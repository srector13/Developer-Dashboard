//! The desktop layer: helper windows, the tray, global shortcuts, screenshot
//! capture, notifications and the notebook file watcher.
//!
//! All of it is summonable without the main window, exactly as in the Electron
//! build — closing the main window leaves the app resident in the tray so the
//! launcher and the capture shortcuts stay live.

use crate::state::{AppState, PendingShot};
use crate::{capture, settings::AppSettings};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

pub const MAIN: &str = "main";
pub const CAPTURE: &str = "capture";
pub const LAUNCHER: &str = "launcher";
pub const SCRATCHPAD: &str = "scratchpad";
pub const REGION: &str = "region";

// ---------------------------------------------------------------------------
// files-changed, debounced
// ---------------------------------------------------------------------------

/// The renderer answers a files-changed event with a full notebook rescan, and
/// a single save produces several watcher events plus an explicit notify from
/// the write command. Without coalescing, one save would cost 3+ full rescans.
static CHANGE_SEQ: AtomicU64 = AtomicU64::new(0);
const CHANGE_DEBOUNCE_MS: u64 = 300;

pub fn notify_files_changed(app: &AppHandle) {
    let seq = CHANGE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(CHANGE_DEBOUNCE_MS)).await;
        if CHANGE_SEQ.load(Ordering::SeqCst) != seq {
            return; // superseded by a later change
        }
        if let Some(main) = app.get_webview_window(MAIN) {
            let _ = main.emit("files-changed", ());
        }
    });
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

/// Reveal and focus the main window, optionally telling the renderer to open a
/// specific note.
pub fn reveal_main_window(app: &AppHandle, open_note: Option<String>) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(path) = open_note {
        let _ = window.emit("open-note", path);
    }
}

/// Tell the running app to open a note, optionally at a line and in a given
/// view. Used by the second-launch handoff, where the window already exists.
pub fn open_note_at(app: &AppHandle, request: crate::cli::OpenRequest) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.emit("open-note-at", request);
    }
}

/// Open a note in the main window AND open its PDF export dialog.
pub fn reveal_main_window_for_export(app: &AppHandle, fs_path: String) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("open-note-export", fs_path);
}

// ---------------------------------------------------------------------------
// Helper windows
// ---------------------------------------------------------------------------

/// How long after showing a helper window a blur is ignored.
///
/// Windows does not simply hand foreground to a window because it asked. A
/// process that is not already in the foreground gets its `SetForegroundWindow`
/// downgraded, and a window shown from a global hotkey can be focused and then
/// have focus taken straight back by the app the user was actually in. The
/// blur that follows is not the user clicking away — it is the window manager
/// still settling — and dismissing on it is what made the launcher and the
/// quick-note overlay flash up and vanish, needing a second try.
const DISMISS_GRACE: std::time::Duration = std::time::Duration::from_millis(700);

/// When each helper window was last shown, keyed by window label.
static SHOWN_AT: once_cell::sync::Lazy<
    Mutex<std::collections::HashMap<String, std::time::Instant>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

fn mark_shown(label: &str) {
    if let Ok(mut map) = SHOWN_AT.lock() {
        map.insert(label.to_string(), std::time::Instant::now());
    }
}

fn within_dismiss_grace(label: &str) -> bool {
    SHOWN_AT
        .lock()
        .ok()
        .and_then(|map| map.get(label).map(|t| t.elapsed() < DISMISS_GRACE))
        .unwrap_or(false)
}

/// Show a helper window and actually take the foreground.
///
/// `set_focus` alone loses to Windows' foreground lock when the call comes from
/// a background process — which is exactly the case here, since these windows
/// are summoned by a global hotkey while another app is in front. Attaching to
/// the current foreground thread's input queue first makes the request come
/// from a thread Windows already considers foreground, so it is granted.
fn present(window: &WebviewWindow, label: &str) {
    mark_shown(label);
    let _ = window.show();
    let _ = window.set_focus();
    #[cfg(windows)]
    force_foreground(window);
}

#[cfg(windows)]
fn force_foreground(window: &WebviewWindow) {
    use windows::Win32::System::Threading::AttachThreadInput;
    use windows::Win32::UI::Input::KeyboardAndMouse::{SetActiveWindow, SetFocus};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };

    let Ok(handle) = window.hwnd() else {
        return;
    };
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0 == handle.0 {
            return; // already ours
        }
        // The threads to join are the one owning the foreground window and the
        // one owning *our* window — not whichever worker thread happens to be
        // running this, which is where the call actually comes from.
        let other = GetWindowThreadProcessId(foreground, None);
        let ours = GetWindowThreadProcessId(handle, None);
        // Attaching a thread to itself is both pointless and an error.
        let attached = other != 0
            && ours != 0
            && other != ours
            && AttachThreadInput(other, ours, true).as_bool();
        let _ = SetForegroundWindow(handle);
        let _ = SetActiveWindow(handle);
        let _ = SetFocus(Some(handle));
        if attached {
            let _ = AttachThreadInput(other, ours, false);
        }
    }
}

/// Dismiss a helper window when the user clicks away from it.
///
/// Two conditions guard the blur, and both exist because of bugs this caused:
/// the window must have actually held focus (a window built lazily and shown in
/// the same breath receives a blur before it was ever focused), and it must be
/// past its settling grace period (Windows routinely takes foreground back from
/// a window it just granted it to).
fn hide_on_blur(window: &WebviewWindow) {
    let handle = window.clone();
    let label = window.label().to_string();
    let had_focus = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(true) => {
            had_focus.store(true, Ordering::SeqCst);
        }
        tauri::WindowEvent::Focused(false) => {
            if within_dismiss_grace(&label) {
                return;
            }
            if had_focus.swap(false, Ordering::SeqCst) {
                let _ = handle.hide();
            }
        }
        _ => {}
    });
}

/// Quick capture: a small always-on-top jot window.
fn build_capture_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, CAPTURE, WebviewUrl::App("capture.html".into()))
        .title("Quick Capture")
        .inner_size(560.0, 340.0)
        .min_inner_size(420.0, 260.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .build()?;
    // A capture scratchpad shouldn't linger over other apps once you click away
    hide_on_blur(&window);
    Ok(window)
}

fn capture_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(CAPTURE).or_else(|| {
        build_capture_window(app)
            .map_err(|e| eprintln!("Failed to create the capture window: {e}"))
            .ok()
    })
}

pub fn toggle_capture_window(app: &AppHandle) {
    let Some(window) = capture_window(app) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.center();
        present(&window, CAPTURE);
    }
}

/// Always show — used by the launcher's Note tool, which hands off to the full
/// quick-capture overlay rather than filing inline.
pub fn show_capture_window(app: &AppHandle) {
    let Some(window) = capture_window(app) else {
        return;
    };
    let _ = window.center();
    present(&window, CAPTURE);
}

pub fn hide_capture_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE) {
        let _ = window.hide();
    }
}

/// The Golden-Gate launcher. Sized generously so the feathered drop-shadow
/// lives inside the window's own transparent margin instead of being clipped.
fn build_launcher_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("launcher.html".into()))
        .title("Launcher")
        .inner_size(804.0, 560.0)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()?;
    hide_on_blur(&window);
    Ok(window)
}

fn launcher_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LAUNCHER).or_else(|| {
        build_launcher_window(app)
            .map_err(|e| eprintln!("Failed to create the launcher window: {e}"))
            .ok()
    })
}

pub fn toggle_launcher_window(app: &AppHandle) {
    let Some(window) = launcher_window(app) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    position_launcher(app, &window);
    let _ = window.emit("launcher-reset", ()); // fresh state each open
    present(&window, LAUNCHER);
}

/// Spotlight-like: horizontally centred, about a fifth down the display under
/// the cursor.
fn position_launcher(app: &AppHandle, window: &WebviewWindow) {
    let Ok(cursor) = app.cursor_position() else {
        return;
    };
    let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) else {
        return;
    };
    let scale = monitor.scale_factor();
    let work_x = monitor.position().x as f64 / scale;
    let work_y = monitor.position().y as f64 / scale;
    let work_w = monitor.size().width as f64 / scale;
    let work_h = monitor.size().height as f64 / scale;
    let size = window
        .inner_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((804.0, 560.0));

    let x = work_x + (work_w - size.0) / 2.0;
    let y = work_y + work_h * 0.18;
    let _ = window.set_position(tauri::LogicalPosition::new(x.round(), y.round()));
}

pub fn hide_launcher_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LAUNCHER) {
        let _ = window.hide();
    }
}

/// The launcher grows and shrinks as search results appear; keep it anchored.
pub fn resize_launcher(app: &AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(LAUNCHER) else {
        return;
    };
    let clamped = height.round().clamp(180.0, 820.0);
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = window
        .inner_size()
        .map(|s| s.width as f64 / scale)
        .unwrap_or(804.0);
    let _ = window.set_size(tauri::LogicalSize::new(width, clamped));
}

/// Floating scratchpad.
fn build_scratchpad_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, SCRATCHPAD, WebviewUrl::App("scratchpad.html".into()))
        .title("Scratchpad")
        .inner_size(380.0, 480.0)
        .min_inner_size(260.0, 200.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
}

pub fn show_scratchpad_window(app: &AppHandle) {
    let window = match app.get_webview_window(SCRATCHPAD) {
        Some(w) => w,
        None => match build_scratchpad_window(app) {
            Ok(w) => w,
            Err(err) => {
                eprintln!("Failed to create the scratchpad window: {err}");
                return;
            }
        },
    };
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn hide_scratchpad_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SCRATCHPAD) {
        let _ = window.hide();
    }
}

pub fn pin_scratchpad_window(app: &AppHandle, pinned: bool) {
    if let Some(window) = app.get_webview_window(SCRATCHPAD) {
        let _ = window.set_always_on_top(pinned);
    }
}

// ---------------------------------------------------------------------------
// Screenshot to note
// ---------------------------------------------------------------------------

pub fn notify_desktop(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Grab the display under the cursor and open the crop overlay on top of it.
pub fn start_screenshot_capture(app: &AppHandle) {
    hide_launcher_window(app);

    let state = app.state::<AppState>();
    let settings = state.settings();
    if settings.notebook_root.is_empty() {
        notify_desktop(app, "Screenshot", "Set a notebook folder first.");
        return;
    }

    let cursor = app
        .cursor_position()
        .unwrap_or(tauri::PhysicalPosition::new(0.0, 0.0));
    let monitor = match app.monitor_from_point(cursor.x, cursor.y) {
        Ok(Some(m)) => m,
        _ => match app.primary_monitor() {
            Ok(Some(m)) => m,
            _ => {
                notify_desktop(app, "Screenshot", "Could not find a display to capture.");
                return;
            }
        },
    };
    let scale = monitor.scale_factor();

    // Capture at true pixel resolution so the crop stays sharp.
    let shot = match grab_monitor(cursor.x as i32, cursor.y as i32) {
        Ok(png) => png,
        Err(err) => {
            eprintln!("Screenshot capture failed: {err}");
            notify_desktop(app, "Screenshot", "Could not capture the screen.");
            return;
        }
    };

    use base64::Engine;
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&shot)
    );
    let logical_w = (monitor.size().width as f64 / scale).round() as u32;
    let logical_h = (monitor.size().height as f64 / scale).round() as u32;

    *state.pending_shot.lock().unwrap() = Some(PendingShot {
        data_url,
        scale_factor: scale,
        width: logical_w,
        height: logical_h,
        png: shot,
    });

    let x = monitor.position().x as f64 / scale;
    let y = monitor.position().y as f64 / scale;
    let built =
        WebviewWindowBuilder::new(app, REGION, WebviewUrl::App("region-select.html".into()))
            .title("Select a region")
            .position(x, y)
            .inner_size(logical_w as f64, logical_h as f64)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .build();

    if let Err(err) = built {
        eprintln!("Could not open the region overlay: {err}");
        *state.pending_shot.lock().unwrap() = None;
    }
}

fn grab_monitor(x: i32, y: i32) -> Result<Vec<u8>, String> {
    let monitor = xcap::Monitor::from_point(x, y).map_err(|e| e.to_string())?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    let mut out = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

pub fn close_region_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(REGION) {
        let _ = window.close();
    }
}

/// Crop `png` to a rect given in the overlay's CSS pixels.
pub fn crop_png(
    png: &[u8],
    scale: f64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<Vec<u8>, String> {
    let full = image::load_from_memory(png).map_err(|e| e.to_string())?;
    let full = full.to_rgba8();
    let (max_w, max_h) = (full.width(), full.height());

    // Rect comes in CSS px (display points); scale to the capture's pixels.
    let px = ((x * scale).round().max(0.0) as u32).min(max_w.saturating_sub(1));
    let py = ((y * scale).round().max(0.0) as u32).min(max_h.saturating_sub(1));
    let pw = ((width * scale).round().max(1.0) as u32).min(max_w - px);
    let ph = ((height * scale).round().max(1.0) as u32).min(max_h - py);

    let cropped = image::imageops::crop_imm(&full, px, py, pw, ph).to_image();
    let mut out = std::io::Cursor::new(Vec::new());
    cropped
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let items = [
        MenuItem::with_id(app, "open", "Open Markdown Notebook", true, None::<&str>)?,
        MenuItem::with_id(app, "launcher", "Launcher…", true, None::<&str>)?,
        MenuItem::with_id(app, "capture", "New Quick Capture", true, None::<&str>)?,
        MenuItem::with_id(app, "daily", "Open Today's Daily Note", true, None::<&str>)?,
        MenuItem::with_id(app, "screenshot", "Screenshot to Note", true, None::<&str>)?,
        MenuItem::with_id(app, "scratchpad", "Floating Scratchpad", true, None::<&str>)?,
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
    ];
    let sep_a = PredefinedMenuItem::separator(app)?;
    let sep_b = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &items[0], &sep_a, &items[1], &items[2], &items[3], &items[4], &items[5], &sep_b,
            &items[6],
        ],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(tauri::include_image!("icons/tray.png"))
        .tooltip("Markdown Notebook")
        .menu(&menu)
        // Left-click opens the app; the menu is on right-click.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle(), None);
            }
        })
        .on_menu_event(|app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                "open" => reveal_main_window(&app, None),
                "launcher" => toggle_launcher_window(&app),
                "capture" => toggle_capture_window(&app),
                "screenshot" => start_screenshot_capture(&app),
                "scratchpad" => show_scratchpad_window(&app),
                "daily" => {
                    let settings = app.state::<AppState>().settings();
                    if settings.notebook_root.is_empty() {
                        reveal_main_window(&app, None);
                    } else {
                        match capture::resolve_or_create_daily_note(&settings) {
                            Ok(path) => {
                                notify_files_changed(&app);
                                reveal_main_window(&app, Some(path.to_string_lossy().into_owned()));
                            }
                            Err(err) => eprintln!("Could not open the daily note: {err}"),
                        }
                    }
                }
                "quit" => {
                    app.state::<AppState>()
                        .quitting
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    app.state::<AppState>().save_meta_cache();
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Global shortcuts
// ---------------------------------------------------------------------------

/// Translate an Electron accelerator ("CommandOrControl+Shift+N") into the
/// form tauri-plugin-global-shortcut parses, so existing settings.json files
/// keep working.
pub fn normalize_accelerator(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| {
            match part.trim().to_lowercase().as_str() {
                "commandorcontrol" | "cmdorctrl" | "command" | "cmd" => "Control",
                "control" | "ctrl" => "Control",
                "alt" | "option" => "Alt",
                "shift" => "Shift",
                "super" | "meta" => "Super",
                _ => return part.trim().to_string(),
            }
            .to_string()
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// (Re-)register both system-wide shortcuts. A shortcut already taken by
/// another app surfaces as a toast in the main window rather than failing
/// silently.
pub fn apply_shortcuts(app: &AppHandle, settings: &AppSettings) {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let state = app.state::<AppState>();
    let mut registered = state.shortcuts.lock().unwrap();

    for previous in [
        registered.quick_capture.take(),
        registered.clipboard_capture.take(),
    ]
    .into_iter()
    .flatten()
    {
        let _ = app.global_shortcut().unregister(previous);
    }

    // The parsed Shortcut — not the accelerator text — is what gets stored, so
    // the handler can compare it by value. Comparing rendered strings does not
    // work: `Shortcut`'s Display writes "shift+control+KeyN", which never
    // equals the "CommandOrControl+Shift+N" that settings.json holds.
    let register = |raw: &str| -> Option<Shortcut> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None; // feature switched off
        }
        let parsed = match Shortcut::from_str(&normalize_accelerator(trimmed)) {
            Ok(shortcut) => shortcut,
            Err(err) => {
                eprintln!("Could not parse the shortcut {trimmed}: {err}");
                if let Some(main) = app.get_webview_window(MAIN) {
                    let _ = main.emit("capture-shortcut-failed", trimmed);
                }
                return None;
            }
        };
        match app.global_shortcut().register(parsed) {
            Ok(_) => Some(parsed),
            Err(err) => {
                eprintln!("Could not register {trimmed}: {err}");
                if let Some(main) = app.get_webview_window(MAIN) {
                    let _ = main.emit("capture-shortcut-failed", trimmed);
                }
                None
            }
        }
    };

    registered.quick_capture = register(&settings.quick_capture_shortcut);
    registered.clipboard_capture = register(&settings.clipboard_capture_shortcut);
}

/// Windowless capture: file whatever text is on the clipboard, with a native
/// notification for feedback since there's no window in this flow.
pub fn capture_clipboard_to_note(app: &AppHandle) {
    let settings = app.state::<AppState>().settings();
    let text = crate::platform::read_clipboard_text();
    if text.trim().is_empty() {
        notify_desktop(
            app,
            "Nothing captured",
            "The clipboard has no text to file.",
        );
        return;
    }
    let target = capture::resolve_clipboard_target(&settings);
    let result = capture::append_capture(&settings, &text, target.as_deref());
    if result.success {
        let name = result
            .note_path
            .as_deref()
            .and_then(|p| std::path::Path::new(p).file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "your note".into());
        notify_desktop(app, "Captured to notebook", &format!("Filed to {name}"));
        notify_files_changed(app);
    } else {
        notify_desktop(
            app,
            "Capture failed",
            result
                .reason
                .as_deref()
                .unwrap_or("Could not file the clipboard text."),
        );
    }
}

/// Route a fired shortcut to the right action. The quick-capture accelerator
/// opens the launcher (quick capture is one of its tools), matching v1.4.0.
pub fn handle_shortcut(app: &AppHandle, pressed: &tauri_plugin_global_shortcut::Shortcut) {
    let state = app.state::<AppState>();
    let (quick, clipboard) = {
        let registered = state.shortcuts.lock().unwrap();
        (registered.quick_capture, registered.clipboard_capture)
    };
    if quick.as_ref() == Some(pressed) {
        toggle_launcher_window(app);
    } else if clipboard.as_ref() == Some(pressed) {
        capture_clipboard_to_note(app);
    }
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------

static WATCHER: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>> =
    Mutex::new(None);

/// Watch the notebook root, ignoring dot-files, the order files and any of the
/// configured ignore folders — churn in those never changes the tree.
pub fn update_watcher(app: &AppHandle, settings: &AppSettings) {
    use notify::RecursiveMode;
    use notify_debouncer_mini::{new_debouncer, DebounceEventResult};

    let mut slot = WATCHER.lock().unwrap();
    *slot = None; // drop the old watcher first, so the path is released

    let root = settings.root();
    if root.as_os_str().is_empty() || !root.exists() {
        return;
    }
    let ignore = settings.ignore_set();
    let root_for_events = root.clone();
    let app_handle = app.clone();

    let debouncer = new_debouncer(
        std::time::Duration::from_millis(CHANGE_DEBOUNCE_MS),
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let relevant = events.iter().any(|event| {
                let Ok(rel) = event.path.strip_prefix(&root_for_events) else {
                    return true;
                };
                let mut components = rel.components();
                let Some(first) = components.next() else {
                    return false;
                };
                let first = first.as_os_str().to_string_lossy().to_lowercase();
                if first.starts_with('.') || ignore.contains(&first) {
                    return false;
                }
                !rel.components().any(|c| {
                    let part = c.as_os_str().to_string_lossy();
                    part.starts_with('.') || part == "node_modules"
                })
            });
            if relevant {
                notify_files_changed(&app_handle);
            }
        },
    );

    match debouncer {
        Ok(mut debouncer) => {
            if let Err(err) = debouncer.watcher().watch(&root, RecursiveMode::Recursive) {
                eprintln!("Failed to watch the notebook folder: {err}");
                return;
            }
            *slot = Some(debouncer);
        }
        Err(err) => eprintln!("Failed to start the file watcher: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electron_accelerators_are_translated() {
        assert_eq!(
            normalize_accelerator("CommandOrControl+Shift+N"),
            "Control+Shift+N"
        );
        assert_eq!(normalize_accelerator("CmdOrCtrl+G"), "Control+G");
        assert_eq!(normalize_accelerator("Alt+Space"), "Alt+Space");
        assert_eq!(normalize_accelerator("Control+Shift+G"), "Control+Shift+G");
    }

    #[test]
    fn unknown_key_names_are_passed_through_untouched() {
        assert_eq!(normalize_accelerator("Super+F12"), "Super+F12");
        assert_eq!(normalize_accelerator("  Shift + N "), "Shift+N");
    }

    /// The shipped defaults must survive normalisation *and* parsing. In
    /// v1.5.0-beta.1 they registered but never fired, because the handler
    /// compared `Shortcut`'s Display output against the accelerator text.
    #[test]
    fn the_default_accelerators_parse_into_the_expected_shortcuts() {
        use std::str::FromStr;
        use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

        let settings = AppSettings::default();
        for (accelerator, expected_code) in [
            (settings.quick_capture_shortcut.as_str(), Code::KeyN),
            (settings.clipboard_capture_shortcut.as_str(), Code::KeyG),
        ] {
            let parsed = Shortcut::from_str(&normalize_accelerator(accelerator))
                .unwrap_or_else(|e| panic!("{accelerator} did not parse: {e}"));
            assert_eq!(parsed.key, expected_code, "{accelerator}");
            assert!(parsed.mods.contains(Modifiers::CONTROL), "{accelerator}");
            assert!(parsed.mods.contains(Modifiers::SHIFT), "{accelerator}");
        }
    }

    /// Guards the actual defect: a round-tripped Display string is NOT the
    /// accelerator, so anything comparing those two is broken by construction.
    #[test]
    fn shortcut_display_does_not_round_trip_to_the_accelerator() {
        use std::str::FromStr;
        use tauri_plugin_global_shortcut::Shortcut;

        let accelerator = normalize_accelerator("CommandOrControl+Shift+N");
        let parsed = Shortcut::from_str(&accelerator).unwrap();
        assert_ne!(parsed.to_string(), accelerator);
        // …but parsing either spelling yields the same value, which is why the
        // handler matches on the parsed Shortcut instead.
        assert_eq!(Shortcut::from_str(&parsed.to_string()).unwrap(), parsed);
    }

    #[test]
    fn cropping_stays_inside_the_captured_image() {
        // 4x4 red image, cropped with a rect that would overflow at scale 2.
        let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let png = png.into_inner();

        let cropped = crop_png(&png, 2.0, 1.0, 1.0, 10.0, 10.0).unwrap();
        let decoded = image::load_from_memory(&cropped).unwrap();
        // Origin scales to (2,2); the remaining area is 2x2, not 20x20.
        assert_eq!((decoded.width(), decoded.height()), (2, 2));
    }

    #[test]
    fn cropping_scales_the_rect_by_the_display_factor() {
        let img = image::RgbaImage::from_pixel(20, 20, image::Rgba([0, 0, 255, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let png = png.into_inner();

        let cropped = crop_png(&png, 2.0, 0.0, 0.0, 5.0, 5.0).unwrap();
        let decoded = image::load_from_memory(&cropped).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (10, 10));
    }
}

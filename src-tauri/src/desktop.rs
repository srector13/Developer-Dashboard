//! The desktop layer: the launcher window, the tray, global shortcuts and the
//! config file watcher.
//!
//! All of it is summonable without the dashboard window — closing the main
//! window leaves Dev Hub resident in the tray so the hotkey stays live.

use crate::registry;
use crate::settings::{self, AppSettings};
use crate::state::AppState;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "main";
pub const LAUNCHER: &str = "launcher";

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

pub fn reveal_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
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
/// still settling — and dismissing on it is what makes a launcher flash up and
/// vanish, needing a second try.
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
/// a background process — which is exactly the case here, since this window is
/// summoned by a global hotkey while another app is in front. Attaching to the
/// current foreground thread's input queue first makes the request come from a
/// thread Windows already considers foreground, so it is granted.
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

/// The quick launcher. Sized generously so the feathered drop-shadow lives
/// inside the window's own transparent margin instead of being clipped.
fn build_launcher_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("launcher.html".into()))
        .title("Dev Hub Launcher")
        .inner_size(804.0, 560.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false);

    // The transparent margin the feathered shadow lives in is what gives the
    // launcher its floating-glass chrome. Tauri only exposes `transparent` on
    // macOS behind its private-API feature, which this build does not enable,
    // so a macOS dev build renders the window opaque — the shipping target is
    // Windows, where it is available unconditionally.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);

    let window = builder.build()?;
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

pub fn show_launcher_window(app: &AppHandle) {
    let Some(window) = launcher_window(app) else {
        return;
    };
    position_launcher(app, &window);
    let _ = window.emit("launcher-reset", ());
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

/// The launcher grows and shrinks as results appear; keep it anchored.
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

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let items = [
        MenuItem::with_id(app, "open", "Open Dev Hub", true, None::<&str>)?,
        MenuItem::with_id(app, "launcher", "Launcher…", true, None::<&str>)?,
        MenuItem::with_id(app, "refresh", "Refresh everything", true, None::<&str>)?,
        MenuItem::with_id(app, "config", "Edit hub.config.json", true, None::<&str>)?,
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
    ];
    let sep_a = PredefinedMenuItem::separator(app)?;
    let sep_b = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &items[0], &sep_a, &items[1], &items[2], &items[3], &sep_b, &items[4],
        ],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(tauri::include_image!("icons/tray.png"))
        .tooltip("Dev Hub")
        .menu(&menu)
        // Left-click opens the dashboard; the menu is on right-click.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                "open" => reveal_main_window(&app),
                "launcher" => toggle_launcher_window(&app),
                "refresh" => {
                    tauri::async_runtime::spawn(async move {
                        registry::refresh_all(&app).await;
                    });
                }
                "config" => crate::commands::open_config_file(&app),
                "quit" => {
                    let state = app.state::<AppState>();
                    state.quitting.store(true, Ordering::SeqCst);
                    state.save_usage();
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Global shortcut
// ---------------------------------------------------------------------------

/// Translate an Electron-style accelerator ("CommandOrControl+Shift+Space")
/// into the form tauri-plugin-global-shortcut parses, so a settings.json
/// written by hand (or copied from Markdown Notebook) keeps working.
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

/// (Re-)register the launcher shortcut. A shortcut already taken by another app
/// surfaces in the dashboard rather than failing silently.
pub fn apply_shortcut(app: &AppHandle, settings: &AppSettings) {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let state = app.state::<AppState>();
    let mut registered = state.shortcut.lock().unwrap();
    if let Some(previous) = registered.take() {
        let _ = app.global_shortcut().unregister(previous);
    }

    let raw = settings.launcher_shortcut.trim();
    if raw.is_empty() {
        return; // switched off deliberately
    }

    // The parsed Shortcut — not the accelerator text — is what gets stored, so
    // the handler can compare it by value. Comparing rendered strings does not
    // work: `Shortcut`'s Display writes "shift+control+Space", which never
    // equals the "CommandOrControl+Shift+Space" that settings.json holds.
    let parsed = match Shortcut::from_str(&normalize_accelerator(raw)) {
        Ok(shortcut) => shortcut,
        Err(err) => {
            eprintln!("Could not parse the shortcut {raw}: {err}");
            let _ = app.emit("shortcut-failed", raw);
            return;
        }
    };
    match app.global_shortcut().register(parsed) {
        Ok(_) => *registered = Some(parsed),
        Err(err) => {
            eprintln!("Could not register {raw}: {err}");
            let _ = app.emit("shortcut-failed", raw);
        }
    }
}

pub fn handle_shortcut(app: &AppHandle, pressed: &tauri_plugin_global_shortcut::Shortcut) {
    let registered = {
        let state = app.state::<AppState>();
        let guard = state.shortcut.lock().unwrap();
        *guard
    };
    if registered.as_ref() == Some(pressed) {
        toggle_launcher_window(app);
    }
}

// ---------------------------------------------------------------------------
// Config watcher
// ---------------------------------------------------------------------------

static WATCHER: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>> =
    Mutex::new(None);

const CONFIG_DEBOUNCE_MS: u64 = 300;

/// Watch `hub.config.json` and hot-reload the providers when it changes, so
/// adding a project root or a URL shows up without a restart.
///
/// The *directory* is watched rather than the file: most editors save by
/// writing a temp file and renaming over the original, which destroys the inode
/// a file watch is bound to and would make the second save silently do nothing.
pub fn watch_config(app: &AppHandle) {
    use notify::RecursiveMode;
    use notify_debouncer_mini::{new_debouncer, DebounceEventResult};

    let mut slot = WATCHER.lock().unwrap();
    *slot = None; // drop the old watcher first, so the path is released

    let config_path = settings::config_file();
    let Some(dir) = config_path.parent().map(|p| p.to_path_buf()) else {
        return;
    };
    if !dir.exists() {
        return;
    }

    let app_handle = app.clone();
    let debouncer = new_debouncer(
        std::time::Duration::from_millis(CONFIG_DEBOUNCE_MS),
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            if events.iter().any(|event| event.path == config_path) {
                registry::reload_config(&app_handle);
            }
        },
    );

    match debouncer {
        Ok(mut debouncer) => {
            if let Err(err) = debouncer.watcher().watch(&dir, RecursiveMode::NonRecursive) {
                eprintln!("Failed to watch the config folder: {err}");
                return;
            }
            *slot = Some(debouncer);
        }
        Err(err) => eprintln!("Failed to start the config watcher: {err}"),
    }
}

static TODO_WATCHER: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>> =
    Mutex::new(None);

/// Is this path a note the todos provider would actually read?
///
/// The watcher fires for every write under the notebook root, and a notebook is
/// usually a git repo with attachments — without this filter, a `git status`
/// touching `.git/index` would trigger a full rescan.
pub fn is_watched_note(path: &std::path::Path, root: &std::path::Path) -> bool {
    if path
        .extension()
        .map(|e| !e.eq_ignore_ascii_case("md"))
        .unwrap_or(true)
    {
        return false;
    }
    let relative = path.strip_prefix(root).unwrap_or(path);
    !relative.components().any(|component| {
        let part = component.as_os_str().to_string_lossy().to_lowercase();
        part.starts_with('.') || crate::providers::todos::IGNORE_DIRS.contains(&part.as_str())
    })
}

/// Watch the notebook roots and refresh the todos provider when a note changes,
/// so ticking a checkbox in Markdown Notebook updates the card in seconds
/// instead of waiting out the 5-minute interval.
///
/// Re-established on every registry restart, because the roots come from the
/// config and can move.
pub fn watch_todo_roots(app: &AppHandle) {
    use notify::RecursiveMode;
    use notify_debouncer_mini::{new_debouncer, DebounceEventResult};

    let mut slot = TODO_WATCHER.lock().unwrap();
    *slot = None; // drop the old watcher first, so the paths are released

    let state = app.state::<AppState>();
    if !state.settings().providers.todos {
        return;
    }
    let roots: Vec<std::path::PathBuf> =
        crate::providers::todos::resolve_roots(&state.config().todos)
            .into_iter()
            .map(std::path::PathBuf::from)
            .filter(|root| root.is_dir())
            .collect();
    if roots.is_empty() {
        return;
    }

    let watched = roots.clone();
    let app_handle = app.clone();
    let debouncer = new_debouncer(
        std::time::Duration::from_millis(CONFIG_DEBOUNCE_MS),
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let relevant = events.iter().any(|event| {
                watched
                    .iter()
                    .any(|root| is_watched_note(&event.path, root))
            });
            if !relevant {
                return;
            }
            let app = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let _ = registry::refresh_provider(&app, crate::providers::todos::ID).await;
            });
        },
    );

    match debouncer {
        Ok(mut debouncer) => {
            for root in &roots {
                if let Err(err) = debouncer.watcher().watch(root, RecursiveMode::Recursive) {
                    eprintln!("Failed to watch {}: {err}", root.display());
                }
            }
            *slot = Some(debouncer);
        }
        Err(err) => eprintln!("Failed to start the notes watcher: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electron_accelerators_are_translated() {
        assert_eq!(
            normalize_accelerator("CommandOrControl+Shift+Space"),
            "Control+Shift+Space"
        );
        assert_eq!(normalize_accelerator("CmdOrCtrl+G"), "Control+G");
        assert_eq!(normalize_accelerator("Alt+Space"), "Alt+Space");
    }

    #[test]
    fn unknown_key_names_are_passed_through_untouched() {
        assert_eq!(normalize_accelerator("Super+F12"), "Super+F12");
        assert_eq!(normalize_accelerator("  Shift + N "), "Shift+N");
    }

    /// The shipped default must survive normalisation *and* parsing — a
    /// default hotkey that registers but never fires is the worst kind of bug,
    /// because the app looks fine.
    #[test]
    fn the_default_accelerator_parses_into_the_expected_shortcut() {
        use std::str::FromStr;
        use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

        let settings = AppSettings::default();
        let parsed = Shortcut::from_str(&normalize_accelerator(&settings.launcher_shortcut))
            .expect("the default launcher shortcut must parse");
        assert_eq!(parsed.key, Code::Space);
        assert!(parsed.mods.contains(Modifiers::CONTROL));
        assert!(parsed.mods.contains(Modifiers::SHIFT));
    }

    /// Guards the actual defect: a round-tripped Display string is NOT the
    /// accelerator, so anything comparing those two is broken by construction.
    #[test]
    fn shortcut_display_does_not_round_trip_to_the_accelerator() {
        use std::str::FromStr;
        use tauri_plugin_global_shortcut::Shortcut;

        let accelerator = normalize_accelerator("CommandOrControl+Shift+Space");
        let parsed = Shortcut::from_str(&accelerator).unwrap();
        assert_ne!(parsed.to_string(), accelerator);
        // …but parsing either spelling yields the same value, which is why the
        // handler matches on the parsed Shortcut instead.
        assert_eq!(Shortcut::from_str(&parsed.to_string()).unwrap(), parsed);
    }

    #[test]
    fn an_empty_shortcut_is_a_deliberate_off_switch_not_a_parse_error() {
        assert_eq!(normalize_accelerator("").trim(), "");
    }

    #[test]
    fn the_notes_watcher_only_wakes_for_markdown_the_provider_would_read() {
        let root = std::path::Path::new("/notes");
        assert!(is_watched_note(
            std::path::Path::new("/notes/work/plan.md"),
            root
        ));
        assert!(is_watched_note(
            std::path::Path::new("/notes/plan.MD"),
            root
        ));

        // Churn a notebook produces constantly, and none of it changes a todo.
        assert!(!is_watched_note(
            std::path::Path::new("/notes/.git/index"),
            root
        ));
        assert!(!is_watched_note(
            std::path::Path::new("/notes/.git/HEAD"),
            root
        ));
        assert!(!is_watched_note(
            std::path::Path::new("/notes/plan.txt"),
            root
        ));
        assert!(!is_watched_note(std::path::Path::new("/notes/work"), root));
        assert!(!is_watched_note(
            std::path::Path::new("/notes/attachments/shot.md"),
            root
        ));
        assert!(!is_watched_note(
            std::path::Path::new("/notes/templates/daily.md"),
            root
        ));
    }
}

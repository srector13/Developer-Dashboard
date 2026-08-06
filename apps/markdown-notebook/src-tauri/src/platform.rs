//! The two features `docs/rust-port-plan.md` flagged as having no drop-in
//! equivalent outside Electron, implemented directly against Windows APIs:
//!
//!  * **PDF export** — `ICoreWebView2_7::PrintToPdf`, the WebView2 counterpart
//!    of Electron's `webContents.printToPDF`. Silent, no print dialog.
//!  * **Clipboard HTML** — the `CF_HTML` clipboard format, which powers
//!    "Paste as note" and "Copy as rich text".
//!
//! Non-Windows builds get stubs so the pure-logic tests still run on CI hosts;
//! the shipped binary is Windows-only.

use std::path::Path;

#[cfg(windows)]
mod imp {
    use super::*;
    use clipboard_win::{formats, Clipboard, Getter, Setter};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2_2, ICoreWebView2_7,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING, PCWSTR};

    type CbErr = clipboard_win::ErrorCode;

    /// Read the clipboard's HTML fragment and plain text in one open.
    /// `clipboard-win` unwraps the CF_HTML header for us, so the fragment
    /// matches what Electron's `clipboard.readHTML()` returned.
    pub fn read_clipboard_html_and_text() -> Result<(String, String), String> {
        let _guard = Clipboard::new_attempts(10).map_err(|e: CbErr| e.to_string())?;
        let mut html = String::new();
        if let Some(fmt) = formats::Html::new() {
            let _ = fmt.read_clipboard(&mut html);
        }
        let mut text = String::new();
        let _ = formats::Unicode.read_clipboard(&mut text);
        Ok((html, text))
    }

    pub fn read_clipboard_text() -> String {
        let Ok(_guard) = Clipboard::new_attempts(10) else {
            return String::new();
        };
        let mut text = String::new();
        let _ = formats::Unicode.read_clipboard(&mut text);
        text
    }

    /// Put both flavours on the clipboard so a paste into Word or Outlook keeps
    /// the formatting while a paste into a plain editor still works.
    pub fn write_clipboard_html(html: &str, text: &str) -> Result<(), String> {
        let _guard = Clipboard::new_attempts(10).map_err(|e: CbErr| e.to_string())?;
        clipboard_win::raw::empty().map_err(|e: CbErr| e.to_string())?;
        formats::Unicode
            .write_clipboard(&text)
            .map_err(|e: CbErr| e.to_string())?;
        if let Some(fmt) = formats::Html::new() {
            fmt.write_clipboard(&html)
                .map_err(|e: CbErr| e.to_string())?;
        }
        Ok(())
    }

    /// Print an already-loaded webview to `out_path`.
    ///
    /// `with_webview` hands the closure the real `ICoreWebView2Controller`, and
    /// `wait_for_async_operation` pumps the message loop while WebView2 renders,
    /// so this returns only once the PDF is on disk.
    pub fn print_webview_to_pdf(
        window: &tauri::WebviewWindow,
        out_path: &Path,
        page_width_in: f64,
        page_height_in: f64,
    ) -> Result<(), String> {
        let out = out_path.to_string_lossy().into_owned();
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

        window
            .with_webview(move |platform| {
                let run = || -> Result<(), String> {
                    let controller = platform.controller();
                    let core = unsafe { controller.CoreWebView2() }.map_err(|e| e.to_string())?;
                    let webview7: ICoreWebView2_7 = core.cast().map_err(|e| e.to_string())?;

                    let core2: ICoreWebView2_2 = core.cast().map_err(|e| e.to_string())?;
                    let environment: ICoreWebView2Environment6 = unsafe { core2.Environment() }
                        .map_err(|e| e.to_string())?
                        .cast()
                        .map_err(|e| e.to_string())?;
                    let settings: ICoreWebView2PrintSettings =
                        unsafe { environment.CreatePrintSettings() }.map_err(|e| e.to_string())?;

                    unsafe {
                        let _ = settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT);
                        let _ = settings.SetPageWidth(page_width_in);
                        let _ = settings.SetPageHeight(page_height_in);
                        // Required for the dark and tinted PDF themes.
                        let _ = settings.SetShouldPrintBackgrounds(true);
                        // Electron printed no browser header/footer either.
                        let _ = settings.SetShouldPrintHeaderAndFooter(false);
                        let _ = settings.SetMarginTop(0.4);
                        let _ = settings.SetMarginBottom(0.4);
                        let _ = settings.SetMarginLeft(0.4);
                        let _ = settings.SetMarginRight(0.4);
                        let _ = settings.SetScaleFactor(1.0);
                    }

                    let path = HSTRING::from(out.as_str());
                    PrintToPdfCompletedHandler::wait_for_async_operation(
                        Box::new(move |handler| unsafe {
                            webview7
                                .PrintToPdf(PCWSTR(path.as_ptr()), &settings, &handler)
                                .map_err(Into::into)
                        }),
                        Box::new(move |result, succeeded| {
                            result?;
                            if succeeded {
                                Ok(())
                            } else {
                                // WebView2 reports a clean "didn't print" (for
                                // example: the target path is not writable).
                                Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                                    -1,
                                )))
                            }
                        }),
                    )
                    .map_err(|e| e.to_string())?;
                    Ok(())
                };
                let _ = tx.send(run());
            })
            .map_err(|e| e.to_string())?;

        rx.recv()
            .map_err(|_| "The print window closed before the PDF was written.".to_string())?
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    const UNSUPPORTED: &str = "This build targets Windows only.";

    pub fn read_clipboard_html_and_text() -> Result<(String, String), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn read_clipboard_text() -> String {
        String::new()
    }

    pub fn write_clipboard_html(_html: &str, _text: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn print_webview_to_pdf(
        _window: &tauri::WebviewWindow,
        _out_path: &Path,
        _page_width_in: f64,
        _page_height_in: f64,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

pub use imp::*;

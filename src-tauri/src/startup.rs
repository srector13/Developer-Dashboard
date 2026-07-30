//! Run at login.
//!
//! A launcher you have to launch is a launcher you forget, so this is the one
//! piece of the app that touches anything outside its own data directory. It
//! writes a single value under the per-user Run key — no scheduled task, no
//! service, no admin rights, and nothing that survives deleting the exe beyond
//! one stale registry value the app clears the next time it starts.

#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The value name. Stable, so toggling never leaves a second copy behind.
#[cfg(windows)]
const VALUE_NAME: &str = "Dev Hub";

/// The command the Run key should hold: the current exe, quoted, with a flag
/// that starts it in the tray rather than opening the dashboard over whatever
/// the user is doing at login.
#[cfg(windows)]
fn run_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Could not locate the exe: {e}"))?;
    Ok(format!("\"{}\" --startup", exe.display()))
}

#[cfg(windows)]
pub fn is_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_KEY) else {
        return false;
    };
    let Ok(existing) = key.get_value::<String, _>(VALUE_NAME) else {
        return false;
    };
    // Only report enabled when the entry points at *this* exe. A portable app
    // gets copied around, and a Run key aimed at a path the user deleted should
    // read as off rather than as working.
    match std::env::current_exe() {
        Ok(exe) => existing.contains(&exe.display().to_string()),
        Err(_) => !existing.trim().is_empty(),
    }
}

#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey_with_flags(RUN_KEY, KEY_WRITE)
        .map_err(|e| format!("Could not open the startup key: {e}"))?;

    if enabled {
        key.set_value(VALUE_NAME, &run_command()?)
            .map_err(|e| format!("Could not write the startup entry: {e}"))
    } else {
        match key.delete_value(VALUE_NAME) {
            Ok(_) => Ok(()),
            // Already absent is the state we wanted.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("Could not remove the startup entry: {err}")),
        }
    }
}

// The other platforms have no equivalent this app should be touching, so the
// setting simply reports off and refuses politely rather than pretending.

#[cfg(not(windows))]
pub fn is_enabled() -> bool {
    false
}

#[cfg(not(windows))]
pub fn set_enabled(_enabled: bool) -> Result<(), String> {
    Err("Running at login is only supported on Windows.".into())
}

/// Was the app started by the Run key rather than by the user?
///
/// A login start goes to the tray: opening the dashboard over the desktop every
/// morning is how a helpful tool becomes one you uninstall.
pub fn launched_at_login() -> bool {
    std::env::args().any(|arg| arg == "--startup")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_startup_flag_is_recognised_only_when_present() {
        // The real check reads this process's args, which a test can't set —
        // assert the app isn't accidentally treating a normal run as a login.
        assert!(!launched_at_login());
    }

    #[cfg(windows)]
    #[test]
    fn the_run_command_quotes_the_exe_and_asks_for_a_tray_start() {
        let command = run_command().unwrap();
        assert!(command.starts_with('"'), "{command}");
        assert!(command.ends_with("--startup"), "{command}");
        assert!(command.contains("dev-hub"), "{command}");
    }

    #[cfg(not(windows))]
    #[test]
    fn other_platforms_say_no_rather_than_silently_doing_nothing() {
        assert!(!is_enabled());
        assert!(set_enabled(true).is_err());
    }
}

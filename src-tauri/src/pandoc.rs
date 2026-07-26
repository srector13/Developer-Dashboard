//! Pandoc integration — the one optional external dependency. It powers Word /
//! PowerPoint / Excel import and Word export; everything else in the app works
//! without it.

use crate::settings::AppSettings;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Keep a console window from flashing up behind every conversion.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn pandoc_path(settings: &AppSettings) -> String {
    settings
        .pandoc_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or("pandoc")
        .to_string()
}

fn base_command(settings: &AppSettings) -> Command {
    let mut cmd = Command::new(pandoc_path(settings));
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Wait for `child`, killing it if it outstays `timeout`.
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child.wait_with_output().map_err(|e| e.to_string());
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Pandoc timed out.".to_string());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => return Err(err.to_string()),
        }
    }
}

fn finish(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("pandoc exited with {}", output.status)
        } else {
            stderr
        })
    }
}

/// Convert text piped over stdin (clipboard import).
pub fn run_stdin(settings: &AppSettings, input: &str, from: &str, to: &str) -> Result<String, String> {
    let mut child = base_command(settings)
        .args(["-f", from, "-t", to, "--wrap=none"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(missing_pandoc)?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
    }
    // Dropping stdin closes the pipe so pandoc stops reading.
    drop(child.stdin.take());

    finish(wait_with_timeout(child, Duration::from_secs(30))?)
}

/// Convert a file on disk to markdown (document import).
pub fn run_file(
    settings: &AppSettings,
    file_path: &Path,
    from: &str,
    to: &str,
) -> Result<String, String> {
    let child = base_command(settings)
        .arg(file_path)
        .args(["-f", from, "-t", to, "--wrap=none"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(missing_pandoc)?;

    finish(wait_with_timeout(child, Duration::from_secs(30))?)
}

/// Convert an on-disk markdown file to another format, writing straight to
/// `out_path`. `cwd` is the note's folder so relative image links resolve.
pub fn run_to_file(
    settings: &AppSettings,
    input_path: &Path,
    out_path: &Path,
    format: &str,
    cwd: &Path,
) -> Result<(), String> {
    let child = base_command(settings)
        .arg(input_path)
        .args(["-f", "gfm", "-t", format])
        .arg("-o")
        .arg(out_path)
        .arg("--wrap=none")
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(missing_pandoc)?;

    finish(wait_with_timeout(child, Duration::from_secs(60))?).map(|_| ())
}

/// Spawn failures are almost always "pandoc isn't installed"; say so in terms
/// the user can act on. The ENOENT marker is preserved because export_to_docx
/// keys its friendlier message off it.
fn missing_pandoc(err: std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        "ENOENT: pandoc was not found on PATH".to_string()
    } else {
        err.to_string()
    }
}

/// Pandoc reader name for a file extension, mirroring the import dialog's
/// filter list. Unknown extensions fall back to docx, as before.
pub fn reader_for_extension(ext: &str) -> &'static str {
    match ext.trim_start_matches('.').to_lowercase().as_str() {
        "docx" => "docx",
        "pptx" => "pptx",
        "xlsx" => "xlsx",
        "odt" => "odt",
        "rtf" => "rtf",
        "epub" => "epub",
        "html" | "htm" => "html",
        "tex" => "latex",
        "txt" | "text" => "markdown",
        _ => "docx",
    }
}

/// Heuristic for "is the clipboard holding HTML rather than plain text?".
pub fn looks_like_html(text: &str) -> bool {
    let sample: String = text.chars().take(4000).collect();
    let strong = regex::Regex::new(r"(?i)<!DOCTYPE html|<html[\s>]|<body[\s>]|<table[\s>]|<blockquote[\s>]").unwrap();
    if strong.is_match(&sample) {
        return true;
    }
    let tags = regex::Regex::new(r"(?i)<(p|div|br|span|a|ul|ol|li|h[1-6]|tr|td)\b[^>]*>").unwrap();
    tags.find_iter(&sample).count() >= 3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readers_map_from_extensions() {
        assert_eq!(reader_for_extension(".docx"), "docx");
        assert_eq!(reader_for_extension("HTM"), "html");
        assert_eq!(reader_for_extension(".tex"), "latex");
        assert_eq!(reader_for_extension(".txt"), "markdown");
        assert_eq!(reader_for_extension(".unknown"), "docx");
    }

    #[test]
    fn strong_html_markers_are_detected() {
        assert!(looks_like_html("<!DOCTYPE html><html><body>hi</body></html>"));
        assert!(looks_like_html("<table><tr><td>1</td></tr></table>"));
    }

    #[test]
    fn three_common_tags_are_enough() {
        assert!(looks_like_html("<p>a</p><p>b</p><p>c</p>"));
        assert!(!looks_like_html("<p>a</p><p>b</p>"));
    }

    #[test]
    fn plain_markdown_is_not_html() {
        assert!(!looks_like_html("# Heading\n\nSome *text* with a [link](x).\n"));
        assert!(!looks_like_html(""));
    }

    #[test]
    fn a_missing_binary_reports_enoent() {
        let mut settings = AppSettings::default();
        settings.pandoc_path = Some("definitely-not-a-real-binary-xyz".into());
        let err = run_stdin(&settings, "hi", "markdown", "gfm").unwrap_err();
        assert!(err.contains("ENOENT"), "got: {err}");
    }

    #[test]
    fn an_empty_configured_path_falls_back_to_the_default() {
        let mut settings = AppSettings::default();
        settings.pandoc_path = Some("   ".into());
        assert_eq!(pandoc_path(&settings), "pandoc");
    }
}

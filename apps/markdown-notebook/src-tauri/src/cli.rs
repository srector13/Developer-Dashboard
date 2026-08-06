//! Command-line arguments, so other tools can open a note in this app.
//!
//! The use case this exists for: a companion app that scans the notebook for
//! TODOs and wants a "jump to it" button. It knows a file path and a line
//! number, and it knows where the portable exe lives — that should be enough.
//!
//!     markdown-notebook.exe "C:\notes\Projects\alpha.md"
//!     markdown-notebook.exe "C:\notes\Projects\alpha.md:42"
//!     markdown-notebook.exe --line 42 "C:\notes\Projects\alpha.md"
//!     markdown-notebook.exe --line 42 --view edit "C:\notes\Projects\alpha.md"
//!
//! The `path:line` form is what most editors emit (`code -g`, `vim +42`, ripgrep
//! output), so a caller that already has such a string can pass it straight
//! through. Parsing it on Windows needs care: `C:\notes\file.md` also contains a
//! colon, and a drive letter is not a line number.

use std::path::PathBuf;

/// A request to open one note, from the command line.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub fs_path: String,
    /// 1-based, as every editor and error message counts lines.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// `preview`, `edit` or `split`. Absent means the app's own default for
    /// opening a note, which is preview.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
}

/// Split a trailing `:<line>` off a path.
///
/// Only a run of digits at the very end counts, and only when what precedes it
/// could be a path rather than a bare drive letter — otherwise `C:\x.md` and a
/// hypothetical `C:12` would both be misread.
fn split_trailing_line(raw: &str) -> (String, Option<u32>) {
    let Some(colon) = raw.rfind(':') else {
        return (raw.to_string(), None);
    };
    let (head, tail) = raw.split_at(colon);
    let digits = &tail[1..];
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return (raw.to_string(), None);
    }
    // "C:12" is a drive-relative path, not line 12 of a file called "C".
    if head.len() < 2 {
        return (raw.to_string(), None);
    }
    match digits.parse::<u32>() {
        Ok(line) => (head.to_string(), Some(line)),
        Err(_) => (raw.to_string(), None),
    }
}

fn normalize_view(raw: &str) -> Option<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "preview" | "read" => Some("preview".into()),
        "edit" | "source" => Some("edit".into()),
        "split" => Some("split".into()),
        _ => None,
    }
}

/// Parse arguments, excluding the program name.
///
/// Returns `None` for a plain launch, so the app starts normally. Anything it
/// cannot make sense of is ignored rather than fatal: this build has no console
/// attached, so a usage error would be invisible, and refusing to start would be
/// a worse answer than simply opening.
pub fn parse(args: &[String]) -> Option<OpenRequest> {
    let mut path: Option<String> = None;
    let mut line: Option<u32> = None;
    let mut view: Option<String> = None;

    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        // Both `--line 42` and `--line=42`, with -l as the short form.
        let (flag, inline_value) = match arg.split_once('=') {
            Some((f, v)) => (f, Some(v.to_string())),
            None => (arg, None),
        };
        let take_value = |index: &mut usize| -> Option<String> {
            if let Some(value) = inline_value.clone() {
                return Some(value);
            }
            *index += 1;
            args.get(*index).cloned()
        };

        match flag {
            "--line" | "-l" => {
                if let Some(value) = take_value(&mut index) {
                    line = value.trim().parse::<u32>().ok().or(line);
                }
            }
            "--view" | "-v" => {
                if let Some(value) = take_value(&mut index) {
                    view = normalize_view(&value).or(view);
                }
            }
            // Unknown switches are skipped; a bare word is the path.
            other if other.starts_with('-') && other.len() > 1 => {}
            other if !other.is_empty() && path.is_none() => {
                let (head, trailing) = split_trailing_line(other);
                path = Some(head);
                if trailing.is_some() {
                    line = trailing;
                }
            }
            _ => {}
        }
        index += 1;
    }

    let fs_path = path?;
    // An explicit --line wins over one glued to the path, so `file.md:1 --line 9`
    // opens line 9. Ordering is handled above by --line overwriting.
    Some(OpenRequest {
        fs_path,
        line,
        // Jumping to a line means "show me this", so name the rendered view
        // explicitly; without a line the app's own default applies anyway.
        view: view.or_else(|| line.map(|_| "preview".to_string())),
    })
}

/// The current process's arguments, minus the program name.
pub fn from_env() -> Option<OpenRequest> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    parse(&args)
}

/// Resolve to something the renderer can actually open: an existing file, made
/// absolute so a relative argument works from any working directory.
pub fn resolve(request: OpenRequest, cwd: Option<&std::path::Path>) -> Option<OpenRequest> {
    let raw = PathBuf::from(&request.fs_path);
    let absolute = if raw.is_absolute() {
        raw
    } else {
        match cwd {
            Some(dir) => dir.join(raw),
            None => std::env::current_dir().ok()?.join(raw),
        }
    };
    let canonical = std::fs::canonicalize(&absolute).unwrap_or(absolute);
    if !canonical.is_file() {
        return None;
    }
    // Windows canonicalisation yields a \\?\ prefix, which nothing downstream
    // (the notebook tree, the renderer's path comparisons) expects to see.
    let cleaned = canonical.to_string_lossy();
    let cleaned = cleaned
        .strip_prefix(r"\\?\")
        .unwrap_or(&cleaned)
        .to_string();
    Some(OpenRequest {
        fs_path: cleaned,
        ..request
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_arguments_is_a_plain_launch() {
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn a_bare_path_opens_it_without_changing_the_view() {
        let got = parse(&args(&[r"C:\notes\alpha.md"])).unwrap();
        assert_eq!(got.fs_path, r"C:\notes\alpha.md");
        assert_eq!(got.line, None);
        assert_eq!(got.view, None);
    }

    #[test]
    fn a_trailing_line_is_split_off_the_path() {
        let got = parse(&args(&[r"C:\notes\alpha.md:42"])).unwrap();
        assert_eq!(got.fs_path, r"C:\notes\alpha.md");
        assert_eq!(got.line, Some(42));
    }

    #[test]
    fn a_windows_drive_letter_is_not_a_line_number() {
        let got = parse(&args(&[r"C:\notes\alpha.md"])).unwrap();
        assert_eq!(got.fs_path, r"C:\notes\alpha.md");
        assert_eq!(got.line, None);

        // The degenerate case: a drive-relative path ending in digits.
        let got = parse(&args(&["C:12"])).unwrap();
        assert_eq!(got.fs_path, "C:12");
        assert_eq!(got.line, None);
    }

    #[test]
    fn a_posix_path_with_a_line_still_splits() {
        let got = parse(&args(&["/home/me/notes/alpha.md:7"])).unwrap();
        assert_eq!(got.fs_path, "/home/me/notes/alpha.md");
        assert_eq!(got.line, Some(7));
    }

    #[test]
    fn the_line_flag_is_accepted_in_both_spellings() {
        for form in [
            args(&["--line", "42", "alpha.md"]),
            args(&["--line=42", "alpha.md"]),
            args(&["-l", "42", "alpha.md"]),
            args(&["alpha.md", "--line", "42"]),
        ] {
            let got = parse(&form).unwrap();
            assert_eq!(got.fs_path, "alpha.md", "{form:?}");
            assert_eq!(got.line, Some(42), "{form:?}");
        }
    }

    #[test]
    fn a_line_defaults_the_view_to_preview() {
        assert_eq!(
            parse(&args(&["--line", "3", "alpha.md"])).unwrap().view,
            Some("preview".to_string())
        );
    }

    #[test]
    fn an_explicit_view_wins_over_the_default() {
        for (given, want) in [
            ("edit", "edit"),
            ("split", "split"),
            ("preview", "preview"),
            ("SOURCE", "edit"),
        ] {
            let got = parse(&args(&["--line", "3", "--view", given, "alpha.md"])).unwrap();
            assert_eq!(got.view, Some(want.to_string()), "{given}");
        }
    }

    #[test]
    fn an_explicit_line_overrides_one_glued_to_the_path() {
        let got = parse(&args(&["alpha.md:1", "--line", "9"])).unwrap();
        assert_eq!(got.line, Some(9));
        assert_eq!(got.fs_path, "alpha.md");
    }

    #[test]
    fn unknown_switches_are_ignored_rather_than_fatal() {
        let got = parse(&args(&["--wat", "--line", "5", "alpha.md"])).unwrap();
        assert_eq!(got.fs_path, "alpha.md");
        assert_eq!(got.line, Some(5));
    }

    #[test]
    fn a_nonsense_line_value_leaves_the_line_unset() {
        let got = parse(&args(&["--line", "abc", "alpha.md"])).unwrap();
        assert_eq!(got.line, None);
        assert_eq!(got.view, None);
    }

    #[test]
    fn only_the_first_path_is_taken() {
        let got = parse(&args(&["first.md", "second.md"])).unwrap();
        assert_eq!(got.fs_path, "first.md");
    }

    #[test]
    fn a_flag_value_is_never_mistaken_for_the_path() {
        // "42" is consumed by --line, so the path is the file that follows.
        let got = parse(&args(&["--line", "42", "alpha.md"])).unwrap();
        assert_eq!(got.fs_path, "alpha.md");
    }

    #[test]
    fn a_path_containing_spaces_survives() {
        let got = parse(&args(&[r"C:\My Notes\a file.md:12"])).unwrap();
        assert_eq!(got.fs_path, r"C:\My Notes\a file.md");
        assert_eq!(got.line, Some(12));
    }

    #[test]
    fn resolve_rejects_a_path_that_is_not_a_file() {
        let request = OpenRequest {
            fs_path: "/definitely/not/here.md".into(),
            line: None,
            view: None,
        };
        assert_eq!(resolve(request, None), None);
    }

    #[test]
    fn resolve_makes_a_relative_path_absolute() {
        let dir = std::env::temp_dir().join("mdnb-cli-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.md");
        std::fs::write(&file, "# hi\n").unwrap();

        let request = OpenRequest {
            fs_path: "note.md".into(),
            line: Some(2),
            view: None,
        };
        let got = resolve(request, Some(&dir)).unwrap();
        assert!(std::path::Path::new(&got.fs_path).is_absolute());
        assert!(got.fs_path.ends_with("note.md"));
        assert!(!got.fs_path.starts_with(r"\\?\"));
        assert_eq!(got.line, Some(2));

        std::fs::remove_dir_all(&dir).ok();
    }
}

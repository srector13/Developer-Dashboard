//! Finding the tools that are already installed.
//!
//! The largest single source of "I configured it and nothing happened" is a
//! mistyped program path, so first-run setup offers what it can actually see on
//! disk instead of asking for paths. Everything here is a lookup — nothing is
//! written, and nothing is assumed to exist because it usually does.

use crate::util;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTool {
    /// Stable id the settings screen keys its checkboxes on.
    pub id: String,
    /// What to call it in the UI and in the generated opener.
    pub label: String,
    pub program: String,
    /// The arguments that make it open a folder, `{path}` included.
    pub args: Vec<String>,
    /// True when this is the kind of thing that should open a repo.
    pub opens_folders: bool,
}

/// A candidate: where to look, and what to call it if it's there.
struct Candidate {
    id: &'static str,
    label: &'static str,
    /// Absolute paths to try, in order of preference.
    absolute: Vec<PathBuf>,
    /// Bare names to resolve on PATH when no absolute path matched.
    on_path: &'static [&'static str],
    args: &'static [&'static str],
    opens_folders: bool,
}

fn program_files() -> Vec<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect()
}

fn jetbrains_candidates(exe: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for base in program_files() {
        // Both the standalone install and the Toolbox layout.
        for root in [
            base.join("JetBrains"),
            base.join("Programs"),
            base.join("JetBrains").join("Toolbox").join("apps"),
        ] {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let candidate = entry.path().join("bin").join(exe);
                if candidate.is_file() {
                    found.push(candidate);
                }
                // Toolbox nests one level deeper: apps/<product>/<channel>/bin.
                let Ok(inner) = std::fs::read_dir(entry.path()) else {
                    continue;
                };
                for nested in inner.flatten() {
                    let candidate = nested.path().join("bin").join(exe);
                    if candidate.is_file() {
                        found.push(candidate);
                    }
                }
            }
        }
    }
    found
}

fn candidates() -> Vec<Candidate> {
    vec![
        Candidate {
            id: "intellij",
            label: "IntelliJ IDEA",
            absolute: jetbrains_candidates("idea64.exe"),
            on_path: &["idea64", "idea"],
            args: &["{path}"],
            opens_folders: true,
        },
        Candidate {
            id: "rider",
            label: "Rider",
            absolute: jetbrains_candidates("rider64.exe"),
            on_path: &["rider64"],
            args: &["{path}"],
            opens_folders: true,
        },
        Candidate {
            id: "vscode",
            label: "VS Code",
            absolute: program_files()
                .into_iter()
                .map(|base| base.join("Microsoft VS Code").join("bin").join("code.cmd"))
                .collect(),
            on_path: &["code"],
            args: &["{path}"],
            opens_folders: true,
        },
        Candidate {
            id: "terminal",
            label: "Windows Terminal",
            absolute: Vec::new(),
            on_path: &["wt"],
            args: &["-d", "{path}"],
            opens_folders: true,
        },
        Candidate {
            id: "explorer",
            label: "Explorer",
            absolute: Vec::new(),
            on_path: &["explorer"],
            args: &["{path}"],
            opens_folders: true,
        },
    ]
}

/// Everything we can find. Order is preference order, so the first entry is a
/// sensible default opener.
pub fn detect_tools() -> Vec<DetectedTool> {
    candidates()
        .into_iter()
        .filter_map(|candidate| {
            let program = candidate
                .absolute
                .iter()
                .find(|path| path.is_file())
                .map(|path| path.to_string_lossy().into_owned())
                .or_else(|| {
                    candidate
                        .on_path
                        .iter()
                        .find_map(|name| util::resolve_program(name))
                        // On non-Windows `resolve_program` doesn't verify
                        // existence, so confirm before claiming it's installed.
                        .filter(|path| path.is_file())
                        .map(|path| path.to_string_lossy().into_owned())
                })?;

            Some(DetectedTool {
                id: candidate.id.to_string(),
                label: candidate.label.to_string(),
                program,
                args: candidate.args.iter().map(|a| a.to_string()).collect(),
                opens_folders: candidate.opens_folders,
            })
        })
        .collect()
}

/// The arguments that make Markdown Notebook open a file on a line.
///
/// The explicit-flag form rather than the `path:line` suffix: a Windows path
/// already contains a colon, so the flags leave nothing to parse ambiguously.
pub const NOTEBOOK_ARGS: &[&str] = &["--line", "{line}", "--view", "edit", "{path}"];

/// Find Markdown Notebook.
///
/// Checked next to our own exe first, because these two ship as portable
/// siblings and land in the same folder more often than not — the same instinct
/// as following the notebook pointer file. Cached: this runs once per todo
/// scan and the answer doesn't change while the app is up.
pub fn markdown_notebook() -> Option<PathBuf> {
    static FOUND: once_cell::sync::Lazy<Option<PathBuf>> =
        once_cell::sync::Lazy::new(find_markdown_notebook);
    FOUND.clone()
}

fn find_markdown_notebook() -> Option<PathBuf> {
    // Both spellings: the release artefact is capitalised, a `cargo build` is
    // not, and on a case-sensitive filesystem that matters.
    const NAMES: &[&str] = &[
        "Markdown-Notebook.exe",
        "markdown-notebook.exe",
        "Markdown Notebook.exe",
        "markdown-notebook",
    ];

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            // A folder of portable tools, one directory per app.
            if let Some(parent) = dir.parent() {
                roots.push(parent.to_path_buf());
                roots.push(parent.join("Markdown Notebook"));
                roots.push(parent.join("markdown-notebook"));
            }
        }
    }
    for base in program_files() {
        roots.push(base.join("Markdown Notebook"));
        roots.push(base.join("Programs").join("Markdown Notebook"));
    }
    if let Some(home) = crate::settings::dirs_home() {
        roots.push(home.join("Downloads"));
    }

    for root in roots {
        for name in NAMES {
            let candidate = root.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // Last resort: on the PATH.
    NAMES
        .iter()
        .find_map(|name| util::resolve_program(name))
        .filter(|path| path.is_file())
}

/// Folders that look like somewhere repositories live, offered as starting
/// points for the projects provider.
pub fn detect_repo_roots() -> Vec<String> {
    let Some(home) = crate::settings::dirs_home() else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    let mut candidates: Vec<PathBuf> = ["dev", "src", "code", "repos", "projects", "git", "source"]
        .iter()
        .map(|name| home.join(name))
        .collect();
    // The Windows convention of a drive-root dev folder.
    candidates.push(PathBuf::from("C:\\dev"));
    candidates.push(PathBuf::from("C:\\src"));
    candidates.push(home.join("IdeaProjects"));

    for candidate in candidates {
        if candidate.is_dir() && contains_a_repo(&candidate) {
            roots.push(candidate.to_string_lossy().into_owned());
        }
    }
    roots
}

/// Cheap check: does this folder hold a checkout one level down? Offering a
/// folder with nothing in it would be worse than offering nothing.
fn contains_a_repo(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .take(200)
        .any(|entry| entry.path().join(".git").exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_never_claims_a_tool_that_is_not_on_disk() {
        for tool in detect_tools() {
            assert!(
                std::path::Path::new(&tool.program).is_file(),
                "{} pointed at {}, which does not exist",
                tool.label,
                tool.program
            );
        }
    }

    #[test]
    fn every_folder_opener_passes_the_path_through() {
        for tool in detect_tools() {
            if tool.opens_folders {
                assert!(
                    tool.args.iter().any(|a| a.contains("{path}")),
                    "{} would open nothing in particular",
                    tool.label
                );
            }
        }
    }

    #[test]
    fn detected_tools_have_unique_ids_so_settings_can_key_on_them() {
        let tools = detect_tools();
        let mut ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        ids.sort();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }

    #[test]
    fn a_folder_with_no_checkouts_is_not_offered_as_a_repo_root() {
        let dir = std::env::temp_dir().join(format!("dev-hub-detect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("not-a-repo")).unwrap();
        assert!(!contains_a_repo(&dir));

        std::fs::create_dir_all(dir.join("a-repo").join(".git")).unwrap();
        assert!(contains_a_repo(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn suggested_repo_roots_all_exist() {
        for root in detect_repo_roots() {
            assert!(std::path::Path::new(&root).is_dir(), "{root}");
        }
    }
}

//! Quick capture and the daily note.
//!
//! Captured text is filed VERBATIM — no timestamp or bullet decoration, which
//! would corrupt something like "- [ ] task" typed straight in. Captures land
//! under a "## Quick Capture" heading of today's daily note by default, or at
//! the end of an explicitly chosen note.

use crate::notebook::{all_markdown_files, read_order_file, write_order_file};
use crate::notes::write_note_file;
use crate::settings::AppSettings;
use crate::util::{
    append_lines_under_heading, is_inside, local_date_string, tags_yaml_line, unique_md, yaml_value,
};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

impl CaptureResult {
    fn failed(reason: impl Into<String>) -> Self {
        Self {
            success: false,
            note_path: None,
            reason: Some(reason.into()),
            count: None,
        }
    }

    fn ok(note_path: &Path) -> Self {
        Self {
            success: true,
            note_path: Some(note_path.to_string_lossy().into_owned()),
            reason: None,
            count: None,
        }
    }
}

/// Find today's daily note anywhere in the tree, creating it at the root when
/// missing. Shared by quick capture, task capture, screenshots and
/// "open daily note".
pub fn resolve_or_create_daily_note(settings: &AppSettings) -> Result<PathBuf, String> {
    let root = settings.root();
    let today = local_date_string();
    let daily_name = format!("{today}.md");

    if let Some(existing) = all_markdown_files(settings).into_iter().find(|f| {
        f.file_name()
            .map(|n| n.to_string_lossy().to_lowercase() == daily_name)
            .unwrap_or(false)
    }) {
        return Ok(existing);
    }

    let mut fm = vec![
        "---".to_string(),
        format!("title: {}", yaml_value(&today)),
        format!("created: {today}"),
    ];
    if !settings.author.is_empty() {
        fm.push(format!("author: {}", yaml_value(&settings.author)));
    }
    fm.push(tags_yaml_line(&[]));
    fm.push("---".into());
    fm.push(String::new());
    fm.push(format!("# {today}"));
    fm.push(String::new());

    let note_path = root.join(unique_md(&root, &today));
    std::fs::write(&note_path, fm.join("\n")).map_err(|e| e.to_string())?;

    let mut ord = read_order_file(&root);
    if let Some(name) = note_path.file_name() {
        ord.push(name.to_string_lossy().into_owned());
    }
    let _ = write_order_file(&root, &ord);
    Ok(note_path)
}

/// Normalise captured text: CRLF to LF, no leading blank lines, no trailing
/// whitespace.
fn normalize_capture(text: &str) -> String {
    static LEAD: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\n+").unwrap());
    static TRAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+$").unwrap());
    let unified = text.replace("\r\n", "\n");
    let no_lead = LEAD.replace(&unified, "");
    TRAIL.replace(&no_lead, "").into_owned()
}

pub fn append_capture(
    settings: &AppSettings,
    text: &str,
    target_fs_path: Option<&Path>,
) -> CaptureResult {
    let root = settings.root();
    if root.as_os_str().is_empty() || !root.exists() {
        return CaptureResult::failed("No notebook folder is set.");
    }

    let raw = normalize_capture(text);
    if raw.trim().is_empty() {
        return CaptureResult::failed("Nothing to capture.");
    }

    if let Some(target) = target_fs_path {
        // Only accept targets inside the notebook that still exist
        if !is_inside(&root, target) || !target.exists() {
            return CaptureResult::failed("That note no longer exists.");
        }
        let Ok(content) = std::fs::read_to_string(target) else {
            return CaptureResult::failed("That note could not be read.");
        };
        let body = content.trim_end();
        let next = format!("{body}\n\n{raw}\n");
        return match write_note_file(settings, target, &next, true, false) {
            Ok(_) => CaptureResult::ok(target),
            Err(err) => CaptureResult::failed(err),
        };
    }

    let note_path = match resolve_or_create_daily_note(settings) {
        Ok(p) => p,
        Err(err) => return CaptureResult::failed(err),
    };
    let Ok(content) = std::fs::read_to_string(&note_path) else {
        return CaptureResult::failed("Today's note could not be read.");
    };
    let lines: Vec<String> = raw.split('\n').map(|s| s.to_string()).collect();
    let next = append_lines_under_heading(&content, "Quick Capture", &lines);
    match write_note_file(settings, &note_path, &next, true, false) {
        Ok(_) => CaptureResult::ok(&note_path),
        Err(err) => CaptureResult::failed(err),
    }
}

/// Turn free text into `- [ ] item` lines, leaving lines that are already
/// checkboxes alone (beyond normalising `*`/`+` bullets to `-`).
pub fn to_task_lines(raw: &str) -> Vec<String> {
    static ALREADY_TASK: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[-*+]\s*\[[ xX]\]").unwrap());
    static BULLET: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[-*+]\s*").unwrap());
    raw.replace("\r\n", "\n")
        .split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| {
            if ALREADY_TASK.is_match(l) {
                // normalise the bullet character only
                format!("-{}", &l[1..])
            } else {
                format!("- [ ] {}", BULLET.replace(l, ""))
            }
        })
        .collect()
}

/// Task capture: files "- [ ] <text>" under a "## Tasks" section of the daily
/// note. Multi-line input becomes multiple tasks.
pub fn append_tasks(settings: &AppSettings, text: &str) -> CaptureResult {
    let root = settings.root();
    if root.as_os_str().is_empty() || !root.exists() {
        return CaptureResult::failed("No notebook folder is set.");
    }
    let raw = text.replace("\r\n", "\n").trim().to_string();
    if raw.is_empty() {
        return CaptureResult::failed("Nothing to capture.");
    }
    let task_lines = to_task_lines(&raw);

    let note_path = match resolve_or_create_daily_note(settings) {
        Ok(p) => p,
        Err(err) => return CaptureResult::failed(err),
    };
    let Ok(content) = std::fs::read_to_string(&note_path) else {
        return CaptureResult::failed("Today's note could not be read.");
    };
    let next = append_lines_under_heading(&content, "Tasks", &task_lines);
    match write_note_file(settings, &note_path, &next, true, false) {
        Ok(_) => CaptureResult {
            count: Some(task_lines.len()),
            ..CaptureResult::ok(&note_path)
        },
        Err(err) => CaptureResult::failed(err),
    }
}

/// Resolve the configured clipboard-capture target (a relPath) to an absolute
/// path, or None for the daily-note default.
pub fn resolve_clipboard_target(settings: &AppSettings) -> Option<PathBuf> {
    let rel = settings.clipboard_capture_target.trim();
    if rel.is_empty() || settings.notebook_root.is_empty() {
        return None;
    }
    let path = settings.root().join(rel);
    path.exists().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_notebook(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdnb-cap-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn settings_for(root: &Path) -> AppSettings {
        AppSettings {
            notebook_root: root.to_string_lossy().into_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn task_lines_are_normalised_but_existing_checkboxes_are_kept() {
        assert_eq!(
            to_task_lines("call Sam\n* buy milk\n- [x] already done\n\n+ [ ] pending"),
            vec![
                "- [ ] call Sam",
                "- [ ] buy milk",
                "- [x] already done",
                "- [ ] pending",
            ]
        );
    }

    #[test]
    fn capture_creates_todays_note_and_files_verbatim() {
        let root = temp_notebook("daily");
        let settings = settings_for(&root);

        let result = append_capture(&settings, "- [ ] a typed task\nsecond line", None);
        assert!(result.success, "{:?}", result.reason);

        let note = PathBuf::from(result.note_path.unwrap());
        assert_eq!(
            note.file_name().unwrap().to_string_lossy(),
            format!("{}.md", local_date_string())
        );
        let text = std::fs::read_to_string(&note).unwrap();
        assert!(text.contains("## Quick Capture"));
        // Verbatim: the checkbox survives untouched, no timestamp added
        assert!(
            text.contains("- [ ] a typed task\nsecond line"),
            "got: {text}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_second_capture_reuses_the_same_heading() {
        let root = temp_notebook("twice");
        let settings = settings_for(&root);
        append_capture(&settings, "first", None);
        let result = append_capture(&settings, "second", None);

        let text = std::fs::read_to_string(result.note_path.unwrap()).unwrap();
        assert_eq!(text.matches("## Quick Capture").count(), 1);
        assert!(text.find("first").unwrap() < text.find("second").unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_explicit_target_appends_at_the_end() {
        let root = temp_notebook("target");
        let settings = settings_for(&root);
        let target = root.join("snippets.md");
        std::fs::write(&target, "# Snippets\n\nexisting\n").unwrap();

        let result = append_capture(&settings, "new snippet", Some(&target));
        assert!(result.success);
        let text = std::fs::read_to_string(&target).unwrap();
        assert_eq!(text, "# Snippets\n\nexisting\n\nnew snippet\n");
        // No "Quick Capture" heading for explicit targets
        assert!(!text.contains("## Quick Capture"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_target_outside_the_notebook_is_refused() {
        let root = temp_notebook("escape");
        let settings = settings_for(&root);
        let outside = std::env::temp_dir().join("mdnb-outside.md");
        std::fs::write(&outside, "x").unwrap();

        let result = append_capture(&settings, "text", Some(&outside));
        assert!(!result.success);
        assert_eq!(result.reason.unwrap(), "That note no longer exists.");

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_captures_are_refused() {
        let root = temp_notebook("empty");
        let settings = settings_for(&root);
        assert_eq!(
            append_capture(&settings, "   \n  ", None).reason.unwrap(),
            "Nothing to capture."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tasks_land_under_their_own_heading_with_a_count() {
        let root = temp_notebook("tasks");
        let settings = settings_for(&root);

        let result = append_tasks(&settings, "one\ntwo");
        assert!(result.success);
        assert_eq!(result.count, Some(2));

        let text = std::fs::read_to_string(result.note_path.unwrap()).unwrap();
        assert!(text.contains("## Tasks"));
        assert!(text.contains("- [ ] one"));
        assert!(text.contains("- [ ] two"));
        assert!(!text.contains("## Quick Capture"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_existing_daily_note_elsewhere_in_the_tree_is_reused() {
        let root = temp_notebook("nested");
        let settings = settings_for(&root);
        let journal = root.join("journal");
        std::fs::create_dir_all(&journal).unwrap();
        let existing = journal.join(format!("{}.md", local_date_string()));
        std::fs::write(&existing, "# today\n").unwrap();

        let result = append_capture(&settings, "note", None);
        assert_eq!(PathBuf::from(result.note_path.unwrap()), existing);
        // No duplicate created at the root
        assert!(!root.join(format!("{}.md", local_date_string())).exists());

        let _ = std::fs::remove_dir_all(&root);
    }
}

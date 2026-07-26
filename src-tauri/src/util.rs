//! Small helpers shared across the backend. Each one mirrors a function of the
//! same name in the old Electron main process so note files keep their exact
//! shape — filenames, YAML quoting and timestamps all have to match what the
//! app has already written to users' notebooks.

use chrono::{Datelike, Local, Timelike};
use once_cell::sync::Lazy;
use regex::Regex;
use std::path::{Path, PathBuf};

/// Quote a YAML scalar only when it would otherwise be ambiguous.
pub fn yaml_value(s: &str) -> String {
    static NEEDS_QUOTE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r#"[:#\[\]{}",'`]|^[\s\-*&?>|%@!]|\s$|^$"#).unwrap());
    if NEEDS_QUOTE.is_match(s) {
        // serde_json produces exactly JSON.stringify's escaping, which is what
        // the Electron build wrote and is valid YAML double-quoted style.
        serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
    } else {
        s.to_string()
    }
}

/// Filename-safe slug, capped at 60 characters.
pub fn slug(s: &str) -> String {
    static NON_ALNUM: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^a-z0-9]+").unwrap());
    let lowered = s.to_lowercase();
    let dashed = NON_ALNUM.replace_all(&lowered, "-");
    let trimmed = dashed.trim_matches('-');
    trimmed.chars().take(60).collect()
}

/// Turn a filename stem into a display title: dashes and underscores become
/// spaces, and each word is capitalised.
pub fn clean_display_name(raw: &str) -> String {
    let spaced = raw.replace(['-', '_'], " ");
    spaced
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Local YYYY-MM-DD. Deliberately not UTC: near midnight a UTC date would file
/// a capture into the wrong daily note.
pub fn local_date_string() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Timestamp prefix for attachment and trash entry names.
pub fn stamp_compact() -> String {
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// Find a name that doesn't collide inside `dir`, appending -1, -2, …
pub fn unique_file(dir: &Path, base: &str, ext: &str) -> String {
    let mut candidate = format!("{base}.{ext}");
    let mut i = 1;
    while dir.join(&candidate).exists() {
        candidate = format!("{base}-{i}.{ext}");
        i += 1;
    }
    candidate
}

pub fn unique_md(dir: &Path, base_slug: &str) -> String {
    unique_file(dir, base_slug, "md")
}

/// Path relative to `root`, always with forward slashes — the form the
/// renderer and the on-disk metadata files both expect.
pub fn rel_path(root: &Path, target: &Path) -> String {
    let rel = pathdiff(root, target);
    rel.replace('\\', "/")
}

/// `path.relative(from, to)` — including the `..` walk-ups Node produces, which
/// callers rely on to detect "outside the notebook".
pub fn pathdiff(from: &Path, to: &Path) -> String {
    let from_c: Vec<_> = from.components().collect();
    let to_c: Vec<_> = to.components().collect();
    let common = from_c
        .iter()
        .zip(to_c.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let mut parts: Vec<String> = vec!["..".into(); from_c.len() - common];
    parts.extend(
        to_c[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join(std::path::MAIN_SEPARATOR_STR)
}

/// True when `target` sits inside `root`. Used everywhere a path arrives from
/// the renderer and must not be allowed to escape the notebook.
pub fn is_inside(root: &Path, target: &Path) -> bool {
    if root.as_os_str().is_empty() {
        return false;
    }
    let rel = pathdiff(root, target);
    !rel.starts_with("..") && !Path::new(&rel).is_absolute()
}

/// Built-in {{variables}} a template gets filled with automatically.
pub fn builtin_template_vars(title: &str, created_date: &str) -> Vec<(String, String)> {
    let now = Local::now();
    let weekday = match now.weekday() {
        chrono::Weekday::Mon => "Monday",
        chrono::Weekday::Tue => "Tuesday",
        chrono::Weekday::Wed => "Wednesday",
        chrono::Weekday::Thu => "Thursday",
        chrono::Weekday::Fri => "Friday",
        chrono::Weekday::Sat => "Saturday",
        chrono::Weekday::Sun => "Sunday",
    };
    // Node's toLocaleTimeString/toLocaleString on an en-US Windows box; close
    // enough that templates written against the Electron build still read well.
    let hour12 = if now.hour() % 12 == 0 { 12 } else { now.hour() % 12 };
    let ampm = if now.hour() < 12 { "AM" } else { "PM" };
    let time = format!("{}:{:02}:{:02} {}", hour12, now.minute(), now.second(), ampm);
    let datetime = format!("{}, {}", now.format("%-m/%-d/%Y"), time);

    vec![
        ("title".into(), title.to_string()),
        ("date".into(), created_date.to_string()),
        ("time".into(), time),
        ("datetime".into(), datetime),
        ("weekday".into(), weekday.to_string()),
        ("year".into(), now.year().to_string()),
        ("month".into(), format!("{:02}", now.month())),
        ("day".into(), format!("{:02}", now.day())),
        ("slug".into(), slug(title)),
        ("cursor".into(), String::new()),
    ]
}

/// Replace `{{ name }}` (any inner spacing) with `value`.
pub fn apply_template_vars(raw: &str, vars: &[(String, String)]) -> String {
    let mut out = raw.to_string();
    for (key, val) in vars {
        let pattern = format!(r"\{{\{{\s*{}\s*\}}\}}", regex::escape(key));
        if let Ok(re) = Regex::new(&pattern) {
            out = re.replace_all(&out, regex::NoExpand(val)).into_owned();
        }
    }
    out
}

/// `tags: [a, b]`, or `tags: []` when empty.
pub fn tags_yaml_line(tags: &[String]) -> String {
    if tags.is_empty() {
        "tags: []".to_string()
    } else {
        let joined = tags
            .iter()
            .map(|t| yaml_value(t))
            .collect::<Vec<_>>()
            .join(", ");
        format!("tags: [{joined}]")
    }
}

/// Insert `entry_lines` under a `## <heading>` section, creating the section at
/// the end when it's absent. Fence-aware so a `#` inside a code block in the
/// section can't be mistaken for the next heading.
pub fn append_lines_under_heading(content: &str, heading: &str, entry_lines: &[String]) -> String {
    let mut lines: Vec<String> = content.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    let heading_re = Regex::new(&format!(r"(?i)^##\s+{}\s*$", regex::escape(heading))).unwrap();
    let heading_idx = lines.iter().position(|l| heading_re.is_match(l));

    match heading_idx {
        None => {
            while lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
                lines.pop();
            }
            lines.push(String::new());
            lines.push(format!("## {heading}"));
            lines.push(String::new());
            lines.extend(entry_lines.iter().cloned());
            lines.push(String::new());
        }
        Some(hidx) => {
            let fence = Regex::new(r"^\s*```").unwrap();
            let next_heading = Regex::new(r"^#{1,6}\s").unwrap();
            let mut end = lines.len();
            let mut in_fence = false;
            for (offset, line) in lines.iter().enumerate().skip(hidx + 1) {
                if fence.is_match(line) {
                    in_fence = !in_fence;
                } else if !in_fence && next_heading.is_match(line) {
                    end = offset;
                    break;
                }
            }
            let mut insert_at = end;
            while insert_at > hidx + 1 && lines[insert_at - 1].trim().is_empty() {
                insert_at -= 1;
            }
            let mut block = vec![String::new()];
            block.extend(entry_lines.iter().cloned());
            lines.splice(insert_at..insert_at, block);
        }
    }

    lines.join("\n")
}

/// Directory portion of a path, as a PathBuf.
pub fn parent_of(p: &Path) -> PathBuf {
    p.parent().map(|d| d.to_path_buf()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_match_the_electron_build() {
        assert_eq!(slug("Weekly Review — Q3"), "weekly-review-q3");
        assert_eq!(slug("  hello  "), "hello");
        assert_eq!(slug("2026-07-13"), "2026-07-13");
        assert_eq!(slug("!!!"), "");
        assert_eq!(slug(&"a".repeat(80)).len(), 60);
    }

    #[test]
    fn display_names_drop_separators() {
        assert_eq!(clean_display_name("meeting-notes"), "Meeting Notes");
        assert_eq!(clean_display_name("project_kickoff"), "Project Kickoff");
        assert_eq!(clean_display_name("已完成"), "已完成");
    }

    #[test]
    fn yaml_values_are_quoted_only_when_needed() {
        assert_eq!(yaml_value("Simple Title"), "Simple Title");
        assert_eq!(yaml_value("Has: colon"), "\"Has: colon\"");
        assert_eq!(yaml_value(""), "\"\"");
        assert_eq!(yaml_value("- leading dash"), "\"- leading dash\"");
    }

    #[test]
    fn tag_lines_round_trip() {
        assert_eq!(tags_yaml_line(&[]), "tags: []");
        assert_eq!(
            tags_yaml_line(&["one".into(), "two: three".into()]),
            "tags: [one, \"two: three\"]"
        );
    }

    #[test]
    fn heading_append_creates_a_missing_section() {
        let out = append_lines_under_heading("# Title\n\nBody\n", "Tasks", &["- [ ] a".into()]);
        assert!(out.ends_with("## Tasks\n\n- [ ] a\n"), "got: {out:?}");
    }

    #[test]
    fn heading_append_lands_at_the_end_of_an_existing_section() {
        let src = "## Tasks\n\n- [ ] first\n\n## Notes\n\ntext\n";
        let out = append_lines_under_heading(src, "Tasks", &["- [ ] second".into()]);
        let tasks_block = out.split("## Notes").next().unwrap();
        assert!(tasks_block.contains("- [ ] first\n\n- [ ] second"), "got: {out:?}");
        assert!(out.contains("## Notes"));
    }

    #[test]
    fn heading_append_ignores_headings_inside_fences() {
        let src = "## Tasks\n\n```\n# not a heading\n```\n\n## Later\n";
        let out = append_lines_under_heading(src, "Tasks", &["- [ ] x".into()]);
        let before_later = out.split("## Later").next().unwrap();
        assert!(before_later.contains("- [ ] x"), "got: {out:?}");
    }

    #[test]
    fn template_vars_replace_every_spacing() {
        let vars = vec![("project".to_string(), "Apollo".to_string())];
        assert_eq!(
            apply_template_vars("{{project}} / {{ project }}", &vars),
            "Apollo / Apollo"
        );
    }

    #[test]
    fn template_var_values_are_literal() {
        // A value containing $1 must not be treated as a capture reference.
        let vars = vec![("cost".to_string(), "$1 each".to_string())];
        assert_eq!(apply_template_vars("{{cost}}", &vars), "$1 each");
    }

    #[test]
    fn containment_rejects_escapes() {
        let root = Path::new("/notes");
        assert!(is_inside(root, Path::new("/notes/a/b.md")));
        assert!(!is_inside(root, Path::new("/other/b.md")));
        assert!(!is_inside(Path::new(""), Path::new("/notes/a.md")));
    }
}

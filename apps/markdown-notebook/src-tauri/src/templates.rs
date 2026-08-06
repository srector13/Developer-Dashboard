//! Page templates. A template file is a note *body*: page creation prepends
//! its own frontmatter and H1, so a template must not carry either. The first
//! line records the display name in an HTML comment, which is stripped when a
//! page is created from it.

use crate::settings::AppSettings;
use crate::util::{builtin_template_vars, clean_display_name, slug, unique_md};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::path::PathBuf;

pub static TEMPLATE_TITLE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^<!--\s*template-title:\s*(.+?)\s*-->").unwrap());
static TEMPLATE_TITLE_STRIP_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^<!--\s*template-title:\s*.+?\s*-->\s*\n?").unwrap());
static VAR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\{\{\s*([\w-]+)\s*\}\}").unwrap());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub name: String,
    pub fs_path: String,
    pub title: String,
}

pub fn list_templates(settings: &AppSettings) -> Vec<TemplateInfo> {
    if settings.notebook_root.is_empty() {
        return Vec::new();
    }
    let dir = settings.templates_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new(); // templates folder doesn't exist yet
    };

    let mut templates: Vec<TemplateInfo> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".md") || !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let full_path = dir.join(&name);
        let mut title = clean_display_name(name.strip_suffix(".md").unwrap_or(&name));
        if let Ok(raw) = std::fs::read_to_string(&full_path) {
            if let Some(caps) = TEMPLATE_TITLE_RE.captures(&raw) {
                title = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or(title);
            }
        }
        templates.push(TemplateInfo {
            name,
            fs_path: full_path.to_string_lossy().into_owned(),
            title,
        });
    }
    templates.sort_by(|a, b| a.title.cmp(&b.title));
    templates
}

/// The custom (non-built-in) {{variables}} a template asks for, in order of
/// first appearance, de-duplicated.
pub fn template_variables(settings: &AppSettings, template_name: &str) -> Vec<String> {
    let path = settings.templates_dir().join(template_name);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let builtin: Vec<String> = builtin_template_vars("", "")
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    let mut found: Vec<String> = Vec::new();
    for caps in VAR_RE.captures_iter(&raw) {
        let name = caps.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
        if !builtin.contains(&name) && !found.contains(&name) {
            found.push(name);
        }
    }
    found
}

/// Read a template body, ready for variable substitution.
pub fn read_template_body(settings: &AppSettings, template_name: &str) -> Option<String> {
    let path = settings.templates_dir().join(template_name);
    let raw = std::fs::read_to_string(path).ok()?;
    Some(TEMPLATE_TITLE_STRIP_RE.replace(&raw, "").into_owned())
}

pub fn create_template(settings: &AppSettings, name: &str) -> Option<PathBuf> {
    if settings.notebook_root.is_empty() {
        return None;
    }
    let dir = settings.templates_dir();
    std::fs::create_dir_all(&dir).ok()?;

    let starter = [
        format!("<!-- template-title: {name} -->"),
        String::new(),
        "## Overview".into(),
        String::new(),
        "Notes about {{title}}, started on {{weekday}} {{date}}.".into(),
        String::new(),
        "## Details".into(),
        String::new(),
        "- [ ] First action item".into(),
        String::new(),
    ]
    .join("\n");

    let base = {
        let s = slug(name);
        if s.is_empty() {
            "template".to_string()
        } else {
            s
        }
    };
    let full_path = dir.join(unique_md(&dir, &base));
    std::fs::write(&full_path, starter).ok()?;
    Some(full_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn temp_notebook(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdnb-tpl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("templates")).unwrap();
        dir
    }

    fn settings_for(root: &Path) -> AppSettings {
        AppSettings {
            notebook_root: root.to_string_lossy().into_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn only_custom_variables_are_reported() {
        let root = temp_notebook("vars");
        let settings = settings_for(&root);
        std::fs::write(
            root.join("templates").join("meeting.md"),
            "# {{title}} on {{date}}\nAttendees: {{ attendees }}\nProject: {{project}}\nAgain: {{attendees}}\n",
        )
        .unwrap();

        // title/date are built in; attendees/project are asked for, in order,
        // and the repeat is dropped.
        assert_eq!(
            template_variables(&settings, "meeting.md"),
            vec!["attendees", "project"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_title_marker_names_the_template_and_is_stripped_from_the_body() {
        let root = temp_notebook("title");
        let settings = settings_for(&root);
        std::fs::write(
            root.join("templates").join("wk.md"),
            "<!-- template-title: Weekly Review -->\n\n## Wins\n",
        )
        .unwrap();

        let listed = list_templates(&settings);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Weekly Review");
        assert_eq!(listed[0].name, "wk.md");

        // The marker line and the blank line after it both go, matching the
        // greedy \s* the Electron build used.
        let body = read_template_body(&settings, "wk.md").unwrap();
        assert_eq!(body, "## Wins\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn templates_without_a_marker_fall_back_to_a_prettified_filename() {
        let root = temp_notebook("fallback");
        let settings = settings_for(&root);
        std::fs::write(
            root.join("templates").join("project-kickoff.md"),
            "## Goals\n",
        )
        .unwrap();
        assert_eq!(list_templates(&settings)[0].title, "Project Kickoff");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_templates_folder_lists_nothing() {
        let root = std::env::temp_dir().join(format!("mdnb-tpl-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(list_templates(&settings_for(&root)).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_created_template_has_no_frontmatter_or_h1() {
        let root = temp_notebook("create");
        let settings = settings_for(&root);
        let path = create_template(&settings, "Weekly Review").unwrap();
        assert_eq!(path.file_name().unwrap(), "weekly-review.md");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(!body.starts_with("---"));
        assert!(!body.contains("\n# "));
        assert!(body.contains("<!-- template-title: Weekly Review -->"));
        let _ = std::fs::remove_dir_all(&root);
    }
}

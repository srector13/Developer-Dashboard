//! Notebook model: frontmatter parsing, manual ordering files, and the
//! directory scan that produces the sidebar tree.
//!
//! The scan is also where the full-text search index comes from — it already
//! reads every note, so indexing costs no extra file reads. Two caches keep
//! steady-state rescans and cold starts cheap; both are keyed on
//! (mtime, size) exactly as the Electron build's were.

use crate::settings::{AppSettings, ORDER_FILE, SECTION_META_FILE};
use crate::util::{clean_display_name, rel_path};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskLine {
    pub text: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub title: String,
    pub created: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub open_tasks: usize,
    pub completed_tasks: usize,
    /// Open-task lines collected during the scan that already reads every
    /// file, so landing pages never need to re-read notes for them.
    pub task_lines: Vec<TaskLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageNode {
    pub kind: &'static str,
    pub name: String,
    pub fs_path: String,
    pub rel_path: String,
    pub title: String,
    pub created: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub open_tasks: usize,
    pub completed_tasks: usize,
    pub task_lines: Vec<TaskLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionNode {
    pub kind: &'static str,
    pub name: String,
    pub fs_path: String,
    pub rel_path: String,
    pub pages: Vec<PageNode>,
    pub sections: Vec<SectionNode>,
    /// Optional folder description from .section.json (dot-file: never a page)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

// ---------------------------------------------------------------------------
// Frontmatter + task parsing
// ---------------------------------------------------------------------------

static OPEN_TASK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^([ \t]*([-*+]\s+|\d+\.\s+)?)\[ \]").unwrap());
static DONE_TASK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^([ \t]*([-*+]\s+|\d+\.\s+)?)\[x\]").unwrap());
static FRONTMATTER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---(?:[ \t]*(?:\r?\n|$))").unwrap());
static DAILY_KEY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\d{4}-\d{2}-\d{2})").unwrap());

fn strip_quotes(s: &str) -> &str {
    let t = s.trim();
    if t.len() >= 2
        && ((t.starts_with('\'') && t.ends_with('\'')) || (t.starts_with('"') && t.ends_with('"')))
    {
        &t[1..t.len() - 1]
    } else {
        t
    }
}

fn parse_inline_list(val: &str) -> Vec<String> {
    let clean = val.trim();
    if clean.starts_with('[') && clean.ends_with(']') {
        return clean[1..clean.len() - 1]
            .split(',')
            .map(|s| strip_quotes(s).to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }
    vec![clean.to_string()]
}

fn parse_block_list(lines: &[&str], start_idx: usize) -> Vec<String> {
    static ITEM_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*- ").unwrap());
    static UNINDENTED_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\S+").unwrap());
    let mut out = Vec::new();
    for line in lines.iter().skip(start_idx) {
        if ITEM_RE.is_match(line) {
            let item = line.trim_start();
            out.push(strip_quotes(item.trim_start_matches('-').trim()).to_string());
        } else if line.trim().is_empty() || UNINDENTED_RE.is_match(line) {
            break;
        }
    }
    out
}

/// Title, tags, pin state and task counts for one note.
pub fn parse_note_meta(content: &str, file_path: &Path) -> NoteMeta {
    let stem = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut meta = NoteMeta {
        title: clean_display_name(&stem),
        created: String::new(),
        tags: Vec::new(),
        pinned: false,
        open_tasks: 0,
        completed_tasks: 0,
        task_lines: Vec::new(),
    };

    for (index, line) in content.split('\n').enumerate() {
        let line = line.trim_end_matches('\r');
        if OPEN_TASK_RE.is_match(line) {
            meta.open_tasks += 1;
            meta.task_lines.push(TaskLine {
                text: OPEN_TASK_RE.replace(line, "").trim().to_string(),
                line: index,
            });
        } else if DONE_TASK_RE.is_match(line) {
            meta.completed_tasks += 1;
        }
    }

    if let Some(caps) = FRONTMATTER_RE.captures(content) {
        let block = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let fm_lines: Vec<&str> = block.split('\n').map(|l| l.trim_end_matches('\r')).collect();
        for (index, line) in fm_lines.iter().enumerate() {
            let Some(colon) = line.find(':') else { continue };
            let key = line[..colon].trim().to_lowercase();
            let val = line[colon + 1..].trim();
            match key.as_str() {
                "title" => meta.title = clean_display_name(strip_quotes(val)),
                "created" => meta.created = strip_quotes(val).to_string(),
                "pinned" => meta.pinned = val.eq_ignore_ascii_case("true"),
                "tags" => {
                    meta.tags = if val.is_empty() {
                        parse_block_list(&fm_lines, index + 1)
                    } else {
                        parse_inline_list(val)
                    }
                }
                _ => {}
            }
        }
    }

    meta
}

pub fn parse_daily_key(filename: &str) -> Option<String> {
    DAILY_KEY_RE
        .captures(filename)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

// ---------------------------------------------------------------------------
// Manual ordering files
// ---------------------------------------------------------------------------

pub fn read_order_file(dir: &Path) -> Vec<String> {
    match std::fs::read_to_string(dir.join(ORDER_FILE)) {
        Ok(text) => text
            .split('\n')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub fn write_order_file(dir: &Path, list: &[String]) -> std::io::Result<()> {
    let path = dir.join(ORDER_FILE);
    if list.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    std::fs::write(path, format!("{}\n", list.join("\n")))
}

pub fn read_section_description(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join(SECTION_META_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("description")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Search documents + scan caches
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SearchDoc {
    pub fs_path: String,
    pub rel_path: String,
    pub title: String,
    pub lines: Vec<String>,
}

/// bytes; skip pathological files
pub const SEARCH_MAX_INDEXED_FILE: u64 = 1_000_000;
pub const SCAN_CACHE_MAX: usize = 5000;
/// Files modified in the last 2s are always re-read: sub-second mtime
/// granularity on some filesystems plus the app's own write→rescan races.
pub const SCAN_CACHE_FRESHNESS_MS: i64 = 2000;

#[derive(Debug, Clone)]
pub struct ScanCacheEntry {
    pub mtime_ms: i64,
    pub size: u64,
    pub meta: NoteMeta,
    /// None when the file exceeds SEARCH_MAX_INDEXED_FILE.
    pub doc: Option<SearchDoc>,
}

/// The persisted half: metadata only (small). Search docs are rebuilt in the
/// background after the tree is returned, so a cold start costs one stat() per
/// unchanged note instead of a full read and parse.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedMeta {
    pub mtime_ms: i64,
    pub size: u64,
    pub meta: NoteMeta,
}

pub fn file_stamp(path: &Path) -> Option<(i64, u64)> {
    let md = std::fs::metadata(path).ok()?;
    let modified = md.modified().ok()?;
    let ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some((ms, md.len()))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn make_search_doc(root: &Path, path: &Path, text: &str, title: &str) -> Option<SearchDoc> {
    if text.len() as u64 > SEARCH_MAX_INDEXED_FILE {
        return None;
    }
    Some(SearchDoc {
        fs_path: path.to_string_lossy().into_owned(),
        rel_path: rel_path(root, path),
        title: title.to_string(),
        lines: text
            .split('\n')
            .map(|l| l.trim_end_matches('\r').to_string())
            .collect(),
    })
}

/// Everything a single scan pass needs to carry around.
pub struct ScanContext<'a> {
    pub root: &'a Path,
    pub ignore: &'a HashSet<String>,
    pub scratchpad_file: &'a str,
    /// Skip subdirectory recursion (move-node only needs one directory).
    pub shallow: bool,
    /// Populated only by the full tree scan.
    pub collector: Option<&'a mut HashMap<String, SearchDoc>>,
    /// Every .md path encountered; full scans prune the caches against it.
    pub seen: Option<&'a mut HashSet<String>>,
    /// Paths served from the persisted cache whose search docs still need
    /// building, handed to the background builder afterwards.
    pub pending_docs: Vec<String>,
    pub cache: &'a mut HashMap<String, ScanCacheEntry>,
    pub persisted: &'a mut HashMap<String, PersistedMeta>,
}

/// Recursive directory scan producing one section node.
pub fn scan_directory(dir: &Path, ctx: &mut ScanContext) -> SectionNode {
    let relative = rel_path(ctx.root, dir);
    let name = dir
        .file_name()
        .map(|n| clean_display_name(&n.to_string_lossy()))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Root".to_string());

    let mut section = SectionNode {
        kind: "section",
        name,
        fs_path: dir.to_string_lossy().into_owned(),
        rel_path: relative.clone(),
        pages: Vec::new(),
        sections: Vec::new(),
        description: read_section_description(dir),
    };

    let Ok(entries) = std::fs::read_dir(dir) else {
        return section;
    };

    for entry in entries.flatten() {
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        let entry_name_lower = entry_name.to_lowercase();
        if entry_name.starts_with('.') || ctx.ignore.contains(&entry_name_lower) {
            continue;
        }
        let full_path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            if !ctx.shallow {
                let child = scan_directory(&full_path, ctx);
                section.sections.push(child);
            }
        } else if file_type.is_file() && entry_name.ends_with(".md") {
            // Skip scratchpad.md if it is in the section root
            if entry_name == ctx.scratchpad_file && relative.is_empty() {
                continue;
            }
            if let Some(page) = scan_page(&full_path, &entry_name, ctx) {
                section.pages.push(page);
            }
        }
    }

    section.sections.sort_by(|a, b| a.name.cmp(&b.name));
    order_pages(&mut section, dir);
    section
}

fn scan_page(full_path: &Path, entry_name: &str, ctx: &mut ScanContext) -> Option<PageNode> {
    let key = full_path.to_string_lossy().into_owned();
    if let Some(seen) = ctx.seen.as_deref_mut() {
        seen.insert(key.clone());
    }

    let (mtime_ms, size) = file_stamp(full_path)?;
    let fresh = now_ms() - mtime_ms > SCAN_CACHE_FRESHNESS_MS;

    let meta: NoteMeta;
    let mut doc: Option<SearchDoc> = None;
    let mut have_doc = false;

    let cached = ctx.cache.get(&key);
    if let Some(hit) = cached.filter(|c| c.mtime_ms == mtime_ms && c.size == size && fresh) {
        // Steady state: no read, no parse.
        meta = hit.meta.clone();
        doc = hit.doc.clone();
        have_doc = true;
    } else if let Some(persisted) = ctx
        .persisted
        .get(&key)
        .filter(|p| p.mtime_ms == mtime_ms && p.size == size && fresh)
    {
        // Cold start: an unchanged file's meta comes from the persisted cache
        // for the cost of the stat above. Its search doc is rebuilt in the
        // background after the tree is returned.
        meta = persisted.meta.clone();
        if ctx.collector.is_some() {
            ctx.pending_docs.push(key.clone());
        }
    } else {
        let text = std::fs::read_to_string(full_path).ok()?;
        meta = parse_note_meta(&text, full_path);
        doc = make_search_doc(ctx.root, full_path, &text, &meta.title);
        have_doc = true;
        ctx.cache.insert(
            key.clone(),
            ScanCacheEntry {
                mtime_ms,
                size,
                meta: meta.clone(),
                doc: doc.clone(),
            },
        );
        ctx.persisted.insert(
            key.clone(),
            PersistedMeta {
                mtime_ms,
                size,
                meta: meta.clone(),
            },
        );
    }

    if have_doc {
        if let (Some(collector), Some(d)) = (ctx.collector.as_deref_mut(), doc.as_ref()) {
            collector.insert(key.clone(), d.clone());
        }
    }

    Some(PageNode {
        kind: "page",
        name: entry_name.to_string(),
        fs_path: key,
        rel_path: rel_path(ctx.root, full_path),
        title: meta.title,
        created: meta.created,
        tags: meta.tags,
        pinned: meta.pinned,
        open_tasks: meta.open_tasks,
        completed_tasks: meta.completed_tasks,
        task_lines: meta.task_lines,
        daily_key: parse_daily_key(entry_name),
    })
}

/// Daily notes ALWAYS float to the top of their section, newest first, so
/// today's note is immediately visible. The manual order file only governs the
/// non-daily pages; anything it doesn't mention sorts by title.
fn order_pages(section: &mut SectionNode, dir: &Path) {
    let all = std::mem::take(&mut section.pages);
    let (mut daily, non_daily): (Vec<_>, Vec<_>) =
        all.into_iter().partition(|p| p.daily_key.is_some());
    daily.sort_by(|a, b| b.daily_key.cmp(&a.daily_key));

    let order_list = read_order_file(dir);
    let order_map: HashMap<String, usize> = order_list
        .iter()
        .enumerate()
        .map(|(i, n)| (n.to_lowercase(), i))
        .collect();

    let (mut ordered, mut unlisted): (Vec<_>, Vec<_>) = non_daily
        .into_iter()
        .partition(|p| order_map.contains_key(&p.name.to_lowercase()));
    ordered.sort_by_key(|p| *order_map.get(&p.name.to_lowercase()).unwrap_or(&0));
    unlisted.sort_by(|a, b| a.title.cmp(&b.title));

    section.pages = daily;
    section.pages.extend(ordered);
    section.pages.extend(unlisted);
}

/// Keep only pages carrying `tag`, and only sections that still hold something.
pub fn filter_by_tag(section: &mut SectionNode, tag_lower: &str) -> bool {
    section
        .pages
        .retain(|p| p.tags.iter().any(|t| t.to_lowercase() == tag_lower));
    section.sections.retain_mut(|s| filter_by_tag(s, tag_lower));
    !section.pages.is_empty() || !section.sections.is_empty()
}

/// Every markdown file under `root`, skipping dot-entries and ignored folders.
pub fn list_markdown_files(root: &Path, ignore: &HashSet<String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_markdown(root, ignore, &mut out);
    out
}

fn collect_markdown(dir: &Path, ignore: &HashSet<String>, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || ignore.contains(&name.to_lowercase()) {
            continue;
        }
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => collect_markdown(&path, ignore, out),
            Ok(ft) if ft.is_file() && name.ends_with(".md") => out.push(path),
            _ => {}
        }
    }
}

/// Convenience wrapper for the callers that only need "all notes in settings".
pub fn all_markdown_files(settings: &AppSettings) -> Vec<PathBuf> {
    let root = settings.root();
    if root.as_os_str().is_empty() || !root.exists() {
        return Vec::new();
    }
    list_markdown_files(&root, &settings.ignore_set())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_title_tags_and_pin() {
        let src = "---\ntitle: Weekly Review\ncreated: 2026-07-13\npinned: true\ntags: [work, review]\n---\n\n# Weekly Review\n";
        let meta = parse_note_meta(src, Path::new("/n/weekly-review.md"));
        assert_eq!(meta.title, "Weekly Review");
        assert_eq!(meta.created, "2026-07-13");
        assert!(meta.pinned);
        assert_eq!(meta.tags, vec!["work", "review"]);
    }

    #[test]
    fn falls_back_to_the_filename_for_the_title() {
        let meta = parse_note_meta("no frontmatter", Path::new("/n/project-kickoff.md"));
        assert_eq!(meta.title, "Project Kickoff");
    }

    #[test]
    fn counts_tasks_and_records_open_ones_with_line_numbers() {
        let src = "# T\n\n- [ ] first\n- [x] done\n  - [ ] nested\n1. [ ] numbered\n";
        let meta = parse_note_meta(src, Path::new("/n/t.md"));
        assert_eq!(meta.open_tasks, 3);
        assert_eq!(meta.completed_tasks, 1);
        assert_eq!(meta.task_lines[0], TaskLine { text: "first".into(), line: 2 });
        assert_eq!(meta.task_lines[1].line, 4);
        assert_eq!(meta.task_lines[2].text, "numbered");
    }

    #[test]
    fn reads_block_style_tag_lists() {
        let src = "---\ntitle: X\ntags:\n  - alpha\n  - beta\n---\n";
        let meta = parse_note_meta(src, Path::new("/n/x.md"));
        assert_eq!(meta.tags, vec!["alpha", "beta"]);
    }

    #[test]
    fn a_later_horizontal_rule_does_not_end_the_frontmatter() {
        let src = "---\ntitle: X\ntags: [a]\n---\n\nBody\n\n---\n\nMore\n";
        let meta = parse_note_meta(src, Path::new("/n/x.md"));
        assert_eq!(meta.title, "X");
        assert_eq!(meta.tags, vec!["a"]);
    }

    #[test]
    fn daily_keys_come_from_the_filename() {
        assert_eq!(parse_daily_key("2026-07-13.md"), Some("2026-07-13".into()));
        assert_eq!(parse_daily_key("2026-07-13-standup.md"), Some("2026-07-13".into()));
        assert_eq!(parse_daily_key("notes.md"), None);
    }

    #[test]
    fn quoted_frontmatter_values_are_unwrapped() {
        let src = "---\ntitle: \"Q3: Planning\"\ncreated: '2026-01-02'\n---\n";
        let meta = parse_note_meta(src, Path::new("/n/x.md"));
        assert_eq!(meta.title, "Q3: Planning");
        assert_eq!(meta.created, "2026-01-02");
    }
}

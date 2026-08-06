//! The note lifecycle: saving (with version history), the trash, renaming
//! with wiki-link rewriting, manual ordering and frontmatter edits.

use crate::notebook::{parse_note_meta, read_order_file, write_order_file};
use crate::settings::AppSettings;
use crate::util::{
    clean_display_name, is_inside, rel_path, slug, stamp_compact, tags_yaml_line, unique_file,
    unique_md, yaml_value,
};
use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};

pub type Res<T> = Result<T, String>;

fn io<T>(r: std::io::Result<T>) -> Res<T> {
    r.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Version history: bounded save snapshots under <root>/.history/
// ---------------------------------------------------------------------------

const HISTORY_MAX_SNAPSHOTS: usize = 20;
const HISTORY_MIN_INTERVAL_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub saved_at: String,
    pub size: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIndex {
    #[serde(default)]
    pub rel_path: String,
    #[serde(default)]
    pub entries: Vec<HistoryEntry>,
}

/// Snapshot ids are ISO stamps with `:` and `.` replaced by `-`.
static HISTORY_ID_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\w\-]+$").unwrap());

pub fn history_dir_for(root: &Path, file_path: &Path) -> PathBuf {
    let rel = rel_path(root, file_path);
    let mut hasher = Sha1::new();
    hasher.update(rel.as_bytes());
    let hash = hex::encode(hasher.finalize());
    root.join(".history").join(&hash[..12])
}

pub fn read_history_index(dir: &Path, rel: &str) -> HistoryIndex {
    match std::fs::read_to_string(dir.join("index.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<HistoryIndex>(&t).ok())
    {
        Some(mut idx) => {
            if idx.rel_path.is_empty() {
                idx.rel_path = rel.to_string();
            }
            idx
        }
        None => HistoryIndex {
            rel_path: rel.to_string(),
            entries: Vec::new(),
        },
    }
}

pub fn write_history_index(dir: &Path, index: &HistoryIndex) -> Res<()> {
    io(std::fs::write(
        dir.join("index.json"),
        serde_json::to_string_pretty(index).map_err(|e| e.to_string())?,
    ))
}

/// Snapshot `content` (the note's PREVIOUS state). Rate-limited unless `force`
/// is set, which restore uses so a restore is itself undoable.
fn snapshot_note(root: &Path, file_path: &Path, content: &str, force: bool) -> Res<()> {
    let rel = rel_path(root, file_path);
    let dir = history_dir_for(root, file_path);
    io(std::fs::create_dir_all(&dir))?;
    let mut index = read_history_index(&dir, &rel);

    if !force {
        if let Some(newest) = index.entries.first() {
            if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&newest.saved_at) {
                let age = chrono::Utc::now().timestamp_millis() - parsed.timestamp_millis();
                if age < HISTORY_MIN_INTERVAL_MS {
                    return Ok(());
                }
            }
        }
    }

    let saved_at = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let id = saved_at.replace([':', '.'], "-");
    io(std::fs::write(dir.join(format!("{id}.md")), content))?;
    index.rel_path = rel;
    index.entries.insert(
        0,
        HistoryEntry {
            id,
            saved_at,
            size: content.len(),
        },
    );

    while index.entries.len() > HISTORY_MAX_SNAPSHOTS {
        if let Some(dropped) = index.entries.pop() {
            let _ = std::fs::remove_file(dir.join(format!("{}.md", dropped.id)));
        }
    }
    write_history_index(&dir, &index)
}

/// Shared write path: snapshots the previous on-disk content when it changed
/// materially. History lives under dot-prefixed `.history/`, so these writes
/// never wake the file watcher.
pub fn write_note_file(
    settings: &AppSettings,
    file_path: &Path,
    content: &str,
    snapshot: bool,
    force_snapshot: bool,
) -> Res<()> {
    if snapshot {
        let root = settings.root();
        if is_inside(&root, file_path) {
            if let Ok(prev) = std::fs::read_to_string(file_path) {
                if prev != content {
                    if let Err(err) = snapshot_note(&root, file_path, &prev, force_snapshot) {
                        eprintln!("History snapshot failed: {err}");
                    }
                }
            }
        }
    }
    io(std::fs::write(file_path, content))
}

pub fn list_history(settings: &AppSettings, file_path: &Path) -> Vec<HistoryEntry> {
    let root = settings.root();
    if root.as_os_str().is_empty() {
        return Vec::new();
    }
    let dir = history_dir_for(&root, file_path);
    read_history_index(&dir, &rel_path(&root, file_path)).entries
}

pub fn read_history(settings: &AppSettings, file_path: &Path, id: &str) -> String {
    let root = settings.root();
    if root.as_os_str().is_empty() || !HISTORY_ID_RE.is_match(id) {
        return String::new();
    }
    let dir = history_dir_for(&root, file_path);
    std::fs::read_to_string(dir.join(format!("{id}.md"))).unwrap_or_default()
}

pub fn restore_history(settings: &AppSettings, file_path: &Path, id: &str) -> Res<bool> {
    let root = settings.root();
    if root.as_os_str().is_empty() || !HISTORY_ID_RE.is_match(id) {
        return Ok(false);
    }
    let dir = history_dir_for(&root, file_path);
    let Ok(snapshot) = std::fs::read_to_string(dir.join(format!("{id}.md"))) else {
        return Ok(false);
    };
    // Snapshot the current content first (bypassing the rate limit), then
    // write the historical content.
    write_note_file(settings, file_path, &snapshot, true, true)?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Trash: soft delete into <root>/.trash/ with sidecar metadata
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashMeta {
    pub original_rel_path: String,
    pub deleted_at: String,
    pub kind: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    #[serde(flatten)]
    pub meta: TrashMeta,
    pub trash_name: String,
}

fn trash_dir_for(root: &Path) -> PathBuf {
    root.join(".trash")
}

static TRASH_STAMP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{8}-\d{6}-").unwrap());

/// Move a file or whole folder into the trash; returns the trash entry name.
fn move_to_trash(root: &Path, file_path: &Path) -> Res<String> {
    let trash_dir = trash_dir_for(root);
    io(std::fs::create_dir_all(&trash_dir))?;

    let is_dir = file_path.is_dir();
    let stamp = stamp_compact();
    let base = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut trash_name = format!("{stamp}-{base}");
    let mut i = 1;
    while trash_dir.join(&trash_name).exists() {
        trash_name = format!("{stamp}-{i}-{base}");
        i += 1;
    }
    let dest = trash_dir.join(&trash_name);

    if std::fs::rename(file_path, &dest).is_err() {
        // Cross-device fallback
        copy_recursive(file_path, &dest)?;
        io(remove_any(file_path))?;
    }

    let mut title = clean_display_name(if is_dir {
        &base
    } else {
        base.strip_suffix(".md").unwrap_or(&base)
    });
    if !is_dir {
        if let Ok(text) = std::fs::read_to_string(&dest) {
            title = parse_note_meta(&text, &dest).title;
        }
    }

    let meta = TrashMeta {
        original_rel_path: rel_path(root, file_path),
        deleted_at: chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
        kind: if is_dir { "section" } else { "page" }.to_string(),
        title,
    };
    io(std::fs::write(
        trash_dir.join(format!("{trash_name}.trashmeta.json")),
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
    ))?;
    Ok(trash_name)
}

fn remove_any(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

fn copy_recursive(src: &Path, dest: &Path) -> Res<()> {
    if src.is_dir() {
        io(std::fs::create_dir_all(dest))?;
        for entry in io(std::fs::read_dir(src))?.flatten() {
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        io(std::fs::copy(src, dest)).map(|_| ())
    }
}

pub fn delete_node(settings: &AppSettings, file_path: &Path) -> Res<bool> {
    if !file_path.exists() {
        return Ok(true);
    }
    let root = settings.root();
    if !is_inside(&root, file_path) {
        // Outside the notebook (e.g. an absolute templates dir): hard delete
        io(remove_any(file_path))?;
    } else {
        move_to_trash(&root, file_path)?;
    }

    // Remove pages from their folder's order file
    if file_path.extension().is_some_and(|e| e == "md") {
        if let (Some(dir), Some(name)) = (file_path.parent(), file_path.file_name()) {
            let name = name.to_string_lossy().into_owned();
            let mut ord = read_order_file(dir);
            if let Some(idx) = ord.iter().position(|n| *n == name) {
                ord.remove(idx);
                io(write_order_file(dir, &ord))?;
            }
        }
    }
    Ok(true)
}

pub fn list_trash(settings: &AppSettings) -> Vec<TrashItem> {
    let root = settings.root();
    if root.as_os_str().is_empty() {
        return Vec::new();
    }
    let trash_dir = trash_dir_for(&root);
    let Ok(entries) = std::fs::read_dir(&trash_dir) else {
        return Vec::new();
    };

    let mut items: Vec<TrashItem> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".trashmeta.json") {
            continue;
        }
        let stripped = TRASH_STAMP_RE.replace(&name, "").into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let mut meta = TrashMeta {
            original_rel_path: stripped.clone(),
            deleted_at: String::new(),
            kind: if is_dir { "section" } else { "page" }.to_string(),
            title: clean_display_name(stripped.strip_suffix(".md").unwrap_or(&stripped)),
        };
        if let Ok(text) = std::fs::read_to_string(trash_dir.join(format!("{name}.trashmeta.json")))
        {
            if let Ok(stored) = serde_json::from_str::<TrashMeta>(&text) {
                meta = stored;
            }
        }
        items.push(TrashItem {
            meta,
            trash_name: name,
        });
    }
    items.sort_by(|a, b| b.meta.deleted_at.cmp(&a.meta.deleted_at));
    items
}

/// Trash entry names come back from list_trash; refuse anything path-like.
fn safe_trash_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && name != "." && name != ".."
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn restore_trash_item(settings: &AppSettings, trash_name: &str) -> RestoreResult {
    let root = settings.root();
    if root.as_os_str().is_empty() || !safe_trash_name(trash_name) {
        return RestoreResult {
            success: false,
            restored_path: None,
            reason: Some("Invalid item.".into()),
        };
    }
    let trash_dir = trash_dir_for(&root);
    let src = trash_dir.join(trash_name);
    if !src.exists() {
        return RestoreResult {
            success: false,
            restored_path: None,
            reason: Some("Item no longer in trash.".into()),
        };
    }

    let mut original_rel = TRASH_STAMP_RE.replace(trash_name, "").into_owned();
    let meta_path = trash_dir.join(format!("{trash_name}.trashmeta.json"));
    if let Ok(text) = std::fs::read_to_string(&meta_path) {
        if let Ok(meta) = serde_json::from_str::<TrashMeta>(&text) {
            if !meta.original_rel_path.is_empty() {
                original_rel = meta.original_rel_path;
            }
        }
    }

    let mut target = root.join(&original_rel);
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    if target.exists() {
        // Collision: uniquify
        let dir = target.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let base = target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if base.to_lowercase().ends_with(".md") {
            target = dir.join(unique_md(&dir, &base[..base.len() - 3]));
        } else {
            let mut i = 1;
            let mut candidate = format!("{base}-restored");
            while dir.join(&candidate).exists() {
                candidate = format!("{base}-restored-{i}");
                i += 1;
            }
            target = dir.join(candidate);
        }
    }

    if std::fs::rename(&src, &target).is_err() {
        if copy_recursive(&src, &target).is_err() {
            return RestoreResult {
                success: false,
                restored_path: None,
                reason: Some("Could not move the item back.".into()),
            };
        }
        let _ = remove_any(&src);
    }
    let _ = std::fs::remove_file(&meta_path);

    // Restored pages rejoin their folder's manual ordering
    if target.extension().is_some_and(|e| e == "md") {
        if let (Some(dir), Some(name)) = (target.parent(), target.file_name()) {
            let name = name.to_string_lossy().into_owned();
            let mut ord = read_order_file(dir);
            if !ord.is_empty() && !ord.contains(&name) {
                ord.push(name);
                let _ = write_order_file(dir, &ord);
            }
        }
    }

    RestoreResult {
        success: true,
        restored_path: Some(target.to_string_lossy().into_owned()),
        reason: None,
    }
}

pub fn delete_trash_item(settings: &AppSettings, trash_name: &str) -> bool {
    let root = settings.root();
    if root.as_os_str().is_empty() || !safe_trash_name(trash_name) {
        return false;
    }
    let trash_dir = trash_dir_for(&root);
    let _ = remove_any(&trash_dir.join(trash_name));
    let _ = std::fs::remove_file(trash_dir.join(format!("{trash_name}.trashmeta.json")));
    true
}

pub fn empty_trash(settings: &AppSettings) -> usize {
    let root = settings.root();
    if root.as_os_str().is_empty() {
        return 0;
    }
    let trash_dir = trash_dir_for(&root);
    let Ok(entries) = std::fs::read_dir(&trash_dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".trashmeta.json") {
            removed += 1;
        }
        let _ = remove_any(&entry.path());
    }
    removed
}

// ---------------------------------------------------------------------------
// Rename + wiki-link rewriting
// ---------------------------------------------------------------------------

static WIKI_LINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[\[([^\[\]]+?)\]\]").unwrap());
static SUBTARGET_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[#^].*$").unwrap());

/// Retarget `[[old]]` links at a renamed note.
///
/// A link is only rewritten when it is unambiguous: either it spells out the
/// same directory as the renamed note, or the bare filename is unique across
/// the notebook. Anything else is left alone rather than risk pointing a link
/// at the wrong page.
pub fn rewrite_wiki_links(
    text: &str,
    old_base: &str,
    new_base: &str,
    bare_name_unique: bool,
    rel_dir: &str,
) -> String {
    let old_lc = old_base.to_lowercase();
    let rel_dir_lc = rel_dir
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();

    WIKI_LINK_RE
        .replace_all(text, |caps: &Captures| {
            let full = caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string();
            let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");

            let (target, alias) = match inner.find('|') {
                Some(pipe) => (&inner[..pipe], &inner[pipe..]),
                None => (inner, ""),
            };
            let sub = SUBTARGET_RE.find(target).map(|m| m.as_str()).unwrap_or("");
            let name_path = &target[..target.len() - sub.len()];
            let (dir_part, name) = match name_path.rfind('/') {
                Some(idx) => (&name_path[..idx + 1], &name_path[idx + 1..]),
                None => ("", name_path),
            };
            let has_md = name.to_lowercase().ends_with(".md");
            let bare = if has_md {
                &name[..name.len() - 3]
            } else {
                name
            };

            if bare.trim().to_lowercase() != old_lc {
                return full;
            }

            if !dir_part.is_empty() {
                let link_dir_lc = dir_part
                    .replace('\\', "/")
                    .trim_end_matches('/')
                    .to_lowercase();
                if link_dir_lc != rel_dir_lc {
                    return full;
                }
            } else if !bare_name_unique {
                return full; // ambiguous, don't rename
            }

            let rebuilt = format!("{new_base}{}", if has_md { ".md" } else { "" });
            format!("[[{dir_part}{rebuilt}{sub}{alias}]]")
        })
        .into_owned()
}

static FM_BLOCK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)^(---\r?\n)(.*?)(\r?\n---)(?:[ \t]*(?:\r?\n|$))").unwrap());
static TITLE_LINE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^title:.*$").unwrap());
static H1_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^(#[ \t]+)(.+?)([ \t]*)$").unwrap());

/// How a note is being renamed: the old and new filename stems plus the
/// disambiguation context wiki-link rewriting needs.
pub struct RenamePlan<'a> {
    pub old_base: &'a str,
    pub new_base: &'a str,
    /// False when the file is only retitled, not renamed on disk.
    pub renaming: bool,
    /// True when no other note in the notebook shares the old basename.
    pub bare_name_unique: bool,
    /// The note's folder, relative to the notebook root.
    pub rel_dir: &'a str,
}

/// Update the renamed note's own frontmatter title, its H1, and any
/// self-referential wiki links.
pub fn update_own_content(
    text: &str,
    old_title: Option<&str>,
    new_title: &str,
    plan: &RenamePlan,
) -> String {
    let mut out = text.to_string();

    if let Some(caps) = FM_BLOCK_RE.captures(text) {
        let whole = caps.get(0).unwrap();
        let open = caps.get(1).unwrap().as_str();
        let block = caps.get(2).unwrap().as_str();
        let close = caps.get(3).unwrap().as_str();
        let new_title_line = format!("title: {}", yaml_value(new_title));
        let new_block = if TITLE_LINE_RE.is_match(block) {
            TITLE_LINE_RE
                .replace(block, regex::NoExpand(&new_title_line))
                .into_owned()
        } else if block.is_empty() {
            new_title_line
        } else {
            format!("{new_title_line}\n{block}")
        };
        out = format!("{open}{new_block}{close}{}", &text[whole.end()..]);
    }

    if let Some(old_title) = old_title {
        let old_trim = old_title.trim().to_string();
        let new_title_owned = new_title.to_string();
        let mut replaced = false;
        out = H1_RE
            .replace(&out, |caps: &Captures| {
                if replaced {
                    return caps.get(0).unwrap().as_str().to_string();
                }
                replaced = true;
                let hashes = caps.get(1).unwrap().as_str();
                let txt = caps.get(2).unwrap().as_str();
                let tail = caps.get(3).unwrap().as_str();
                if txt.trim() == old_trim {
                    format!("{hashes}{new_title_owned}{tail}")
                } else {
                    caps.get(0).unwrap().as_str().to_string()
                }
            })
            .into_owned();
    }

    if plan.renaming {
        out = rewrite_wiki_links(
            &out,
            plan.old_base,
            plan.new_base,
            plan.bare_name_unique,
            plan.rel_dir,
        );
    }
    out
}

// ---------------------------------------------------------------------------
// Frontmatter metadata edits
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetaPatch {
    pub title: Option<String>,
    pub created: Option<String>,
    pub tags: Option<Vec<String>>,
    pub pinned: Option<bool>,
}

static DATE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());

pub fn sanitize_meta(meta: Option<&NoteMetaPatch>) -> (String, Vec<String>) {
    let created = meta
        .and_then(|m| m.created.as_deref())
        .filter(|c| DATE_RE.is_match(c))
        .map(|c| c.to_string())
        .unwrap_or_else(crate::util::local_date_string);
    let tags = meta
        .and_then(|m| m.tags.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().trim_start_matches('#').to_string())
        .filter(|t| !t.is_empty())
        .collect();
    (created, tags)
}

/// Replace `key: ...` (for tags, including a following block list) or append.
fn set_key(block: &str, key: &str, value: &str) -> String {
    let pattern = if key == "tags" {
        r"(?m)^[ \t]*tags:.*(?:\r?\n[ \t]+-[ \t].*)*".to_string()
    } else {
        format!(r"(?m)^[ \t]*{}:.*$", regex::escape(key))
    };
    let re = Regex::new(&pattern).unwrap();
    let replacement = format!("{key}: {value}");
    if re.is_match(block) {
        re.replace(block, regex::NoExpand(&replacement))
            .into_owned()
    } else {
        format!("{block}\n{replacement}")
    }
}

/// Update a note's frontmatter metadata (created/tags/pinned) in place,
/// preserving any other keys. The title is handled by rename instead, since it
/// can also change the filename and wiki-links.
pub fn apply_note_meta(text: &str, meta: &NoteMetaPatch) -> String {
    let created = meta
        .created
        .as_deref()
        .filter(|c| DATE_RE.is_match(c))
        .unwrap_or("");
    let tags: Vec<String> = meta
        .tags
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().trim_start_matches('#').to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let pinned = meta.pinned.unwrap_or(false);
    let tag_value = format!(
        "[{}]",
        tags.iter()
            .map(|t| yaml_value(t))
            .collect::<Vec<_>>()
            .join(", ")
    );

    if let Some(caps) = FM_BLOCK_RE.captures(text) {
        let whole = caps.get(0).unwrap();
        let open = caps.get(1).unwrap().as_str();
        let mut block = caps.get(2).unwrap().as_str().to_string();
        let close = caps.get(3).unwrap().as_str();
        if !created.is_empty() {
            block = set_key(&block, "created", created);
        }
        block = set_key(&block, "tags", &tag_value);
        if pinned || Regex::new(r"(?m)^[ \t]*pinned:").unwrap().is_match(&block) {
            block = set_key(&block, "pinned", if pinned { "true" } else { "false" });
        }
        format!("{open}{block}{close}{}", &text[whole.end()..])
    } else {
        // No frontmatter yet: create one
        let mut lines = vec!["---".to_string()];
        if !created.is_empty() {
            lines.push(format!("created: {created}"));
        }
        lines.push(tags_yaml_line(&tags));
        if pinned {
            lines.push("pinned: true".into());
        }
        lines.push("---".into());
        lines.push(String::new());
        format!("{}{}", lines.join("\n"), text)
    }
}

// ---------------------------------------------------------------------------
// Page creation
// ---------------------------------------------------------------------------

/// Compose a new page's file content: frontmatter, H1, then the (already
/// variable-substituted) template body.
pub fn compose_page(
    settings: &AppSettings,
    title: &str,
    created_date: &str,
    tags: &[String],
    body: &str,
) -> String {
    let mut fm = vec![
        "---".to_string(),
        format!("title: {}", yaml_value(title)),
        format!("created: {created_date}"),
    ];
    if !settings.author.is_empty() {
        fm.push(format!("author: {}", yaml_value(&settings.author)));
    }
    fm.push(tags_yaml_line(tags));
    fm.push("---".into());
    fm.push(String::new());
    fm.push(format!("# {title}"));
    fm.push(String::new());
    fm.push(body.to_string());
    fm.join("\n")
}

/// Write `content` as a new page in `dir` and append it to the order file.
pub fn create_page_file(dir: &Path, base_slug: &str, content: &str) -> Res<PathBuf> {
    let filename = unique_md(dir, base_slug);
    let full_path = dir.join(&filename);
    io(std::fs::write(&full_path, content))?;
    let mut ord = read_order_file(dir);
    ord.push(filename);
    io(write_order_file(dir, &ord))?;
    Ok(full_path)
}

// ---------------------------------------------------------------------------
// Task checkbox toggling
// ---------------------------------------------------------------------------

static CHECKBOX_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^([ \t]*(?:[-*+]\s+|\d+\.\s+)?)\[([ xX])\]").unwrap());

/// Flip the checkbox on `line_index`. Returns the new file text, or None when
/// that line has no checkbox.
pub fn toggle_task_line(content: &str, line_index: usize) -> Option<String> {
    let mut lines: Vec<String> = content
        .split('\n')
        .map(|l| l.trim_end_matches('\r').to_string())
        .collect();
    let line = lines.get(line_index)?;
    let caps = CHECKBOX_RE.captures(line)?;
    let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
    let checked = caps.get(2).map(|m| m.as_str()).unwrap_or(" ");
    let new_checked = if checked == " " { "x" } else { " " };
    let replacement = format!("{prefix}[{new_checked}]");
    lines[line_index] = CHECKBOX_RE
        .replace(line, regex::NoExpand(&replacement))
        .into_owned();
    Some(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// Moves and ordering
// ---------------------------------------------------------------------------

pub fn relocate_node(src_path: &Path, dest_dir: &Path) -> bool {
    if !src_path.exists() || !dest_dir.is_dir() {
        return false;
    }
    let Some(base_name) = src_path.file_name() else {
        return false;
    };
    let dest_path = dest_dir.join(base_name);
    if dest_path == src_path {
        return false;
    }
    // Prevent moving a folder into itself
    if dest_path.starts_with(src_path) {
        return false;
    }
    std::fs::rename(src_path, &dest_path).is_ok()
}

pub fn move_in_order(ord: &mut [String], file_name: &str, direction: &str) -> bool {
    let Some(idx) = ord.iter().position(|n| n.eq_ignore_ascii_case(file_name)) else {
        return false;
    };
    match direction {
        "up" if idx > 0 => ord.swap(idx, idx - 1),
        "down" if idx + 1 < ord.len() => ord.swap(idx, idx + 1),
        _ => {}
    }
    true
}

/// Uniquified attachment filename, exposed here so attachments and screenshots
/// share one implementation.
pub fn unique_attachment_name(dir: &Path, base_name: &str, default_ext: &str) -> String {
    let path = Path::new(base_name);
    let ext = path
        .extension()
        .map(|e| {
            e.to_string_lossy()
                .to_lowercase()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
        })
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| default_ext.to_string());
    let stem_raw = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = {
        let s = slug(&stem_raw);
        if s.is_empty() {
            "pasted-image".to_string()
        } else {
            s
        }
    };
    unique_file(dir, &format!("{}-{}", stamp_compact(), stem), &ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_a_bare_unique_link() {
        let out = rewrite_wiki_links("see [[old-page]] here", "old-page", "new-page", true, "");
        assert_eq!(out, "see [[new-page]] here");
    }

    #[test]
    fn keeps_the_alias_and_the_md_extension() {
        let out = rewrite_wiki_links("[[old-page.md|Label]]", "old-page", "new-page", true, "");
        assert_eq!(out, "[[new-page.md|Label]]");
    }

    #[test]
    fn keeps_a_heading_subtarget() {
        let out = rewrite_wiki_links("[[old-page#Section]]", "old-page", "new-page", true, "");
        assert_eq!(out, "[[new-page#Section]]");
        let out = rewrite_wiki_links("[[old-page^block|Alias]]", "old-page", "new", true, "");
        assert_eq!(out, "[[new^block|Alias]]");
    }

    #[test]
    fn leaves_ambiguous_bare_links_alone() {
        // Two notes share the basename, so a bare link could mean either.
        let out = rewrite_wiki_links("[[old-page]]", "old-page", "new-page", false, "projects");
        assert_eq!(out, "[[old-page]]");
    }

    #[test]
    fn rewrites_a_path_qualified_link_only_in_the_matching_folder() {
        let src = "[[projects/old-page]] and [[archive/old-page]]";
        let out = rewrite_wiki_links(src, "old-page", "new-page", false, "projects");
        assert_eq!(out, "[[projects/new-page]] and [[archive/old-page]]");
    }

    #[test]
    fn matches_folder_case_insensitively() {
        let out = rewrite_wiki_links(
            "[[Projects/Old-Page]]",
            "old-page",
            "new",
            false,
            "projects",
        );
        assert_eq!(out, "[[Projects/new]]");
    }

    #[test]
    fn leaves_unrelated_links_untouched() {
        let src = "[[other]] [[old-pages]] [[old-page-2]]";
        assert_eq!(rewrite_wiki_links(src, "old-page", "new", true, ""), src);
    }

    #[test]
    fn updates_frontmatter_title_and_h1() {
        let src = "---\ntitle: Old Title\ntags: [a]\n---\n\n# Old Title\n\nBody\n";
        let plan = RenamePlan {
            old_base: "old",
            new_base: "new",
            renaming: false,
            bare_name_unique: true,
            rel_dir: "",
        };
        let out = update_own_content(src, Some("Old Title"), "New Title", &plan);
        assert!(out.contains("title: New Title"));
        assert!(out.contains("# New Title"));
        assert!(out.contains("tags: [a]"));
        assert!(out.ends_with("Body\n"));
    }

    #[test]
    fn adds_a_title_key_when_the_frontmatter_lacks_one() {
        let src = "---\ncreated: 2026-01-01\n---\n\nBody\n";
        let plan = RenamePlan {
            old_base: "old",
            new_base: "new",
            renaming: false,
            bare_name_unique: true,
            rel_dir: "",
        };
        let out = update_own_content(src, None, "New Title", &plan);
        assert!(out.starts_with("---\ntitle: New Title\ncreated: 2026-01-01\n---"));
    }

    #[test]
    fn only_rewrites_the_h1_that_matches_the_old_title() {
        let src = "# Old Title\n\n# Something Else\n";
        let plan = RenamePlan {
            old_base: "o",
            new_base: "n",
            renaming: false,
            bare_name_unique: true,
            rel_dir: "",
        };
        let out = update_own_content(src, Some("Old Title"), "New", &plan);
        assert!(out.contains("# New\n"));
        assert!(out.contains("# Something Else"));
    }

    #[test]
    fn meta_patch_replaces_tags_and_keeps_other_keys() {
        let src = "---\ntitle: X\ncreated: 2026-01-01\nauthor: Sam\ntags: [old]\n---\n\nBody\n";
        let patch = NoteMetaPatch {
            created: Some("2026-02-02".into()),
            tags: Some(vec!["new".into(), "#hashed".into()]),
            pinned: Some(true),
            ..Default::default()
        };
        let out = apply_note_meta(src, &patch);
        assert!(out.contains("created: 2026-02-02"));
        assert!(out.contains("tags: [new, hashed]"));
        assert!(out.contains("pinned: true"));
        assert!(out.contains("author: Sam"));
        assert!(out.contains("title: X"));
    }

    #[test]
    fn meta_patch_replaces_a_block_style_tag_list() {
        let src = "---\ntitle: X\ntags:\n  - one\n  - two\n---\n\nBody\n";
        let patch = NoteMetaPatch {
            tags: Some(vec!["three".into()]),
            ..Default::default()
        };
        let out = apply_note_meta(src, &patch);
        assert!(out.contains("tags: [three]"), "got: {out}");
        assert!(!out.contains("- one"), "got: {out}");
    }

    #[test]
    fn meta_patch_creates_frontmatter_when_absent() {
        let out = apply_note_meta(
            "# Just a body\n",
            &NoteMetaPatch {
                created: Some("2026-03-03".into()),
                tags: Some(vec!["x".into()]),
                ..Default::default()
            },
        );
        assert!(out.starts_with("---\ncreated: 2026-03-03\ntags: [x]\n---\n"));
        assert!(out.ends_with("# Just a body\n"));
    }

    #[test]
    fn toggles_checkboxes_in_both_directions() {
        let src = "- [ ] one\n- [x] two\nplain\n";
        assert_eq!(
            toggle_task_line(src, 0).unwrap(),
            "- [x] one\n- [x] two\nplain\n"
        );
        assert_eq!(
            toggle_task_line(src, 1).unwrap(),
            "- [ ] one\n- [ ] two\nplain\n"
        );
        assert!(toggle_task_line(src, 2).is_none());
        assert!(toggle_task_line(src, 99).is_none());
    }

    #[test]
    fn toggles_indented_and_numbered_checkboxes() {
        let src = "  - [ ] nested\n1. [ ] numbered\n";
        assert!(toggle_task_line(src, 0)
            .unwrap()
            .starts_with("  - [x] nested"));
        assert!(toggle_task_line(src, 1)
            .unwrap()
            .contains("1. [x] numbered"));
    }

    #[test]
    fn order_moves_are_clamped_at_the_ends() {
        let mut ord: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        assert!(move_in_order(&mut ord, "a", "up"));
        assert_eq!(ord, ["a", "b", "c"]);
        assert!(move_in_order(&mut ord, "a", "down"));
        assert_eq!(ord, ["b", "a", "c"]);
        assert!(!move_in_order(&mut ord, "missing.md", "up"));
    }

    #[test]
    fn history_directories_are_stable_per_relative_path() {
        let root = Path::new("/notes");
        let a = history_dir_for(root, Path::new("/notes/sec/page.md"));
        let b = history_dir_for(root, Path::new("/notes/sec/page.md"));
        let c = history_dir_for(root, Path::new("/notes/other/page.md"));
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.file_name().unwrap().to_string_lossy().len(), 12);
    }

    #[test]
    fn composed_pages_carry_frontmatter_and_an_h1() {
        let settings = AppSettings {
            author: "Sam".into(),
            ..Default::default()
        };
        let out = compose_page(&settings, "My Page", "2026-05-05", &["a".into()], "Body");
        assert!(out.starts_with(
            "---\ntitle: My Page\ncreated: 2026-05-05\nauthor: Sam\ntags: [a]\n---\n"
        ));
        assert!(out.contains("\n# My Page\n"));
        assert!(out.ends_with("Body"));
    }
}

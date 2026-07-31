//! The `#[tauri::command]` surface. One command per Electron IPC channel,
//! named after it in snake_case — see renderer/api-tauri.js for the JS side.
//!
//! Commands are `async` so Tauri runs them on its worker pool rather than the
//! UI thread; the filesystem work inside is plain `std::fs`, matching the
//! Electron main process's behaviour.

use crate::attachments::{store_attachment, AttachmentResult};
use crate::cli;
use crate::capture::{self, CaptureResult};
use crate::desktop::{self, notify_files_changed};
use crate::exports;
use crate::notebook::{
    self, filter_by_tag, make_search_doc, parse_note_meta, read_order_file, scan_directory,
    write_order_file, ScanCacheEntry, ScanContext, SearchDoc, SectionNode,
};
use crate::notes::{self, HistoryEntry, NoteMetaPatch, RestoreResult, TrashItem};
use crate::pandoc;
use crate::platform;
use crate::search::{self, LauncherResult, SearchResult};
use crate::settings::AppSettings;
use crate::state::{AppState, PendingShot};
use crate::templates::{self, TemplateInfo};
use crate::util::{
    apply_template_vars, builtin_template_vars, is_inside, local_date_string, slug, tags_yaml_line,
    yaml_value,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type Res<T> = Result<T, String>;

fn path(s: &str) -> PathBuf {
    PathBuf::from(s)
}

// ===========================================================================
// Settings
// ===========================================================================

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Res<AppSettings> {
    Ok(state.settings())
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: serde_json::Value,
) -> Res<AppSettings> {
    let before = state.settings();
    let updated = state.update_settings(settings);

    // Re-arm the watcher when anything it depends on changed.
    if updated.notebook_root != before.notebook_root
        || updated.ignore_folders != before.ignore_folders
    {
        desktop::update_watcher(&app, &updated);
    }
    if updated.quick_capture_shortcut != before.quick_capture_shortcut
        || updated.clipboard_capture_shortcut != before.clipboard_capture_shortcut
    {
        desktop::apply_shortcuts(&app, &updated);
    }
    Ok(updated)
}

#[tauri::command]
pub async fn select_folder(app: AppHandle, state: State<'_, AppState>) -> Res<String> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(String::new());
    };
    let chosen = folder.to_string();
    let updated = state.update_settings(serde_json::json!({ "notebookRoot": chosen }));
    desktop::update_watcher(&app, &updated);
    Ok(chosen)
}

#[tauri::command]
pub async fn app_version(app: AppHandle) -> Res<String> {
    Ok(app.package_info().version.to_string())
}

/// The portable build can't replace its own running .exe, so it never
/// self-updates — the renderer shows a "download the new version" hint for
/// this status, exactly as the Electron portable build did.
#[tauri::command]
pub async fn check_for_updates() -> Res<serde_json::Value> {
    Ok(serde_json::json!({ "status": "portable" }))
}

// ===========================================================================
// Notebook tree
// ===========================================================================

#[tauri::command]
pub async fn get_notebook_tree(
    app: AppHandle,
    state: State<'_, AppState>,
    root_path: String,
    filter_tag: Option<String>,
) -> Res<Option<SectionNode>> {
    let root = path(&root_path);
    if root_path.is_empty() || !root.exists() {
        return Ok(None);
    }
    let settings = state.settings();
    let ignore = settings.ignore_set();

    let (mut tree, collector, seen, pending_docs) = state.with_caches(|cache, persisted| {
        let mut collector: HashMap<String, SearchDoc> = HashMap::new();
        let mut seen: HashSet<String> = HashSet::new();
        let pending_docs;
        let tree;
        {
            let mut ctx = ScanContext {
                root: &root,
                ignore: &ignore,
                scratchpad_file: &settings.scratchpad_file,
                shallow: false,
                collector: Some(&mut collector),
                seen: Some(&mut seen),
                pending_docs: Vec::new(),
                cache,
                persisted,
            };
            tree = scan_directory(&root, &mut ctx);
            pending_docs = ctx.pending_docs;
        }
        (tree, collector, seen, pending_docs)
    });

    state.replace_index(collector);
    state.prune_caches(&seen);
    state.save_meta_cache();

    // Files served from the persisted cache get their search docs (full text)
    // rebuilt off the critical path; searches await that build, the tree does
    // not.
    if !pending_docs.is_empty() {
        spawn_search_doc_build(app, pending_docs, root.clone());
    }

    if let Some(tag) = filter_tag.filter(|t| !t.is_empty()) {
        filter_by_tag(&mut tree, &tag.to_lowercase());
    }
    Ok(Some(tree))
}

/// Serialized so overlapping scans can't race each other.
fn spawn_search_doc_build(app: AppHandle, paths: Vec<String>, root: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let _gate = state.index_gate.lock().await;
        for (i, key) in paths.iter().enumerate() {
            let file = path(key);
            if let (Some((mtime_ms, size)), Ok(text)) =
                (notebook::file_stamp(&file), std::fs::read_to_string(&file))
            {
                let meta = parse_note_meta(&text, &file);
                let doc = make_search_doc(&root, &file, &text, &meta.title);
                state.record_scanned(
                    key.clone(),
                    ScanCacheEntry {
                        mtime_ms,
                        size,
                        meta,
                        doc: doc.clone(),
                    },
                );
                if let Some(doc) = doc {
                    state.index_insert(key.clone(), doc);
                }
            }
            // Stay responsive: yield every 25 files.
            if i % 25 == 24 {
                tokio::task::yield_now().await;
            }
        }
        state.save_meta_cache();
    });
}

// ===========================================================================
// Reading and writing notes
// ===========================================================================

#[tauri::command]
pub async fn read_note(file_path: String) -> Res<String> {
    std::fs::read_to_string(path(&file_path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_note(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    content: String,
) -> Res<bool> {
    let settings = state.settings();
    notes::write_note_file(&settings, &path(&file_path), &content, true, false)?;
    notify_files_changed(&app);
    Ok(true)
}

#[tauri::command]
pub async fn list_note_history(
    state: State<'_, AppState>,
    file_path: String,
) -> Res<Vec<HistoryEntry>> {
    Ok(notes::list_history(&state.settings(), &path(&file_path)))
}

#[tauri::command]
pub async fn read_note_history(
    state: State<'_, AppState>,
    file_path: String,
    id: String,
) -> Res<String> {
    Ok(notes::read_history(&state.settings(), &path(&file_path), &id))
}

#[tauri::command]
pub async fn restore_note_history(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    id: String,
) -> Res<bool> {
    let restored = notes::restore_history(&state.settings(), &path(&file_path), &id)?;
    if restored {
        notify_files_changed(&app);
    }
    Ok(restored)
}

#[tauri::command]
pub async fn toggle_task_at_line(
    app: AppHandle,
    file_path: String,
    line_index: usize,
) -> Res<bool> {
    let file = path(&file_path);
    let Ok(content) = std::fs::read_to_string(&file) else {
        return Ok(false);
    };
    match notes::toggle_task_line(&content, line_index) {
        Some(next) => {
            std::fs::write(&file, next).map_err(|e| e.to_string())?;
            notify_files_changed(&app);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// The backend doesn't track which note is open, so it asks the renderer to
/// perform the toggle on the active note.
#[tauri::command]
pub async fn toggle_mermaid_orientation(app: AppHandle, line_index: i64) -> Res<()> {
    use tauri::Emitter;
    if let Some(main) = app.get_webview_window(desktop::MAIN) {
        let _ = main.emit("perform-mermaid-toggle", line_index);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Res<bool> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

// ===========================================================================
// Pages and sections
// ===========================================================================

#[tauri::command]
pub async fn get_template_variables(
    state: State<'_, AppState>,
    template_name: String,
) -> Res<Vec<String>> {
    Ok(templates::template_variables(&state.settings(), &template_name))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_page(
    app: AppHandle,
    state: State<'_, AppState>,
    dir_path: String,
    title: String,
    template_name: Option<String>,
    meta: Option<NoteMetaPatch>,
    custom_vars: Option<HashMap<String, String>>,
) -> Res<String> {
    let settings = state.settings();
    let (created_date, tags) = notes::sanitize_meta(meta.as_ref());

    let mut body = String::new();
    if let Some(name) = template_name.filter(|n| !n.is_empty()) {
        if let Some(raw) = templates::read_template_body(&settings, &name) {
            let mut filled = apply_template_vars(&raw, &builtin_template_vars(&title, &created_date));
            // User-provided custom fields ({{project}}, {{attendees}}, …)
            if let Some(vars) = custom_vars {
                let pairs: Vec<(String, String)> = vars.into_iter().collect();
                filled = apply_template_vars(&filled, &pairs);
            }
            body = filled;
        }
    }

    let content = notes::compose_page(&settings, &title, &created_date, &tags, &body);
    let base = {
        let s = slug(&title);
        if s.is_empty() {
            "untitled".to_string()
        } else {
            s
        }
    };
    let full_path = notes::create_page_file(&path(&dir_path), &base, &content)?;
    notify_files_changed(&app);
    Ok(full_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn create_section(
    app: AppHandle,
    dir_path: String,
    name: String,
    description: Option<String>,
) -> Res<String> {
    let full_path = path(&dir_path).join(name.trim());
    if !full_path.exists() {
        std::fs::create_dir_all(&full_path).map_err(|e| e.to_string())?;
        if let Some(text) = description.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
            let meta = serde_json::json!({ "description": text });
            std::fs::write(
                full_path.join(crate::settings::SECTION_META_FILE),
                serde_json::to_string_pretty(&meta).unwrap_or_default(),
            )
            .map_err(|e| e.to_string())?;
        }
        notify_files_changed(&app);
    }
    Ok(full_path.to_string_lossy().into_owned())
}

/// The folder description lives in a dot-file inside the folder itself, so it
/// travels with renames and moves and never shows up as a page.
#[tauri::command]
pub async fn set_section_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    dir_path: String,
    description: String,
) -> Res<bool> {
    let settings = state.settings();
    let dir = path(&dir_path);
    if !is_inside(&settings.root(), &dir) || !dir.exists() {
        return Ok(false);
    }
    let meta_path = dir.join(crate::settings::SECTION_META_FILE);
    let trimmed = description.trim();
    if trimmed.is_empty() {
        let _ = std::fs::remove_file(&meta_path);
    } else {
        let meta = serde_json::json!({ "description": trimmed });
        std::fs::write(
            &meta_path,
            serde_json::to_string_pretty(&meta).unwrap_or_default(),
        )
        .map_err(|e| e.to_string())?;
    }
    notify_files_changed(&app);
    Ok(true)
}

#[tauri::command]
pub async fn delete_node(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
) -> Res<bool> {
    let result = notes::delete_node(&state.settings(), &path(&file_path))?;
    notify_files_changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn rename_node(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    new_name: String,
) -> Res<bool> {
    let settings = state.settings();
    let file = path(&file_path);
    if !file.exists() {
        return Ok(false);
    }
    let dir = file.parent().map(|p| p.to_path_buf()).unwrap_or_default();

    if file.is_dir() {
        std::fs::rename(&file, dir.join(new_name.trim())).map_err(|e| e.to_string())?;
        notify_files_changed(&app);
        return Ok(true);
    }

    let old_base = file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let old_text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let old_title = regex::Regex::new(r"(?m)^title:\s*(.*)$")
        .unwrap()
        .captures(&old_text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().trim_matches(['\'', '"']).to_string())
        .unwrap_or_else(|| old_base.clone());

    let new_slug = {
        let s = slug(&new_name);
        if s.is_empty() {
            old_base.clone()
        } else {
            s
        }
    };
    let renaming = !new_slug.eq_ignore_ascii_case(&old_base);

    let mut new_path = file.clone();
    let mut final_base = old_base.clone();
    if renaming {
        let fname = crate::util::unique_md(&dir, &new_slug);
        final_base = fname.trim_end_matches(".md").to_string();
        new_path = dir.join(&fname);
    }

    let all_files = notebook::all_markdown_files(&settings);
    // A bare [[link]] is only safe to retarget when no other note shares the
    // basename.
    let old_base_file = format!("{}.md", old_base.to_lowercase());
    let bare_name_unique = !all_files.iter().any(|f| {
        f.file_name()
            .map(|n| n.to_string_lossy().to_lowercase() == old_base_file)
            .unwrap_or(false)
            && f != &file
    });
    let rel_dir = crate::util::pathdiff(&settings.root(), &dir);

    let plan = notes::RenamePlan {
        old_base: &old_base,
        new_base: &final_base,
        renaming,
        bare_name_unique,
        rel_dir: &rel_dir,
    };
    let new_own = notes::update_own_content(&old_text, Some(&old_title), &new_name, &plan);
    std::fs::write(&file, new_own).map_err(|e| e.to_string())?;

    if renaming {
        for other in &all_files {
            if other == &file {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(other) else {
                continue;
            };
            let rewritten = notes::rewrite_wiki_links(
                &text,
                &old_base,
                &final_base,
                bare_name_unique,
                &rel_dir,
            );
            if rewritten != text {
                let _ = std::fs::write(other, rewritten);
            }
        }

        std::fs::rename(&file, &new_path).map_err(|e| e.to_string())?;

        // Keep the note's history attached to its new path
        let old_hist = notes::history_dir_for(&settings.root(), &file);
        if old_hist.exists() {
            let new_hist = notes::history_dir_for(&settings.root(), &new_path);
            match std::fs::rename(&old_hist, &new_hist) {
                Ok(_) => {
                    let rel_new = crate::util::rel_path(&settings.root(), &new_path);
                    let mut index = notes::read_history_index(&new_hist, &rel_new);
                    index.rel_path = rel_new;
                    let _ = notes::write_history_index(&new_hist, &index);
                }
                Err(err) => eprintln!("Failed to migrate note history on rename: {err}"),
            }
        }

        // Update the folder's manual ordering file
        let old_order_name = file
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let new_order_name = new_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ord = read_order_file(&dir);
        if ord.iter().any(|n| n.to_lowercase() == old_order_name) {
            let updated: Vec<String> = ord
                .into_iter()
                .map(|n| {
                    if n.to_lowercase() == old_order_name {
                        new_order_name.clone()
                    } else {
                        n
                    }
                })
                .collect();
            let _ = write_order_file(&dir, &updated);
        }
    }

    notify_files_changed(&app);
    Ok(true)
}

#[tauri::command]
pub async fn update_note_meta(
    app: AppHandle,
    file_path: String,
    meta: NoteMetaPatch,
) -> Res<bool> {
    let file = path(&file_path);
    if !file.exists() {
        return Ok(false);
    }
    let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    std::fs::write(&file, notes::apply_note_meta(&text, &meta)).map_err(|e| e.to_string())?;
    notify_files_changed(&app);
    Ok(true)
}

#[tauri::command]
pub async fn relocate_node(app: AppHandle, src_path: String, dest_dir: String) -> Res<bool> {
    let moved = notes::relocate_node(&path(&src_path), &path(&dest_dir));
    if moved {
        notify_files_changed(&app);
    }
    Ok(moved)
}

#[tauri::command]
pub async fn move_node(
    app: AppHandle,
    state: State<'_, AppState>,
    dir_path: String,
    file_name: String,
    direction: String,
) -> Res<bool> {
    let dir = path(&dir_path);
    let mut ord = read_order_file(&dir);

    // An empty order file means "alphabetical"; seed it from the current order
    // so the first move has something to reorder.
    if ord.is_empty() {
        let settings = state.settings();
        let ignore = settings.ignore_set();
        let section = state.with_caches(|cache, persisted| {
            let mut ctx = ScanContext {
                root: &settings.root(),
                ignore: &ignore,
                scratchpad_file: &settings.scratchpad_file,
                shallow: true,
                collector: None,
                seen: None,
                pending_docs: Vec::new(),
                cache,
                persisted,
            };
            scan_directory(&dir, &mut ctx)
        });
        ord = section.pages.into_iter().map(|p| p.name).collect();
    }

    if !notes::move_in_order(&mut ord, &file_name, &direction) {
        return Ok(false);
    }
    write_order_file(&dir, &ord).map_err(|e| e.to_string())?;
    notify_files_changed(&app);
    Ok(true)
}

/// Wholesale reorder from drag & drop: the renderer sends the section's full
/// page list in its new order.
#[tauri::command]
pub async fn set_node_order(
    app: AppHandle,
    dir_path: String,
    ordered_names: Vec<String>,
) -> Res<bool> {
    let dir = path(&dir_path);
    if dir_path.is_empty() || !dir.exists() {
        return Ok(false);
    }
    let cleaned: Vec<String> = ordered_names
        .into_iter()
        .filter(|n| !n.trim().is_empty())
        .collect();
    write_order_file(&dir, &cleaned).map_err(|e| e.to_string())?;
    notify_files_changed(&app);
    Ok(true)
}

// ===========================================================================
// Trash
// ===========================================================================

#[tauri::command]
pub async fn list_trash(state: State<'_, AppState>) -> Res<Vec<TrashItem>> {
    Ok(notes::list_trash(&state.settings()))
}

#[tauri::command]
pub async fn restore_trash_item(
    app: AppHandle,
    state: State<'_, AppState>,
    trash_name: String,
) -> Res<RestoreResult> {
    let result = notes::restore_trash_item(&state.settings(), &trash_name);
    if result.success {
        notify_files_changed(&app);
    }
    Ok(result)
}

#[tauri::command]
pub async fn delete_trash_item(state: State<'_, AppState>, trash_name: String) -> Res<bool> {
    Ok(notes::delete_trash_item(&state.settings(), &trash_name))
}

#[tauri::command]
pub async fn empty_trash(state: State<'_, AppState>) -> Res<serde_json::Value> {
    let removed = notes::empty_trash(&state.settings());
    Ok(serde_json::json!({ "removed": removed }))
}

// ===========================================================================
// Search
// ===========================================================================

#[tauri::command]
pub async fn search_notes(
    state: State<'_, AppState>,
    query: String,
    max_results: Option<usize>,
) -> Res<Vec<SearchResult>> {
    // Cold-start scans defer search-doc building to the background; wait for it
    // so results are never silently partial.
    let _gate = state.index_gate.lock().await;
    Ok(search::search_docs(&state.index_docs(), &query, max_results))
}

#[tauri::command]
pub async fn get_backlinks(state: State<'_, AppState>, file_path: String) -> Res<Vec<String>> {
    Ok(search::backlinks(&state.settings(), &path(&file_path)))
}

// ===========================================================================
// Templates and scratchpad
// ===========================================================================

#[tauri::command]
pub async fn list_templates(state: State<'_, AppState>) -> Res<Vec<TemplateInfo>> {
    Ok(templates::list_templates(&state.settings()))
}

#[tauri::command]
pub async fn create_template(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Res<Option<String>> {
    let created = templates::create_template(&state.settings(), &name);
    if created.is_some() {
        notify_files_changed(&app);
    }
    Ok(created.map(|p| p.to_string_lossy().into_owned()))
}

fn scratchpad_path(settings: &AppSettings) -> Option<PathBuf> {
    if settings.notebook_root.is_empty() {
        return None;
    }
    Some(settings.root().join(&settings.scratchpad_file))
}

#[tauri::command]
pub async fn read_scratchpad(state: State<'_, AppState>) -> Res<String> {
    let Some(file) = scratchpad_path(&state.settings()) else {
        return Ok(String::new());
    };
    Ok(std::fs::read_to_string(file).unwrap_or_default())
}

#[tauri::command]
pub async fn append_scratchpad(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Res<bool> {
    let Some(file) = scratchpad_path(&state.settings()) else {
        return Ok(false);
    };
    let mut existing = std::fs::read_to_string(&file).unwrap_or_default();
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(&text);
    existing.push('\n');
    std::fs::write(&file, existing).map_err(|e| e.to_string())?;
    notify_files_changed(&app);
    Ok(true)
}

/// Whole-document save (the floating pad edits the entire scratchpad file).
#[tauri::command]
pub async fn write_scratchpad(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Res<bool> {
    let Some(file) = scratchpad_path(&state.settings()) else {
        return Ok(false);
    };
    std::fs::write(&file, text).map_err(|e| e.to_string())?;
    notify_files_changed(&app);
    Ok(true)
}

// ===========================================================================
// Attachments
// ===========================================================================

#[tauri::command]
pub async fn save_attachment(
    state: State<'_, AppState>,
    base_name: String,
    bytes_b64: String,
    note_path: String,
) -> Res<AttachmentResult> {
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(bytes_b64.as_bytes()) {
        Ok(b) => b,
        Err(err) => return Ok(AttachmentResult::failed(err.to_string())),
    };
    let name = if base_name.is_empty() {
        "pasted-image.png".to_string()
    } else {
        base_name
    };
    Ok(store_attachment(
        &state.settings(),
        &bytes,
        &name,
        "png",
        &path(&note_path),
    ))
}

#[tauri::command]
pub async fn import_attachment_file(
    state: State<'_, AppState>,
    source_path: String,
    note_path: String,
) -> Res<AttachmentResult> {
    let source = path(&source_path);
    let bytes = match std::fs::read(&source) {
        Ok(b) => b,
        Err(err) => return Ok(AttachmentResult::failed(err.to_string())),
    };
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "dropped-file".into());
    Ok(store_attachment(
        &state.settings(),
        &bytes,
        &name,
        "bin",
        &path(&note_path),
    ))
}

// ===========================================================================
// Local AI
// ===========================================================================

#[tauri::command]
pub async fn ai_transform(
    state: State<'_, AppState>,
    mode: String,
    text: String,
) -> Res<crate::ai::AiResult> {
    let settings = state.settings();
    Ok(crate::ai::transform(&settings, &mode, &text).await)
}

#[tauri::command]
pub async fn ai_complete(
    state: State<'_, AppState>,
    context: String,
) -> Res<crate::ai::AiResult> {
    let settings = state.settings();
    Ok(crate::ai::complete(&settings, &context).await)
}

#[tauri::command]
pub async fn ai_list_models(state: State<'_, AppState>) -> Res<crate::ai::AiResult> {
    let settings = state.settings();
    Ok(crate::ai::list_models(&settings).await)
}

// ===========================================================================
// Imports
// ===========================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn write_imported_note(
    settings: &AppSettings,
    dest_dir: &Path,
    title: &str,
    created: &str,
    tags: &[String],
    body: &str,
) -> Res<PathBuf> {
    let mut fm = vec![
        "---".to_string(),
        format!("title: {}", yaml_value(title)),
        format!("created: {created}"),
    ];
    if !settings.author.is_empty() {
        fm.push(format!("author: {}", yaml_value(&settings.author)));
    }
    fm.push(tags_yaml_line(tags));
    fm.push("---".into());
    fm.push(String::new());
    fm.push(body.to_string());

    let base = {
        let s = slug(title);
        if s.is_empty() {
            format!("import-{}", crate::notebook::now_ms())
        } else {
            format!("import-{s}")
        }
    };
    notes::create_page_file(dest_dir, &base, &fm.join("\n"))
}

fn first_heading(body: &str) -> Option<String> {
    regex::Regex::new(r"(?m)^#{1,6}\s+(.+?)\s*$")
        .unwrap()
        .captures(body)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
}

#[tauri::command]
pub async fn import_clipboard(
    app: AppHandle,
    state: State<'_, AppState>,
    dest_dir: String,
    meta: Option<NoteMetaPatch>,
) -> Res<ImportResult> {
    let settings = state.settings();
    let (html, text) = platform::read_clipboard_html_and_text()?;
    if html.is_empty() && text.is_empty() {
        return Ok(ImportResult {
            success: false,
            file_path: None,
            reason: Some("Clipboard is empty.".into()),
        });
    }

    let candidate = if html.is_empty() { &text } else { &html };
    let is_html = pandoc::looks_like_html(candidate);
    let (input, from) = if is_html {
        (candidate.as_str(), "html")
    } else {
        (text.as_str(), "markdown")
    };

    let body = match pandoc::run_stdin(&settings, input, from, "gfm") {
        Ok(out) => out.trim().to_string(),
        Err(err) => {
            return Ok(ImportResult {
                success: false,
                file_path: None,
                reason: Some(format!("Pandoc conversion failed: {err}")),
            })
        }
    };

    // A user-supplied title wins; otherwise auto-detect from the first heading.
    let title = meta
        .as_ref()
        .and_then(|m| m.title.clone())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| first_heading(&body))
        .unwrap_or_else(|| "Imported Note".into());
    let (created, tags) = notes::sanitize_meta(meta.as_ref());
    let tags = if tags.is_empty() {
        vec!["imported".to_string()]
    } else {
        tags
    };

    let full_path = write_imported_note(&settings, &path(&dest_dir), &title, &created, &tags, &body)?;
    notify_files_changed(&app);
    Ok(ImportResult {
        success: true,
        file_path: Some(full_path.to_string_lossy().into_owned()),
        reason: None,
    })
}

/// Convert a OneNote-style MHTML document into markdown.
///
/// The images it carries inline are saved into the attachments folder first
/// and the HTML repointed at them, so the note keeps its pictures instead of
/// losing them the way a plain pandoc conversion would. `note_dir` is the
/// folder the note itself will live in, which is what the returned relative
/// links are resolved against.
fn mhtml_to_markdown(settings: &AppSettings, bytes: &[u8], note_dir: &Path) -> Res<String> {
    let parsed = crate::mhtml::parse(bytes)?;

    // The note's filename isn't chosen yet, but only its directory affects the
    // relative path, so a placeholder is enough to compute the links.
    let placeholder = note_dir.join("imported.md");
    let mut replacements: HashMap<String, String> = HashMap::new();
    // The saved images in the order the MHTML listed them, which is document
    // order — the fallback for any `<img>` whose source matches nothing.
    let mut ordered: Vec<String> = Vec::new();

    for (index, resource) in parsed.resources.iter().enumerate() {
        if !resource.mime.starts_with("image/") {
            continue;
        }
        let name = resource.suggested_name(index);
        // The fallback extension has to follow the part's own media type. A
        // JPEG saved as .png is a file nothing will open.
        let fallback_ext = name.rsplit('.').next().filter(|e| !e.is_empty() && *e != name);
        let stored = store_attachment(
            settings,
            &resource.bytes,
            &name,
            fallback_ext.unwrap_or("png"),
            &placeholder,
        );
        let Some(rel) = stored.rel_path.filter(|_| stored.success) else {
            continue; // an unsaveable image just keeps its original src
        };
        ordered.push(rel.clone());
        // The HTML may name the image by URL, by bare filename, or by cid.
        if !resource.location.is_empty() {
            replacements.insert(resource.location.clone(), rel.clone());
            if let Some(tail) = resource.location.rsplit(['/', '\\']).next() {
                replacements.entry(tail.to_string()).or_insert(rel.clone());
            }
        }
        if !resource.content_id.is_empty() {
            replacements.insert(resource.content_id.clone(), rel.clone());
        }
    }

    let rewritten = crate::mhtml::rewrite_sources_ordered(&parsed.html, &replacements, &ordered);
    let html = crate::html_clean::clean_onenote_html(&rewritten.html);

    // `-native_divs-native_spans` stops pandoc treating OneNote's layout
    // wrappers as structure it must preserve, and `gfm-raw_html` refuses the
    // escape hatch of passing HTML through — between them, what comes out is
    // markdown rather than a web page with markdown around it.
    let markdown = pandoc::run_stdin(
        settings,
        &html,
        "html-native_divs-native_spans",
        "gfm-raw_html",
    )?;
    Ok(crate::html_clean::tidy_markdown(&markdown))
}

#[tauri::command]
pub async fn import_document(
    app: AppHandle,
    state: State<'_, AppState>,
    dest_dir: String,
) -> Res<Option<ImportResult>> {
    let settings = state.settings();
    let picked = app
        .dialog()
        .file()
        .add_filter("Word Documents", &["docx", "odt", "rtf"])
        .add_filter("OneNote Web Page Export", &["mht", "mhtml"])
        .add_filter("Powerpoint Presentations", &["pptx"])
        .add_filter("Excel Sheets", &["xlsx"])
        .add_filter("EPUB Books", &["epub"])
        .add_filter("HTML files", &["html", "htm"])
        .add_filter("Plain Text & LaTeX", &["txt", "text", "tex"])
        .blocking_pick_file();

    let Some(picked) = picked else {
        return Ok(None); // cancelled
    };
    let doc_path = path(&picked.to_string());
    let ext = doc_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // MHTML has no pandoc reader, so it is unwrapped here into HTML plus
    // attachments before conversion.
    let converted = if ext == "mht" || ext == "mhtml" {
        std::fs::read(&doc_path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| mhtml_to_markdown(&settings, &bytes, &path(&dest_dir)))
    } else {
        let reader = pandoc::reader_for_extension(&ext);
        pandoc::run_file(&settings, &doc_path, reader, "gfm").map(|out| out.trim().to_string())
    };

    let body = match converted {
        Ok(body) => body,
        Err(err) => {
            return Ok(Some(ImportResult {
                success: false,
                file_path: None,
                reason: Some(format!("Could not convert that file: {err}")),
            }))
        }
    };

    let title = first_heading(&body).unwrap_or_else(|| {
        doc_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Imported Note".into())
    });
    let full_path = write_imported_note(
        &settings,
        &path(&dest_dir),
        &title,
        &local_date_string(),
        &["imported".to_string()],
        &body,
    )?;
    notify_files_changed(&app);
    Ok(Some(ImportResult {
        success: true,
        file_path: Some(full_path.to_string_lossy().into_owned()),
        reason: None,
    }))
}

// ===========================================================================
// OneNote import
// ===========================================================================

/// Is OneNote desktop present and driveable? The UI asks before offering the
/// import, so an unavailable OneNote is explained rather than hit as an error.
#[tauri::command]
pub async fn onenote_probe() -> Res<crate::onenote::OneNoteStatus> {
    Ok(crate::onenote::probe())
}

/// Everything known about why OneNote automation is or is not working, for the
/// "Run a check" button in the import dialog.
#[tauri::command]
pub async fn onenote_diagnostics() -> Res<Vec<crate::onenote_shell::Finding>> {
    Ok(crate::onenote_shell::diagnose())
}

#[tauri::command]
pub async fn onenote_notebooks() -> Res<Vec<crate::onenote::OneNotebook>> {
    crate::onenote::notebooks()
}

/// One page the user asked to bring across, and where it should land.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneNoteImportItem {
    pub id: String,
    pub name: String,
    /// Folder names from the notebook down to the section, outermost first.
    #[serde(default)]
    pub section_path: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneNoteImportFailure {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneNoteImportResult {
    pub imported: usize,
    pub failures: Vec<OneNoteImportFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OneNoteProgress {
    done: usize,
    total: usize,
    name: String,
}

/// Import the selected OneNote pages, one markdown page each.
///
/// Section paths become real folders, so a notebook keeps its shape. A page
/// that fails is recorded and the run continues — one unreadable page
/// shouldn't cost the user the other two hundred.
#[tauri::command]
pub async fn onenote_import(
    app: AppHandle,
    state: State<'_, AppState>,
    items: Vec<OneNoteImportItem>,
    dest_dir: String,
) -> Res<OneNoteImportResult> {
    use tauri::Emitter;

    let settings = state.settings();
    let root = path(&dest_dir);
    if !root.exists() {
        return Err("The destination section no longer exists.".into());
    }

    let total = items.len();
    let mut imported = 0usize;
    let mut failures: Vec<OneNoteImportFailure> = Vec::new();
    let mut first_path: Option<String> = None;
    let temp = std::env::temp_dir();

    for (index, item) in items.iter().enumerate() {
        if let Some(main) = app.get_webview_window(desktop::MAIN) {
            let _ = main.emit(
                "onenote-import-progress",
                OneNoteProgress {
                    done: index,
                    total,
                    name: item.name.clone(),
                },
            );
        }

        let mut dir = root.clone();
        for segment in &item.section_path {
            dir = dir.join(crate::util::sanitize_folder_name(segment));
        }
        if let Err(err) = std::fs::create_dir_all(&dir) {
            failures.push(OneNoteImportFailure {
                name: item.name.clone(),
                reason: format!("Could not create its section folder: {err}"),
            });
            continue;
        }

        let export = temp.join(format!("mdnb-onenote-{}.mht", crate::notebook::now_ms() + index as i64));
        let outcome = crate::onenote::publish_page(&item.id, &export)
            .and_then(|_| std::fs::read(&export).map_err(|e| e.to_string()))
            .and_then(|bytes| mhtml_to_markdown(&settings, &bytes, &dir));
        let _ = std::fs::remove_file(&export);

        match outcome {
            Ok(body) => {
                let title = if item.name.trim().is_empty() {
                    "Untitled page".to_string()
                } else {
                    item.name.trim().to_string()
                };
                let content = notes::compose_page(
                    &settings,
                    &title,
                    &local_date_string(),
                    &["onenote".to_string()],
                    &body,
                );
                let base = {
                    let s = slug(&title);
                    if s.is_empty() {
                        "onenote-page".to_string()
                    } else {
                        s
                    }
                };
                match notes::create_page_file(&dir, &base, &content) {
                    Ok(written) => {
                        imported += 1;
                        first_path.get_or_insert_with(|| written.to_string_lossy().into_owned());
                    }
                    Err(err) => failures.push(OneNoteImportFailure {
                        name: item.name.clone(),
                        reason: err,
                    }),
                }
            }
            Err(reason) => failures.push(OneNoteImportFailure {
                name: item.name.clone(),
                reason,
            }),
        }
    }

    if let Some(main) = app.get_webview_window(desktop::MAIN) {
        let _ = main.emit(
            "onenote-import-progress",
            OneNoteProgress {
                done: total,
                total,
                name: String::new(),
            },
        );
    }
    notify_files_changed(&app);

    Ok(OneNoteImportResult {
        imported,
        failures,
        first_path,
    })
}

// ===========================================================================
// Exports
// ===========================================================================

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub theme: Option<String>,
    pub page_size: Option<String>,
    pub open_after: Option<bool>,
    pub reveal: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docx_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ExportResult {
    fn canceled() -> Self {
        Self {
            success: false,
            canceled: Some(true),
            pdf_path: None,
            html_path: None,
            docx_path: None,
            reason: None,
        }
    }
    fn failed(reason: impl Into<String>) -> Self {
        Self {
            success: false,
            canceled: None,
            pdf_path: None,
            html_path: None,
            docx_path: None,
            reason: Some(reason.into()),
        }
    }
}

fn suggested_name(file_path: &str, ext: &str) -> String {
    let stem = Path::new(file_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "note".into());
    format!("{stem}.{ext}")
}

#[tauri::command]
pub async fn export_to_pdf(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    html_content: String,
    options: Option<ExportOptions>,
) -> Res<ExportResult> {
    let settings = state.settings();
    let options = options.unwrap_or_default();
    let theme = options.theme.unwrap_or(settings.pdf_export.theme.clone());
    let page_size = options
        .page_size
        .unwrap_or(settings.pdf_export.page_size.clone());
    let open_after = options.open_after.unwrap_or(settings.pdf_export.open_after);
    let reveal = options.reveal.unwrap_or(settings.pdf_export.reveal);

    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Export to PDF")
        .set_file_name(suggested_name(&file_path, "pdf"))
        .add_filter("PDF Document", &["pdf"])
        .blocking_save_file()
    else {
        return Ok(ExportResult::canceled());
    };
    let pdf_path = path(&chosen.to_string());

    // Remember the chosen options for next time
    state.update_settings(serde_json::json!({
        "pdfExport": {
            "theme": theme,
            "pageSize": page_size,
            "openAfter": open_after,
            "reveal": reveal,
        }
    }));

    let document = exports::build_print_document(&html_content, &theme);
    let (width, height) = exports::page_size_inches(&page_size);

    match render_pdf(&app, document, &pdf_path, width, height).await {
        Ok(()) => {
            if open_after {
                let _ = app.opener().open_path(pdf_path.to_string_lossy(), None::<&str>);
            }
            if reveal {
                let _ = app.opener().reveal_item_in_dir(&pdf_path);
            }
            Ok(ExportResult {
                success: true,
                canceled: None,
                pdf_path: Some(pdf_path.to_string_lossy().into_owned()),
                html_path: None,
                docx_path: None,
                reason: None,
            })
        }
        Err(err) => {
            eprintln!("Failed to print to PDF: {err}");
            Ok(ExportResult::failed(err))
        }
    }
}

const PRINT_WINDOW: &str = "pdf-print";

/// Load the styled HTML into an offscreen WebView2 and print it to `out`.
///
/// This is the WebView2 counterpart of Electron's hidden BrowserWindow +
/// `webContents.printToPDF`.
async fn render_pdf(
    app: &AppHandle,
    document: String,
    out: &Path,
    width_in: f64,
    height_in: f64,
) -> Res<()> {
    use tauri::webview::PageLoadEvent;

    // Load via a temp file: data: URLs have practical size limits that notes
    // with large embedded images can exceed.
    let temp_html = std::env::temp_dir().join(format!("mdnb-export-{}.html", crate::notebook::now_ms()));
    std::fs::write(&temp_html, document).map_err(|e| e.to_string())?;

    let cleanup = |window: Option<tauri::WebviewWindow>, temp: &Path| {
        if let Some(window) = window {
            let _ = window.close();
        }
        let _ = std::fs::remove_file(temp);
    };

    // A stale window from a previous failed export would take the label.
    if let Some(existing) = app.get_webview_window(PRINT_WINDOW) {
        let _ = existing.close();
    }

    let url = tauri::Url::parse(&exports::path_to_file_url(&temp_html))
        .map_err(|e| format!("Could not address the temporary export file: {e}"))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let tx = std::sync::Mutex::new(Some(tx));
    let window = tauri::WebviewWindowBuilder::new(app, PRINT_WINDOW, tauri::WebviewUrl::External(url))
        .title("Exporting…")
        .inner_size(1024.0, 1400.0)
        .visible(false)
        .skip_taskbar(true)
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    // Page load fires before images have necessarily painted; give the layout a
    // moment to settle so diagrams and screenshots make it into the PDF.
    let loaded = tokio::time::timeout(std::time::Duration::from_secs(30), rx).await;
    if loaded.is_err() {
        cleanup(Some(window), &temp_html);
        return Err("Timed out preparing the document for export.".into());
    }
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;

    let result = platform::print_webview_to_pdf(&window, out, width_in, height_in);
    cleanup(Some(window), &temp_html);
    result
}

#[tauri::command]
pub async fn export_to_html(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    html_content: String,
    options: Option<ExportOptions>,
) -> Res<ExportResult> {
    let settings = state.settings();
    let theme = options
        .and_then(|o| o.theme)
        .unwrap_or(settings.pdf_export.theme.clone());

    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Export to HTML")
        .set_file_name(suggested_name(&file_path, "html"))
        .add_filter("HTML Document", &["html"])
        .blocking_save_file()
    else {
        return Ok(ExportResult::canceled());
    };
    let out = path(&chosen.to_string());

    let title = Path::new(&file_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let document = exports::build_html_document(&html_content, &theme, &title);

    match std::fs::write(&out, document) {
        Ok(()) => {
            let _ = app.opener().reveal_item_in_dir(&out);
            Ok(ExportResult {
                success: true,
                canceled: None,
                pdf_path: None,
                html_path: Some(out.to_string_lossy().into_owned()),
                docx_path: None,
                reason: None,
            })
        }
        Err(err) => {
            eprintln!("Failed to export HTML: {err}");
            Ok(ExportResult::failed(err.to_string()))
        }
    }
}

#[tauri::command]
pub async fn export_to_docx(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
) -> Res<ExportResult> {
    let settings = state.settings();
    let source = path(&file_path);
    if !source.exists() {
        return Ok(ExportResult::failed("Note file not found."));
    }

    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Export to Word")
        .set_file_name(suggested_name(&file_path, "docx"))
        .add_filter("Word Document", &["docx"])
        .blocking_save_file()
    else {
        return Ok(ExportResult::canceled());
    };
    let out = path(&chosen.to_string());

    // Pandoc's gfm reader would print the YAML frontmatter as a table, so hand
    // it a temp copy with the frontmatter stripped. Mermaid blocks come through
    // as plain code blocks — pandoc has no renderer for them.
    let raw = std::fs::read_to_string(&source).map_err(|e| e.to_string())?;
    let temp_md = std::env::temp_dir().join(format!("mdnb-docx-{}.md", crate::notebook::now_ms()));
    std::fs::write(&temp_md, exports::strip_frontmatter(&raw)).map_err(|e| e.to_string())?;

    let cwd = source.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let result = pandoc::run_to_file(&settings, &temp_md, &out, "docx", &cwd);
    let _ = std::fs::remove_file(&temp_md);

    match result {
        Ok(()) => {
            let _ = app.opener().reveal_item_in_dir(&out);
            Ok(ExportResult {
                success: true,
                canceled: None,
                pdf_path: None,
                html_path: None,
                docx_path: Some(out.to_string_lossy().into_owned()),
                reason: None,
            })
        }
        Err(err) => Ok(ExportResult::failed(if err.contains("ENOENT") {
            "Pandoc is required for Word export but was not found. Install pandoc or set its path in Settings.".to_string()
        } else {
            format!("Pandoc conversion failed: {err}")
        })),
    }
}

#[tauri::command]
pub async fn copy_rich_text(html_content: String, plain_text: String) -> Res<serde_json::Value> {
    let inlined = exports::inline_images(&html_content);
    match platform::write_clipboard_html(&inlined, &plain_text) {
        Ok(()) => Ok(serde_json::json!({ "success": true })),
        Err(reason) => Ok(serde_json::json!({ "success": false, "reason": reason })),
    }
}

// ===========================================================================
// Quick capture window
// ===========================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    pub fs_path: String,
    pub rel_path: String,
}

#[tauri::command]
pub async fn list_capture_targets(state: State<'_, AppState>) -> Res<Vec<CaptureTarget>> {
    let settings = state.settings();
    let root = settings.root();
    let mut targets: Vec<CaptureTarget> = notebook::all_markdown_files(&settings)
        .into_iter()
        .map(|f| CaptureTarget {
            fs_path: f.to_string_lossy().into_owned(),
            rel_path: crate::util::rel_path(&root, &f),
        })
        .collect();
    targets.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(targets)
}

#[tauri::command]
pub async fn append_quick_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    target_fs_path: Option<String>,
) -> Res<CaptureResult> {
    let settings = state.settings();
    let target = target_fs_path.filter(|t| !t.is_empty()).map(|t| path(&t));
    let result = capture::append_capture(&settings, &text, target.as_deref());
    if result.success {
        notify_files_changed(&app);
    }
    Ok(result)
}

#[tauri::command]
pub async fn hide_capture_window(app: AppHandle) -> Res<()> {
    desktop::hide_capture_window(&app);
    Ok(())
}

// ===========================================================================
// Launcher
// ===========================================================================

#[tauri::command]
pub async fn launcher_context(state: State<'_, AppState>) -> Res<serde_json::Value> {
    let settings = state.settings();
    Ok(serde_json::json!({
        "theme": settings.theme,
        "hasNotebook": !settings.notebook_root.is_empty(),
    }))
}

#[tauri::command]
pub async fn launcher_search(
    state: State<'_, AppState>,
    query: String,
) -> Res<Vec<LauncherResult>> {
    let _gate = state.index_gate.lock().await; // wait for the background build
    Ok(search::launcher_search_docs(&state.index_docs(), &query))
}

#[tauri::command]
pub async fn launcher_open_note(app: AppHandle, fs_path: String) -> Res<()> {
    desktop::hide_launcher_window(&app);
    desktop::reveal_main_window(&app, Some(fs_path));
    Ok(())
}

/// Hand the renderer whatever the command line asked to open, once.
///
/// A cold start parses its arguments long before the webview exists, so the
/// request is parked in state rather than emitted. The renderer collects it as
/// part of booting; a second launch, where the window is already up, gets an
/// `open-note-at` event instead and never reaches this.
#[tauri::command]
pub async fn take_pending_open(state: State<'_, AppState>) -> Res<Option<cli::OpenRequest>> {
    Ok(state.pending_open.lock().unwrap().take())
}

#[tauri::command]
pub async fn launcher_export_note(app: AppHandle, fs_path: String) -> Res<()> {
    desktop::hide_launcher_window(&app);
    desktop::reveal_main_window_for_export(&app, fs_path);
    Ok(())
}

#[tauri::command]
pub async fn launcher_open_capture(app: AppHandle) -> Res<serde_json::Value> {
    desktop::hide_launcher_window(&app);
    desktop::show_capture_window(&app);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn launcher_open_daily(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Res<serde_json::Value> {
    let settings = state.settings();
    if settings.notebook_root.is_empty() {
        desktop::reveal_main_window(&app, None);
        return Ok(serde_json::json!({ "success": false }));
    }
    let note_path = capture::resolve_or_create_daily_note(&settings)?;
    notify_files_changed(&app);
    desktop::hide_launcher_window(&app);
    let as_string = note_path.to_string_lossy().into_owned();
    desktop::reveal_main_window(&app, Some(as_string.clone()));
    Ok(serde_json::json!({ "success": true, "notePath": as_string }))
}

#[tauri::command]
pub async fn launcher_append_task(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Res<CaptureResult> {
    let settings = state.settings();
    let result = capture::append_tasks(&settings, &text);
    if result.success {
        notify_files_changed(&app);
    }
    Ok(result)
}

#[tauri::command]
pub async fn launcher_open_scratchpad(app: AppHandle) -> Res<serde_json::Value> {
    desktop::hide_launcher_window(&app);
    desktop::show_scratchpad_window(&app);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn launcher_screenshot(app: AppHandle) -> Res<serde_json::Value> {
    desktop::start_screenshot_capture(&app);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn launcher_resize(app: AppHandle, height: f64) -> Res<()> {
    desktop::resize_launcher(&app, height);
    Ok(())
}

#[tauri::command]
pub async fn launcher_hide(app: AppHandle) -> Res<()> {
    desktop::hide_launcher_window(&app);
    Ok(())
}

// ===========================================================================
// Scratchpad window
// ===========================================================================

#[tauri::command]
pub async fn scratchpad_hide(app: AppHandle) -> Res<()> {
    desktop::hide_scratchpad_window(&app);
    Ok(())
}

#[tauri::command]
pub async fn scratchpad_pin(app: AppHandle, pinned: bool) -> Res<()> {
    desktop::pin_scratchpad_window(&app, pinned);
    Ok(())
}

// ===========================================================================
// Screenshot region overlay
// ===========================================================================

#[tauri::command]
pub async fn region_get_shot(state: State<'_, AppState>) -> Res<Option<PendingShot>> {
    Ok(state.pending_shot.lock().unwrap().clone())
}

#[tauri::command]
pub async fn region_cancel(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    desktop::close_region_window(&app);
    *state.pending_shot.lock().unwrap() = None;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct RegionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
pub async fn region_commit(
    app: AppHandle,
    state: State<'_, AppState>,
    rect: RegionRect,
) -> Res<serde_json::Value> {
    desktop::close_region_window(&app);
    let shot = state.pending_shot.lock().unwrap().take();

    let Some(shot) = shot else {
        return Ok(serde_json::json!({ "success": false }));
    };
    if rect.width < 3.0 || rect.height < 3.0 {
        return Ok(serde_json::json!({ "success": false }));
    }

    let settings = state.settings();
    let png = match desktop::crop_png(
        &shot.png,
        shot.scale_factor,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
    ) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("Screenshot crop failed: {err}");
            return Ok(serde_json::json!({ "success": false }));
        }
    };

    let note_path = capture::resolve_or_create_daily_note(&settings)?;
    let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let stored = store_attachment(
        &settings,
        &png,
        &format!("screenshot-{stamp}.png"),
        "png",
        &note_path,
    );
    if !stored.success {
        return Ok(serde_json::json!({ "success": false, "reason": stored.reason }));
    }

    let markdown = format!("![screenshot]({})", stored.rel_path.unwrap_or_default());
    let content = std::fs::read_to_string(&note_path).map_err(|e| e.to_string())?;
    let next = crate::util::append_lines_under_heading(&content, "Screenshots", &[markdown]);
    notes::write_note_file(&settings, &note_path, &next, true, false)?;
    notify_files_changed(&app);

    let name = note_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    desktop::notify_desktop(&app, "Screenshot saved", &format!("Filed to {name}"));
    Ok(serde_json::json!({
        "success": true,
        "notePath": note_path.to_string_lossy(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_names_are_derived_from_the_note() {
        // Separator handling is std::path's, so the backslash case is only
        // meaningful on the platform this binary actually ships to.
        #[cfg(windows)]
        assert_eq!(
            suggested_name(r"C:\notes\weekly-review.md", "pdf"),
            "weekly-review.pdf"
        );
        assert_eq!(suggested_name("/n/weekly-review.md", "pdf"), "weekly-review.pdf");
        assert_eq!(suggested_name("/n/a.md", "docx"), "a.docx");
        assert_eq!(suggested_name("", "pdf"), "note.pdf");
    }

    #[test]
    fn the_first_heading_becomes_an_import_title() {
        assert_eq!(
            first_heading("Intro text\n\n## Real Heading\n\nmore"),
            Some("Real Heading".into())
        );
        assert_eq!(first_heading("no headings here"), None);
    }
}

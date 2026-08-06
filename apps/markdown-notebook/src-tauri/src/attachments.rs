//! Pasted images, dropped files and screenshots. Everything lands in the
//! notebook's attachments folder with a timestamped, slugified name, and the
//! caller gets back a path relative to the note so the markdown link works
//! wherever the notebook is later moved to.

use crate::notes::unique_attachment_name;
use crate::settings::AppSettings;
use crate::util::parent_of;
use serde::Serialize;
use std::path::Path;

const ATTACHMENT_MAX_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fs_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl AttachmentResult {
    pub fn failed(reason: impl Into<String>) -> Self {
        Self {
            success: false,
            fs_path: None,
            rel_path: None,
            reason: Some(reason.into()),
        }
    }
}

pub fn store_attachment(
    settings: &AppSettings,
    data: &[u8],
    base_name: &str,
    default_ext: &str,
    note_path: &Path,
) -> AttachmentResult {
    if settings.notebook_root.is_empty() {
        return AttachmentResult::failed("No notebook open.");
    }
    if data.is_empty() {
        return AttachmentResult::failed("Empty attachment.");
    }
    if data.len() > ATTACHMENT_MAX_BYTES {
        return AttachmentResult::failed("Attachment exceeds 50 MB.");
    }

    let dir = settings.attachments_dir();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        return AttachmentResult::failed(err.to_string());
    }

    let filename = unique_attachment_name(&dir, base_name, default_ext);
    let fs_path = dir.join(&filename);
    if let Err(err) = std::fs::write(&fs_path, data) {
        return AttachmentResult::failed(err.to_string());
    }
    // Deliberately no files-changed event: attachments aren't in the tree.

    let rel = crate::util::pathdiff(&parent_of(note_path), &fs_path).replace('\\', "/");
    AttachmentResult {
        success: true,
        fs_path: Some(fs_path.to_string_lossy().into_owned()),
        rel_path: Some(rel),
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_notebook(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mdnb-attach-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("section")).unwrap();
        dir
    }

    fn settings_for(root: &Path) -> AppSettings {
        AppSettings {
            notebook_root: root.to_string_lossy().into_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn stores_a_file_and_returns_a_note_relative_link() {
        let root = temp_notebook("basic");
        let settings = settings_for(&root);
        let note = root.join("section").join("page.md");

        let result = store_attachment(&settings, b"\x89PNG data", "Screen Shot.PNG", "png", &note);
        assert!(result.success, "{:?}", result.reason);

        let rel = result.rel_path.unwrap();
        // Relative to the note's own folder, forward slashes, original extension
        assert!(rel.starts_with("../attachments/"), "got {rel}");
        assert!(rel.ends_with("-screen-shot.png"), "got {rel}");
        assert!(root.join("attachments").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_empty_and_oversized_payloads() {
        let root = temp_notebook("limits");
        let settings = settings_for(&root);
        let note = root.join("page.md");

        assert!(!store_attachment(&settings, b"", "a.png", "png", &note).success);
        let big = vec![0u8; ATTACHMENT_MAX_BYTES + 1];
        let result = store_attachment(&settings, &big, "a.png", "png", &note);
        assert_eq!(result.reason.unwrap(), "Attachment exceeds 50 MB.");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_store_without_a_notebook() {
        let settings = AppSettings::default();
        let result = store_attachment(&settings, b"x", "a.png", "png", Path::new("/tmp/n.md"));
        assert_eq!(result.reason.unwrap(), "No notebook open.");
    }

    #[test]
    fn names_never_collide() {
        let root = temp_notebook("collide");
        let settings = settings_for(&root);
        let note = root.join("page.md");

        let first = store_attachment(&settings, b"a", "img.png", "png", &note);
        let second = store_attachment(&settings, b"b", "img.png", "png", &note);
        assert_ne!(first.rel_path.unwrap(), second.rel_path.unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn falls_back_to_the_default_extension() {
        let root = temp_notebook("noext");
        let settings = settings_for(&root);
        let note = root.join("page.md");
        let result = store_attachment(&settings, b"x", "clipboard", "png", &note);
        assert!(result.rel_path.unwrap().ends_with("-clipboard.png"));
        let _ = std::fs::remove_dir_all(&root);
    }
}

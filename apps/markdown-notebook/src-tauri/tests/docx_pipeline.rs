//! The OneNote import's conversion stage, run for real against pandoc.
//!
//! Every other test in this crate exercises the string handling in isolation.
//! This one runs the actual command the import runs, on an actual `.docx` with
//! an actual embedded image, and checks what comes out — which is the only way
//! to catch the class of mistake that shipped twice: a pandoc invocation that
//! looked right and silently dropped content, and one that failed outright on
//! some pandoc builds.
//!
//! Skipped when pandoc is not installed, so it never breaks a build that has
//! no reason to have it.

use std::path::{Path, PathBuf};
use std::process::Command;

fn pandoc_available() -> bool {
    Command::new("pandoc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("onenote-page.docx")
}

/// Run exactly what `pandoc::run_file_extract_media` runs.
fn convert(media_dir: &Path) -> String {
    let out = Command::new("pandoc")
        .arg(fixture())
        .args(["-f", "docx", "-t", "gfm", "--wrap=none"])
        .arg(format!("--extract-media={}", media_dir.display()))
        .output()
        .expect("pandoc should run");
    assert!(
        out.status.success(),
        "pandoc failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn a_word_page_converts_to_markdown_with_its_structure_intact() {
    if !pandoc_available() {
        eprintln!("skipping: pandoc not installed");
        return;
    }
    let media = std::env::temp_dir().join(format!("mdnb-docx-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&media);
    let markdown = convert(&media);

    // Headings survive as headings, not as bold paragraphs.
    assert!(markdown.contains("# Meeting Notes"), "{markdown}");
    assert!(markdown.contains("## Agenda"), "{markdown}");
    // Inline formatting and links.
    assert!(markdown.contains("**bold**"), "{markdown}");
    assert!(markdown.contains("*italic*"), "{markdown}");
    assert!(
        markdown.contains("[link](https://example.com)"),
        "{markdown}"
    );
    // Lists, including nesting and numbering.
    assert!(markdown.contains("- First point"), "{markdown}");
    assert!(markdown.contains("  - A nested point"), "{markdown}");
    assert!(
        markdown.contains("1.  Numbered one") || markdown.contains("1. Numbered one"),
        "{markdown}"
    );
    // A real pipe table, not a grid table and not one long line.
    assert!(markdown.contains("| Column A | Column B |"), "{markdown}");
    assert!(markdown.contains("| alpha"), "{markdown}");
    // Block quote.
    assert!(markdown.contains("> A quote from someone."), "{markdown}");

    // Nothing leaked through as a layout wrapper.
    assert!(!markdown.contains("<div"), "{markdown}");
    assert!(!markdown.contains("<span"), "{markdown}");
    assert!(!markdown.contains("<table"), "{markdown}");

    let _ = std::fs::remove_dir_all(&media);
}

#[test]
fn the_embedded_image_is_extracted_and_ends_up_as_a_markdown_image() {
    if !pandoc_available() {
        eprintln!("skipping: pandoc not installed");
        return;
    }
    let media = std::env::temp_dir().join(format!("mdnb-docx-img-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&media);
    let markdown = convert(&media);

    // pandoc wrote the image out for us — no source matching required.
    let extracted: Vec<PathBuf> = walk(&media);
    assert_eq!(extracted.len(), 1, "expected one image, got {extracted:?}");
    assert!(std::fs::metadata(&extracted[0]).unwrap().len() > 0);

    // A Word export carries image dimensions, so pandoc emits a raw <img>.
    // This is the exact shape the conversion has to cope with.
    assert!(
        markdown.contains("<img"),
        "expected pandoc's raw img: {markdown}"
    );

    // …and the app turns it back into markdown.
    let converted = html_clean::html_images_to_markdown(&markdown);
    assert!(!converted.contains("<img"), "{converted}");
    assert!(converted.contains("![A diagram]("), "{converted}");

    // The link the app is about to rewrite points at the file that was written.
    let targets = html_clean::image_targets(&converted);
    assert_eq!(targets.len(), 1, "{converted}");
    let target = &targets[0].0;
    let resolved = media.parent().unwrap().join(target);
    assert!(
        resolved.is_file(),
        "{target} should resolve to {resolved:?}"
    );

    let _ = std::fs::remove_dir_all(&media);
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(walk(&path));
        } else {
            found.push(path);
        }
    }
    found
}

// A binary crate exposes no library to link against, so the module is pulled in
// by path. That keeps this test running the shipping code, not a copy of it.
#[path = "../src/html_clean.rs"]
mod html_clean;

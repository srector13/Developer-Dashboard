//! Sharing: PDF, standalone HTML, Word (via pandoc) and rich-text clipboard.
//!
//! The renderer hands over the preview pane's own HTML, so exports look like
//! what's on screen. Image `src`s arrive as Tauri asset URLs; they are turned
//! back into real paths here — inlined as data URIs for HTML, or rewritten to
//! `file://` for the WebView2 print pass.

use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use std::path::{Path, PathBuf};

/// Theme-independent layout rules, written against --pdf-* tokens; each
/// selectable PDF theme is just a token block layered on top.
pub const PDF_BASE_CSS: &str = r#"
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--pdf-text);
    line-height: 1.6;
    padding: 40px;
    background: var(--pdf-bg);
  }
  h1, h2, h3, h4, h5, h6 {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
    color: var(--pdf-heading);
  }
  h1 { font-size: 2em; border-bottom: 1px solid var(--pdf-border); padding-bottom: .3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid var(--pdf-border); padding-bottom: .3em; }
  h3 { font-size: 1.25em; }
  pre, code {
    font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
    background-color: var(--pdf-code-bg);
    border-radius: 3px;
  }
  /* Paper can't scroll: long code lines must WRAP, never clip behind an
     overflow container (which also paints a useless scrollbar into the PDF) */
  pre {
    padding: 16px;
    overflow: visible;
    font-size: 85%;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  code { padding: .2em .4em; margin: 0; font-size: 85%; word-break: break-word; }
  pre code { padding: 0; background-color: transparent; white-space: inherit; }
  blockquote {
    padding: 0 1em;
    color: var(--pdf-muted);
    border-left: .25em solid var(--pdf-border);
    margin: 0 0 16px 0;
  }
  table { border-spacing: 0; border-collapse: collapse; width: 100%; margin-bottom: 16px; }
  table th, table td { padding: 6px 13px; border: 1px solid var(--pdf-border); }
  table th { background-color: var(--pdf-head-bg); }
  table tr { background-color: var(--pdf-bg); border-top: 1px solid var(--pdf-border); }
  table tr:nth-child(2n) { background-color: var(--pdf-code-bg); }
  img { max-width: 100%; box-sizing: content-box; }
  .task-checkbox { vertical-align: middle; margin-right: 8px; }
  a { color: var(--pdf-link); text-decoration: none; }
  mark { background-color: var(--pdf-mark-bg); color: var(--pdf-text); padding: 1px 4px; border-radius: 3px; }

  /* Page break controls */
  h1, h2, h3 { page-break-after: avoid; }
  blockquote, table, img { page-break-inside: avoid; }
  pre { page-break-inside: avoid; max-height: none; }

  /* Mermaid diagrams: render at natural size, capped to one page, so a
     stretched SVG can't span multiple pages and leave blank gaps. */
  .mermaid-block-container {
    page-break-inside: avoid;
    margin: 16px 0;
    border: none;
    background: transparent;
  }
  .notebook-mermaid {
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    box-shadow: none !important;
    display: flex;
    justify-content: center;
    page-break-inside: avoid;
  }
  .notebook-mermaid svg {
    max-width: 100% !important;
    max-height: 8.5in;
    height: auto !important;
  }

  /* Batch export: table of contents + one note per section */
  .pdf-toc { page-break-after: always; }
  .pdf-toc ol { padding-left: 20px; }
  .pdf-toc li { margin-bottom: 6px; display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .pdf-toc a { color: var(--pdf-link); }
  .pdf-toc-path { color: var(--pdf-muted); font-size: 11px; }
  .pdf-note { page-break-before: always; }

  /* Hide notebook UI elements for clean write-up export */
  .toolbar, .code-header, .code-header-bar, .copy-btn, .copy-code-btn,
  .mermaid-actions-bar, .code-block-copy-btn,
  #note-header, .backlink-pill, .tag-pill, .status-indicator, #titlebar {
    display: none !important;
  }

  /* Code block wrapper chrome from the preview pane */
  .code-block-wrapper {
    border: 1px solid var(--pdf-border);
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 16px;
    page-break-inside: avoid;
  }
  .code-block-wrapper pre { margin: 0; }
  .code-block-header {
    padding: 4px 12px;
    background: var(--pdf-head-bg);
    border-bottom: 1px solid var(--pdf-border);
    font-size: 10px;
    font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
    text-transform: uppercase;
    color: var(--pdf-muted);
  }
"#;

const PDF_THEME_LIGHT: &str = r#"
    :root { --pdf-bg: #ffffff; --pdf-text: #24292e; --pdf-heading: #1f2328; --pdf-muted: #6a737d;
            --pdf-border: #dfe2e5; --pdf-code-bg: #f6f8fa; --pdf-head-bg: #f0f2f4;
            --pdf-link: #0366d6; --pdf-mark-bg: #fff3b8; }
"#;

const PDF_THEME_DARK: &str = r#"
    :root { --pdf-bg: #0d1117; --pdf-text: #c9d1d9; --pdf-heading: #f0f6fc; --pdf-muted: #8b949e;
            --pdf-border: #30363d; --pdf-code-bg: #161b22; --pdf-head-bg: #161b22;
            --pdf-link: #58a6ff; --pdf-mark-bg: #4d3800; }
"#;

const PDF_THEME_MINIMAL: &str = r#"
    :root { --pdf-bg: #ffffff; --pdf-text: #1a1a1a; --pdf-heading: #000000; --pdf-muted: #666666;
            --pdf-border: #e5e5e5; --pdf-code-bg: #fafafa; --pdf-head-bg: #ffffff;
            --pdf-link: #1a56db; --pdf-mark-bg: #f5f0d8; }
    .code-block-wrapper { border: none; }
    .code-block-header { display: none; }
    pre { border: 1px solid var(--pdf-border); }
    table tr:nth-child(2n) { background-color: var(--pdf-bg); }
"#;

pub fn theme_css(theme: &str) -> &'static str {
    match theme {
        "dark" => PDF_THEME_DARK,
        "minimal" => PDF_THEME_MINIMAL,
        _ => PDF_THEME_LIGHT,
    }
}

/// Page dimensions in inches, matching Electron's printToPDF page sizes.
pub fn page_size_inches(page_size: &str) -> (f64, f64) {
    match page_size {
        "Letter" => (8.5, 11.0),
        "Legal" => (8.5, 14.0),
        _ => (8.27, 11.69), // A4
    }
}

// ---------------------------------------------------------------------------
// Image URL handling
// ---------------------------------------------------------------------------

/// Matches the `src="..."` of an <img>, whatever the scheme.
static IMG_SRC_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)(<img\b[^>]*?\ssrc=")([^"]+)(")"#).unwrap());

/// Tauri's asset protocol on Windows: http://asset.localhost/<percent-encoded path>
static ASSET_URL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^https?://asset\.localhost/(.*)$").unwrap());

/// Turn an image URL the renderer produced back into a filesystem path.
/// Handles both the asset protocol and plain file:// URLs (which is what the
/// Electron build emitted, so older exported HTML still round-trips).
pub fn url_to_path(url: &str) -> Option<PathBuf> {
    if let Some(caps) = ASSET_URL_RE.captures(url) {
        let encoded = caps.get(1)?.as_str();
        let decoded = urlencoding::decode(encoded).ok()?.into_owned();
        return Some(PathBuf::from(decoded));
    }
    if let Some(rest) = url.strip_prefix("file://") {
        let decoded = urlencoding::decode(rest).ok()?.into_owned();
        // Windows file URLs look like file:///C:/... — strip the leading slash
        let trimmed = if decoded.len() > 2
            && decoded.starts_with('/')
            && decoded.as_bytes()[2] == b':'
            && decoded.as_bytes()[1].is_ascii_alphabetic()
        {
            decoded[1..].to_string()
        } else {
            decoded
        };
        return Some(PathBuf::from(trimmed));
    }
    None
}

/// The reverse, for the print pass: WebView2 loads the temp HTML from a
/// file:// origin, where asset.localhost is not reachable.
pub fn path_to_file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    // Node's pathToFileURL escapes only the characters that would otherwise be
    // read as URL syntax, and notably leaves the drive-letter colon alone —
    // WebView2 rejects `file:///C%3A/...`.
    let mut encoded = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '%' => encoded.push_str("%25"),
            '#' => encoded.push_str("%23"),
            '?' => encoded.push_str("%3F"),
            ' ' => encoded.push_str("%20"),
            '"' => encoded.push_str("%22"),
            c if (c as u32) < 0x20 => encoded.push_str(&format!("%{:02X}", c as u32)),
            c => encoded.push(c),
        }
    }
    if text.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

pub fn rewrite_asset_urls_to_file(html: &str) -> String {
    IMG_SRC_RE
        .replace_all(html, |caps: &Captures| {
            let url = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            match url_to_path(url) {
                Some(path) => format!(
                    "{}{}{}",
                    caps.get(1).map(|m| m.as_str()).unwrap_or(""),
                    path_to_file_url(&path),
                    caps.get(3).map(|m| m.as_str()).unwrap_or("")
                ),
                None => caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string(),
            }
        })
        .into_owned()
}

/// Data-URI inlining caps: one oversized screenshot shouldn't balloon the
/// exported HTML past what browsers and mail clients will open.
const HTML_INLINE_IMAGE_MAX: u64 = 10 * 1024 * 1024;
const HTML_INLINE_TOTAL_MAX: u64 = 40 * 1024 * 1024;

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// Rewrite local image sources into data: URIs so the exported HTML is a
/// single self-contained file. Images that are missing, non-image, or over the
/// size caps keep their original src.
pub fn inline_images(html: &str) -> String {
    use base64::Engine;
    let mut total: u64 = 0;
    let mut replacements: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for caps in IMG_SRC_RE.captures_iter(html) {
        let url = caps.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
        if replacements.contains_key(&url) {
            continue;
        }
        let Some(path) = url_to_path(&url) else { continue };
        let Some(mime) = image_mime(&path) else { continue };
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.len() > HTML_INLINE_IMAGE_MAX || total + meta.len() > HTML_INLINE_TOTAL_MAX {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        total += meta.len();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        replacements.insert(url, format!("data:{mime};base64,{encoded}"));
    }

    if replacements.is_empty() {
        return html.to_string();
    }
    IMG_SRC_RE
        .replace_all(html, |caps: &Captures| {
            let url = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            match replacements.get(url) {
                Some(data_uri) => format!(
                    "{}{}{}",
                    caps.get(1).map(|m| m.as_str()).unwrap_or(""),
                    data_uri,
                    caps.get(3).map(|m| m.as_str()).unwrap_or("")
                ),
                None => caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string(),
            }
        })
        .into_owned()
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;")
}

/// The document handed to WebView2 for printing.
pub fn build_print_document(html_content: &str, theme: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>{theme_css}</style>
  <style>{base_css}</style>
</head>
<body>
{body}
</body>
</html>
"#,
        theme_css = theme_css(theme),
        base_css = PDF_BASE_CSS,
        body = rewrite_asset_urls_to_file(html_content),
    )
}

/// A single self-contained HTML file, images included.
pub fn build_html_document(html_content: &str, theme: &str, title: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{theme_css}</style>
<style>{base_css}</style>
<style>body {{ max-width: 860px; margin: 0 auto; }}</style>
</head>
<body>
{body}
</body>
</html>
"#,
        title = escape_html(title),
        theme_css = theme_css(theme),
        base_css = PDF_BASE_CSS,
        body = inline_images(html_content),
    )
}

/// Pandoc's gfm reader would print YAML frontmatter as a table, so Word export
/// hands it a copy with the frontmatter stripped.
pub fn strip_frontmatter(raw: &str) -> String {
    static FM: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)^---\r?\n.*?\r?\n---\r?\n").unwrap());
    FM.replace(raw, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_urls_decode_back_to_windows_paths() {
        let url = "http://asset.localhost/C%3A%5Cnotes%5Cattachments%5Cshot.png";
        assert_eq!(
            url_to_path(url).unwrap(),
            PathBuf::from(r"C:\notes\attachments\shot.png")
        );
    }

    #[test]
    fn legacy_file_urls_still_decode() {
        assert_eq!(
            url_to_path("file:///C:/notes/a%20b.png").unwrap(),
            PathBuf::from("C:/notes/a b.png")
        );
        assert_eq!(
            url_to_path("file:///home/u/x.png").unwrap(),
            PathBuf::from("/home/u/x.png")
        );
    }

    #[test]
    fn non_local_urls_are_left_alone() {
        assert!(url_to_path("https://example.com/x.png").is_none());
        assert!(url_to_path("data:image/png;base64,AAAA").is_none());
    }

    #[test]
    fn file_urls_round_trip() {
        let path = PathBuf::from(r"C:\notes\my folder\shot.png");
        let url = path_to_file_url(&path);
        assert_eq!(url, "file:///C:/notes/my%20folder/shot.png");
        assert_eq!(url_to_path(&url).unwrap(), PathBuf::from("C:/notes/my folder/shot.png"));
    }

    #[test]
    fn print_documents_rewrite_asset_urls_and_keep_remote_ones() {
        let html = r#"<img src="http://asset.localhost/C%3A%5Cn%5Ca.png"><img src="https://example.com/b.png">"#;
        let doc = build_print_document(html, "light");
        assert!(doc.contains(r#"src="file:///C:/n/a.png""#), "got: {doc}");
        assert!(doc.contains(r#"src="https://example.com/b.png""#));
        assert!(doc.contains("--pdf-bg: #ffffff"));
    }

    #[test]
    fn each_theme_supplies_its_own_tokens() {
        assert!(theme_css("dark").contains("#0d1117"));
        assert!(theme_css("minimal").contains(".code-block-header { display: none; }"));
        assert!(theme_css("nonsense").contains("#ffffff"));
    }

    #[test]
    fn page_sizes_map_to_inches() {
        assert_eq!(page_size_inches("Letter"), (8.5, 11.0));
        assert_eq!(page_size_inches("Legal"), (8.5, 14.0));
        assert_eq!(page_size_inches("A4"), (8.27, 11.69));
    }

    #[test]
    fn missing_images_keep_their_original_src() {
        let html = r#"<img src="http://asset.localhost/C%3A%5Cnope%5Cmissing.png">"#;
        assert_eq!(inline_images(html), html);
    }

    #[test]
    fn present_images_become_data_uris() {
        let dir = std::env::temp_dir().join(format!("mdnb-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("dot.png");
        std::fs::write(&img, b"\x89PNG\r\n\x1a\n").unwrap();

        let html = format!(r#"<img src="{}">"#, path_to_file_url(&img));
        let out = inline_images(&html);
        assert!(out.contains("data:image/png;base64,"), "got: {out}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_image_files_are_not_inlined() {
        let dir = std::env::temp_dir().join(format!("mdnb-export-txt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.txt");
        std::fs::write(&file, b"hello").unwrap();

        let html = format!(r#"<img src="{}">"#, path_to_file_url(&file));
        assert_eq!(inline_images(&html), html);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_titles_are_escaped() {
        let doc = build_html_document("<p>x</p>", "light", "A & B <script>");
        assert!(doc.contains("<title>A &amp; B &lt;script></title>"));
    }

    #[test]
    fn frontmatter_is_stripped_for_word_export() {
        let src = "---\ntitle: X\ntags: [a]\n---\n# Heading\n\nBody\n";
        assert_eq!(strip_frontmatter(src), "# Heading\n\nBody\n");
    }

    #[test]
    fn a_note_without_frontmatter_is_untouched() {
        let src = "# Heading\n\nBody with --- a rule\n";
        assert_eq!(strip_frontmatter(src), src);
    }
}

//! MHTML ("Single File Web Page", `.mht`) parsing.
//!
//! This is the format OneNote's File → Export writes, and the one the COM
//! import publishes each page as. Pandoc has no MHTML reader, so the file is
//! unwrapped here: MHTML is a MIME `multipart/related` document holding one
//! HTML part plus every image it references, so extracting the HTML and
//! saving the images as attachments turns it into something the existing
//! HTML → gfm pandoc path already handles.
//!
//! Nothing here touches the filesystem or COM, so it is all directly testable.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct Resource {
    /// `Content-Location`, the URL the HTML refers to this part by.
    pub location: String,
    /// `Content-ID`, used by `cid:` references. Angle brackets stripped.
    pub content_id: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

impl Resource {
    /// A sensible attachment filename: the last path segment of the location,
    /// or a generated one when the location carries nothing usable.
    pub fn suggested_name(&self, index: usize) -> String {
        let tail = self
            .location
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .split(['?', '#'])
            .next()
            .unwrap_or("");
        let decoded = percent_decode(tail);
        if !decoded.is_empty() && decoded.contains('.') {
            return decoded;
        }
        format!("image-{index}.{}", extension_for(&self.mime))
    }
}

fn extension_for(mime: &str) -> &'static str {
    match mime.split(';').next().unwrap_or("").trim() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/tiff" => "tif",
        _ => "bin",
    }
}

#[derive(Debug, Clone)]
pub struct Mhtml {
    pub html: String,
    pub resources: Vec<Resource>,
}

// ---------------------------------------------------------------------------
// Transfer encodings
// ---------------------------------------------------------------------------

/// RFC 2045 quoted-printable. `=XX` is a hex byte; `=` at end of line is a
/// soft break that disappears.
pub fn decode_quoted_printable(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'=' {
            // Soft line break: "=\r\n" or "=\n"
            if i + 1 < input.len() && input[i + 1] == b'\n' {
                i += 2;
                continue;
            }
            if i + 2 < input.len() && input[i + 1] == b'\r' && input[i + 2] == b'\n' {
                i += 3;
                continue;
            }
            if i + 2 < input.len() {
                let hex = std::str::from_utf8(&input[i + 1..i + 3]).ok();
                if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
            // A stray '=' that isn't valid QP: keep it rather than lose data.
            out.push(b'=');
            i += 1;
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    out
}

fn decode_base64(input: &[u8]) -> Vec<u8> {
    use base64::Engine;
    let cleaned: Vec<u8> = input
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .unwrap_or_default()
}

fn percent_decode(input: &str) -> String {
    urlencoding::decode(input)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| input.to_string())
}

// ---------------------------------------------------------------------------
// MIME structure
// ---------------------------------------------------------------------------

/// Split a MIME entity into its headers and its raw body.
/// Folded continuation lines (leading space or tab) are joined onto the
/// previous header, per RFC 5322.
fn split_headers(entity: &[u8]) -> (HashMap<String, String>, &[u8]) {
    let mut headers: HashMap<String, String> = HashMap::new();
    let mut offset = 0usize;
    let mut current: Option<(String, String)> = None;

    loop {
        let Some(line_end) = find_line_end(entity, offset) else {
            break;
        };
        let raw = &entity[offset..line_end.0];
        let next = line_end.1;

        // A blank line ends the header block.
        if raw.is_empty() {
            offset = next;
            break;
        }

        let line = String::from_utf8_lossy(raw);
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some((_, value)) = current.as_mut() {
                value.push(' ');
                value.push_str(line.trim());
            }
        } else {
            if let Some((name, value)) = current.take() {
                headers.insert(name, value);
            }
            if let Some(colon) = line.find(':') {
                current = Some((
                    line[..colon].trim().to_lowercase(),
                    line[colon + 1..].trim().to_string(),
                ));
            }
        }
        offset = next;
    }
    if let Some((name, value)) = current.take() {
        headers.insert(name, value);
    }

    (headers, &entity[offset.min(entity.len())..])
}

/// Returns (index just past the line's content, index of the next line).
fn find_line_end(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    if from >= buf.len() {
        return None;
    }
    let mut i = from;
    while i < buf.len() && buf[i] != b'\n' {
        i += 1;
    }
    if i >= buf.len() {
        return Some((buf.len(), buf.len()));
    }
    let content_end = if i > from && buf[i - 1] == b'\r' { i - 1 } else { i };
    Some((content_end, i + 1))
}

/// Pull a parameter out of a structured header value, e.g. the `boundary` of
/// `multipart/related; boundary="----=_Next"`.
fn header_param(value: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"(?i){}\s*=\s*("([^"]*)"|[^;\s]+)"#, regex::escape(name));
    let re = Regex::new(&pattern).ok()?;
    let caps = re.captures(value)?;
    caps.get(2)
        .or_else(|| caps.get(1))
        .map(|m| m.as_str().to_string())
}

fn strip_angle_brackets(value: &str) -> String {
    value.trim().trim_start_matches('<').trim_end_matches('>').to_string()
}

/// Split a multipart body on its boundary delimiters.
fn split_parts<'a>(body: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let delimiter = format!("--{boundary}");
    let delimiter = delimiter.as_bytes();
    let mut parts = Vec::new();
    let mut search = 0usize;
    let mut part_start: Option<usize> = None;

    while let Some(found) = find_subslice(body, delimiter, search) {
        // Boundaries must sit at the start of a line.
        let at_line_start = found == 0 || body[found - 1] == b'\n';
        if !at_line_start {
            search = found + 1;
            continue;
        }
        if let Some(start) = part_start.take() {
            let mut end = found;
            // Trim the CRLF that belongs to the delimiter, not the content.
            if end > start && body[end - 1] == b'\n' {
                end -= 1;
            }
            if end > start && body[end - 1] == b'\r' {
                end -= 1;
            }
            parts.push(&body[start..end]);
        }
        let after = found + delimiter.len();
        // "--boundary--" closes the multipart.
        if body[after..].starts_with(b"--") {
            break;
        }
        let next_line = find_line_end(body, after).map(|(_, n)| n).unwrap_or(body.len());
        part_start = Some(next_line);
        search = next_line;
    }
    parts
}

fn find_subslice(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn decode_body(headers: &HashMap<String, String>, body: &[u8]) -> Vec<u8> {
    match headers
        .get("content-transfer-encoding")
        .map(|v| v.trim().to_lowercase())
        .as_deref()
    {
        Some("quoted-printable") => decode_quoted_printable(body),
        Some("base64") => decode_base64(body),
        _ => body.to_vec(),
    }
}

/// Decode a text part's bytes using its declared charset. Windows-1252 shows
/// up in older exports; anything else is treated as UTF-8 with lossy fallback.
fn decode_text(bytes: &[u8], content_type: &str) -> String {
    let charset = header_param(content_type, "charset")
        .unwrap_or_default()
        .to_lowercase();
    match charset.as_str() {
        "windows-1252" | "cp1252" | "iso-8859-1" | "latin1" => {
            bytes.iter().map(|&b| windows_1252_char(b)).collect()
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Windows-1252 differs from Latin-1 only in 0x80–0x9F.
fn windows_1252_char(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{FFFD}',
        '\u{017D}', '\u{FFFD}', '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}',
        '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
    ];
    if (0x80..0xA0).contains(&byte) {
        HIGH[(byte - 0x80) as usize]
    } else {
        byte as char
    }
}

/// Parse an MHTML document into its HTML and the resources it embeds.
///
/// A file that isn't multipart at all (a plain HTML part with MIME headers) is
/// still accepted — its body simply becomes the HTML with no resources.
pub fn parse(bytes: &[u8]) -> Result<Mhtml, String> {
    let (headers, body) = split_headers(bytes);
    let content_type = headers.get("content-type").cloned().unwrap_or_default();

    let Some(boundary) = header_param(&content_type, "boundary") else {
        // Not multipart: treat the whole body as the HTML document.
        let decoded = decode_body(&headers, body);
        let html = decode_text(&decoded, &content_type);
        if html.trim().is_empty() {
            return Err("The file contains no readable HTML.".into());
        }
        return Ok(Mhtml {
            html,
            resources: Vec::new(),
        });
    };

    let mut html: Option<String> = None;
    let mut resources = Vec::new();

    for part in split_parts(body, &boundary) {
        let (part_headers, part_body) = split_headers(part);
        let part_type = part_headers
            .get("content-type")
            .cloned()
            .unwrap_or_else(|| "text/plain".into());
        let mime = part_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let decoded = decode_body(&part_headers, part_body);

        if mime == "text/html" && html.is_none() {
            // The first HTML part is the document; later ones are frames.
            html = Some(decode_text(&decoded, &part_type));
        } else if !decoded.is_empty() {
            resources.push(Resource {
                location: part_headers
                    .get("content-location")
                    .cloned()
                    .unwrap_or_default(),
                content_id: part_headers
                    .get("content-id")
                    .map(|v| strip_angle_brackets(v))
                    .unwrap_or_default(),
                mime,
                bytes: decoded,
            });
        }
    }

    match html {
        Some(html) if !html.trim().is_empty() => Ok(Mhtml { html, resources }),
        _ => Err("The file contains no HTML part — is it really a .mht export?".into()),
    }
}

/// Point the document's `src` attributes at saved attachments.
///
/// `replacements` maps whatever the HTML might use to name a resource — the
/// full Content-Location, its bare filename, or `cid:<Content-ID>` — onto the
/// note-relative path the attachment was written to.
/// What `rewrite_sources_ordered` did, so the import can report it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RewriteOutcome {
    pub html: String,
    /// Images now pointing at a saved attachment.
    pub linked: usize,
    /// Images whose source could not be matched to any part of the MHTML.
    pub unresolved: usize,
}

pub fn rewrite_sources(html: &str, replacements: &HashMap<String, String>) -> String {
    rewrite_sources_ordered(html, replacements, &[]).html
}

/// Point every `<img>` at its saved attachment.
///
/// Matching is by source string first — location, `cid:`, bare filename,
/// percent-decoded — and `ordered` is the safety net: the saved attachments in
/// the order the MHTML listed them, handed out to any image whose source
/// matched nothing. OneNote writes its parts in document order, so an image
/// referenced by some spelling this does not recognise still lands on the right
/// file rather than staying broken.
pub fn rewrite_sources_ordered(
    html: &str,
    replacements: &HashMap<String, String>,
    ordered: &[String],
) -> RewriteOutcome {
    // The value may be double-quoted, single-quoted, or bare — Office writes
    // all three, and a quoted-only pattern silently skips the rest.
    static SRC_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"(?i)(<img\b[^>]*?\ssrc\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
    });

    let mut linked = 0usize;
    let mut unresolved = 0usize;
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();

    let html = SRC_RE
        .replace_all(html, |caps: &regex::Captures| {
            let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let raw = caps
                .get(3)
                .or_else(|| caps.get(4))
                .or_else(|| caps.get(5))
                .map(|m| m.as_str())
                .unwrap_or("");

            if let Some(path) = lookup(raw, replacements) {
                used.insert(path.clone());
                linked += 1;
                return format!(r#"{prefix}"{path}""#);
            }
            if let Some(next) = ordered.iter().find(|p| !used.contains(*p)) {
                used.insert(next.clone());
                linked += 1;
                return format!(r#"{prefix}"{next}""#);
            }
            unresolved += 1;
            caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string()
        })
        .into_owned();

    RewriteOutcome { html, linked, unresolved }
}

fn lookup(reference: &str, replacements: &HashMap<String, String>) -> Option<String> {
    let trimmed = reference.trim();
    if let Some(hit) = replacements.get(trimmed) {
        return Some(hit.clone());
    }
    // cid:foo → foo
    if let Some(rest) = trimmed.strip_prefix("cid:") {
        if let Some(hit) = replacements.get(rest) {
            return Some(hit.clone());
        }
    }
    // Fall back to the bare filename, which is how relative refs appear.
    let tail = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("");
    if !tail.is_empty() {
        if let Some(hit) = replacements.get(tail) {
            return Some(hit.clone());
        }
        let decoded = percent_decode(tail);
        if let Some(hit) = replacements.get(decoded.as_str()) {
            return Some(hit.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A miniature version of what OneNote's "Single File Web Page" writes.
    fn sample_mht() -> Vec<u8> {
        let png = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nFAKE")
        };
        format!(
            "From: <Saved by Microsoft OneNote>\r\n\
             Subject: Meeting Notes\r\n\
             MIME-Version: 1.0\r\n\
             Content-Type: multipart/related;\r\n\
             \ttype=\"text/html\";\r\n\
             \tboundary=\"----=_NextPart_01\"\r\n\
             \r\n\
             ------=_NextPart_01\r\n\
             Content-Location: http://example.com/page.htm\r\n\
             Content-Transfer-Encoding: quoted-printable\r\n\
             Content-Type: text/html; charset=\"utf-8\"\r\n\
             \r\n\
             <html><body><h1>Meeting=20Notes</h1>\r\n\
             <p>Caf=C3=A9 budget =\r\n\
             review</p>\r\n\
             <img src=3D\"http://example.com/image001.png\">\r\n\
             </body></html>\r\n\
             ------=_NextPart_01\r\n\
             Content-Location: http://example.com/image001.png\r\n\
             Content-Transfer-Encoding: base64\r\n\
             Content-Type: image/png\r\n\
             \r\n\
             {png}\r\n\
             ------=_NextPart_01--\r\n"
        )
        .into_bytes()
    }

    #[test]
    fn quoted_printable_decodes_hex_and_soft_breaks() {
        assert_eq!(decode_quoted_printable(b"Caf=C3=A9"), "Café".as_bytes());
        assert_eq!(decode_quoted_printable(b"one=\r\ntwo"), b"onetwo");
        assert_eq!(decode_quoted_printable(b"one=\ntwo"), b"onetwo");
        assert_eq!(decode_quoted_printable(b"plain text"), b"plain text");
        // A '=' that isn't valid QP survives rather than eating the next byte
        assert_eq!(decode_quoted_printable(b"a=zz"), b"a=zz");
    }

    #[test]
    fn folded_headers_are_joined() {
        let entity = b"Content-Type: multipart/related;\r\n\tboundary=\"abc\"\r\n\r\nbody";
        let (headers, body) = split_headers(entity);
        assert_eq!(
            headers.get("content-type").unwrap(),
            "multipart/related; boundary=\"abc\""
        );
        assert_eq!(body, b"body");
    }

    #[test]
    fn header_params_handle_quotes_and_bare_values() {
        assert_eq!(header_param(r#"x; boundary="a-b""#, "boundary").unwrap(), "a-b");
        assert_eq!(header_param("x; boundary=plain", "boundary").unwrap(), "plain");
        assert_eq!(header_param("text/html; charset=\"utf-8\"", "charset").unwrap(), "utf-8");
        assert!(header_param("text/html", "charset").is_none());
    }

    #[test]
    fn a_onenote_style_export_yields_html_and_its_image() {
        let parsed = parse(&sample_mht()).unwrap();
        assert!(parsed.html.contains("<h1>Meeting Notes</h1>"), "{}", parsed.html);
        // Soft break rejoined, and the UTF-8 escape decoded
        assert!(parsed.html.contains("Café budget review"), "{}", parsed.html);
        assert_eq!(parsed.resources.len(), 1);
        assert_eq!(parsed.resources[0].mime, "image/png");
        assert_eq!(parsed.resources[0].location, "http://example.com/image001.png");
        assert!(parsed.resources[0].bytes.starts_with(b"\x89PNG"));
    }

    #[test]
    fn sources_are_rewritten_by_location_filename_or_cid() {
        let mut map = HashMap::new();
        map.insert("http://example.com/image001.png".to_string(), "../attachments/a.png".to_string());
        map.insert("logo.gif".to_string(), "../attachments/b.gif".to_string());
        map.insert("abc123".to_string(), "../attachments/c.jpg".to_string());

        let html = r#"<img src="http://example.com/image001.png"><img src='./logo.gif'><img src="cid:abc123"><img src="http://other/x.png">"#;
        let out = rewrite_sources(html, &map);
        assert!(out.contains(r#"src="../attachments/a.png""#), "{out}");
        assert!(out.contains(r#"src="../attachments/b.gif""#), "{out}");
        assert!(out.contains(r#"src="../attachments/c.jpg""#), "{out}");
        // Unknown references are left exactly as they were
        assert!(out.contains(r#"src="http://other/x.png""#), "{out}");
    }

    #[test]
    fn resource_names_come_from_the_location_when_usable() {
        let resource = Resource {
            location: "http://example.com/path/My%20Image.PNG?v=2".into(),
            content_id: String::new(),
            mime: "image/png".into(),
            bytes: vec![1],
        };
        assert_eq!(resource.suggested_name(0), "My Image.PNG");

        let bare = Resource {
            location: "http://example.com/generate".into(),
            content_id: String::new(),
            mime: "image/jpeg".into(),
            bytes: vec![1],
        };
        assert_eq!(bare.suggested_name(3), "image-3.jpg");
    }

    #[test]
    fn a_plain_html_entity_is_accepted() {
        let entity = b"MIME-Version: 1.0\r\nContent-Type: text/html; charset=\"utf-8\"\r\n\r\n<html>hi</html>";
        let parsed = parse(entity).unwrap();
        assert_eq!(parsed.html, "<html>hi</html>");
        assert!(parsed.resources.is_empty());
    }

    #[test]
    fn windows_1252_text_decodes() {
        // 0x92 is a curly apostrophe in cp1252, invalid UTF-8
        let entity = b"Content-Type: text/html; charset=\"windows-1252\"\r\n\r\nIt\x92s fine";
        let parsed = parse(entity).unwrap();
        assert_eq!(parsed.html, "It\u{2019}s fine");
    }

    #[test]
    fn a_file_without_html_is_reported_clearly() {
        let entity = b"Content-Type: text/plain\r\n\r\njust text";
        // A non-multipart text/plain body still comes through as "html"
        assert!(parse(entity).is_ok());

        let multipart = b"Content-Type: multipart/related; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: image/png\r\n\r\nxx\r\n--b--\r\n";
        let err = parse(multipart).unwrap_err();
        assert!(err.contains(".mht"), "{err}");
    }

    #[test]
    fn empty_input_is_an_error_not_a_panic() {
        assert!(parse(b"").is_err());
    }

    // --- image sources -----------------------------------------------------

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_single_quoted_source_is_rewritten() {
        let out = rewrite_sources("<img src='shot.png'>", &map(&[("shot.png", "att/a.png")]));
        assert!(out.contains(r#"src="att/a.png""#), "{out}");
    }

    #[test]
    fn an_unquoted_source_is_rewritten() {
        // Office emits these; the old pattern matched quoted values only, so
        // every image written this way stayed broken.
        let out = rewrite_sources("<img src=shot.png >", &map(&[("shot.png", "att/a.png")]));
        assert!(out.contains(r#"src="att/a.png""#), "{out}");
    }

    #[test]
    fn an_unmatched_source_falls_back_to_document_order() {
        let ordered = vec!["att/one.png".to_string(), "att/two.png".to_string()];
        let got = rewrite_sources_ordered(
            r#"<img src="cid:unknown-1"><img src="cid:unknown-2">"#,
            &HashMap::new(),
            &ordered,
        );
        assert!(got.html.contains(r#"src="att/one.png""#), "{}", got.html);
        assert!(got.html.contains(r#"src="att/two.png""#), "{}", got.html);
        assert_eq!(got.linked, 2);
        assert_eq!(got.unresolved, 0);
    }

    #[test]
    fn the_fallback_never_reuses_an_image_already_placed_by_name() {
        // First image matches by name and consumes one.png; the second must
        // fall back to two.png, not hand out one.png a second time.
        let ordered = vec!["att/one.png".to_string(), "att/two.png".to_string()];
        let got = rewrite_sources_ordered(
            r#"<img src="known.png"><img src="cid:mystery">"#,
            &map(&[("known.png", "att/one.png")]),
            &ordered,
        );
        assert!(got.html.contains(r#"src="att/one.png""#), "{}", got.html);
        assert!(got.html.contains(r#"src="att/two.png""#), "{}", got.html);
        assert_eq!(got.html.matches("att/one.png").count(), 1, "{}", got.html);
    }

    #[test]
    fn an_image_with_nothing_left_to_fall_back_to_is_counted_not_mangled() {
        let got = rewrite_sources_ordered(r#"<img src="gone.png">"#, &HashMap::new(), &[]);
        assert_eq!(got.unresolved, 1);
        assert_eq!(got.linked, 0);
        // The original tag survives, so the note still shows something is there.
        assert!(got.html.contains(r#"src="gone.png""#), "{}", got.html);
    }

    #[test]
    fn other_attributes_on_the_tag_survive_the_rewrite() {
        let got = rewrite_sources_ordered(
            r#"<img alt="A chart" src="shot.png" width="300">"#,
            &map(&[("shot.png", "att/a.png")]),
            &[],
        );
        assert!(got.html.contains(r#"alt="A chart""#), "{}", got.html);
        assert!(got.html.contains(r#"width="300""#), "{}", got.html);
        assert!(got.html.contains(r#"src="att/a.png""#), "{}", got.html);
    }
}

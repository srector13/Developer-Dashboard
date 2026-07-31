//! Turning OneNote's exported HTML into something pandoc can render as clean
//! markdown.
//!
//! OneNote publishes MHTML meant for a browser, not for conversion. A page of
//! three bullet points arrives as nested `<div>`s carrying absolute positions,
//! every run of text wrapped in a `<span style="font-family:Calibri;...">`, a
//! single-cell `<table>` used purely to place the body on the canvas, and
//! Office's own `<o:p>` and conditional-comment markup throughout.
//!
//! Handed that directly, pandoc does the only correct thing it can: what it
//! cannot express in markdown it passes through as raw HTML, so the note ends
//! up full of `<div>` and `<span>` tags. Stripping the presentation first is
//! what makes the difference between a note that reads as markdown and one that
//! reads as a web page someone pasted in.
//!
//! All of this is plain string work, so it is testable without Windows, OneNote
//! or pandoc — which the COM half of this feature emphatically is not.

use once_cell::sync::Lazy;
use regex::Regex;

/// Strip the presentation OneNote wraps its content in.
pub fn clean_onenote_html(html: &str) -> String {
    let mut out = html.to_string();

    // Office's conditional comments carry a second, uglier copy of the markup.
    static CONDITIONAL: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?is)<!--\[if[^>]*\]>.*?<!\[endif\]-->").unwrap());
    out = CONDITIONAL.replace_all(&out, "").into_owned();

    // Stylesheets and scripts contribute nothing to a markdown note, and
    // pandoc would otherwise emit the CSS as a paragraph of text. One pattern
    // per tag: this crate's regex engine has no backreferences, so a single
    // `<(style|script)>…</\1>` is not available.
    static BLOCKS: Lazy<Vec<Regex>> = Lazy::new(|| {
        ["style", "script", "head", "xml"]
            .iter()
            .map(|tag| Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</\s*{tag}\s*>")).unwrap())
            .collect()
    });
    for pattern in BLOCKS.iter() {
        out = pattern.replace_all(&out, "").into_owned();
    }

    // Office namespace tags: <o:p>, <w:worddocument>, <v:shape …>.
    static OFFICE_TAGS: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?is)</?[a-z]+:[a-z0-9]+\b[^>]*>").unwrap());
    out = OFFICE_TAGS.replace_all(&out, "").into_owned();

    // Presentation attributes. `style` is the big one — it is what makes pandoc
    // treat a span as something it must preserve verbatim.
    static ATTRS: Lazy<Regex> = Lazy::new(|| {
        Regex::new(
            r#"(?i)\s(style|class|lang|id|width|height|align|valign|bgcolor|border|cellpadding|cellspacing|dir|face|color|size)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#,
        )
        .unwrap()
    });
    // `<img width=…>` is presentation too, but its `src` and `alt` must survive,
    // and the pattern above only ever removes the attributes it names.
    out = ATTRS.replace_all(&out, "").into_owned();

    out = unwrap_single_cell_tables(&out);

    // A span with nothing left on it is pure noise once its style is gone.
    static BARE_SPAN: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)</?span\s*>").unwrap());
    out = BARE_SPAN.replace_all(&out, "").into_owned();

    // Non-breaking spaces read as normal spaces in a note, and left alone they
    // become a literal U+00A0 that looks like a stray character in the editor.
    out = out.replace("&nbsp;", " ").replace('\u{00A0}', " ");

    out
}

/// Remove `<table>` wrappers that hold exactly one cell.
///
/// OneNote uses these to position a page's body on its canvas. Converted
/// literally they become a one-cell markdown table wrapped around the whole
/// note. Tables with real content — more than one cell — are left alone,
/// because those are tables the user actually made.
pub fn unwrap_single_cell_tables(html: &str) -> String {
    static TABLE_OPEN: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)<table\b[^>]*>").unwrap());
    let mut out = String::with_capacity(html.len());
    let mut rest = html;

    while let Some(open) = TABLE_OPEN.find(rest) {
        out.push_str(&rest[..open.start()]);
        // Find this table's matching close, counting nested tables.
        let body_start = open.start();
        let Some(end) = matching_table_end(rest, open.end()) else {
            // Unbalanced markup: keep the remainder verbatim rather than
            // truncating someone's note.
            out.push_str(&rest[body_start..]);
            return out;
        };
        let whole = &rest[body_start..end];
        // Only this table's own cells count. A layout wrapper around a real
        // table would otherwise see the inner table's cells as its own and be
        // left in place. Taking the cell's contents — rather than deleting all
        // table tags in the block — is what keeps a nested real table intact.
        let inner = &rest[open.end()..end];
        match single_cell_content(inner) {
            // Recurse: the cell may itself hold another layout table.
            // Unwrapping keeps only the cell, so it is only safe when nothing
            // else in the table carries text — a caption or a stray row would
            // otherwise be dropped, and losing content is far worse than
            // leaving a one-cell table in place.
            Some(cell) if !has_text_outside(inner, cell) => {
                out.push_str(&unwrap_single_cell_tables(cell))
            }
            _ => out.push_str(whole),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// Does anything in `inner` other than `cell` carry visible text?
///
/// `cell` is a slice of `inner`, so the two ends around it are what unwrapping
/// would throw away.
fn has_text_outside(inner: &str, cell: &str) -> bool {
    static TAGS: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
    let cell_start = cell.as_ptr() as usize - inner.as_ptr() as usize;
    let cell_end = cell_start + cell.len();
    let outside = format!("{}{}", &inner[..cell_start], &inner[cell_end..]);
    let text = TAGS.replace_all(&outside, "");
    text.chars().any(|c| !c.is_whitespace() && c != '\u{00A0}')
}

/// The contents of this table's only cell, or `None` when it has any number of
/// cells other than one.
///
/// `inner` is everything between the table's own open and close tags. Cells
/// inside a nested table belong to that table, not this one, so the scan tracks
/// table depth and only counts what sits at depth zero.
fn single_cell_content(inner: &str) -> Option<&str> {
    static TAG: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)<(/?)(table|td|th)\b[^>]*>").unwrap());

    let mut table_depth = 0usize;
    let mut cell_depth = 0usize;
    let mut cells = 0usize;
    let mut start = None;
    let mut end = None;

    for caps in TAG.captures_iter(inner) {
        let whole = caps.get(0)?;
        let closing = caps.get(1).map(|m| m.as_str()) == Some("/");
        let tag = caps.get(2).map(|m| m.as_str()).unwrap_or("").to_ascii_lowercase();

        if tag == "table" {
            if closing {
                table_depth = table_depth.saturating_sub(1);
            } else {
                table_depth += 1;
            }
            continue;
        }
        // A cell of a nested table.
        if table_depth > 0 {
            continue;
        }
        if closing {
            cell_depth = cell_depth.saturating_sub(1);
            if cell_depth == 0 && start.is_some() && end.is_none() {
                end = Some(whole.start());
            }
        } else {
            if cell_depth == 0 {
                cells += 1;
                if cells > 1 {
                    return None; // a table the user actually made
                }
                start = Some(whole.end());
            }
            cell_depth += 1;
        }
    }

    match (cells, start, end) {
        (1, Some(from), Some(to)) if from <= to => Some(&inner[from..to]),
        _ => None,
    }
}

/// The index just past the `</table>` that closes the table opened before
/// `from`, accounting for nesting.
fn matching_table_end(html: &str, from: usize) -> Option<usize> {
    static ANY: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)<(/?)table\b[^>]*>").unwrap());
    let mut depth = 1usize;
    for caps in ANY.captures_iter(&html[from..]) {
        let whole = caps.get(0)?;
        if caps.get(1).map(|m| m.as_str()) == Some("/") {
            depth -= 1;
            if depth == 0 {
                return Some(from + whole.end());
            }
        } else {
            depth += 1;
        }
    }
    None
}

/// Turn `<img>` tags in markdown output back into `![alt](src)`.
///
/// pandoc's gfm writer falls back to raw HTML for an image whenever it carries
/// anything markdown cannot say — and a Word export always carries width and
/// height, so *every* image from a OneNote page arrives as an `<img>` tag with
/// an inline style. The dimensions are worth nothing in a note; the link is
/// worth everything.
pub fn html_images_to_markdown(markdown: &str) -> String {
    static IMG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<img\b([^>]*?)/?>").unwrap());
    static ATTR: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"(?i)\b(src|alt|title)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
    });

    IMG.replace_all(markdown, |caps: &regex::Captures| {
        let attrs = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let mut src = String::new();
        let mut alt = String::new();
        let mut title = String::new();
        for attr in ATTR.captures_iter(attrs) {
            let value = attr
                .get(3)
                .or_else(|| attr.get(4))
                .or_else(|| attr.get(5))
                .map(|m| m.as_str())
                .unwrap_or("");
            match attr.get(1).map(|m| m.as_str().to_ascii_lowercase()).as_deref() {
                Some("src") => src = value.to_string(),
                Some("alt") => alt = value.to_string(),
                Some("title") => title = value.to_string(),
                _ => {}
            }
        }
        // Without a source there is no image to write, so keep the tag rather
        // than silently deleting it.
        if src.is_empty() {
            return caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string();
        }
        if title.is_empty() {
            format!("![{alt}]({src})")
        } else {
            format!("![{alt}]({src} \"{title}\")")
        }
    })
    .into_owned()
}

/// Every local file a markdown document points at through an image link.
///
/// Returns each `(whole link target, byte range)` so a caller can swap the
/// target for something else. Both `![alt](path)` and a surviving `<img src>`
/// are covered; remote URLs and data URIs are skipped, since there is no local
/// file to relocate.
pub fn image_targets(markdown: &str) -> Vec<(String, std::ops::Range<usize>)> {
    static MD_IMAGE: Lazy<Regex> = Lazy::new(|| Regex::new(r"!\[[^\]]*\]\(([^)]+)\)").unwrap());
    static HTML_IMAGE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"(?i)<img\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
    });

    let mut found = Vec::new();
    let mut push = |m: regex::Match| {
        let raw = m.as_str();
        // A markdown target may carry a title: ![](path "Caption").
        let path = raw.split_whitespace().next().unwrap_or(raw);
        if path.is_empty() || is_remote(path) {
            return;
        }
        found.push((path.to_string(), m.start()..m.start() + path.len()));
    };

    for caps in MD_IMAGE.captures_iter(markdown) {
        if let Some(m) = caps.get(1) {
            push(m);
        }
    }
    for caps in HTML_IMAGE.captures_iter(markdown) {
        if let Some(m) = caps.get(2).or_else(|| caps.get(3)).or_else(|| caps.get(4)) {
            push(m);
        }
    }
    found.sort_by_key(|(_, range)| range.start);
    found
}

fn is_remote(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("//")
}

/// Replace image targets with new ones, given as `(range, replacement)`.
///
/// Applied back to front so an earlier replacement cannot shift the offsets of
/// a later one.
pub fn replace_ranges(text: &str, mut edits: Vec<(std::ops::Range<usize>, String)>) -> String {
    edits.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
    let mut out = text.to_string();
    for (range, replacement) in edits {
        if range.end <= out.len() {
            out.replace_range(range, &replacement);
        }
    }
    out
}

/// Tidy what pandoc produced.
pub fn tidy_markdown(md: &str) -> String {
    // Trailing spaces are invisible and become accidental hard line breaks.
    let mut lines: Vec<String> = md
        .lines()
        .map(|line| line.trim_end().to_string())
        .collect();

    // A line holding only punctuation-free whitespace artefacts from the export
    // is not content; blanking it lets the blank-run collapse below remove it.
    for line in lines.iter_mut() {
        if line.chars().all(|c| c.is_whitespace() || c == '\u{00A0}') {
            line.clear();
        }
    }

    // Collapse runs of blank lines to a single blank line. OneNote's layout
    // divs turn into dozens of them.
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut blanks = 0usize;
    for line in lines {
        if line.is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push(line);
    }

    let mut text = out.join("\n");
    while text.starts_with('\n') {
        text.remove(0);
    }
    text.truncate(text.trim_end().len());
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_styles_and_classes_are_removed() {
        let html = r#"<p style="margin:0;font-size:11pt" class="MsoNormal">Hello</p>"#;
        assert_eq!(clean_onenote_html(html), "<p>Hello</p>");
    }

    #[test]
    fn an_unquoted_attribute_value_is_removed_too() {
        // Office emits these; a quoted-only pattern would leave them behind.
        assert_eq!(clean_onenote_html("<td width=120 valign=top>x</td>"), "<td>x</td>");
    }

    #[test]
    fn a_span_left_with_no_attributes_is_unwrapped() {
        let html = r#"<p><span style="font-family:Calibri">plain text</span></p>"#;
        assert_eq!(clean_onenote_html(html), "<p>plain text</p>");
    }

    #[test]
    fn an_images_src_and_alt_survive_the_attribute_strip() {
        let html = r#"<img src="attachments/a.png" alt="A diagram" width="400" style="border:0">"#;
        let cleaned = clean_onenote_html(html);
        assert!(cleaned.contains(r#"src="attachments/a.png""#), "{cleaned}");
        assert!(cleaned.contains(r#"alt="A diagram""#), "{cleaned}");
        assert!(!cleaned.contains("width"), "{cleaned}");
    }

    #[test]
    fn a_link_keeps_its_href() {
        let html = r#"<a href="https://example.com" style="color:blue">site</a>"#;
        assert!(clean_onenote_html(html).contains(r#"href="https://example.com""#));
    }

    #[test]
    fn style_and_script_blocks_go_with_their_contents() {
        let html = "<style>p { margin: 0 }</style><p>kept</p><script>alert(1)</script>";
        assert_eq!(clean_onenote_html(html), "<p>kept</p>");
    }

    #[test]
    fn office_conditional_comments_are_dropped_whole() {
        let html = "<!--[if gte mso 9]><xml><o:DocumentProperties/></xml><![endif]--><p>body</p>";
        assert_eq!(clean_onenote_html(html), "<p>body</p>");
    }

    #[test]
    fn office_namespace_tags_are_dropped() {
        assert_eq!(clean_onenote_html("<p>text<o:p></o:p></p>"), "<p>text</p>");
    }

    #[test]
    fn non_breaking_spaces_become_ordinary_ones() {
        assert_eq!(clean_onenote_html("<p>a&nbsp;b\u{00A0}c</p>"), "<p>a b c</p>");
    }

    #[test]
    fn a_single_cell_layout_table_is_unwrapped() {
        let html = "<table><tbody><tr><td><p>the page</p></td></tr></tbody></table>";
        assert_eq!(unwrap_single_cell_tables(html), "<p>the page</p>");
    }

    #[test]
    fn a_real_table_is_left_intact() {
        let html = "<table><tr><td>a</td><td>b</td></tr></table>";
        assert_eq!(unwrap_single_cell_tables(html), html);
    }

    #[test]
    fn a_layout_table_wrapping_a_real_one_unwraps_only_the_outer() {
        // OneNote's canvas wrapper around a table the user actually made.
        let html = "<table><tr><td><table><tr><td>a</td><td>b</td></tr></table></td></tr></table>";
        let got = unwrap_single_cell_tables(html);
        assert_eq!(got, "<table><tr><td>a</td><td>b</td></tr></table>");
    }

    #[test]
    fn content_around_a_table_is_preserved() {
        // The cell's own contents come through as-is — it held bare text, so
        // bare text is what is left once the wrapper goes.
        let html = "<p>before</p><table><tr><td>only</td></tr></table><p>after</p>";
        assert_eq!(unwrap_single_cell_tables(html), "<p>before</p>only<p>after</p>");
    }

    #[test]
    fn unbalanced_table_markup_does_not_lose_content() {
        let html = "<p>keep</p><table><tr><td>dangling";
        let got = unwrap_single_cell_tables(html);
        assert!(got.contains("keep"), "{got}");
        assert!(got.contains("dangling"), "{got}");
    }

    #[test]
    fn a_caption_stops_the_table_being_unwrapped() {
        // Unwrapping keeps only the cell, so anything else carrying text would
        // vanish. Losing content is worse than leaving a one-cell table.
        let html = "<table><caption>Q3 figures</caption><tr><td>body</td></tr></table>";
        assert_eq!(unwrap_single_cell_tables(html), html);
    }

    #[test]
    fn a_stray_empty_row_does_not_block_unwrapping() {
        // Whitespace and empty markup outside the cell carry nothing, so the
        // layout wrapper still goes.
        let html = "<table>\n  <tr>\n  </tr>\n<tr><td><p>body</p></td></tr></table>";
        assert_eq!(unwrap_single_cell_tables(html), "<p>body</p>");
    }

    // --- pandoc's raw <img> fallback -------------------------------------

    #[test]
    fn a_word_export_image_becomes_a_markdown_image() {
        // Verbatim from `pandoc page.docx -t gfm`: the inline style is why
        // pandoc could not write markdown in the first place.
        let got = html_images_to_markdown(
            r#"<img src="mediaout/media/rId21.png" style="width:0.11111in;height:0.11111in" alt="A diagram" />"#,
        );
        assert_eq!(got, "![A diagram](mediaout/media/rId21.png)");
    }

    #[test]
    fn an_image_with_no_alt_text_still_converts() {
        assert_eq!(
            html_images_to_markdown(r#"<img src="a.png" width="30" />"#),
            "![](a.png)"
        );
    }

    #[test]
    fn a_title_is_carried_across() {
        assert_eq!(
            html_images_to_markdown(r#"<img src="a.png" alt="A" title="T">"#),
            r#"![A](a.png "T")"#
        );
    }

    #[test]
    fn several_images_in_one_document_all_convert() {
        let got = html_images_to_markdown(
            r#"one <img src="a.png" alt="A"/> two <img src="b.png" alt="B"/>"#,
        );
        assert_eq!(got, "one ![A](a.png) two ![B](b.png)");
    }

    #[test]
    fn a_tag_with_no_source_is_left_alone_rather_than_deleted() {
        let html = r#"<img alt="broken" />"#;
        assert_eq!(html_images_to_markdown(html), html);
    }

    // --- image targets, for relocating what pandoc extracted ---------------

    #[test]
    fn a_markdown_image_target_is_found() {
        let got = image_targets("text ![a shot](media/image1.png) more");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "media/image1.png");
    }

    #[test]
    fn a_title_after_the_path_is_not_part_of_it() {
        let got = image_targets(r#"![](media/i.png "A caption")"#);
        assert_eq!(got[0].0, "media/i.png");
    }

    #[test]
    fn a_surviving_html_image_is_found_too() {
        let got = image_targets(r#"<img src="media/i.png" alt="x">"#);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "media/i.png");
    }

    #[test]
    fn remote_and_inline_images_are_left_alone() {
        // There is no local file to relocate for any of these.
        assert!(image_targets("![](https://example.com/a.png)").is_empty());
        assert!(image_targets("![](http://example.com/a.png)").is_empty());
        assert!(image_targets("![](data:image/png;base64,AAAA)").is_empty());
        assert!(image_targets("![](//cdn/a.png)").is_empty());
    }

    #[test]
    fn a_plain_link_is_not_mistaken_for_an_image() {
        assert!(image_targets("[a page](other.md)").is_empty());
    }

    #[test]
    fn the_reported_range_covers_exactly_the_path() {
        let text = "![alt](media/image1.png)";
        let (target, range) = image_targets(text).remove(0);
        assert_eq!(&text[range], target);
    }

    #[test]
    fn replacing_several_targets_keeps_them_all_correct() {
        // Back-to-front application is what stops an earlier edit shifting a
        // later one's offsets.
        let text = "![](a.png) and ![](bb.png) and ![](c.png)";
        let edits: Vec<_> = image_targets(text)
            .into_iter()
            .map(|(t, r)| (r, format!("attachments/{}", t.to_uppercase())))
            .collect();
        assert_eq!(
            replace_ranges(text, edits),
            "![](attachments/A.PNG) and ![](attachments/BB.PNG) and ![](attachments/C.PNG)"
        );
    }

    #[test]
    fn an_out_of_bounds_range_is_skipped_rather_than_panicking() {
        let got = replace_ranges("short", vec![(100..200, "x".into())]);
        assert_eq!(got, "short");
    }

    #[test]
    fn runs_of_blank_lines_collapse_to_one() {
        assert_eq!(tidy_markdown("a\n\n\n\n\nb"), "a\n\nb\n");
    }

    #[test]
    fn trailing_spaces_go_so_they_cannot_become_hard_breaks() {
        assert_eq!(tidy_markdown("a   \nb\t\n"), "a\nb\n");
    }

    #[test]
    fn whitespace_only_lines_count_as_blank() {
        assert_eq!(tidy_markdown("a\n \n\u{00A0}\n \nb"), "a\n\nb\n");
    }

    #[test]
    fn leading_and_trailing_blank_lines_are_trimmed_to_one_newline() {
        assert_eq!(tidy_markdown("\n\n\nbody\n\n\n"), "body\n");
    }

    #[test]
    fn an_empty_document_stays_harmless() {
        assert_eq!(tidy_markdown(""), "\n");
        assert_eq!(tidy_markdown("\n\n\n"), "\n");
    }

    #[test]
    fn a_realistic_onenote_fragment_comes_out_as_plain_html() {
        // Close to what Publish actually emits for a short page.
        let html = r#"<html><head><style>.a{}</style></head><body>
<table cellpadding="0" cellspacing="0" style="position:absolute"><tr><td>
<div style="position:absolute;left:48px"><p class="MsoNormal">
<span style="font-family:Calibri;font-size:11pt">Meeting notes</span><o:p></o:p></p>
<ul><li><span style="font-family:Calibri">First point</span></li></ul>
</div></td></tr></table></body></html>"#;
        let cleaned = clean_onenote_html(html);
        assert!(!cleaned.contains("style="), "{cleaned}");
        assert!(!cleaned.contains("<span"), "{cleaned}");
        assert!(!cleaned.contains("<table"), "{cleaned}");
        assert!(!cleaned.contains("o:p"), "{cleaned}");
        assert!(cleaned.contains("Meeting notes"), "{cleaned}");
        assert!(cleaned.contains("<li>First point</li>"), "{cleaned}");
    }
}

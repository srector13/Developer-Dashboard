//! Full-text search over the index built by the tree scan, plus the
//! launcher's lighter title-first search and backlink discovery.

use crate::notebook::{list_markdown_files, SearchDoc};
use crate::settings::AppSettings;
use serde::Serialize;
use std::path::Path;

const SEARCH_MAX_FILES: usize = 50;
const SEARCH_MAX_SNIPPETS: usize = 3;
const SEARCH_MAX_LINE_MATCHES: usize = 50;
const SEARCH_SNIPPET_WIDTH: usize = 160;

#[derive(Debug, Serialize)]
pub struct Snippet {
    pub line: usize,
    pub text: String,
    /// [start, length] pairs into `text`, already merged where they overlap.
    pub ranges: Vec<[usize; 2]>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub fs_path: String,
    pub rel_path: String,
    pub title: String,
    pub match_count: usize,
    pub snippets: Vec<Snippet>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherResult {
    pub fs_path: String,
    pub rel_path: String,
    pub title: String,
    pub snippet: String,
}

/// Char-boundary-safe slice of up to `width` chars starting at char `start`.
fn slice_chars(s: &str, start: usize, width: usize) -> String {
    s.chars().skip(start).take(width).collect()
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// Index of `needle` in `haystack` measured in chars, searching from char
/// offset `from`. Ranges are handed to the renderer for `<mark>` insertion, so
/// they have to be char offsets, not byte offsets.
fn char_find(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let chars: Vec<char> = haystack.chars().collect();
    let pat: Vec<char> = needle.chars().collect();
    if pat.is_empty() || pat.len() > chars.len() {
        return None;
    }
    (from..=chars.len() - pat.len()).find(|&i| chars[i..i + pat.len()] == pat[..])
}

fn make_snippet(line: &str, lower: &str, terms: &[String], line_idx: usize) -> Snippet {
    let first_hit = terms
        .iter()
        .filter_map(|t| char_find(lower, t, 0))
        .min()
        .unwrap_or(0);

    let mut start = 0usize;
    let line_len = char_len(line);
    if line_len > SEARCH_SNIPPET_WIDTH {
        let ideal = first_hit.saturating_sub(40);
        start = ideal.min(line_len - SEARCH_SNIPPET_WIDTH);
    }
    let text = slice_chars(line, start, SEARCH_SNIPPET_WIDTH);
    let text_lower = slice_chars(lower, start, SEARCH_SNIPPET_WIDTH);

    let mut ranges: Vec<[usize; 2]> = Vec::new();
    for term in terms {
        let mut idx = 0usize;
        while let Some(found) = char_find(&text_lower, term, idx) {
            ranges.push([found, char_len(term)]);
            idx = found + char_len(term);
        }
    }
    ranges.sort_by_key(|r| r[0]);

    let mut merged: Vec<[usize; 2]> = Vec::new();
    for [s, l] in ranges {
        match merged.last_mut() {
            Some(last) if s <= last[0] + last[1] => {
                last[1] = last[1].max(s + l - last[0]);
            }
            _ => merged.push([s, l]),
        }
    }

    Snippet {
        line: line_idx,
        text,
        ranges: merged,
    }
}

/// A line matches when it contains every whitespace-separated term
/// (case-insensitive). Results are capped and carry highlight ranges.
pub fn search_docs(docs: &[SearchDoc], query: &str, max_results: Option<usize>) -> Vec<SearchResult> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Vec::new();
    }
    let terms: Vec<String> = q
        .to_lowercase()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let max_files = max_results
        .unwrap_or(SEARCH_MAX_FILES)
        .clamp(1, SEARCH_MAX_FILES);

    let mut results: Vec<SearchResult> = Vec::new();
    for doc in docs {
        let mut match_count = 0usize;
        let mut snippets: Vec<Snippet> = Vec::new();
        for (i, line) in doc.lines.iter().enumerate() {
            let lower = line.to_lowercase();
            if !terms.iter().all(|t| lower.contains(t.as_str())) {
                continue;
            }
            match_count += 1;
            if snippets.len() < SEARCH_MAX_SNIPPETS {
                snippets.push(make_snippet(line, &lower, &terms, i));
            }
            if match_count >= SEARCH_MAX_LINE_MATCHES {
                break;
            }
        }
        if match_count > 0 {
            results.push(SearchResult {
                fs_path: doc.fs_path.clone(),
                rel_path: doc.rel_path.clone(),
                title: doc.title.clone(),
                match_count,
                snippets,
            });
        }
    }

    results.sort_by(|a, b| {
        b.match_count
            .cmp(&a.match_count)
            .then_with(|| a.title.cmp(&b.title))
    });
    results.truncate(max_files);
    results
}

/// Launcher-scoped search: title matches first, then a light content scan.
/// Reuses the same in-memory index the main window's search uses.
pub fn launcher_search_docs(docs: &[SearchDoc], query: &str) -> Vec<LauncherResult> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let terms: Vec<String> = q.split_whitespace().map(|s| s.to_string()).collect();

    let mut scored: Vec<(f64, LauncherResult)> = Vec::new();
    for doc in docs {
        let title_lower = doc.title.to_lowercase();
        let title_hit = terms.iter().all(|t| title_lower.contains(t.as_str()));
        let mut body_line = String::new();
        let mut body_hit = false;
        if !title_hit {
            for line in &doc.lines {
                let ll = line.to_lowercase();
                if terms.iter().all(|t| ll.contains(t.as_str())) {
                    body_hit = true;
                    body_line = line.trim().to_string();
                    break;
                }
            }
        }
        if !title_hit && !body_hit {
            continue;
        }
        let score = (if title_hit { 100.0 } else { 0.0 })
            + (if title_lower.starts_with(&q) { 50.0 } else { 0.0 })
            - doc.rel_path.chars().count() as f64 * 0.01;
        scored.push((
            score,
            LauncherResult {
                fs_path: doc.fs_path.clone(),
                rel_path: doc.rel_path.clone(),
                title: doc.title.clone(),
                snippet: if title_hit {
                    String::new()
                } else {
                    body_line.chars().take(120).collect()
                },
            },
        ));
    }

    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.title.cmp(&b.1.title))
    });
    scored.into_iter().take(8).map(|(_, r)| r).collect()
}

/// Notes that link to `file_path`, via [[wiki-links]] or markdown links.
pub fn backlinks(settings: &AppSettings, file_path: &Path) -> Vec<String> {
    let root = settings.root();
    if root.as_os_str().is_empty() {
        return Vec::new();
    }
    let Some(stem) = file_path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
        return Vec::new();
    };
    let Some(full_name) = file_path.file_name().map(|s| s.to_string_lossy().into_owned()) else {
        return Vec::new();
    };

    let wiki_re = match regex::Regex::new(&format!(r"(?i)\[\[{}(\||#|\]\])", regex::escape(&stem))) {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };
    let md_re = match regex::Regex::new(&format!(r"(?i)\(\.*/?.*?{}\)", regex::escape(&full_name))) {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };

    let target = normalize(file_path);
    let mut results: Vec<String> = list_markdown_files(&root, &settings.ignore_set())
        .into_iter()
        .filter(|f| normalize(f) != target)
        .filter(|f| {
            std::fs::read_to_string(f)
                .map(|text| wiki_re.is_match(&text) || md_re.is_match(&text))
                .unwrap_or(false)
        })
        .map(|f| f.to_string_lossy().into_owned())
        .collect();
    results.sort();
    results
}

fn normalize(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(title: &str, lines: &[&str]) -> SearchDoc {
        SearchDoc {
            fs_path: format!("C:\\n\\{title}.md"),
            rel_path: format!("{title}.md"),
            title: title.to_string(),
            lines: lines.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn a_one_character_query_returns_nothing() {
        let docs = vec![doc("a", &["alpha"])];
        assert!(search_docs(&docs, "a", None).is_empty());
    }

    #[test]
    fn every_term_must_appear_on_the_same_line() {
        let docs = vec![doc("note", &["alpha beta", "alpha only", "beta only"])];
        let hits = search_docs(&docs, "alpha beta", None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].match_count, 1);
        assert_eq!(hits[0].snippets[0].line, 0);
    }

    #[test]
    fn results_rank_by_match_count() {
        let docs = vec![
            doc("few", &["term", "nope"]),
            doc("many", &["term", "term", "term"]),
        ];
        let hits = search_docs(&docs, "term", None);
        assert_eq!(hits[0].title, "many");
        assert_eq!(hits[0].match_count, 3);
    }

    #[test]
    fn highlight_ranges_cover_each_occurrence() {
        let docs = vec![doc("n", &["one two one"])];
        let hits = search_docs(&docs, "one", None);
        assert_eq!(hits[0].snippets[0].ranges, vec![[0, 3], [8, 3]]);
    }

    #[test]
    fn overlapping_ranges_are_merged() {
        // "aa" and "aaa" both hit at 0; the merged range must be the longer one
        let docs = vec![doc("n", &["aaa"])];
        let hits = search_docs(&docs, "aa aaa", None);
        assert_eq!(hits[0].snippets[0].ranges, vec![[0, 3]]);
    }

    #[test]
    fn snippets_are_capped_and_windowed_around_the_first_hit() {
        let long = format!("{}NEEDLE{}", "x".repeat(300), "y".repeat(300));
        let docs = vec![doc("n", &[&long])];
        let hits = search_docs(&docs, "needle", None);
        let snip = &hits[0].snippets[0];
        assert_eq!(snip.text.chars().count(), SEARCH_SNIPPET_WIDTH);
        assert!(snip.text.contains("NEEDLE"));
    }

    #[test]
    fn snippet_offsets_are_char_based_not_byte_based() {
        // Without char-based offsets the range would land mid-emoji.
        let docs = vec![doc("n", &["🎉🎉 target"])];
        let hits = search_docs(&docs, "target", None);
        assert_eq!(hits[0].snippets[0].ranges, vec![[3, 6]]);
    }

    #[test]
    fn only_three_snippets_are_returned_but_all_matches_counted() {
        let lines: Vec<&str> = vec!["hit"; 10];
        let docs = vec![doc("n", &lines)];
        let hits = search_docs(&docs, "hit", None);
        assert_eq!(hits[0].match_count, 10);
        assert_eq!(hits[0].snippets.len(), 3);
    }

    #[test]
    fn launcher_puts_title_matches_first() {
        let docs = vec![
            doc("body only", &["kickoff happens here"]),
            doc("kickoff", &["unrelated"]),
        ];
        let hits = launcher_search_docs(&docs, "kickoff");
        assert_eq!(hits[0].title, "kickoff");
        assert!(hits[0].snippet.is_empty());
        assert_eq!(hits[1].title, "body only");
        assert_eq!(hits[1].snippet, "kickoff happens here");
    }

    #[test]
    fn launcher_returns_at_most_eight() {
        let docs: Vec<SearchDoc> = (0..20).map(|i| doc(&format!("hit{i}"), &["x"])).collect();
        assert_eq!(launcher_search_docs(&docs, "hit").len(), 8);
    }
}

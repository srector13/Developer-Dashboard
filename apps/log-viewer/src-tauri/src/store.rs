//! The line buffer, and the merge that makes several files read as one stream.
//!
//! Two decisions carry this module:
//!
//! **The buffer is bounded.** A log viewer pointed at a service that logs
//! 20k lines a second must not grow until the machine swaps. Lines are held in
//! a ring; the oldest fall off the front. What you lose is what has already
//! scrolled past, which is what a file on disk is for.
//!
//! **Ordering is by timestamp, with inheritance.** Two services write to two
//! files with no coordination, so ingest order is not time order. Sorting by
//! the parsed timestamp fixes that — except that the second and subsequent
//! lines of a stack trace have no timestamp of their own, and sorting those to
//! the top of the view is how a multi-file tail becomes unreadable. So an
//! untimestamped line inherits the position of the line above it *from its own
//! source*, which keeps every trace intact and in order.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;

use crate::filter::{Highlighter, Matcher};
use crate::line::LogLine;
use crate::parse::{parse_level, parse_timestamp};

/// How many lines to keep. At an average 120 bytes a line this is roughly
/// 60MB of text, which is a lot of scrollback and a small fraction of what a
/// dev box has.
pub const DEFAULT_CAPACITY: usize = 500_000;

/// One line as the renderer wants it: the parsed line plus which highlight
/// rule claimed it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewLine {
    #[serde(flatten)]
    pub line: LogLine,
    /// The id of the highlight rule that matched, if any.
    pub highlight: Option<String>,
}

/// The answer to one query.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub lines: Vec<ViewLine>,
    /// How many lines matched in total, which may be more than were returned.
    /// The renderer shows this as "showing 2,000 of 41,318".
    pub matched: usize,
    /// How many lines are held in the buffer at all.
    pub total: usize,
    /// True when the oldest lines have been dropped, so the UI can say the
    /// scrollback is not the whole story.
    pub truncated: bool,
}

#[derive(Debug)]
pub struct LineStore {
    lines: VecDeque<LogLine>,
    capacity: usize,
    next_seq: u64,
    /// The last timestamp seen per source, for the inheritance rule.
    last_timestamp: HashMap<String, i64>,
    /// Set once the ring has dropped anything.
    dropped_any: bool,
}

impl Default for LineStore {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }
}

impl LineStore {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            capacity: capacity.max(1),
            next_seq: 0,
            last_timestamp: HashMap::new(),
            dropped_any: false,
        }
    }

    /// The buffer's size. Production reads this through `View::total`, which
    /// every query already carries; this is here for the tests that assert on
    /// it directly.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lines.len()
    }

    /// Add one raw line, parsing it as it lands.
    pub fn push(&mut self, source: &str, text: String) {
        let timestamp = parse_timestamp(&text);
        let level = parse_level(&text);

        // Inheritance: a line with no timestamp of its own takes the position
        // of the previous line from the same source.
        let effective_timestamp = match timestamp {
            Some(ts) => {
                self.last_timestamp.insert(source.to_string(), ts);
                Some(ts)
            }
            None => self.last_timestamp.get(source).copied(),
        };
        let continuation = timestamp.is_none() && effective_timestamp.is_some();

        self.lines.push_back(LogLine {
            seq: self.next_seq,
            source: source.to_string(),
            text,
            timestamp,
            effective_timestamp,
            level,
            continuation,
        });
        self.next_seq += 1;

        while self.lines.len() > self.capacity {
            self.lines.pop_front();
            self.dropped_any = true;
        }
    }

    pub fn extend(&mut self, source: &str, texts: Vec<String>) {
        for text in texts {
            self.push(source, text);
        }
    }

    /// Note that a source rotated, so the view can show the boundary rather
    /// than leaving the reader to guess why the numbering jumped.
    pub fn mark_rotation(&mut self, source: &str) {
        // The marker deliberately carries no timestamp of its own, so it keeps
        // the position of the line it follows instead of jumping to "now".
        self.push(source, "── file rotated ──".to_string());
        // …but it is not a continuation of anything, so unflag it.
        if let Some(last) = self.lines.back_mut() {
            last.continuation = false;
        }
    }

    pub fn clear(&mut self) {
        self.lines.clear();
        self.last_timestamp.clear();
        self.dropped_any = false;
    }

    /// Drop every line from one source, for when a source is removed.
    pub fn clear_source(&mut self, source: &str) {
        self.lines.retain(|line| line.source != source);
        self.last_timestamp.remove(source);
    }

    /// The most recent `limit` lines that match, oldest first.
    ///
    /// Sorting happens only when it can change the answer: with a single
    /// source, ingest order *is* time order, and sorting half a million lines
    /// to reach the same result would be the whole cost of a keystroke.
    pub fn query(&self, matcher: &Matcher, highlighter: &Highlighter, limit: usize) -> View {
        let mut matched: Vec<&LogLine> = if matcher.is_permissive() {
            self.lines.iter().collect()
        } else {
            self.lines.iter().filter(|l| matcher.matches(l)).collect()
        };

        let total_matched = matched.len();

        if self.needs_merge(&matched) {
            // Stable, so lines that share a timestamp — or inherit one, as a
            // stack trace does — keep their ingest order relative to each other.
            matched.sort_by_key(|line| line.effective_timestamp);
        }

        let start = total_matched.saturating_sub(limit);
        let lines = matched[start..]
            .iter()
            .map(|line| ViewLine {
                line: (*line).clone(),
                highlight: if highlighter.is_empty() {
                    None
                } else {
                    highlighter.rule_for(&line.text).map(str::to_string)
                },
            })
            .collect();

        View {
            lines,
            matched: total_matched,
            total: self.lines.len(),
            truncated: self.dropped_any,
        }
    }

    /// The next sequence number that will be handed out. The tail loop records
    /// this before a batch so it can ask for exactly what the batch added.
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// Everything added since `seq`, in timestamp order within the batch.
    ///
    /// This is what follow mode appends. It is deliberately *not* a re-sort of
    /// the whole view: a line that arrives late — a writer that buffered for a
    /// second — lands at the bottom rather than being slotted into the middle
    /// of what someone is already reading. Changing the filter, or pressing
    /// refresh, runs a full `query`, which does order it properly.
    pub fn query_since(
        &self,
        seq: u64,
        matcher: &Matcher,
        highlighter: &Highlighter,
    ) -> Vec<ViewLine> {
        let mut batch: Vec<&LogLine> = self
            .lines
            .iter()
            .rev()
            .take_while(|line| line.seq >= seq)
            .filter(|line| matcher.matches(line))
            .collect();
        batch.reverse();

        if self.needs_merge(&batch) {
            batch.sort_by_key(|line| line.effective_timestamp);
        }
        batch
            .into_iter()
            .map(|line| ViewLine {
                line: line.clone(),
                highlight: if highlighter.is_empty() {
                    None
                } else {
                    highlighter.rule_for(&line.text).map(str::to_string)
                },
            })
            .collect()
    }

    /// Is a merge sort worth doing? Only when more than one source is present
    /// among the matched lines *and* at least one of them can be ordered.
    fn needs_merge(&self, matched: &[&LogLine]) -> bool {
        let mut seen: Option<&str> = None;
        let mut multiple = false;
        let mut any_timestamp = false;

        for line in matched {
            if line.effective_timestamp.is_some() {
                any_timestamp = true;
            }
            match seen {
                None => seen = Some(&line.source),
                Some(first) if first != line.source => multiple = true,
                _ => {}
            }
            if multiple && any_timestamp {
                return true;
            }
        }
        false
    }

    /// Per-source counts, for the source list in the sidebar.
    pub fn counts(&self) -> HashMap<String, usize> {
        let mut counts = HashMap::new();
        for line in &self.lines {
            *counts.entry(line.source.clone()).or_insert(0) += 1;
        }
        counts
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::FilterSpec;
    use crate::line::Level;

    fn view_texts(view: &View) -> Vec<&str> {
        view.lines.iter().map(|l| l.line.text.as_str()).collect()
    }

    fn query(store: &LineStore, spec: &FilterSpec) -> View {
        let matcher = Matcher::build(spec).unwrap();
        store.query(&matcher, &Highlighter::default(), 10_000)
    }

    fn all(store: &LineStore) -> View {
        query(store, &FilterSpec::default())
    }

    #[test]
    fn lines_are_parsed_as_they_land() {
        let mut store = LineStore::default();
        store.push("api", "2024-05-01T12:00:00Z INFO started".into());

        let line = &all(&store).lines[0].line;
        assert_eq!(line.level, Level::Info);
        assert!(line.timestamp.is_some());
        assert_eq!(line.seq, 0);
        assert_eq!(line.source, "api");
    }

    #[test]
    fn the_ring_drops_the_oldest_lines_and_says_so() {
        let mut store = LineStore::with_capacity(3);
        for n in 0..5 {
            store.push("api", format!("line {n}"));
        }
        let view = all(&store);
        assert_eq!(view_texts(&view), vec!["line 2", "line 3", "line 4"]);
        assert!(
            view.truncated,
            "the UI must be able to say scrollback was lost"
        );
        assert_eq!(view.total, 3);
    }

    #[test]
    fn a_fresh_store_is_not_marked_truncated() {
        let mut store = LineStore::with_capacity(10);
        store.push("api", "one".into());
        assert!(!all(&store).truncated);
    }

    #[test]
    fn an_untimestamped_line_inherits_the_position_of_the_one_above_it() {
        let mut store = LineStore::default();
        store.push("api", "2024-05-01T12:00:00Z ERROR boom".into());
        store.push("api", "\tat com.example.App.main(App.java:42)".into());

        let lines = &all(&store).lines;
        assert_eq!(
            lines[0].line.effective_timestamp,
            lines[1].line.effective_timestamp
        );
        assert!(lines[1].line.timestamp.is_none(), "it has none of its own");
        assert!(lines[1].line.continuation, "so the renderer can indent it");
    }

    #[test]
    fn inheritance_does_not_cross_sources() {
        let mut store = LineStore::default();
        store.push("api", "2024-05-01T12:00:00Z INFO up".into());
        // The worker has produced nothing timestamped yet, so this line has
        // nowhere to inherit from — it must not borrow the api's clock.
        store.push("worker", "starting".into());

        let worker = all(&store)
            .lines
            .into_iter()
            .find(|l| l.line.source == "worker")
            .unwrap();
        assert_eq!(worker.line.effective_timestamp, None);
        assert!(!worker.line.continuation);
    }

    #[test]
    fn two_sources_are_merged_into_timestamp_order() {
        let mut store = LineStore::default();
        // Ingested api-then-worker, but the worker line happened first.
        store.push("api", "2024-05-01T12:00:05Z INFO api second".into());
        store.push("worker", "2024-05-01T12:00:01Z INFO worker first".into());

        let view = all(&store);
        assert_eq!(
            view_texts(&view),
            vec![
                "2024-05-01T12:00:01Z INFO worker first",
                "2024-05-01T12:00:05Z INFO api second"
            ]
        );
    }

    #[test]
    fn a_merged_view_keeps_each_stack_trace_together() {
        // The failure mode this whole module exists to avoid: the trace's
        // continuation lines sorting away from the line that threw.
        let mut store = LineStore::default();
        store.push("api", "2024-05-01T12:00:05Z ERROR boom".into());
        store.push("api", "\tat com.example.A".into());
        store.push("api", "\tat com.example.B".into());
        store.push("worker", "2024-05-01T12:00:01Z INFO earlier".into());
        store.push("worker", "2024-05-01T12:00:09Z INFO later".into());

        assert_eq!(
            view_texts(&all(&store)),
            vec![
                "2024-05-01T12:00:01Z INFO earlier",
                "2024-05-01T12:00:05Z ERROR boom",
                "\tat com.example.A",
                "\tat com.example.B",
                "2024-05-01T12:00:09Z INFO later",
            ]
        );
    }

    #[test]
    fn a_single_source_keeps_ingest_order_even_when_its_clock_jumps_backwards() {
        // One file is already in the order it was written. Re-sorting it by a
        // timestamp the writer got wrong would scramble it for no gain.
        let mut store = LineStore::default();
        store.push("api", "2024-05-01T12:00:05Z INFO first written".into());
        store.push("api", "2024-05-01T12:00:01Z INFO second written".into());

        assert_eq!(
            view_texts(&all(&store)),
            vec![
                "2024-05-01T12:00:05Z INFO first written",
                "2024-05-01T12:00:01Z INFO second written",
            ]
        );
    }

    #[test]
    fn sources_with_no_timestamps_at_all_stay_in_ingest_order() {
        let mut store = LineStore::default();
        store.push("a", "alpha".into());
        store.push("b", "bravo".into());
        store.push("a", "charlie".into());
        assert_eq!(view_texts(&all(&store)), vec!["alpha", "bravo", "charlie"]);
    }

    #[test]
    fn the_limit_returns_the_newest_lines_not_the_oldest() {
        let mut store = LineStore::default();
        for n in 0..10 {
            store.push("api", format!("line {n}"));
        }
        let view = store.query(&Matcher::permissive(), &Highlighter::default(), 3);
        assert_eq!(view_texts(&view), vec!["line 7", "line 8", "line 9"]);
        assert_eq!(view.matched, 10, "the count is of everything that matched");
    }

    #[test]
    fn filtering_reports_how_many_matched_beyond_what_it_returned() {
        let mut store = LineStore::default();
        for n in 0..100 {
            store.push("api", format!("line {n} ERROR"));
            store.push("api", format!("line {n} INFO"));
        }
        let matcher = Matcher::build(&FilterSpec {
            query: "ERROR".into(),
            ..Default::default()
        })
        .unwrap();
        let view = store.query(&matcher, &Highlighter::default(), 10);
        assert_eq!(view.lines.len(), 10);
        assert_eq!(view.matched, 100);
        assert_eq!(view.total, 200);
    }

    #[test]
    fn highlights_are_attached_to_the_lines_they_claim() {
        use crate::filter::HighlightRule;

        let mut store = LineStore::default();
        store.push("api", "connection timeout".into());
        store.push("api", "all good".into());

        let highlighter = Highlighter::build(&[HighlightRule {
            id: "warn".into(),
            name: "Timeouts".into(),
            pattern: "timeout".into(),
            colour: "amber".into(),
            enabled: true,
            ..Default::default()
        }]);
        let view = store.query(&Matcher::permissive(), &highlighter, 100);
        assert_eq!(view.lines[0].highlight.as_deref(), Some("warn"));
        assert_eq!(view.lines[1].highlight, None);
    }

    #[test]
    fn a_rotation_marker_sits_where_the_rotation_happened() {
        let mut store = LineStore::default();
        store.push("api", "2024-05-01T12:00:00Z INFO before".into());
        store.mark_rotation("api");
        store.push("api", "2024-05-01T12:00:10Z INFO after".into());

        let view = all(&store);
        assert_eq!(view_texts(&view)[1], "── file rotated ──");
        // It inherits the previous line's position, so it cannot sort to "now".
        let marker = &view.lines[1].line;
        assert!(!marker.continuation);
        assert_eq!(
            marker.effective_timestamp,
            view.lines[0].line.effective_timestamp
        );
    }

    #[test]
    fn clearing_one_source_leaves_the_others_alone() {
        let mut store = LineStore::default();
        store.push("api", "api line".into());
        store.push("worker", "worker line".into());
        store.clear_source("api");

        assert_eq!(view_texts(&all(&store)), vec!["worker line"]);
    }

    #[test]
    fn counts_are_reported_per_source() {
        let mut store = LineStore::default();
        store.push("api", "one".into());
        store.push("api", "two".into());
        store.push("worker", "three".into());

        let counts = store.counts();
        assert_eq!(counts["api"], 2);
        assert_eq!(counts["worker"], 1);
    }

    #[test]
    fn clearing_resets_the_inheritance_so_a_new_stream_starts_clean() {
        let mut store = LineStore::default();
        store.push("api", "2024-05-01T12:00:00Z INFO up".into());
        store.clear();
        store.push("api", "no timestamp here".into());

        let line = &all(&store).lines[0].line;
        assert_eq!(line.effective_timestamp, None);
    }

    #[test]
    fn asking_for_lines_since_a_mark_returns_only_the_new_ones() {
        let mut store = LineStore::default();
        store.push("api", "old".into());
        let mark = store.next_seq();
        store.push("api", "new one".into());
        store.push("api", "new two".into());

        let batch = store.query_since(mark, &Matcher::permissive(), &Highlighter::default());
        let texts: Vec<&str> = batch.iter().map(|l| l.line.text.as_str()).collect();
        assert_eq!(texts, vec!["new one", "new two"]);
    }

    #[test]
    fn a_batch_from_two_sources_is_ordered_within_itself() {
        let mut store = LineStore::default();
        let mark = store.next_seq();
        store.push("api", "2024-05-01T12:00:05Z INFO later".into());
        store.push("worker", "2024-05-01T12:00:01Z INFO earlier".into());

        let batch = store.query_since(mark, &Matcher::permissive(), &Highlighter::default());
        let texts: Vec<&str> = batch.iter().map(|l| l.line.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "2024-05-01T12:00:01Z INFO earlier",
                "2024-05-01T12:00:05Z INFO later"
            ]
        );
    }

    #[test]
    fn a_batch_respects_the_active_filter() {
        let mut store = LineStore::default();
        let mark = store.next_seq();
        store.push("api", "INFO fine".into());
        store.push("api", "ERROR boom".into());

        let matcher = Matcher::build(&FilterSpec {
            query: "ERROR".into(),
            ..Default::default()
        })
        .unwrap();
        let batch = store.query_since(mark, &matcher, &Highlighter::default());
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].line.text, "ERROR boom");
    }

    #[test]
    fn asking_since_the_current_mark_returns_nothing() {
        let mut store = LineStore::default();
        store.push("api", "one".into());
        let mark = store.next_seq();
        assert!(store
            .query_since(mark, &Matcher::permissive(), &Highlighter::default())
            .is_empty());
    }

    #[test]
    fn sequence_numbers_keep_rising_across_a_clear() {
        // They are the tie-break for the sort; reusing them after a clear
        // would make the order depend on history that no longer exists.
        let mut store = LineStore::default();
        store.push("api", "one".into());
        store.clear();
        store.push("api", "two".into());
        assert_eq!(all(&store).lines[0].line.seq, 1);
    }
}

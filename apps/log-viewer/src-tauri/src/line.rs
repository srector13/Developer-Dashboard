//! What one line of a log is, once it has been read.
//!
//! Everything downstream — filtering, merging, rendering — works on this
//! struct, so the parsing happens exactly once, at ingest, rather than every
//! time someone types in the filter box.

use serde::{Deserialize, Serialize};

/// Severity, ordered so a "show me warnings and worse" filter is a comparison.
///
/// `Unknown` sorts *below* `Trace` deliberately: a line whose level could not
/// be read is not evidence of severity, and hiding it whenever a floor is set
/// is the behaviour that loses stack traces. See `Level::passes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    #[default]
    Unknown,
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl Level {
    /// Does this line survive a `min` floor?
    ///
    /// An unparsed level always passes. A log viewer that swallows the
    /// continuation lines of a stack trace because they have no level token on
    /// them is worse than one with no level filter at all — the one time you
    /// filter to `error` is the one time you need the whole trace.
    pub fn passes(self, min: Level) -> bool {
        self == Level::Unknown || self >= min
    }

    pub fn parse(token: &str) -> Option<Level> {
        // Case-insensitive without allocating: log lines arrive by the hundred
        // thousand and this runs on every one of them.
        Some(match token {
            t if t.eq_ignore_ascii_case("trace") || t.eq_ignore_ascii_case("verbose") => {
                Level::Trace
            }
            t if t.eq_ignore_ascii_case("debug") || t.eq_ignore_ascii_case("fine") => Level::Debug,
            t if t.eq_ignore_ascii_case("info") || t.eq_ignore_ascii_case("notice") => Level::Info,
            t if t.eq_ignore_ascii_case("warn") || t.eq_ignore_ascii_case("warning") => Level::Warn,
            t if t.eq_ignore_ascii_case("error") || t.eq_ignore_ascii_case("severe") => {
                Level::Error
            }
            t if t.eq_ignore_ascii_case("fatal") || t.eq_ignore_ascii_case("critical") => {
                Level::Fatal
            }
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Monotonic across every source, assigned at ingest. This is the tie-break
    /// that keeps the merged view stable when two lines share a timestamp.
    pub seq: u64,
    /// Which source this came from.
    pub source: String,
    pub text: String,
    /// Milliseconds since the epoch, if the line carried a timestamp.
    pub timestamp: Option<i64>,
    /// The timestamp used for ordering: this line's own, or the last one seen
    /// from the same source. A stack trace has no timestamp on lines 2..n, and
    /// sorting those to the top of the merged view is the classic way to make a
    /// multi-file tail useless.
    pub effective_timestamp: Option<i64>,
    pub level: Level,
    /// True when the line inherited its ordering timestamp from the line above
    /// it — i.e. it is a continuation. The renderer indents these.
    pub continuation: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_order_from_least_to_most_severe() {
        assert!(Level::Error > Level::Warn);
        assert!(Level::Warn > Level::Info);
        assert!(Level::Fatal > Level::Error);
    }

    #[test]
    fn a_floor_keeps_everything_at_or_above_it() {
        assert!(Level::Error.passes(Level::Warn));
        assert!(Level::Warn.passes(Level::Warn));
        assert!(!Level::Info.passes(Level::Warn));
    }

    #[test]
    fn an_unparsed_level_always_passes_so_stack_traces_survive_a_filter() {
        // The continuation lines of a Java stack trace carry no level token.
        // Filtering to `error` must not be what hides the trace itself.
        assert!(Level::Unknown.passes(Level::Fatal));
        assert!(Level::Unknown.passes(Level::Warn));
    }

    #[test]
    fn level_tokens_are_matched_case_insensitively_with_their_synonyms() {
        assert_eq!(Level::parse("ERROR"), Some(Level::Error));
        assert_eq!(Level::parse("error"), Some(Level::Error));
        assert_eq!(Level::parse("Severe"), Some(Level::Error));
        assert_eq!(Level::parse("WARNING"), Some(Level::Warn));
        assert_eq!(Level::parse("verbose"), Some(Level::Trace));
        assert_eq!(Level::parse("critical"), Some(Level::Fatal));
    }

    #[test]
    fn a_word_that_is_not_a_level_is_none_rather_than_a_guess() {
        assert_eq!(Level::parse("starting"), None);
        assert_eq!(Level::parse(""), None);
    }

    #[test]
    fn levels_serialize_lowercase_for_the_renderer() {
        assert_eq!(
            serde_json::to_value(Level::Warn).unwrap(),
            serde_json::json!("warn")
        );
    }
}

//! Deciding which lines are shown, and which of the shown ones are coloured.
//!
//! A filter is compiled once and applied to every line, so an invalid regex is
//! caught at compile time and reported to the user rather than quietly matching
//! nothing — "my filter shows no lines" and "my filter is broken" look
//! identical from the outside, and only one of them is worth telling someone
//! about.

use serde::{Deserialize, Serialize};

use crate::line::{Level, LogLine};

/// What the filter bar holds. Serialisable because a saved filter is exactly
/// this, written to the config file under a name.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSpec {
    /// Lines must match this to be shown. Empty shows everything.
    #[serde(default)]
    pub query: String,
    /// Lines matching this are hidden, even if they matched `query`. This is
    /// the one that does the real work during an incident — a health-check
    /// endpoint logging every second buries everything else.
    #[serde(default)]
    pub exclude: String,
    /// Treat `query` and `exclude` as regular expressions.
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    /// Hide anything below this level. Lines with no level always pass — see
    /// `Level::passes`.
    #[serde(default)]
    pub min_level: Level,
    /// Source ids to include. Empty means every source.
    #[serde(default)]
    pub sources: Vec<String>,
    /// Show only the last N minutes. Zero means the whole buffer.
    ///
    /// The window counts back from the newest line the viewer holds rather than
    /// from the wall clock — see `Matcher::build_at`.
    #[serde(default)]
    pub since_mins: u64,
}

/// A named, saved `FilterSpec`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFilter {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub spec: FilterSpec,
}

/// A colouring rule. Unlike a filter, a highlight never hides anything — it
/// marks lines you want to spot while scrolling past everything else.
/// `Default` is hand-written so `enabled` matches its `serde(default)` — see
/// the note on `settings::LogSource`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    /// A token from the renderer's fixed palette — never a raw colour, which
    /// would reach a style attribute straight from a config file.
    #[serde(default)]
    pub colour: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Default for HighlightRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            pattern: String::new(),
            regex: false,
            case_sensitive: false,
            colour: String::new(),
            enabled: true,
        }
    }
}

/// A compiled pattern. Substring matching is the default because it is what
/// people type, and it is markedly faster than a regex for the same intent.
#[derive(Debug)]
enum Pattern {
    /// Pre-lowercased needle, matched against a lowercased haystack.
    Insensitive(String),
    Sensitive(String),
    Regex(regex::Regex),
}

impl Pattern {
    fn build(pattern: &str, regex: bool, case_sensitive: bool) -> Result<Option<Self>, String> {
        if pattern.is_empty() {
            return Ok(None);
        }
        if regex {
            let compiled = regex::RegexBuilder::new(pattern)
                .case_insensitive(!case_sensitive)
                .size_limit(1 << 20)
                .build()
                .map_err(|e| first_line(&e.to_string()))?;
            return Ok(Some(Pattern::Regex(compiled)));
        }
        Ok(Some(if case_sensitive {
            Pattern::Sensitive(pattern.to_string())
        } else {
            Pattern::Insensitive(pattern.to_lowercase())
        }))
    }

    fn matches(&self, text: &str) -> bool {
        match self {
            Pattern::Sensitive(needle) => text.contains(needle.as_str()),
            // `to_lowercase` allocates per line. It is still cheaper than a
            // case-insensitive regex, and this is the default path.
            Pattern::Insensitive(needle) => text.to_lowercase().contains(needle.as_str()),
            Pattern::Regex(regex) => regex.is_match(text),
        }
    }
}

/// A regex error is several lines of caret-diagram; the filter bar has room
/// for one. The first line is the part that names the problem.
fn first_line(message: &str) -> String {
    message
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("invalid pattern")
        .trim()
        .to_string()
}

/// Wall clock in epoch milliseconds — the fallback anchor for an interval when
/// nothing in the buffer carries a timestamp.
pub fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A `FilterSpec` compiled and ready to run.
#[derive(Debug)]
pub struct Matcher {
    include: Option<Pattern>,
    exclude: Option<Pattern>,
    min_level: Level,
    sources: Vec<String>,
    /// Lines older than this are hidden. `None` when no interval is set.
    since: Option<i64>,
}

impl Matcher {
    /// Compile a spec, counting any interval back from the wall clock.
    ///
    /// Every production path anchors to the buffer instead — see
    /// `commands::matcher_for` — so this is the tests' entry point, where "now"
    /// is the only anchor there is.
    #[cfg(test)]
    pub fn build(spec: &FilterSpec) -> Result<Self, String> {
        Self::build_at(spec, now_millis())
    }

    /// Compile a spec, counting any interval back from `anchor`.
    ///
    /// The anchor is the newest line the viewer holds, not `now`. Anchoring to
    /// the wall clock is the obvious choice and the wrong one: a service that
    /// stopped an hour ago has a perfectly good log, and "last 15 minutes"
    /// against the wall clock empties the window with no explanation. Counting
    /// back from the newest line means the interval always shows the *end* of
    /// the log, which is what someone asking for it wants.
    ///
    /// `commands::matcher_for` supplies the anchor from the store; callers with
    /// no store — and the tests — use `build`.
    pub fn build_at(spec: &FilterSpec, anchor: i64) -> Result<Self, String> {
        Ok(Self {
            include: Pattern::build(&spec.query, spec.regex, spec.case_sensitive)
                .map_err(|e| format!("Filter: {e}"))?,
            exclude: Pattern::build(&spec.exclude, spec.regex, spec.case_sensitive)
                .map_err(|e| format!("Exclude: {e}"))?,
            min_level: spec.min_level,
            sources: spec.sources.clone(),
            // Saturating the whole way down. `sinceMins` can come from a saved
            // filter in the config file, so it can be any u64 at all, and a
            // naive cast turns a large one negative — which lands the floor in
            // the future and hides the entire log.
            since: (spec.since_mins > 0).then(|| {
                let back = spec.since_mins.saturating_mul(60_000).min(i64::MAX as u64) as i64;
                anchor.saturating_sub(back)
            }),
        })
    }

    /// An empty spec. Production always builds from a real `FilterSpec`, even
    /// an empty one, so this exists for the tests that would otherwise repeat
    /// `Matcher::build(&FilterSpec::default()).unwrap()` on every line.
    #[cfg(test)]
    pub fn permissive() -> Self {
        Self {
            include: None,
            exclude: None,
            min_level: Level::Unknown,
            sources: Vec::new(),
            since: None,
        }
    }

    pub fn matches(&self, line: &LogLine) -> bool {
        if !self.sources.is_empty() && !self.sources.contains(&line.source) {
            return false;
        }
        if !line.level.passes(self.min_level) {
            return false;
        }
        if let Some(floor) = self.since {
            // A line the parser could place in time is judged on that. One it
            // could not is kept, for the same reason `Level::Unknown` passes
            // every floor: an interval must not be what silently swallows a
            // stack trace, or a whole log that simply has no timestamps in it.
            if line.effective_timestamp.is_some_and(|ts| ts < floor) {
                return false;
            }
        }
        if let Some(exclude) = &self.exclude {
            if exclude.matches(&line.text) {
                return false;
            }
        }
        match &self.include {
            Some(include) => include.matches(&line.text),
            None => true,
        }
    }

    /// True when nothing is filtered at all, which lets the store skip the
    /// per-line work entirely on first paint.
    pub fn is_permissive(&self) -> bool {
        self.include.is_none()
            && self.exclude.is_none()
            && self.sources.is_empty()
            && self.min_level == Level::Unknown
            && self.since.is_none()
    }
}

/// Compile a pattern only to find out whether it compiles.
///
/// The highlight editor calls this on every keystroke: a rule with a broken
/// regex is skipped by `Highlighter::build` and simply colours nothing, which
/// is indistinguishable from a rule that matches nothing. Saying so while the
/// pattern is being typed is the only place that distinction can be made.
pub fn check_pattern(pattern: &str, regex: bool, case_sensitive: bool) -> Result<(), String> {
    Pattern::build(pattern, regex, case_sensitive).map(|_| ())
}

/// The compiled highlight rules, in the order they were configured.
#[derive(Debug, Default)]
pub struct Highlighter {
    rules: Vec<(String, Pattern)>,
}

impl Highlighter {
    /// Build from the configured rules, skipping any that are switched off or
    /// fail to compile. A broken highlight rule must not stop the other rules
    /// from working — unlike a filter, it hides nothing, so failing quietly
    /// here costs colour rather than data.
    pub fn build(rules: &[HighlightRule]) -> Self {
        let compiled = rules
            .iter()
            .filter(|rule| rule.enabled)
            .filter_map(|rule| {
                Pattern::build(&rule.pattern, rule.regex, rule.case_sensitive)
                    .ok()
                    .flatten()
                    .map(|pattern| (rule.id.clone(), pattern))
            })
            .collect();
        Self { rules: compiled }
    }

    /// The id of the first rule that matches, if any. First rather than most
    /// specific: the rules are an ordered list the user controls, so "move it
    /// up" is the way to change which one wins.
    pub fn rule_for(&self, text: &str) -> Option<&str> {
        self.rules
            .iter()
            .find(|(_, pattern)| pattern.matches(text))
            .map(|(id, _)| id.as_str())
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, level: Level, source: &str) -> LogLine {
        LogLine {
            seq: 0,
            source: source.into(),
            text: text.into(),
            timestamp: None,
            effective_timestamp: None,
            level,
            continuation: false,
        }
    }

    fn spec(query: &str) -> FilterSpec {
        FilterSpec {
            query: query.into(),
            ..Default::default()
        }
    }

    #[test]
    fn an_empty_filter_shows_everything() {
        let matcher = Matcher::build(&FilterSpec::default()).unwrap();
        assert!(matcher.is_permissive());
        assert!(matcher.matches(&line("anything at all", Level::Trace, "a")));
    }

    #[test]
    fn substring_matching_is_case_insensitive_by_default() {
        let matcher = Matcher::build(&spec("timeout")).unwrap();
        assert!(matcher.matches(&line("Read TIMEOUT after 30s", Level::Warn, "a")));
        assert!(!matcher.matches(&line("all good", Level::Info, "a")));
    }

    #[test]
    fn case_sensitivity_can_be_asked_for() {
        let matcher = Matcher::build(&FilterSpec {
            query: "ERROR".into(),
            case_sensitive: true,
            ..Default::default()
        })
        .unwrap();
        assert!(matcher.matches(&line("ERROR boom", Level::Error, "a")));
        assert!(!matcher.matches(&line("error boom", Level::Error, "a")));
    }

    #[test]
    fn an_exclude_wins_over_a_match() {
        // The classic: everything from the payments service except the
        // health-check line that fires every second.
        let matcher = Matcher::build(&FilterSpec {
            query: "payments".into(),
            exclude: "/health".into(),
            ..Default::default()
        })
        .unwrap();
        assert!(matcher.matches(&line("payments POST /charge 201", Level::Info, "a")));
        assert!(!matcher.matches(&line("payments GET /health 200", Level::Info, "a")));
    }

    #[test]
    fn an_exclude_on_its_own_hides_only_what_it_names() {
        let matcher = Matcher::build(&FilterSpec {
            exclude: "heartbeat".into(),
            ..Default::default()
        })
        .unwrap();
        assert!(matcher.matches(&line("starting up", Level::Info, "a")));
        assert!(!matcher.matches(&line("heartbeat ok", Level::Debug, "a")));
    }

    #[test]
    fn a_level_floor_keeps_unparsed_lines_so_a_stack_trace_survives() {
        let matcher = Matcher::build(&FilterSpec {
            min_level: Level::Error,
            ..Default::default()
        })
        .unwrap();
        assert!(matcher.matches(&line("ERROR boom", Level::Error, "a")));
        assert!(!matcher.matches(&line("INFO fine", Level::Info, "a")));
        assert!(
            matcher.matches(&line("\tat com.example.App.main", Level::Unknown, "a")),
            "the continuation lines of the trace must come with it"
        );
    }

    #[test]
    fn naming_sources_restricts_to_them() {
        let matcher = Matcher::build(&FilterSpec {
            sources: vec!["api".into(), "worker".into()],
            ..Default::default()
        })
        .unwrap();
        assert!(matcher.matches(&line("x", Level::Info, "api")));
        assert!(matcher.matches(&line("x", Level::Info, "worker")));
        assert!(!matcher.matches(&line("x", Level::Info, "nginx")));
    }

    #[test]
    fn a_regex_filter_matches_as_a_pattern_rather_than_a_literal() {
        let matcher = Matcher::build(&FilterSpec {
            query: r#"HTTP/1\.[01]" 5\d\d"#.into(),
            regex: true,
            ..Default::default()
        })
        .unwrap();
        assert!(matcher.matches(&line(r#"GET / HTTP/1.1" 503 -"#, Level::Unknown, "a")));
        assert!(!matcher.matches(&line(r#"GET / HTTP/1.1" 200 -"#, Level::Unknown, "a")));
    }

    #[test]
    fn an_invalid_regex_is_reported_rather_than_matching_nothing() {
        let error = Matcher::build(&FilterSpec {
            query: "unclosed(".into(),
            regex: true,
            ..Default::default()
        })
        .expect_err("an unbalanced paren must not compile");
        assert!(error.starts_with("Filter: "), "got {error:?}");
        // One line, so the filter bar can show it.
        assert_eq!(error.lines().count(), 1);
    }

    #[test]
    fn an_invalid_exclude_is_reported_as_the_exclude() {
        let error = Matcher::build(&FilterSpec {
            exclude: "*nope".into(),
            regex: true,
            ..Default::default()
        })
        .expect_err("a leading repeat must not compile");
        assert!(error.starts_with("Exclude: "), "got {error:?}");
    }

    // --- intervals

    /// A line at a known moment, so the interval tests read as clock arithmetic.
    fn at(millis: i64) -> LogLine {
        LogLine {
            effective_timestamp: Some(millis),
            timestamp: Some(millis),
            ..line("some text", Level::Info, "a")
        }
    }

    const NOON: i64 = 1_714_564_800_000;
    const MINUTE: i64 = 60_000;

    #[test]
    fn an_interval_hides_everything_older_than_it() {
        let matcher = Matcher::build_at(
            &FilterSpec {
                since_mins: 15,
                ..Default::default()
            },
            NOON,
        )
        .unwrap();

        assert!(matcher.matches(&at(NOON)));
        assert!(matcher.matches(&at(NOON - 14 * MINUTE)));
        assert!(!matcher.matches(&at(NOON - 16 * MINUTE)));
    }

    #[test]
    fn no_interval_shows_the_whole_buffer() {
        let matcher = Matcher::build(&FilterSpec::default()).unwrap();
        assert!(matcher.is_permissive());
        assert!(matcher.matches(&at(0)), "1970 is still in the log");
    }

    #[test]
    fn an_interval_stops_the_filter_being_permissive() {
        // Otherwise the store's fast path would skip the per-line check and
        // hand back everything.
        let matcher = Matcher::build(&FilterSpec {
            since_mins: 5,
            ..Default::default()
        })
        .unwrap();
        assert!(!matcher.is_permissive());
    }

    #[test]
    fn an_interval_keeps_lines_that_could_not_be_placed_in_time() {
        // A log with no timestamps at all, or the trailing lines of a trace
        // before the first timestamped line: an interval must not be the thing
        // that empties the window.
        let matcher = Matcher::build_at(
            &FilterSpec {
                since_mins: 5,
                ..Default::default()
            },
            NOON,
        )
        .unwrap();
        assert!(matcher.matches(&line("no clock on this one", Level::Info, "a")));
    }

    #[test]
    fn the_interval_counts_back_from_the_anchor_not_from_now() {
        // The whole point: a service that stopped yesterday still shows its
        // last 15 minutes, rather than nothing at all.
        let yesterday = now_millis() - 24 * 60 * MINUTE;
        let matcher = Matcher::build_at(
            &FilterSpec {
                since_mins: 15,
                ..Default::default()
            },
            yesterday,
        )
        .unwrap();
        assert!(matcher.matches(&at(yesterday - 5 * MINUTE)));
        assert!(!matcher.matches(&at(yesterday - 30 * MINUTE)));
    }

    #[test]
    fn an_absurd_interval_does_not_overflow_into_the_future() {
        // `sinceMins` arrives from a config file, so it can be anything.
        let matcher = Matcher::build_at(
            &FilterSpec {
                since_mins: u64::MAX,
                ..Default::default()
            },
            NOON,
        )
        .unwrap();
        assert!(matcher.matches(&at(NOON)));
    }

    #[test]
    fn checking_a_pattern_reports_what_the_highlight_editor_needs_to_say() {
        assert!(check_pattern(r"\b(ERROR|FATAL)\b", true, false).is_ok());
        assert!(
            check_pattern("unclosed(", false, false).is_ok(),
            "a literal"
        );
        assert!(check_pattern("unclosed(", true, false).is_err());
        assert!(check_pattern("", true, false).is_ok(), "empty matches all");
    }

    #[test]
    fn a_literal_paren_is_fine_when_regex_is_off() {
        let matcher = Matcher::build(&spec("shutdown(")).unwrap();
        assert!(matcher.matches(&line("calling shutdown() now", Level::Info, "a")));
    }

    // --- highlights

    fn rule(id: &str, pattern: &str) -> HighlightRule {
        HighlightRule {
            id: id.into(),
            name: id.into(),
            pattern: pattern.into(),
            regex: false,
            case_sensitive: false,
            colour: "red".into(),
            enabled: true,
        }
    }

    #[test]
    fn the_first_matching_rule_wins() {
        let highlighter = Highlighter::build(&[rule("a", "timeout"), rule("b", "connection")]);
        assert_eq!(
            highlighter.rule_for("connection timeout after 30s"),
            Some("a"),
            "order in the list decides, not position in the text"
        );
    }

    #[test]
    fn a_disabled_rule_does_not_colour_anything() {
        let mut off = rule("a", "timeout");
        off.enabled = false;
        let highlighter = Highlighter::build(&[off]);
        assert!(highlighter.is_empty());
        assert_eq!(highlighter.rule_for("timeout"), None);
    }

    #[test]
    fn a_rule_that_does_not_compile_is_skipped_and_the_others_still_work() {
        let mut broken = rule("broken", "unclosed(");
        broken.regex = true;
        let highlighter = Highlighter::build(&[broken, rule("good", "boom")]);
        assert_eq!(highlighter.rule_for("boom"), Some("good"));
    }

    #[test]
    fn a_line_matching_no_rule_is_not_coloured() {
        let highlighter = Highlighter::build(&[rule("a", "timeout")]);
        assert_eq!(highlighter.rule_for("everything is fine"), None);
    }

    #[test]
    fn a_saved_filter_serializes_its_spec_flat_so_the_file_reads_well() {
        let saved = SavedFilter {
            id: "errors".into(),
            name: "Errors only".into(),
            spec: FilterSpec {
                min_level: Level::Error,
                ..Default::default()
            },
        };
        let json = serde_json::to_value(&saved).unwrap();
        assert_eq!(json["name"], "Errors only");
        assert_eq!(json["minLevel"], "error");
        assert!(json.get("spec").is_none(), "the spec is flattened");
    }
}

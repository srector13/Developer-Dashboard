//! Pulling a timestamp and a level out of a line of text.
//!
//! This runs on every line of every file, so it is a hand-rolled scanner
//! rather than a set of regexes — at a hundred thousand lines a second the
//! difference is the whole reason the app feels instant when you point it at a
//! 400MB file.
//!
//! It recognises the formats that actually turn up in a full-stack Java/JS
//! shop, and nothing else:
//!
//! ```text
//! 2024-05-01T12:34:56.789Z        ISO-8601, with or without a zone
//! 2024-05-01T12:34:56.789+01:00
//! 2024-05-01 12:34:56,789         logback / log4j default
//! 2024/05/01 12:34:56
//! 12:34:56.789                    bare time — see `parse_timestamp`
//! ```
//!
//! Anything else yields `None`, and a line with no timestamp is not a
//! problem — `store` gives it the ordering position of the line above it.

use chrono::{Local, NaiveDate, NaiveTime, TimeZone};

use crate::line::Level;

/// How far into a line to look for a level token.
///
/// Long enough to clear a timestamp, a thread name and a fully-qualified
/// logger (`… [http-nio-8080-exec-3] ERROR c.e.PaymentService -`), short
/// enough that the word "error" in the middle of a long message is not
/// mistaken for the line's severity.
const LEVEL_SCAN_LIMIT: usize = 200;

/// Read the level from a line, if it announces one.
///
/// The first token in the scanned prefix that names a level wins. Where a
/// message and a real level both appear, the real one is to the left of it in
/// every logging format worth supporting, so "first" is the right rule.
pub fn parse_level(line: &str) -> Level {
    let mut token_start: Option<usize> = None;
    // Tracked rather than computed, because the scan limit is a byte count and
    // slicing a `str` at an arbitrary byte offset panics on a multi-byte
    // character. Log files are full of them — a stack trace with an arrow, a
    // message in any language but English.
    let mut scanned_end = 0usize;

    for (index, ch) in line.char_indices() {
        if index >= LEVEL_SCAN_LIMIT {
            break;
        }
        scanned_end = index + ch.len_utf8();

        if ch.is_ascii_alphabetic() {
            token_start.get_or_insert(index);
            continue;
        }
        if let Some(start) = token_start.take() {
            if let Some(level) = Level::parse(&line[start..index]) {
                return level;
            }
        }
    }
    // A token running to the end of the scanned window.
    if let Some(start) = token_start {
        if let Some(level) = Level::parse(&line[start..scanned_end]) {
            return level;
        }
    }
    Level::Unknown
}

/// Read a timestamp from the start of a line, as milliseconds since the epoch.
///
/// A bare time with no date (`12:34:56.789 [main] INFO …`) is resolved against
/// *today's local date*. That is a guess, but it is the only useful one: those
/// lines come from a process running now, and the alternative — refusing to
/// order them — makes a merged tail of two such files meaningless.
pub fn parse_timestamp(line: &str) -> Option<i64> {
    let bytes = line.as_bytes();
    let mut at = 0;
    // Skip leading whitespace and one opening bracket, which is where a good
    // number of formats put the timestamp: `[2024-05-01 12:34:56] …`.
    while at < bytes.len() && (bytes[at] == b' ' || bytes[at] == b'\t') {
        at += 1;
    }
    if at < bytes.len() && (bytes[at] == b'[' || bytes[at] == b'(') {
        at += 1;
    }

    match parse_date(bytes, at) {
        Some((date, next)) => {
            // A date must be followed by `T` or a space, then a time.
            let next = match bytes.get(next) {
                Some(b'T') | Some(b't') | Some(b' ') => next + 1,
                _ => return None,
            };
            let (time, next) = parse_time(bytes, next)?;
            let naive = date.and_time(time);
            match parse_offset(bytes, next) {
                Some(offset) => Some(
                    chrono::FixedOffset::east_opt(offset)?
                        .from_local_datetime(&naive)
                        .earliest()?
                        .timestamp_millis(),
                ),
                None => Some(
                    Local
                        .from_local_datetime(&naive)
                        .earliest()?
                        .timestamp_millis(),
                ),
            }
        }
        None => {
            let (time, _) = parse_time(bytes, at)?;
            let today = Local::now().date_naive();
            Local
                .from_local_datetime(&today.and_time(time))
                .earliest()
                .map(|dt| dt.timestamp_millis())
        }
    }
}

/// `YYYY-MM-DD` or `YYYY/MM/DD`, returning the date and the index after it.
fn parse_date(bytes: &[u8], at: usize) -> Option<(NaiveDate, usize)> {
    let year = digits(bytes, at, 4)?;
    let separator = *bytes.get(at + 4)?;
    if separator != b'-' && separator != b'/' {
        return None;
    }
    let month = digits(bytes, at + 5, 2)?;
    if *bytes.get(at + 7)? != separator {
        return None;
    }
    let day = digits(bytes, at + 8, 2)?;
    let date = NaiveDate::from_ymd_opt(year as i32, month, day)?;
    Some((date, at + 10))
}

/// `HH:MM:SS` with an optional `.mmm` or `,mmm` fraction, returning the time
/// and the index after it.
fn parse_time(bytes: &[u8], at: usize) -> Option<(NaiveTime, usize)> {
    let hour = digits(bytes, at, 2)?;
    if *bytes.get(at + 2)? != b':' {
        return None;
    }
    let minute = digits(bytes, at + 3, 2)?;
    if *bytes.get(at + 5)? != b':' {
        return None;
    }
    let second = digits(bytes, at + 6, 2)?;
    let mut next = at + 8;

    let mut millis = 0;
    if matches!(bytes.get(next), Some(b'.') | Some(b',')) {
        let start = next + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > start {
            // Take milliseconds; a nanosecond-precision log is still only
            // ordered to the millisecond, which is finer than anyone reads.
            let taken = (end - start).min(3);
            millis = digits(bytes, start, taken)?;
            for _ in taken..3 {
                millis *= 10;
            }
            next = end;
        }
    }

    let time = NaiveTime::from_hms_milli_opt(hour, minute, second, millis)?;
    Some((time, next))
}

/// `Z`, `+HH:MM`, `+HHMM` or `-HH:MM`, as an offset in seconds east of UTC.
/// `None` means the line carried no zone, and should be read as local time.
fn parse_offset(bytes: &[u8], at: usize) -> Option<i32> {
    match bytes.get(at) {
        Some(b'Z') | Some(b'z') => Some(0),
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            let hours = digits(bytes, at + 1, 2)?;
            // `+01:00` and `+0100` are both current.
            let minute_at = if bytes.get(at + 3) == Some(&b':') {
                at + 4
            } else {
                at + 3
            };
            let minutes = digits(bytes, minute_at, 2)?;
            Some(sign * (hours * 3600 + minutes * 60) as i32)
        }
        _ => None,
    }
}

/// Exactly `count` ASCII digits starting at `at`, as a number.
fn digits(bytes: &[u8], at: usize, count: usize) -> Option<u32> {
    let slice = bytes.get(at..at + count)?;
    let mut value = 0u32;
    for byte in slice {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + (byte - b'0') as u32;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, TimeZone, Timelike};

    /// The epoch millis a UTC wall-clock reading corresponds to.
    fn utc_millis(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32, ms: u32) -> i64 {
        chrono::Utc
            .with_ymd_and_hms(y, mo, d, h, mi, s)
            .unwrap()
            .timestamp_millis()
            + ms as i64
    }

    #[test]
    fn iso_timestamps_with_a_zulu_zone_are_absolute() {
        assert_eq!(
            parse_timestamp("2024-05-01T12:34:56.789Z ready"),
            Some(utc_millis(2024, 5, 1, 12, 34, 56, 789))
        );
    }

    #[test]
    fn a_numeric_offset_is_applied_in_both_spellings_and_directions() {
        let expected = utc_millis(2024, 5, 1, 11, 34, 56, 0);
        assert_eq!(parse_timestamp("2024-05-01T12:34:56+01:00"), Some(expected));
        assert_eq!(parse_timestamp("2024-05-01T12:34:56+0100"), Some(expected));
        assert_eq!(
            parse_timestamp("2024-05-01T12:34:56-01:00"),
            Some(utc_millis(2024, 5, 1, 13, 34, 56, 0))
        );
    }

    #[test]
    fn the_logback_default_with_a_comma_fraction_parses() {
        // Zone-less, so it reads as local time — compare against the same
        // local instant rather than hardcoding a UTC offset the CI box may
        // not share.
        let expected = Local
            .with_ymd_and_hms(2024, 5, 1, 12, 34, 56)
            .unwrap()
            .timestamp_millis()
            + 789;
        assert_eq!(
            parse_timestamp("2024-05-01 12:34:56,789 [main] INFO  c.e.App - up"),
            Some(expected)
        );
    }

    #[test]
    fn slash_separated_dates_parse_and_mixed_separators_do_not() {
        assert!(parse_timestamp("2024/05/01 12:34:56 started").is_some());
        // A date whose two separators disagree is a false positive waiting to
        // happen, so it is refused.
        assert_eq!(parse_timestamp("2024/05-01 12:34:56"), None);
    }

    #[test]
    fn a_bracketed_timestamp_is_found_past_the_bracket() {
        assert_eq!(
            parse_timestamp("[2024-05-01T12:34:56Z] GET /health 200"),
            Some(utc_millis(2024, 5, 1, 12, 34, 56, 0))
        );
    }

    #[test]
    fn leading_whitespace_does_not_hide_a_timestamp() {
        assert!(parse_timestamp("   2024-05-01T12:34:56Z x").is_some());
    }

    #[test]
    fn a_bare_time_is_resolved_against_todays_local_date() {
        let millis = parse_timestamp("12:34:56.250 [main] INFO up").expect("a bare time parses");
        let parsed = Local.timestamp_millis_opt(millis).unwrap();
        let today = Local::now();
        assert_eq!(parsed.date_naive(), today.date_naive());
        assert_eq!(
            (parsed.hour(), parsed.minute(), parsed.second()),
            (12, 34, 56)
        );
        assert_eq!(parsed.timestamp_subsec_millis(), 250);
    }

    #[test]
    fn a_nanosecond_fraction_is_truncated_to_milliseconds_not_rejected() {
        assert_eq!(
            parse_timestamp("2024-05-01T12:34:56.789123456Z"),
            Some(utc_millis(2024, 5, 1, 12, 34, 56, 789))
        );
    }

    #[test]
    fn a_short_fraction_is_read_as_written() {
        // ".5" is half a second, not five milliseconds.
        assert_eq!(
            parse_timestamp("2024-05-01T12:34:56.5Z"),
            Some(utc_millis(2024, 5, 1, 12, 34, 56, 500))
        );
    }

    #[test]
    fn an_impossible_date_is_refused_rather_than_clamped() {
        assert_eq!(parse_timestamp("2024-13-01T12:34:56Z"), None);
        assert_eq!(parse_timestamp("2024-02-30T12:34:56Z"), None);
        assert_eq!(parse_timestamp("2024-05-01T25:00:00Z"), None);
    }

    #[test]
    fn a_line_with_no_timestamp_is_none() {
        assert_eq!(
            parse_timestamp("\tat com.example.App.main(App.java:42)"),
            None
        );
        assert_eq!(
            parse_timestamp("Caused by: java.lang.NullPointerException"),
            None
        );
        assert_eq!(parse_timestamp(""), None);
    }

    #[test]
    fn a_leading_number_that_is_not_a_date_does_not_parse() {
        assert_eq!(parse_timestamp("12345 records written"), None);
        assert_eq!(parse_timestamp("2024-05-01 not a time"), None);
    }

    #[test]
    fn dates_survive_a_leap_day() {
        let parsed = parse_timestamp("2024-02-29T00:00:00Z").expect("2024 is a leap year");
        assert_eq!(chrono::Utc.timestamp_millis_opt(parsed).unwrap().day(), 29);
        assert_eq!(parse_timestamp("2023-02-29T00:00:00Z"), None);
    }

    // --- levels

    #[test]
    fn the_level_token_is_read_from_a_typical_logback_line() {
        assert_eq!(
            parse_level(
                "2024-05-01 12:34:56,789 [http-nio-8080-exec-3] ERROR c.e.PaymentService - boom"
            ),
            Level::Error
        );
    }

    #[test]
    fn a_bracketed_level_is_found() {
        assert_eq!(parse_level("12:00:00 [WARN] disk 91% full"), Level::Warn);
    }

    #[test]
    fn the_leftmost_level_wins_so_the_real_one_beats_the_prose() {
        // "error" appears in the message too; the logger's own token is first.
        assert_eq!(
            parse_level("2024-05-01 12:34:56 WARN  retrying after error"),
            Level::Warn
        );
    }

    #[test]
    fn a_line_with_no_level_is_unknown_rather_than_info() {
        assert_eq!(
            parse_level("\tat com.example.App.main(App.java:42)"),
            Level::Unknown
        );
        assert_eq!(parse_level(""), Level::Unknown);
    }

    #[test]
    fn a_level_word_past_the_scan_window_is_not_mistaken_for_the_lines_level() {
        let line = format!("{} ERROR", "x".repeat(LEVEL_SCAN_LIMIT + 10));
        assert_eq!(parse_level(&line), Level::Unknown);
    }

    #[test]
    fn scanning_a_line_of_multibyte_text_does_not_panic() {
        // The scan window is a byte length, so it must not split a character.
        let line = "→".repeat(LEVEL_SCAN_LIMIT);
        assert_eq!(parse_level(&line), Level::Unknown);
    }
}

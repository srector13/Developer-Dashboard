//! Fuzzy matching over the provider item cache.
//!
//! One matcher serves the launcher and the dashboard's filter box — the
//! launcher does not get its own ranking rules, because two rankings that drift
//! apart is how "why did it pick that one?" starts.
//!
//! The scoring is a subsequence match with three intuitions baked in:
//!
//!   * a prefix match is what the user meant (`jen` → **Jen**kins)
//!   * contiguous letters beat scattered ones (`jenk` in "Jenkins" beats
//!     "**J**ava **En**terprise **K**it")
//!   * a match that starts a word beats one buried mid-token
//!
//! Anything the user has actually launched recently then gets a small nudge, so
//! the tool settles into their habits without ever overriding a clear match.

use crate::model::Item;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// What `usage.json` holds, keyed by `Item::key()`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub count: u32,
    /// Unix seconds of the last launch.
    pub last: i64,
}

pub type UsageMap = HashMap<String, Usage>;

const BOUNDARY_CHARS: &[char] = &[' ', '-', '_', '/', '\\', '.', ':', '@', '(', '[', '\t'];

/// Score one haystack against a lowercase query. `None` means "not a match at
/// all" — every character of the query must appear, in order.
fn subsequence_score(haystack: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let hay: Vec<char> = haystack.to_lowercase().chars().collect();
    let needle: Vec<char> = query.chars().collect();
    if needle.len() > hay.len() {
        return None;
    }

    let mut score = 0i32;
    let mut hay_idx = 0usize;
    let mut previous_match: Option<usize> = None;

    for &want in &needle {
        let found = hay[hay_idx..].iter().position(|&c| c == want)? + hay_idx;

        score += 1;
        // Starting a word is a strong signal: "hub" in "dev-hub" is what the
        // user typed for, "hub" inside "githubbed" mostly is not.
        let at_boundary =
            found == 0 || BOUNDARY_CHARS.contains(&hay[found - 1]) || hay[found - 1].is_numeric();
        if at_boundary {
            score += 18;
        }
        if previous_match == Some(found.wrapping_sub(1)) {
            score += 10; // contiguous with the previous match
        } else if let Some(prev) = previous_match {
            // Skipping a long way to find the next letter is weak evidence.
            score -= ((found - prev - 1) as i32).min(6);
        }

        previous_match = Some(found);
        hay_idx = found + 1;
    }

    // A match that starts at the very beginning is what people expect first.
    if hay.starts_with(&needle) {
        score += 45;
    }
    // Among equally good matches, the shorter title is the more specific one.
    score += (30 - (hay.len() as i32 / 3)).max(0);

    Some(score)
}

/// How much a recently-used item is nudged up the list. Deliberately small: it
/// reorders ties, it never promotes a worse match over a better one.
pub fn usage_boost(usage: Option<&Usage>, now: i64) -> i32 {
    let Some(usage) = usage else { return 0 };
    let frequency = (usage.count.min(10) as i32) * 2;
    let age = now - usage.last;
    let recency = match age {
        a if a < 0 => 0, // clock skew
        a if a < 3_600 => 16,
        a if a < 86_400 => 10,
        a if a < 604_800 => 5,
        _ => 0,
    };
    frequency + recency
}

/// Score one item. Title matches dominate; the subtitle and the hidden keyword
/// list can still surface an item, but never outrank a title hit.
pub fn score_item(item: &Item, query: &str, boost: i32) -> Option<i32> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Some(boost);
    }

    let title = subsequence_score(&item.title, &query).map(|s| s * 3);
    let subtitle = item
        .subtitle
        .as_deref()
        .and_then(|s| subsequence_score(s, &query))
        .map(|s| s * 2);
    let keywords = item
        .keywords
        .iter()
        .filter_map(|k| subsequence_score(k, &query))
        .max()
        .map(|s| s * 2);
    let badges = item
        .badges
        .iter()
        .filter_map(|b| subsequence_score(b, &query))
        .max();

    [title, subtitle, keywords, badges]
        .into_iter()
        .flatten()
        .max()
        .map(|best| best + boost)
}

/// Rank `items` against `query`, best first. `max_results` of `None` returns
/// everything that matched.
pub fn search<'a>(
    items: impl IntoIterator<Item = &'a Item>,
    query: &str,
    usage: &UsageMap,
    now: i64,
    max_results: Option<usize>,
) -> Vec<Item> {
    let mut scored: Vec<(i32, &Item)> = items
        .into_iter()
        .filter_map(|item| {
            let boost = usage_boost(usage.get(&item.key()), now);
            score_item(item, query, boost).map(|score| (score, item))
        })
        .collect();

    // Ties break on title so the order is stable between refreshes; an
    // unstable launcher list is maddening to use.
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.title.cmp(&b.1.title)));
    scored
        .into_iter()
        .take(max_results.unwrap_or(usize::MAX))
        .map(|(_, item)| item.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Item;

    fn item(title: &str) -> Item {
        Item::new("launch", title, title)
    }

    fn titles(results: &[Item]) -> Vec<&str> {
        results.iter().map(|i| i.title.as_str()).collect()
    }

    #[test]
    fn a_query_whose_letters_are_absent_does_not_match() {
        assert!(subsequence_score("Jenkins", "xyz").is_none());
        assert!(score_item(&item("Jenkins"), "xyz", 0).is_none());
    }

    #[test]
    fn letters_must_appear_in_order() {
        assert!(subsequence_score("Jenkins", "jen").is_some());
        assert!(subsequence_score("Jenkins", "nej").is_none());
    }

    #[test]
    fn an_empty_query_matches_everything_so_the_launcher_can_list_it_all() {
        assert_eq!(score_item(&item("Jenkins"), "   ", 0), Some(0));
    }

    #[test]
    fn prefix_matches_rank_above_mid_word_matches() {
        let results = search(
            [&item("Hub Config"), &item("GitHub")],
            "hub",
            &UsageMap::new(),
            0,
            None,
        );
        assert_eq!(titles(&results)[0], "Hub Config");
    }

    #[test]
    fn contiguous_matches_beat_scattered_ones() {
        let contiguous = score_item(&item("Jenkins"), "jenk", 0).unwrap();
        let scattered = score_item(&item("Java Enterprise Nightly Kit"), "jenk", 0).unwrap();
        assert!(
            contiguous > scattered,
            "contiguous {contiguous} should beat scattered {scattered}"
        );
    }

    #[test]
    fn word_boundary_starts_beat_buried_letters() {
        let boundary = score_item(&item("dev-hub"), "dh", 0).unwrap();
        let buried = score_item(&item("adhesive"), "dh", 0).unwrap();
        assert!(boundary > buried, "boundary {boundary} vs buried {buried}");
    }

    #[test]
    fn a_title_hit_outranks_a_subtitle_hit_for_the_same_query() {
        let by_title = item("payments-api");
        let by_subtitle = Item::new("projects", "b", "orders").subtitle("C:/dev/payments-api");
        let results = search(
            [&by_title, &by_subtitle],
            "payments",
            &UsageMap::new(),
            0,
            None,
        );
        assert_eq!(titles(&results), vec!["payments-api", "orders"]);
    }

    #[test]
    fn hidden_keywords_can_surface_an_item_the_title_would_not() {
        let jenkins = Item::new("launch", "jenkins", "Jenkins").keyword("ci");
        let results = search([&jenkins], "ci", &UsageMap::new(), 0, None);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn recent_usage_breaks_ties_without_overriding_a_better_match() {
        let stale_exact = item("deploy");
        let used_loose = item("development environment playbook");
        let mut usage = UsageMap::new();
        usage.insert(
            used_loose.key(),
            Usage {
                count: 10,
                last: 1_000,
            },
        );

        // The boost reorders equals…
        let boost = usage_boost(usage.get(&used_loose.key()), 1_000);
        assert!(boost > 0);
        // …but the exact prefix match still wins.
        let results = search([&stale_exact, &used_loose], "deploy", &usage, 1_000, None);
        assert_eq!(titles(&results)[0], "deploy");
    }

    #[test]
    fn usage_from_the_future_does_not_produce_a_negative_boost() {
        let usage = Usage {
            count: 3,
            last: 5_000,
        };
        assert!(usage_boost(Some(&usage), 1_000) >= 0);
    }

    #[test]
    fn max_results_truncates_after_ranking_not_before() {
        let items = [item("zeta hub"), item("hub"), item("alpha hub")];
        let refs: Vec<&Item> = items.iter().collect();
        let results = search(refs, "hub", &UsageMap::new(), 0, Some(1));
        assert_eq!(titles(&results), vec!["hub"]);
    }

    #[test]
    fn ranking_is_stable_for_equal_scores() {
        let items = [item("service b"), item("service a")];
        let refs: Vec<&Item> = items.iter().collect();
        let first = search(refs.clone(), "service", &UsageMap::new(), 0, None);
        let second = search(refs, "service", &UsageMap::new(), 0, None);
        assert_eq!(titles(&first), titles(&second));
        assert_eq!(titles(&first), vec!["service a", "service b"]);
    }
}

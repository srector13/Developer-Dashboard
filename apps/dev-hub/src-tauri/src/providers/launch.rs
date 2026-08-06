//! Static entries straight from `hub.config.json`. Zero I/O, so it is always
//! the first card to paint.

use super::{Provider, ProviderConfig};
use crate::settings::LaunchEntry;
use suite_core::model::{Action, Item, ProviderResult, Status};

pub const ID: &str = "launch";
pub const NAME: &str = "Launch";

pub struct LaunchProvider;

/// Build the actions an entry implies. An entry with none of `url`, `path` or
/// `run` is a typo, not a feature — it comes back with no actions and the card
/// shows it as a dead row rather than pretending Enter will do something.
fn actions_for(entry: &LaunchEntry) -> Vec<Action> {
    let mut actions = Vec::new();
    if let Some(url) = entry.url.as_deref().filter(|u| !u.trim().is_empty()) {
        actions.push(Action::OpenUrl {
            label: "Open".into(),
            url: url.to_string(),
        });
    }
    if let Some(run) = entry.run.as_ref().filter(|r| !r.program.trim().is_empty()) {
        actions.push(Action::Run {
            label: "Run".into(),
            program: run.program.clone(),
            args: run.args.clone(),
            cwd: run.cwd.clone(),
            capture: false,
        });
    }
    if let Some(path) = entry.path.as_deref().filter(|p| !p.trim().is_empty()) {
        actions.push(Action::OpenPath {
            label: "Open".into(),
            path: path.to_string(),
        });
        actions.push(Action::Reveal {
            label: "Reveal in Explorer".into(),
            path: path.to_string(),
        });
    }
    if let Some(url) = entry.url.as_deref().filter(|u| !u.trim().is_empty()) {
        actions.push(Action::CopyText {
            label: "Copy URL".into(),
            text: url.to_string(),
        });
    }
    actions
}

pub fn items_from(config: &ProviderConfig) -> Vec<Item> {
    config
        .launch
        .iter()
        .enumerate()
        .filter(|(_, entry)| !entry.title.trim().is_empty())
        .map(|(index, entry)| {
            // The index keeps ids stable for two entries sharing a title; the
            // title keeps them stable when the list is reordered around them.
            let mut item = Item::new(ID, format!("{index}:{}", entry.title), entry.title.clone())
                .icon(entry.icon.as_deref().unwrap_or("app"))
                .status(Status::Neutral);

            let subtitle = entry.subtitle.clone().or_else(|| {
                entry
                    .url
                    .clone()
                    .or_else(|| entry.path.clone())
                    .or_else(|| entry.run.as_ref().map(|r| r.program.clone()))
            });
            if let Some(subtitle) = subtitle {
                item = item.subtitle(subtitle);
            }
            for keyword in &entry.keywords {
                item = item.keyword(keyword.clone());
            }
            for action in actions_for(entry) {
                item = item.action(action);
            }
            item
        })
        .collect()
}

#[async_trait::async_trait]
impl Provider for LaunchProvider {
    fn id(&self) -> &str {
        ID
    }

    fn display_name(&self) -> &str {
        NAME
    }

    /// Config-driven and free to compute: the config watcher refreshes it, so
    /// there is nothing for a timer to discover.
    fn refresh_interval(&self) -> u64 {
        0
    }

    async fn items(&self, cfg: &ProviderConfig) -> ProviderResult {
        ProviderResult::ok(ID, NAME, items_from(cfg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{HubConfig, RunSpec};

    fn config(entries: Vec<LaunchEntry>) -> HubConfig {
        HubConfig {
            launch: entries,
            ..Default::default()
        }
    }

    #[test]
    fn a_url_entry_opens_and_can_be_copied() {
        let items = items_from(&config(vec![LaunchEntry {
            title: "Jenkins".into(),
            url: Some("https://jenkins.example.com".into()),
            keywords: vec!["ci".into()],
            ..Default::default()
        }]));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].actions[0].label(), "Open");
        assert!(matches!(items[0].actions[0], Action::OpenUrl { .. }));
        assert!(items[0]
            .actions
            .iter()
            .any(|a| matches!(a, Action::CopyText { .. })));
        // The URL doubles as the subtitle when the entry gives none.
        assert_eq!(
            items[0].subtitle.as_deref(),
            Some("https://jenkins.example.com")
        );
        assert_eq!(items[0].keywords, vec!["ci"]);
    }

    #[test]
    fn a_run_entry_carries_its_program_and_args() {
        let items = items_from(&config(vec![LaunchEntry {
            title: "IntelliJ".into(),
            run: Some(RunSpec {
                program: "idea64.exe".into(),
                args: vec!["-e".into()],
                cwd: None,
            }),
            ..Default::default()
        }]));
        match &items[0].actions[0] {
            Action::Run { program, args, .. } => {
                assert_eq!(program, "idea64.exe");
                assert_eq!(args, &vec!["-e".to_string()]);
            }
            other => panic!("expected a run action, got {other:?}"),
        }
    }

    #[test]
    fn a_path_entry_can_be_opened_or_revealed() {
        let items = items_from(&config(vec![LaunchEntry {
            title: "Repos".into(),
            path: Some("C:\\dev".into()),
            ..Default::default()
        }]));
        assert!(matches!(items[0].actions[0], Action::OpenPath { .. }));
        assert!(items[0]
            .actions
            .iter()
            .any(|a| matches!(a, Action::Reveal { .. })));
    }

    #[test]
    fn an_entry_with_nothing_to_do_produces_no_actions_rather_than_a_dead_enter() {
        let items = items_from(&config(vec![LaunchEntry {
            title: "Typo".into(),
            ..Default::default()
        }]));
        assert!(items[0].actions.is_empty());
    }

    #[test]
    fn blank_titles_are_dropped_and_ids_stay_unique_across_duplicates() {
        let items = items_from(&config(vec![
            LaunchEntry {
                title: "  ".into(),
                url: Some("https://x".into()),
                ..Default::default()
            },
            LaunchEntry {
                title: "Docs".into(),
                url: Some("https://a".into()),
                ..Default::default()
            },
            LaunchEntry {
                title: "Docs".into(),
                url: Some("https://b".into()),
                ..Default::default()
            },
        ]));
        assert_eq!(items.len(), 2);
        assert_ne!(items[0].id, items[1].id);
    }

    #[test]
    fn a_whitespace_only_url_is_not_treated_as_an_action() {
        let items = items_from(&config(vec![LaunchEntry {
            title: "Empty".into(),
            url: Some("   ".into()),
            ..Default::default()
        }]));
        assert!(items[0].actions.is_empty());
    }
}

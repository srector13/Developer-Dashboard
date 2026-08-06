//! Log files worth having an eye on, as a card.
//!
//! This provider is the suite registry earning its keep. Dev Hub does not read
//! a single byte of these files — it stats them, and hands the tailing to
//! whichever installed app advertises `tail-file`. What that app is, and where
//! it lives, comes from the registry rather than from anything Dev Hub was
//! taught about the Log Viewer specifically. A future tool that registers the
//! same capability takes over the action with no change here.
//!
//! What the card is *for* is the glance: which of the logs you care about has
//! grown in the last minute, and which has gone quiet. A service that stops
//! logging is often the first sign of trouble, and it is invisible from a
//! health check that only asks whether the port answers.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use suite_core::model::{Action, Item, ProviderResult, Status};

use super::{Provider, ProviderConfig};
use crate::settings::LogWatch;

pub const ID: &str = "logs";
pub const NAME: &str = "Logs";

pub struct LogsProvider {
    /// From `logs.intervalSeconds`, so the user's config drives the rate.
    pub interval: u64,
}

/// What a single `stat` told us. Split out from item building so the
/// interesting logic is testable without touching a filesystem.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub name: String,
    pub path: String,
    /// `None` when the file isn't there — which is normal for a service that
    /// hasn't started, not an error worth shouting about.
    pub size: Option<u64>,
    /// Seconds since the file was last written.
    pub age_secs: Option<i64>,
    /// Minutes of silence after which a live log is suspicious. 0 disables it.
    pub stale_after_mins: u64,
}

impl Reading {
    fn status(&self) -> Status {
        match (self.size, self.age_secs) {
            (None, _) => Status::Neutral, // not there yet
            (Some(_), Some(age)) if self.is_stale(age) => Status::Warn,
            (Some(_), _) => Status::Ok,
        }
    }

    fn is_stale(&self, age_secs: i64) -> bool {
        self.stale_after_mins > 0 && age_secs >= (self.stale_after_mins * 60) as i64
    }
}

/// Human-readable bytes. Logs run from a few KB to several GB, so the unit has
/// to move; a card that says "4831838208 bytes" has told you nothing.
fn human_size(bytes: u64) -> String {
    const UNITS: [(&str, u64); 4] = [
        ("GB", 1024 * 1024 * 1024),
        ("MB", 1024 * 1024),
        ("KB", 1024),
        ("B", 1),
    ];
    for (unit, scale) in UNITS {
        if bytes >= scale {
            let value = bytes as f64 / scale as f64;
            let rounded = (value * 10.0).round() / 10.0;
            // One decimal below 10 of a unit, and only when it says something:
            // "1.5 GB" is useful, "847.3 MB" is noise, and "4.0 KB" is a
            // decimal point pretending to be precision.
            return if value < 10.0 && scale > 1 && rounded.fract() != 0.0 {
                format!("{rounded:.1} {unit}")
            } else {
                format!("{} {unit}", value.round() as u64)
            };
        }
    }
    "0 B".to_string()
}

pub fn item_for(reading: &Reading, viewer: Option<&Path>) -> Item {
    let subtitle = match (reading.size, reading.age_secs) {
        (None, _) => "not created yet".to_string(),
        (Some(size), Some(age)) => {
            format!(
                "{} · {}",
                human_size(size),
                suite_core::util::relative_age(age)
            )
        }
        (Some(size), None) => human_size(size),
    };

    let mut item = Item::new(ID, reading.path.clone(), reading.name.clone())
        .subtitle(subtitle)
        .icon("file")
        .status(reading.status())
        .keyword("log")
        .keyword("tail");

    if let (Some(_), Some(age)) = (reading.size, reading.age_secs) {
        if reading.is_stale(age) {
            item = item.badge("quiet");
        }
    }

    // The default action is to tail it, when something can. `actions[0]` is
    // what Enter in the launcher and a click on the card both run, so "type
    // the log's name, press Enter, watch it" falls out of the ordering.
    if let Some(viewer) = viewer {
        item = item.action(Action::Run {
            label: "Tail".into(),
            program: viewer.to_string_lossy().into_owned(),
            args: vec!["--file".into(), reading.path.clone()],
            cwd: None,
            capture: false,
        });
    }

    item = item
        .action(Action::Reveal {
            label: "Show in Explorer".into(),
            path: reading.path.clone(),
        })
        .action(Action::CopyText {
            label: "Copy path".into(),
            text: reading.path.clone(),
        });

    item
}

/// The executable that can tail a file, if one is installed.
///
/// The registry is asked for a *capability*, not for the Log Viewer by name.
/// The fallback looks beside our own exe, which is where a portable suite
/// dropped in one folder actually lives, and covers the case where the viewer
/// has been downloaded but never yet run — so it has not registered itself.
fn tail_viewer() -> Option<PathBuf> {
    suite_registry::find_exe_for(suite_registry::capability::TAIL_FILE).or_else(|| {
        suite_registry::find_sibling_exe(&[
            "Log-Viewer.exe",
            "log-viewer.exe",
            "Log Viewer.exe",
            "log-viewer",
        ])
    })
}

fn read(watch: &LogWatch, stale_after_mins: u64) -> Reading {
    let path = PathBuf::from(&watch.path);
    let name = if watch.name.trim().is_empty() {
        suite_core::util::base_name(&path)
    } else {
        watch.name.clone()
    };

    // A file that is missing, locked or on a disconnected share all land here
    // as `None`. None of them is worth an error on a card.
    let metadata = std::fs::metadata(&path).ok().filter(|m| m.is_file());
    let size = metadata.as_ref().map(|m| m.len());
    let age_secs = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|elapsed| elapsed.as_secs() as i64);

    Reading {
        name,
        path: watch.path.clone(),
        size,
        age_secs,
        stale_after_mins: watch.stale_after_mins.unwrap_or(stale_after_mins),
    }
}

#[async_trait::async_trait]
impl Provider for LogsProvider {
    fn id(&self) -> &str {
        ID
    }

    fn display_name(&self) -> &str {
        NAME
    }

    fn refresh_interval(&self) -> u64 {
        self.interval
    }

    async fn items(&self, cfg: &ProviderConfig) -> ProviderResult {
        let watches = cfg.logs.files.clone();
        let stale_after = cfg.logs.stale_after_mins;

        // `stat` on a disconnected network share can block for seconds. Doing
        // that on the async runtime would stall every other provider's refresh.
        let readings = tokio::task::spawn_blocking(move || {
            watches
                .iter()
                .filter(|watch| !watch.path.trim().is_empty())
                .map(|watch| read(watch, stale_after))
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();

        let viewer = tail_viewer();
        let items = readings
            .iter()
            .map(|reading| item_for(reading, viewer.as_deref()))
            .collect();

        ProviderResult::ok(ID, NAME, items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(size: Option<u64>, age_secs: Option<i64>, stale_after_mins: u64) -> Reading {
        Reading {
            name: "api".into(),
            path: "C:\\services\\api\\application.log".into(),
            size,
            age_secs,
            stale_after_mins,
        }
    }

    #[test]
    fn a_log_that_is_being_written_reads_as_healthy() {
        let item = item_for(&reading(Some(4096), Some(5), 15), None);
        assert_eq!(item.status, Status::Ok);
        assert!(item.badges.is_empty());
        assert_eq!(item.subtitle.as_deref(), Some("4 KB · just now"));
    }

    #[test]
    fn a_log_that_has_gone_quiet_is_a_warning_not_an_error() {
        // A service that stops logging is worth noticing and is not proof of
        // anything. Error would cry wolf every lunchtime on a low-traffic box.
        let item = item_for(&reading(Some(4096), Some(3600), 15), None);
        assert_eq!(item.status, Status::Warn);
        assert!(item.badges.contains(&"quiet".to_string()));
    }

    #[test]
    fn staleness_can_be_switched_off_per_file() {
        // A log that only writes on failure is *supposed* to be silent.
        let item = item_for(&reading(Some(4096), Some(86_400), 0), None);
        assert_eq!(item.status, Status::Ok);
        assert!(item.badges.is_empty());
    }

    #[test]
    fn a_file_that_does_not_exist_yet_is_neutral_rather_than_broken() {
        // The normal state of a service that has not been started today.
        let item = item_for(&reading(None, None, 15), None);
        assert_eq!(item.status, Status::Neutral);
        assert_eq!(item.subtitle.as_deref(), Some("not created yet"));
    }

    #[test]
    fn tailing_is_the_default_action_when_a_viewer_is_installed() {
        let viewer = Path::new("C:\\tools\\Log-Viewer.exe");
        let item = item_for(&reading(Some(10), Some(1), 15), Some(viewer));

        match &item.actions[0] {
            Action::Run {
                label,
                program,
                args,
                ..
            } => {
                assert_eq!(label, "Tail");
                assert_eq!(program, "C:\\tools\\Log-Viewer.exe");
                assert_eq!(args, &["--file", "C:\\services\\api\\application.log"]);
            }
            other => panic!("expected the tail action first, got {other:?}"),
        }
    }

    #[test]
    fn with_no_viewer_installed_the_row_still_works() {
        // Dev Hub must not offer an action it cannot perform, and must not
        // become useless because a sibling app is missing.
        let item = item_for(&reading(Some(10), Some(1), 15), None);
        assert!(!item.actions.is_empty());
        assert!(
            !matches!(&item.actions[0], Action::Run { label, .. } if label == "Tail"),
            "there is nothing to tail with"
        );
        assert_eq!(item.actions[0].label(), "Show in Explorer");
    }

    #[test]
    fn every_row_can_reveal_and_copy_its_path() {
        let item = item_for(&reading(Some(10), Some(1), 15), Some(Path::new("v.exe")));
        let labels: Vec<&str> = item.actions.iter().map(|a| a.label()).collect();
        assert!(labels.contains(&"Show in Explorer"));
        assert!(labels.contains(&"Copy path"));
    }

    #[test]
    fn sizes_are_scaled_to_a_unit_a_person_can_read() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(4096), "4 KB");
        assert_eq!(human_size(1024 * 1024 * 3 / 2), "1.5 MB");
        assert_eq!(human_size(1024 * 1024 * 847), "847 MB");
        assert_eq!(human_size(1024 * 1024 * 1024 * 3 / 2), "1.5 GB");
    }

    #[test]
    fn an_item_is_findable_in_the_launcher_by_what_it_is() {
        let item = item_for(&reading(Some(10), Some(1), 15), None);
        assert!(item.keywords.contains(&"log".to_string()));
        assert!(item.keywords.contains(&"tail".to_string()));
    }

    #[test]
    fn item_ids_are_the_path_so_they_survive_a_rescan() {
        // Usage ranking and per-item overrides are keyed on this; deriving it
        // from the display name would break both when a name changes.
        let item = item_for(&reading(Some(10), Some(1), 15), None);
        assert_eq!(item.id, "C:\\services\\api\\application.log");
        assert_eq!(item.provider, ID);
    }

    #[test]
    fn a_watch_with_no_name_is_labelled_by_its_file() {
        let watch = LogWatch {
            name: String::new(),
            path: "/var/log/nginx/access.log".into(),
            stale_after_mins: None,
        };
        assert_eq!(read(&watch, 15).name, "access.log");
    }

    #[test]
    fn a_per_file_staleness_overrides_the_global_one() {
        let watch = LogWatch {
            name: "audit".into(),
            path: "/var/log/audit.log".into(),
            stale_after_mins: Some(0),
        };
        assert_eq!(read(&watch, 15).stale_after_mins, 0);
    }

    #[test]
    fn a_missing_file_reads_without_panicking() {
        let watch = LogWatch {
            name: "nope".into(),
            path: "/definitely/not/here/app.log".into(),
            stale_after_mins: None,
        };
        let reading = read(&watch, 15);
        assert_eq!(reading.size, None);
        assert_eq!(reading.status(), Status::Neutral);
    }

    #[test]
    fn a_real_file_is_measured() {
        let dir = std::env::temp_dir().join("dev-hub-logs-provider");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("app.log");
        std::fs::write(&path, "hello\n").unwrap();

        let watch = LogWatch {
            name: String::new(),
            path: path.to_string_lossy().into_owned(),
            stale_after_mins: None,
        };
        let reading = read(&watch, 15);
        assert_eq!(reading.size, Some(6));
        assert_eq!(reading.status(), Status::Ok);
        assert_eq!(reading.name, "app.log");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! The app's live state: what is being watched, what has been read, and what
//! the filter bar currently says.
//!
//! Each field has its own lock rather than one lock over everything, because
//! the tail loop holds the store for as long as it takes to parse a batch, and
//! the renderer must still be able to read settings while that happens.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use crate::filter::FilterSpec;
use crate::settings::{self, LogSource, LogsConfig, ViewerSettings};
use crate::store::LineStore;
use crate::tail::Tail;

/// What the last poll of one source found.
///
/// This exists because of the bug it fixes. `Tail::poll` has always reported
/// `missing`, and nothing ever read it: a source whose path had a typo in it, or
/// pointed at a share that wasn't mounted, produced no lines and no complaint,
/// which from the outside is identical to a quiet log. "I added a file and see
/// nothing" has to have an answer on screen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHealth {
    /// The file could not be read on the last poll.
    pub missing: bool,
    /// True once the file has been read successfully at least once, so the UI
    /// can tell "never showed up" from "was there and went away".
    pub seen: bool,
}

pub struct AppState {
    settings: Mutex<ViewerSettings>,
    config: Mutex<LogsConfig>,
    /// Sources opened for this session only — from the command line, from the
    /// file picker, from a drop. They are not written to the config file until
    /// the user asks for that, because "I looked at a log once" is not a
    /// preference.
    session: Mutex<Vec<LogSource>>,
    store: Mutex<LineStore>,
    tails: Mutex<HashMap<String, Tail>>,
    filter: Mutex<FilterSpec>,
    /// Reported to the renderer so a config error is visible rather than
    /// looking like an empty config.
    config_error: Mutex<Option<String>>,
    /// What the last poll found, per source id.
    health: Mutex<HashMap<String, SourceHealth>>,
}

impl AppState {
    pub fn load() -> Self {
        let settings = settings::load_settings();
        let (config, config_error) = match settings::load_config() {
            Ok(config) => (config, None),
            Err(error) => (LogsConfig::default(), Some(error)),
        };

        Self {
            store: Mutex::new(LineStore::with_capacity(settings.capacity)),
            settings: Mutex::new(settings),
            config: Mutex::new(config),
            session: Mutex::new(Vec::new()),
            tails: Mutex::new(HashMap::new()),
            filter: Mutex::new(FilterSpec::default()),
            config_error: Mutex::new(config_error),
            health: Mutex::new(HashMap::new()),
        }
    }

    pub fn settings(&self) -> ViewerSettings {
        self.settings.lock().unwrap().clone()
    }

    pub fn set_settings(&self, settings: ViewerSettings) {
        // A changed capacity means a new ring; rather than resizing in place,
        // let the next lines fill it. Dropping the scrollback on a settings
        // save would be a surprising amount of collateral damage.
        *self.settings.lock().unwrap() = settings;
    }

    pub fn config(&self) -> LogsConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn set_config(&self, config: LogsConfig) {
        *self.config.lock().unwrap() = config;
        *self.config_error.lock().unwrap() = None;
    }

    pub fn config_error(&self) -> Option<String> {
        self.config_error.lock().unwrap().clone()
    }

    /// Report a config that would not parse, without touching the config that
    /// is currently working. The watcher uses this: a file caught mid-edit is
    /// something to say, not a reason to stop tailing.
    pub fn set_config_error(&self, error: String) {
        *self.config_error.lock().unwrap() = Some(error);
    }

    pub fn filter(&self) -> FilterSpec {
        self.filter.lock().unwrap().clone()
    }

    pub fn set_filter(&self, filter: FilterSpec) {
        *self.filter.lock().unwrap() = filter;
    }

    /// Every source being watched: the configured ones first, then whatever
    /// this session opened. A session source whose path is already configured
    /// is dropped, so opening a file you already watch does not double it.
    pub fn sources(&self) -> Vec<LogSource> {
        let configured = self.config.lock().unwrap().sources.clone();
        let known: Vec<String> = configured.iter().map(|s| normalise(&s.path)).collect();

        let session = self.session.lock().unwrap();
        configured
            .iter()
            .cloned()
            .chain(
                session
                    .iter()
                    .filter(|s| !known.contains(&normalise(&s.path)))
                    .cloned(),
            )
            .collect()
    }

    /// Open a file for this session. Returns the source, or `None` if it was
    /// already being watched.
    pub fn add_session_source(&self, path: &str) -> Option<LogSource> {
        let path = path.trim();
        if path.is_empty() {
            return None;
        }
        if self
            .sources()
            .iter()
            .any(|s| normalise(&s.path) == normalise(path))
        {
            return None;
        }

        let mut session = self.session.lock().unwrap();
        let index = self.config.lock().unwrap().sources.len() + session.len();
        let source = LogSource {
            path: path.to_string(),
            ..Default::default()
        }
        .completed(index);
        session.push(source.clone());
        Some(source)
    }

    /// Stop watching a source. A configured source is removed from the config
    /// in memory; saving the config is a separate, explicit act.
    pub fn remove_source(&self, id: &str) {
        self.config.lock().unwrap().sources.retain(|s| s.id != id);
        self.session.lock().unwrap().retain(|s| s.id != id);
        self.tails.lock().unwrap().remove(id);
        self.store.lock().unwrap().clear_source(id);
        self.health.lock().unwrap().remove(id);
    }

    pub fn set_source_enabled(&self, id: &str, enabled: bool) {
        let mut config = self.config.lock().unwrap();
        for source in config.sources.iter_mut().filter(|s| s.id == id) {
            source.enabled = enabled;
        }
        drop(config);
        for source in self
            .session
            .lock()
            .unwrap()
            .iter_mut()
            .filter(|s| s.id == id)
        {
            source.enabled = enabled;
        }
    }

    /// Promote a session source into the config so it survives a restart.
    pub fn pin_source(&self, id: &str) -> Option<LogSource> {
        let mut session = self.session.lock().unwrap();
        let position = session.iter().position(|s| s.id == id)?;
        let source = session.remove(position);
        drop(session);
        self.config.lock().unwrap().sources.push(source.clone());
        Some(source)
    }

    /// Record what a poll found. Returns true when this changed the answer, so
    /// the tail loop can tell the window only when there is something new to
    /// say rather than on every tick.
    pub fn set_health(&self, id: &str, missing: bool) -> bool {
        let mut health = self.health.lock().unwrap();
        let entry = health.entry(id.to_string()).or_default();
        let before = *entry;
        entry.missing = missing;
        entry.seen |= !missing;
        *entry != before
    }

    pub fn health(&self, id: &str) -> SourceHealth {
        self.health.lock().unwrap().get(id).copied().unwrap_or(
            // Nothing polled yet. Not missing — claiming a file is gone before
            // anyone has looked for it would be its own kind of wrong.
            SourceHealth::default(),
        )
    }

    pub fn with_store<T>(&self, f: impl FnOnce(&mut LineStore) -> T) -> T {
        f(&mut self.store.lock().unwrap())
    }

    pub fn with_tails<T>(&self, f: impl FnOnce(&mut HashMap<String, Tail>) -> T) -> T {
        f(&mut self.tails.lock().unwrap())
    }

    /// Drop the readers for sources that no longer exist, and create readers
    /// for ones that have appeared. Called every tick — it is cheap, and it is
    /// what makes adding a source take effect without a restart.
    pub fn reconcile_tails(&self) {
        let live: Vec<LogSource> = self.sources().into_iter().filter(|s| s.enabled).collect();
        let mut tails = self.tails.lock().unwrap();

        tails.retain(|id, _| live.iter().any(|s| &s.id == id));
        for source in live {
            tails
                .entry(source.id.clone())
                .or_insert_with(|| Tail::new(&source.path));
        }
    }
}

/// Compare paths the way a person would: case-insensitively on Windows, and
/// without caring which slash was typed.
fn normalise(path: &str) -> String {
    let swapped = path.replace('\\', "/");
    if cfg!(windows) {
        swapped.to_lowercase()
    } else {
        swapped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A state with no files on disk behind it — enough to exercise the source
    /// bookkeeping, which is all these tests are about.
    fn state() -> AppState {
        AppState {
            settings: Mutex::new(ViewerSettings::default()),
            config: Mutex::new(LogsConfig::default()),
            session: Mutex::new(Vec::new()),
            store: Mutex::new(LineStore::with_capacity(100)),
            tails: Mutex::new(HashMap::new()),
            filter: Mutex::new(FilterSpec::default()),
            config_error: Mutex::new(None),
            health: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn a_session_source_is_added_and_listed() {
        let state = state();
        let source = state.add_session_source("/var/log/api.log").unwrap();
        assert_eq!(source.name, "api.log");
        assert_eq!(state.sources().len(), 1);
    }

    #[test]
    fn opening_the_same_file_twice_does_not_double_it() {
        let state = state();
        assert!(state.add_session_source("/var/log/api.log").is_some());
        assert!(state.add_session_source("/var/log/api.log").is_none());
        assert_eq!(state.sources().len(), 1);
    }

    #[test]
    fn opening_a_file_that_is_already_configured_is_a_no_op() {
        let state = state();
        state.set_config(LogsConfig {
            sources: vec![LogSource {
                id: "api".into(),
                name: "API".into(),
                path: "/var/log/api.log".into(),
                enabled: true,
                colour: "blue".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        assert!(state.add_session_source("/var/log/api.log").is_none());
        assert_eq!(state.sources().len(), 1);
        assert_eq!(state.sources()[0].name, "API", "the configured one wins");
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_compare_case_insensitively_and_across_slashes() {
        let state = state();
        state.add_session_source("C:\\logs\\API.log").unwrap();
        assert!(state.add_session_source("c:/logs/api.log").is_none());
    }

    #[test]
    fn an_empty_path_is_refused() {
        let state = state();
        assert!(state.add_session_source("   ").is_none());
        assert!(state.sources().is_empty());
    }

    #[test]
    fn removing_a_source_drops_its_lines_and_its_reader() {
        let state = state();
        let source = state.add_session_source("/var/log/api.log").unwrap();
        state.with_store(|store| store.push(&source.id, "a line".into()));
        state.reconcile_tails();
        assert_eq!(state.with_tails(|t| t.len()), 1);

        state.remove_source(&source.id);
        assert!(state.sources().is_empty());
        assert_eq!(state.with_store(|s| s.len()), 0);
        assert_eq!(state.with_tails(|t| t.len()), 0);
    }

    #[test]
    fn disabling_a_source_stops_it_being_tailed_without_losing_it() {
        let state = state();
        let source = state.add_session_source("/var/log/api.log").unwrap();
        state.reconcile_tails();
        assert_eq!(state.with_tails(|t| t.len()), 1);

        state.set_source_enabled(&source.id, false);
        state.reconcile_tails();
        assert_eq!(state.with_tails(|t| t.len()), 0, "no longer read");
        assert_eq!(
            state.sources().len(),
            1,
            "but still listed, so it can come back"
        );
    }

    #[test]
    fn pinning_moves_a_session_source_into_the_config() {
        let state = state();
        let source = state.add_session_source("/var/log/api.log").unwrap();
        let pinned = state
            .pin_source(&source.id)
            .expect("it was a session source");

        assert_eq!(state.config().sources, vec![pinned]);
        assert_eq!(state.sources().len(), 1, "and it is not listed twice");
    }

    #[test]
    fn pinning_something_already_configured_is_a_no_op() {
        let state = state();
        assert!(state.pin_source("not-a-session-source").is_none());
    }

    #[test]
    fn reconciling_creates_one_reader_per_enabled_source() {
        let state = state();
        state.add_session_source("/var/log/a.log").unwrap();
        state.add_session_source("/var/log/b.log").unwrap();
        state.reconcile_tails();
        assert_eq!(state.with_tails(|t| t.len()), 2);

        // Called again with nothing changed, it must not rebuild the readers —
        // that would reset every file offset and replay the whole tail.
        let before = state.with_tails(|t| t.keys().cloned().collect::<Vec<_>>());
        state.reconcile_tails();
        let after = state.with_tails(|t| t.keys().cloned().collect::<Vec<_>>());
        assert_eq!(before.len(), after.len());
    }

    #[test]
    fn a_source_nobody_has_polled_yet_is_not_reported_as_missing() {
        let state = state();
        assert_eq!(state.health("api"), SourceHealth::default());
        assert!(!state.health("api").missing);
    }

    #[test]
    fn a_file_that_never_turned_up_is_distinguishable_from_one_that_went_away() {
        let state = state();

        assert!(state.set_health("typo", true), "first answer is news");
        assert!(!state.set_health("typo", true), "the same answer is not");
        assert!(state.health("typo").missing);
        assert!(
            !state.health("typo").seen,
            "it has never once been readable — probably a wrong path"
        );

        state.set_health("rotating", false);
        assert!(state.set_health("rotating", true));
        let health = state.health("rotating");
        assert!(health.missing && health.seen, "it was there and now is not");
    }

    #[test]
    fn closing_a_source_forgets_what_was_known_about_its_file() {
        let state = state();
        let source = state.add_session_source("/var/log/api.log").unwrap();
        state.set_health(&source.id, true);

        state.remove_source(&source.id);
        assert!(
            !state.health(&source.id).missing,
            "reopening the same path must not inherit the old complaint"
        );
    }

    #[test]
    fn a_config_that_failed_to_parse_is_reported_rather_than_looking_empty() {
        let state = state();
        *state.config_error.lock().unwrap() = Some("logs.config.json is not valid JSON".into());
        assert!(state.config_error().unwrap().contains("not valid JSON"));

        state.set_config(LogsConfig::default());
        assert_eq!(state.config_error(), None, "a successful save clears it");
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    use crate::filter::{Highlighter, Matcher};

    fn fresh() -> AppState {
        AppState {
            settings: Mutex::new(ViewerSettings::default()),
            config: Mutex::new(LogsConfig::default()),
            session: Mutex::new(Vec::new()),
            store: Mutex::new(LineStore::with_capacity(1000)),
            tails: Mutex::new(HashMap::new()),
            filter: Mutex::new(FilterSpec::default()),
            config_error: Mutex::new(None),
            health: Mutex::new(HashMap::new()),
        }
    }

    /// End to end, exactly what the app does when you add a file: register the
    /// source, reconcile the readers, poll, and ask for the view.
    ///
    /// Written to chase "I added a log and see nothing". It passes, which is
    /// what ruled the backend out: the reading path is correct, and the two
    /// things that made a real file look empty were both above it — a config
    /// that was never re-read (`desktop::watch_config`) and a file that could
    /// not be opened at all, which nothing reported
    /// (`a_file_that_cannot_be_read_is_reported_rather_than_silent`).
    #[test]
    fn adding_a_file_then_polling_shows_its_lines() {
        let dir = std::env::temp_dir().join("log-viewer-repro-add");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app.log");
        std::fs::write(&path, "line one\nline two\nline three\n").unwrap();

        let state = fresh();

        let source = state
            .add_session_source(&path.to_string_lossy())
            .expect("the file is added as a source");
        assert!(source.enabled, "a newly added source must be read");

        state.reconcile_tails();
        assert_eq!(
            state.with_tails(|t| t.len()),
            1,
            "one reader for one source"
        );

        // What the tail loop does each tick.
        let polls = state.with_tails(|tails| {
            tails
                .iter_mut()
                .map(|(id, tail)| (id.clone(), tail.poll()))
                .collect::<Vec<_>>()
        });
        for (id, poll) in polls {
            assert!(!poll.missing, "the file exists");
            state.with_store(|store| store.extend(&id, poll.lines));
        }

        let matcher = Matcher::build(&state.filter()).unwrap();
        let view = state.with_store(|store| {
            store.query(&matcher, &Highlighter::default(), state.settings().window)
        });

        let texts: Vec<&str> = view.lines.iter().map(|l| l.line.text.as_str()).collect();
        assert_eq!(texts, vec!["line one", "line two", "line three"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The other half of "I added a log and see nothing": the path was wrong.
    ///
    /// Every step here succeeds. The source is added, a reader is created, the
    /// poll runs — and there is nothing to show, because there is no file. The
    /// only thing that separates this from a quiet log is that the poll said
    /// `missing`, so that has to reach the window.
    #[test]
    fn a_file_that_cannot_be_read_is_reported_rather_than_silent() {
        let state = fresh();
        let source = state
            .add_session_source("/no/such/directory/typo.log")
            .expect("a path that does not exist is still added — it may appear");

        state.reconcile_tails();
        let polls = state.with_tails(|tails| {
            tails
                .iter_mut()
                .map(|(id, tail)| (id.clone(), tail.poll()))
                .collect::<Vec<_>>()
        });
        for (id, poll) in polls {
            state.set_health(&id, poll.missing);
        }

        let health = state.health(&source.id);
        assert!(health.missing, "the sidebar has to be able to say so");
        assert!(
            !health.seen,
            "and that it was never there in the first place"
        );
    }
}

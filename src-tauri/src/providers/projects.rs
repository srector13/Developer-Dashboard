//! Git repositories found by walking the configured roots.
//!
//! libgit2 is a blocking C library and a status scan over a large repo is not
//! free, so the whole pass runs on a blocking thread and results are cached
//! against the mtimes of `.git/HEAD` and the index. A rescan of an untouched
//! repo therefore costs two `stat` calls, which is what makes a 120-second
//! refresh interval over a folder full of checkouts reasonable.

use super::{Provider, ProviderConfig};
use crate::model::{Action, Item, ProviderResult, Status};
use crate::settings::ProjectsConfig;
use crate::util;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const ID: &str = "projects";
pub const NAME: &str = "Projects";

/// Directories that are never a project root and are expensive to descend into.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".idea",
    ".gradle",
    "vendor",
    "__pycache__",
];

pub struct ProjectsProvider;

#[derive(Debug, Clone, PartialEq)]
pub struct RepoStatus {
    pub branch: String,
    pub dirty: bool,
    pub ahead: usize,
    pub behind: usize,
    pub remote_url: Option<String>,
    /// Unix seconds of the last commit on HEAD, if there is one.
    pub last_commit: Option<i64>,
    /// A repo we could open but not fully read (no HEAD in a fresh `git init`,
    /// a detached HEAD with no upstream). The item still renders.
    pub note: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct CacheStamp {
    head: Option<u64>,
    index: Option<u64>,
}

static CACHE: Lazy<Mutex<HashMap<PathBuf, (CacheStamp, RepoStatus)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn mtime_of(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

fn stamp_for(repo: &Path) -> CacheStamp {
    let git_dir = repo.join(".git");
    CacheStamp {
        head: mtime_of(&git_dir.join("HEAD")),
        index: mtime_of(&git_dir.join("index")),
    }
}

/// Walk one root for repositories. A `.git` entry ends the descent — nested
/// repos inside a checkout are submodules or vendored copies, not projects.
pub fn find_repos(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let walker = walkdir::WalkDir::new(root)
        .max_depth(max_depth.max(1))
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if SKIP_DIRS.contains(&name.as_str()) {
                return false;
            }
            // Dot-directories other than .git are never project roots.
            !(name.starts_with('.') && name != ".git")
        });

    for entry in walker.flatten() {
        if entry.file_name() == ".git" {
            if let Some(parent) = entry.path().parent() {
                found.push(parent.to_path_buf());
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

/// Read a repo's status through libgit2. Errors are folded into `note` rather
/// than dropping the repo — a checkout that can't report ahead/behind is still
/// something the user wants to open.
pub fn read_status(path: &Path) -> Result<RepoStatus, String> {
    let repo = git2::Repository::open(path).map_err(|e| e.message().to_string())?;

    let mut status = RepoStatus {
        branch: String::new(),
        dirty: false,
        ahead: 0,
        behind: 0,
        remote_url: repo
            .find_remote("origin")
            .ok()
            .and_then(|r| r.url().map(|u| u.to_string())),
        last_commit: None,
        note: None,
    };

    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(false);
    match repo.statuses(Some(&mut options)) {
        Ok(statuses) => status.dirty = !statuses.is_empty(),
        Err(err) => status.note = Some(err.message().to_string()),
    }

    match repo.head() {
        Ok(head) => {
            status.branch = head
                .shorthand()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "detached".into());

            if let Ok(commit) = head.peel_to_commit() {
                status.last_commit = Some(commit.time().seconds());
                // Ahead/behind needs an upstream; a local-only branch has none,
                // which is normal and not an error worth surfacing.
                if head.is_branch() {
                    if let Ok(branch) = repo.find_branch(&status.branch, git2::BranchType::Local) {
                        if let Ok(upstream) = branch.upstream() {
                            if let Some(target) = upstream.get().target() {
                                if let Ok((ahead, behind)) =
                                    repo.graph_ahead_behind(commit.id(), target)
                                {
                                    status.ahead = ahead;
                                    status.behind = behind;
                                }
                            }
                        }
                    }
                }
            }
        }
        Err(_) => {
            // A freshly `git init`ed repo with no commits. The branch badge
            // says this on its own — setting `note` too produced two badges
            // ("no commits" and "No commits yet") that meant the same thing.
            // `note` stays reserved for a status read that genuinely failed.
            status.branch = "no commits".into();
        }
    }

    Ok(status)
}

fn status_cached(path: &Path) -> Result<RepoStatus, String> {
    let stamp = stamp_for(path);
    if let Ok(cache) = CACHE.lock() {
        if let Some((cached_stamp, cached)) = cache.get(path) {
            if *cached_stamp == stamp {
                return Ok(cached.clone());
            }
        }
    }
    let status = read_status(path)?;
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(path.to_path_buf(), (stamp, status.clone()));
    }
    Ok(status)
}

/// Turn a repo path + status into the dashboard/launcher item.
pub fn item_for(path: &Path, status: &RepoStatus, config: &ProjectsConfig, now: i64) -> Item {
    let mut item = Item::new(ID, util::display_path(path), util::base_name(path))
        .icon("git")
        .status(if status.dirty {
            Status::Warn
        } else {
            Status::Neutral
        });

    let age = status
        .last_commit
        .map(|t| format!(" · {}", util::relative_age(now - t)))
        .unwrap_or_default();
    item = item.subtitle(format!("{}{age}", util::display_path(path)));

    if !status.branch.is_empty() {
        item = item.badge(status.branch.clone());
    }
    if status.dirty {
        item = item.badge("dirty");
    }
    if status.ahead > 0 {
        item = item.badge(format!("↑{}", status.ahead));
    }
    if status.behind > 0 {
        item = item.badge(format!("↓{}", status.behind));
    }
    if let Some(note) = &status.note {
        item = item.badge(note.clone());
    }
    item = item
        .keyword(util::display_path(path))
        .keyword(status.branch.clone());

    let path_str = path.to_string_lossy().into_owned();

    // The configured editors go behind one "Open with" menu. Four IDEs meant
    // four buttons on every row, which is a worse-looking menu that also makes
    // the rows shift width depending on how many you happen to have.
    let openers_start = item.actions.len();
    for opener in &config.open_with {
        if opener.program.trim().is_empty() {
            continue;
        }
        item = item.action(Action::Run {
            label: opener.label.clone(),
            program: opener.program.clone(),
            args: opener
                .args
                .iter()
                .map(|a| util::expand_placeholders(a, &path_str, None))
                .collect(),
            cwd: Some(path_str.clone()),
            capture: false,
        });
    }
    // Always openable, even with no `openWith` configured at all — so it joins
    // the menu rather than sitting outside it.
    item = item
        .action(Action::OpenPath {
            label: "Open folder".into(),
            path: path_str.clone(),
        })
        .group_from("Open with", openers_start);

    if let Some(web) = status
        .remote_url
        .as_deref()
        .and_then(util::remote_to_web_url)
    {
        let remote_start = item.actions.len();
        item = item.action(Action::OpenUrl {
            label: "Repository".into(),
            url: web.clone(),
        });
        if !status.branch.is_empty() && status.branch != "detached" {
            item = item.action(Action::OpenUrl {
                label: format!("Branch: {}", status.branch),
                url: util::branch_web_url(&web, &status.branch),
            });
        }
        item = item.group_from("Open remote", remote_start);
    }

    item.action(Action::Reveal {
        label: "Reveal in Explorer".into(),
        path: path_str.clone(),
    })
    .action(Action::CopyText {
        label: "Copy path".into(),
        text: path_str,
    })
}

fn scan(config: &ProjectsConfig) -> (Vec<Item>, Option<String>) {
    let now = util::now_secs();
    let mut items = Vec::new();
    let mut problems: Vec<String> = Vec::new();

    if config.roots.is_empty() {
        return (
            items,
            Some(
                "No project roots configured — add some to projects.roots in hub.config.json."
                    .into(),
            ),
        );
    }

    for root in &config.roots {
        let root_path = PathBuf::from(root);
        if !root_path.exists() {
            problems.push(format!("{root} does not exist"));
            continue;
        }
        for repo in find_repos(&root_path, config.max_depth) {
            match status_cached(&repo) {
                Ok(status) => items.push(item_for(&repo, &status, config, now)),
                Err(err) => problems.push(format!("{}: {err}", util::display_path(&repo))),
            }
        }
    }

    // Dirty repos first — "what needs my attention" is the question this card
    // answers — then alphabetical so the order is stable.
    items.sort_by(|a, b| {
        let a_dirty = a.status == Status::Warn;
        let b_dirty = b.status == Status::Warn;
        b_dirty.cmp(&a_dirty).then_with(|| a.title.cmp(&b.title))
    });

    let error = (!problems.is_empty()).then(|| problems.join("; "));
    (items, error)
}

#[async_trait::async_trait]
impl Provider for ProjectsProvider {
    fn id(&self) -> &str {
        ID
    }

    fn display_name(&self) -> &str {
        NAME
    }

    fn refresh_interval(&self) -> u64 {
        120
    }

    async fn items(&self, cfg: &ProviderConfig) -> ProviderResult {
        let config = cfg.projects.clone();
        // libgit2 blocks; keep it off the async runtime's worker threads.
        let scanned = tokio::task::spawn_blocking(move || scan(&config)).await;
        match scanned {
            Ok((items, error)) => {
                let mut result = ProviderResult::ok(ID, NAME, items);
                result.error = error;
                result
            }
            Err(err) => ProviderResult::failed(ID, NAME, format!("Repo scan failed: {err}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::OpenWith;

    /// A real repository in a tempdir: one commit, one remote, optionally dirty.
    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("dev-hub-test-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();

            let repo = git2::Repository::init(&dir).unwrap();
            repo.remote("origin", "git@github.com:srector13/fixture.git")
                .unwrap();
            std::fs::write(dir.join("README.md"), "# fixture\n").unwrap();

            let mut index = repo.index().unwrap();
            index.add_path(Path::new("README.md")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = git2::Signature::now("Test", "test@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .unwrap();

            Self { dir }
        }

        fn dirty(self) -> Self {
            std::fs::write(self.dir.join("scratch.txt"), "uncommitted\n").unwrap();
            self
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn a_clean_repo_reports_its_branch_remote_and_no_dirt() {
        let fixture = Fixture::new("clean");
        let status = read_status(&fixture.dir).unwrap();
        assert!(!status.dirty);
        assert!(
            status.branch == "main" || status.branch == "master",
            "{}",
            status.branch
        );
        assert_eq!(
            status.remote_url.as_deref(),
            Some("git@github.com:srector13/fixture.git")
        );
        assert!(status.last_commit.unwrap() > 0);
        // No upstream configured, which is normal — not an error.
        assert_eq!((status.ahead, status.behind), (0, 0));
    }

    #[test]
    fn an_untracked_file_makes_the_repo_dirty_and_the_item_a_warning() {
        let fixture = Fixture::new("dirty").dirty();
        let status = read_status(&fixture.dir).unwrap();
        assert!(status.dirty);

        let item = item_for(
            &fixture.dir,
            &status,
            &ProjectsConfig::default(),
            util::now_secs(),
        );
        assert_eq!(item.status, Status::Warn);
        assert!(item.badges.iter().any(|b| b == "dirty"));
    }

    #[test]
    fn a_repo_with_no_commits_says_so_exactly_once() {
        let dir = std::env::temp_dir().join(format!("dev-hub-test-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();

        let status = read_status(&dir).unwrap();
        assert_eq!(status.branch, "no commits");
        assert_eq!(status.note, None, "the branch badge already says this");

        let item = item_for(&dir, &status, &ProjectsConfig::default(), util::now_secs());
        let saying_no_commits = item
            .badges
            .iter()
            .filter(|b| b.to_lowercase().contains("no commits"))
            .count();
        assert_eq!(saying_no_commits, 1, "badges: {:?}", item.badges);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_a_folder_that_is_not_a_repo_is_an_error_not_a_panic() {
        let dir = std::env::temp_dir().join("dev-hub-test-not-a-repo");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_status(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_scan_skips_node_modules_and_stops_at_the_first_git_dir() {
        let root = std::env::temp_dir().join(format!("dev-hub-test-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("app").join(".git")).unwrap();
        std::fs::create_dir_all(
            root.join("app")
                .join("node_modules")
                .join("dep")
                .join(".git"),
        )
        .unwrap();

        let found = find_repos(&root, 5);
        assert_eq!(found, vec![root.join("app")]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn open_with_entries_become_the_default_actions_with_path_substituted() {
        let fixture = Fixture::new("openwith");
        let status = read_status(&fixture.dir).unwrap();
        let config = ProjectsConfig {
            open_with: vec![OpenWith {
                label: "VS Code".into(),
                program: "code".into(),
                args: vec!["{path}".into()],
            }],
            ..Default::default()
        };
        let item = item_for(&fixture.dir, &status, &config, util::now_secs());

        match &item.actions[0] {
            Action::Run {
                label,
                program,
                args,
                ..
            } => {
                assert_eq!(label, "VS Code");
                assert_eq!(program, "code");
                assert_eq!(args[0], fixture.dir.to_string_lossy());
            }
            other => panic!("expected the configured opener first, got {other:?}"),
        }
    }

    #[test]
    fn an_ssh_remote_produces_browsable_repo_and_branch_urls() {
        let fixture = Fixture::new("remote");
        let status = read_status(&fixture.dir).unwrap();
        let item = item_for(
            &fixture.dir,
            &status,
            &ProjectsConfig::default(),
            util::now_secs(),
        );

        let urls: Vec<&str> = item
            .actions
            .iter()
            .filter_map(|a| match a {
                Action::OpenUrl { url, .. } => Some(url.as_str()),
                _ => None,
            })
            .collect();
        assert!(urls.contains(&"https://github.com/srector13/fixture"));
        assert!(urls.iter().any(|u| u.contains("/tree/")));
    }

    #[test]
    fn every_configured_editor_lands_in_one_open_with_menu() {
        let fixture = Fixture::new("grouped");
        let status = read_status(&fixture.dir).unwrap();
        let config = ProjectsConfig {
            open_with: vec![
                OpenWith {
                    label: "IntelliJ".into(),
                    program: "idea64.exe".into(),
                    args: vec!["{path}".into()],
                },
                OpenWith {
                    label: "VS Code".into(),
                    program: "code".into(),
                    args: vec!["{path}".into()],
                },
            ],
            ..Default::default()
        };
        let item = item_for(&fixture.dir, &status, &config, util::now_secs());

        let open_with = item
            .action_groups
            .iter()
            .find(|g| g.label == "Open with")
            .expect("the editors should be grouped");
        // Both editors plus "Open folder", so the menu is the one place that
        // answers "how do I open this".
        assert_eq!(open_with.actions.len(), 3);
        let labels: Vec<&str> = open_with
            .actions
            .iter()
            .map(|i| item.actions[*i].label())
            .collect();
        assert_eq!(labels, vec!["IntelliJ", "VS Code", "Open folder"]);

        // Grouping is advisory: the indices still address the real actions.
        assert!(open_with.actions.iter().all(|i| *i < item.actions.len()));

        let remote = item
            .action_groups
            .iter()
            .find(|g| g.label == "Open remote")
            .expect("the remote links should be grouped too");
        assert_eq!(remote.actions.len(), 2);
    }

    #[test]
    fn a_repo_with_no_remote_has_no_remote_menu() {
        let dir = std::env::temp_dir().join(format!("dev-hub-noremote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();

        let status = read_status(&dir).unwrap();
        let item = item_for(&dir, &status, &ProjectsConfig::default(), util::now_secs());
        assert!(!item.action_groups.iter().any(|g| g.label == "Open remote"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_repo_with_no_open_with_configured_can_still_be_opened() {
        let fixture = Fixture::new("noopener");
        let status = read_status(&fixture.dir).unwrap();
        let item = item_for(
            &fixture.dir,
            &status,
            &ProjectsConfig::default(),
            util::now_secs(),
        );
        assert!(matches!(item.actions[0], Action::OpenPath { .. }));
    }

    #[test]
    fn no_configured_roots_is_reported_on_the_card_not_silently_empty() {
        let (items, error) = scan(&ProjectsConfig::default());
        assert!(items.is_empty());
        assert!(error.unwrap().contains("hub.config.json"));
    }

    #[test]
    fn a_missing_root_is_named_in_the_error_and_does_not_stop_the_others() {
        let fixture = Fixture::new("mixedroots");
        let parent = fixture.dir.parent().unwrap().to_path_buf();
        let config = ProjectsConfig {
            roots: vec![
                "Z:\\definitely\\not\\here".into(),
                parent.to_string_lossy().into_owned(),
            ],
            max_depth: 2,
            open_with: Vec::new(),
        };
        let (items, error) = scan(&config);
        assert!(error.unwrap().contains("does not exist"));
        assert!(items.iter().any(|i| i.title.contains("mixedroots")));
    }
}

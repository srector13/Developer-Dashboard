//! Unchecked `- [ ]` lines from a folder of markdown notes.
//!
//! When `todos.roots` is empty this follows the pointer file Markdown Notebook
//! writes at `%USERPROFILE%\.markdown-notebook\last-notebook.json`, so the two
//! apps find each other with no configuration at all.

use super::{Provider, ProviderConfig};
use crate::settings::{self, TodosConfig};
use crate::util;
use once_cell::sync::Lazy;
use regex::Regex;
use std::path::{Path, PathBuf};
use suite_core::model::{Action, Item, ProviderResult, Status};

pub const ID: &str = "todos";
pub const NAME: &str = "Todos";

/// The notebook's own ignore list, so Dev Hub sees exactly the notes Markdown
/// Notebook shows.
pub const IGNORE_DIRS: &[&str] = &[
    "_media",
    "attachments",
    "templates",
    "node_modules",
    ".git",
    ".vscode",
];

pub struct TodosProvider;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTodo {
    /// 1-based, so it can be handed straight to an editor's `file:line`.
    pub line: usize,
    pub text: String,
    pub tags: Vec<String>,
    /// `YYYY-MM-DD`, when the line carried one.
    pub due: Option<String>,
}

static UNCHECKED: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s*(.*)$").unwrap());
static FENCE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*(?:```|~~~)").unwrap());
static TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|\s)#([\w/-]+)").unwrap());
static DUE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|\s)@(?:due[:(]?\s*)?(\d{4}-\d{2}-\d{2})\)?").unwrap());
static WIKILINK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());

/// Strip the syntax that is markup rather than content: wikilinks collapse to
/// their display text, and the trailing metadata tokens come off the end.
fn clean_title(raw: &str) -> String {
    let unlinked = WIKILINK.replace_all(raw, |caps: &regex::Captures| {
        caps.get(2)
            .or_else(|| caps.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default()
    });
    let without_due = DUE.replace_all(&unlinked, " ");
    let without_tags = TAG.replace_all(&without_due, " ");
    without_tags
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse one markdown document. Fenced code blocks are skipped entirely — a
/// `- [ ]` inside a sample snippet is documentation, not a task.
pub fn parse_todos(text: &str) -> Vec<ParsedTodo> {
    let mut todos = Vec::new();
    let mut in_fence = false;

    for (index, line) in text.lines().enumerate() {
        if FENCE.is_match(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(caps) = UNCHECKED.captures(line) else {
            continue;
        };
        let body = caps.get(1).map(|m| m.as_str()).unwrap_or("").trim();
        if body.is_empty() {
            continue;
        }

        let tags = TAG
            .captures_iter(body)
            .map(|c| c[1].to_string())
            .collect::<Vec<_>>();
        let due = DUE.captures(body).map(|c| c[1].to_string());
        let title = clean_title(body);
        if title.is_empty() {
            continue; // a line that was nothing but tags
        }

        todos.push(ParsedTodo {
            line: index + 1,
            text: title,
            tags,
            due,
        });
    }
    todos
}

/// Today as `YYYY-MM-DD`. Kept separate so the overdue test doesn't depend on
/// the wall clock.
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn is_overdue(due: &str, today: &str) -> bool {
    // ISO dates compare correctly as strings, which avoids pulling a date
    // parser in just to answer "is this before today".
    due < today
}

/// Is this file an aggregate note we should skip?
///
/// A notebook app writes table-of-contents and task-roll-up notes that repeat
/// every todo underneath them. Scanning those reports each todo a second time,
/// pointing at a file you'd never edit.
///
/// An entry beginning with a dot is a *suffix* — `.toc.md` skips
/// `sprint.toc.md` and `team.toc.md` but leaves `roadmap.md` alone. Anything
/// else matches the whole file name, with or without its extension, so both
/// `index` and `index.md` work in the config.
pub fn is_excluded(file: &Path, excludes: &[String]) -> bool {
    let Some(name) = file.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
        return false;
    };
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    excludes.iter().any(|raw| {
        let wanted = raw.trim().to_lowercase();
        if wanted.is_empty() {
            return false;
        }
        if wanted.starts_with('.') {
            return name.ends_with(&wanted);
        }
        wanted == name || wanted == stem
    })
}

/// How specific a file is as the *home* of a todo, lower being better.
///
/// When the same todo text appears twice, the copy in a shallow, index-shaped
/// file is the generated one and the deeper note is where it actually lives —
/// so that is the one to keep and the one whose line number is worth opening.
fn specificity(relative: &Path) -> (usize, usize) {
    let stem = relative
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let index_shaped = usize::from(
        default_index_names().contains(&stem.as_str())
            // A note named after its own folder is the same convention.
            || relative
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_lowercase() == stem)
                .unwrap_or(false),
    );
    // Deeper wins among equals: a todo in Projects/Alpha/plan.md is more
    // specific than one repeated in Projects/plan.md.
    (index_shaped, usize::MAX - relative.components().count())
}

fn default_index_names() -> &'static [&'static str] {
    &[
        "index", "toc", "_toc", "contents", "_index", "readme", "home",
    ]
}

fn markdown_files(root: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if !entry.file_type().is_dir() {
                return true;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            !IGNORE_DIRS.contains(&name.as_str()) && !name.starts_with('.')
        })
        .flatten()
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
        })
        .map(|entry| entry.into_path())
        .collect()
}

/// The roots to scan: the config's own list, or the Markdown Notebook pointer
/// when it is empty.
pub fn resolve_roots(config: &TodosConfig) -> Vec<String> {
    let configured: Vec<String> = config
        .roots
        .iter()
        .filter(|r| !r.trim().is_empty())
        .cloned()
        .collect();
    if !configured.is_empty() {
        return configured;
    }
    let pointer = settings::read_notebook_pointer();
    if pointer.is_empty() {
        Vec::new()
    } else {
        vec![pointer]
    }
}

fn item_for(
    root: &Path,
    file: &Path,
    todo: &ParsedTodo,
    config: &TodosConfig,
    today: &str,
) -> Item {
    let relative = file.strip_prefix(root).unwrap_or(file);
    let relative_display = util::display_path(relative);
    let overdue = todo
        .due
        .as_deref()
        .map(|due| is_overdue(due, today))
        .unwrap_or(false);

    let mut item = Item::new(
        ID,
        format!("{}:{}", util::display_path(file), todo.line),
        todo.text.clone(),
    )
    .subtitle(format!("{relative_display}:{}", todo.line))
    .rich_title()
    .icon("check")
    .status(if overdue {
        Status::Warn
    } else {
        Status::Neutral
    })
    .keyword(relative_display);

    for tag in &todo.tags {
        item = item.badge(format!("#{tag}")).keyword(tag.clone());
    }
    if let Some(due) = &todo.due {
        item = item.badge(if overdue {
            format!("overdue {due}")
        } else {
            format!("due {due}")
        });
    }

    // Exactly one action, so a todo row is a single thing you click rather than
    // a menu of ways to look at it: open the note where the todo lives, on the
    // line.
    //
    // Three tiers, in order: whatever the config says, then Markdown Notebook
    // if it can be found on disk, then the OS default for .md. The middle tier
    // is the point — the two apps already find each other's *notebook*, so
    // finding each other's *binary* costs nothing and means a todo opens in the
    // right place with no configuration at all.
    let path_str = file.to_string_lossy().into_owned();
    let expand = |program: String, args: &[String]| Action::Run {
        label: "Open in Markdown Notebook".into(),
        program,
        args: args
            .iter()
            .map(|a| util::expand_placeholders(a, &path_str, Some(todo.line)))
            .collect(),
        cwd: None,
        capture: false,
    };

    let open = match config
        .open_with
        .as_ref()
        .filter(|o| !o.program.trim().is_empty())
    {
        Some(opener) => expand(opener.program.clone(), &opener.args),
        None => match crate::detect::markdown_notebook() {
            Some(program) => {
                let args: Vec<String> = crate::detect::NOTEBOOK_ARGS
                    .iter()
                    .map(|a| a.to_string())
                    .collect();
                expand(program.to_string_lossy().into_owned(), &args)
            }
            None => Action::OpenPath {
                label: "Open note".into(),
                path: path_str,
            },
        },
    };
    item.action(open)
}

fn scan(config: &TodosConfig) -> (Vec<Item>, Option<String>) {
    let roots = resolve_roots(config);
    if roots.is_empty() {
        return (
            Vec::new(),
            Some(
                "No notes folder found. Set todos.roots in hub.config.json, or open a notebook in \
                 Markdown Notebook once and Dev Hub will follow it."
                    .into(),
            ),
        );
    }

    let today = today();
    let wanted: Vec<String> = config
        .include_tags
        .iter()
        .map(|t| t.trim_start_matches('#').to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();

    // (specificity, item) — the key decides which copy of a repeated todo wins.
    let mut candidates: Vec<((usize, usize), Item)> = Vec::new();
    let mut problems = Vec::new();

    for root in &roots {
        let root_path = PathBuf::from(root);
        if !root_path.exists() {
            problems.push(format!("{root} does not exist"));
            continue;
        }
        for file in markdown_files(&root_path) {
            if is_excluded(&file, &config.exclude_files) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else {
                problems.push(format!("could not read {}", util::display_path(&file)));
                continue;
            };
            let relative = file.strip_prefix(&root_path).unwrap_or(&file).to_path_buf();
            for todo in parse_todos(&text) {
                if !wanted.is_empty()
                    && !todo.tags.iter().any(|t| wanted.contains(&t.to_lowercase()))
                {
                    continue;
                }
                candidates.push((
                    specificity(&relative),
                    item_for(&root_path, &file, &todo, config, &today),
                ));
            }
        }
    }

    // Collapse repeats. A generated directory index lists every todo beneath
    // it, so without this each one appears twice — once in the note where you'd
    // actually edit it, once in a file you'd never open. Keeping the most
    // specific occurrence means the row still opens the right line.
    if config.deduplicate {
        candidates.sort_by_key(|(specificity, _)| *specificity);
        let mut seen = std::collections::HashSet::new();
        candidates.retain(|(_, item)| seen.insert(dedupe_key(item)));
    }
    let mut items: Vec<Item> = candidates.into_iter().map(|(_, item)| item).collect();

    // Overdue first, then by due date, then by title — "what should I do next"
    // is the question, so undated work sinks below dated work.
    items.sort_by(|a, b| {
        let a_warn = a.status == Status::Warn;
        let b_warn = b.status == Status::Warn;
        b_warn
            .cmp(&a_warn)
            .then_with(|| due_key(a).cmp(&due_key(b)))
            .then_with(|| a.title.cmp(&b.title))
    });

    let error = (!problems.is_empty()).then(|| problems.join("; "));
    (items, error)
}

/// What makes two todos "the same one".
///
/// Text plus tags plus due date, case-folded and whitespace-normalised. Text
/// alone would merge two genuinely different `- [ ] follow up` lines; including
/// the metadata keeps those apart while still catching a verbatim copy.
fn dedupe_key(item: &Item) -> String {
    let title = item.title.to_lowercase();
    let mut badges = item.badges.clone();
    badges.sort();
    format!(
        "{}|{}",
        title.split_whitespace().collect::<Vec<_>>().join(" "),
        badges.join(",")
    )
}

/// Sortable due date, with undated todos pushed to the end.
fn due_key(item: &Item) -> String {
    item.badges
        .iter()
        .find_map(|b| {
            b.strip_prefix("due ")
                .or_else(|| b.strip_prefix("overdue "))
        })
        .unwrap_or("9999-99-99")
        .to_string()
}

#[async_trait::async_trait]
impl Provider for TodosProvider {
    fn id(&self) -> &str {
        ID
    }

    fn display_name(&self) -> &str {
        NAME
    }

    fn refresh_interval(&self) -> u64 {
        300
    }

    async fn items(&self, cfg: &ProviderConfig) -> ProviderResult {
        let config = cfg.todos.clone();
        match tokio::task::spawn_blocking(move || scan(&config)).await {
            Ok((items, error)) => {
                let mut result = ProviderResult::ok(ID, NAME, items);
                result.error = error;
                result
            }
            Err(err) => ProviderResult::failed(ID, NAME, format!("Todo scan failed: {err}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::TodoOpener;

    #[test]
    fn unchecked_boxes_are_todos_and_checked_ones_are_not() {
        let todos = parse_todos("- [ ] write the spec\n- [x] read the spec\n- [X] ship it\n");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].text, "write the spec");
        assert_eq!(todos[0].line, 1);
    }

    #[test]
    fn nested_and_numbered_list_markers_are_all_recognised() {
        let todos = parse_todos("- [ ] top\n    - [ ] nested\n* [ ] star\n1. [ ] numbered\n");
        assert_eq!(
            todos.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["top", "nested", "star", "numbered"]
        );
    }

    #[test]
    fn todos_inside_code_fences_are_ignored() {
        let text = "- [ ] real\n```md\n- [ ] example in a snippet\n```\n- [ ] also real\n";
        let todos = parse_todos(text);
        assert_eq!(
            todos.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["real", "also real"]
        );
    }

    #[test]
    fn tilde_fences_are_handled_too() {
        let todos = parse_todos("~~~\n- [ ] hidden\n~~~\n- [ ] visible\n");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].text, "visible");
    }

    #[test]
    fn line_numbers_are_one_based_so_editors_land_on_the_right_line() {
        let todos = parse_todos("# Heading\n\n- [ ] third line\n");
        assert_eq!(todos[0].line, 3);
    }

    #[test]
    fn tags_come_off_the_title_and_into_the_badges() {
        let todos = parse_todos("- [ ] renew the cert #ops #urgent\n");
        assert_eq!(todos[0].text, "renew the cert");
        assert_eq!(todos[0].tags, vec!["ops", "urgent"]);
    }

    #[test]
    fn wikilinks_collapse_to_their_display_text() {
        let todos = parse_todos("- [ ] review [[Auth Design]] before [[rfc-7|the RFC]]\n");
        assert_eq!(todos[0].text, "review Auth Design before the RFC");
    }

    #[test]
    fn due_dates_are_extracted_in_every_spelling_and_removed_from_the_title() {
        for line in [
            "- [ ] pay the invoice @due(2026-01-15)",
            "- [ ] pay the invoice @due:2026-01-15",
            "- [ ] pay the invoice @2026-01-15",
        ] {
            let todos = parse_todos(line);
            assert_eq!(todos[0].due.as_deref(), Some("2026-01-15"), "{line}");
            assert_eq!(todos[0].text, "pay the invoice", "{line}");
        }
    }

    #[test]
    fn a_past_due_date_is_overdue_and_todays_is_not() {
        assert!(is_overdue("2026-01-01", "2026-07-30"));
        assert!(!is_overdue("2026-07-30", "2026-07-30"));
        assert!(!is_overdue("2027-01-01", "2026-07-30"));
    }

    #[test]
    fn an_overdue_todo_renders_as_a_warning_with_an_overdue_badge() {
        let todo = ParsedTodo {
            line: 4,
            text: "ship the beta".into(),
            tags: vec!["release".into()],
            due: Some("2020-01-01".into()),
        };
        let item = item_for(
            Path::new("/notes"),
            Path::new("/notes/plans/q3.md"),
            &todo,
            &TodosConfig::default(),
            "2026-07-30",
        );
        assert_eq!(item.status, Status::Warn);
        assert_eq!(item.subtitle.as_deref(), Some("plans/q3.md:4"));
        assert!(item.badges.iter().any(|b| b == "#release"));
        assert!(item.badges.iter().any(|b| b.starts_with("overdue")));
    }

    #[test]
    fn the_configured_opener_gets_both_path_and_line_substituted() {
        let todo = ParsedTodo {
            line: 12,
            text: "fix it".into(),
            tags: vec![],
            due: None,
        };
        let config = TodosConfig {
            open_with: Some(TodoOpener {
                program: "code".into(),
                args: vec!["-g".into(), "{path}:{line}".into()],
            }),
            ..Default::default()
        };
        let item = item_for(
            Path::new("/notes"),
            Path::new("/notes/a.md"),
            &todo,
            &config,
            "2026-07-30",
        );
        match &item.actions[0] {
            Action::Run { program, args, .. } => {
                assert_eq!(program, "code");
                assert_eq!(args, &vec!["-g".to_string(), "/notes/a.md:12".to_string()]);
            }
            other => panic!("expected the configured opener, got {other:?}"),
        }
    }

    #[test]
    fn the_notebook_opener_passes_the_line_and_the_path_in_the_flag_form() {
        // A Windows path already contains a colon, so `--line N … <path>` is
        // what Markdown Notebook is handed rather than `path:line`.
        let args: Vec<String> = crate::detect::NOTEBOOK_ARGS
            .iter()
            .map(|a| util::expand_placeholders(a, "C:\\notes\\alpha.md", Some(42)))
            .collect();
        assert_eq!(
            args,
            vec!["--line", "42", "--view", "edit", "C:\\notes\\alpha.md"]
        );
    }

    #[test]
    fn a_todo_offers_exactly_one_action_so_the_row_is_a_single_thing_to_click() {
        let todo = ParsedTodo {
            line: 3,
            text: "ship it".into(),
            tags: vec![],
            due: None,
        };
        let configured = TodosConfig {
            open_with: Some(TodoOpener {
                program: "markdown-notebook.exe".into(),
                args: vec!["{path}".into()],
            }),
            ..Default::default()
        };
        for config in [TodosConfig::default(), configured] {
            let item = item_for(
                Path::new("/notes"),
                Path::new("/notes/a.md"),
                &todo,
                &config,
                "2026-07-30",
            );
            assert_eq!(item.actions.len(), 1, "{:?}", item.actions);
            assert!(item.action_groups.is_empty());
        }
    }

    #[test]
    fn todo_titles_are_flagged_as_markdown_so_bold_text_renders() {
        let todos = parse_todos("- [ ] ship the **beta** to `prod`\n");
        assert_eq!(todos[0].text, "ship the **beta** to `prod`");

        let item = item_for(
            Path::new("/notes"),
            Path::new("/notes/a.md"),
            &todos[0],
            &TodosConfig::default(),
            "2026-07-30",
        );
        assert!(item.rich_title, "the renderer needs to know to parse it");
    }

    #[test]
    fn with_no_opener_configured_the_note_can_still_be_opened() {
        let todo = ParsedTodo {
            line: 1,
            text: "x".into(),
            tags: vec![],
            due: None,
        };
        let item = item_for(
            Path::new("/notes"),
            Path::new("/notes/a.md"),
            &todo,
            &TodosConfig::default(),
            "2026-07-30",
        );
        assert!(matches!(item.actions[0], Action::OpenPath { .. }));
    }

    #[test]
    fn a_line_that_is_nothing_but_tags_is_not_a_todo() {
        assert!(parse_todos("- [ ] #ops\n").is_empty());
        assert!(parse_todos("- [ ]   \n").is_empty());
    }

    #[test]
    fn nothing_to_scan_is_reported_on_the_card() {
        let config = TodosConfig {
            roots: vec!["   ".into()],
            ..Default::default()
        };
        // resolve_roots falls through to the notebook pointer, which is absent
        // in a test environment — so this asserts the message, not the pointer.
        if resolve_roots(&config).is_empty() {
            let (items, error) = scan(&config);
            assert!(items.is_empty());
            assert!(error.unwrap().contains("hub.config.json"));
        }
    }

    #[test]
    fn generated_directory_indexes_are_excluded_by_name() {
        let excludes = TodosConfig::default().exclude_files;
        assert!(is_excluded(Path::new("/n/work/index.md"), &excludes));
        assert!(is_excluded(Path::new("/n/work/TOC.md"), &excludes));
        assert!(is_excluded(Path::new("/n/work/Contents.md"), &excludes));
        assert!(!is_excluded(Path::new("/n/work/plan.md"), &excludes));
        // Configured with the extension spelled out, which is the natural way
        // to write it in a config file.
        assert!(is_excluded(
            Path::new("/n/work/summary.md"),
            &["summary.md".to_string()]
        ));
    }

    #[test]
    fn aggregate_files_are_excluded_by_suffix_whatever_they_are_named() {
        let excludes = TodosConfig::default().exclude_files;
        assert!(is_excluded(Path::new("/n/work/sprint.toc.md"), &excludes));
        assert!(is_excluded(Path::new("/n/work/Team.Tasks.md"), &excludes));
        assert!(is_excluded(
            Path::new("/n/a/b/anything.tasks.md"),
            &excludes
        ));
        // A note that merely mentions the word is untouched.
        assert!(!is_excluded(Path::new("/n/work/toc-design.md"), &excludes));
        assert!(!is_excluded(
            Path::new("/n/work/tasks-for-friday.md"),
            &excludes
        ));
    }

    #[test]
    fn a_suffix_pattern_does_not_swallow_the_bare_name() {
        // ".toc.md" is about `<something>.toc.md`; a file called exactly
        // "toc.md" is caught by the separate whole-name entry, not this one.
        assert!(!is_excluded(
            Path::new("/n/toc.md"),
            &[".toc.md".to_string()]
        ));
    }

    #[test]
    fn a_todo_repeated_in_a_generated_index_is_reported_once_from_the_real_note() {
        let root = std::env::temp_dir().join(format!("dev-hub-dedupe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("work")).unwrap();
        std::fs::write(root.join("work").join("plan.md"), "- [ ] ship the beta\n").unwrap();
        // A generated folder index that repeats it, named something the
        // default exclude list does NOT cover — so this exercises the dedupe
        // rather than the name filter.
        std::fs::write(
            root.join("work").join("work.md"),
            "# Work\n\n- [ ] ship the beta\n",
        )
        .unwrap();

        let config = TodosConfig {
            roots: vec![root.to_string_lossy().into_owned()],
            ..Default::default()
        };
        let (items, _) = scan(&config);
        assert_eq!(
            items.len(),
            1,
            "{:?}",
            items.iter().map(|i| &i.subtitle).collect::<Vec<_>>()
        );
        assert_eq!(
            items[0].subtitle.as_deref(),
            Some("work/plan.md:1"),
            "the surviving row must open the note you'd actually edit"
        );

        // Switched off, both copies come back — the behaviour is a choice.
        let noisy = TodosConfig {
            deduplicate: false,
            ..config
        };
        assert_eq!(scan(&noisy).0.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn two_different_todos_that_merely_share_a_word_are_not_merged() {
        let root = std::env::temp_dir().join(format!("dev-hub-nodedupe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("a.md"),
            "- [ ] follow up #alpha\n- [ ] follow up #beta\n- [ ] review the design\n",
        )
        .unwrap();

        let config = TodosConfig {
            roots: vec![root.to_string_lossy().into_owned()],
            ..Default::default()
        };
        assert_eq!(scan(&config).0.len(), 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scanning_a_real_folder_finds_todos_and_skips_ignored_directories() {
        let root = std::env::temp_dir().join(format!("dev-hub-todos-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("templates")).unwrap();
        std::fs::create_dir_all(root.join("work")).unwrap();
        std::fs::write(root.join("work").join("plan.md"), "- [ ] real task #work\n").unwrap();
        std::fs::write(root.join("templates").join("t.md"), "- [ ] template task\n").unwrap();
        std::fs::write(root.join("notes.txt"), "- [ ] not markdown\n").unwrap();

        let config = TodosConfig {
            roots: vec![root.to_string_lossy().into_owned()],
            ..Default::default()
        };
        let (items, error) = scan(&config);
        assert_eq!(error, None);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "real task");

        // includeTags filters to a subset without changing anything else.
        let filtered = TodosConfig {
            include_tags: vec!["#nope".into()],
            ..config
        };
        assert!(scan(&filtered).0.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}

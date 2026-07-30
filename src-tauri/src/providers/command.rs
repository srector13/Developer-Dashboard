//! The escape hatch: run a user-configured command on an interval and read its
//! stdout as a JSON array of `Item`s.
//!
//! This is what makes Dev Hub extensible without a plugin ABI. Anything with a
//! CLI — `gh pr list`, a kubectl one-liner, a company script — becomes a card
//! and a launcher source with a config block and no recompile.
//!
//! The command comes from `hub.config.json` and nowhere else. The renderer
//! cannot add one, and the parsed items are re-stamped with this provider's id
//! so a command can't impersonate `projects` or inject an icon the renderer
//! doesn't know.

use super::{Provider, ProviderConfig};
use crate::model::{Item, ProviderResult};
use crate::settings::CommandProviderConfig;
use std::time::Duration;

pub struct CommandProvider {
    config: CommandProviderConfig,
}

impl CommandProvider {
    pub fn new(config: CommandProviderConfig) -> Self {
        Self { config }
    }
}

/// Parse a command's stdout. Accepts either a bare array of items or an object
/// with an `items` key, because both are natural things to emit.
pub fn parse_output(provider: &str, stdout: &str) -> Result<Vec<Item>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("stdout is not valid JSON: {e}"))?;

    let array = match value {
        serde_json::Value::Array(array) => array,
        serde_json::Value::Object(map) => match map.get("items") {
            Some(serde_json::Value::Array(array)) => array.clone(),
            _ => {
                return Err(
                    "expected a JSON array of items, or an object with an `items` array".into(),
                )
            }
        },
        _ => return Err("expected a JSON array of items".into()),
    };

    let mut items = Vec::new();
    for (index, entry) in array.into_iter().enumerate() {
        let mut item: Item = serde_json::from_value(entry)
            .map_err(|e| format!("item {index} is not a valid item: {e}"))?;
        if item.title.trim().is_empty() {
            return Err(format!("item {index} has no title"));
        }
        if item.id.trim().is_empty() {
            item.id = format!("{index}");
        }
        // Non-negotiable: an item belongs to the provider that produced it.
        item.provider = provider.to_string();
        items.push(item);
    }
    Ok(items)
}

async fn run(config: &CommandProviderConfig) -> Result<Vec<Item>, String> {
    if config.program.trim().is_empty() {
        return Err("no program configured".into());
    }
    let mut command = tokio::process::Command::new(&config.program);
    command.args(&config.args).kill_on_drop(true);
    if let Some(cwd) = config.cwd.as_deref().filter(|c| !c.trim().is_empty()) {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — otherwise every refresh flashes a console.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let timeout = Duration::from_millis(config.timeout_ms.max(500));
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| format!("timed out after {}ms", timeout.as_millis()))?
        .map_err(|e| format!("could not run `{}`: {e}", config.program))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first_line = stderr.lines().next().unwrap_or("").trim();
        return Err(if first_line.is_empty() {
            format!("`{}` exited with {}", config.program, output.status)
        } else {
            format!("`{}` failed: {first_line}", config.program)
        });
    }

    parse_output(&config.id, &String::from_utf8_lossy(&output.stdout))
}

#[async_trait::async_trait]
impl Provider for CommandProvider {
    fn id(&self) -> &str {
        &self.config.id
    }

    fn display_name(&self) -> &str {
        &self.config.name
    }

    fn refresh_interval(&self) -> u64 {
        self.config.interval_seconds
    }

    async fn items(&self, _cfg: &ProviderConfig) -> ProviderResult {
        match run(&self.config).await {
            Ok(items) => ProviderResult::ok(&self.config.id, &self.config.name, items),
            Err(err) => ProviderResult::failed(&self.config.id, &self.config.name, err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Action, Status};

    #[test]
    fn a_bare_array_of_items_parses() {
        let items = parse_output(
            "prs",
            r#"[{"id":"1","title":"Fix the thing","status":"warn",
                 "actions":[{"kind":"openUrl","label":"Open","url":"https://example.com/1"}]}]"#,
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Fix the thing");
        assert_eq!(items[0].status, Status::Warn);
        assert!(matches!(items[0].actions[0], Action::OpenUrl { .. }));
    }

    #[test]
    fn an_object_with_an_items_key_parses_too() {
        let items = parse_output("prs", r#"{"items":[{"id":"a","title":"One"}]}"#).unwrap();
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn a_command_cannot_claim_to_be_another_provider() {
        let items = parse_output(
            "prs",
            r#"[{"id":"x","provider":"projects","title":"Sneaky"}]"#,
        )
        .unwrap();
        assert_eq!(items[0].provider, "prs");
    }

    #[test]
    fn empty_output_is_an_empty_list_not_an_error() {
        assert!(parse_output("prs", "   \n").unwrap().is_empty());
    }

    #[test]
    fn malformed_json_is_reported_so_the_card_can_show_it() {
        let err = parse_output("prs", "not json").unwrap_err();
        assert!(err.contains("not valid JSON"), "{err}");
    }

    #[test]
    fn a_non_array_payload_is_rejected_with_a_useful_message() {
        let err = parse_output("prs", r#"{"nope":1}"#).unwrap_err();
        assert!(err.contains("items"), "{err}");
    }

    #[test]
    fn an_item_without_a_title_is_rejected_rather_than_rendering_blank() {
        let err = parse_output("prs", r#"[{"id":"1","title":"  "}]"#).unwrap_err();
        assert!(err.contains("no title"), "{err}");
    }

    #[test]
    fn a_missing_id_falls_back_to_the_index_so_items_stay_addressable() {
        let items = parse_output("prs", r#"[{"title":"One"},{"title":"Two"}]"#).unwrap();
        assert_eq!(items[0].id, "0");
        assert_eq!(items[1].id, "1");
    }

    #[tokio::test]
    async fn a_program_that_does_not_exist_fails_the_card_not_the_app() {
        let result = run(&CommandProviderConfig {
            id: "nope".into(),
            name: "Nope".into(),
            program: "definitely-not-a-real-program-xyz".into(),
            args: vec![],
            cwd: None,
            interval_seconds: 300,
            timeout_ms: 2000,
        })
        .await;
        assert!(result.unwrap_err().contains("could not run"));
    }

    #[tokio::test]
    async fn a_nonzero_exit_surfaces_stderr() {
        // `false` exists on every platform CI runs on except Windows, where the
        // equivalent is a cmd builtin; skip there rather than shelling out.
        if cfg!(windows) {
            return;
        }
        let result = run(&CommandProviderConfig {
            id: "fail".into(),
            name: "Fail".into(),
            program: "sh".into(),
            args: vec!["-c".into(), "echo boom >&2; exit 3".into()],
            cwd: None,
            interval_seconds: 300,
            timeout_ms: 2000,
        })
        .await;
        assert!(result.unwrap_err().contains("boom"));
    }

    #[tokio::test]
    async fn a_command_that_hangs_is_killed_at_the_timeout() {
        if cfg!(windows) {
            return;
        }
        let result = run(&CommandProviderConfig {
            id: "slow".into(),
            name: "Slow".into(),
            program: "sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            cwd: None,
            interval_seconds: 300,
            timeout_ms: 500,
        })
        .await;
        assert!(result.unwrap_err().contains("timed out"));
    }
}

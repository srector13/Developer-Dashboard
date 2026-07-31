//! The core abstraction.
//!
//! Everything in Dev Hub is a *provider* that yields *items* that carry
//! *actions*. The launcher is every provider's items flattened and fuzzy
//! matched; the dashboard is the same items rendered as cards. There is
//! deliberately no second code path for "dashboard data" vs "launcher data" —
//! both read the same cache in `state::AppState`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Stable within a provider across refreshes, so selection and usage
    /// ranking survive a rescan. Defaulted on read because a `command`
    /// provider's JSON may omit it; the parser then fills in the row index.
    #[serde(default)]
    pub id: String,
    /// Provider id, e.g. "projects". Defaulted on read and always overwritten
    /// by the provider that produced the item, so a command can't claim to be
    /// a different card.
    #[serde(default)]
    pub provider: String,
    pub title: String,
    /// Render `title` as inline markdown rather than plain text.
    ///
    /// A todo written `- [ ] **ship** the beta` should read as it does in the
    /// note. Off by default: a repo name containing an underscore is a repo
    /// name, not an italic.
    #[serde(default)]
    pub rich_title: bool,
    #[serde(default)]
    pub subtitle: Option<String>,
    /// A token from the renderer's fixed icon set — never raw SVG, which would
    /// let a `command` provider inject markup into both windows.
    #[serde(default)]
    pub icon: Option<String>,
    /// A per-item colour, set by the user rather than a provider. Validated as
    /// a hex literal before it is stored — it ends up in a style attribute.
    #[serde(default)]
    pub accent: Option<String>,
    /// A user-supplied image as a `data:` URI, shown instead of `icon`.
    #[serde(default)]
    pub icon_data: Option<String>,
    /// "high" | "medium" | "low". Drives the marker and the sort order.
    #[serde(default)]
    pub priority: Option<String>,
    /// Drives the dashboard's status dot.
    #[serde(default)]
    pub status: Status,
    /// Short chips, e.g. ["main", "dirty", "↑3"].
    #[serde(default)]
    pub badges: Vec<String>,
    /// Extra fuzzy-match text that is never displayed.
    #[serde(default)]
    pub keywords: Vec<String>,
    /// `actions[0]` is the default: Enter in the launcher, row click on a card.
    #[serde(default)]
    pub actions: Vec<Action>,
    /// Actions that belong together behind one menu.
    ///
    /// A repo with four configured editors would otherwise put four buttons on
    /// its row, which is a worse version of a menu. Grouping is advisory — the
    /// actions stay addressable by index either way, so a renderer that ignores
    /// this still works.
    #[serde(default)]
    pub action_groups: Vec<ActionGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionGroup {
    /// What the menu button says, e.g. "Open with".
    pub label: String,
    /// Indices into `Item::actions`.
    pub actions: Vec<usize>,
}

impl Item {
    /// A globally unique key: item ids are only unique within their provider.
    pub fn key(&self) -> String {
        format!("{}::{}", self.provider, self.id)
    }

    pub fn new(provider: &str, id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            provider: provider.to_string(),
            title: title.into(),
            rich_title: false,
            subtitle: None,
            icon: None,
            accent: None,
            icon_data: None,
            priority: None,
            status: Status::Neutral,
            badges: Vec::new(),
            keywords: Vec::new(),
            actions: Vec::new(),
            action_groups: Vec::new(),
        }
    }

    /// Group the actions added since `from` under one menu label. Called after
    /// the actions themselves, so the indices are already known.
    pub fn group_from(mut self, label: &str, from: usize) -> Self {
        let indices: Vec<usize> = (from..self.actions.len()).collect();
        if !indices.is_empty() {
            self.action_groups.push(ActionGroup {
                label: label.to_string(),
                actions: indices,
            });
        }
        self
    }

    pub fn subtitle(mut self, subtitle: impl Into<String>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// Mark the title as inline markdown — see `Item::rich_title`.
    pub fn rich_title(mut self) -> Self {
        self.rich_title = true;
        self
    }

    pub fn icon(mut self, icon: &str) -> Self {
        self.icon = Some(icon.to_string());
        self
    }

    pub fn priority(mut self, priority: Option<String>) -> Self {
        self.priority = priority;
        self
    }

    pub fn status(mut self, status: Status) -> Self {
        self.status = status;
        self
    }

    pub fn badge(mut self, badge: impl Into<String>) -> Self {
        self.badges.push(badge.into());
        self
    }

    pub fn keyword(mut self, keyword: impl Into<String>) -> Self {
        self.keywords.push(keyword.into());
        self
    }

    pub fn action(mut self, action: Action) -> Self {
        self.actions.push(action);
        self
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Neutral,
    Ok,
    Warn,
    Error,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    OpenUrl {
        label: String,
        url: String,
    },
    /// A file or a folder, handed to the platform opener.
    OpenPath {
        label: String,
        path: String,
    },
    Run {
        label: String,
        program: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        /// `false` → fire and forget; `true` → wait and return stdout/stderr.
        #[serde(default)]
        capture: bool,
    },
    CopyText {
        label: String,
        text: String,
    },
    /// `explorer /select,<path>` on Windows; the containing folder elsewhere.
    Reveal {
        label: String,
        path: String,
    },
}

impl Action {
    pub fn label(&self) -> &str {
        match self {
            Action::OpenUrl { label, .. }
            | Action::OpenPath { label, .. }
            | Action::Run { label, .. }
            | Action::CopyText { label, .. }
            | Action::Reveal { label, .. } => label,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    pub provider: String,
    /// Human-readable provider name, so a card can render before the renderer
    /// has seen `list_providers`.
    pub display_name: String,
    pub items: Vec<Item>,
    /// Shown on the card. A failing provider must never look like an empty one.
    pub error: Option<String>,
    /// Unix seconds. 0 means "never refreshed" — the card renders as pending.
    pub refreshed_at: i64,
}

impl ProviderResult {
    pub fn ok(provider: &str, display_name: &str, items: Vec<Item>) -> Self {
        Self {
            provider: provider.to_string(),
            display_name: display_name.to_string(),
            items,
            error: None,
            refreshed_at: crate::util::now_secs(),
        }
    }

    pub fn failed(provider: &str, display_name: &str, error: impl Into<String>) -> Self {
        Self {
            provider: provider.to_string(),
            display_name: display_name.to_string(),
            items: Vec::new(),
            error: Some(error.into()),
            refreshed_at: crate::util::now_secs(),
        }
    }

    pub fn pending(provider: &str, display_name: &str) -> Self {
        Self {
            provider: provider.to_string(),
            display_name: display_name.to_string(),
            items: Vec::new(),
            error: None,
            refreshed_at: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_serialize_with_camel_case_keys_and_a_lowercase_status() {
        let item = Item::new("projects", "repo-1", "dev-hub")
            .subtitle("C:\\dev\\dev-hub")
            .status(Status::Warn);
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["provider"], "projects");
        assert_eq!(json["status"], "warn");
        assert!(json.get("subtitle").is_some());
    }

    #[test]
    fn actions_serialize_with_a_kind_tag_the_renderer_can_switch_on() {
        let action = Action::Run {
            label: "IntelliJ".into(),
            program: "idea64.exe".into(),
            args: vec!["C:\\dev".into()],
            cwd: None,
            capture: false,
        };
        let json = serde_json::to_value(&action).unwrap();
        assert_eq!(json["kind"], "run");
        assert_eq!(json["label"], "IntelliJ");
    }

    #[test]
    fn item_keys_are_namespaced_by_provider() {
        let a = Item::new("launch", "jenkins", "Jenkins");
        let b = Item::new("projects", "jenkins", "jenkins");
        assert_ne!(a.key(), b.key());
    }

    #[test]
    fn a_pending_result_is_distinguishable_from_an_empty_one() {
        assert_eq!(ProviderResult::pending("health", "Health").refreshed_at, 0);
        assert!(ProviderResult::ok("health", "Health", vec![]).refreshed_at > 0);
    }
}

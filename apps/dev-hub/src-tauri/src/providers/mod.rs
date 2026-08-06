//! The provider trait, and nothing else.
//!
//! Adding a provider is: a new file in this directory, a `pub mod` line here,
//! a config block in `settings.rs`, and one line in `registry::build`. That is
//! the whole seam — see §11 of the spec for the calendar provider this is
//! deliberately left clean for.

pub mod command;
pub mod health;
pub mod launch;
pub mod logs;
pub mod projects;
pub mod todos;

use suite_core::model::ProviderResult;

/// Providers read the user's content config directly. It is a type alias rather
/// than a wrapper struct so there is exactly one config shape in the codebase.
pub use crate::settings::HubConfig as ProviderConfig;

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    /// Stable id, unique across providers. It is `&str` rather than
    /// `&'static str` because a `command` provider's id comes from the user's
    /// config file and so cannot be a compile-time constant.
    fn id(&self) -> &str;

    fn display_name(&self) -> &str;

    /// Seconds between background refreshes. 0 = manual/on-demand only.
    fn refresh_interval(&self) -> u64;

    /// Never panics; failure comes back as `ProviderResult.error` so the card
    /// can say what went wrong instead of rendering as empty.
    async fn items(&self, cfg: &ProviderConfig) -> ProviderResult;
}

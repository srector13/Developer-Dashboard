//! The vocabulary every app in the suite shares.
//!
//! Dev Hub's provider → item → action model turned out not to be Dev Hub's at
//! all: a log source is an item with a "tail this" action, a saved filter is an
//! item with an "apply" action. Anything that ends up in a launcher list or on
//! a card speaks this language, so it lives here rather than in the app that
//! happened to need it first.
//!
//! Nothing in this crate knows about Tauri, windows, or the filesystem layout.
//! That is deliberate — it keeps the model testable with `cargo test -p
//! suite-core`, which runs in well under a second.

pub mod model;
pub mod search;
pub mod util;

pub use model::{Action, ActionGroup, Item, ProviderResult, Status};

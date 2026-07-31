//! HTTP health checks against endpoints listed in `hub.config.json`.
//!
//! This is the only outbound network traffic Dev Hub makes on its own, and it
//! only ever goes to URLs the user typed into their own config file. There is
//! no update check, no telemetry and no discovery.

use super::{Provider, ProviderConfig};
use crate::model::{Action, Item, ProviderResult, Status};
use crate::settings::{HealthConfig, HealthEndpoint};
use std::time::{Duration, Instant};

pub const ID: &str = "health";
pub const NAME: &str = "Health";

pub struct HealthProvider {
    /// Taken from `health.intervalSeconds` when the registry builds it, so the
    /// user's config drives the polling rate rather than a constant.
    pub interval: u64,
}

/// The outcome of one probe, before it becomes an `Item`.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub name: String,
    pub url: String,
    pub expect: u16,
    pub status_code: Option<u16>,
    pub latency_ms: u128,
    pub error: Option<String>,
}

impl Probe {
    fn healthy(&self) -> bool {
        self.status_code == Some(self.expect)
    }

    /// Answering correctly but slowly. Reported as a warning rather than an
    /// error: the service is up, and saying otherwise would cry wolf.
    fn slow(&self, slow_ms: u64) -> bool {
        self.healthy() && slow_ms > 0 && self.latency_ms >= slow_ms as u128
    }
}

pub fn item_for(probe: &Probe, slow_ms: u64) -> Item {
    let subtitle = match (&probe.error, probe.status_code) {
        (Some(error), _) => error.clone(),
        (None, Some(code)) => format!("{code} · {}ms", probe.latency_ms),
        (None, None) => "no response".to_string(),
    };

    let status = if !probe.healthy() {
        Status::Error
    } else if probe.slow(slow_ms) {
        Status::Warn
    } else {
        Status::Ok
    };

    let mut item = Item::new(ID, probe.url.clone(), probe.name.clone())
        .subtitle(subtitle)
        .icon("health")
        .status(status)
        .keyword(probe.url.clone())
        .action(Action::OpenUrl {
            label: "Open in browser".into(),
            url: probe.url.clone(),
        })
        .action(Action::CopyText {
            label: "Copy URL".into(),
            text: probe.url.clone(),
        });

    if let Some(code) = probe.status_code {
        item = item.badge(code.to_string());
        if code != probe.expect {
            item = item.badge(format!("expected {}", probe.expect));
        }
    } else {
        item = item.badge("unreachable");
    }
    if probe.slow(slow_ms) {
        item = item.badge("slow");
    }
    item
}

/// Probe one endpoint. Never returns an error: an unreachable host is a
/// result, not a failure of the provider.
pub async fn probe(
    client: &reqwest::Client,
    endpoint: &HealthEndpoint,
    timeout: Duration,
) -> Probe {
    let started = Instant::now();
    let response = client.get(&endpoint.url).timeout(timeout).send().await;
    let latency_ms = started.elapsed().as_millis();

    match response {
        Ok(response) => Probe {
            name: endpoint.name.clone(),
            url: endpoint.url.clone(),
            expect: endpoint.expect,
            status_code: Some(response.status().as_u16()),
            latency_ms,
            error: None,
        },
        Err(err) => Probe {
            name: endpoint.name.clone(),
            url: endpoint.url.clone(),
            expect: endpoint.expect,
            status_code: None,
            latency_ms,
            // reqwest's Display includes the URL; the short form reads better
            // on a card and the URL is already the subtitle's neighbour.
            error: Some(short_error(&err)),
        },
    }
}

fn short_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "timed out".to_string()
    } else if err.is_connect() {
        "connection refused".to_string()
    } else {
        let text = err.to_string();
        text.split(':').next().unwrap_or(&text).trim().to_string()
    }
}

pub async fn check_all(config: &HealthConfig) -> (Vec<Item>, Option<String>) {
    if config.endpoints.is_empty() {
        return (
            Vec::new(),
            Some(
                "No endpoints configured — add some to health.endpoints in hub.config.json.".into(),
            ),
        );
    }

    let timeout = Duration::from_millis(config.timeout_ms.max(250));
    let client = match reqwest::Client::builder()
        // Redirects are followed: a health endpoint behind a login redirect
        // still tells you the host is up.
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("dev-hub")
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            return (
                Vec::new(),
                Some(format!("Could not start the HTTP client: {err}")),
            )
        }
    };

    // Concurrent, so N slow endpoints cost one timeout rather than N.
    let mut set = tokio::task::JoinSet::new();
    for (index, endpoint) in config.endpoints.iter().enumerate() {
        let client = client.clone();
        let endpoint = endpoint.clone();
        set.spawn(async move { (index, probe(&client, &endpoint, timeout).await) });
    }

    let mut probes: Vec<(usize, Probe)> = Vec::new();
    let mut problems = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(result) => probes.push(result),
            Err(err) => problems.push(format!("a check did not finish: {err}")),
        }
    }
    // Config order, not completion order — a list that reshuffles itself every
    // minute is unreadable.
    probes.sort_by_key(|(index, _)| *index);

    let items = probes
        .iter()
        .map(|(_, probe)| item_for(probe, config.slow_ms))
        .collect();
    let error = (!problems.is_empty()).then(|| problems.join("; "));
    (items, error)
}

#[async_trait::async_trait]
impl Provider for HealthProvider {
    fn id(&self) -> &str {
        ID
    }

    fn display_name(&self) -> &str {
        NAME
    }

    fn refresh_interval(&self) -> u64 {
        self.interval.max(10)
    }

    async fn items(&self, cfg: &ProviderConfig) -> ProviderResult {
        let (items, error) = check_all(&cfg.health).await;
        let mut result = ProviderResult::ok(ID, NAME, items);
        result.error = error;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_of(status_code: Option<u16>, expect: u16, error: Option<&str>) -> Probe {
        Probe {
            name: "API — dev".into(),
            url: "https://api.dev.example.com/health".into(),
            expect,
            status_code,
            latency_ms: 42,
            error: error.map(|e| e.to_string()),
        }
    }

    /// A threshold no fixture latency can reach, for the tests that aren't
    /// about slowness.
    const NEVER_SLOW: u64 = 100_000;

    #[test]
    fn a_correct_but_slow_response_is_a_warning_not_a_failure() {
        // 42ms against a 20ms threshold: up, but degraded.
        let item = item_for(&probe_of(Some(200), 200, None), 20);
        assert_eq!(item.status, Status::Warn);
        assert!(item.badges.iter().any(|b| b == "slow"));

        // A service that is already failing is not additionally "slow" — one
        // problem, one colour.
        let failing = item_for(&probe_of(Some(500), 200, None), 20);
        assert_eq!(failing.status, Status::Error);
        assert!(!failing.badges.iter().any(|b| b == "slow"));
    }

    #[test]
    fn a_zero_threshold_switches_the_latency_warning_off() {
        let item = item_for(&probe_of(Some(200), 200, None), 0);
        assert_eq!(item.status, Status::Ok);
        assert!(!item.badges.iter().any(|b| b == "slow"));
    }

    #[test]
    fn the_expected_status_code_is_ok_and_anything_else_is_an_error() {
        assert_eq!(
            item_for(&probe_of(Some(200), 200, None), NEVER_SLOW).status,
            Status::Ok
        );
        assert_eq!(
            item_for(&probe_of(Some(503), 200, None), NEVER_SLOW).status,
            Status::Error
        );
        // A non-200 expectation is honoured, not assumed.
        assert_eq!(
            item_for(&probe_of(Some(204), 204, None), NEVER_SLOW).status,
            Status::Ok
        );
    }

    #[test]
    fn a_healthy_check_shows_its_code_and_latency() {
        let item = item_for(&probe_of(Some(200), 200, None), NEVER_SLOW);
        assert_eq!(item.subtitle.as_deref(), Some("200 · 42ms"));
        assert!(item.badges.iter().any(|b| b == "200"));
    }

    #[test]
    fn a_wrong_code_says_what_was_expected() {
        let item = item_for(&probe_of(Some(500), 200, None), NEVER_SLOW);
        assert!(item.badges.iter().any(|b| b == "expected 200"));
    }

    #[test]
    fn an_unreachable_host_shows_the_reason_rather_than_an_empty_row() {
        let item = item_for(&probe_of(None, 200, Some("connection refused")), NEVER_SLOW);
        assert_eq!(item.status, Status::Error);
        assert_eq!(item.subtitle.as_deref(), Some("connection refused"));
        assert!(item.badges.iter().any(|b| b == "unreachable"));
    }

    #[test]
    fn every_check_is_openable_in_a_browser() {
        let item = item_for(&probe_of(Some(200), 200, None), NEVER_SLOW);
        match &item.actions[0] {
            Action::OpenUrl { url, .. } => assert_eq!(url, "https://api.dev.example.com/health"),
            other => panic!("expected an openUrl action, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn no_endpoints_is_a_message_on_the_card_not_a_silent_empty_list() {
        let (items, error) = check_all(&HealthConfig::default()).await;
        assert!(items.is_empty());
        assert!(error.unwrap().contains("hub.config.json"));
    }

    #[tokio::test]
    async fn an_unreachable_endpoint_produces_an_error_item_and_no_provider_error() {
        let config = HealthConfig {
            timeout_ms: 500,
            // Port 1 is never listening, so this exercises the failure path
            // without depending on the network.
            endpoints: vec![HealthEndpoint {
                name: "nowhere".into(),
                url: "http://127.0.0.1:1/health".into(),
                expect: 200,
            }],
            ..Default::default()
        };
        let (items, error) = check_all(&config).await;
        assert_eq!(
            error, None,
            "a down service is a result, not a provider failure"
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].status, Status::Error);
    }
}

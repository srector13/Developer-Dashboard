//! Optional local AI, off by default. Talks only to a model server on the
//! user's own machine — note content never leaves it. Ollama speaks its native
//! /api/chat; LM Studio speaks the OpenAI-compatible /v1/chat/completions.

use crate::settings::AppSettings;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
}

impl AiResult {
    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            text: None,
            error: Some(msg.into()),
            models: None,
        }
    }
    fn text(t: String) -> Self {
        Self {
            ok: true,
            text: Some(t),
            error: None,
            models: None,
        }
    }
}

pub fn base_url(settings: &AppSettings) -> String {
    if !settings.ai.base_url.is_empty() {
        return settings.ai.base_url.trim_end_matches('/').to_string();
    }
    if settings.ai.provider == "lmstudio" {
        "http://localhost:1234".into()
    } else {
        "http://localhost:11434".into()
    }
}

fn provider_label(settings: &AppSettings) -> &'static str {
    if settings.ai.provider == "lmstudio" {
        "LM Studio"
    } else {
        "Ollama"
    }
}

/// Every prompt shares the header-protection contract. The renderer ALSO
/// strips the YAML frontmatter/H1/Related lines mechanically before the text
/// ever reaches the model, so the header survives even a model that ignores
/// instructions.
const AI_HARD_RULES: &str = concat!(
    "Hard rules — never break these:\n",
    "- Do NOT alter the note's custom header: any YAML frontmatter (--- ... --- block), the first H1 title line, and any \"**Related:**\" links line must be returned character-for-character unchanged, in their original position.\n",
    "- Keep [[wiki-links]], #tags, task checkboxes (\"- [ ]\" / \"- [x]\"), ```mermaid blocks, HTML comments, and image/attachment paths exactly as written."
);

fn transform_prompt(mode: &str) -> Option<String> {
    let prompt = match mode {
        "polish" => format!(
            concat!(
                "You are a markdown formatting assistant inside a note-taking app. The user gives you one note; you return the same note, cleaned up.\n",
                "\n",
                "What to improve:\n",
                "- Fix heading hierarchy and spacing between sections.\n",
                "- Normalize list formatting (bullets, numbering, indentation) and table alignment.\n",
                "- Repair broken or unlabeled code fences.\n",
                "- Correct obvious typos and punctuation. You may lightly smooth wording, but never change meaning, drop information, or invent content that is not in the note.\n",
                "\n",
                "{}\n",
                "- Return ONLY the reformatted markdown. No commentary, no explanations, and no wrapping code fence around the whole note."
            ),
            AI_HARD_RULES
        ),
        "summarize" => concat!(
            "You are a summarizing assistant inside a note-taking app. The user gives you one markdown note.\n",
            "Write a 1-3 sentence TL;DR of the note: the key facts, decisions, or takeaways. Plain sentences, no headings, no bullet list, no preamble.\n",
            "Return ONLY the summary text — it will be inserted into a \"> **TL;DR:**\" callout, so do not include \"TL;DR\" yourself."
        )
        .to_string(),
        "tasks" => concat!(
            "You are a task-extraction assistant inside a note-taking app. The user gives you one markdown note.\n",
            "Find every action item, commitment, follow-up, or to-do implied by the note and return them as a markdown task list: one \"- [ ] item\" per line.\n",
            "Skip tasks the note already lists as checkboxes. If there are no new action items, return exactly: NONE\n",
            "Return ONLY the task lines (or NONE) — no headings, no commentary."
        )
        .to_string(),
        "tags" => concat!(
            "You are a tagging assistant inside a note-taking app. The user gives you one markdown note.\n",
            "Suggest 3-6 short lowercase topic tags for it (single words or hyphenated-words, no # prefix).\n",
            "Return ONLY the tags as one comma-separated line, e.g.: planning, budget, q3-review"
        )
        .to_string(),
        _ => return None,
    };
    Some(prompt)
}

const AI_COMPLETE_SYSTEM_PROMPT: &str = concat!(
    "You autocomplete markdown notes. The user gives you the text before their cursor.\n",
    "Continue it naturally with ONE short completion: at most one sentence, or one list item if the cursor is in a list.\n",
    "Return ONLY the continuation text. Do not repeat any text the user already wrote, do not wrap it in quotes or a code fence, and do not explain."
);

/// Reasoning models prepend `<think>` blocks; some models wrap the whole reply
/// in a markdown fence despite instructions. Strip both.
pub fn clean_model_output(content: &str) -> String {
    static THINK: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)^<think>.*?</think>\s*").unwrap());
    static FENCE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?s)^```(?:markdown|md)?\s*\n(.*?)\n```\s*$").unwrap());
    let stripped = THINK.replace(content, "").into_owned();
    match FENCE.captures(&stripped) {
        Some(caps) => caps.get(1).map(|m| m.as_str().to_string()).unwrap_or(stripped),
        None => stripped,
    }
}

/// One chat round-trip against whichever provider is configured.
async fn chat(
    settings: &AppSettings,
    messages: Vec<serde_json::Value>,
    max_tokens: u32,
    timeout: Duration,
) -> Result<String, String> {
    let base = base_url(settings);
    let model = settings.ai.model.trim().to_string();
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;

    let content = if settings.ai.provider == "lmstudio" {
        let res = client
            .post(format!("{base}/v1/chat/completions"))
            .json(&serde_json::json!({
                "model": model,
                "messages": messages,
                "temperature": 0.2,
                "stream": false,
                "max_tokens": max_tokens,
            }))
            .send()
            .await
            .map_err(|e| describe(e, settings))?;
        let json = check(res).await?;
        json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string()
    } else {
        let res = client
            .post(format!("{base}/api/chat"))
            .json(&serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": false,
                "options": { "temperature": 0.2, "num_predict": max_tokens },
            }))
            .send()
            .await
            .map_err(|e| describe(e, settings))?;
        let json = check(res).await?;
        json["message"]["content"].as_str().unwrap_or("").to_string()
    };

    Ok(clean_model_output(&content))
}

async fn check(res: reqwest::Response) -> Result<serde_json::Value, String> {
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }
    res.json().await.map_err(|e| e.to_string())
}

fn describe(err: reqwest::Error, settings: &AppSettings) -> String {
    if err.is_timeout() {
        return "__TIMEOUT__".to_string();
    }
    if err.is_connect() {
        return format!(
            "Could not reach {} — is {} running?",
            base_url(settings),
            provider_label(settings)
        );
    }
    err.to_string()
}

fn with_timeout_hint(err: String, hint: &str) -> String {
    if err == "__TIMEOUT__" {
        hint.to_string()
    } else {
        err
    }
}

pub async fn transform(settings: &AppSettings, mode: &str, text: &str) -> AiResult {
    if !settings.ai.enabled {
        return AiResult::err("Local AI is disabled — enable it in Settings first.");
    }
    if settings.ai.model.trim().is_empty() {
        return AiResult::err(
            "No model configured — set one in Settings (use Test to list what's installed).",
        );
    }
    if text.trim().is_empty() {
        return AiResult::err("This note has no content to work with yet.");
    }
    let Some(system) = transform_prompt(mode) else {
        return AiResult::err(format!("Unknown AI action: {mode}"));
    };

    let messages = vec![
        serde_json::json!({ "role": "system", "content": system }),
        serde_json::json!({ "role": "user", "content": text }),
    ];
    // Local models can be slow, so allow three minutes.
    let max_tokens = if mode == "polish" { 4096 } else { 512 };
    match chat(settings, messages, max_tokens, Duration::from_secs(180)).await {
        Ok(content) if content.trim().is_empty() => {
            AiResult::err("The model returned an empty response — try a different model.")
        }
        Ok(content) => AiResult::text(content),
        Err(err) => AiResult::err(with_timeout_hint(
            err,
            "Timed out waiting for the model (3 min). A smaller/faster model may work better.",
        )),
    }
}

/// Ghost-text completion: short, fast, and quiet — failures return ok:false
/// with no user-facing noise (the renderer just doesn't show a suggestion).
pub async fn complete(settings: &AppSettings, context: &str) -> AiResult {
    if !settings.ai.enabled || !settings.ai.autocomplete {
        return AiResult::err("disabled");
    }
    if settings.ai.model.trim().is_empty() {
        return AiResult::err("no model");
    }
    if context.trim().is_empty() {
        return AiResult::err("no context");
    }
    let messages = vec![
        serde_json::json!({ "role": "system", "content": AI_COMPLETE_SYSTEM_PROMPT }),
        serde_json::json!({ "role": "user", "content": context }),
    ];
    match chat(settings, messages, 48, Duration::from_secs(20)).await {
        Ok(content) if content.trim().is_empty() => AiResult::err("empty"),
        Ok(content) => AiResult::text(content.trim_end().to_string()),
        Err(err) => AiResult::err(with_timeout_hint(err, "timeout")),
    }
}

/// Reachability probe + model listing for the Settings "Test" button.
pub async fn list_models(settings: &AppSettings) -> AiResult {
    let base = base_url(settings);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(err) => return AiResult::err(err.to_string()),
    };

    let (url, key) = if settings.ai.provider == "lmstudio" {
        (format!("{base}/v1/models"), "data")
    } else {
        (format!("{base}/api/tags"), "models")
    };

    let result: Result<Vec<String>, String> = async {
        let res = client.get(&url).send().await.map_err(|e| {
            if e.is_timeout() {
                format!(
                    "Timed out reaching {base} — is {} running?",
                    provider_label(settings)
                )
            } else {
                format!(
                    "Could not reach {base} — is {} running? ({e})",
                    provider_label(settings)
                )
            }
        })?;
        let json = check(res).await?;
        let field = if key == "data" { "id" } else { "name" };
        Ok(json[key]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|m| m[field].as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default())
    }
    .await;

    match result {
        Ok(models) => AiResult {
            ok: true,
            text: None,
            error: None,
            models: Some(models),
        },
        Err(err) => AiResult::err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_base_urls_match_each_provider() {
        let mut settings = AppSettings::default();
        assert_eq!(base_url(&settings), "http://localhost:11434");
        settings.ai.provider = "lmstudio".into();
        assert_eq!(base_url(&settings), "http://localhost:1234");
    }

    #[test]
    fn a_configured_base_url_wins_and_loses_its_trailing_slash() {
        let mut settings = AppSettings::default();
        settings.ai.base_url = "http://192.168.0.5:11434///".into();
        assert_eq!(base_url(&settings), "http://192.168.0.5:11434");
    }

    #[test]
    fn think_blocks_are_stripped() {
        assert_eq!(
            clean_model_output("<think>reasoning\nmore</think>\n\nActual answer"),
            "Actual answer"
        );
    }

    #[test]
    fn a_wrapping_code_fence_is_unwrapped() {
        assert_eq!(clean_model_output("```markdown\n# Note\nbody\n```"), "# Note\nbody");
        assert_eq!(clean_model_output("```\ntext\n```"), "text");
    }

    #[test]
    fn inner_fences_are_preserved() {
        let src = "Here is code:\n\n```js\nconst x = 1;\n```\n\nDone";
        assert_eq!(clean_model_output(src), src);
    }

    #[test]
    fn unknown_transform_modes_are_rejected() {
        assert!(transform_prompt("polish").is_some());
        assert!(transform_prompt("summarize").is_some());
        assert!(transform_prompt("tasks").is_some());
        assert!(transform_prompt("tags").is_some());
        assert!(transform_prompt("rewrite-everything").is_none());
    }

    #[test]
    fn the_polish_prompt_carries_the_header_protection_contract() {
        let prompt = transform_prompt("polish").unwrap();
        assert!(prompt.contains("Hard rules"));
        assert!(prompt.contains("[[wiki-links]]"));
    }

    #[tokio::test]
    async fn transforms_are_refused_while_ai_is_disabled() {
        let settings = AppSettings::default();
        let result = transform(&settings, "polish", "text").await;
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("disabled"));
    }

    #[tokio::test]
    async fn transforms_need_a_model() {
        let mut settings = AppSettings::default();
        settings.ai.enabled = true;
        let result = transform(&settings, "polish", "text").await;
        assert!(result.error.unwrap().contains("No model configured"));
    }

    #[tokio::test]
    async fn autocomplete_stays_quiet_when_switched_off() {
        let mut settings = AppSettings::default();
        settings.ai.enabled = true;
        settings.ai.model = "llama3".into();
        // autocomplete flag still false
        let result = complete(&settings, "some text").await;
        assert_eq!(result.error.unwrap(), "disabled");
    }
}

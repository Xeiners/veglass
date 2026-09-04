//! The Gemini REST client.
//!
//! Deliberately thin. The *shape* of a request — the system instruction, the
//! JSON schema a feature wants back, how much of the project to describe — is
//! decided in TypeScript, where it is typed and can be unit-tested next to the
//! feature that needs it. This module owns the three things TypeScript must not:
//!
//! 1. the API key, which never crosses into the webview;
//! 2. the HTTP call itself, which from Rust is subject to no CSP and no CORS;
//! 3. turning a failure into something the interface can act on — an invalid
//!    key opens the settings panel, a quota error stops, a 503 is retried.
//!
//! The request body arrives as opaque JSON and is forwarded as-is, so adding a
//! new capability upstream (tools, thinking budgets, a new modality) is a
//! front-end change and nothing more.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::error::{AiError, AiErrorKind, Result};
use super::secrets;

const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Event the assistant panel listens on while a request is being retried.
pub const AI_PROGRESS: &str = "veglass://ai-progress";

/// How long to wait for the *answer*, when the caller does not say.
///
/// The caller almost always should say: a chat turn that has not come back in
/// ninety seconds is not coming back usefully, while a transcription carrying
/// an hour of audio genuinely takes minutes. One number cannot serve both, and
/// the seven-minute default this used to have meant a stalled chat looked
/// identical to a working one for a very long time.
const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(120);

/// One try plus two retries — enough to ride out a rate limit, not enough to
/// keep a user waiting on a service that is genuinely down.
const MAX_ATTEMPTS: u32 = 3;
/// However long the server asks us to wait, we never block longer than this.
const MAX_BACKOFF: Duration = Duration::from_secs(20);

/// Told to the front-end between attempts, so a retry is visible rather than
/// indistinguishable from a request that is simply taking its time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryNotice {
    /// The attempt about to start, 1-based.
    pub attempt: u32,
    pub total: u32,
    /// Why the previous one failed, in the words the user would be shown.
    pub reason: String,
    /// Seconds being waited before this attempt.
    pub delay: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateOutcome {
    /// Every text part of the first candidate, concatenated.
    pub text: String,
    /// `STOP` · `MAX_TOKENS` · `SAFETY` … — surfaced so the UI can explain a
    /// truncated answer instead of silently showing half a plan.
    pub finish_reason: Option<String>,
    pub prompt_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
    /// How many HTTP attempts it took, so a retried call can say so.
    pub attempts: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Bare id, `models/` stripped — what a request actually names.
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub input_token_limit: Option<u32>,
}

/// The proxy this machine expects HTTPS to go through, if any.
///
/// The agent every request here goes through.
///
/// The proxy handling and IPv4-first resolution this needs turned out to be
/// needed by the binary downloads too, so both live in `crate::net` now — and
/// a fix to one is a fix to all three rather than to whichever was remembered.
fn agent(read_timeout: Duration) -> ureq::Agent {
    crate::net::agent_for(crate::net::host_of(ENDPOINT), read_timeout)
}

fn key_of(app: &AppHandle) -> Result<String> {
    secrets::load(app, secrets::GEMINI).ok_or_else(AiError::missing_key)
}

/* ------------------------------------------------------------------ *
 * Failure mapping
 * ------------------------------------------------------------------ */

/// Google's error envelope: `{ "error": { "code", "message", "status" } }`.
fn message_from_body(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    parsed
        .get("error")?
        .get("message")?
        .as_str()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Turns an HTTP status into the failure the interface reacts to.
///
/// The upstream message is kept alongside our own sentence rather than
/// replacing it: "API key not valid" is the detail that makes the difference
/// between a typo and a key that was never enabled for this API.
fn from_status(status: u16, body: &str) -> AiError {
    let detail = message_from_body(body);
    let with = |kind: AiErrorKind, sentence: &str| {
        let message = match &detail {
            Some(text) => format!("{sentence} ({text})"),
            None => sentence.to_string(),
        };
        AiError::new(kind, message).with_status(status)
    };

    match status {
        400 => {
            // A bad key comes back as a 400 with an API_KEY_INVALID reason,
            // which is otherwise indistinguishable from a malformed request.
            let looks_like_key = body.contains("API_KEY_INVALID") || body.contains("API key not valid");
            if looks_like_key {
                with(AiErrorKind::InvalidKey, "Clé API refusée par Google.")
            } else {
                with(AiErrorKind::Request, "Requête refusée par l'API Gemini.")
            }
        }
        401 => with(AiErrorKind::InvalidKey, "Clé API manquante ou invalide."),
        403 => with(
            AiErrorKind::InvalidKey,
            "Accès refusé — la clé n'a pas l'API Generative Language activée.",
        ),
        404 => with(
            AiErrorKind::Request,
            "Modèle introuvable — vérifiez son identifiant dans les réglages.",
        ),
        429 => {
            // Google returns two very different problems as 429, and telling
            // them apart is what decides the fix. A *rate* limit is a burst
            // that clears in seconds, so waiting works. An exhausted *plan
            // quota* — the free tier's daily allowance — does not clear today,
            // so waiting is useless and only another model has any headroom.
            // Quotas are per model, which is what makes the fallback work.
            let exhausted = body.contains("free_tier")
                || body.contains("FreeTier")
                || body.contains("PerDay")
                || body.contains("Quota exceeded for metric");
            if exhausted {
                with(
                    AiErrorKind::Quota,
                    "Quota épuisé pour ce modèle. Les quotas sont comptés par modèle : en essayer un autre repart d'un compteur neuf.",
                )
            } else {
                with(AiErrorKind::RateLimit, "Trop de requêtes en peu de temps.")
            }
        }
        // 402 has no meaning here; a genuinely exhausted plan arrives as 429
        // with a RESOURCE_EXHAUSTED status, which the message carries.
        500 | 502 | 503 | 504 => with(
            AiErrorKind::Server,
            "Le service Gemini est momentanément indisponible.",
        ),
        _ => with(AiErrorKind::Request, "L'API Gemini a renvoyé une erreur."),
    }
}

/// Turns a transport failure into something the reader can act on.
///
/// The raw text is unusable on its own: a Windows socket timeout arrives as two
/// sentences of operating-system prose ending in `os error 10060`, which tells
/// someone staring at a video editor exactly nothing. What matters is *which*
/// kind of failure it is, because the three have different fixes.
fn from_transport(error: &ureq::Transport) -> AiError {
    let raw = error.to_string();
    let lower = raw.to_lowercase();

    // Timed out: WSAETIMEDOUT on Windows, ETIMEDOUT elsewhere. The connection
    // was accepted or never answered — a filter in the middle, not a wrong URL.
    let timed_out = lower.contains("os error 10060")
        || lower.contains("os error 110")
        || lower.contains("os error 60")
        || lower.contains("timed out")
        || lower.contains("timeout");
    // Refused or unresolvable: nothing is listening, or the name did not resolve.
    let unreachable = lower.contains("os error 10061")
        || lower.contains("refused")
        || lower.contains("dns")
        || lower.contains("resolve");

    let route = crate::net::route_of(crate::net::host_of(ENDPOINT));

    let message = if timed_out {
        format!(
            "La connexion à Google a expiré{route}. Le serveur n'a jamais répondu : \
             en général un pare-feu, un proxy d'entreprise ou un VPN sur le trajet. \
             Si votre réseau passe par un proxy, définissez la variable d'environnement \
             HTTPS_PROXY avant de lancer Veglass."
        )
    } else if unreachable {
        format!("Impossible de joindre generativelanguage.googleapis.com{route}. Vérifiez la connexion et le DNS.")
    } else {
        format!("Réseau indisponible{route} : {raw}")
    };

    AiError::new(AiErrorKind::Network, message)
}

/// Google's own advice on when to come back: `details[].retryDelay`, as `"24s"`.
///
/// It arrives in the response *body* rather than in a `Retry-After` header, so a
/// client that only reads headers waits its own arbitrary backoff instead of the
/// one the service actually asked for.
fn retry_delay_from_body(body: &str) -> Option<u64> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    let details = parsed.get("error")?.get("details")?.as_array()?;
    details.iter().find_map(|entry| {
        let delay = entry.get("retryDelay")?.as_str()?;
        delay
            .trim_end_matches('s')
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value.ceil() as u64)
    })
}

/// How long to wait before attempt `n`, honouring `Retry-After` when given.
fn backoff(attempt: u32, retry_after: Option<u64>) -> Duration {
    let suggested = retry_after.map(Duration::from_secs);
    let default = Duration::from_millis(700 * 2u64.pow(attempt.min(4)));
    suggested.unwrap_or(default).min(MAX_BACKOFF)
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

enum Attempt {
    Ok(String),
    Failed(AiError, Option<u64>),
}

fn send(agent: &ureq::Agent, url: &str, key: &str, payload: &str) -> Attempt {
    match agent
        .post(url)
        // Header rather than `?key=`: query strings end up in proxy logs.
        .set("x-goog-api-key", key)
        .set("Content-Type", "application/json")
        .send_string(payload)
    {
        Ok(response) => match response.into_string() {
            Ok(text) => Attempt::Ok(text),
            Err(error) => Attempt::Failed(
                AiError::new(AiErrorKind::Format, format!("réponse illisible : {error}")),
                None,
            ),
        },
        Err(ureq::Error::Status(status, response)) => {
            let header = response
                .header("Retry-After")
                .and_then(|value| value.parse::<u64>().ok());
            let body = response.into_string().unwrap_or_default();
            // The header first, then Google's own `retryDelay` from the body.
            let retry_after = header.or_else(|| retry_delay_from_body(&body));
            Attempt::Failed(from_status(status, &body), retry_after)
        }
        Err(ureq::Error::Transport(transport)) => Attempt::Failed(from_transport(&transport), None),
    }
}

/// Posts `body` to `models/{model}:generateContent` and reads the first candidate.
///
/// `timeout_secs` is the caller's patience for one attempt. It is required in
/// spirit even though it is optional in type: a chat turn and an hour of audio
/// have nothing in common, and sharing a timeout means one of them is wrong.
pub fn generate(
    app: &AppHandle,
    model: &str,
    body: Value,
    timeout_secs: Option<u64>,
) -> Result<GenerateOutcome> {
    let key = key_of(app)?;
    let model = model.trim().trim_start_matches("models/");
    if model.is_empty() {
        return Err(AiError::new(AiErrorKind::Request, "Aucun modèle sélectionné."));
    }

    let url = format!("{ENDPOINT}/models/{model}:generateContent");
    // Serialised once: the body is re-sent verbatim on a retry, and an audio
    // payload is far too large to pay for encoding it again.
    let payload = serde_json::to_string(&body).map_err(|error| {
        AiError::new(AiErrorKind::Request, format!("requête non sérialisable : {error}"))
    })?;
    let agent = agent(
        timeout_secs
            .map(|secs| Duration::from_secs(secs.clamp(5, 900)))
            .unwrap_or(DEFAULT_READ_TIMEOUT),
    );

    let mut pause: Option<Duration> = None;
    let mut last: Option<AiError> = None;
    for attempt in 0..MAX_ATTEMPTS {
        if let Some(delay) = pause.take() {
            std::thread::sleep(delay);
        }

        match send(&agent, &url, &key, &payload) {
            Attempt::Ok(text) => return parse_outcome(&text, attempt + 1),
            Attempt::Failed(error, retry_after) => {
                // A refused key or an exhausted plan will refuse again; only a
                // transient failure earns another attempt.
                if !error.retryable || attempt + 1 == MAX_ATTEMPTS {
                    return Err(error);
                }
                let delay = backoff(attempt, retry_after);
                // Retrying silently is how three eight-second connect failures
                // became one unexplained minute. Say what happened instead.
                let _ = app.emit(
                    AI_PROGRESS,
                    RetryNotice {
                        attempt: attempt + 2,
                        total: MAX_ATTEMPTS,
                        reason: error.message.clone(),
                        delay: delay.as_secs_f64(),
                    },
                );
                pause = Some(delay);
                last = Some(error);
            }
        }
    }

    Err(last.unwrap_or_else(|| {
        AiError::new(AiErrorKind::Server, "L'API Gemini n'a pas répondu.")
    }))
}

/// Extracts the answer, or explains why there is not one.
fn parse_outcome(body: &str, attempts: u32) -> Result<GenerateOutcome> {
    let parsed: Value = serde_json::from_str(body).map_err(|error| {
        AiError::new(AiErrorKind::Format, format!("réponse JSON illisible : {error}"))
    })?;

    // A prompt rejected before generation carries no candidate at all.
    if let Some(reason) = parsed
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
    {
        return Err(AiError::new(
            AiErrorKind::Blocked,
            format!("Requête bloquée par les filtres de sécurité ({reason})."),
        ));
    }

    let candidate = parsed
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|items| items.first());

    let finish_reason = candidate
        .and_then(|item| item.get("finishReason"))
        .and_then(Value::as_str)
        .map(str::to_string);

    // Thinking models return their reasoning as parts flagged `thought`; those
    // are not the answer and must not be concatenated into it.
    let text = candidate
        .and_then(|item| item.pointer("/content/parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part.get("thought") != Some(&Value::Bool(true)))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    if text.trim().is_empty() {
        return Err(match finish_reason.as_deref() {
            Some("SAFETY") | Some("RECITATION") | Some("PROHIBITED_CONTENT") => AiError::new(
                AiErrorKind::Blocked,
                "Réponse bloquée par les filtres de sécurité de Gemini.",
            ),
            Some("MAX_TOKENS") => AiError::new(
                AiErrorKind::Format,
                "Réponse tronquée avant d'avoir commencé — réduisez le contexte ou augmentez la limite de sortie.",
            ),
            _ => AiError::new(AiErrorKind::Format, "Gemini a renvoyé une réponse vide."),
        });
    }

    let usage = |field: &str| {
        parsed
            .pointer(&format!("/usageMetadata/{field}"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32
    };

    Ok(GenerateOutcome {
        text,
        finish_reason,
        prompt_tokens: usage("promptTokenCount"),
        output_tokens: usage("candidatesTokenCount"),
        total_tokens: usage("totalTokenCount"),
        attempts,
    })
}

/// Models this key may call, filtered to those that can `generateContent`.
///
/// Doubles as the key check: listing costs no tokens, so saving a key can be
/// verified against the real service without spending quota on it.
pub fn list_models(app: &AppHandle, override_key: Option<&str>) -> Result<Vec<ModelInfo>> {
    let owned;
    let key = match override_key {
        Some(value) => value,
        None => {
            owned = key_of(app)?;
            &owned
        }
    };

    let response = agent(Duration::from_secs(30))
        .get(&format!("{ENDPOINT}/models"))
        .set("x-goog-api-key", key)
        .query("pageSize", "200")
        .call();

    let body = match response {
        Ok(value) => value.into_string().map_err(|error| {
            AiError::new(AiErrorKind::Format, format!("réponse illisible : {error}"))
        })?,
        Err(ureq::Error::Status(status, response)) => {
            let text = response.into_string().unwrap_or_default();
            return Err(from_status(status, &text));
        }
        Err(ureq::Error::Transport(transport)) => return Err(from_transport(&transport)),
    };

    let parsed: Value = serde_json::from_str(&body).map_err(|error| {
        AiError::new(AiErrorKind::Format, format!("liste de modèles illisible : {error}"))
    })?;

    let mut models: Vec<ModelInfo> = parsed
        .get("models")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|model| {
            model
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .map(|methods| methods.iter().any(|m| m.as_str() == Some("generateContent")))
                .unwrap_or(false)
        })
        .filter_map(|model| {
            let name = model.get("name")?.as_str()?;
            let id = name.trim_start_matches("models/").to_string();
            Some(ModelInfo {
                label: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                description: model
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input_token_limit: model
                    .get("inputTokenLimit")
                    .and_then(Value::as_u64)
                    .map(|value| value as u32),
                id,
            })
        })
        .collect();

    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_first_candidate() {
        let body = r#"{
            "candidates": [{ "content": { "parts": [{ "text": "bon" }, { "text": "jour" }] },
                             "finishReason": "STOP" }],
            "usageMetadata": { "promptTokenCount": 12, "candidatesTokenCount": 3, "totalTokenCount": 15 }
        }"#;
        let outcome = parse_outcome(body, 1).expect("parses");
        assert_eq!(outcome.text, "bonjour");
        assert_eq!(outcome.finish_reason.as_deref(), Some("STOP"));
        assert_eq!(outcome.prompt_tokens, 12);
        assert_eq!(outcome.total_tokens, 15);
    }

    #[test]
    fn skips_thought_parts() {
        let body = r#"{"candidates":[{"content":{"parts":[
            {"text":"réflexion","thought":true},{"text":"réponse"}]}}]}"#;
        assert_eq!(parse_outcome(body, 1).expect("parses").text, "réponse");
    }

    #[test]
    fn a_blocked_prompt_is_not_an_empty_answer() {
        let body = r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#;
        let error = parse_outcome(body, 1).expect_err("blocked");
        assert_eq!(error.kind, AiErrorKind::Blocked);
    }

    #[test]
    fn truncation_says_so() {
        let body = r#"{"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]}"#;
        let error = parse_outcome(body, 1).expect_err("empty");
        assert_eq!(error.kind, AiErrorKind::Format);
    }

    #[test]
    fn a_bad_key_is_told_apart_from_a_bad_request() {
        let key = from_status(400, r#"{"error":{"message":"API key not valid","status":"INVALID_ARGUMENT"}}"#);
        assert_eq!(key.kind, AiErrorKind::InvalidKey);
        assert!(!key.retryable);

        let request = from_status(400, r#"{"error":{"message":"Invalid JSON payload"}}"#);
        assert_eq!(request.kind, AiErrorKind::Request);
    }

    #[test]
    fn a_burst_is_retryable_but_a_refusal_is_not() {
        assert!(from_status(429, "{}").retryable);
        assert!(from_status(503, "{}").retryable);
        assert!(!from_status(403, "{}").retryable);
    }

    #[test]
    fn an_exhausted_plan_is_told_apart_from_a_burst() {
        let plan = from_status(
            429,
            r#"{"error":{"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests"}}"#,
        );
        assert_eq!(plan.kind, AiErrorKind::Quota);
        // Waiting cannot fix a daily allowance, so the same model is not retried
        // — the front-end moves to another one instead.
        assert!(!plan.retryable);

        let burst = from_status(429, r#"{"error":{"message":"Too many requests"}}"#);
        assert_eq!(burst.kind, AiErrorKind::RateLimit);
        assert!(burst.retryable);
    }

    #[test]
    fn google_s_own_retry_delay_is_read_from_the_body() {
        let body = r#"{"error":{"details":[
            {"@type":"type.googleapis.com/google.rpc.QuotaFailure"},
            {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"24.055327413s"}
        ]}}"#;
        // Rounded up: coming back a fraction early only earns another refusal.
        assert_eq!(retry_delay_from_body(body), Some(25));
        assert_eq!(retry_delay_from_body("{}"), None);
        assert_eq!(retry_delay_from_body("not json"), None);
    }

    #[test]
    fn backoff_respects_retry_after_within_the_ceiling() {
        assert_eq!(backoff(1, Some(5)), Duration::from_secs(5));
        assert_eq!(backoff(1, Some(600)), MAX_BACKOFF);
        assert!(backoff(1, None) <= MAX_BACKOFF);
    }

    #[test]
    fn upstream_detail_survives_into_the_message() {
        let error = from_status(429, r#"{"error":{"message":"Quota exceeded for quota metric"}}"#);
        assert!(error.message.contains("Quota exceeded"));
        assert_eq!(error.status, Some(429));
    }
}

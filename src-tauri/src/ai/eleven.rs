//! The speech half of the AI suite: ElevenLabs text-to-speech.
//!
//! Same shape as [`super::gemini`], and for the same three reasons. The key
//! stays out of the renderer; the request goes through [`crate::net`] so a
//! proxy or a filtered IPv6 route is handled once rather than per-caller; and a
//! transport blip earns a retry while a refused key does not.
//!
//! Two things are specific to this service and worth stating.
//!
//! **The timestamped endpoint is the only one used.** `/with-timestamps`
//! returns the audio *and* a per-character alignment, for the same price as the
//! plain endpoint. That alignment is what lets a take be placed against a
//! screen recording to the frame rather than to the nearest guess — and it is
//! also where the take's true duration comes from, so nothing has to probe the
//! file it just wrote.
//!
//! **The audio is written to disk, not handed back as base64.** A voice-over is
//! a media asset: it goes in the project, it is played by the preview, and it
//! is read by ffmpeg at export. All three need a path. The one exception is
//! [`preview`], which is thrown away the moment it has been heard and never
//! touches the disk at all.

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::error::{AiError, AiErrorKind, Result};
use super::secrets;

const ENDPOINT: &str = "https://api.elevenlabs.io/v1";

/// Long enough for a paragraph on a busy server, short enough that a stalled
/// request fails while the user is still watching the wizard.
const READ_TIMEOUT: Duration = Duration::from_secs(120);

/// One try plus two retries, mirroring the Gemini client.
const MAX_ATTEMPTS: u32 = 3;
const MAX_BACKOFF: Duration = Duration::from_secs(20);

/// The ceiling the service enforces per request. Checked here so an over-long
/// sentence is a clear message rather than a 400 from a stranger.
const MAX_CHARS: usize = 4_500;

/* ------------------------------------------------------------------ *
 * Shapes crossing the bridge
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    /// `premade` · `cloned` · `professional` … — how the account came by it.
    pub category: Option<String>,
    pub description: Option<String>,
    /// The service's own sample, playable straight from a URL.
    pub preview_url: Option<String>,
    /// Free-form tags the service attaches: accent, age, use case.
    pub labels: Vec<String>,
}

/// How a voice should be driven. Mirrors the service's own vocabulary, so the
/// settings panel can pass what the user chose through untranslated.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    pub stability: f64,
    pub similarity_boost: f64,
    pub style: f64,
    pub use_speaker_boost: bool,
    pub speed: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRequest {
    pub voice_id: String,
    pub model_id: String,
    pub text: String,
    pub settings: VoiceSettings,
    /// Basename for the file written under the voice-over directory. Sanitised
    /// here, never trusted: it reaches the filesystem.
    pub key: String,
}

/// One word, and when it is said.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WordTiming {
    pub word: String,
    /// Seconds from the start of this take.
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechOutcome {
    /// Absolute path of the written mp3.
    pub path: String,
    /// Seconds, from the alignment rather than from a probe of the file.
    pub duration: f64,
    pub words: Vec<WordTiming>,
    pub bytes: u64,
    pub attempts: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// Base64 mp3 — the caller builds the `data:` URI and throws it away after.
    pub data: String,
    pub mime_type: String,
    pub duration: f64,
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

fn agent() -> ureq::Agent {
    crate::net::agent_for(crate::net::host_of(ENDPOINT), READ_TIMEOUT)
}

fn key_of(app: &AppHandle) -> Result<String> {
    secrets::load(app, secrets::ELEVENLABS).ok_or_else(AiError::missing_voice_key)
}

/// The service's error envelope, which is `detail` as either an object or a
/// bare string depending on which layer refused.
fn message_from_body(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    let detail = parsed.get("detail")?;
    let text = detail
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| detail.as_str())?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// The machine-readable status beside that message, when there is one.
fn status_from_body(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    parsed
        .get("detail")?
        .get("status")?
        .as_str()
        .map(str::to_string)
}

/// Turns an HTTP status into the failure the interface reacts to.
///
/// The one subtlety: this service answers **401** both for a key it does not
/// recognise and for a key whose character allowance is spent. Those need
/// opposite reactions — one reopens the settings panel, the other must not —
/// so the body's `status` field is consulted before the code is trusted.
/// Whether a string has the shape of an ElevenLabs key.
///
/// The service publishes this itself, in the very error that prompted the
/// check: "API keys start with 'sk_' and are shown when the key is created or
/// rotated." The dashboard displays a *key id* next to each key, which looks
/// enough like a secret to be copied by mistake — and the request it produces
/// comes back as a 400, so it reads as a bad request rather than a bad key.
pub fn looks_like_key(key: &str) -> bool {
    key.trim().starts_with("sk_")
}

/// The mistake, explained in the terms of what the user actually did.
const KEY_ID_PASTED: &str =
    "Ceci est l'identifiant de la clé, pas la clé elle-même. Sur elevenlabs.io, la clé      commence par « sk_ » et n'est affichée qu'au moment où vous la créez ou la      régénérez — l'identifiant listé à côté ne fonctionne pas.";

fn from_status(status: u16, body: &str) -> AiError {
    let detail = message_from_body(body);
    let flag = status_from_body(body).unwrap_or_default();

    // Checked before the status code, because this particular refusal arrives
    // as a 400 and would otherwise be reported as a problem with the voice or
    // the model — sending the user to look in entirely the wrong place.
    let about_key = detail
        .as_deref()
        .map(str::to_lowercase)
        .is_some_and(|text| text.contains("api key") || text.contains("api_key"));
    if about_key {
        let sentence = if detail
            .as_deref()
            .map(str::to_lowercase)
            .is_some_and(|text| text.contains("key id"))
        {
            KEY_ID_PASTED
        } else {
            "Clé ElevenLabs refusée. Vérifiez-la dans les réglages, onglet Voix."
        };
        return AiError::new(AiErrorKind::InvalidKey, sentence).with_status(status);
    }

    let with = |kind: AiErrorKind, sentence: &str| {
        let message = match &detail {
            Some(text) => format!("{sentence} ({text})"),
            None => sentence.to_string(),
        };
        AiError::new(kind, message).with_status(status)
    };

    if flag.contains("quota") {
        return with(
            AiErrorKind::Quota,
            "Le quota de caractères ElevenLabs est épuisé. La voix off reprendra au renouvellement de votre offre.",
        );
    }

    match status {
        400 | 422 => with(
            AiErrorKind::Request,
            "ElevenLabs a refusé la requête — vérifiez la voix et le modèle choisis.",
        ),
        401 | 403 => with(
            AiErrorKind::InvalidKey,
            "Clé ElevenLabs refusée. Vérifiez-la dans les réglages, onglet Voix.",
        ),
        404 => with(
            AiErrorKind::Request,
            "Cette voix n'existe plus sur votre compte ElevenLabs.",
        ),
        429 => with(
            AiErrorKind::RateLimit,
            "Trop de requêtes ElevenLabs à la fois — nouvelle tentative dans un instant.",
        ),
        500..=599 => with(
            AiErrorKind::Server,
            "ElevenLabs est momentanément indisponible.",
        ),
        _ => with(AiErrorKind::Request, "ElevenLabs a répondu par une erreur."),
    }
}

/// A transport failure, in the terms `net::classify` already distinguishes.
fn from_transport(error: &ureq::Transport) -> AiError {
    let text = error.to_string();
    let route = crate::net::route_of(crate::net::host_of(ENDPOINT));

    let sentence = match crate::net::classify(&text) {
        crate::net::Fault::Dns => format!(
            "Le nom api.elevenlabs.io n'a pas pu être résolu{route}. C'est le DNS, pas le service."
        ),
        crate::net::Fault::Timeout => {
            format!("ElevenLabs n'a pas répondu dans le temps imparti{route}.")
        }
        crate::net::Fault::Refused => {
            format!("La connexion à ElevenLabs a été refusée{route}.")
        }
        crate::net::Fault::Other => format!("Connexion à ElevenLabs impossible{route} : {text}"),
    };

    AiError::new(AiErrorKind::Network, sentence)
}

fn backoff(attempt: u32, retry_after: Option<u64>) -> Duration {
    let suggested = retry_after.map(Duration::from_secs);
    let default = Duration::from_millis(700 * 2u64.pow(attempt.min(4)));
    suggested.unwrap_or(default).min(MAX_BACKOFF)
}

enum Attempt {
    Ok(String),
    Failed(AiError, Option<u64>),
}

fn send(agent: &ureq::Agent, url: &str, key: &str, payload: &str) -> Attempt {
    match agent
        .post(url)
        .set("xi-api-key", key)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
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
            let retry_after = response
                .header("Retry-After")
                .and_then(|value| value.parse::<u64>().ok());
            let body = response.into_string().unwrap_or_default();
            Attempt::Failed(from_status(status, &body), retry_after)
        }
        Err(ureq::Error::Transport(transport)) => Attempt::Failed(from_transport(&transport), None),
    }
}

/// Posts `body`, retrying only what is worth retrying. Returns the raw answer
/// and how many attempts it took.
fn post(app: &AppHandle, url: &str, body: &Value) -> Result<(String, u32)> {
    let key = key_of(app)?;
    let payload = serde_json::to_string(body).map_err(|error| {
        AiError::new(AiErrorKind::Request, format!("requête non sérialisable : {error}"))
    })?;
    let agent = agent();

    let mut pause: Option<Duration> = None;
    let mut last: Option<AiError> = None;

    for attempt in 0..MAX_ATTEMPTS {
        if let Some(delay) = pause.take() {
            std::thread::sleep(delay);
        }

        match send(&agent, url, &key, &payload) {
            Attempt::Ok(text) => return Ok((text, attempt + 1)),
            Attempt::Failed(error, retry_after) => {
                if !error.retryable || attempt + 1 == MAX_ATTEMPTS {
                    return Err(error);
                }
                pause = Some(backoff(attempt, retry_after));
                last = Some(error);
            }
        }
    }

    Err(last.unwrap_or_else(|| AiError::new(AiErrorKind::Server, "ElevenLabs n'a pas répondu.")))
}

/* ------------------------------------------------------------------ *
 * Alignment
 * ------------------------------------------------------------------ */

/// Groups a character-level alignment into words.
///
/// The service aligns *characters*, which is more precision than anything
/// downstream can use and less structure than it needs: a caption, a marker or
/// a keyframe is placed against a word. Whitespace separates; a word's span
/// runs from the start of its first character to the end of its last.
///
/// Deliberately tolerant of a ragged answer — the three arrays are supposed to
/// be the same length, and anything past the shortest is ignored rather than
/// indexed into.
pub fn words_from_alignment(
    characters: &[String],
    starts: &[f64],
    ends: &[f64],
) -> Vec<WordTiming> {
    let count = characters.len().min(starts.len()).min(ends.len());
    let mut out: Vec<WordTiming> = Vec::new();
    let mut current: Option<WordTiming> = None;

    for index in 0..count {
        let glyph = characters[index].as_str();
        let start = starts[index];
        let end = ends[index];
        if !start.is_finite() || !end.is_finite() {
            continue;
        }

        if glyph.trim().is_empty() {
            if let Some(word) = current.take() {
                out.push(word);
            }
            continue;
        }

        match current.as_mut() {
            Some(word) => {
                word.word.push_str(glyph);
                // Never let a rounding artefact make a word end before it began.
                word.end = word.end.max(end);
            }
            None => current = Some(WordTiming { word: glyph.to_string(), start, end }),
        }
    }

    if let Some(word) = current {
        out.push(word);
    }
    out
}

/// The alignment block of an answer, if it carries one.
///
/// `normalized_alignment` is preferred: it is aligned against the text as the
/// model actually pronounced it, with numbers and abbreviations expanded, which
/// is the version whose characters correspond to the audio.
fn alignment_of(parsed: &Value) -> Vec<WordTiming> {
    let block = parsed
        .get("normalized_alignment")
        .filter(|value| !value.is_null())
        .or_else(|| parsed.get("alignment"))
        .unwrap_or(&Value::Null);

    let strings = |key: &str| -> Vec<String> {
        block
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    let numbers = |key: &str| -> Vec<f64> {
        block
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().map(|item| item.as_f64().unwrap_or(f64::NAN)).collect())
            .unwrap_or_default()
    };

    words_from_alignment(
        &strings("characters"),
        &numbers("character_start_times_seconds"),
        &numbers("character_end_times_seconds"),
    )
}

/// Where a take ends, which is where the last word stops.
fn duration_of(words: &[WordTiming]) -> f64 {
    words.iter().fold(0.0_f64, |longest, word| longest.max(word.end))
}

/* ------------------------------------------------------------------ *
 * Filesystem
 * ------------------------------------------------------------------ */

/// A basename that cannot escape the voice-over directory.
///
/// The key comes from the front-end, and the front-end composes it from a
/// project id and a step id — but "comes from our own code" is not a property
/// this function can check, so it enforces the alphabet instead.
fn safe_name(key: &str) -> Result<String> {
    let cleaned: String = key
        .chars()
        .map(|glyph| if glyph.is_ascii_alphanumeric() || glyph == '-' { glyph } else { '_' })
        .take(80)
        .collect();

    let trimmed = cleaned.trim_matches('_').to_string();
    if trimmed.is_empty() {
        return Err(AiError::io("nom de fichier de voix off vide"));
    }
    Ok(trimmed)
}

/// Where generated voice-overs live.
///
/// App **data**, not app cache: these files are referenced by a saved project,
/// and a cache is a directory the system is entitled to empty. A voice-over
/// that vanishes between two sessions would take the montage with it.
pub fn voiceover_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AiError::io(format!("dossier applicatif indisponible : {error}")))?
        .join("voiceover");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

fn body_of(request: &SpeechRequest) -> Value {
    json!({
        "text": request.text,
        "model_id": request.model_id,
        "voice_settings": {
            "stability": request.settings.stability.clamp(0.0, 1.0),
            "similarity_boost": request.settings.similarity_boost.clamp(0.0, 1.0),
            "style": request.settings.style.clamp(0.0, 1.0),
            "use_speaker_boost": request.settings.use_speaker_boost,
            "speed": request.settings.speed.clamp(0.7, 1.2),
        },
    })
}

fn validate(request: &SpeechRequest) -> Result<()> {
    if request.voice_id.trim().is_empty() {
        return Err(AiError::new(
            AiErrorKind::Request,
            "Aucune voix sélectionnée. Choisissez-en une dans les réglages, onglet Voix.",
        ));
    }
    if request.text.trim().is_empty() {
        return Err(AiError::new(AiErrorKind::Request, "Le texte à dire est vide."));
    }
    if request.text.chars().count() > MAX_CHARS {
        return Err(AiError::new(
            AiErrorKind::Request,
            format!("Ce passage dépasse {MAX_CHARS} caractères — découpez-le en phrases plus courtes."),
        ));
    }
    Ok(())
}

/// The audio, its alignment, and the attempts it took.
fn synthesize(app: &AppHandle, request: &SpeechRequest) -> Result<(Vec<u8>, Vec<WordTiming>, u32)> {
    validate(request)?;

    let url = format!(
        "{ENDPOINT}/text-to-speech/{}/with-timestamps?output_format=mp3_44100_128",
        request.voice_id.trim()
    );
    let (body, attempts) = post(app, &url, &body_of(request))?;

    let parsed: Value = serde_json::from_str(&body).map_err(|error| {
        AiError::new(AiErrorKind::Format, format!("réponse JSON illisible : {error}"))
    })?;

    let encoded = parsed
        .get("audio_base64")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AiError::new(AiErrorKind::Format, "ElevenLabs n'a renvoyé aucun audio.")
        })?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| {
            AiError::new(AiErrorKind::Format, format!("audio illisible : {error}"))
        })?;

    if bytes.is_empty() {
        return Err(AiError::new(AiErrorKind::Format, "ElevenLabs a renvoyé un audio vide."));
    }

    Ok((bytes, alignment_of(&parsed), attempts))
}

/// Speaks `request.text` and writes it beside the project's other voice-overs.
pub fn speak(app: &AppHandle, request: SpeechRequest) -> Result<SpeechOutcome> {
    let name = safe_name(&request.key)?;
    let (bytes, words, attempts) = synthesize(app, &request)?;

    let path = voiceover_dir(app)?.join(format!("{name}.mp3"));
    std::fs::write(&path, &bytes)?;

    Ok(SpeechOutcome {
        path: path.to_string_lossy().to_string(),
        duration: duration_of(&words),
        words,
        bytes: bytes.len() as u64,
        attempts,
    })
}

/// The same, kept in memory — for the settings panel's audition button.
pub fn preview(app: &AppHandle, request: SpeechRequest) -> Result<Preview> {
    let (bytes, words, _) = synthesize(app, &request)?;
    Ok(Preview {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime_type: "audio/mpeg".into(),
        duration: duration_of(&words),
    })
}

/// Removes a generated take. Missing is success: the caller wants it gone.
pub fn discard(app: &AppHandle, key: &str) -> Result<()> {
    let path = voiceover_dir(app)?.join(format!("{}.mp3", safe_name(key)?));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// The voices this account can actually use.
///
/// Doubles as the key check, exactly as `list_models` does for Gemini: it costs
/// no characters, so a typo is caught while the field is still on screen.
pub fn voices(app: &AppHandle, override_key: Option<&str>) -> Result<Vec<VoiceInfo>> {
    let key = match override_key {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        Some(_) => return Err(AiError::new(AiErrorKind::InvalidKey, "La clé est vide.")),
        None => key_of(app)?,
    };

    // Caught here rather than by the service: the round trip costs a second and
    // comes back as a 400 whose wording sends the reader to the wrong setting.
    if !looks_like_key(&key) {
        return Err(AiError::new(AiErrorKind::InvalidKey, KEY_ID_PASTED));
    }

    let response = agent()
        .get(&format!("{ENDPOINT}/voices"))
        .set("xi-api-key", &key)
        .set("Accept", "application/json")
        .call();

    let body = match response {
        Ok(answer) => answer.into_string().map_err(|error| {
            AiError::new(AiErrorKind::Format, format!("réponse illisible : {error}"))
        })?,
        Err(ureq::Error::Status(status, answer)) => {
            let text = answer.into_string().unwrap_or_default();
            return Err(from_status(status, &text));
        }
        Err(ureq::Error::Transport(transport)) => return Err(from_transport(&transport)),
    };

    let parsed: Value = serde_json::from_str(&body).map_err(|error| {
        AiError::new(AiErrorKind::Format, format!("liste des voix illisible : {error}"))
    })?;

    Ok(parse_voices(&parsed))
}

/// Rebuilds the voice list field by field — the same trust boundary the rest of
/// the suite applies to anything that arrived over the network.
fn parse_voices(parsed: &Value) -> Vec<VoiceInfo> {
    let text = |value: Option<&Value>| -> Option<String> {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
    };

    parsed
        .get("voices")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let id = text(entry.get("voice_id"))?;
            let name = text(entry.get("name")).unwrap_or_else(|| id.clone());
            let labels = entry
                .get("labels")
                .and_then(Value::as_object)
                .map(|map| {
                    map.values()
                        .filter_map(|value| text(Some(value)))
                        .take(4)
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();

            Some(VoiceInfo {
                id,
                name,
                category: text(entry.get("category")),
                description: text(entry.get("description")),
                preview_url: text(entry.get("preview_url")),
                labels,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(source: &str) -> Vec<String> {
        source.chars().map(|glyph| glyph.to_string()).collect()
    }

    /// Evenly spaced characters, a tenth of a second each.
    fn spans(count: usize) -> (Vec<f64>, Vec<f64>) {
        let starts: Vec<f64> = (0..count).map(|index| index as f64 * 0.1).collect();
        let ends: Vec<f64> = starts.iter().map(|value| value + 0.1).collect();
        (starts, ends)
    }

    #[test]
    fn characters_become_words() {
        let source = "ok go";
        let (starts, ends) = spans(source.chars().count());
        let words = words_from_alignment(&chars(source), &starts, &ends);

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].word, "ok");
        assert!((words[0].start - 0.0).abs() < 1e-9);
        assert!((words[0].end - 0.2).abs() < 1e-9);
        assert_eq!(words[1].word, "go");
        assert!((words[1].start - 0.3).abs() < 1e-9);
    }

    #[test]
    fn runs_of_whitespace_do_not_make_empty_words() {
        let source = "  a   b  ";
        let (starts, ends) = spans(source.chars().count());
        let words = words_from_alignment(&chars(source), &starts, &ends);
        assert_eq!(words.iter().map(|word| word.word.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }

    #[test]
    fn punctuation_stays_attached_to_its_word() {
        let source = "Cliquez, puis";
        let (starts, ends) = spans(source.chars().count());
        let words = words_from_alignment(&chars(source), &starts, &ends);
        assert_eq!(words[0].word, "Cliquez,");
    }

    /// A ragged answer must not panic, and must not invent timings.
    #[test]
    fn a_short_array_truncates_rather_than_indexes_past_it() {
        let words = words_from_alignment(&chars("abcd"), &[0.0, 0.1], &[0.1]);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "a");
    }

    #[test]
    fn a_non_finite_timing_is_dropped_not_propagated() {
        let words = words_from_alignment(
            &chars("ab"),
            &[f64::NAN, 0.1],
            &[0.05, 0.2],
        );
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "b");
        assert!(words[0].start.is_finite());
    }

    #[test]
    fn duration_is_the_end_of_the_last_word() {
        let source = "un deux";
        let (starts, ends) = spans(source.chars().count());
        let words = words_from_alignment(&chars(source), &starts, &ends);
        assert!((duration_of(&words) - 0.7).abs() < 1e-9);
        assert_eq!(duration_of(&[]), 0.0);
    }

    #[test]
    fn the_normalized_alignment_wins_when_both_are_present() {
        let parsed = json!({
            "alignment": {
                "characters": ["1"],
                "character_start_times_seconds": [0.0],
                "character_end_times_seconds": [0.1],
            },
            "normalized_alignment": {
                "characters": ["u", "n"],
                "character_start_times_seconds": [0.0, 0.1],
                "character_end_times_seconds": [0.1, 0.2],
            },
        });
        let words = alignment_of(&parsed);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "un");
    }

    #[test]
    fn a_missing_alignment_is_no_words_rather_than_a_panic() {
        assert!(alignment_of(&json!({ "audio_base64": "" })).is_empty());
        assert!(alignment_of(&json!({ "normalized_alignment": null })).is_empty());
    }

    #[test]
    fn a_file_name_cannot_climb_out_of_its_directory() {
        assert_eq!(safe_name("../../etc/passwd").unwrap(), "etc_passwd");
        assert_eq!(safe_name("prj_1-step_2").unwrap(), "prj_1-step_2");
        assert!(safe_name("///").is_err());
        assert!(safe_name("").is_err());
    }

    #[test]
    fn a_spent_allowance_is_a_quota_not_a_bad_key() {
        let body = r#"{"detail":{"status":"quota_exceeded","message":"crédits épuisés"}}"#;
        let error = from_status(401, body);
        assert_eq!(error.kind, AiErrorKind::Quota);
        // A quota is not worth retrying; a rate limit is.
        assert!(!error.retryable);
        assert!(error.message.contains("crédits épuisés"));
    }

    #[test]
    fn an_unrecognised_key_reopens_the_settings_panel() {
        // Verbatim from the report that prompted this: a key id pasted in place
        // of the key, which the service answers with a 400.
        let body = r#"{"detail":{"status":"invalid_api_key","message":"API key ID used as API key - only valid API keys can be used. API keys start with 'sk_' and are shown when the key is created or rotated."}}"#;
        let error = from_status(400, body);
        assert_eq!(error.kind, AiErrorKind::InvalidKey, "{}", error.message);
        assert!(error.message.contains("identifiant"), "{}", error.message);
        // The old wording sent the reader to the voice and model pickers.
        assert!(!error.message.contains("voix"), "{}", error.message);

        assert!(looks_like_key("sk_abc123"));
        assert!(looks_like_key("  sk_abc123  "));
        assert!(!looks_like_key("abcdef0123456789"));
        assert!(!looks_like_key(""));

        // A genuine bad-request about the model must keep its own advice.
        let model = from_status(400, r#"{"detail":{"message":"model_id not found"}}"#);
        assert_eq!(model.kind, AiErrorKind::Request, "{}", model.message);

        let error = from_status(401, r#"{"detail":{"status":"invalid_api_key"}}"#);
        assert_eq!(error.kind, AiErrorKind::InvalidKey);
        assert_eq!(error.status, Some(401));
    }

    #[test]
    fn a_rate_limit_is_retried_and_a_bad_request_is_not() {
        assert!(from_status(429, "{}").retryable);
        assert!(from_status(500, "{}").retryable);
        assert!(!from_status(422, "{}").retryable);
    }

    #[test]
    fn a_bare_string_detail_still_reaches_the_message() {
        let error = from_status(400, r#"{"detail":"voice_id manquant"}"#);
        assert!(error.message.contains("voice_id manquant"));
    }

    #[test]
    fn voices_are_rebuilt_field_by_field() {
        let parsed = json!({
            "voices": [
                {
                    "voice_id": "abc",
                    "name": "Rachel",
                    "category": "premade",
                    "labels": { "accent": "american", "age": "young" },
                    "preview_url": "https://example.invalid/a.mp3",
                },
                { "name": "sans identifiant" },
            ]
        });
        let voices = parse_voices(&parsed);
        assert_eq!(voices.len(), 1, "une voix sans id n'est pas une voix");
        assert_eq!(voices[0].id, "abc");
        assert_eq!(voices[0].labels.len(), 2);
    }

    #[test]
    fn an_over_long_passage_is_refused_before_it_is_sent() {
        let request = SpeechRequest {
            voice_id: "abc".into(),
            model_id: "eleven_multilingual_v2".into(),
            text: "a".repeat(MAX_CHARS + 1),
            settings: VoiceSettings {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0.0,
                use_speaker_boost: true,
                speed: 1.0,
            },
            key: "k".into(),
        };
        assert_eq!(validate(&request).unwrap_err().kind, AiErrorKind::Request);
    }

    #[test]
    fn settings_are_clamped_into_the_range_the_service_accepts() {
        let request = SpeechRequest {
            voice_id: "abc".into(),
            model_id: "eleven_multilingual_v2".into(),
            text: "bonjour".into(),
            settings: VoiceSettings {
                stability: 4.0,
                similarity_boost: -1.0,
                style: 0.3,
                use_speaker_boost: false,
                speed: 9.0,
            },
            key: "k".into(),
        };
        let body = body_of(&request);
        assert_eq!(body["voice_settings"]["stability"], json!(1.0));
        assert_eq!(body["voice_settings"]["similarity_boost"], json!(0.0));
        assert_eq!(body["voice_settings"]["speed"], json!(1.2));
    }
}

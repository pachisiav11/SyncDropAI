//! Naming a file from its content, using a vision model served by Ollama on
//! this machine.
//!
//! This runs on the sending side, before the bytes go anywhere. Nothing is
//! uploaded to get a name, the model call costs nothing, and if Ollama is not
//! running the send simply keeps the original filename.
//!
//! Behaviour matches the JavaScript namer the CLI uses, including the two
//! findings that made it work on CPU-only hardware: reasoning must be disabled,
//! and asking for a plain description then formatting it ourselves beats asking
//! the model for a filename.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use image::imageops::FilterType;
use serde_json::json;
use tauri::ipc::{InvokeBody, Request};

const IMAGE_PROMPT: &str = "Name this image as a file: reply with a specific 3-6 word description of its content. Include any app, brand, product, or document name you can read. Description only, no punctuation, no extra text.";
const TEXT_PROMPT: &str = "Below is the beginning of a document. In 3 to 6 words, describe what it is so it can be named as a file. Description only, no extra text.\n\n";
const TEXT_BUDGET: usize = 1200;

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn ollama_host() -> String {
    env_or("OLLAMA_HOST", "http://127.0.0.1:11434")
        .trim_end_matches('/')
        .to_string()
}

fn max_edge() -> u32 {
    env_or("SYNCDROP_NAMER_MAX_EDGE", "512").parse().unwrap_or(512)
}

fn describe(prompt: &str, images: Vec<String>) -> Result<String, String> {
    let payload = json!({
        "model": env_or("SYNCDROP_NAMER_MODEL", "minicpm-v4.6"),
        "prompt": prompt,
        "images": images,
        // Without this the reasoning backbone emits its chain of thought
        // instead of an answer.
        "think": false,
        "stream": false,
        "options": { "temperature": 0.1, "num_predict": 40 }
    });

    let mut response = ureq::post(format!("{}/api/generate", ollama_host()))
        .send_json(&payload)
        .map_err(|e| format!("Ollama is not reachable: {e}"))?;

    let body: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|e| format!("Ollama returned something unreadable: {e}"))?;

    Ok(body
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string())
}

/// Downscale before sending: the vision encoder tiles the image, so input
/// resolution is what drives latency on a CPU.
fn to_model_image(bytes: &[u8]) -> Result<String, String> {
    let decoded = image::load_from_memory(bytes).map_err(|e| format!("Cannot decode this image: {e}"))?;
    let edge = max_edge();
    let resized = if decoded.width().max(decoded.height()) > edge {
        decoded.resize(edge, edge, FilterType::Triangle)
    } else {
        decoded
    };

    let mut jpeg = Vec::new();
    resized
        .to_rgb8()
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 82))
        .map_err(|e| format!("Cannot re-encode this image: {e}"))?;
    Ok(B64.encode(jpeg))
}

fn extension_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| !ext.is_empty() && ext.len() <= 12 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default()
}

/// Lowercase, hyphenate, trim. Mirrors cleanFilename in protocol/util so a name
/// made here looks like a name made anywhere else in the app.
fn kebab(text: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in text.to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').chars().take(54).collect::<String>().trim_matches('-').to_string()
}

fn text_from_markup(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let title = lower
        .find("<title")
        .and_then(|start| raw[start..].find('>').map(|o| start + o + 1))
        .and_then(|start| lower[start..].find("</title").map(|end| raw[start..start + end].trim().to_string()))
        .unwrap_or_default();

    let mut body = String::new();
    let mut inside = false;
    for ch in raw.chars() {
        match ch {
            '<' => inside = true,
            '>' => inside = false,
            c if !inside => body.push(c),
            _ => {}
        }
    }

    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let joined = if title.is_empty() { collapsed } else { format!("{title}. {collapsed}") };
    joined.chars().take(TEXT_BUDGET).collect()
}

fn description_to_filename(description: &str, original: &str) -> Option<String> {
    let first = description.lines().next().unwrap_or_default();
    let cleaned = first.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`').trim();
    if cleaned.is_empty() {
        return None;
    }
    let base = kebab(cleaned);
    if base.is_empty() || base.starts_with("untitled-file") {
        return None;
    }
    let candidate = format!("{base}{}", extension_of(original));
    if candidate.len() > 80 {
        return None;
    }
    Some(candidate)
}

#[tauri::command]
pub async fn suggest_name(request: Request<'_>) -> Result<Option<String>, String> {
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };
    let name = header("name");
    let mime = header("mime").to_ascii_lowercase();

    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("suggest_name expects a raw body".to_string());
    };

    let description = match mime.as_str() {
        "image/png" | "image/jpeg" | "image/bmp" | "image/tiff" | "image/gif" => {
            describe(IMAGE_PROMPT, vec![to_model_image(bytes)?])?
        }
        "text/html" | "application/xhtml+xml" | "image/svg+xml" => {
            let text = text_from_markup(&String::from_utf8_lossy(bytes));
            if text.is_empty() {
                return Ok(None);
            }
            describe(&format!("{TEXT_PROMPT}{text}"), vec![])?
        }
        other if other.starts_with("text/") || matches!(other, "application/json" | "application/xml" | "application/yaml" | "application/javascript" | "application/sql") => {
            let raw = String::from_utf8_lossy(bytes);
            let text: String = raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(TEXT_BUDGET).collect();
            if text.is_empty() {
                return Ok(None);
            }
            describe(&format!("{TEXT_PROMPT}{text}"), vec![])?
        }
        // Archives, video, and image formats we cannot decode keep their name.
        _ => return Ok(None),
    };

    Ok(description_to_filename(&description, &name))
}

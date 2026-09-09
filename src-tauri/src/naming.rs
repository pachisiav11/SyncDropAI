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

const IMAGE_PROMPT: &str = "Describe what is in this image in 3 to 6 words, as specifically as you can. Include any app, brand, product, or document name you can read. Reply with the description only. No punctuation, no quotes, and never use the words image, photo, picture, screenshot or file.";
const TEXT_PROMPT: &str = "Below is the start of a document. In 3 to 6 words, say specifically what it is. Reply with the description only. No punctuation, no quotes, and never use the words document, text or file.\n\n";
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

    name_for(bytes, &name, &mime)
}

/// Whether the model is there to be asked. The toggle in the UI promises
/// something only this can deliver, so it is checked at the moment somebody
/// switches it on rather than discovered as silence when a file arrives with
/// its old name.
#[tauri::command]
pub fn namer_ready() -> bool {
    ureq::get(format!("{}/api/tags", ollama_host()))
        .call()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// The whole feature, minus the Tauri request wrapper. Kept separate so it can
/// be exercised against the model without a running window.
pub fn name_for(bytes: &[u8], name: &str, mime: &str) -> Result<Option<String>, String> {
    let description = match mime {
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

    Ok(description_to_filename(&description, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_description_becomes_a_filename_that_keeps_its_extension() {
        assert_eq!(
            description_to_filename("Quarterly revenue chart", "IMG_2841.PNG").as_deref(),
            Some("quarterly-revenue-chart.png")
        );
        // Models like to wrap answers in quotes and add a second line.
        assert_eq!(
            description_to_filename("\"Train ticket to Bristol\"\nLet me know", "scan.pdf").as_deref(),
            Some("train-ticket-to-bristol.pdf")
        );
        assert_eq!(description_to_filename("   ", "a.png"), None);
        assert_eq!(description_to_filename("!!!", "a.png"), None);
    }

    #[test]
    fn a_format_we_cannot_read_keeps_its_name() {
        assert_eq!(name_for(b"PK\x03\x04", "photos.zip", "application/zip"), Ok(None));
        assert_eq!(name_for(b"", "clip.mp4", "video/mp4"), Ok(None));
    }

    #[test]
    fn markup_gives_up_its_title_first() {
        let html = "<html><head><title>Invoice 4471</title></head><body><p>Amount due</p></body></html>";
        let text = text_from_markup(html);
        assert!(text.starts_with("Invoice 4471"), "got {text}");
        assert!(text.contains("Amount due"));
    }

    // Runs against the model on this machine. Skips itself rather than failing
    // when Ollama is not running, because naming is optional by design.
    #[test]
    fn the_local_model_names_a_document_from_its_text() {
        if !namer_ready() {
            eprintln!("skipped: no Ollama on {}", ollama_host());
            return;
        }
        let letter = "INVOICE\nNorthwind Plumbing Ltd\nInvoice number 4471\nDate 14 March\n\
                      Bill to: 22 Elm Road\nDescription: replace kitchen mixer tap\nTotal due 240.00 GBP";
        let named = name_for(letter.as_bytes(), "scan_0001.txt", "text/plain")
            .expect("the namer should not error")
            .expect("the model should have produced a name");

        assert!(named.ends_with(".txt"), "kept the extension: {named}");
        assert!(
            named.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.'),
            "kebab case only: {named}"
        );
        assert!(named.len() > 4 && named.len() <= 80, "sensible length: {named}");
        assert!(named != "scan_0001.txt", "the name actually changed: {named}");
        // The prompt forbids these words. Without that the model narrates the
        // task back and every name ends up with "-file" or "-document" in it.
        for filler in ["-file", "-document", "-text"] {
            assert!(!named.contains(filler), "no filler in the name: {named}");
        }
        eprintln!("model named the invoice: {named}");
    }

    #[test]
    fn the_local_model_names_an_image_from_what_is_in_it() {
        if !namer_ready() {
            eprintln!("skipped: no Ollama on {}", ollama_host());
            return;
        }
        // A red circle on white. Small, but it is a real decode-resize-encode
        // round trip and a real vision call.
        let mut canvas = image::RgbImage::from_pixel(320, 320, image::Rgb([255, 255, 255]));
        for y in 0..320i32 {
            for x in 0..320i32 {
                let (dx, dy) = (x - 160, y - 160);
                if dx * dx + dy * dy < 120 * 120 {
                    canvas.put_pixel(x as u32, y as u32, image::Rgb([220, 30, 30]));
                }
            }
        }
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(canvas)
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("encode");

        let named = name_for(&png.into_inner(), "IMG_0042.png", "image/png")
            .expect("the namer should not error")
            .expect("the model should have produced a name");

        assert!(named.ends_with(".png"), "kept the extension: {named}");
        assert!(named != "IMG_0042.png", "the name actually changed: {named}");
        for filler in ["-image", "-photo", "-picture", "-file", "-screenshot"] {
            assert!(!named.contains(filler), "no filler in the name: {named}");
        }
        eprintln!("model named the image: {named}");
    }
}

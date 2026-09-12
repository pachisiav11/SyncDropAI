//! Naming a file from its content, using the vision model in [`crate::llama`].
//!
//! This runs on the sending side, before the bytes go anywhere. Nothing is
//! uploaded to get a name, the model runs on this machine, and if it is not
//! there the send simply keeps the original filename.
//!
//! Behaviour matches the JavaScript namer the CLI uses, including the two
//! findings that made it work on CPU-only hardware: reasoning must be disabled,
//! and asking for a plain description then formatting it ourselves beats asking
//! the model for a filename.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use image::imageops::FilterType;
use tauri::ipc::{InvokeBody, Request};

const IMAGE_PROMPT: &str = "Describe what is in this image in 3 to 6 words, as specifically as you can. Include any app, brand, product, or document name you can read. Reply with the description only. No punctuation, no quotes, and never use the words image, photo, picture, screenshot or file.";
const TEXT_PROMPT: &str = "Below is the start of a document. In 3 to 6 words, say specifically what it is. Reply with the description only. No punctuation, no quotes, and never use the words document, text or file.\n\n";
const TEXT_BUDGET: usize = 1200;

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn max_edge() -> u32 {
    env_or("SYNCDROP_NAMER_MAX_EDGE", "512").parse().unwrap_or(512)
}

fn describe(prompt: &str, image: Option<String>) -> Result<String, String> {
    crate::llama::describe(prompt, image)
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

/// A short counter or version at the end of the original name. Mirrors
/// keepTrailingIndex in protocol/filenames.js: a description says what is
/// inside a file, so two files holding nearly the same thing come back with
/// nearly the same name and the counter that told them apart is gone. Three
/// digits at most, so that a timestamp or a camera index is never mistaken for
/// a counter.
fn trailing_marker(original: &str) -> String {
    let extension = extension_of(original);
    let base = original.strip_suffix(extension.as_str()).unwrap_or(original);
    let chars: Vec<char> = base.chars().collect();

    let mut start = chars.len();
    while start > 0 && chars[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if !(1..=3).contains(&(chars.len() - start)) {
        return String::new();
    }
    if start > 0 && (chars[start - 1] == 'v' || chars[start - 1] == 'V') {
        start -= 1;
    }
    if start == 0 || !matches!(chars[start - 1], '-' | '_' | ' ') {
        return String::new();
    }
    chars[start..].iter().collect::<String>().to_ascii_lowercase()
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

    let marker = trailing_marker(original);
    let base = if marker.is_empty() || base.split('-').any(|part| part == marker) {
        base
    } else {
        // Appended after the trim rather than before it, or a long description
        // would push the counter straight back off the end.
        let room = 54usize.saturating_sub(marker.len() + 1);
        let trimmed: String = base.chars().take(room).collect();
        format!("{}-{marker}", trimmed.trim_end_matches('-'))
    };

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

/// Whether naming can run at all: the server ships with the app, but the
/// weights are fetched once and until they are here there is nothing to ask.
/// Checked when the toggle is switched on, so an absent model is a sentence on
/// screen rather than files quietly keeping their old names.
#[tauri::command]
pub fn namer_ready() -> bool {
    crate::llama::server_available() && crate::llama::models_present()
}

/// The whole feature, minus the Tauri request wrapper. Kept separate so it can
/// be exercised against the model without a running window.
pub fn name_for(bytes: &[u8], name: &str, mime: &str) -> Result<Option<String>, String> {
    let description = match mime {
        "image/png" | "image/jpeg" | "image/bmp" | "image/tiff" | "image/gif" => {
            describe(IMAGE_PROMPT, Some(to_model_image(bytes)?))?
        }
        "text/html" | "application/xhtml+xml" | "image/svg+xml" => {
            let text = text_from_markup(&String::from_utf8_lossy(bytes));
            if text.is_empty() {
                return Ok(None);
            }
            describe(&format!("{TEXT_PROMPT}{text}"), None)?
        }
        other if other.starts_with("text/") || matches!(other, "application/json" | "application/xml" | "application/yaml" | "application/javascript" | "application/sql") => {
            let raw = String::from_utf8_lossy(bytes);
            let text: String = raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(TEXT_BUDGET).collect();
            if text.is_empty() {
                return Ok(None);
            }
            describe(&format!("{TEXT_PROMPT}{text}"), None)?
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
    fn a_counter_the_description_dropped_is_carried_across() {
        // The case this was written for: three files whose contents read alike,
        // where the model kept the number twice and lost it on the third.
        assert_eq!(
            description_to_filename("tally file 1 is a list", "tally-1.txt").as_deref(),
            Some("tally-file-1-is-a-list.txt")
        );
        assert_eq!(
            description_to_filename("tally file is a list", "tally-3.txt").as_deref(),
            Some("tally-file-is-a-list-3.txt")
        );
        assert_eq!(
            description_to_filename("release notes", "notes_v2.md").as_deref(),
            Some("release-notes-v2.md")
        );
        // Not counters: a camera index and a timestamp are part of a name
        // nobody chose, and carrying them would be noise in every name.
        assert_eq!(
            description_to_filename("red circle on white", "IMG_0042.png").as_deref(),
            Some("red-circle-on-white.png")
        );
        assert_eq!(
            description_to_filename("settings page", "Screenshot_2026-09-10_154501.png").as_deref(),
            Some("settings-page.png")
        );
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
    // when the model is not on this machine, because naming is optional.
    #[test]
    fn the_local_model_names_a_document_from_its_text() {
        if !namer_ready() {
            eprintln!("skipped: the naming model is not on this machine");
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
            eprintln!("skipped: the naming model is not on this machine");
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

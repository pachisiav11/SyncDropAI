//! Writing a received file to disk.
//!
//! The webview streams the transfer into OPFS as it arrives, then hands it over
//! here in large slices. Bulk bytes come in through Tauri's raw request body;
//! passing a Vec<u8> as an ordinary command argument would be serialised as a
//! JSON array of numbers and cost tens of megabytes of text per slice.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request};
use tauri::State;

#[derive(Default)]
pub struct Downloads(pub Mutex<HashMap<String, Pending>>);

pub struct Pending {
    file: File,
    temp: PathBuf,
    target: PathBuf,
}

// Characters Windows refuses in a filename, plus control codes. The
// backslash is compared by code point so this stays readable.
fn forbidden(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '|' | '?' | '*') || c as u32 == 92 || (c as u32) < 0x20
}

fn sanitize(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "syncdrop-file".to_string());

    let cleaned: String = base.chars().map(|c| if forbidden(c) { '-' } else { c }).collect();

    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "syncdrop-file".to_string()
    } else {
        trimmed.chars().take(150).collect()
    }
}

// Never silently overwrite something the user already has.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();

    let mut candidate = dir.join(name);
    let mut index = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({index}){ext}"));
        index += 1;
    }
    candidate
}

fn token() -> String {
    // Monotonic enough for a per-process handle table.
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("dl{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

#[tauri::command]
pub fn file_begin(name: String, state: State<'_, Downloads>) -> Result<String, String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not find a Downloads folder".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let target = unique_path(&dir, &sanitize(&name));
    let temp = target.with_extension(format!(
        "{}.part",
        target.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
    ));

    let file = File::create(&temp).map_err(|e| e.to_string())?;
    let id = token();
    state
        .0
        .lock()
        .map_err(|_| "Download table is poisoned".to_string())?
        .insert(id.clone(), Pending { file, temp, target });
    Ok(id)
}

#[tauri::command]
pub fn file_append(request: Request<'_>, state: State<'_, Downloads>) -> Result<(), String> {
    let id = request
        .headers()
        .get("token")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Missing download token".to_string())?
        .to_string();

    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("file_append expects a raw body".to_string());
    };

    let mut table = state.0.lock().map_err(|_| "Download table is poisoned".to_string())?;
    let pending = table.get_mut(&id).ok_or_else(|| "Unknown download token".to_string())?;
    pending.file.write_all(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn file_finish(token: String, state: State<'_, Downloads>) -> Result<String, String> {
    let mut table = state.0.lock().map_err(|_| "Download table is poisoned".to_string())?;
    let pending = table.remove(&token).ok_or_else(|| "Unknown download token".to_string())?;
    let Pending { mut file, temp, target } = pending;
    file.flush().map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn file_abort(token: String, state: State<'_, Downloads>) -> Result<(), String> {
    let mut table = state.0.lock().map_err(|_| "Download table is poisoned".to_string())?;
    if let Some(pending) = table.remove(&token) {
        drop(pending.file);
        let _ = fs::remove_file(&pending.temp);
    }
    Ok(())
}

#[tauri::command]
pub fn reveal(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("That file is no longer there".to_string());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let parent = target.parent().unwrap_or(&target);
        std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" })
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

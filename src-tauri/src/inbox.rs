//! Files handed to SyncDrop by the Windows shell.
//!
//! "Send to > SyncDrop" and the Explorer right-click both start the app with
//! file paths on the command line. If a window is already open, the second
//! process forwards its arguments and exits, so sharing never opens a second
//! copy of the app.
//!
//! The webview is told the name, type and size, and then pulls the bytes in
//! windows through `inbox_read`. A 4 GB video is therefore never held in the
//! webview, and never copied anywhere before it is sent.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct Inbox(pub Mutex<Vec<PathBuf>>);

#[derive(Serialize, Clone)]
pub struct SharedFile {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

fn mime_for(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn describe(path: &Path) -> Option<SharedFile> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(SharedFile {
        path: path.to_string_lossy().to_string(),
        name: path.file_name()?.to_string_lossy().to_string(),
        mime: mime_for(path).to_string(),
        size: metadata.len(),
    })
}

/// Pull real file paths out of a process argument list, skipping the executable
/// and anything that looks like a switch.
pub fn paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-') && !arg.starts_with('/'))
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .collect()
}

pub fn remember(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    if let Some(inbox) = app.try_state::<Inbox>() {
        let mut held = inbox.0.lock().unwrap();
        held.extend(paths);
    }
    let _ = app.emit("shared-files", ());
}

/// Everything the shell has handed us since the last call. Draining rather than
/// peeking means a share is queued once, no matter how often the page reloads.
#[tauri::command]
pub fn inbox_take(inbox: State<'_, Inbox>) -> Vec<SharedFile> {
    let paths: Vec<PathBuf> = inbox.0.lock().unwrap().drain(..).collect();
    paths.iter().filter_map(|path| describe(path)).collect()
}

/// One window of a shared file, returned as raw bytes on the response body so
/// nothing is JSON-encoded on the way through.
#[tauri::command]
pub fn inbox_read(path: String, offset: u64, length: usize) -> Result<tauri::ipc::Response, String> {
    const MAX_WINDOW: usize = 16 * 1024 * 1024;
    if length == 0 || length > MAX_WINDOW {
        return Err("Read window is out of range".into());
    }

    let mut file = File::open(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Could not seek in {path}: {e}"))?;

    let mut buffer = vec![0u8; length];
    let mut filled = 0;
    while filled < length {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) => return Err(format!("Could not read {path}: {error}")),
        }
    }
    buffer.truncate(filled);
    Ok(tauri::ipc::Response::new(buffer))
}

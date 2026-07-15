// Small CLI-only helpers: time-window parsing, mime guessing, table rendering.

import path from "node:path";
import { formatBytes } from "../../src/core/filenames.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(value) {
  return UUID_RE.test(String(value ?? "").trim());
}

// Parse a window like "5h", "30m", "28d", "45s" into a Date cutoff in the past.
// Returns null if the input is empty; throws on malformed input.
export function parseSince(input) {
  if (input == null) return null;
  const match = String(input).trim().match(/^(\d+)\s*([smhdw])$/i);
  if (!match) {
    throw new Error(`Invalid --since value "${input}". Use forms like 30m, 5h, 28d, 2w.`);
  }
  const amount = Number(match[1]);
  const unitMs = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[match[2].toLowerCase()];
  return new Date(Date.now() - amount * unitMs);
}

// The browser app sends the OS-provided File.type instead of calling this, so a
// gap here shows up as the CLI skipping a file the app would have named. Keep
// the two roughly in step.
const MIME_BY_EXT = {
  // Text — read directly by the namer.
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yml": "application/yaml",
  ".yaml": "application/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  // Source files. text/plain rather than a per-language type: the namer only
  // needs "this is readable text", and the model reads the code either way.
  ".js": "text/plain",
  ".mjs": "text/plain",
  ".ts": "text/plain",
  ".jsx": "text/plain",
  ".tsx": "text/plain",
  ".py": "text/plain",
  ".java": "text/plain",
  ".kt": "text/plain",
  ".c": "text/plain",
  ".h": "text/plain",
  ".cpp": "text/plain",
  ".cs": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".rb": "text/plain",
  ".php": "text/plain",
  ".sh": "text/plain",
  ".ps1": "text/plain",
  ".sql": "text/plain",
  ".css": "text/plain",
  ".ini": "text/plain",
  ".toml": "text/plain",
  ".gradle": "text/plain",
  // Images the vision model can read (Jimp decodes these).
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  // Images we can label but not decode — named correctly here so the metadata is
  // right; the namer skips them and they keep their original filename.
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  // Everything below is opaque to the namer; these entries exist so mime_type is
  // accurate rather than a blanket application/octet-stream.
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".zip": "application/zip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".apk": "application/vnd.android.package-archive",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".msi": "application/x-msi",
  ".epub": "application/epub+zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

export function guessMimeType(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

export function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  return date.toISOString().replace("T", " ").slice(0, 16);
}

// Render an array of row objects as a fixed-width table given [key, header] cols.
export function renderTable(rows, columns) {
  if (rows.length === 0) return "No files.";
  const widths = columns.map(([key, header]) =>
    Math.max(header.length, ...rows.map((row) => String(row[key] ?? "").length))
  );
  const line = (cells) => cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ").trimEnd();
  const header = line(columns.map(([, header]) => header));
  const divider = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map((row) => line(columns.map(([key]) => row[key])));
  return [header, divider, ...body].join("\n");
}

export { formatBytes };

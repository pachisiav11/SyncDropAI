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

const MIME_BY_EXT = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
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

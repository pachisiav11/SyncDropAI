// File source and sink for Node.
//
// Both read and write a slice at a time, so the CLI can move a file larger than
// memory without ever holding more than one chunk.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".js": "application/javascript",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg"
};

export function guessMime(filename) {
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export async function fileSource(filePath, { name } = {}) {
  const resolved = path.resolve(filePath);
  const stats = await fsp.stat(resolved);
  if (!stats.isFile()) throw new Error(`${filePath} is not a file`);

  const handle = await fsp.open(resolved, "r");
  return {
    name: name ?? path.basename(resolved),
    mime: guessMime(resolved),
    size: stats.size,
    path: resolved,
    async readChunk(offset, length) {
      if (length <= 0) return new Uint8Array(0);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    },
    async close() {
      await handle.close();
    }
  };
}

function uniquePath(directory, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function sanitize(filename) {
  const base = path.basename(String(filename || "syncdrop-file"));
  const cleaned = base.replace(/[<>:"/\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim();
  return cleaned.replace(/^\.+/, "").slice(0, 150) || "syncdrop-file";
}

// Writes into <dir>/<name>.part and renames on close, so a failed transfer
// never leaves something that looks like a finished file.
export function directorySink(directory) {
  return async (info) => {
    await fsp.mkdir(directory, { recursive: true });
    const target = uniquePath(directory, sanitize(info.name));
    const temp = `${target}.part`;
    const handle = await fsp.open(temp, "w");

    return {
      resumeFrom: 0,
      async write(sequence, bytes) {
        await handle.write(bytes, 0, bytes.length, sequence * info.chunkSize);
      },
      async close() {
        await handle.close();
        await fsp.rename(temp, target);
        this.path = target;
        this.result = { name: path.basename(target), path: target, size: info.size };
      },
      async abort() {
        await handle.close().catch(() => {});
        await fsp.rm(temp, { force: true }).catch(() => {});
      }
    };
  };
}

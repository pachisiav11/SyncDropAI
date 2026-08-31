// Byte, encoding, and formatting helpers shared by every runtime that speaks
// the SyncDrop protocol: the browser/PWA app, the Tauri webview, the Node CLI,
// and the signaling server. Nothing here may touch the DOM or node: builtins.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// Crockford's decode aliases: I/L read as 1, O reads as 0, U is never emitted.
const CROCKFORD_DECODE = (() => {
  const map = new Map();
  for (let i = 0; i < CROCKFORD.length; i += 1) map.set(CROCKFORD[i], i);
  map.set("I", 1);
  map.set("L", 1);
  map.set("O", 0);
  return map;
})();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text) {
  return encoder.encode(text);
}

export function fromUtf8(bytes) {
  return decoder.decode(bytes);
}

// getRandomValues refuses more than 65536 bytes in one call, so fill in slices.
// Callers ask for large buffers in tests and for nonce material in bulk, and a
// QuotaExceededError from the crypto layer is a confusing way to learn that.
const RANDOM_MAX = 65536;

export function randomBytes(length) {
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += RANDOM_MAX) {
    globalThis.crypto.getRandomValues(out.subarray(offset, Math.min(offset + RANDOM_MAX, length)));
  }
  return out;
}

export function concat(...parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Expected binary data");
}

export function b64u(input) {
  const bytes = toBytes(input);
  let binary = "";
  // Chunked so a large payload doesn't blow the argument limit of String.apply.
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text) {
  const padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function hex(input) {
  return Array.from(toBytes(input), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function unhex(text) {
  const clean = String(text).trim();
  if (clean.length % 2) throw new Error("Odd-length hex string");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// Crockford base32: no I/L/O/U, so codes survive being read aloud or retyped.
export function base32(input) {
  const bytes = toBytes(input);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(text) {
  const clean = String(text).toUpperCase().replace(/[^0-9A-Z]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const digit = CROCKFORD_DECODE.get(char);
    if (digit === undefined) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// Constant-time comparison. Used on confirmation tags and auth signatures,
// where an early return would leak how much of the value the caller guessed.
export function equalBytes(a, b) {
  const left = toBytes(a);
  const right = toBytes(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function groupCode(text, size = 4) {
  return String(text).replace(new RegExp(`(.{${size}})(?=.)`, "g"), "$1-");
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Monotonic-ish clock that still works in webviews without performance.now().
export function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

export function shortId(length = 12) {
  return base32(randomBytes(Math.ceil((length * 5) / 8))).slice(0, length);
}

// Deterministic JSON: object keys sorted at every level, so two runtimes that
// build the same logical value always produce byte-identical output. Handshake
// signatures and confirmation tags are computed over this, so any divergence
// here breaks pairing — keep it boring and total.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  const body = keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",");
  return "{" + body + "}";
}

export function canonicalBytes(value) {
  return utf8(canonicalJson(value));
}

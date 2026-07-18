// Shared session store for the "app-only auth" bridge.
//
// NODE-ONLY. Unlike ./filenames.js this module uses node:fs/os/path and must
// never be imported into the browser bundle (src/app.js). It is imported by the
// Electron main process (electron/main.js), which WRITES the session whenever
// the desktop app signs in/out, and by the syncdrop CLI (cli/), which READS it.
//
// The CLI does not run its own login flow — it consumes whatever the desktop
// app last wrote here. The file holds the Supabase project URL + public anon
// key (safe to store; the anon key is already shipped in the client bundle)
// plus the current access/refresh tokens.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".syncdrop");
export const SESSION_FILE = path.join(CONFIG_DIR, "session.json");
// Backing store for supabase-js's own persistence. The packaged app loads over
// file://, where Chromium hands out a localStorage that never flushes to disk —
// so the library's default storage silently loses the session on every quit.
// This file replaces it (see the authStorage bridge in electron/preload.cjs).
export const AUTH_STORE_FILE = path.join(CONFIG_DIR, "auth-store.json");

export function sessionFilePath() {
  return SESSION_FILE;
}

// Both files carry auth tokens, so they get identical owner-only treatment.
function writeSecretFile(file, contents) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op / unsupported on some Windows setups — ignore.
  }
}

export function readSession() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSession(data) {
  // Best-effort: written to the user's home dir; readable only by them on most
  // platforms. On POSIX, tighten to 0600 since it carries auth tokens.
  writeSecretFile(SESSION_FILE, JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2));
}

export function clearSession() {
  try {
    fs.rmSync(SESSION_FILE, { force: true });
  } catch {
    // Nothing to remove.
  }
}

// --- supabase-js storage adapter backing ---
// A flat key/value map; supabase-js owns the keys (sb-<ref>-auth-token) and the
// value shape, so we never parse the values — just persist the strings.

function readAuthStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_STORE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readAuthItem(key) {
  const value = readAuthStore()[key];
  return typeof value === "string" ? value : null;
}

export function writeAuthItem(key, value) {
  const store = readAuthStore();
  store[key] = String(value);
  writeSecretFile(AUTH_STORE_FILE, JSON.stringify(store, null, 2));
}

export function removeAuthItem(key) {
  const store = readAuthStore();
  if (!(key in store)) return;
  delete store[key];
  writeSecretFile(AUTH_STORE_FILE, JSON.stringify(store, null, 2));
}

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

export function sessionFilePath() {
  return SESSION_FILE;
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
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const payload = JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2);
  // Best-effort: written to the user's home dir; readable only by them on most
  // platforms. On POSIX, tighten to 0600 since it carries auth tokens.
  fs.writeFileSync(SESSION_FILE, payload, { mode: 0o600 });
  try {
    fs.chmodSync(SESSION_FILE, 0o600);
  } catch {
    // chmod is a no-op / unsupported on some Windows setups — ignore.
  }
}

export function clearSession() {
  try {
    fs.rmSync(SESSION_FILE, { force: true });
  } catch {
    // Nothing to remove.
  }
}

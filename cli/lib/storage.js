// File-backed vault storage for the CLI.
//
// The CLI has its own device identity rather than borrowing the desktop app's.
// That is the fix for the failure this rebuild started from: the old CLI reused
// the app's session file, and because refresh tokens rotate on use, whichever
// process refreshed first invalidated the other and the desktop app was signed
// out roughly every hour. Two devices, two keypairs, nothing shared, nothing to
// rotate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".syncdrop");
const VAULT_DIR = path.join(CONFIG_DIR, "vault");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function safeKey(key) {
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(String(key))) throw new Error("Invalid vault key");
  return String(key);
}

export function fileStorage() {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  const entry = (key) => path.join(VAULT_DIR, `${safeKey(key)}.json`);

  return {
    async getItem(key) {
      try {
        return fs.readFileSync(entry(key), "utf8");
      } catch {
        return null;
      }
    },
    async setItem(key, value) {
      const file = entry(key);
      const temp = `${file}.tmp`;
      // Private keys: owner-only, and written then renamed so an interrupted
      // write cannot destroy an identity that exists nowhere else.
      fs.writeFileSync(temp, String(value), { mode: 0o600 });
      fs.renameSync(temp, file);
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // chmod is a no-op on some Windows setups.
      }
    },
    async removeItem(key) {
      fs.rmSync(entry(key), { force: true });
    }
  };
}

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function serverUrl() {
  return process.env.SYNCDROP_SERVER || readConfig().server || "http://localhost:8787";
}

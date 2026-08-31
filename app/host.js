// Platform adapters.
//
// The same bundle runs as a web app, as an installed PWA on the phone, and
// inside the Tauri webview on Windows. Everything platform-specific is behind
// this one module: where the vault is kept, where a received file lands, and
// whether a local model is available to name files.

import { createBrowserSink, saveToDisk } from "./sinks.js";
import { webStorage } from "../protocol/vault.js";

const TAURI = () => globalThis.__TAURI__?.core?.invoke ?? null;

export function isTauri() {
  return Boolean(TAURI());
}

export function detectPlatform() {
  if (isTauri()) return "windows";
  const ua = navigator.userAgent || "";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/windows/i.test(ua)) return "windows";
  if (/mac os/i.test(ua)) return "macos";
  if (/linux/i.test(ua)) return "linux";
  return "web";
}

export function defaultDeviceName(platform) {
  const guess = {
    windows: "Windows PC",
    android: "Android phone",
    ios: "iPhone",
    macos: "Mac",
    linux: "Linux PC"
  };
  return guess[platform] ?? "SyncDrop device";
}

// --- Tauri ------------------------------------------------------------------

// Bulk bytes go through Tauri's raw-body invoke path. Passing a Uint8Array as
// a normal argument would be serialised as a JSON array of numbers, which for a
// 4 MiB slice means tens of megabytes of text per call.
async function rawInvoke(command, headers, bytes) {
  const invoke = TAURI();
  return invoke(command, bytes, { headers });
}

function tauriHost() {
  const invoke = TAURI();

  return {
    kind: "tauri",
    storage: {
      async getItem(key) {
        return invoke("vault_load", { key });
      },
      async setItem(key, value) {
        return invoke("vault_save", { key, value: String(value) });
      },
      async removeItem(key) {
        return invoke("vault_clear", { key });
      }
    },

    // Received files stream into OPFS exactly as they do on the web, then land
    // on disk in one pass. That keeps a single receive path for every platform
    // and still costs only one IPC call per 4 MiB.
    createSink: createBrowserSink(),

    canAutoSave: true,

    async save(result, { chunkSize = 4 * 1024 * 1024 } = {}) {
      const token = await invoke("file_begin", { name: result.name });
      try {
        for (let offset = 0; offset < result.size; offset += chunkSize) {
          const slice = result.file.slice(offset, Math.min(offset + chunkSize, result.size));
          await rawInvoke("file_append", { token }, new Uint8Array(await slice.arrayBuffer()));
        }
        const path = await invoke("file_finish", { token });
        await result.release?.();
        return path;
      } catch (error) {
        await invoke("file_abort", { token }).catch(() => {});
        throw error;
      }
    },

    reveal: (path) => invoke("reveal", { path }),

    // The vision model runs locally on this machine, so naming costs nothing
    // and no file content leaves the device to get a name.
    async suggestName(file) {
      const head = new Uint8Array(await file.slice(0, 8 * 1024 * 1024).arrayBuffer());
      return rawInvoke("suggest_name", { name: file.name, mime: file.type || "application/octet-stream" }, head);
    },

    async deviceName() {
      return invoke("device_name").catch(() => defaultDeviceName("windows"));
    }
  };
}

// --- browser ----------------------------------------------------------------

function browserHost(platform) {
  return {
    kind: "web",
    storage: webStorage(),
    createSink: createBrowserSink(),
    canAutoSave: false,
    async save(result) {
      saveToDisk(result);
      return null;
    },
    reveal: async () => {},
    // No local model in a browser; the sender keeps the original filename.
    suggestName: async () => null,
    async deviceName() {
      return defaultDeviceName(platform);
    }
  };
}

export function createHost() {
  const platform = detectPlatform();
  const host = isTauri() ? tauriHost() : browserHost(platform);
  return { ...host, platform };
}

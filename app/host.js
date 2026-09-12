// Platform adapters.
//
// The same bundle runs as a web app, as an installed PWA on the phone, and
// inside the Tauri webview on Windows. Everything platform-specific is behind
// this one module: where the vault is kept, where a received file lands, and
// whether a local model is available to name files.

import { createBrowserSink, saveToDisk, sweepIncoming } from "./sinks.js";
import { webStorage } from "../protocol/vault.js";
import { hasNativeShare, onNativeShare, takeNativeShares } from "./shares.js";
import { windowedSource } from "../protocol/sources.js";

const TAURI = () => globalThis.__TAURI__?.core?.invoke ?? null;

// Subscribing is itself a core command, so it is gated by the capability file
// rather than being local to this app. A denial comes back as a rejected
// promise that nothing is waiting on, which is how a broken bridge used to
// look identical to a push that had simply not happened yet.
function listen(name, handler) {
  const bridge = globalThis.__TAURI__?.event?.listen;
  if (!bridge) return Promise.reject(new Error("The Tauri event bridge is missing"));
  return bridge(name, (event) => handler(event.payload));
}

export function isTauri() {
  return Boolean(TAURI());
}

// Tauri serves the window from its own protocol and Capacitor serves the Android
// build from https://localhost. Neither origin has anything to do with where the
// relay lives, so an installed app must be told rather than left to guess.
export function isNative() {
  return isTauri() || Boolean(globalThis.Capacitor?.isNativePlatform?.());
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

    async save(result, { chunkSize = 4 * 1024 * 1024, dir = "" } = {}) {
      const token = await invoke("file_begin", { name: result.name, dir });
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

    // Answers with the folder that would actually be used, so the settings
    // dialog can show the default instead of an empty box and can refuse a path
    // that is not there while it is still open.
    resolveDownloadDir: (dir) => invoke("resolve_download_dir", { dir }),

    // The desktop app writes straight to the download folder, so its staging
    // area is released as each transfer completes and there is nothing to sweep.
    sweep: async () => 0,

    // The vision model runs on this machine, so naming costs nothing and no
    // file content leaves the device to get a name. Only the first slice is
    // read: a model cannot use more than that, and a 4 GB video should not be
    // walked end to end to be given a title.
    async suggestName(source) {
      const head = await source.readChunk(0, Math.min(source.size, 8 * 1024 * 1024));
      return rawInvoke("suggest_name", { name: source.name, mime: source.mime }, head);
    },

    // "Send to > SyncDrop" and the Explorer right-click reach the running
    // window as file paths. The bytes stay on the Rust side until they are sent.
    async takeShares() {
      const entries = await invoke("inbox_take").catch(() => []);
      return entries.map((entry) =>
        windowedSource({
          name: entry.name,
          mime: entry.mime,
          size: entry.size,
          // inbox_read answers on the raw response body, so this comes back
          // as an ArrayBuffer rather than a JSON array of numbers.
          fetchWindow: (offset, length) =>
            invoke("inbox_read", { path: entry.path, offset, length }).then(
              (bytes) => new Uint8Array(bytes)
            )
        })
      );
    },

    onShare(handler) {
      return listen("shared-files", () => handler());
    },

    async deviceName() {
      return invoke("device_name").catch(() => defaultDeviceName("windows"));
    },

    namerReady: () => invoke("namer_ready").catch(() => false),

    fetchNamer: () => invoke("namer_fetch"),

    namerProgress: () => invoke("namer_progress"),

    onNamerProgress(handler) {
      return listen("namer-progress", handler);
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
      return saveToDisk(result);
    },
    reveal: async () => {},
    // A browser and a phone put downloads where they put downloads; neither
    // lets a page choose, so there is nothing here to configure.
    resolveDownloadDir: async () => "",
    sweep: sweepIncoming,
    // No local model in a browser or on the phone; the sender keeps the
    // original filename. Naming is a laptop feature by design: it runs a vision
    // model, and a phone should not be asked to.
    suggestName: async () => null,
    namerReady: async () => false,
    fetchNamer: async () => {},
    namerProgress: async () => ({ done: 0, total: 0, running: false }),
    onNamerProgress: () => {},
    // The Android build registers a share-sheet plugin; a plain browser tab has
    // nothing to take, and the installed PWA gets its shares through the
    // service worker instead.
    takeShares: () => (hasNativeShare() ? takeNativeShares() : Promise.resolve([])),
    onShare: (handler) => onNativeShare(handler),
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

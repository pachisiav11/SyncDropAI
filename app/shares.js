// Files that arrive from the operating system rather than from the page.
//
// Three routes end up here and all three produce the same thing — a list of
// sources the send panel can queue:
//
//   * the Android share sheet, through a native plugin in the Capacitor build
//   * the Web Share Target, when the app is installed as a PWA from a browser
//   * a Windows "Send to" or right-click, which reaches the Tauri window as
//     command-line arguments and is picked up by the Tauri host adapter
//
// None of them copies the file first. Each source reads the bytes on demand, so
// picking a 2 GB video from the share sheet costs nothing until it is sent.

import { windowedSource } from "../protocol/sources.js";

function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Android share sheet (Capacitor build) ----------------------------------

let nativeShare;

// Capacitor 7 exposes a native-only plugin through registerPlugin rather than
// the legacy Plugins map, and the guard keeps a plain browser tab - where
// registerPlugin would hand back a proxy that rejects every call - out of it.
function sharePlugin() {
  if (nativeShare !== undefined) return nativeShare;
  const capacitor = globalThis.Capacitor;
  nativeShare = capacitor?.isNativePlatform?.()
    ? capacitor.Plugins?.ShareTarget ?? capacitor.registerPlugin?.("ShareTarget") ?? null
    : null;
  return nativeShare;
}

export function hasNativeShare() {
  return Boolean(sharePlugin());
}

export async function takeNativeShares() {
  const plugin = sharePlugin();
  if (!plugin) return [];
  const { files = [] } = await plugin.take();
  return files.map((file) =>
    windowedSource({
      name: file.name,
      mime: file.mime,
      size: file.size,
      async fetchWindow(offset, length) {
        const { data } = await plugin.read({ id: file.id, offset, length });
        return decodeBase64(data ?? "");
      },
      release: () => plugin.release({ id: file.id })
    })
  );
}

// Fires when a share arrives while the app is already open. singleTask on the
// activity means that is the normal case, not the exception.
export function onNativeShare(handler) {
  const plugin = sharePlugin();
  if (!plugin) return () => {};
  const pending = Promise.resolve(plugin.addListener("shareReceived", () => handler()));
  return () => pending.then((listener) => listener?.remove?.()).catch(() => {});
}

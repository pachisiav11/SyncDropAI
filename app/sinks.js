// Where received bytes go in a browser.
//
// A transfer arrives without a user gesture, so showSaveFilePicker is not
// available at that moment. Instead the file is streamed into the origin
// private file system as it arrives - which keeps memory flat for a multi-GB
// file - and the UI offers a Save button afterwards, where a click does supply
// the gesture a download needs.
//
// Runtimes without OPFS fall back to memory, which is fine for the sizes those
// runtimes are realistically handed.

const OPFS_DIR = "incoming";

function hasOpfs() {
  return typeof navigator !== "undefined" && navigator.storage?.getDirectory;
}

// One positional write per 64 KiB chunk measures about 73 MB/s; gathering them
// into 4 MiB writes measures about 388 MB/s for the same bytes. The receiver is
// the slow half of a fast transfer, so this is worth the buffer.
const WRITE_BATCH = 4 * 1024 * 1024;

async function opfsSink(info, tempName) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const handle = await dir.getFileHandle(tempName, { create: true });
  const writable = await handle.createWritable();

  // Chunks normally arrive in order, so they are gathered here and written in
  // one go. A chunk that does not continue the run flushes what is held and
  // starts a new one, which keeps out-of-order delivery correct rather than
  // fast.
  let batch = null;
  let batchStart = 0;
  let batchUsed = 0;

  const flush = async () => {
    if (batchUsed === 0) return;
    await writable.write({ type: "write", position: batchStart, data: batch.subarray(0, batchUsed) });
    batchUsed = 0;
  };

  return {
    resumeFrom: 0,
    async write(sequence, bytes) {
      const position = sequence * info.chunkSize;
      if (batchUsed > 0 && position !== batchStart + batchUsed) await flush();
      if (batchUsed === 0) batchStart = position;
      if (!batch) batch = new Uint8Array(WRITE_BATCH + info.chunkSize);
      batch.set(bytes, batchUsed);
      batchUsed += bytes.length;
      if (batchUsed >= WRITE_BATCH) await flush();
    },
    async close() {
      await flush();
      await writable.close();
      const file = await handle.getFile();
      this.result = {
        name: info.name,
        mime: info.mime,
        size: file.size,
        file,
        url: URL.createObjectURL(file),
        release: () => dir.removeEntry(tempName).catch(() => {})
      };
    },
    async abort() {
      batchUsed = 0;
      await writable.abort().catch(() => {});
      await dir.removeEntry(tempName).catch(() => {});
    }
  };
}

function memorySink(info) {
  const chunks = [];
  return {
    resumeFrom: 0,
    async write(sequence, bytes) {
      chunks[sequence] = bytes.slice();
    },
    async close() {
      const blob = new Blob(chunks.filter(Boolean), { type: info.mime || "application/octet-stream" });
      this.result = {
        name: info.name,
        mime: info.mime,
        size: blob.size,
        file: blob,
        url: URL.createObjectURL(blob),
        release: () => {}
      };
    },
    async abort() {
      chunks.length = 0;
    }
  };
}

export function createBrowserSink() {
  let counter = 0;
  return async (info) => {
    if (!hasOpfs()) return memorySink(info);
    counter += 1;
    const tempName = `${Date.now()}-${counter}.part`;
    try {
      return await opfsSink(info, tempName);
    } catch {
      // A private window, a quota refusal, or a browser without writable OPFS.
      return memorySink(info);
    }
  };
}

// Chunked, because a received file can be gigabytes and every byte crosses the
// Capacitor bridge as base64, a third larger again.
const SAVE_CHUNK = 1024 * 1024;

let savePlugin;

// Capacitor 7 reaches a native-only plugin through registerPlugin. The guard
// keeps a plain browser tab out of it, where that call hands back a proxy which
// rejects everything.
function nativeSaver() {
  if (savePlugin !== undefined) return savePlugin;
  const capacitor = globalThis.Capacitor;
  savePlugin = capacitor?.isNativePlatform?.()
    ? capacitor.Plugins?.SaveFile ?? capacitor.registerPlugin?.("SaveFile") ?? null
    : null;
  return savePlugin;
}

function toBase64(bytes) {
  let binary = "";
  // In slices, because the argument list of a single apply is not unbounded and
  // a megabyte of bytes is well past it.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

async function saveNatively(plugin, result) {
  const { token } = await plugin.begin({
    name: result.name,
    mime: result.mime || "application/octet-stream"
  });
  try {
    for (let offset = 0; offset < result.size; offset += SAVE_CHUNK) {
      const slice = result.file.slice(offset, Math.min(offset + SAVE_CHUNK, result.size));
      await plugin.append({ token, data: toBase64(new Uint8Array(await slice.arrayBuffer())) });
    }
    const { path } = await plugin.finish({ token });
    return path;
  } catch (error) {
    await plugin.abort({ token }).catch(() => {});
    throw error;
  }
}

// Triggering a download needs a click to have happened, so this is only ever
// called from a button handler.
//
// On Android the link below does nothing whatsoever: a WebView ignores the
// download attribute, so the Save button was drawn and pressed and no file ever
// appeared. There the bytes go through a native plugin into the phone's
// Downloads folder instead.
export async function saveToDisk(result) {
  const plugin = nativeSaver();
  if (plugin) return saveNatively(plugin, result);

  const anchor = document.createElement("a");
  anchor.href = result.url;
  anchor.download = result.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  return null;
}

// Received files are streamed into OPFS before the user decides where to keep
// them. Anything still sitting there at startup is a leftover: the activity list
// survives a reload now, but the handle on the file does not, so no button can
// reach those bytes any more and leaving them would mean every file the phone
// has ever received is stored twice for good. Nothing is in flight at boot, so
// this is safe to run then and only then.
export async function sweepIncoming() {
  if (!hasOpfs()) return 0;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false });
    const names = [];
    for await (const [name] of dir.entries()) names.push(name);
    for (const name of names) await dir.removeEntry(name).catch(() => {});
    return names.length;
  } catch {
    // No incoming directory yet, or storage the browser will not open.
    return 0;
  }
}

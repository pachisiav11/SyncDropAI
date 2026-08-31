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

async function opfsSink(info, tempName) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const handle = await dir.getFileHandle(tempName, { create: true });
  const writable = await handle.createWritable();

  return {
    resumeFrom: 0,
    async write(sequence, bytes) {
      // Positional writes, so a transport that delivers out of order still
      // lands every chunk at its correct offset.
      await writable.write({ type: "write", position: sequence * info.chunkSize, data: bytes });
    },
    async close() {
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

// Triggering a download needs a click to have happened, so this is only ever
// called from a button handler.
export function saveToDisk(result) {
  const anchor = document.createElement("a");
  anchor.href = result.url;
  anchor.download = result.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

// Sources and sinks: the two ends the transfer engine reads from and writes to.
//
// The engine never touches a File, a filesystem, or a Blob directly. Hosts plug
// in whichever pair suits them - a Blob source in the browser, a file-descriptor
// source in the CLI, a streaming-to-disk sink under Tauri - and the state
// machine above stays identical.

export function bytesSource({ name, mime = "application/octet-stream", bytes }) {
  return {
    name,
    mime,
    size: bytes.length,
    async readChunk(offset, length) {
      return bytes.subarray(offset, offset + length);
    }
  };
}

// Browser File or Blob. Reading a slice at a time keeps memory flat: a 4 GB
// video never exists in the page as anything larger than one chunk.
export function blobSource(file, { name = file.name, mime = file.type } = {}) {
  return {
    name,
    mime: mime || "application/octet-stream",
    size: file.size,
    async readChunk(offset, length) {
      const slice = file.slice(offset, offset + length);
      return new Uint8Array(await slice.arrayBuffer());
    }
  };
}

// Collects into memory and hands back one buffer. Fine for the CLI and tests;
// hosts that receive large files should write straight to disk instead.
export function memorySink() {
  return (info) => {
    const chunks = [];
    let total = 0;
    return {
      resumeFrom: 0,
      async write(sequence, bytes) {
        chunks[sequence] = bytes.slice();
        total += bytes.length;
      },
      async close() {
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          if (!chunk) continue;
          out.set(chunk, offset);
          offset += chunk.length;
        }
        this.result = { name: info.name, mime: info.mime, bytes: out };
      },
      async abort() {
        chunks.length = 0;
      }
    };
  };
}

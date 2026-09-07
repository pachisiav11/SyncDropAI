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

// How much of a file to pull in at once from whatever is holding it. The engine
// asks for 64 KiB at a time, and honouring that literally is slow for every
// backing store there is: a Blob slice, a native bridge, a file handle. Reading
// a few megabytes and serving slices out of it measures eight times faster on a
// browser Blob, and it does not change what the page holds - one window, not
// one file.
const SOURCE_WINDOW = 4 * 1024 * 1024;

// A source over anything that can hand back a range of bytes. `fetchWindow` is
// called with an offset and a length and must return at least that many bytes
// unless the file ends first.
export function windowedSource({ name, mime, size, fetchWindow, close }) {
  let window = null;
  let windowStart = 0;

  return {
    name,
    mime: mime || "application/octet-stream",
    size,
    async readChunk(offset, length) {
      const end = Math.min(offset + length, size);
      if (end <= offset) return new Uint8Array(0);
      if (!window || offset < windowStart || end > windowStart + window.length) {
        windowStart = offset;
        window = await fetchWindow(offset, Math.min(Math.max(SOURCE_WINDOW, length), size - offset));
        if (window.length === 0) return new Uint8Array(0);
      }
      return window.subarray(offset - windowStart, end - windowStart);
    },
    async close() {
      window = null;
      await close?.();
    }
  };
}

// Browser File or Blob. Memory stays flat whatever the file size: a 4 GB video
// never exists in the page as anything larger than one window.
export function blobSource(file, { name = file.name, mime = file.type } = {}) {
  return windowedSource({
    name,
    mime,
    size: file.size,
    async fetchWindow(offset, length) {
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    }
  });
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

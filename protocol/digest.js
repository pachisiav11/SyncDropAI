// Streaming integrity check.
//
// WebCrypto has no incremental digest, and a transfer must not require holding
// the whole file in memory to hash it. So we hash each fixed-size chunk and
// then hash the ordered concatenation of those chunk hashes. Both sides compute
// it as the bytes go past, and a mismatch at the end means the file that landed
// is not the file that was sent.
//
// Chunk hashes are stored by index rather than appended, so a transport that
// delivers out of order still produces the same digest.

import { sha256 } from "./crypto.js";
import { b64u, concat } from "./util.js";

export function createChunkDigest() {
  const hashes = [];

  return {
    async update(index, bytes) {
      hashes[index] = await sha256(bytes);
    },
    get count() {
      return hashes.filter(Boolean).length;
    },
    async final() {
      const present = [];
      for (let i = 0; i < hashes.length; i += 1) {
        if (!hashes[i]) throw new Error(`Digest is missing chunk ${i}`);
        present.push(hashes[i]);
      }
      return b64u(await sha256(concat(...present)));
    }
  };
}

export async function digestBytes(bytes, chunkSize) {
  const digest = createChunkDigest();
  let index = 0;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    await digest.update(index, bytes.subarray(offset, offset + chunkSize));
    index += 1;
  }
  // A zero-length file still needs a defined digest.
  if (index === 0) await digest.update(0, new Uint8Array(0));
  return digest.final();
}

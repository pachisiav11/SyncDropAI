// Storage backends for the relay server.
//
// Everything stored here is either routing metadata or ciphertext. The server
// never holds a content key, a filename, or a plaintext byte, so the choice of
// backend is an operational question, not a privacy one.
//
// memory - tests and ephemeral use
// disk   - self-hosting on a box you own
// R2 + Durable Objects live in server/worker behind this same interface.

import { RELAY_TTL_DAYS } from "../protocol/constants.js";
import { b64u, randomBytes, shortId } from "../protocol/util.js";

export const DEFAULT_TTL_MS = RELAY_TTL_DAYS * 24 * 60 * 60 * 1000;

function newToken() {
  return b64u(randomBytes(24));
}

function blobRecord({ owner, recipient, parts, size, ttlMs }) {
  const createdAt = Date.now();
  return {
    blobId: shortId(20),
    owner,
    recipient: recipient ?? null,
    parts,
    size,
    complete: false,
    received: 0,
    writeToken: newToken(),
    readToken: newToken(),
    createdAt,
    expiresAt: createdAt + (ttlMs ?? DEFAULT_TTL_MS)
  };
}

export function createMemoryStore() {
  const devices = new Map();
  const mailboxes = new Map();
  const blobs = new Map();
  const parts = new Map();

  const partKey = (blobId, index) => blobId + "/" + index;

  return {
    kind: "memory",
    devices: {
      async put(record) {
        devices.set(record.deviceId, { ...record, seenAt: Date.now() });
      },
      async get(deviceId) {
        return devices.get(deviceId) ?? null;
      }
    },
    mailbox: {
      async push(to, envelope) {
        const id = shortId(16);
        const entry = { id, to, envelope, createdAt: Date.now() };
        if (!mailboxes.has(to)) mailboxes.set(to, new Map());
        mailboxes.get(to).set(id, entry);
        return entry;
      },
      async list(to) {
        const found = mailboxes.get(to);
        return found ? [...found.values()].sort((a, b) => a.createdAt - b.createdAt) : [];
      },
      async count(to) {
        return mailboxes.get(to)?.size ?? 0;
      },
      async get(to, id) {
        return mailboxes.get(to)?.get(id) ?? null;
      },
      async ack(to, id) {
        return Boolean(mailboxes.get(to)?.delete(id));
      }
    },
    blobs: {
      async create(options) {
        const record = blobRecord(options);
        blobs.set(record.blobId, record);
        return record;
      },
      async get(blobId) {
        return blobs.get(blobId) ?? null;
      },
      async putPart(blobId, index, bytes) {
        const record = blobs.get(blobId);
        if (!record) return null;
        const key = partKey(blobId, index);
        if (!parts.has(key)) record.received += 1;
        parts.set(key, bytes);
        return record;
      },
      async getPart(blobId, index) {
        return parts.get(partKey(blobId, index)) ?? null;
      },
      async complete(blobId) {
        const record = blobs.get(blobId);
        if (!record) return null;
        record.complete = true;
        return record;
      },
      async remove(blobId) {
        const record = blobs.get(blobId);
        if (!record) return false;
        for (let i = 0; i < record.parts; i += 1) parts.delete(partKey(blobId, i));
        blobs.delete(blobId);
        return true;
      },
      async sweep(now = Date.now()) {
        let removed = 0;
        for (const [blobId, record] of blobs) {
          if (record.expiresAt <= now) {
            for (let i = 0; i < record.parts; i += 1) parts.delete(partKey(blobId, i));
            blobs.delete(blobId);
            removed += 1;
          }
        }
        return removed;
      }
    }
  };
}

// Disk-backed store for self-hosting. Node-only, imported lazily by
// server/node.js so neither the browser bundle nor the Worker pulls in node:fs.
export async function createDiskStore(directory) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const dirs = {
    devices: path.join(directory, "devices"),
    mailbox: path.join(directory, "mailbox"),
    blobs: path.join(directory, "blobs")
  };
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });

  // Ids come from our own alphabet, but they still arrive over the wire, so
  // refuse anything that could escape the data directory.
  const safe = (id) => {
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(String(id))) throw new Error("Unsafe identifier");
    return String(id);
  };

  const readJson = async (file, fallback = null) => {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  };

  // Write-then-rename, so a crash mid-write cannot leave a half-parsed record.
  const writeJson = async (file, value) => {
    const temp = file + "." + shortId(8) + ".tmp";
    await fs.writeFile(temp, JSON.stringify(value));
    await fs.rename(temp, file);
  };

  const blobDir = (blobId) => path.join(dirs.blobs, safe(blobId));
  const metaFile = (blobId) => path.join(blobDir(blobId), "meta.json");
  const partFile = (blobId, index) => path.join(blobDir(blobId), "part-" + Number(index));
  const mailDir = (to) => path.join(dirs.mailbox, safe(to));
  const mailFile = (to, id) => path.join(mailDir(to), safe(id) + ".json");

  const listMail = async (to) => {
    const names = await fs.readdir(mailDir(to)).catch(() => []);
    const entries = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map((n) => readJson(path.join(mailDir(to), n)))
    );
    return entries.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
  };

  return {
    kind: "disk",
    directory,
    devices: {
      async put(record) {
        await writeJson(path.join(dirs.devices, safe(record.deviceId) + ".json"), { ...record, seenAt: Date.now() });
      },
      async get(deviceId) {
        return readJson(path.join(dirs.devices, safe(deviceId) + ".json"));
      }
    },
    mailbox: {
      async push(to, envelope) {
        const id = shortId(16);
        const entry = { id, to, envelope, createdAt: Date.now() };
        await fs.mkdir(mailDir(to), { recursive: true });
        await writeJson(mailFile(to, id), entry);
        return entry;
      },
      list: listMail,
      async count(to) {
        return (await listMail(to)).length;
      },
      async get(to, id) {
        return readJson(mailFile(to, id));
      },
      async ack(to, id) {
        try {
          await fs.rm(mailFile(to, id), { force: true });
          return true;
        } catch {
          return false;
        }
      }
    },
    blobs: {
      async create(options) {
        const record = blobRecord(options);
        await fs.mkdir(blobDir(record.blobId), { recursive: true });
        await writeJson(metaFile(record.blobId), record);
        return record;
      },
      async get(blobId) {
        return readJson(metaFile(blobId));
      },
      async putPart(blobId, index, bytes) {
        const record = await readJson(metaFile(blobId));
        if (!record) return null;
        const file = partFile(blobId, index);
        const existed = await fs.stat(file).then(() => true).catch(() => false);
        await fs.writeFile(file, bytes);
        if (!existed) {
          record.received += 1;
          await writeJson(metaFile(blobId), record);
        }
        return record;
      },
      async getPart(blobId, index) {
        return fs.readFile(partFile(blobId, index)).catch(() => null);
      },
      async complete(blobId) {
        const record = await readJson(metaFile(blobId));
        if (!record) return null;
        record.complete = true;
        await writeJson(metaFile(blobId), record);
        return record;
      },
      async remove(blobId) {
        try {
          await fs.rm(blobDir(blobId), { recursive: true, force: true });
          return true;
        } catch {
          return false;
        }
      },
      async sweep(now = Date.now()) {
        const names = await fs.readdir(dirs.blobs).catch(() => []);
        let removed = 0;
        for (const name of names) {
          const record = await readJson(path.join(dirs.blobs, name, "meta.json"));
          if (record && record.expiresAt <= now) {
            await fs.rm(path.join(dirs.blobs, name), { recursive: true, force: true });
            removed += 1;
          }
        }
        return removed;
      }
    }
  };
}

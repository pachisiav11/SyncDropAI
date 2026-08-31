// Everything a device must remember: its own identity and the devices it has
// paired with. Persisted through an injected key-value adapter so the same code
// backs localStorage on the web, the OS-encrypted store under Tauri, and a
// file on disk for the CLI.
//
// The identity is created on first open and then never changes. Nothing here
// has an expiry date, so "open the vault" cannot fail in a way that a user
// would have to fix by signing in.

import { createIdentity, deserializeIdentity, importPeer, serializeIdentity } from "./identity.js";

const IDENTITY_KEY = "syncdrop.identity";
const PEERS_KEY = "syncdrop.peers";

export async function openVault(storage, { name, platform } = {}) {
  const stored = await storage.getItem(IDENTITY_KEY);

  let identity;
  let created = false;
  if (stored) {
    identity = await deserializeIdentity(stored);
  } else {
    identity = await createIdentity({ name, platform });
    await storage.setItem(IDENTITY_KEY, serializeIdentity(identity));
    created = true;
  }

  const rawPeers = await storage.getItem(PEERS_KEY);
  const records = rawPeers ? JSON.parse(rawPeers) : [];
  const peers = new Map();
  for (const record of records) {
    try {
      peers.set(record.deviceId, { record, peer: await importPeer(record) });
    } catch {
      // A record whose id no longer matches its key is corrupt; drop it rather
      // than letting it poison every later lookup.
    }
  }

  const persistPeers = () =>
    storage.setItem(PEERS_KEY, JSON.stringify([...peers.values()].map((entry) => entry.record)));

  return {
    identity,
    created,

    async rename(newName) {
      identity.name = newName;
      await storage.setItem(IDENTITY_KEY, serializeIdentity(identity));
    },

    list() {
      return [...peers.values()].map((entry) => entry.record);
    },

    ids() {
      return [...peers.keys()];
    },

    get(deviceId) {
      return peers.get(deviceId)?.peer ?? null;
    },

    record(deviceId) {
      return peers.get(deviceId)?.record ?? null;
    },

    has(deviceId) {
      return peers.has(deviceId);
    },

    async add(record) {
      const peer = await importPeer(record);
      const existing = peers.get(record.deviceId);
      peers.set(record.deviceId, {
        record: { ...record, pairedAt: existing?.record.pairedAt ?? new Date().toISOString() },
        peer
      });
      await persistPeers();
      return peer;
    },

    async remove(deviceId) {
      const removed = peers.delete(deviceId);
      if (removed) await persistPeers();
      return removed;
    }
  };
}

// Adapters -------------------------------------------------------------------

export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, String(value));
    },
    async removeItem(key) {
      map.delete(key);
    }
  };
}

export function webStorage(backing = globalThis.localStorage) {
  return {
    async getItem(key) {
      return backing.getItem(key);
    },
    async setItem(key, value) {
      backing.setItem(key, String(value));
    },
    async removeItem(key) {
      backing.removeItem(key);
    }
  };
}

// The store.js interface, backed by Durable Objects and R2.
//
// server/core.js does not know or care which of the three stores it is talking
// to. That is the point of writing it this way: the rules that decide who may
// read a blob or claim a mailbox entry are the same lines of code on a laptop,
// on a Pi and on Cloudflare, so there is only ever one of them to get right.
//
// Only the blob data plane differs in shape. Parts are R2 objects written and
// read by the Worker directly, so bytes never pass through a Durable Object.

import { shortId } from "../../protocol/util.js";
import { partKey } from "./blob.js";

const post = (stub, path, body) =>
  stub.fetch("https://do/" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });

const readJson = async (response) => {
  if (!response.ok) throw new Error(`Durable Object returned ${response.status}`);
  return response.json();
};

export function createWorkerStore(env) {
  const device = (deviceId) => env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  const blob = (blobId) => env.BLOB.get(env.BLOB.idFromName(blobId));

  // A device id is the hash of the device's public key, so a record can never
  // change once it exists. That makes it safe to remember for the life of the
  // isolate and skip a Durable Object hop on every signed request.
  const records = new Map();

  return {
    kind: "cloudflare",
    devices: {
      // Registration happens inside DeviceObject during the socket handshake,
      // which is the only place a record can be proven. Nothing to do here.
      async put() {},
      async get(deviceId) {
        if (records.has(deviceId)) return records.get(deviceId);
        const { record } = await readJson(await post(device(deviceId), "record"));
        if (record) records.set(deviceId, record);
        return record;
      }
    },
    mailbox: {
      async push(to, envelope, from = null) {
        const entry = { id: shortId(16), to, from, envelope, createdAt: Date.now() };
        const response = await post(device(to), "mail/push", entry);
        if (response.status === 429) throw new Error("Recipient mailbox is full");
        return (await readJson(response)).entry;
      },
      async list(to) {
        return (await readJson(await post(device(to), "mail/list"))).entries;
      },
      async count(to) {
        return (await readJson(await post(device(to), "mail/count"))).count;
      },
      async get(to, id) {
        return (await readJson(await post(device(to), "mail/get", { id }))).entry;
      },
      async ack(to, id) {
        return (await readJson(await post(device(to), "mail/ack", { id }))).acked;
      }
    },
    blobs: {
      async create(options) {
        const blobId = shortId(20);
        const { record } = await readJson(await post(blob(blobId), "create", { ...options, blobId }));
        return record;
      },
      async get(blobId) {
        const { record } = await readJson(await post(blob(blobId), "meta"));
        return record;
      },
      async putPart(blobId, index, bytes) {
        await env.BLOBS.put(partKey(blobId, index), bytes);
        const { record } = await readJson(await post(blob(blobId), "received", { index }));
        return record;
      },
      async getPart(blobId, index) {
        const object = await env.BLOBS.get(partKey(blobId, index));
        if (!object) return null;
        return new Uint8Array(await object.arrayBuffer());
      },
      async complete(blobId) {
        const { record } = await readJson(await post(blob(blobId), "complete"));
        return record;
      },
      async remove(blobId) {
        const { removed } = await readJson(await post(blob(blobId), "remove"));
        return removed;
      },
      // Every blob carries its own alarm, so expiry has already happened by the
      // time anyone would think to sweep. Kept so the interface stays whole.
      async sweep() {
        return 0;
      }
    }
  };
}

// The three methods server/core.js asks of a hub. On a single host these are
// map lookups; here each one is a hop to the object that owns the device.
export function createWorkerHub(env) {
  const device = (deviceId) => env.DEVICE.get(env.DEVICE.idFromName(deviceId));

  return {
    async isOnline(deviceId) {
      try {
        const response = await device(deviceId).fetch("https://do/online");
        return response.ok ? (await response.json()).online : false;
      } catch {
        return false;
      }
    },
    async notifyMail(deviceId, count) {
      await post(device(deviceId), "deliver", { message: { type: "mail", count } }).catch(() => {});
    },
    async describe() {
      // There is no global connection count to report, and that is the design:
      // no single object sees every device, so no single object can be the
      // thing that falls over.
      return { host: "cloudflare", sharded: true };
    }
  };
}

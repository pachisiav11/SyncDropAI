// One Durable Object per queued blob — metadata only.
//
// The ciphertext itself never enters this object: parts go straight to
// Workers KV from the Worker, which is what keeps an 8 MB upload off the
// object's single thread. What lives here is the part count, the two
// capability tokens and the tally of which indices have landed, because that
// tally has to be exact and KV gives no atomic counter.
//
// The alarm is the whole expiry story. Instead of a nightly sweep over every
// blob in the system, each blob knows when it dies and deletes its own KV
// keys on the way out. Nothing has to enumerate anything. (Each KV value also
// carries its own expirationTtl as a second line of defense, in case a blob's
// alarm is ever lost.)

import { RELAY_TTL_DAYS } from "../../protocol/constants.js";
import { b64u, randomBytes } from "../../protocol/util.js";

const DEFAULT_TTL_MS = RELAY_TTL_DAYS * 24 * 60 * 60 * 1000;

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export const partKey = (blobId, index) => `blob/${blobId}/${index}`;

export class BlobObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  meta() {
    return this.state.storage.get("meta");
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.replace(/^\/+/, "");
    const body = await request.json().catch(() => ({}));

    switch (action) {
      case "create":
        return this.create(body);
      case "meta":
        return json({ record: (await this.meta()) ?? null });
      case "received":
        return this.received(body.index);
      case "complete": {
        const record = await this.meta();
        if (!record) return json({ record: null });
        record.complete = true;
        await this.state.storage.put("meta", record);
        return json({ record });
      }
      case "remove":
        return json({ removed: await this.destroy() });
      default:
        return json({ error: "No such blob action" }, 404);
    }
  }

  async create({ blobId, owner, recipient, parts, size, ttlMs }) {
    const createdAt = Date.now();
    const record = {
      blobId,
      owner,
      recipient: recipient ?? null,
      parts,
      size,
      complete: false,
      received: 0,
      writeToken: b64u(randomBytes(24)),
      readToken: b64u(randomBytes(24)),
      createdAt,
      expiresAt: createdAt + (ttlMs ?? DEFAULT_TTL_MS)
    };
    await this.state.storage.put("meta", record);
    await this.state.storage.setAlarm(record.expiresAt);
    return json({ record });
  }

  // Called after the bytes are already in R2. Counting here rather than at the
  // write means a retried part is free: the index is either new or it is not.
  async received(index) {
    const record = await this.meta();
    if (!record) return json({ record: null });
    const key = "p:" + Number(index);
    if ((await this.state.storage.get(key)) == null) {
      await this.state.storage.put(key, 1);
      record.received += 1;
      await this.state.storage.put("meta", record);
    }
    return json({ record });
  }

  async destroy() {
    const record = await this.meta();
    if (record) {
      // KV has no bulk-delete call, so each part is its own request. The
      // expirationTtl set at upload time means a failed delete here still
      // self-cleans, just not on this object's schedule.
      const keys = [];
      for (let i = 0; i < record.parts; i += 1) keys.push(partKey(record.blobId, i));
      await Promise.all(keys.map((key) => this.env.BLOBS.delete(key).catch(() => {})));
    }
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    return Boolean(record);
  }

  async alarm() {
    await this.destroy();
  }
}

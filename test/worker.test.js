// The Cloudflare host, run for real.
//
// Miniflare boots the same workerd runtime Cloudflare runs, with real Durable
// Objects and a real R2 bucket, and serves it over HTTP. So these are not mocks
// of the edge: the client below is the unmodified protocol client, talking to
// the unmodified Worker, over a socket that genuinely hibernates.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { Miniflare } from "miniflare";

import { createSyncDrop } from "../protocol/client.js";
import { memoryStorage, openVault } from "../protocol/vault.js";
import { bytesSource } from "../protocol/sources.js";

function startEdge() {
  return new Miniflare({
    port: 0,
    modules: true,
    modulesRoot: process.cwd(),
    // The protocol is plain ESM in .js files; without this the collector reads
    // them as CommonJS and every import fails to parse.
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    scriptPath: "server/worker/index.js",
    compatibilityDate: "2025-04-01",
    r2Buckets: ["BLOBS"],
    durableObjects: {
      DEVICE: { className: "DeviceObject", useSQLite: true },
      PAIR_ROOM: { className: "PairRoomObject", useSQLite: true },
      BLOB: { className: "BlobObject", useSQLite: true }
    }
  });
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 8000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await settle(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}


// The recipient's own view of its mailbox, fetched with a signed request.
async function mailboxOf(serverUrl, identity) {
  const { signRequest } = await import("../protocol/auth.js");
  const authorization = await signRequest(identity, "GET", "/api/mailbox");
  const response = await fetch(serverUrl + "/api/mailbox", { headers: { authorization } });
  const body = await response.json();
  return body.entries ?? [];
}

test("cloudflare host: pairing, presence and relay on Durable Objects", async (t) => {
  const edge = startEdge();
  const url = await edge.ready;
  const serverUrl = url.origin;

  const events = { phone: [], desk: [] };
  const landed = [];
  // A sink that keeps what it was given, so the test can compare the bytes the
  // desk actually wrote against the bytes the phone actually sent.
  const recordingSink = () => (info) => {
    const chunks = [];
    return {
      resumeFrom: 0,
      async write(sequence, bytes) {
        chunks[sequence] = bytes.slice();
      },
      async close() {
        const total = chunks.reduce((sum, chunk) => sum + (chunk?.length ?? 0), 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          if (!chunk) continue;
          out.set(chunk, offset);
          offset += chunk.length;
        }
        landed.push({ ...info, bytes: out });
        this.result = { name: info.name, mime: info.mime, bytes: out };
      },
      async abort() {}
    };
  };
  // The desk's storage is held separately so the test can close that device and
  // bring the same identity back up, which is what "asleep" means here.
  const deskStorage = memoryStorage();
  const phoneVault = await openVault(memoryStorage(), { name: "Phone", platform: "android" });
  const deskVault = await openVault(deskStorage, { name: "Desk", platform: "windows" });

  const phone = createSyncDrop({
    vault: phoneVault,
    serverUrl,
    createSink: recordingSink(),
    onEvent: (event) => events.phone.push(event)
  });
  const desk = createSyncDrop({
    vault: deskVault,
    serverUrl,
    createSink: recordingSink(),
    onEvent: (event) => events.desk.push(event)
  });

  let woken = null;
  t.after(async () => {
    phone.stop();
    desk.stop();
    woken?.stop();
    await edge.dispose();
  });

  await t.test("health reports the sharded host, not a connection count", async () => {
    const response = await fetch(serverUrl + "/api/health");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { ok: true, store: "cloudflare", host: "cloudflare", sharded: true });
  });

  await t.test("both devices authenticate over the sharded socket", async () => {
    await phone.start();
    await desk.start();
    assert.ok(phone.identity.deviceId);
    assert.ok(desk.identity.deviceId);
  });

  await t.test("a socket sent to the wrong shard is refused", async () => {
    const wrong = new URL(serverUrl);
    wrong.protocol = "ws:";
    wrong.pathname = "/ws";
    wrong.searchParams.set("d", desk.identity.deviceId);
    // Open a socket claiming to be the desk, then hand it the phone's key.
    const socket = new WebSocket(wrong.toString());
    const error = await new Promise((resolve, reject) => {
      socket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "challenge") {
          const { buildHandshake } = await import("../protocol/auth.js");
          socket.send(JSON.stringify(await buildHandshake(phone.identity, message.nonce)));
        }
        if (message.type === "error") resolve(message.message);
        if (message.type === "ready") reject(new Error("the impostor was accepted"));
      };
      setTimeout(() => reject(new Error("no answer")), 5000);
    });
    socket.close();
    assert.match(error, /does not match this connection/);
  });

  await t.test("two devices pair through a room object neither of them owns", async () => {
    const offer = phone.createPairingOffer();
    const [fromPhone, fromDesk] = await Promise.all([phone.pair(offer.code), desk.pair(offer.code)]);
    assert.equal(fromPhone.deviceId, desk.identity.deviceId);
    assert.equal(fromDesk.deviceId, phone.identity.deviceId);
    assert.equal(phone.peers().length, 1);
    assert.equal(desk.peers().length, 1);
  });

  await t.test("presence crosses object boundaries", async () => {
    await waitFor(() => phone.isOnline(desk.identity.deviceId), { label: "the desk to look online" });
    assert.equal(desk.isOnline(phone.identity.deviceId), true);
  });

  await t.test("a file rides the relay through R2 and lands intact", async () => {
    const bytes = new Uint8Array(nodeRandomBytes(400000));
    const source = bytesSource({ name: "budget.xlsx", mime: "application/vnd.ms-excel", bytes });
    const result = await phone.send(desk.identity.deviceId, source);
    assert.equal(result.via, "relay");

    await waitFor(() => events.desk.some((e) => e.type === "collected"), { label: "the desk to collect" });
    const collected = events.desk.find((e) => e.type === "collected");
    assert.equal(collected.name, "budget.xlsx");
    assert.equal(collected.mime, "application/vnd.ms-excel");
    assert.equal(landed.length, 1);
    assert.ok(Buffer.from(landed[0].bytes).equals(bytes), "bytes survive the round trip");
  });

  await t.test("a sleeping device gets its file when it wakes up", async () => {
    desk.stop();
    await waitFor(() => !phone.isOnline(desk.identity.deviceId), { label: "the desk to go offline" });

    const bytes = new Uint8Array(nodeRandomBytes(120000));
    const asleep = await phone.send(
      desk.identity.deviceId,
      bytesSource({ name: "while-you-were-out.zip", mime: "application/zip", bytes })
    );
    assert.equal(asleep.via, "relay");

    // A brand new client object over the same stored identity: this is the desk
    // being switched on again, not the old one resuming.
    woken = createSyncDrop({
      vault: await openVault(deskStorage),
      serverUrl,
      createSink: recordingSink(),
      onEvent: (event) => events.desk.push(event)
    });

    await woken.start();
    await waitFor(() => landed.some((file) => file.name === "while-you-were-out.zip"), {
      label: "the woken desk to collect"
    });
    const file = landed.find((entry) => entry.name === "while-you-were-out.zip");
    assert.ok(Buffer.from(file.bytes).equals(bytes), "the parked file is intact");
  });

  await t.test("the relay cannot say what it is holding", async () => {
    // Put the recipient back to sleep so the envelope stays where the operator
    // of the relay would find it.
    woken.stop();
    await waitFor(() => !phone.isOnline(desk.identity.deviceId), { label: "the desk to go offline again" });

    const bytes = new Uint8Array(nodeRandomBytes(60000));
    const secret = "salary-negotiation-notes.docx";
    await phone.send(desk.identity.deviceId, bytesSource({ name: secret, mime: "text/plain", bytes }));

    // Everything the bucket holds, as the operator would see it.
    const bucket = await edge.getR2Bucket("BLOBS");
    const listing = await bucket.list();
    assert.ok(listing.objects.length > 0, "there is ciphertext to inspect");

    const seen = [];
    for (const object of listing.objects) {
      const stored = await bucket.get(object.key);
      seen.push(new Uint8Array(await stored.arrayBuffer()));
    }
    const haystack = Buffer.concat(seen.map((part) => Buffer.from(part)));
    assert.equal(haystack.includes(Buffer.from(secret, "utf8")), false, "the filename is not in the bucket");
    assert.equal(haystack.includes(Buffer.from(bytes.subarray(0, 64))), false, "the content is not in the bucket");

    // And the routing metadata beside it names a recipient and a size, nothing else.
    const entries = await mailboxOf(serverUrl, desk.identity);
    const envelope = JSON.stringify(entries);
    assert.equal(envelope.includes(secret), false, "the mailbox does not name the file either");
    assert.match(envelope, /"blobId"/);
  });
});

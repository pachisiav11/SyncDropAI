import test from "node:test";
import assert from "node:assert/strict";

import { startServer } from "../server/node.js";
import { createApiClient } from "../protocol/api.js";
import { createIdentity, importPeer, publicRecord } from "../protocol/identity.js";
import { collectMailbox, receiveViaRelay, sendViaRelay } from "../protocol/relay.js";
import { bytesSource, memorySink } from "../protocol/sources.js";
import { equalBytes, randomBytes, utf8 } from "../protocol/util.js";
import { createSignalingClient } from "../protocol/signaling.js";

test("relay: an offline device collects a sealed transfer later", async (t) => {
  const server = await startServer({ port: 0, host: "127.0.0.1", verbose: false });
  const base = "http://127.0.0.1:" + server.port;
  const wsUrl = "ws://127.0.0.1:" + server.port + "/ws";

  const pc = await createIdentity({ name: "Desk PC", platform: "windows" });
  const phone = await createIdentity({ name: "Pixel", platform: "android" });
  const pcPeer = await importPeer(publicRecord(pc));
  const phonePeer = await importPeer(publicRecord(phone));

  // Both devices must be known to the server before they can use the signed
  // control API; a socket connection is how a device registers its public key.
  const sockets = [];
  for (const identity of [pc, phone]) {
    const client = createSignalingClient({ url: wsUrl, identity });
    await client.connect();
    sockets.push(client);
  }

  const pcApi = createApiClient({ baseUrl: base, identity: pc });
  const phoneApi = createApiClient({ baseUrl: base, identity: phone });

  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  await t.test("a small file round-trips through the mailbox", async () => {
    const bytes = randomBytes(20000);
    const sent = await sendViaRelay({
      api: pcApi,
      identity: pc,
      peer: phonePeer,
      source: bytesSource({ name: "invoice.pdf", mime: "application/pdf", bytes }),
      partSize: 8192
    });
    assert.equal(sent.parts, 3);

    const collected = await collectMailbox({
      api: phoneApi,
      identity: phone,
      resolvePeer: async (deviceId) => (deviceId === pc.deviceId ? pcPeer : null),
      createSink: memorySink()
    });

    assert.equal(collected.length, 1);
    assert.equal(collected[0].info.name, "invoice.pdf");
    assert.equal(collected[0].info.mime, "application/pdf");
    assert.ok(equalBytes(collected[0].result.bytes, bytes));
    assert.deepEqual(await phoneApi.listMail(), [], "collecting acks the envelope");
  });

  await t.test("the server never sees the filename or the plaintext", async () => {
    const marker = utf8("TOP-SECRET-PLAINTEXT-MARKER");
    const bytes = new Uint8Array(4096);
    bytes.set(marker, 0);

    await sendViaRelay({
      api: pcApi,
      identity: pc,
      peer: phonePeer,
      source: bytesSource({ name: "salary-letter.pdf", mime: "application/pdf", bytes }),
      partSize: 8192
    });

    const [entry] = await phoneApi.listMail();
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes("salary-letter"), "the filename is inside the sealed metadata");
    assert.ok(!serialized.includes("application/pdf"), "the mime type is sealed too");
    assert.equal(entry.envelope.size, 4096, "only the size is in the clear");

    const stored = await server.store.blobs.getPart(entry.envelope.blobId, 0);
    const haystack = Buffer.from(stored).toString("latin1");
    assert.ok(!haystack.includes("TOP-SECRET-PLAINTEXT-MARKER"), "stored bytes are ciphertext");
    assert.equal(stored.length, 4096 + 16, "ciphertext carries a GCM tag");

    await phoneApi.ackMail(entry.id);
  });

  await t.test("a tampered ciphertext part is caught", async () => {
    const bytes = randomBytes(3000);
    await sendViaRelay({
      api: pcApi,
      identity: pc,
      peer: phonePeer,
      source: bytesSource({ name: "report.txt", bytes }),
      partSize: 8192
    });

    const [entry] = await phoneApi.listMail();
    const original = await server.store.blobs.getPart(entry.envelope.blobId, 0);
    const flipped = Uint8Array.from(original);
    flipped[10] ^= 0xff;
    await server.store.blobs.putPart(entry.envelope.blobId, 0, flipped);

    await assert.rejects(
      () =>
        receiveViaRelay({
          api: phoneApi,
          identity: phone,
          envelope: entry.envelope,
          peer: pcPeer,
          createSink: memorySink()
        }),
      /operation-specific reason|decrypt|Cipher job failed|OperationError/i
    );
    await phoneApi.ackMail(entry.id);
  });

  await t.test("a part moved to the wrong index is caught", async () => {
    const bytes = randomBytes(20000);
    await sendViaRelay({
      api: pcApi,
      identity: pc,
      peer: phonePeer,
      source: bytesSource({ name: "swap.bin", bytes }),
      partSize: 8192
    });

    const [entry] = await phoneApi.listMail();
    // Swap parts 0 and 1. Each part is authenticated against its own index, so
    // the reorder must fail rather than silently produce a scrambled file.
    const first = await server.store.blobs.getPart(entry.envelope.blobId, 0);
    const second = await server.store.blobs.getPart(entry.envelope.blobId, 1);
    await server.store.blobs.putPart(entry.envelope.blobId, 0, second);
    await server.store.blobs.putPart(entry.envelope.blobId, 1, first);

    await assert.rejects(() =>
      receiveViaRelay({
        api: phoneApi,
        identity: phone,
        envelope: entry.envelope,
        peer: pcPeer,
        createSink: memorySink()
      })
    );
    await phoneApi.ackMail(entry.id);
  });

  await t.test("an envelope from an unpaired device is discarded, not opened", async () => {
    const stranger = await createIdentity({ name: "Stranger" });
    const strangerSocket = createSignalingClient({ url: wsUrl, identity: stranger });
    await strangerSocket.connect();
    sockets.push(strangerSocket);

    const strangerApi = createApiClient({ baseUrl: base, identity: stranger });
    await sendViaRelay({
      api: strangerApi,
      identity: stranger,
      peer: phonePeer,
      source: bytesSource({ name: "malware.exe", bytes: randomBytes(64) })
    });

    const events = [];
    const collected = await collectMailbox({
      api: phoneApi,
      identity: phone,
      resolvePeer: async (deviceId) => (deviceId === pc.deviceId ? pcPeer : null),
      createSink: memorySink(),
      onEvent: (event) => events.push(event)
    });

    assert.equal(collected.length, 0);
    assert.equal(events[0].type, "discarded");
    assert.match(events[0].reason, /Not from a paired device/);
    assert.deepEqual(await phoneApi.listMail(), [], "the junk envelope is cleared");
  });

  await t.test("a forged envelope signature is refused", async () => {
    const impostor = await createIdentity({ name: "Impostor" });
    const impostorSocket = createSignalingClient({ url: wsUrl, identity: impostor });
    await impostorSocket.connect();
    sockets.push(impostorSocket);

    const impostorApi = createApiClient({ baseUrl: base, identity: impostor });
    await sendViaRelay({
      api: impostorApi,
      identity: impostor,
      peer: phonePeer,
      source: bytesSource({ name: "fake.txt", bytes: randomBytes(32) })
    });

    const [entry] = await phoneApi.listMail();
    // Claim to be the PC while still holding the impostor signature.
    const forged = { ...entry.envelope, sender: pc.deviceId };

    await assert.rejects(
      () =>
        receiveViaRelay({
          api: phoneApi,
          identity: phone,
          envelope: forged,
          peer: pcPeer,
          createSink: memorySink()
        }),
      /signature does not match/
    );
    await phoneApi.ackMail(entry.id);
  });

  await t.test("a multi-part file larger than one part reassembles in order", async () => {
    const bytes = randomBytes(300000);
    const progress = [];
    const sent = await sendViaRelay({
      api: pcApi,
      identity: pc,
      peer: phonePeer,
      source: bytesSource({ name: "video.mp4", mime: "video/mp4", bytes }),
      partSize: 65536,
      onProgress: (p) => progress.push(p.transferred)
    });
    assert.equal(sent.parts, 5);
    assert.equal(progress.at(-1), 300000);

    const collected = await collectMailbox({
      api: phoneApi,
      identity: phone,
      resolvePeer: async (deviceId) => (deviceId === pc.deviceId ? pcPeer : null),
      createSink: memorySink()
    });
    assert.ok(equalBytes(collected[0].result.bytes, bytes));
  });

  await t.test("an empty file survives the relay", async () => {
    await sendViaRelay({
      api: pcApi,
      identity: pc,
      peer: phonePeer,
      source: bytesSource({ name: "empty.log", bytes: new Uint8Array(0) })
    });
    const collected = await collectMailbox({
      api: phoneApi,
      identity: phone,
      resolvePeer: async () => pcPeer,
      createSink: memorySink()
    });
    assert.equal(collected[0].result.bytes.length, 0);
  });

  await t.test("collecting reclaims the server storage", async () => {
    const bytes = randomBytes(5000);
    const sent = await sendViaRelay({
      api: pcApi,
      identity: pc,
      peer: phonePeer,
      source: bytesSource({ name: "temp.bin", bytes })
    });
    assert.ok(await server.store.blobs.get(sent.blobId));

    await collectMailbox({
      api: phoneApi,
      identity: phone,
      resolvePeer: async () => pcPeer,
      createSink: memorySink()
    });
    assert.equal(await server.store.blobs.get(sent.blobId), null, "ciphertext is dropped once collected");
  });

  await t.test("two transfers to the same device use different keys", async () => {
    const bytes = new Uint8Array(1024).fill(7);
    const first = await sendViaRelay({
      api: pcApi,
      identity: pc,
      peer: phonePeer,
      source: bytesSource({ name: "same.bin", bytes })
    });
    const second = await sendViaRelay({
      api: pcApi,
      identity: pc,
      peer: phonePeer,
      source: bytesSource({ name: "same.bin", bytes })
    });

    const a = await server.store.blobs.getPart(first.blobId, 0);
    const b = await server.store.blobs.getPart(second.blobId, 0);
    assert.ok(!equalBytes(a, b), "identical plaintext must not produce identical ciphertext");

    await collectMailbox({
      api: phoneApi,
      identity: phone,
      resolvePeer: async () => pcPeer,
      createSink: memorySink()
    });
  });
});

import test from "node:test";
import assert from "node:assert/strict";

import { startServer } from "../server/node.js";
import { createSignalingClient } from "../protocol/signaling.js";
import { createApiClient } from "../protocol/api.js";
import { createIdentity } from "../protocol/identity.js";
import * as pair from "../protocol/pairing.js";
import { equalBytes, randomBytes } from "../protocol/util.js";
import { signRequest } from "../protocol/auth.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function connected(identity, url, handlers = {}) {
  const client = createSignalingClient({ url, identity, ...handlers });
  await client.connect();
  return client;
}

test("server: rendezvous, pairing, signalling, mailbox and blobs", async (t) => {
  const server = await startServer({ port: 0, host: "127.0.0.1", verbose: false });
  const base = "http://127.0.0.1:" + server.port;
  const wsUrl = "ws://127.0.0.1:" + server.port + "/ws";

  const pc = await createIdentity({ name: "Desk PC", platform: "windows" });
  const phone = await createIdentity({ name: "Pixel", platform: "android" });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
  });

  await t.test("health endpoint answers unauthenticated", async () => {
    const response = await fetch(base + "/api/health");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });

  await t.test("a device authenticates with nothing but its key", async () => {
    const client = await connected(pc, wsUrl);
    clients.push(client);
    assert.ok(client.ready);
  });

  await t.test("two devices complete a pairing handshake through the relay", async () => {
    const offer = pair.createPairingOffer();
    const { roomId, pairKey } = await pair.derivePairing(offer.code);

    const pcGotPhone = deferred();
    const phoneGotPc = deferred();

    const pcClient = await connected(pc, wsUrl, {
      onPair: (_room, _from, payload) => pcGotPhone.resolve(payload)
    });
    const phoneClient = await connected(phone, wsUrl, {
      onPair: (_room, _from, payload) => phoneGotPc.resolve(payload)
    });
    clients.push(pcClient, phoneClient);

    pcClient.joinPairRoom(roomId);
    phoneClient.joinPairRoom(roomId);

    const helloPc = await pair.buildHello(pc);
    const helloPhone = await pair.buildHello(phone);
    pcClient.sendPair(roomId, helloPc);
    phoneClient.sendPair(roomId, helloPhone);

    const seenByPc = await pcGotPhone.promise;
    const seenByPhone = await phoneGotPc.promise;

    const peerPhone = await pair.verifyHello(seenByPc);
    const peerPc = await pair.verifyHello(seenByPhone);
    assert.equal(peerPhone.deviceId, phone.deviceId);
    assert.equal(peerPc.deviceId, pc.deviceId);

    const tagPc = await pair.confirmationTag(pairKey, helloPc, seenByPc);
    const tagPhone = await pair.confirmationTag(pairKey, seenByPhone, helloPhone);
    assert.equal(tagPc, tagPhone, "both sides derive the same confirmation tag");
  });

  await t.test("a third device cannot squat an in-use pairing room", async () => {
    const offer = pair.createPairingOffer();
    const { roomId } = await pair.derivePairing(offer.code);
    const a = await createIdentity({ name: "A" });
    const b = await createIdentity({ name: "B" });
    const c = await createIdentity({ name: "C" });

    const full = deferred();
    const aClient = await connected(a, wsUrl);
    const bClient = await connected(b, wsUrl);
    const cClient = await connected(c, wsUrl, {
      onStatus: (status, detail) => {
        if (status === "error") full.resolve(detail);
      }
    });
    clients.push(aClient, bClient, cClient);

    aClient.joinPairRoom(roomId);
    bClient.joinPairRoom(roomId);
    await new Promise((r) => setTimeout(r, 50));
    cClient.joinPairRoom(roomId);
    assert.match(await full.promise, /room is full/i);
  });

  await t.test("presence tells a device when its peer comes online", async () => {
    const watcher = await createIdentity({ name: "Watcher" });
    const target = await createIdentity({ name: "Target" });
    const online = deferred();

    const watcherClient = await connected(watcher, wsUrl, {
      onPeer: (deviceId, isOnline) => {
        if (deviceId === target.deviceId && isOnline) online.resolve(true);
      }
    });
    clients.push(watcherClient);
    watcherClient.watch([target.deviceId]);

    const targetClient = await connected(target, wsUrl);
    clients.push(targetClient);
    assert.equal(await online.promise, true);
  });

  await t.test("signals route between devices and report unreachable peers", async () => {
    const got = deferred();
    const pcClient = await connected(pc, wsUrl);
    const phoneClient = await connected(phone, wsUrl, {
      onSignal: (from, payload) => got.resolve({ from, payload })
    });
    clients.push(pcClient, phoneClient);

    pcClient.signal(phone.deviceId, { kind: "offer", sdp: "v=0" });
    const received = await got.promise;
    assert.equal(received.from, pc.deviceId);
    assert.equal(received.payload.sdp, "v=0");

    const ghost = await createIdentity({ name: "Ghost" });
    const unreachable = deferred();
    const solo = await connected(pc, wsUrl, {
      onPeer: (deviceId, isOnline) => {
        if (deviceId === ghost.deviceId && !isOnline) unreachable.resolve(true);
      }
    });
    clients.push(solo);
    solo.signal(ghost.deviceId, { kind: "offer" });
    assert.equal(await unreachable.promise, true);
  });

  await t.test("blob parts upload, complete and download intact", async () => {
    const api = createApiClient({ baseUrl: base, identity: pc });
    const partA = randomBytes(4096);
    const partB = randomBytes(2048);

    const blob = await api.createBlob({ parts: 2, size: partA.length + partB.length, recipient: phone.deviceId });
    await api.putPart(blob.blobId, 0, blob.writeToken, partA);
    await api.putPart(blob.blobId, 1, blob.writeToken, partB);
    await api.completeBlob(blob.blobId);

    const status = await api.blobStatus(blob.blobId);
    assert.equal(status.complete, true);
    assert.equal(status.received, 2);

    const phoneApi = createApiClient({ baseUrl: base, identity: phone });
    assert.ok(equalBytes(await phoneApi.getPart(blob.blobId, 0, blob.readToken), partA));
    assert.ok(equalBytes(await phoneApi.getPart(blob.blobId, 1, blob.readToken), partB));
  });

  await t.test("a wrong capability token is refused", async () => {
    const api = createApiClient({ baseUrl: base, identity: pc });
    const blob = await api.createBlob({ parts: 1, size: 4, recipient: phone.deviceId });
    await api.putPart(blob.blobId, 0, blob.writeToken, randomBytes(4));

    const wrongWrite = await fetch(base + "/blob/" + blob.blobId + "/0?t=nope", { method: "PUT", body: "x" });
    assert.equal(wrongWrite.status, 403);
    const wrongRead = await fetch(base + "/blob/" + blob.blobId + "/0?t=" + blob.writeToken);
    assert.equal(wrongRead.status, 403, "the write token must not grant reads");
    const rightRead = await fetch(base + "/blob/" + blob.blobId + "/0?t=" + blob.readToken);
    assert.equal(rightRead.status, 200);
  });

  await t.test("completing a blob with missing parts is refused", async () => {
    const api = createApiClient({ baseUrl: base, identity: pc });
    const blob = await api.createBlob({ parts: 3, size: 12, recipient: phone.deviceId });
    await api.putPart(blob.blobId, 0, blob.writeToken, randomBytes(4));
    await assert.rejects(() => api.completeBlob(blob.blobId), /1 of 3/);
  });

  await t.test("mailbox delivers to an offline device and ack reclaims the blob", async () => {
    const pcApi = createApiClient({ baseUrl: base, identity: pc });
    const phoneApi = createApiClient({ baseUrl: base, identity: phone });

    const blob = await pcApi.createBlob({ parts: 1, size: 8, recipient: phone.deviceId });
    await pcApi.putPart(blob.blobId, 0, blob.writeToken, randomBytes(8));
    await pcApi.completeBlob(blob.blobId);
    await pcApi.sendMail(phone.deviceId, { blobId: blob.blobId, readToken: blob.readToken, sealed: "ciphertext" });

    const entries = await phoneApi.listMail();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].envelope.from, pc.deviceId);
    assert.equal(entries[0].envelope.blobId, blob.blobId);

    await phoneApi.ackMail(entries[0].id);
    assert.equal((await phoneApi.listMail()).length, 0);
    const gone = await fetch(base + "/blob/" + blob.blobId + "/0?t=" + blob.readToken);
    assert.equal(gone.status, 404, "acking the envelope drops the ciphertext too");
  });

  await t.test("another device cannot read your mailbox or your blob", async () => {
    const stranger = await createIdentity({ name: "Stranger" });
    const strangerClient = await connected(stranger, wsUrl);
    clients.push(strangerClient);

    const pcApi = createApiClient({ baseUrl: base, identity: pc });
    const blob = await pcApi.createBlob({ parts: 1, size: 4, recipient: phone.deviceId });

    const strangerApi = createApiClient({ baseUrl: base, identity: stranger });
    await assert.rejects(() => strangerApi.blobStatus(blob.blobId), /Not your blob/);
    assert.deepEqual(await strangerApi.listMail(), []);
  });

  await t.test("forged and stale authorization headers are refused", async () => {
    const evil = await createIdentity({ name: "Evil" });
    const evilClient = await connected(evil, wsUrl);
    clients.push(evilClient);

    const header = await signRequest(evil, "GET", "/api/mailbox");
    const swapped = header.replace(evil.deviceId, pc.deviceId);
    const response = await fetch(base + "/api/mailbox", { headers: { authorization: swapped } });
    assert.equal(response.status, 401);

    const stale = await signRequest(pc, "GET", "/api/mailbox", Date.now() - 10 * 60 * 1000);
    const staleResponse = await fetch(base + "/api/mailbox", { headers: { authorization: stale } });
    assert.equal(staleResponse.status, 401);
    assert.match((await staleResponse.json()).error, /window/);
  });
});

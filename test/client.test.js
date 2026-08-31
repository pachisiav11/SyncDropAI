import test from "node:test";
import assert from "node:assert/strict";

import { startServer } from "../server/node.js";
import { createSyncDrop } from "../protocol/client.js";
import { memoryStorage, openVault } from "../protocol/vault.js";
import { bytesSource, memorySink } from "../protocol/sources.js";
import { equalBytes, randomBytes } from "../protocol/util.js";
import { createSignalingClient } from "../protocol/signaling.js";
import { createIdentity } from "../protocol/identity.js";
import * as pairing from "../protocol/pairing.js";

async function waitFor(list, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = list.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for an event");
}

async function makeClient(serverUrl, name, platform, received) {
  const vault = await openVault(memoryStorage(), { name, platform });
  const client = createSyncDrop({
    vault,
    serverUrl,
    createSink: memorySink(),
    onEvent: (event) => {
      if (event.type === "complete" && event.direction === "receive") received?.push(event);
      if (event.type === "collected") received?.push(event);
    }
  });
  await client.start();
  return client;
}

test("client: pairing, presence, relay fallback", async (t) => {
  const server = await startServer({ port: 0, host: "127.0.0.1", verbose: false });
  const serverUrl = "http://127.0.0.1:" + server.port;

  const pcInbox = [];
  const phoneInbox = [];
  const pc = await makeClient(serverUrl, "Desk PC", "windows", pcInbox);
  const phone = await makeClient(serverUrl, "Pixel", "android", phoneInbox);

  t.after(async () => {
    pc.stop();
    phone.stop();
    await server.close();
  });

  await t.test("two fresh devices pair from a code", async () => {
    const offer = pc.createPairingOffer();
    const [fromPc, fromPhone] = await Promise.all([pc.pair(offer.code), phone.pair(offer.display)]);

    assert.equal(fromPc.deviceId, phone.identity.deviceId);
    assert.equal(fromPc.name, "Pixel");
    assert.equal(fromPhone.deviceId, pc.identity.deviceId);
    assert.equal(fromPhone.name, "Desk PC");
    assert.equal(pc.peers().length, 1);
    assert.equal(phone.peers().length, 1);
  });

  await t.test("each device learns the other is online", async () => {
    const deadline = Date.now() + 2000;
    while (!pc.isOnline(phone.identity.deviceId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(pc.isOnline(phone.identity.deviceId));
  });

  await t.test("a device that proves a different code is refused", async () => {
    const offer = pairing.createPairingOffer();
    const { roomId } = await pairing.derivePairing(offer.code);

    // An attacker who somehow learned the room id but not the code: it can join
    // and send a well-formed signed hello, but its confirmation tag is keyed by
    // a code it does not have.
    const attacker = await createIdentity({ name: "Attacker" });
    const attackerHello = await pairing.buildHello(attacker);
    const wrong = await pairing.derivePairing(pairing.generatePairingCode());
    const wrongTag = await pairing.confirmationTag(wrong.pairKey, attackerHello, attackerHello);

    let played = false;
    const attackerSocket = createSignalingClient({
      url: serverUrl.replace("http", "ws") + "/ws",
      identity: attacker,
      // Precomputed and fired synchronously: an async handler here can outlive
      // the socket and throw into the test after it has already closed.
      onJoined: (_room, occupants) => {
        if (played || occupants < 2) return;
        played = true;
        attackerSocket.sendPair(roomId, attackerHello);
        attackerSocket.sendPair(roomId, { type: "confirm", tag: wrongTag });
      }
    });
    await attackerSocket.connect();
    attackerSocket.joinPairRoom(roomId);

    await assert.rejects(() => pc.pair(offer.code, { timeoutMs: 3000 }), /different code|timed out/i);
    attackerSocket.close();
    assert.equal(pc.peers().length, 1, "the attacker was not stored as a peer");
  });

  await t.test("a mistyped code times out instead of pairing", async () => {
    await assert.rejects(() => pc.pair(pairing.generatePairingCode(), { timeoutMs: 600 }), /timed out/i);
  });

  await t.test("sending to an unpaired device is refused", async () => {
    await assert.rejects(
      () => pc.send("AAAAAAAAAAAAAAAAAAAAAAAA", bytesSource({ name: "x.bin", bytes: randomBytes(8) })),
      /not paired/
    );
  });

  await t.test("an explicit relay send is collected by the other device", async () => {
    const bytes = randomBytes(50000);
    const result = await pc.send(phone.identity.deviceId, bytesSource({ name: "notes.md", mime: "text/markdown", bytes }), {
      prefer: "relay"
    });
    assert.equal(result.via, "relay");

    // The recipient is online, so the mailbox notification makes it collect on
    // its own. Nobody has to press anything.
    const event = await waitFor(phoneInbox, (e) => e.name === "notes.md");
    assert.equal(event.type, "collected");
    assert.equal(event.via, "relay");
    assert.deepEqual(await phone.api.listMail(), [], "the envelope is acked once written");
  });

  await t.test("a runtime with no WebRTC goes straight to the relay", async () => {
    // Node has no RTCPeerConnection. There is no direct path to attempt, so the
    // send should not report a fallback from an attempt that never happened.
    assert.equal(globalThis.RTCPeerConnection, undefined);
    const fallbacks = [];
    const listener = createSyncDrop({
      vault: pc.vault,
      serverUrl,
      createSink: memorySink(),
      onEvent: (event) => event.type === "fallback" && fallbacks.push(event)
    });
    await listener.start();

    const bytes = randomBytes(4096);
    const result = await listener.send(phone.identity.deviceId, bytesSource({ name: "auto.bin", bytes }));
    assert.equal(result.via, "relay");
    assert.deepEqual(fallbacks, []);
    await assert.rejects(
      () => listener.send(phone.identity.deviceId, bytesSource({ name: "x.bin", bytes }), { prefer: "p2p" }),
      /no WebRTC/i
    );

    const event = await waitFor(phoneInbox, (e) => e.name === "auto.bin");
    assert.equal(event.via, "relay");
    listener.stop();
  });

  await t.test("a direct connection that fails falls back to the relay", async () => {
    // Stand in a WebRTC implementation that always fails to connect, which is
    // what a symmetric NAT with no reachable TURN looks like from here.
    class DeadPeerConnection {
      constructor() {
        this.connectionState = "new";
      }
      createDataChannel() {
        return { close() {} };
      }
      createOffer() {
        throw new Error("ICE gathering failed");
      }
      close() {}
    }
    globalThis.RTCPeerConnection = DeadPeerConnection;

    const fallbacks = [];
    const listener = createSyncDrop({
      vault: pc.vault,
      serverUrl,
      createSink: memorySink(),
      onEvent: (event) => event.type === "fallback" && fallbacks.push(event)
    });
    await listener.start();

    try {
      const bytes = randomBytes(2048);
      const result = await listener.send(phone.identity.deviceId, bytesSource({ name: "deadrtc.bin", bytes }));
      assert.equal(result.via, "relay");
      assert.equal(fallbacks.length, 1);
      assert.match(fallbacks[0].reason, /ICE gathering failed/);
      const event = await waitFor(phoneInbox, (e) => e.name === "deadrtc.bin");
      assert.equal(event.via, "relay");
    } finally {
      listener.stop();
      delete globalThis.RTCPeerConnection;
    }
  });

  await t.test("unpairing forgets the device and refuses later sends", async () => {
    const scratchVault = await openVault(memoryStorage(), { name: "Scratch" });
    const scratch = createSyncDrop({ vault: scratchVault, serverUrl, createSink: memorySink() });
    await scratch.start();

    const offer = scratch.createPairingOffer();
    await Promise.all([scratch.pair(offer.code), phone.pair(offer.code)]);
    assert.equal(scratch.peers().length, 1);

    assert.equal(await scratch.unpair(phone.identity.deviceId), true);
    assert.equal(scratch.peers().length, 0);
    await assert.rejects(
      () => scratch.send(phone.identity.deviceId, bytesSource({ name: "gone.bin", bytes: randomBytes(8) })),
      /not paired/
    );
    scratch.stop();
    await phone.unpair(scratch.identity.deviceId);
  });

  await t.test("a vault reopens with the same identity and peers", async () => {
    const storage = memoryStorage();
    const first = await openVault(storage, { name: "Reopen", platform: "windows" });
    const known = pc.peers()[0];
    await first.add(known);

    const second = await openVault(storage, { name: "ignored" });
    assert.equal(second.identity.deviceId, first.identity.deviceId, "identity survives a reopen");
    assert.equal(second.created, false);
    assert.equal(second.list().length, 1);
    assert.equal(second.list()[0].deviceId, known.deviceId);
    assert.ok(second.get(known.deviceId), "the peer key reimports on reopen");
  });
});

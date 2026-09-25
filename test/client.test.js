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
import { createRtcTransport, signDescription } from "../protocol/webrtc.js";

async function waitFor(list, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = list.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for an event");
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for a condition");
}

// Just enough of RTCPeerConnection for two clients in one process to build a
// direct link. The descriptions still travel the real signaling path, signed;
// they only pair up here by their sdp string. `sever` makes every link built so
// far go quiet without closing, which is how a device that fell asleep looks
// from the other end.
function fakeWebRtc() {
  const bySdp = new Map();
  const channels = [];
  const farEnds = [];
  let counter = 0;
  let linked = 0;

  class Channel {
    constructor() {
      this.readyState = "connecting";
      this.bufferedAmount = 0;
      this.other = null;
      this.silent = false;
      channels.push(this);
    }
    send(data) {
      if (this.readyState !== "open") throw new Error("Channel is not open");
      if (this.silent) return;
      const payload = ArrayBuffer.isView(data) ? data.slice().buffer : data;
      const other = this.other;
      setTimeout(() => other.readyState === "open" && other.onmessage?.({ data: payload }));
    }
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      setTimeout(() => this.onclose?.());
      if (!this.silent) this.other?.close();
    }
  }

  class PeerConnection {
    constructor() {
      this.connectionState = "new";
      this.channel = null;
    }
    createDataChannel() {
      this.channel = new Channel();
      return this.channel;
    }
    async createOffer() {
      return { type: "offer", sdp: `offer-${++counter}` };
    }
    async createAnswer() {
      return { type: "answer", sdp: `answer-${++counter}` };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
      bySdp.set(description.sdp, this);
    }
    async setRemoteDescription(description) {
      if (description.type !== "answer") return;
      const answerer = bySdp.get(description.sdp);
      const theirs = new Channel();
      this.channel.other = theirs;
      theirs.other = this.channel;
      farEnds.push(theirs);
      linked += 1;
      answerer.ondatachannel?.({ channel: theirs });
      setTimeout(() => {
        for (const channel of [this.channel, theirs]) {
          channel.readyState = "open";
          channel.onopen?.();
        }
      });
    }
    async addIceCandidate() {}
    close() {
      this.channel?.close();
    }
  }

  return {
    PeerConnection,
    linked: () => linked,
    closeFarEnd: () => farEnds.at(-1).close(),
    sever() {
      for (const channel of channels) channel.silent = true;
    }
  };
}

// Never opens and never fails: a socket Android let the app create while it
// had the app frozen in the background.
class StuckSocket {
  constructor() {
    this.readyState = 0;
  }
  send() {
    throw new Error("Not open");
  }
  close() {
    this.readyState = 3;
  }
}

// Completes the handshake the way the relay does and then stays up.
class GreetingSocket {
  constructor() {
    this.readyState = 0;
    setTimeout(() => {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify({ type: "challenge", nonce: "n" }) });
    });
  }
  send(text) {
    if (JSON.parse(text).type === "auth") {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "ready", mail: 0 }) }));
    }
  }
  close() {
    this.readyState = 3;
  }
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

  await t.test("a device that rejoins the room still pairs", async () => {
    // The abort fires on the joined notification, so this device leaves before
    // it ever answers the hello the other one has already sent. That is the
    // state the exchange used to deadlock in: the peer treated its hello as
    // spent, the second attempt waited out the full timeout, and both devices
    // reported a failure. A phone whose socket drops and reconnects lands in
    // the same place, because reconnecting rejoins the room.
    const abort = new AbortController();
    const scratch = createSyncDrop({
      vault: await openVault(memoryStorage(), { name: "Scratch", platform: "linux" }),
      serverUrl,
      createSink: memorySink(),
      onEvent: (event) => {
        if (event.type === "pair-room" && event.occupants >= 2) abort.abort();
      }
    });
    await scratch.start();
    const other = await makeClient(serverUrl, "Other", "android");

    const offer = pairing.createPairingOffer();
    const waiting = other.pair(offer.code, { timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 300));

    await assert.rejects(() => scratch.pair(offer.code, { signal: abort.signal }), /cancelled/i);

    const [again, fromOther] = await Promise.all([scratch.pair(offer.code, { timeoutMs: 8000 }), waiting]);
    assert.equal(again.deviceId, other.identity.deviceId);
    assert.equal(fromOther.deviceId, scratch.identity.deviceId);

    scratch.stop();
    other.stop();
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
    // A sink inside a page has no path to report, only the file it is holding.
    // While this event carried the path alone, every relayed file reached the
    // app and stopped there: nothing saved itself, and no Save button appeared,
    // because both are drawn from this.
    assert.ok(event.result, "the collected event carries what the sink produced");
    assert.deepEqual(await phone.api.listMail(), [], "the envelope is acked once written");
  });

  await t.test("a relayed file that lands while another is being collected is collected too", async () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const events = [];
    const toMemory = memorySink();
    const vault = await openVault(memoryStorage(), { name: "Busy", platform: "windows" });
    const busy = createSyncDrop({
      vault,
      serverUrl,
      // The first file takes as long as the test says, the way a large one does.
      createSink: (info) => {
        const sink = toMemory(info);
        if (info.name !== "long.bin") return sink;
        return { ...sink, write: async (sequence, bytes) => (await held, sink.write(sequence, bytes)) };
      },
      onEvent: (event) => events.push(event)
    });
    await busy.start();
    try {
      const offer = busy.createPairingOffer();
      await Promise.all([busy.pair(offer.code), phone.pair(offer.code)]);

      await phone.send(busy.identity.deviceId, bytesSource({ name: "long.bin", bytes: randomBytes(4096) }), { prefer: "relay" });
      await waitFor(events, (e) => e.type === "collecting");
      await phone.send(busy.identity.deviceId, bytesSource({ name: "short.bin", bytes: randomBytes(64) }), { prefer: "relay" });
      await new Promise((r) => setTimeout(r, 200));
      release();

      await waitFor(events, (e) => e.type === "collected" && e.name === "short.bin", 3000);
      assert.ok(events.some((e) => e.type === "collected" && e.name === "long.bin"));
    } finally {
      busy.stop();
      await phone.unpair(vault.identity.deviceId);
    }
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

  const rtc = fakeWebRtc();

  await t.test("a direct link the other side closed is not reused", async () => {
    globalThis.RTCPeerConnection = rtc.PeerConnection;
    try {
      const first = await pc.send(phone.identity.deviceId, bytesSource({ name: "direct-1.bin", bytes: randomBytes(4096) }));
      assert.equal(first.via, "p2p");
      await waitFor(phoneInbox, (e) => e.name === "direct-1.bin");

      rtc.closeFarEnd();
      await until(() => pc.connections().length === 0);

      const before = rtc.linked();
      const second = await pc.send(phone.identity.deviceId, bytesSource({ name: "direct-2.bin", bytes: randomBytes(4096) }));
      assert.equal(second.via, "p2p");
      assert.equal(rtc.linked(), before + 1, "a new link was built");
      await waitFor(phoneInbox, (e) => e.name === "direct-2.bin");
    } finally {
      delete globalThis.RTCPeerConnection;
    }
  });

  await t.test("a direct link that went quiet is replaced rather than waited on", async () => {
    globalThis.RTCPeerConnection = rtc.PeerConnection;
    try {
      await pc.send(phone.identity.deviceId, bytesSource({ name: "quiet-1.bin", bytes: randomBytes(2048) }));
      rtc.sever();

      const before = rtc.linked();
      const result = await pc.send(phone.identity.deviceId, bytesSource({ name: "quiet-2.bin", bytes: randomBytes(2048) }));
      assert.equal(result.via, "p2p", "a fresh direct link, not the relay");
      assert.equal(rtc.linked(), before + 1);
      await waitFor(phoneInbox, (e) => e.name === "quiet-2.bin");
      assert.equal(phoneInbox.filter((e) => e.name === "quiet-2.bin").length, 1, "delivered once");
    } finally {
      delete globalThis.RTCPeerConnection;
    }
  });

  await t.test("a send made while the socket reconnects waits for it and goes direct", async () => {
    globalThis.RTCPeerConnection = rtc.PeerConnection;
    const sockets = [];
    let stuck = false;
    function PocketSocket(url) {
      const socket = stuck ? new StuckSocket() : new WebSocket(url);
      sockets.push(socket);
      return socket;
    }
    const vault = await openVault(memoryStorage(), { name: "Pocket", platform: "android" });
    const pocket = createSyncDrop({ vault, serverUrl, createSink: memorySink(), WebSocketImpl: PocketSocket });
    await pocket.start();
    try {
      const offer = pocket.createPairingOffer();
      await Promise.all([pocket.pair(offer.code), pc.pair(offer.code)]);
      await until(() => pocket.isOnline(pc.identity.deviceId));

      // The file picker is open: Android closes the socket and the retry it
      // makes in the background goes nowhere.
      stuck = true;
      sockets.at(-1).close();
      await until(() => sockets.at(-1) instanceof StuckSocket);

      const sending = pocket.send(pc.identity.deviceId, bytesSource({ name: "picked.bin", bytes: randomBytes(4096) }));
      await new Promise((r) => setTimeout(r, 100));
      stuck = false;
      pocket.wake();

      const result = await sending;
      assert.equal(result.via, "p2p", "direct, not pushed through the relay");
      await waitFor(pcInbox, (e) => e.name === "picked.bin");
    } finally {
      pocket.stop();
      await pc.unpair(vault.identity.deviceId);
      delete globalThis.RTCPeerConnection;
    }
  });

  await t.test("a runtime with no WebRTC turns a direct offer down instead of crashing", async () => {
    // The phone here is a node client, as the CLI is. Dial it the way the
    // desktop app does when it sees the other device online.
    const vault = await openVault(memoryStorage(), { name: "Dialer" });
    const dialer = createSyncDrop({ vault, serverUrl, createSink: memorySink() });
    await dialer.start();
    const offer = dialer.createPairingOffer();
    await Promise.all([dialer.pair(offer.code), phone.pair(offer.code)]);
    dialer.stop();

    const url = new URL(serverUrl);
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.searchParams.set("d", vault.identity.deviceId);
    const replies = [];
    const socket = createSignalingClient({
      url: url.toString(),
      identity: vault.identity,
      onSignal: (_from, payload) => replies.push(payload)
    });
    try {
      await socket.connect();
      socket.signal(phone.identity.deviceId, await signDescription(vault.identity, { type: "offer", sdp: "v=0" }));
      await until(() => replies.length > 0);
      assert.equal(replies[0].kind, "no-direct");
    } finally {
      socket.close();
      await phone.unpair(vault.identity.deviceId);
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

test("signaling: a socket that stops answering is replaced", async () => {
  const identity = await createIdentity({ name: "Quiet", platform: "test" });
  const sockets = [];
  // Completes the handshake and then says nothing more, which is how a socket
  // looks when the network under it went away without closing it.
  class QuietSocket {
    constructor() {
      this.readyState = 0;
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onmessage?.({ data: JSON.stringify({ type: "challenge", nonce: "n" }) });
      });
    }
    send(text) {
      if (JSON.parse(text).type === "auth") {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "ready", mail: 0 }) }));
      }
    }
    close() {
      this.readyState = 3;
    }
  }

  const statuses = [];
  const client = createSignalingClient({
    url: "ws://quiet.invalid/ws",
    identity,
    WebSocketImpl: QuietSocket,
    onStatus: (status) => statuses.push(status)
  });
  try {
    await client.connect();
    client.wake(50);
    await until(() => sockets.length === 2);
    assert.ok(statuses.includes("offline"), "the dead socket was reported");
    assert.equal(sockets[0].readyState, 3, "and closed");
  } finally {
    client.close();
  }
});

test("signaling: a connection that never gets going is abandoned and retried", async () => {
  const identity = await createIdentity({ name: "Frozen", platform: "android" });
  const sockets = [];
  function FirstStuck() {
    const socket = sockets.length === 0 ? new StuckSocket() : new GreetingSocket();
    sockets.push(socket);
    return socket;
  }
  const client = createSignalingClient({
    url: "ws://frozen.invalid/ws",
    identity,
    WebSocketImpl: FirstStuck,
    handshakeTimeoutMs: 50
  });
  try {
    await client.connect();
    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].readyState, 3, "the stuck socket was closed");
  } finally {
    client.close();
  }
});

test("signaling: waking with no session reconnects now, not at the next retry", async () => {
  const identity = await createIdentity({ name: "Frozen", platform: "android" });
  const sockets = [];
  let stuck = true;
  function Socket() {
    const socket = stuck ? new StuckSocket() : new GreetingSocket();
    sockets.push(socket);
    return socket;
  }
  const client = createSignalingClient({ url: "ws://frozen.invalid/ws", identity, WebSocketImpl: Socket });
  try {
    const connected = client.connect();
    stuck = false;
    client.wake(50);
    await connected;
    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].readyState, 3, "the stuck attempt was dropped");
  } finally {
    client.close();
  }
});

test("webrtc: an offer turned down fails at once instead of at the timeout", async () => {
  const identity = await createIdentity({ name: "Desk", platform: "windows" });
  class SilentPeerConnection {
    createDataChannel() {
      return {};
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0" };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
    }
    close() {}
  }
  const transport = createRtcTransport({
    identity,
    peer: { deviceId: "cli" },
    signaling: { signal() {} },
    initiator: true,
    RTCPeerConnectionImpl: SilentPeerConnection
  });
  const started = transport.start();
  await transport.handleSignal({ kind: "no-direct" });
  await assert.rejects(() => started, /cannot take a direct connection/);
});

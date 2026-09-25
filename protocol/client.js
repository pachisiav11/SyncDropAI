// The client: one object a host can drive.
//
// Layers the two transports in the order that costs least. A transfer tries the
// direct path first, because on a shared network that path is bounded by the
// LAN rather than by a home upload link, and it costs nobody anything. Only
// when the far device is unreachable - asleep, on mobile data behind a hostile
// NAT, off - does it fall back to the sealed relay.
//
// Hosts supply the platform-specific pieces: where to keep the vault, how to
// write a received file, whether to accept an offer.

import { PAIR_TTL_MS } from "./constants.js";
import { createApiClient } from "./api.js";
import { createSignalingClient } from "./signaling.js";
import { createRtcTransport } from "./webrtc.js";
import { createTransferSession } from "./transfer.js";
import { collectMailbox, sendViaRelay } from "./relay.js";
import * as pairing from "./pairing.js";
import { shortId } from "./util.js";

// How long a returning app gives its socket to prove it survived the break.
const WAKE_PING_TIMEOUT_MS = 5000;
// A phone's socket is often mid-reconnect in the seconds after it comes back
// from the file picker, and a direct link cannot be set up without it. Worth
// waiting this long rather than pushing a large file through the relay.
const SIGNALING_WAIT_MS = 10000;

const idle = (entry) => !entry.session || (entry.session.active.outgoing === 0 && entry.session.active.incoming === 0);

// The `d` parameter is a routing hint, not a claim of identity. A single-process
// host ignores it; the Cloudflare host uses it to pick which Durable Object owns
// the socket, then refuses the connection if the handshake that follows proves a
// different device. Nothing is trusted before that signature is checked.
function websocketUrl(serverUrl, deviceId) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/+$/, "") + "/ws";
  url.searchParams.set("d", deviceId);
  return url.toString();
}

export function createSyncDrop({
  vault,
  serverUrl,
  createSink,
  autoAccept = () => true,
  iceServers,
  WebSocketImpl,
  onEvent = () => {}
}) {
  const identity = vault.identity;
  const api = createApiClient({ baseUrl: serverUrl, identity });
  const connections = new Map();
  const online = new Set();
  const pendingPairings = new Map();
  let collecting = false;
  let collectAgain = false;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // Host callbacks must never break the protocol loop.
    }
  };

  const signaling = createSignalingClient({
    url: websocketUrl(serverUrl, identity.deviceId),
    identity,
    WebSocketImpl,
    onStatus: (status, detail) => {
      // Our own socket dropping is how an app that was in the background finds
      // out it was away. The other side heard we went offline and closed its
      // end, so an idle connection from before is one the next send would trust
      // and write into. A connection still carrying a file is left to finish.
      if (status === "offline") {
        for (const [deviceId, entry] of connections) if (idle(entry)) dropConnection(deviceId, entry);
      }
      emit({ type: "status", status, detail });
    },
    onPeer: (deviceId, isOnline) => {
      if (isOnline) online.add(deviceId);
      else {
        online.delete(deviceId);
        // A peer that vanished cannot finish a half-open connection.
        dropConnection(deviceId);
      }
      emit({ type: "presence", deviceId, online: isOnline });
    },
    onSignal: (from, payload) =>
      routeSignal(from, payload).catch((error) => emit({ type: "error", deviceId: from, error: error.message })),
    onPair: (roomId, from, payload) => pendingPairings.get(roomId)?.handle(from, payload),
    onJoined: (roomId, occupants) => {
      emit({ type: "pair-room", roomId, occupants });
      pendingPairings.get(roomId)?.joined(occupants);
    },
    onMail: (count) => {
      emit({ type: "mail", count });
      if (count > 0) collect().catch((error) => emit({ type: "error", error: error.message }));
    }
  });

  // `expected` keeps a stale callback from tearing down the connection that
  // replaced the one it belonged to.
  function dropConnection(deviceId, expected) {
    const existing = connections.get(deviceId);
    if (!existing || (expected && existing !== expected)) return;
    connections.delete(deviceId);
    try {
      existing.session?.close();
      existing.transport?.close();
    } catch {
      // Already torn down.
    }
  }

  async function routeSignal(from, payload) {
    const peer = vault.get(from);
    // Unpaired devices are ignored outright: without a stored key there is
    // nothing to verify a description against, so there is nothing to answer.
    if (!peer) return emit({ type: "rejected-signal", from });

    let entry = connections.get(from);
    if (entry && payload.kind === "offer") {
      // A new offer means the other side gave up on the connection we hold and
      // started again. Two devices that dial each other at the same moment
      // would each drop the other's attempt, so the lower id keeps its own.
      if (entry.initiator && !entry.session && identity.deviceId < from) return;
      dropConnection(from, entry);
      entry = null;
    }
    if (!entry) {
      if (payload.kind !== "offer") return;
      // A runtime with no WebRTC, such as the CLI, cannot answer. Saying so
      // sends the other device to the relay now rather than at its timeout.
      if (!globalThis.RTCPeerConnection) return signaling.signal(from, { kind: "no-direct" });
      entry = openConnection(peer, false);
    }
    try {
      await entry.transport.handleSignal(payload);
    } catch (error) {
      emit({ type: "error", deviceId: from, error: error.message });
      dropConnection(from);
    }
  }

  function openConnection(peer, initiator) {
    const entry = { peer, initiator, transport: null, session: null, ready: null };
    entry.transport = createRtcTransport({
      identity,
      peer,
      signaling,
      initiator,
      iceServers,
      onState: (state) => {
        emit({ type: "connection", deviceId: peer.deviceId, state });
        // Nothing else watches a channel once it is open, so without this a
        // closed one stayed cached and the next send waited on it forever.
        if (state === "closed" || state === "failed") dropConnection(peer.deviceId, entry);
      }
    });
    connections.set(peer.deviceId, entry);

    entry.ready = entry.transport.start().then(async (channel) => {
      entry.session = createTransferSession({
        channel,
        autoAccept: (info) => autoAccept({ ...info, from: peer.deviceId, via: "p2p" }),
        createSink: (info) => createSink({ ...info, from: peer.deviceId, via: "p2p" }),
        onEvent: (event) => emit({ ...event, deviceId: peer.deviceId, via: "p2p" })
      });
      // start() resolves to the channel adapter, which is what knows the
      // selected candidate pair.
      entry.route = await channel.route().catch(() => null);
      emit({ type: "connected", deviceId: peer.deviceId, route: entry.route });
      return entry;
    });

    entry.ready.catch(() => dropConnection(peer.deviceId, entry));
    return entry;
  }

  async function connect(deviceId) {
    const peer = vault.get(deviceId);
    if (!peer) throw new Error("That device is not paired with this one");
    const existing = connections.get(deviceId);
    if (existing) return existing.ready;
    return openConnection(peer, true).ready;
  }

  // A connection kept from earlier is only a guess that the other side is still
  // there. When it proves dead, one fresh connection is worth trying before the
  // relay: the other device is usually awake and simply closed its end while
  // this one was in the background.
  async function sendDirect(deviceId, source, meta, retry = true) {
    const reused = connections.has(deviceId);
    const entry = await connect(deviceId);
    try {
      const result = await entry.session.send(source, meta);
      return { ...result, via: "p2p", route: entry.route ?? null };
    } catch (error) {
      if (!retry || !reused || error.declined) throw error;
      dropConnection(deviceId, entry);
      return sendDirect(deviceId, source, meta, false);
    }
  }

  async function collect() {
    if (collecting) {
      // The pass under way listed the mailbox before this arrived, and a large
      // file can keep it busy for minutes.
      collectAgain = true;
      return [];
    }
    collecting = true;
    try {
      const results = [];
      do {
        collectAgain = false;
        const pass = await collectMailbox({
          api,
          identity,
          resolvePeer: async (deviceId) => vault.get(deviceId),
          createSink: (info) => createSink({ ...info, via: "relay" }),
          onProgress: (progress) => emit({ type: "progress", direction: "receive", via: "relay", ...progress }),
          onEvent: (event) => emit({ ...event, via: "relay" })
        });
        results.push(...pass);
      } while (collectAgain);
      return results;
    } finally {
      collecting = false;
    }
  }

  // Pairing is symmetric: whichever device shows the code and whichever types
  // it run the identical exchange. Both send a signed hello, both compute the
  // confirmation tag over the ordered transcript, and both refuse to store the
  // peer until the tags agree.
  async function runPairing(code, { timeoutMs = PAIR_TTL_MS, signal } = {}) {
    const normalized = pairing.parsePairingInput(code);
    const { roomId, pairKey } = await pairing.derivePairing(normalized);
    const myHello = await pairing.buildHello(identity);

    await signaling.connect();

    return new Promise((resolve, reject) => {
      let theirHello = null;
      let theirTag = null;
      let myTag = null;
      let settled = false;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingPairings.delete(roomId);
        signaling.leavePairRoom(roomId);
        if (error) reject(error);
        else resolve(value);
      };

      const timer = setTimeout(
        () => finish(new Error("Pairing timed out. Generate a fresh code and try again.")),
        timeoutMs
      );

      // Abandoning an attempt has to leave the room as well as stop listening,
      // or the next device to use that code finds it already occupied.
      if (signal) {
        if (signal.aborted) return finish(new Error("Pairing cancelled"));
        signal.addEventListener("abort", () => finish(new Error("Pairing cancelled")), { once: true });
      }

      const tryConfirm = async () => {
        if (!theirHello || theirTag === null) return;
        const ok = await pairing.checkConfirmation(pairKey, myHello, theirHello, theirTag);
        if (!ok) {
          return finish(
            new Error("Pairing failed: the other device proved a different code. Do not trust this connection.")
          );
        }
        const { sig, ...record } = theirHello;
        await vault.add({
          deviceId: record.deviceId,
          name: record.name,
          platform: record.platform,
          idPub: record.idPub,
          boxPub: record.boxPub
        });
        signaling.watch(vault.ids());
        emit({ type: "paired", deviceId: record.deviceId, name: record.name });
        finish(null, vault.record(record.deviceId));
      };

      let sentHello = false;
      const sendHello = () => {
        sentHello = true;
        signaling.sendPair(roomId, myHello);
      };

      pendingPairings.set(roomId, {
        // The server only relays to devices already in the room, so a hello
        // sent before the other side arrives is simply dropped. Wait until the
        // room reports two occupants, which both devices are told about.
        //
        // Sent again on every refill rather than once. A dropped socket that
        // reconnects rejoins its rooms, and the device that stayed would
        // otherwise sit forever on a hello it had already spent. A phone that
        // sleeps for a moment is enough to cause that. The hello is built once
        // outside this promise, so a repeat carries identical bytes and the
        // confirmation transcript does not move.
        joined(occupants) {
          if (occupants >= 2) sendHello();
        },
        async handle(_from, payload) {
          // Whoever arrived first may still be waiting on its own joined
          // notification; a message proves the room is occupied either way.
          if (!sentHello) sendHello();
          try {
            if (payload?.type === "confirm") {
              theirTag = payload.tag;
              await tryConfirm();
              return;
            }
            // A hello that repeats byte for byte is the other side asking
            // again, not a second device. It is still waiting on the
            // confirmation that was already sent once, so send that again
            // instead of recomputing a tag over the same transcript.
            if (theirHello && payload?.sig === theirHello.sig) {
              if (myTag) signaling.sendPair(roomId, { type: "confirm", tag: myTag });
              return;
            }
            // A different hello means the other side started the exchange
            // over. Its old tag covered a transcript that no longer applies.
            theirTag = null;
            theirHello = payload;
            const peer = await pairing.verifyHello(payload);
            if (peer.deviceId === identity.deviceId) {
              return finish(new Error("That code belongs to this device"));
            }
            myTag = await pairing.confirmationTag(pairKey, myHello, theirHello);
            signaling.sendPair(roomId, { type: "confirm", tag: myTag });
            await tryConfirm();
          } catch (error) {
            finish(error);
          }
        }
      });

      signaling.joinPairRoom(roomId);
    });
  }

  return {
    identity,
    api,
    signaling,
    vault,

    async start() {
      await signaling.connect();
      signaling.watch(vault.ids());
      // Anything that arrived while this device was off is waiting in the
      // mailbox; pick it up before the user has to ask.
      await collect().catch((error) => emit({ type: "error", error: error.message }));
      return this;
    },

    isOnline: (deviceId) => online.has(deviceId),
    peers: () => vault.list(),
    connections: () => [...connections.keys()],

    createPairingOffer: () => pairing.createPairingOffer(),
    pair: (code, options) => runPairing(code, options),
    unpair: async (deviceId) => {
      dropConnection(deviceId);
      const removed = await vault.remove(deviceId);
      signaling.watch(vault.ids());
      return removed;
    },

    connect,
    collect,

    // Direct first, sealed relay second. `via` in the result says which path
    // actually carried the bytes so the UI can be honest about it.
    async send(deviceId, source, { prefer = "auto", meta } = {}) {
      const peer = vault.get(deviceId);
      if (!peer) throw new Error("That device is not paired with this one");
      // One id for the whole attempt, whichever path carries it, so a host can
      // keep a single row for the file through a fallback.
      const id = meta?.id ?? shortId(16);

      // A runtime with no WebRTC at all (the CLI, a server-side script) has no
      // direct path to attempt, so go straight to the relay rather than
      // reporting a fallback from an attempt that never happened.
      const canDirect = Boolean(globalThis.RTCPeerConnection);
      if (prefer !== "relay" && canDirect && !signaling.ready) {
        let timer;
        const waited = new Promise((resolve) => (timer = setTimeout(resolve, SIGNALING_WAIT_MS)));
        await Promise.race([signaling.connect(), waited]).catch(() => {});
        clearTimeout(timer);
      }
      const tryDirect = prefer !== "relay" && canDirect && signaling.ready && online.has(deviceId);
      if (tryDirect) {
        try {
          return await sendDirect(deviceId, source, { ...meta, id });
        } catch (error) {
          if (prefer === "p2p" || error.declined) throw error;
          emit({ type: "fallback", deviceId, id, reason: error.message });
          dropConnection(deviceId);
        }
      }

      if (prefer === "p2p") {
        throw new Error(
          canDirect
            ? "That device is not reachable directly right now"
            : "This runtime has no WebRTC, so there is no direct path to use"
        );
      }

      const queued = await sendViaRelay({
        api,
        identity,
        peer,
        source,
        onProgress: (progress) =>
          emit({ type: "progress", direction: "send", via: "relay", deviceId, id, name: source.name, ...progress })
      });
      emit({ type: "complete", direction: "send", via: "relay", deviceId, id, name: source.name, total: source.size });
      return { ...queued, via: "relay" };
    },

    // For a host with reason to think it was away, such as an app coming back
    // to the foreground: a socket that died meanwhile is found in seconds
    // rather than at the next keepalive.
    wake() {
      signaling.wake(WAKE_PING_TIMEOUT_MS);
    },

    stop() {
      for (const deviceId of [...connections.keys()]) dropConnection(deviceId);
      signaling.close();
    }
  };
}

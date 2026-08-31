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
  onEvent = () => {}
}) {
  const identity = vault.identity;
  const api = createApiClient({ baseUrl: serverUrl, identity });
  const connections = new Map();
  const online = new Set();
  const pendingPairings = new Map();
  let collecting = false;

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
    onStatus: (status, detail) => emit({ type: "status", status, detail }),
    onPeer: (deviceId, isOnline) => {
      if (isOnline) online.add(deviceId);
      else {
        online.delete(deviceId);
        // A peer that vanished cannot finish a half-open connection.
        dropConnection(deviceId);
      }
      emit({ type: "presence", deviceId, online: isOnline });
    },
    onSignal: (from, payload) => routeSignal(from, payload),
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

  function dropConnection(deviceId) {
    const existing = connections.get(deviceId);
    if (!existing) return;
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
    if (!entry) {
      if (payload.kind !== "offer") return;
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
    const transport = createRtcTransport({
      identity,
      peer,
      signaling,
      initiator,
      iceServers,
      onState: (state) => emit({ type: "connection", deviceId: peer.deviceId, state })
    });

    const entry = { peer, transport, session: null, ready: null };
    connections.set(peer.deviceId, entry);

    entry.ready = transport.start().then(async (channel) => {
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

    entry.ready.catch(() => dropConnection(peer.deviceId));
    return entry;
  }

  async function connect(deviceId) {
    const peer = vault.get(deviceId);
    if (!peer) throw new Error("That device is not paired with this one");
    const existing = connections.get(deviceId);
    if (existing) return existing.ready;
    return openConnection(peer, true).ready;
  }

  async function collect() {
    if (collecting) return [];
    collecting = true;
    try {
      return await collectMailbox({
        api,
        identity,
        resolvePeer: async (deviceId) => vault.get(deviceId),
        createSink: (info) => createSink({ ...info, via: "relay" }),
        onProgress: (progress) => emit({ type: "progress", direction: "receive", via: "relay", ...progress }),
        onEvent: (event) => emit({ ...event, via: "relay" })
      });
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
        if (sentHello) return;
        sentHello = true;
        signaling.sendPair(roomId, myHello);
      };

      pendingPairings.set(roomId, {
        // The server only relays to devices already in the room, so a hello
        // sent before the other side arrives is simply dropped. Wait until the
        // room reports two occupants, which both devices are told about.
        joined(occupants) {
          if (occupants >= 2) sendHello();
        },
        async handle(_from, payload) {
          // Whoever arrived first may still be waiting on its own joined
          // notification; a message proves the room is occupied either way.
          sendHello();
          try {
            if (payload?.type === "confirm") {
              theirTag = payload.tag;
              await tryConfirm();
              return;
            }
            if (theirHello) return;
            theirHello = payload;
            const peer = await pairing.verifyHello(payload);
            if (peer.deviceId === identity.deviceId) {
              return finish(new Error("That code belongs to this device"));
            }
            const tag = await pairing.confirmationTag(pairKey, myHello, theirHello);
            signaling.sendPair(roomId, { type: "confirm", tag });
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

      // A runtime with no WebRTC at all (the CLI, a server-side script) has no
      // direct path to attempt, so go straight to the relay rather than
      // reporting a fallback from an attempt that never happened.
      const canDirect = Boolean(globalThis.RTCPeerConnection);
      const tryDirect = prefer !== "relay" && canDirect && online.has(deviceId);
      if (tryDirect) {
        try {
          const entry = await connect(deviceId);
          const result = await entry.session.send(source, meta);
          return { ...result, via: "p2p", route: entry.route ?? null };
        } catch (error) {
          if (prefer === "p2p") throw error;
          emit({ type: "fallback", deviceId, reason: error.message });
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
          emit({ type: "progress", direction: "send", via: "relay", deviceId, name: source.name, ...progress })
      });
      emit({ type: "complete", direction: "send", via: "relay", deviceId, name: source.name, total: source.size });
      return { ...queued, via: "relay" };
    },

    stop() {
      for (const deviceId of [...connections.keys()]) dropConnection(deviceId);
      signaling.close();
    }
  };
}

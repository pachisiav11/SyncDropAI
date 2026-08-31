// Host-agnostic server logic: rendezvous, presence, signal routing, mailbox and
// blob endpoints. No node: imports and no Worker imports, so the exact same
// rules run behind server/node.js (self-hosting) and server/worker (Cloudflare).
//
// What this server can see: which device ids talk to each other, how big the
// ciphertext is, and when. What it cannot see: filenames, file contents, or any
// key material. Every payload it routes or stores was sealed by the sender for
// one specific recipient device key.

import { createChallenge, verifyHandshake, verifyRequest } from "../protocol/auth.js";
import { importPeer } from "../protocol/identity.js";

const MAX_PAIR_ROOM_OCCUPANTS = 2;
const MAX_CONTROL_BODY = 256 * 1024;

export class Hub {
  constructor({ store, log = () => {} }) {
    this.store = store;
    this.log = log;
    this.connections = new Map(); // deviceId -> Set<connection>
    this.pairRooms = new Map(); // roomId -> Set<connection>
    this.watchers = new Map(); // deviceId -> Set<connection>
  }

  isOnline(deviceId) {
    return (this.connections.get(deviceId)?.size ?? 0) > 0;
  }

  connect({ send, close = () => {} }) {
    const hub = this;
    const connection = {
      nonce: createChallenge(),
      device: null,
      rooms: new Set(),
      watching: new Set(),
      send,
      close,
      async receive(raw) {
        let message;
        try {
          message = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          return send({ type: "error", message: "Malformed JSON" });
        }
        try {
          await hub.dispatch(connection, message);
        } catch (error) {
          send({ type: "error", message: error.message });
        }
      },
      dispose() {
        hub.disconnect(connection);
      }
    };

    send({ type: "challenge", nonce: connection.nonce });
    return connection;
  }

  async dispatch(connection, message) {
    const type = message?.type;
    if (type === "auth") return this.handleAuth(connection, message);
    if (!connection.device) throw new Error("Not authenticated");

    switch (type) {
      case "join-pair":
        return this.joinPairRoom(connection, message.roomId);
      case "pair":
        return this.relayPair(connection, message);
      case "leave-pair":
        return this.leavePairRoom(connection, message.roomId);
      case "watch":
        return this.watch(connection, message.peers);
      case "signal":
        return this.routeSignal(connection, message);
      case "ping":
        return connection.send({ type: "pong", t: Date.now() });
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  }

  async handleAuth(connection, message) {
    if (connection.device) throw new Error("Already authenticated");
    const peer = await verifyHandshake(message, connection.nonce);

    connection.device = peer;
    await this.store.devices.put(message.record);

    if (!this.connections.has(peer.deviceId)) this.connections.set(peer.deviceId, new Set());
    this.connections.get(peer.deviceId).add(connection);

    const mail = await this.store.mailbox.count(peer.deviceId);
    connection.send({ type: "ready", deviceId: peer.deviceId, mail });
    this.log("device online", peer.deviceId, peer.name);
    this.announce(peer.deviceId, true);
  }

  // Pairing rooms are intentionally open: the room id is a slow KDF over a code
  // only the two devices know, and the confirmation step inside the room proves
  // both sides had that code. The server just puts two sockets in touch.
  joinPairRoom(connection, roomId) {
    if (typeof roomId !== "string" || roomId.length < 16) throw new Error("Invalid room id");
    if (!this.pairRooms.has(roomId)) this.pairRooms.set(roomId, new Set());
    const room = this.pairRooms.get(roomId);
    if (!room.has(connection) && room.size >= MAX_PAIR_ROOM_OCCUPANTS) {
      throw new Error("Pairing room is full; generate a fresh code");
    }
    room.add(connection);
    connection.rooms.add(roomId);
    connection.send({ type: "joined", roomId, occupants: room.size });
    for (const other of room) {
      if (other !== connection) other.send({ type: "joined", roomId, occupants: room.size });
    }
  }

  relayPair(connection, { roomId, payload }) {
    const room = this.pairRooms.get(roomId);
    if (!room || !room.has(connection)) throw new Error("Not in that pairing room");
    for (const other of room) {
      if (other !== connection) other.send({ type: "pair", roomId, from: connection.device.deviceId, payload });
    }
  }

  leavePairRoom(connection, roomId) {
    const room = this.pairRooms.get(roomId);
    if (!room) return;
    room.delete(connection);
    connection.rooms.delete(roomId);
    if (room.size === 0) this.pairRooms.delete(roomId);
  }

  watch(connection, peers) {
    const list = Array.isArray(peers) ? peers.filter((p) => typeof p === "string").slice(0, 256) : [];
    for (const deviceId of connection.watching) this.watchers.get(deviceId)?.delete(connection);
    connection.watching = new Set(list);
    for (const deviceId of list) {
      if (!this.watchers.has(deviceId)) this.watchers.set(deviceId, new Set());
      this.watchers.get(deviceId).add(connection);
    }
    connection.send({ type: "presence", online: list.filter((deviceId) => this.isOnline(deviceId)) });
  }

  // Signal payloads carry WebRTC offers, answers and ICE candidates. They are
  // signed by the sender and bound to the session, so a hostile server can drop
  // or reorder them but cannot inject a connection of its own.
  routeSignal(connection, { to, payload }) {
    const targets = this.connections.get(to);
    if (!targets || targets.size === 0) {
      return connection.send({ type: "unreachable", to });
    }
    for (const target of targets) {
      target.send({ type: "signal", from: connection.device.deviceId, payload });
    }
  }

  announce(deviceId, online) {
    for (const watcher of this.watchers.get(deviceId) ?? []) {
      watcher.send({ type: "peer", deviceId, online });
    }
  }

  notifyMail(deviceId, count) {
    for (const connection of this.connections.get(deviceId) ?? []) {
      connection.send({ type: "mail", count });
    }
  }

  disconnect(connection) {
    for (const roomId of connection.rooms) this.leavePairRoom(connection, roomId);
    for (const deviceId of connection.watching) this.watchers.get(deviceId)?.delete(connection);
    const deviceId = connection.device?.deviceId;
    if (!deviceId) return;
    const set = this.connections.get(deviceId);
    set?.delete(connection);
    if (set && set.size === 0) {
      this.connections.delete(deviceId);
      this.log("device offline", deviceId);
      this.announce(deviceId, false);
    }
  }
}

const JSON_HEADERS = { "content-type": "application/json" };
// The API is authenticated by signature and capability token, never by a cookie
// or ambient credential, so a permissive CORS policy grants an attacker page
// nothing it could not already do with plain fetch from anywhere.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400"
};

function json(status, value) {
  return { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body: JSON.stringify(value) };
}

function fail(status, message) {
  return json(status, { error: message });
}

export function createApi({ store, hub, log = () => {} }) {
  const resolveDevice = async (deviceId) => {
    const record = await store.devices.get(deviceId);
    if (!record) return null;
    try {
      return await importPeer(record);
    } catch {
      return null;
    }
  };

  const authenticate = async (request) => {
    const header = request.headers.get("authorization");
    return verifyRequest(header, request.method, request.path, resolveDevice);
  };

  const readJsonBody = (request) => {
    if (!request.body || request.body.length === 0) return {};
    if (request.body.length > MAX_CONTROL_BODY) throw new Error("Control request body is too large");
    return JSON.parse(new TextDecoder().decode(request.body));
  };

  return async function handle(request) {
    const { method, path } = request;

    if (method === "OPTIONS") return { status: 204, headers: CORS_HEADERS, body: null };

    if (method === "GET" && path === "/api/health") {
      return json(200, { ok: true, store: store.kind, devices: hub.connections.size });
    }

    // --- data plane: capability tokens, no signature ------------------------
    // Mirrors presigned object-storage URLs. The token grants access to one
    // blob and nothing else, and the bytes behind it are already ciphertext.
    const partMatch = path.match(/^\/blob\/([0-9A-Za-z_-]{1,64})\/(\d{1,6})$/);
    if (partMatch) {
      const [, blobId, indexText] = partMatch;
      const index = Number(indexText);
      const token = request.query.get("t");
      const record = await store.blobs.get(blobId);
      if (!record) return fail(404, "No such blob");
      if (record.expiresAt <= Date.now()) return fail(410, "Blob has expired");
      if (index >= record.parts) return fail(400, "Part index is out of range");

      if (method === "PUT") {
        if (token !== record.writeToken) return fail(403, "Invalid write token");
        if (record.complete) return fail(409, "Blob is already complete");
        await store.blobs.putPart(blobId, index, request.body ?? new Uint8Array(0));
        return json(200, { blobId, index, received: true });
      }
      if (method === "GET") {
        if (token !== record.readToken) return fail(403, "Invalid read token");
        const bytes = await store.blobs.getPart(blobId, index);
        if (!bytes) return fail(404, "Part has not been uploaded");
        return {
          status: 200,
          headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length), ...CORS_HEADERS },
          body: bytes
        };
      }
      return fail(405, "Method not allowed");
    }

    // --- control plane: every route below is signature-authenticated --------
    let caller;
    try {
      caller = await authenticate(request);
    } catch (error) {
      return fail(401, error.message);
    }

    try {
      if (method === "POST" && path === "/api/blob") {
        const body = readJsonBody(request);
        const parts = Number(body.parts);
        const size = Number(body.size);
        if (!Number.isInteger(parts) || parts < 1 || parts > 100000) return fail(400, "Invalid part count");
        if (!Number.isFinite(size) || size < 0) return fail(400, "Invalid size");
        const record = await store.blobs.create({
          owner: caller.deviceId,
          recipient: typeof body.recipient === "string" ? body.recipient : null,
          parts,
          size
        });
        log("blob created", record.blobId, parts, "parts");
        return json(201, {
          blobId: record.blobId,
          parts: record.parts,
          writeToken: record.writeToken,
          readToken: record.readToken,
          expiresAt: record.expiresAt
        });
      }

      const completeMatch = path.match(/^\/api\/blob\/([0-9A-Za-z_-]{1,64})\/complete$/);
      if (method === "POST" && completeMatch) {
        const record = await store.blobs.get(completeMatch[1]);
        if (!record) return fail(404, "No such blob");
        if (record.owner !== caller.deviceId) return fail(403, "Not your blob");
        if (record.received < record.parts) return fail(409, `Only ${record.received} of ${record.parts} parts uploaded`);
        await store.blobs.complete(record.blobId);
        return json(200, { blobId: record.blobId, complete: true });
      }

      const blobMatch = path.match(/^\/api\/blob\/([0-9A-Za-z_-]{1,64})$/);
      if (blobMatch) {
        const record = await store.blobs.get(blobMatch[1]);
        if (!record) return fail(404, "No such blob");
        if (method === "GET") {
          // Either party may poll status: the sender to confirm the upload
          // landed, the recipient to see whether it is safe to start pulling.
          if (record.owner !== caller.deviceId && record.recipient !== caller.deviceId) return fail(403, "Not your blob");
          return json(200, {
            blobId: record.blobId,
            parts: record.parts,
            received: record.received,
            complete: record.complete,
            size: record.size,
            expiresAt: record.expiresAt
          });
        }
        if (method === "DELETE") {
          if (record.owner !== caller.deviceId && record.recipient !== caller.deviceId) return fail(403, "Not your blob");
          await store.blobs.remove(record.blobId);
          return json(200, { blobId: record.blobId, deleted: true });
        }
      }

      if (method === "POST" && path === "/api/mailbox") {
        const body = readJsonBody(request);
        if (typeof body.to !== "string" || !body.envelope) return fail(400, "Need a recipient and an envelope");
        // The envelope is the sender's signed artifact. Stamping anything into
        // it here would invalidate that signature, so the routing hint goes
        // beside it on the entry instead.
        const entry = await store.mailbox.push(body.to, body.envelope, caller.deviceId);
        const count = await store.mailbox.count(body.to);
        hub.notifyMail(body.to, count);
        log("mail queued for", body.to);
        return json(201, { id: entry.id, queued: true, online: hub.isOnline(body.to) });
      }

      if (method === "GET" && path === "/api/mailbox") {
        const entries = await store.mailbox.list(caller.deviceId);
        return json(200, { entries });
      }

      const ackMatch = path.match(/^\/api\/mailbox\/([0-9A-Za-z_-]{1,64})\/ack$/);
      if (method === "POST" && ackMatch) {
        const entry = await store.mailbox.get(caller.deviceId, ackMatch[1]);
        if (!entry) return fail(404, "No such envelope");
        await store.mailbox.ack(caller.deviceId, entry.id);
        // The blob exists only to carry this envelope, so drop it immediately
        // rather than waiting for the TTL sweep to reclaim the space.
        if (entry.envelope?.blobId) await store.blobs.remove(entry.envelope.blobId);
        return json(200, { id: entry.id, acked: true });
      }

      return fail(404, "No such endpoint");
    } catch (error) {
      log("api error", error.message);
      return fail(400, error.message);
    }
  };
}

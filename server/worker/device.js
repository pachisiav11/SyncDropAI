// One Durable Object per device.
//
// This is the unit that makes the design shard: a device's sockets, its public
// record, its mailbox and the list of peers watching it all live in the object
// named after its device id. Two devices never share an object, so there is no
// central hub to outgrow — a million devices is a million small objects, each
// idle almost all of the time.
//
// Sockets are accepted through the hibernation API. A phone can hold its
// rendezvous socket open all day; while nothing is being said the object is
// evicted from memory and bills nothing, and Cloudflare wakes it when a byte
// arrives. That is the whole reason a device can be "reachable" here without
// polling, which is what the account-and-poll design could never do cheaply.

import { createChallenge, verifyHandshake } from "../../protocol/auth.js";

const MAILBOX_LIMIT = 512;
const WATCHER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export class DeviceObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.deviceId = null; // learned on first use, then cached in storage
  }

  async name() {
    if (!this.deviceId) this.deviceId = (await this.state.storage.get("deviceId")) ?? null;
    return this.deviceId;
  }

  sockets() {
    return this.state.getWebSockets();
  }

  // Fan a server-authored message out to every socket this device has open.
  deliver(message) {
    const text = JSON.stringify(message);
    let delivered = 0;
    for (const socket of this.sockets()) {
      try {
        socket.send(text);
        delivered += 1;
      } catch {
        // A socket the runtime has already torn down; webSocketClose will tidy.
      }
    }
    return delivered;
  }

  peer(deviceId) {
    return this.env.DEVICE.get(this.env.DEVICE.idFromName(deviceId));
  }

  // Cross-object call. The URL host is a placeholder: Durable Object stubs are
  // addressed by id, so only the path and body carry meaning.
  call(deviceId, path, body) {
    return this.peer(deviceId).fetch("https://do/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {})
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");

    if (path === "socket") return this.openSocket(url);
    if (path === "record") return json({ record: (await this.state.storage.get("record")) ?? null });
    if (path === "online") return json({ online: this.sockets().length > 0, deviceId: await this.name() });

    const body = await request.json().catch(() => ({}));

    switch (path) {
      case "deliver":
        return json({ delivered: this.deliver(body.message) });
      case "watch":
        return this.addWatcher(body.watcher);
      case "mail/push":
        return this.mailPush(body);
      case "mail/list":
        return json({ entries: await this.mailList() });
      case "mail/count":
        return json({ count: (await this.mailList()).length });
      case "mail/get":
        return json({ entry: (await this.state.storage.get("m:" + body.id)) ?? null });
      case "mail/ack": {
        const key = "m:" + body.id;
        const existed = (await this.state.storage.get(key)) != null;
        if (existed) await this.state.storage.delete(key);
        return json({ acked: existed });
      }
      default:
        return json({ error: "No such device route" }, 404);
    }
  }

  async mailPush({ id, to, from, envelope, createdAt }) {
    const entries = await this.mailList();
    if (entries.length >= MAILBOX_LIMIT) return json({ error: "Mailbox is full" }, 429);
    const entry = { id, to, from, envelope, createdAt };
    await this.state.storage.put("m:" + id, entry);
    return json({ entry });
  }

  async mailList() {
    const found = await this.state.storage.list({ prefix: "m:" });
    return [...found.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async addWatcher(watcher) {
    if (typeof watcher !== "string" || !watcher) return json({ watching: false }, 400);
    await this.state.storage.put("w:" + watcher, Date.now());
    return json({ watching: true, online: this.sockets().length > 0 });
  }

  // Tell everyone who asked about this device that it came up or went down.
  // Watchers are stored rather than kept in memory because the object holding
  // them is evicted whenever the device is asleep, which is exactly when the
  // next transition matters.
  async announce(online) {
    const deviceId = await this.name();
    if (!deviceId) return;
    const found = await this.state.storage.list({ prefix: "w:" });
    const cutoff = Date.now() - WATCHER_TTL_MS;
    const stale = [];
    const message = { type: "peer", deviceId, online };
    await Promise.all(
      [...found].map(async ([key, seenAt]) => {
        if (seenAt < cutoff) return stale.push(key);
        await this.call(key.slice(2), "deliver", { message }).catch(() => {});
      })
    );
    if (stale.length) await this.state.storage.delete(stale);
  }

  // The `d` hint in the URL chose this object; the handshake below decides
  // whether the socket gets to keep it.
  async openSocket(url) {
    const hint = url.searchParams.get("d") ?? "";
    const known = await this.name();
    if (known && hint !== known) {
      return new Response("Device id does not match this shard", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const nonce = createChallenge();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ nonce, hint, authed: false });
    server.send(JSON.stringify({ type: "challenge", nonce }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return socket.send(JSON.stringify({ type: "error", message: "Malformed JSON" }));
    }
    try {
      await this.dispatch(socket, message);
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: error.message }));
    }
  }

  async webSocketClose(socket) {
    await this.maybeOffline(socket);
  }

  async webSocketError(socket) {
    await this.maybeOffline(socket);
  }

  // The runtime may or may not have removed the closing socket from the list
  // yet, so exclude it explicitly rather than trusting the count.
  async maybeOffline(socket) {
    const remaining = this.sockets().filter((other) => other !== socket);
    if (remaining.length === 0) await this.announce(false);
  }

  async dispatch(socket, message) {
    const attachment = socket.deserializeAttachment() ?? {};
    const type = message?.type;

    if (type === "auth") return this.handleAuth(socket, attachment, message);
    if (!attachment.authed) throw new Error("Not authenticated");
    const me = attachment.hint;

    switch (type) {
      case "join-pair":
        return this.room(message.roomId, "join", { deviceId: me });
      case "pair":
        return this.room(message.roomId, "relay", { deviceId: me, payload: message.payload });
      case "leave-pair":
        return this.room(message.roomId, "leave", { deviceId: me });
      case "watch":
        return this.handleWatch(socket, me, message.peers);
      case "signal":
        return this.handleSignal(socket, me, message);
      case "ping":
        return socket.send(JSON.stringify({ type: "pong", t: Date.now() }));
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  }

  async handleAuth(socket, attachment, message) {
    if (attachment.authed) throw new Error("Already authenticated");
    const peer = await verifyHandshake(message, attachment.nonce);
    if (peer.deviceId !== attachment.hint) throw new Error("Handshake identity does not match this connection");

    const known = await this.name();
    if (known && known !== peer.deviceId) throw new Error("Wrong shard for this device");

    // The record is derived from the key, and the id is derived from the
    // record, so this write is idempotent for the life of the device.
    await this.state.storage.put({ deviceId: peer.deviceId, record: message.record });
    this.deviceId = peer.deviceId;
    socket.serializeAttachment({ ...attachment, authed: true });

    const first = this.sockets().length <= 1;
    const mail = (await this.mailList()).length;
    socket.send(JSON.stringify({ type: "ready", deviceId: peer.deviceId, mail }));
    if (first) await this.announce(true);
    await this.schedulePrune();
  }

  async handleWatch(socket, me, peers) {
    const list = Array.isArray(peers) ? peers.filter((p) => typeof p === "string").slice(0, 256) : [];
    const states = await Promise.all(
      list.map(async (deviceId) => {
        const response = await this.call(deviceId, "watch", { watcher: me }).catch(() => null);
        if (!response || !response.ok) return null;
        const { online } = await response.json();
        return online ? deviceId : null;
      })
    );
    socket.send(JSON.stringify({ type: "presence", online: states.filter(Boolean) }));
  }

  async handleSignal(socket, me, { to, payload }) {
    if (typeof to !== "string" || !to) throw new Error("Signal needs a recipient");
    const response = await this.call(to, "deliver", { message: { type: "signal", from: me, payload } }).catch(() => null);
    const delivered = response && response.ok ? (await response.json()).delivered : 0;
    if (!delivered) socket.send(JSON.stringify({ type: "unreachable", to }));
  }

  room(roomId, action, body) {
    if (typeof roomId !== "string" || roomId.length < 16) throw new Error("Invalid room id");
    const stub = this.env.PAIR_ROOM.get(this.env.PAIR_ROOM.idFromName(roomId));
    return stub.fetch("https://do/" + action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, ...body })
    });
  }

  // Watcher rows outlive the sockets that made them, so give the object a slow
  // heartbeat that drops the ones nobody renewed.
  async schedulePrune() {
    if (await this.state.storage.getAlarm()) return;
    await this.state.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
  }

  async alarm() {
    const found = await this.state.storage.list({ prefix: "w:" });
    const cutoff = Date.now() - WATCHER_TTL_MS;
    const stale = [...found].filter(([, seenAt]) => seenAt < cutoff).map(([key]) => key);
    if (stale.length) await this.state.storage.delete(stale);
    if (this.sockets().length > 0) await this.state.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
  }
}

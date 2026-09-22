// Client for the rendezvous socket.
//
// The reconnect loop is unconditional and never gives up, because there is no
// failure mode here that a user could fix by signing in again: the device signs
// a fresh challenge with a key it already holds, so a dropped socket is always
// just a dropped socket. Compare the token model this replaced, where a network
// gap long enough to outlive a refresh token ended in a login screen.

import { buildHandshake } from "./auth.js";
import { sleep } from "./util.js";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30000;
// Nothing tells a socket that the far end went away without closing it: a
// phone that slept, a network that dropped the mapping. An unanswered ping is
// the only way this side finds out, and the relay learns the same thing from
// the pings that stop arriving.
const KEEPALIVE_MS = 25000;
const PONG_TIMEOUT_MS = 10000;

export function createSignalingClient({
  url,
  identity,
  WebSocketImpl = globalThis.WebSocket,
  onSignal = () => {},
  onPair = () => {},
  onPeer = () => {},
  onMail = () => {},
  onStatus = () => {},
  onJoined = () => {},
  keepaliveMs = KEEPALIVE_MS
}) {
  if (!WebSocketImpl) throw new Error("No WebSocket implementation available");

  let socket = null;
  let ready = false;
  let closed = false;
  let attempt = 0;
  // Bumped whenever the current socket is given up on, so a late event from a
  // socket this client has already replaced cannot act on the new one.
  let generation = 0;
  let keepalive = null;
  let pongTimer = null;
  let readyWaiters = [];
  let watching = [];
  const rooms = new Set();

  const flushReady = (error) => {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const { resolve, reject } of waiters) (error ? reject(error) : resolve());
  };

  const setStatus = (status, detail) => {
    ready = status === "ready";
    onStatus(status, detail);
  };

  function send(message) {
    if (!socket || socket.readyState !== 1) throw new Error("Signaling socket is not open");
    socket.send(JSON.stringify(message));
  }

  function stopKeepalive() {
    clearInterval(keepalive);
    clearTimeout(pongTimer);
    keepalive = null;
    pongTimer = null;
  }

  // Any message at all counts as the answer. A new probe replaces the deadline
  // of one still waiting, so a host that asks for a quick answer gets one.
  function probe(timeoutMs = PONG_TIMEOUT_MS) {
    if (!ready) return;
    try {
      send({ type: "ping" });
    } catch {
      return;
    }
    clearTimeout(pongTimer);
    const current = generation;
    pongTimer = setTimeout(() => {
      pongTimer = null;
      if (current !== generation) return;
      const dead = socket;
      lost();
      try {
        dead?.close();
      } catch {
        // It is being abandoned either way.
      }
    }, timeoutMs);
    pongTimer.unref?.();
  }

  function lost() {
    generation += 1;
    stopKeepalive();
    const wasReady = ready;
    setStatus("offline");
    if (closed) return flushReady(new Error("Signaling client was closed"));
    attempt += 1;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    // Full jitter, so a server restart does not bring every device back in
    // the same millisecond.
    const delay = wasReady ? Math.random() * RECONNECT_BASE_MS : Math.random() * backoff;
    sleep(delay).then(open);
  }

  async function handle(message) {
    switch (message.type) {
      case "challenge":
        send(await buildHandshake(identity, message.nonce));
        break;
      case "ready":
        attempt = 0;
        setStatus("ready", message);
        // Re-assert everything the old socket knew about us. The server keeps
        // no per-device state across connections on purpose.
        if (watching.length) send({ type: "watch", peers: watching });
        for (const roomId of rooms) send({ type: "join-pair", roomId });
        if (message.mail > 0) onMail(message.mail);
        stopKeepalive();
        keepalive = setInterval(() => probe(), keepaliveMs);
        keepalive.unref?.();
        probe();
        flushReady();
        break;
      case "signal":
        onSignal(message.from, message.payload);
        break;
      case "pair":
        onPair(message.roomId, message.from, message.payload);
        break;
      case "joined":
        onJoined(message.roomId, message.occupants);
        break;
      case "peer":
        onPeer(message.deviceId, message.online);
        break;
      case "presence":
        for (const deviceId of message.online) onPeer(deviceId, true);
        break;
      case "mail":
        onMail(message.count);
        break;
      case "unreachable":
        onPeer(message.to, false);
        break;
      case "error":
        onStatus("error", message.message);
        break;
      default:
        break;
    }
  }

  function open() {
    if (closed) return;
    const mine = ++generation;
    const live = () => mine === generation;
    setStatus("connecting");
    const ws = new WebSocketImpl(url);
    socket = ws;
    ws.onmessage = (event) => {
      if (!live()) return;
      clearTimeout(pongTimer);
      pongTimer = null;
      let parsed;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
      } catch {
        return;
      }
      handle(parsed).catch((error) => onStatus("error", error.message));
    };
    ws.onclose = () => {
      if (live()) lost();
    };
    ws.onerror = () => {
      if (live() && ws.readyState !== 1) onStatus("error", "Signaling connection failed");
    };
  }

  return {
    get ready() {
      return ready;
    },
    connect() {
      if (!socket) open();
      if (ready) return Promise.resolve();
      return new Promise((resolve, reject) => readyWaiters.push({ resolve, reject }));
    },
    watch(peers) {
      watching = [...peers];
      if (ready) send({ type: "watch", peers: watching });
    },
    signal(to, payload) {
      send({ type: "signal", to, payload });
    },
    joinPairRoom(roomId) {
      rooms.add(roomId);
      if (ready) send({ type: "join-pair", roomId });
    },
    sendPair(roomId, payload) {
      send({ type: "pair", roomId, payload });
    },
    leavePairRoom(roomId) {
      rooms.delete(roomId);
      if (ready) send({ type: "leave-pair", roomId });
    },
    // For a host that knows the socket may have died under it, such as an app
    // coming back from the background.
    ping(timeoutMs) {
      probe(timeoutMs);
    },
    close() {
      closed = true;
      generation += 1;
      stopKeepalive();
      flushReady(new Error("Signaling client was closed"));
      socket?.close();
      socket = null;
      setStatus("closed");
    }
  };
}

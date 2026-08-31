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

export function createSignalingClient({
  url,
  identity,
  WebSocketImpl = globalThis.WebSocket,
  onSignal = () => {},
  onPair = () => {},
  onPeer = () => {},
  onMail = () => {},
  onStatus = () => {},
  onJoined = () => {}
}) {
  if (!WebSocketImpl) throw new Error("No WebSocket implementation available");

  let socket = null;
  let ready = false;
  let closed = false;
  let attempt = 0;
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
    setStatus("connecting");
    socket = new WebSocketImpl(url);
    socket.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
      } catch {
        return;
      }
      handle(parsed).catch((error) => onStatus("error", error.message));
    };
    socket.onclose = () => {
      const wasReady = ready;
      setStatus("offline");
      if (closed) return flushReady(new Error("Signaling client was closed"));
      attempt += 1;
      const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      // Full jitter, so a server restart does not bring every device back in
      // the same millisecond.
      const delay = wasReady ? Math.random() * RECONNECT_BASE_MS : Math.random() * backoff;
      sleep(delay).then(open);
    };
    socket.onerror = () => {
      if (socket && socket.readyState !== 1) onStatus("error", "Signaling connection failed");
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
    ping() {
      send({ type: "ping" });
    },
    close() {
      closed = true;
      flushReady(new Error("Signaling client was closed"));
      socket?.close();
      socket = null;
      setStatus("closed");
    }
  };
}

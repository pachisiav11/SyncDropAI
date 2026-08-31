// How a device proves who it is to the signaling/relay server.
//
// Note what is deliberately absent: there is no account, no password, and no
// bearer token with a lifetime. A device signs a fresh challenge (WebSocket) or
// the request line itself (HTTP) with the identity key it generated at first
// run. Nothing the server holds can expire, so nothing the server holds can log
// a device out — the worst it can do is forget the public key, which the next
// connection re-registers.
//
// Authentication here only establishes *which* device is calling. Authorization
// is peer-to-peer: the server will route a message to a device, but only the
// paired peers can decrypt anything, so an unknown device connecting learns
// nothing.

import { CONTEXT } from "./constants.js";
import { importPeer, signContext, verifyContext } from "./identity.js";
import { b64u, randomBytes } from "./util.js";

export const AUTH_SCHEME = "SyncDrop";
// How far apart the two clocks may be before a signed request is refused. Wide
// enough for an unsynced phone, narrow enough that a captured header is stale
// long before anyone could reuse it against a control endpoint.
export const MAX_CLOCK_SKEW_MS = 120000;

export function createChallenge() {
  return b64u(randomBytes(32));
}

export async function buildHandshake(identity, nonce) {
  const { publicRecord } = await import("./identity.js");
  const record = publicRecord(identity);
  return {
    type: "auth",
    record,
    sig: await signContext(identity, CONTEXT.auth, { nonce, deviceId: identity.deviceId })
  };
}

export async function verifyHandshake(message, nonce) {
  if (!message || message.type !== "auth" || !message.record || !message.sig) {
    throw new Error("Malformed handshake");
  }
  const peer = await importPeer(message.record);
  const ok = await verifyContext(peer.idKey, CONTEXT.auth, { nonce, deviceId: peer.deviceId }, message.sig);
  if (!ok) throw new Error("Handshake signature is invalid");
  return peer;
}

function requestPayload(method, path, timestamp, deviceId) {
  return { m: String(method).toUpperCase(), p: path, t: timestamp, d: deviceId };
}

export async function signRequest(identity, method, path, timestamp = Date.now()) {
  const sig = await signContext(identity, CONTEXT.auth, requestPayload(method, path, timestamp, identity.deviceId));
  return `${AUTH_SCHEME} ${identity.deviceId}.${timestamp}.${sig}`;
}

// resolveDevice(deviceId) -> imported peer (or null). The server keeps the
// public record from the last handshake; an unknown device is asked to connect
// over the socket once before it can use the control API.
export async function verifyRequest(header, method, path, resolveDevice, { now = Date.now() } = {}) {
  const raw = String(header || "");
  if (!raw.startsWith(`${AUTH_SCHEME} `)) throw new Error("Missing SyncDrop authorization");
  const [deviceId, timestamp, sig] = raw.slice(AUTH_SCHEME.length + 1).split(".");
  if (!deviceId || !timestamp || !sig) throw new Error("Malformed authorization header");

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
    throw new Error("Authorization timestamp is outside the accepted window");
  }

  const peer = await resolveDevice(deviceId);
  if (!peer) throw new Error("Unknown device; open a socket connection first");

  const ok = await verifyContext(peer.idKey, CONTEXT.auth, requestPayload(method, path, ts, deviceId), sig);
  if (!ok) throw new Error("Authorization signature is invalid");
  return peer;
}

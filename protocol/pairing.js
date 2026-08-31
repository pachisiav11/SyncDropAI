// Code-authenticated pairing.
//
// Two devices that have never met derive a rendezvous room from a short code
// shown on one screen and typed (or scanned) on the other, exchange identity
// keys there, and then prove to each other that they both knew the code. That
// last step is what makes the signaling server untrusted infrastructure: it can
// see the room and relay the messages, but it cannot substitute its own keys,
// because the confirmation tag is an HMAC keyed by the code it never sees.
//
// The room id is a slow KDF over the code rather than the code itself, so an
// operator who logs every room id still cannot work backwards to the code.

import { hkdf, hmac, pbkdf2 } from "./crypto.js";
import { CONTEXT, PAIR_CODE_CHARS, PAIR_ROOM_ROUNDS, PAIR_TTL_MS, PROTOCOL_VERSION } from "./constants.js";
import { importPeer, publicRecord, signContext, verifyContext } from "./identity.js";
import { b64u, base32, canonicalBytes, equalBytes, groupCode, randomBytes, utf8 } from "./util.js";

export function generatePairingCode() {
  // 12 Crockford characters = 60 bits. Read aloud in three groups of four.
  return base32(randomBytes(8)).slice(0, PAIR_CODE_CHARS);
}

export function normalizePairingCode(input) {
  const clean = String(input || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    // Crockford aliases, so a code read off a screen survives O/0 and I/1/L.
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (clean.length !== PAIR_CODE_CHARS) {
    throw new Error(`A pairing code is ${PAIR_CODE_CHARS} characters; got ${clean.length}`);
  }
  return clean;
}

export function formatPairingCode(code) {
  return groupCode(code, 4);
}

export function pairingLink(code) {
  return `syncdrop://pair?c=${code}`;
}

export function parsePairingInput(input) {
  const text = String(input || "").trim();
  const fromLink = text.match(/[?&]c=([0-9A-Za-z]+)/);
  return normalizePairingCode(fromLink ? fromLink[1] : text);
}

// One slow derivation, then cheap HKDF splits. Doing PBKDF2 twice would double
// the cost of the only step a user actually waits on.
async function pairMaster(code) {
  return pbkdf2(normalizePairingCode(code), utf8(CONTEXT.room), PAIR_ROOM_ROUNDS, 32);
}

export async function derivePairing(code) {
  const master = await pairMaster(code);
  const [room, key] = await Promise.all([
    hkdf(master, { info: CONTEXT.room, bytes: 20 }),
    hkdf(master, { info: CONTEXT.pairKey, bytes: 32 })
  ]);
  return { roomId: base32(room), pairKey: key };
}

export function createPairingOffer() {
  const code = generatePairingCode();
  return { code, display: formatPairingCode(code), link: pairingLink(code), expiresAt: Date.now() + PAIR_TTL_MS };
}

export async function buildHello(identity) {
  const body = {
    v: PROTOCOL_VERSION,
    ...publicRecord(identity),
    nonce: b64u(randomBytes(16))
  };
  return { ...body, sig: await signContext(identity, CONTEXT.hello, body) };
}

// Returns the imported peer, or throws. Callers must treat a throw as "abort
// the pairing" rather than "retry": a bad signature here means someone other
// than the device that owns those keys produced the message.
export async function verifyHello(message) {
  const { sig, ...body } = message ?? {};
  if (!sig) throw new Error("Pairing message is not signed");
  if (body.v !== PROTOCOL_VERSION) throw new Error(`Peer speaks protocol v${body.v}, this device speaks v${PROTOCOL_VERSION}`);
  const peer = await importPeer(body);
  const ok = await verifyContext(peer.idKey, CONTEXT.hello, body, sig);
  if (!ok) throw new Error("Pairing message signature is invalid");
  return peer;
}

function helloTranscript(a, b) {
  // Both sides must hash the same bytes, and neither knows who "went first",
  // so order by device id rather than by arrival.
  const ordered = [a, b].slice().sort((x, y) => (x.deviceId < y.deviceId ? -1 : 1));
  return ordered.map(({ sig, ...body }) => body);
}

export async function confirmationTag(pairKey, helloA, helloB) {
  const bytes = canonicalBytes({ context: CONTEXT.confirm, transcript: helloTranscript(helloA, helloB) });
  return b64u(await hmac(pairKey, bytes));
}

export async function checkConfirmation(pairKey, helloA, helloB, theirTag) {
  const mine = await confirmationTag(pairKey, helloA, helloB);
  return equalBytes(utf8(mine), utf8(String(theirTag || "")));
}

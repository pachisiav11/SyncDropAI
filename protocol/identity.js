// A SyncDrop device identity: two long-lived keypairs and a name.
//
// This replaces the account model entirely. There is no server that issues it,
// no token to expire, and nothing to refresh - which is precisely why a device
// cannot be signed out. The private keys are generated on the device, never
// leave it, and are handed to the platform secure store (Windows DPAPI via
// Tauri, origin-private storage on the web).

import {
  exportPrivateKey,
  exportPublicKey,
  generateBoxKeyPair,
  generateIdentityKeyPair,
  importBoxPrivate,
  importBoxPublic,
  importIdentityPrivate,
  importIdentityPublic,
  sha256,
  sign,
  verify
} from "./crypto.js";
import { PROTOCOL_VERSION } from "./constants.js";
import { b64u, base32, canonicalBytes, groupCode, unb64u } from "./util.js";

// 120 bits of the identity-key hash, rendered as 24 Crockford characters. Long
// enough that a collision is not a concern, short enough to read down a phone.
export async function deviceIdFromPublicKey(idPubSpki) {
  const digest = await sha256(idPubSpki);
  return base32(digest.subarray(0, 15));
}

export function formatDeviceId(deviceId) {
  return groupCode(deviceId, 6);
}

export async function createIdentity({ name, platform } = {}) {
  const idPair = await generateIdentityKeyPair();
  const boxPair = await generateBoxKeyPair();
  const idPub = await exportPublicKey(idPair.publicKey);
  const boxPub = await exportPublicKey(boxPair.publicKey);

  return {
    version: PROTOCOL_VERSION,
    deviceId: await deviceIdFromPublicKey(idPub),
    name: name || "SyncDrop device",
    platform: platform || "unknown",
    createdAt: new Date().toISOString(),
    keys: {
      idPub,
      idPriv: await exportPrivateKey(idPair.privateKey),
      boxPub,
      boxPriv: await exportPrivateKey(boxPair.privateKey)
    },
    _keyPair: { idPair, boxPair }
  };
}

export function serializeIdentity(identity) {
  return JSON.stringify({
    version: identity.version,
    deviceId: identity.deviceId,
    name: identity.name,
    platform: identity.platform,
    createdAt: identity.createdAt,
    keys: {
      idPub: b64u(identity.keys.idPub),
      idPriv: b64u(identity.keys.idPriv),
      boxPub: b64u(identity.keys.boxPub),
      boxPriv: b64u(identity.keys.boxPriv)
    }
  });
}

export async function deserializeIdentity(json) {
  const raw = typeof json === "string" ? JSON.parse(json) : json;
  const keys = {
    idPub: unb64u(raw.keys.idPub),
    idPriv: unb64u(raw.keys.idPriv),
    boxPub: unb64u(raw.keys.boxPub),
    boxPriv: unb64u(raw.keys.boxPriv)
  };

  const identity = {
    version: raw.version ?? PROTOCOL_VERSION,
    deviceId: raw.deviceId,
    name: raw.name,
    platform: raw.platform,
    createdAt: raw.createdAt,
    keys,
    _keyPair: {
      idPair: {
        publicKey: await importIdentityPublic(keys.idPub),
        privateKey: await importIdentityPrivate(keys.idPriv)
      },
      boxPair: {
        publicKey: await importBoxPublic(keys.boxPub),
        privateKey: await importBoxPrivate(keys.boxPriv)
      }
    }
  };

  // A tampered store would otherwise let a device claim another device id.
  const expected = await deviceIdFromPublicKey(keys.idPub);
  if (expected !== identity.deviceId) {
    throw new Error("Stored identity is corrupt: device id does not match its key");
  }
  return identity;
}

// The half of an identity that is safe to hand to another device or the server.
export function publicRecord(identity) {
  return {
    deviceId: identity.deviceId,
    name: identity.name,
    platform: identity.platform,
    idPub: b64u(identity.keys.idPub),
    boxPub: b64u(identity.keys.boxPub)
  };
}

export async function importPeer(record) {
  const idPub = unb64u(record.idPub);
  const boxPub = unb64u(record.boxPub);
  const expected = await deviceIdFromPublicKey(idPub);
  if (expected !== record.deviceId) throw new Error("Peer record does not match its identity key");
  return {
    deviceId: record.deviceId,
    name: record.name,
    platform: record.platform,
    idPub,
    boxPub,
    idKey: await importIdentityPublic(idPub),
    boxKey: await importBoxPublic(boxPub)
  };
}

// Sign a structured value under a context string. Both sides build the same
// canonical bytes, so the signature covers the whole logical message and cannot
// be lifted into a different context.
export async function signContext(identity, context, payload) {
  const bytes = canonicalBytes({ context, payload });
  return b64u(await sign(identity._keyPair.idPair.privateKey, bytes));
}

export async function verifyContext(peerIdKey, context, payload, signature) {
  try {
    const bytes = canonicalBytes({ context, payload });
    return await verify(peerIdKey, unb64u(signature), bytes);
  } catch {
    return false;
  }
}

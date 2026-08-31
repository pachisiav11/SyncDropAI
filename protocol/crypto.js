// WebCrypto primitives for the SyncDrop protocol.
//
// Every algorithm here is chosen because it exists in ALL four runtimes we ship
// into: Chromium (PWA + Android WebView), WebView2 (Tauri on Windows), and Node.
// That rules out Ed25519/X25519, which are still uneven across webview versions,
// so identity signing is ECDSA P-256 and key agreement is ECDH P-256.
//
//   identity key (ECDSA P-256)  long-lived, names the device, signs handshakes
//   box key      (ECDH P-256)   long-lived, lets a sender encrypt to a device
//                               that is currently offline (the relay path)
//   content key  (AES-256-GCM)  per-transfer, derived, never leaves the peers

import { concat, toBytes, utf8 } from "./util.js";

const subtle = globalThis.crypto?.subtle;

if (!subtle) {
  throw new Error(
    "WebCrypto is unavailable. SyncDrop needs a secure context (https://, " +
      "http://localhost, or the app's own custom protocol)."
  );
}

export const ID_ALGO = { name: "ECDSA", namedCurve: "P-256" };
export const ID_SIGN = { name: "ECDSA", hash: "SHA-256" };
export const BOX_ALGO = { name: "ECDH", namedCurve: "P-256" };
export const AES_ALGO = "AES-GCM";
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export async function sha256(data) {
  return new Uint8Array(await subtle.digest("SHA-256", toBytes(data)));
}

export async function generateIdentityKeyPair() {
  return subtle.generateKey(ID_ALGO, true, ["sign", "verify"]);
}

export async function generateBoxKeyPair() {
  return subtle.generateKey(BOX_ALGO, true, ["deriveBits"]);
}

export async function exportPublicKey(key) {
  return new Uint8Array(await subtle.exportKey("spki", key));
}

export async function exportPrivateKey(key) {
  return new Uint8Array(await subtle.exportKey("pkcs8", key));
}

export async function importIdentityPublic(spki) {
  return subtle.importKey("spki", toBytes(spki), ID_ALGO, true, ["verify"]);
}

export async function importIdentityPrivate(pkcs8) {
  return subtle.importKey("pkcs8", toBytes(pkcs8), ID_ALGO, true, ["sign"]);
}

export async function importBoxPublic(spki) {
  return subtle.importKey("spki", toBytes(spki), BOX_ALGO, true, []);
}

export async function importBoxPrivate(pkcs8) {
  return subtle.importKey("pkcs8", toBytes(pkcs8), BOX_ALGO, true, ["deriveBits"]);
}

export async function sign(privateKey, data) {
  return new Uint8Array(await subtle.sign(ID_SIGN, privateKey, toBytes(data)));
}

export async function verify(publicKey, signature, data) {
  return subtle.verify(ID_SIGN, publicKey, toBytes(signature), toBytes(data));
}

// Raw ECDH output. Never used as a key directly — always run through HKDF with
// a context string so two different uses of the same pair get different keys.
export async function sharedSecret(privateKey, publicKey) {
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
}

export async function hkdf(ikm, { salt = new Uint8Array(0), info = "", bytes = 32 } = {}) {
  const key = await subtle.importKey("raw", toBytes(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toBytes(salt), info: typeof info === "string" ? utf8(info) : toBytes(info) },
    key,
    bytes * 8
  );
  return new Uint8Array(bits);
}

export async function pbkdf2(password, salt, iterations, bytes = 32) {
  const key = await subtle.importKey(
    "raw",
    typeof password === "string" ? utf8(password) : toBytes(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", salt: toBytes(salt), iterations, hash: "SHA-256" },
    key,
    bytes * 8
  );
  return new Uint8Array(bits);
}

export async function hmacKey(raw) {
  return subtle.importKey("raw", toBytes(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmac(raw, data) {
  const key = await hmacKey(raw);
  return new Uint8Array(await subtle.sign("HMAC", key, toBytes(data)));
}

export async function importAesKey(raw) {
  return subtle.importKey("raw", toBytes(raw), AES_ALGO, false, ["encrypt", "decrypt"]);
}

export async function aesEncrypt(key, nonce, plaintext, aad) {
  const params = { name: AES_ALGO, iv: toBytes(nonce), tagLength: TAG_BYTES * 8 };
  if (aad) params.additionalData = toBytes(aad);
  return new Uint8Array(await subtle.encrypt(params, key, toBytes(plaintext)));
}

export async function aesDecrypt(key, nonce, ciphertext, aad) {
  const params = { name: AES_ALGO, iv: toBytes(nonce), tagLength: TAG_BYTES * 8 };
  if (aad) params.additionalData = toBytes(aad);
  return new Uint8Array(await subtle.decrypt(params, key, toBytes(ciphertext)));
}

// Deterministic per-part nonce: a 8-byte random stream prefix chosen once per
// transfer, then a big-endian counter. Reusing a (key, nonce) pair under GCM is
// catastrophic, so the counter must never be reset for a given content key.
export function partNonce(streamPrefix, index) {
  if (streamPrefix.length !== NONCE_BYTES - 4) {
    throw new Error(`Stream prefix must be ${NONCE_BYTES - 4} bytes`);
  }
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, index, false);
  return concat(streamPrefix, counter);
}

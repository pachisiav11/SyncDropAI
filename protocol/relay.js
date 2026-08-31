// Store-and-forward relay: the path that runs when the other device is asleep.
//
// The sender seals the file to the recipient long-lived ECDH key, uploads the
// ciphertext in parts, and leaves a signed envelope in the recipient mailbox.
// The recipient collects it whenever it next comes online. The server holds the
// ciphertext for a TTL and nothing else - no name, no type, no key - so this
// path leaks strictly less than the Supabase Storage design it replaces, where
// filenames and metadata sat in a queryable table.
//
// Forward secrecy comes from a fresh ephemeral keypair per transfer: recovering
// a device box key later does not decrypt transfers already collected and
// deleted, because the ephemeral half is gone.

import {
  aesDecrypt,
  aesEncrypt,
  exportPublicKey,
  generateBoxKeyPair,
  hkdf,
  importAesKey,
  importBoxPublic,
  partNonce,
  sharedSecret
} from "./crypto.js";
import { CONTEXT, RELAY_PART_SIZE } from "./constants.js";
import { createChunkDigest } from "./digest.js";
import { signContext, verifyContext } from "./identity.js";
import { b64u, canonicalBytes, concat, randomBytes, unb64u, utf8 } from "./util.js";

const META_NONCE_BYTES = 12;

// Both sides must derive the same two keys from the same inputs. Binding the
// salt to both public keys means a captured ephemeral key cannot be replayed
// against a different recipient.
async function deriveKeys(secret, ephPub, boxPub) {
  const salt = concat(ephPub, boxPub);
  const [content, meta] = await Promise.all([
    hkdf(secret, { salt, info: CONTEXT.relayContent, bytes: 32 }),
    hkdf(secret, { salt, info: CONTEXT.relayMeta, bytes: 32 })
  ]);
  return { contentKey: await importAesKey(content), metaKey: await importAesKey(meta) };
}

// Every part is authenticated against its own index and its blob, so the server
// cannot reorder parts, drop one, or splice a part from another transfer.
function partAad(blobId, index) {
  return utf8(`${CONTEXT.relayContent}|${blobId}|${index}`);
}

export async function sendViaRelay({
  api,
  identity,
  peer,
  source,
  partSize = RELAY_PART_SIZE,
  onProgress = () => {}
}) {
  const ephemeral = await generateBoxKeyPair();
  const ephPub = await exportPublicKey(ephemeral.publicKey);
  const recipientBox = peer.boxKey ?? (await importBoxPublic(peer.boxPub));
  const secret = await sharedSecret(ephemeral.privateKey, recipientBox);
  const { contentKey, metaKey } = await deriveKeys(secret, ephPub, peer.boxPub);

  const parts = source.size === 0 ? 1 : Math.ceil(source.size / partSize);
  const streamPrefix = randomBytes(8);
  const digest = createChunkDigest();

  const blob = await api.createBlob({
    parts,
    size: source.size,
    recipient: peer.deviceId
  });

  let sent = 0;
  for (let index = 0; index < parts; index += 1) {
    const offset = index * partSize;
    const plain = await source.readChunk(offset, Math.min(partSize, Math.max(0, source.size - offset)));
    await digest.update(index, plain);
    const sealed = await aesEncrypt(contentKey, partNonce(streamPrefix, index), plain, partAad(blob.blobId, index));
    await api.putPart(blob.blobId, index, blob.writeToken, sealed);
    sent += plain.length;
    onProgress({ transferred: sent, total: source.size, part: index + 1, parts });
  }

  await api.completeBlob(blob.blobId);

  const metaNonce = randomBytes(META_NONCE_BYTES);
  const metadata = {
    name: source.name,
    mime: source.mime ?? "application/octet-stream",
    size: source.size,
    partSize,
    digest: await digest.final(),
    sentAt: new Date().toISOString()
  };
  const sealedMeta = await aesEncrypt(metaKey, metaNonce, canonicalBytes(metadata));

  // Everything a courier needs and nothing more. The name and type are inside
  // sealedMeta; the server sees only sizes, ids and timing.
  const envelope = {
    v: 2,
    blobId: blob.blobId,
    readToken: blob.readToken,
    parts,
    partSize,
    size: source.size,
    ephPub: b64u(ephPub),
    streamPrefix: b64u(streamPrefix),
    metaNonce: b64u(metaNonce),
    meta: b64u(sealedMeta),
    sender: identity.deviceId
  };
  envelope.sig = await signContext(identity, CONTEXT.mailbox, envelope);

  const queued = await api.sendMail(peer.deviceId, envelope);
  return { id: queued.id, blobId: blob.blobId, parts, size: source.size, metadata };
}

export async function openEnvelope({ identity, envelope, peer }) {
  if (envelope?.v !== 2) throw new Error("Unsupported envelope version");

  // The server stamps `from` on every envelope, but the server is untrusted.
  // The signature is what actually says who sent this, checked against the key
  // recorded when the two devices paired.
  const { sig, ...body } = envelope;
  const signedOk = await verifyContext(peer.idKey, CONTEXT.mailbox, body, sig);
  if (!signedOk) throw new Error("Envelope signature does not match the paired device");

  const ephPub = unb64u(envelope.ephPub);
  const secret = await sharedSecret(identity._keyPair.boxPair.privateKey, await importBoxPublic(ephPub));
  const { contentKey, metaKey } = await deriveKeys(secret, ephPub, identity.keys.boxPub);

  const metaBytes = await aesDecrypt(metaKey, unb64u(envelope.metaNonce), unb64u(envelope.meta));
  const metadata = JSON.parse(new TextDecoder().decode(metaBytes));

  return { contentKey, metadata, streamPrefix: unb64u(envelope.streamPrefix) };
}

export async function receiveViaRelay({
  api,
  identity,
  envelope,
  peer,
  createSink,
  onProgress = () => {}
}) {
  const { contentKey, metadata, streamPrefix } = await openEnvelope({ identity, envelope, peer });

  const info = {
    id: envelope.blobId,
    name: metadata.name,
    mime: metadata.mime,
    size: metadata.size,
    chunkSize: metadata.partSize,
    chunks: envelope.parts,
    via: "relay",
    from: peer.deviceId
  };

  const sink = await createSink(info);
  const digest = createChunkDigest();
  let received = 0;

  try {
    for (let index = 0; index < envelope.parts; index += 1) {
      const sealed = await api.getPart(envelope.blobId, index, envelope.readToken);
      const plain = await aesDecrypt(contentKey, partNonce(streamPrefix, index), sealed, partAad(envelope.blobId, index));
      await digest.update(index, plain);
      await sink.write(index, plain);
      received += plain.length;
      onProgress({ transferred: received, total: metadata.size, part: index + 1, parts: envelope.parts });
    }

    const ours = await digest.final();
    if (ours !== metadata.digest) throw new Error("Integrity check failed");

    await sink.close();
    return { info, metadata, result: sink.result ?? null, path: sink.path ?? null };
  } catch (error) {
    await sink.abort?.();
    throw error;
  }
}

// Drain the mailbox. Envelopes from devices this one has not paired with are
// deleted rather than kept: the sender is unauthenticated to us, and leaving
// them would let anyone who learns a device id fill the mailbox.
export async function collectMailbox({
  api,
  identity,
  resolvePeer,
  createSink,
  onProgress = () => {},
  onEvent = () => {}
}) {
  const entries = await api.listMail();
  const results = [];

  for (const entry of entries) {
    const envelope = entry.envelope ?? {};
    const peer = await resolvePeer(envelope.sender ?? entry.from);

    if (!peer) {
      onEvent({ type: "discarded", id: entry.id, reason: "Not from a paired device", from: envelope.sender });
      await api.ackMail(entry.id).catch(() => {});
      continue;
    }

    try {
      onEvent({ type: "collecting", id: entry.id, from: peer.deviceId, size: envelope.size });
      const received = await receiveViaRelay({
        api,
        identity,
        envelope,
        peer,
        createSink,
        onProgress: (progress) => onProgress({ ...progress, id: entry.id, from: peer.deviceId })
      });
      // Ack only after the bytes are safely written and verified. A crash
      // before this point leaves the envelope in place and the transfer is
      // simply collected again on the next pass.
      await api.ackMail(entry.id);
      results.push(received);
      onEvent({ type: "collected", id: entry.id, from: peer.deviceId, ...received.info, path: received.path });
    } catch (error) {
      onEvent({ type: "failed", id: entry.id, from: peer.deviceId, error: error.message });
    }
  }

  return results;
}

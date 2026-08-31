import test from "node:test";
import assert from "node:assert/strict";

import * as pair from "../protocol/pairing.js";
import { createIdentity } from "../protocol/identity.js";
import { encodeChunk, decodeChunk, encodeControl, decodeControl } from "../protocol/wire.js";
import { equalBytes, randomBytes } from "../protocol/util.js";

test("pairing code normalizes ambiguous characters", () => {
  assert.equal(pair.normalizePairingCode("abcd-efoi-1234"), "ABCDEF011234");
  assert.equal(pair.normalizePairingCode("ABCD EF01 1234"), "ABCDEF011234");
  assert.throws(() => pair.normalizePairingCode("TOOSHORT"), /12 characters/);
});

test("pairing link round-trips", () => {
  const offer = pair.createPairingOffer();
  assert.equal(pair.parsePairingInput(offer.link), offer.code);
  assert.equal(pair.parsePairingInput(offer.display), offer.code);
});

test("the same code derives the same room and key on both devices", async () => {
  const offer = pair.createPairingOffer();
  const a = await pair.derivePairing(offer.code);
  const b = await pair.derivePairing(pair.formatPairingCode(offer.code).toLowerCase());
  assert.equal(a.roomId, b.roomId);
  assert.ok(equalBytes(a.pairKey, b.pairKey));
});

test("a different code derives a different room", async () => {
  const a = await pair.derivePairing(pair.generatePairingCode());
  const b = await pair.derivePairing(pair.generatePairingCode());
  assert.notEqual(a.roomId, b.roomId);
});

test("two devices pair and agree on a confirmation tag", async () => {
  const offer = pair.createPairingOffer();
  const pc = await createIdentity({ name: "PC", platform: "windows" });
  const phone = await createIdentity({ name: "Phone", platform: "android" });

  const helloPc = await pair.buildHello(pc);
  const helloPhone = await pair.buildHello(phone);

  const seenByPhone = await pair.verifyHello(helloPc);
  const seenByPc = await pair.verifyHello(helloPhone);
  assert.equal(seenByPhone.deviceId, pc.deviceId);
  assert.equal(seenByPc.deviceId, phone.deviceId);

  const { pairKey } = await pair.derivePairing(offer.code);
  const tagPc = await pair.confirmationTag(pairKey, helloPc, helloPhone);
  // Argument order is deliberately swapped: the transcript must be ordered by
  // device id, not by who happened to speak first.
  const tagPhone = await pair.confirmationTag(pairKey, helloPhone, helloPc);
  assert.equal(tagPc, tagPhone);
  assert.ok(await pair.checkConfirmation(pairKey, helloPc, helloPhone, tagPhone));
});

test("a signaling server that swaps keys fails confirmation", async () => {
  const offer = pair.createPairingOffer();
  const { pairKey } = await pair.derivePairing(offer.code);
  const pc = await createIdentity({ name: "PC" });
  const phone = await createIdentity({ name: "Phone" });
  const attacker = await createIdentity({ name: "Evil relay" });

  const helloPc = await pair.buildHello(pc);
  const helloPhone = await pair.buildHello(phone);
  const helloEvil = await pair.buildHello(attacker);

  // The attacker signs its own hello correctly, so signature checks pass...
  await assert.doesNotReject(() => pair.verifyHello(helloEvil));
  // ...but the tag the PC computes covers the attacker key it actually saw,
  // while the phone computes over the real PC key. They cannot match.
  const tagPcSide = await pair.confirmationTag(pairKey, helloPc, helloEvil);
  const tagPhoneSide = await pair.confirmationTag(pairKey, helloEvil, helloPhone);
  assert.notEqual(tagPcSide, tagPhoneSide);
  assert.ok(!(await pair.checkConfirmation(pairKey, helloPc, helloPhone, tagPcSide)));
});

test("an attacker without the code cannot forge a tag", async () => {
  const real = await pair.derivePairing(pair.generatePairingCode());
  const guess = await pair.derivePairing(pair.generatePairingCode());
  const pc = await createIdentity({ name: "PC" });
  const phone = await createIdentity({ name: "Phone" });
  const helloPc = await pair.buildHello(pc);
  const helloPhone = await pair.buildHello(phone);

  const forged = await pair.confirmationTag(guess.pairKey, helloPc, helloPhone);
  assert.ok(!(await pair.checkConfirmation(real.pairKey, helloPc, helloPhone, forged)));
});

test("tampered hello signatures are rejected", async () => {
  const pc = await createIdentity({ name: "PC" });
  const hello = await pair.buildHello(pc);
  await assert.rejects(() => pair.verifyHello({ ...hello, name: "Not PC" }), /signature is invalid/);
  await assert.rejects(() => pair.verifyHello({ ...hello, sig: undefined }), /not signed/);
});

test("chunk frames round-trip with their header intact", () => {
  const payload = randomBytes(1000);
  const frame = encodeChunk(65535, 4294967295, payload);
  const decoded = decodeChunk(frame);
  assert.equal(decoded.streamId, 65535);
  assert.equal(decoded.sequence, 4294967295);
  assert.ok(equalBytes(decoded.payload, payload));
});

test("control messages round-trip and reject junk", () => {
  assert.deepEqual(decodeControl(encodeControl({ type: "offer", id: "x" })), { type: "offer", id: "x" });
  assert.throws(() => decodeControl(JSON.stringify({ nope: 1 })), /Malformed/);
});

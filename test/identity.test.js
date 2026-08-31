import test from "node:test";
import assert from "node:assert/strict";

import * as id from "../protocol/identity.js";
import { canonicalJson, equalBytes, randomBytes, unbase32, base32, unb64u, b64u } from "../protocol/util.js";

test("encodings round-trip", () => {
  const bytes = randomBytes(37);
  assert.ok(equalBytes(unb64u(b64u(bytes)), bytes));
  assert.ok(equalBytes(unbase32(base32(bytes)), bytes));
});

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: "1" }));
});

test("identity round-trips through serialization", async () => {
  const me = await id.createIdentity({ name: "Test PC", platform: "windows" });
  assert.equal(me.deviceId.length, 24);
  const back = await id.deserializeIdentity(id.serializeIdentity(me));
  assert.equal(back.deviceId, me.deviceId);
  assert.equal(back.name, me.name);
});

test("device id is bound to the identity key", async () => {
  const me = await id.createIdentity({ name: "A" });
  const tampered = JSON.parse(id.serializeIdentity(me));
  tampered.deviceId = "AAAAAAAAAAAAAAAAAAAAAAAA";
  await assert.rejects(() => id.deserializeIdentity(tampered), /does not match/);
});

test("peer import rejects a mismatched public record", async () => {
  const a = await id.createIdentity({ name: "A" });
  const b = await id.createIdentity({ name: "B" });
  const forged = { ...id.publicRecord(a), idPub: id.publicRecord(b).idPub };
  await assert.rejects(() => id.importPeer(forged), /does not match/);
});

test("context signatures verify and refuse cross-context replay", async () => {
  const me = await id.createIdentity({ name: "A" });
  const peer = await id.importPeer(id.publicRecord(me));
  const sig = await id.signContext(me, "ctx/one", { a: 1, b: [2, 3] });
  assert.ok(await id.verifyContext(peer.idKey, "ctx/one", { b: [2, 3], a: 1 }, sig));
  assert.ok(!(await id.verifyContext(peer.idKey, "ctx/two", { a: 1, b: [2, 3] }, sig)));
  assert.ok(!(await id.verifyContext(peer.idKey, "ctx/one", { a: 2, b: [2, 3] }, sig)));
});

test("a different device cannot forge a signature", async () => {
  const a = await id.createIdentity({ name: "A" });
  const b = await id.createIdentity({ name: "B" });
  const peerA = await id.importPeer(id.publicRecord(a));
  const sigFromB = await id.signContext(b, "ctx/one", { x: 1 });
  assert.ok(!(await id.verifyContext(peerA.idKey, "ctx/one", { x: 1 }, sigFromB)));
});

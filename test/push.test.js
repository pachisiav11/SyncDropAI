import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../server/core.js";
import { createMemoryStore } from "../server/store.js";
import { createFcmSender } from "../server/push.js";
import { createIdentity, publicRecord } from "../protocol/identity.js";
import { signRequest } from "../protocol/auth.js";
import { unb64u, utf8 } from "../protocol/util.js";

async function serviceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = btoa(String.fromCharCode(...der)).replace(/.{64}/g, "$&\n");
  return {
    publicKey: pair.publicKey,
    account: {
      type: "service_account",
      project_id: "syncdrop-test",
      client_email: "relay@syncdrop-test.iam.gserviceaccount.com",
      private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
      token_uri: "https://oauth2.example/token"
    }
  };
}

// Answers the OAuth exchange and records every FCM send.
function fakeGoogle({ sendStatus = () => 200 } = {}) {
  const calls = { grants: [], sends: [] };
  let issued = 0;
  const fetchImpl = async (url, init) => {
    if (url === "https://oauth2.example/token") {
      calls.grants.push(new URLSearchParams(init.body));
      issued += 1;
      return Response.json({ access_token: "access-" + issued, expires_in: 3600 });
    }
    calls.sends.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const status = sendStatus(calls.sends.length);
    return new Response(status === 200 ? "{}" : '{"error":{}}', { status });
  };
  return { calls, fetchImpl };
}

test("fcm: signs in with a verifiable JWT and sends a high-priority data message", async () => {
  const { account, publicKey } = await serviceAccount();
  const google = fakeGoogle();
  const sender = createFcmSender(JSON.stringify(account), { fetchImpl: google.fetchImpl });

  assert.equal(await sender.send("device-token", { type: "mail", sender: "SENDER" }), "sent");

  const grant = google.calls.grants[0];
  assert.equal(grant.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, payload, signature] = grant.get("assertion").split(".");
  const claims = JSON.parse(new TextDecoder().decode(unb64u(payload)));
  assert.equal(claims.iss, account.client_email);
  assert.equal(claims.aud, account.token_uri);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(claims.exp - claims.iat, 3600);
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    unb64u(signature),
    utf8(header + "." + payload)
  );
  assert.ok(verified, "the JWT verifies against the service account's public key");

  const send = google.calls.sends[0];
  assert.equal(send.url, "https://fcm.googleapis.com/v1/projects/syncdrop-test/messages:send");
  assert.equal(send.headers.authorization, "Bearer access-1");
  assert.equal(send.body.message.token, "device-token");
  assert.deepEqual(send.body.message.data, { type: "mail", sender: "SENDER" });
  assert.equal(send.body.message.android.priority, "HIGH");
  assert.equal(send.body.message.android.collapse_key, "SENDER");
  assert.equal(send.body.message.notification, undefined, "data only, so the app decides what to show");
});

test("fcm: reuses the access token, renews it on 401, and reports a dead token", async () => {
  const { account } = await serviceAccount();
  const statuses = [200, 200, 401, 200, 404];
  const google = fakeGoogle({ sendStatus: (n) => statuses[n - 1] });
  const sender = createFcmSender(account, { fetchImpl: google.fetchImpl });

  await sender.send("t", { type: "mail", sender: "A" });
  await sender.send("t", { type: "mail", sender: "A" });
  assert.equal(google.calls.grants.length, 1, "one sign-in for two sends");

  await assert.rejects(() => sender.send("t", { type: "mail", sender: "A" }), /401/);
  await sender.send("t", { type: "mail", sender: "A" });
  assert.equal(google.calls.grants.length, 2, "a 401 forces a fresh sign-in");
  assert.equal(google.calls.sends[3].headers.authorization, "Bearer access-2");

  assert.equal(await sender.send("t", { type: "mail", sender: "A" }), "gone");
});

test("fcm: refuses a key file that is missing fields", () => {
  assert.throws(() => createFcmSender({ project_id: "x" }), /client_email/);
});

// --- relay ------------------------------------------------------------------

async function relay({ push } = {}) {
  const store = createMemoryStore();
  const hub = { isOnline: async () => false, notifyMail: async () => {}, describe: async () => ({}) };
  const api = createApi({ store, hub, push });
  const phone = await createIdentity({ name: "Pixel", platform: "android" });
  const desk = await createIdentity({ name: "Desk PC", platform: "windows" });
  await store.devices.put(publicRecord(phone));
  await store.devices.put(publicRecord(desk));

  const call = async (identity, method, path, body) => {
    const authorization = await signRequest(identity, method, path);
    const result = await api({
      method,
      path,
      query: new URLSearchParams(),
      headers: { get: (name) => (name === "authorization" ? authorization : null) },
      body: body === undefined ? null : utf8(JSON.stringify(body))
    });
    return { status: result.status, body: JSON.parse(result.body) };
  };
  return { store, phone, desk, call };
}

test("relay: a device registers and clears its own push token", async () => {
  const { store, phone, call } = await relay();

  const set = await call(phone, "POST", "/api/push", { token: "fcm-token-1" });
  assert.equal(set.status, 200);
  assert.equal(set.body.registered, true);
  assert.equal(await store.push.get(phone.deviceId), "fcm-token-1");

  const cleared = await call(phone, "POST", "/api/push", { token: null });
  assert.equal(cleared.body.registered, false);
  assert.equal(await store.push.get(phone.deviceId), null);

  assert.equal((await call(phone, "POST", "/api/push", { token: 42 })).status, 400);
  assert.equal((await call(phone, "POST", "/api/push", { token: "x".repeat(5000) })).status, 400);
});

test("relay: an unsigned request cannot set a token", async () => {
  const store = createMemoryStore();
  const hub = { isOnline: async () => false, notifyMail: async () => {}, describe: async () => ({}) };
  const api = createApi({ store, hub });
  const result = await api({
    method: "POST",
    path: "/api/push",
    query: new URLSearchParams(),
    headers: { get: () => null },
    body: utf8(JSON.stringify({ token: "stolen" }))
  });
  assert.equal(result.status, 401);
});

test("relay: new mail pushes the sender's id to the recipient's token, and nothing else", async () => {
  const sent = [];
  const push = { send: async (token, data) => (sent.push({ token, data }), "sent") };
  const { phone, desk, call } = await relay({ push });

  // No token yet: mail still queues and nothing is pushed.
  await call(desk, "POST", "/api/mailbox", { to: phone.deviceId, envelope: { sealed: "a" } });
  assert.equal(sent.length, 0);

  await call(phone, "POST", "/api/push", { token: "phone-token" });
  const queued = await call(desk, "POST", "/api/mailbox", { to: phone.deviceId, envelope: { sealed: "b", name: "x" } });
  assert.equal(queued.status, 201);
  assert.deepEqual(sent, [{ token: "phone-token", data: { type: "mail", sender: desk.deviceId } }]);
});

test("relay: a token FCM calls dead is forgotten, and a failed push still queues the mail", async () => {
  let outcome = "gone";
  const push = {
    send: async () => {
      if (outcome === "throw") throw new Error("FCM is down");
      return outcome;
    }
  };
  const { store, phone, desk, call } = await relay({ push });

  await call(phone, "POST", "/api/push", { token: "stale" });
  await call(desk, "POST", "/api/mailbox", { to: phone.deviceId, envelope: { sealed: "a" } });
  assert.equal(await store.push.get(phone.deviceId), null);

  await call(phone, "POST", "/api/push", { token: "fresh" });
  outcome = "throw";
  const queued = await call(desk, "POST", "/api/mailbox", { to: phone.deviceId, envelope: { sealed: "b" } });
  assert.equal(queued.status, 201);
  assert.equal(await store.push.get(phone.deviceId), "fresh");
  assert.equal((await store.mailbox.list(phone.deviceId)).length, 2);
});

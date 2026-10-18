// Firebase Cloud Messaging sender, for waking a phone whose app is closed.
// FCM reserves some data keys ("from" among them) and refuses a message that
// uses one, which is why the sender's id travels as "sender".
//
// The push says only "mail is waiting, from this device id". The phone already
// knows its paired devices by id, so it can name the sender without the server
// ever holding a name, and the file itself stays sealed in the mailbox until
// the app opens and collects it.
//
// FCM's HTTP v1 API takes an OAuth access token, minted here from a
// service-account key with WebCrypto alone, so the same code runs on Node and
// on a Worker without the Google SDK.

import { b64u, utf8 } from "../protocol/util.js";
import { RELAY_TTL_DAYS } from "../protocol/constants.js";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
// Renew a little before Google says the token expires, so a send never races it.
const EXPIRY_MARGIN_MS = 60 * 1000;

async function importPrivateKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function signJwt(key, claims) {
  const header = b64u(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64u(utf8(JSON.stringify(claims)));
  const input = header + "." + payload;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(input));
  return input + "." + b64u(new Uint8Array(signature));
}

// `serviceAccount` is the key file Firebase hands out, parsed or as text.
// send() answers "sent", or "gone" when FCM says the token no longer belongs
// to an installed app, so the caller can forget it. Anything else throws.
export function createFcmSender(serviceAccount, { fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  const account = typeof serviceAccount === "string" ? JSON.parse(serviceAccount) : serviceAccount;
  if (!account?.project_id || !account.client_email || !account.private_key) {
    throw new Error("The FCM service account needs project_id, client_email and private_key");
  }
  const tokenUri = account.token_uri || DEFAULT_TOKEN_URI;
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;

  let key = null;
  let cached = null; // { token, expiresAt }

  async function accessToken() {
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token;
    key ??= await importPrivateKey(account.private_key);
    const issuedAt = Math.floor(now() / 1000);
    const assertion = await signJwt(key, {
      iss: account.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600
    });
    const response = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString()
    });
    if (!response.ok) throw new Error(`FCM sign-in failed with ${response.status}`);
    const grant = await response.json();
    cached = { token: grant.access_token, expiresAt: now() + Number(grant.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    async send(token, data) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: "Bearer " + (await accessToken()), "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            data,
            android: {
              // High priority is what reaches a phone in Doze. Android keeps
              // granting it only to apps that show a notice for each one, which
              // the phone does.
              priority: "HIGH",
              ttl: RELAY_TTL_DAYS * 24 * 60 * 60 + "s",
              // While the phone is off the network, a burst from one sender
              // waits as one push instead of one per file.
              ...(data.sender ? { collapse_key: String(data.sender).slice(0, 64) } : {})
            }
          }
        })
      });
      if (response.ok) return "sent";
      if (response.status === 404) return "gone";
      if (response.status === 401) cached = null;
      const detail = await response.text().catch(() => "");
      throw new Error(`FCM send failed with ${response.status} ${detail.slice(0, 200)}`);
    }
  };
}

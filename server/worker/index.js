// Cloudflare entrypoint.
//
// The Worker is deliberately thin. It terminates TLS, routes a socket to the
// Durable Object that owns the device, moves blob parts in and out of R2, and
// hands every other request to the same createApi() that the Node host uses.
// There is no logic here that a self-hoster does not also get.
//
// Deploy with `npx wrangler deploy` after `npx wrangler r2 bucket create
// syncdrop-blobs`. The app itself is served by the [assets] binding, so one
// deploy puts the PWA and the relay on the same origin.

import { createApi } from "../core.js";
import { createWorkerHub, createWorkerStore } from "./store.js";
import { RELAY_PART_SIZE } from "../../protocol/constants.js";
import { partKey } from "./blob.js";

export { DeviceObject } from "./device.js";
export { PairRoomObject } from "./room.js";
export { BlobObject } from "./blob.js";

// A part plus its AES-GCM tag and a little slack. Larger than this is a client
// bug or someone trying to fill the bucket.
const MAX_PART_BYTES = RELAY_PART_SIZE + 1024 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400"
};

const fail = (status, message) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...CORS }
  });

const PART_PATH = /^\/blob\/([0-9A-Za-z_-]{1,64})\/(\d{1,6})$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade") !== "websocket") return fail(426, "Expected a WebSocket upgrade");
      const deviceId = url.searchParams.get("d");
      if (!deviceId || !/^[0-9A-HJ-NP-TV-Z]{24}$/.test(deviceId)) return fail(400, "Missing device routing hint");
      // Rewritten onto the object's own route. Durable Object stubs are
      // addressed by id, so the host is a placeholder and only the path is read.
      const upgrade = new Request("https://do/socket" + url.search, request);
      return env.DEVICE.get(env.DEVICE.idFromName(deviceId)).fetch(upgrade);
    }

    const store = createWorkerStore(env);

    // Blob parts stream between the client and R2 without being buffered by a
    // Durable Object. The token check needs the record first, so that is one
    // metadata hop; the bytes themselves are never seen by anything but R2.
    const part = url.pathname.match(PART_PATH);
    if (part) {
      const response = await handlePart(request, env, store, part);
      if (response) return response;
    }

    if (url.pathname.startsWith("/api/")) {
      const hub = createWorkerHub(env);
      const api = createApi({ store, hub });
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? null
          : new Uint8Array(await request.arrayBuffer());

      const result = await api({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body
      });
      return new Response(result.body, { status: result.status, headers: result.headers ?? {} });
    }

    // Anything else is the app. ASSETS is bound to the built PWA, so the same
    // origin serves the page and the relay and no CORS preflight is needed for
    // the common case.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return fail(404, "No such endpoint");
  }
};

async function handlePart(request, env, store, match) {
  const [, blobId, indexText] = match;
  const index = Number(indexText);
  const token = new URL(request.url).searchParams.get("t");

  const record = await store.blobs.get(blobId);
  if (!record) return fail(404, "No such blob");
  if (record.expiresAt <= Date.now()) return fail(410, "Blob has expired");
  if (index >= record.parts) return fail(400, "Part index is out of range");

  if (request.method === "PUT") {
    if (token !== record.writeToken) return fail(403, "Invalid write token");
    if (record.complete) return fail(409, "Blob is already complete");
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_PART_BYTES) return fail(413, "Part is too large");

    await env.BLOBS.put(partKey(blobId, index), request.body, {
      httpMetadata: { contentType: "application/octet-stream" }
    });
    await env.BLOB.get(env.BLOB.idFromName(blobId)).fetch("https://do/received", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index })
    });
    return new Response(JSON.stringify({ blobId, index, received: true }), {
      headers: { "content-type": "application/json", ...CORS }
    });
  }

  if (request.method === "GET") {
    if (token !== record.readToken) return fail(403, "Invalid read token");
    const object = await env.BLOBS.get(partKey(blobId, index));
    if (!object) return fail(404, "Part has not been uploaded");
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        ...CORS
      }
    });
  }

  return fail(405, "Method not allowed");
}

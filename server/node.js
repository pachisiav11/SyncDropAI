// Node host for the SyncDrop rendezvous + relay server.
//
// One process serves three things: the WebSocket rendezvous that lets two
// paired devices find each other and exchange WebRTC offers, the mailbox and
// blob API that carries a transfer when the recipient is asleep, and (when a
// build exists) the web app itself. Run it on a VPS, a Pi, or your own PC.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { Hub, createApi } from "./core.js";
import { createDiskStore, createMemoryStore } from "./store.js";
import { RELAY_PART_SIZE } from "../protocol/constants.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// A relay part plus its AES-GCM tag and a little slack. Anything larger is a
// client bug or an attempt to fill the disk, so refuse it before buffering.
const MAX_BODY = RELAY_PART_SIZE + 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    request.on("error", reject);
  });
}

function serveStatic(staticDir, urlPath, response) {
  if (!staticDir) return false;
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = path.resolve(staticDir, relative);
  // path.resolve on attacker-controlled input can climb out of the root.
  if (!target.startsWith(path.resolve(staticDir))) return false;

  let file = target;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const fallback = path.join(staticDir, "index.html");
    if (!fs.existsSync(fallback)) return false;
    file = fallback;
  }
  const body = fs.readFileSync(file);
  response.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": body.length,
    // The app needs a secure context for WebCrypto; these two make the served
    // origin cross-origin isolated, which also unlocks precise timers.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "credentialless"
  });
  response.end(body);
  return true;
}

export async function startServer({
  port = Number(process.env.SYNCDROP_PORT || 8787),
  host = process.env.SYNCDROP_HOST || "0.0.0.0",
  dataDir = process.env.SYNCDROP_DATA || null,
  staticDir = null,
  verbose = true
} = {}) {
  const log = verbose ? (...args) => console.log("[syncdrop]", ...args) : () => {};
  const store = dataDir ? await createDiskStore(dataDir) : createMemoryStore();
  const hub = new Hub({ store, log });
  const api = createApi({ store, hub, log });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://" + (request.headers.host ?? "localhost"));
    const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/blob/");

    if (!isApi && serveStatic(staticDir, url.pathname, response)) return;

    let body = null;
    try {
      if (request.method !== "GET" && request.method !== "HEAD") body = await readBody(request);
    } catch (error) {
      response.writeHead(413, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
      return;
    }

    const result = await api({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: { get: (name) => request.headers[name.toLowerCase()] ?? null },
      body
    });

    response.writeHead(result.status, result.headers ?? {});
    if (result.body == null) response.end();
    else if (typeof result.body === "string") response.end(result.body);
    else response.end(Buffer.from(result.body));
  });

  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1024 * 1024 });
  wss.on("connection", (socket) => {
    const connection = hub.connect({
      send: (message) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
      close: () => socket.close()
    });
    socket.on("message", (data) => connection.receive(data.toString()));
    socket.on("close", () => connection.dispose());
    socket.on("error", () => connection.dispose());
  });

  // Keepalive: a silent proxy in the middle will drop an idle socket, and the
  // client only learns about it when a transfer fails to signal.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) if (socket.readyState === socket.OPEN) socket.ping();
  }, 30000);

  const sweeper = setInterval(async () => {
    const removed = await store.blobs.sweep();
    if (removed) log("swept", removed, "expired blobs");
  }, SWEEP_INTERVAL_MS);

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  log(`listening on http://${host}:${address.port}  (ws://${host}:${address.port}/ws)`);
  if (staticDir) log("serving app from", staticDir);
  log("store:", store.kind, dataDir ? `at ${dataDir}` : "(in memory, nothing survives a restart)");

  return {
    port: address.port,
    hub,
    store,
    async close() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

// `node server/node.js` runs a self-hosting instance.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const built = path.join(ROOT, "dist-app");
  await startServer({
    dataDir: process.env.SYNCDROP_DATA || path.join(ROOT, ".syncdrop-data"),
    staticDir: fs.existsSync(built) ? built : null
  });
}

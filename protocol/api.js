// Signed HTTP client for the mailbox and blob endpoints.
//
// Every call signs its own method and path with the device identity key, so
// there is no session to establish, nothing cached that can go stale, and no
// 401-then-refresh dance. A request either verifies or it does not.

import { signRequest } from "./auth.js";

export function createApiClient({ baseUrl, identity, fetchImpl = globalThis.fetch }) {
  const root = String(baseUrl).replace(/\/+$/, "");

  async function signed(method, path, { body, headers = {} } = {}) {
    const authorization = await signRequest(identity, method, path);
    const response = await fetchImpl(root + path, {
      method,
      headers: {
        authorization,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(parsed.error || `${method} ${path} failed with ${response.status}`);
    return parsed;
  }

  return {
    baseUrl: root,
    health: () => signed("GET", "/api/health").catch(() => fetchImpl(root + "/api/health").then((r) => r.json())),

    createBlob: ({ parts, size, recipient }) => signed("POST", "/api/blob", { body: { parts, size, recipient } }),
    blobStatus: (blobId) => signed("GET", `/api/blob/${blobId}`),
    completeBlob: (blobId) => signed("POST", `/api/blob/${blobId}/complete`),
    deleteBlob: (blobId) => signed("DELETE", `/api/blob/${blobId}`),

    // Part transfer uses the capability token, not a signature: it is the hot
    // path, and re-signing every 8 MiB part would add a KDF to each request.
    async putPart(blobId, index, token, bytes) {
      const response = await fetchImpl(`${root}/blob/${blobId}/${index}?t=${encodeURIComponent(token)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      });
      if (!response.ok) throw new Error(`Part ${index} upload failed with ${response.status}`);
      return response.json();
    },
    async getPart(blobId, index, token) {
      const response = await fetchImpl(`${root}/blob/${blobId}/${index}?t=${encodeURIComponent(token)}`);
      if (!response.ok) throw new Error(`Part ${index} download failed with ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },

    sendMail: (to, envelope) => signed("POST", "/api/mailbox", { body: { to, envelope } }),
    listMail: () => signed("GET", "/api/mailbox").then((r) => r.entries ?? []),
    ackMail: (id) => signed("POST", `/api/mailbox/${id}/ack`)
  };
}

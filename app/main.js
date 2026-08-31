// Wiring. Owns the view model, drives the protocol client, and translates its
// events into the shape the renderer wants.

import { createSyncDrop } from "../protocol/client.js";
import { openVault } from "../protocol/vault.js";
import { blobSource } from "../protocol/sources.js";
import { formatPairingCode, parsePairingInput } from "../protocol/pairing.js";
import { createHost } from "./host.js";
import * as ui from "./ui.js";

const SERVER_KEY = "syncdrop.server";
const RENAME_KEY = "syncdrop.autoname";

const el = (id) => document.getElementById(id);

const state = {
  status: "connecting",
  deviceName: "",
  deviceId: "",
  peers: [],
  pending: [],
  transfers: new Map(),
  autoName: false
};

let host;
let client;
let vault;

// A Tauri window is served from its own protocol, so it has no useful origin to
// infer a server from; the web build almost always wants the origin it came
// from, which is what `npm run serve` hands out.
function defaultServerUrl() {
  if (location.protocol.startsWith("http")) return location.origin;
  return "http://localhost:8787";
}

function refresh() {
  state.peers = client
    ? client.peers().map((peer) => ({ ...peer, online: client.isOnline(peer.deviceId) }))
    : [];
  ui.render(state, handlers);
}

function peerName(deviceId) {
  return client?.peers().find((peer) => peer.deviceId === deviceId)?.name ?? "Unknown device";
}

function upsert(id, patch) {
  const existing = state.transfers.get(id) ?? {
    id,
    name: "",
    direction: "send",
    total: 0,
    transferred: 0,
    rate: 0,
    state: "active",
    startedAt: Date.now()
  };
  state.transfers.set(id, { ...existing, ...patch });
  refresh();
}

function onProtocolEvent(event) {
  switch (event.type) {
    case "status":
      state.status = event.status;
      ui.renderStatus(state);
      return;

    case "presence":
    case "paired":
    case "connected":
      refresh();
      return;

    case "offered":
      if (event.direction === "receive") {
        upsert(event.id, {
          name: event.name,
          direction: "receive",
          total: event.total ?? event.size ?? 0,
          via: event.via,
          peerName: peerName(event.deviceId ?? event.from)
        });
      }
      return;

    case "progress":
      upsert(event.id, {
        name: event.name ?? state.transfers.get(event.id)?.name ?? "",
        direction: event.direction,
        transferred: event.transferred,
        total: event.total,
        rate: event.rate ?? 0,
        via: event.via,
        state: "active",
        peerName: peerName(event.deviceId ?? event.from)
      });
      return;

    case "collecting":
      upsert(event.id, {
        direction: "receive",
        via: "relay",
        total: event.size ?? 0,
        state: "active",
        peerName: peerName(event.from)
      });
      return;

    case "collected":
      upsert(event.id, {
        name: event.name,
        direction: "receive",
        via: "relay",
        state: "complete",
        total: event.size ?? 0,
        transferred: event.size ?? 0,
        result: event.result,
        peerName: peerName(event.from)
      });
      maybeAutoSave(event.id);
      return;

    case "complete":
      upsert(event.id, {
        name: event.name,
        direction: event.direction,
        state: "complete",
        total: event.total ?? 0,
        transferred: event.total ?? 0,
        via: event.via,
        result: event.result ?? undefined,
        route: event.route,
        peerName: peerName(event.deviceId ?? event.from)
      });
      if (event.direction === "receive") maybeAutoSave(event.id);
      return;

    case "failed":
      upsert(event.id, { state: "failed", error: event.error });
      return;

    case "rejected":
      if (event.direction === "send") ui.toast(`${event.name ?? "Transfer"} was declined`);
      return;

    case "fallback":
      ui.toast(`No direct path to ${peerName(event.deviceId)} \u2014 using the encrypted relay`);
      return;

    case "discarded":
      ui.toast("Discarded a transfer from an unpaired device");
      return;

    case "error":
      ui.toast(event.error);
      return;

    default:
      return;
  }
}

// On the desktop a received file goes straight to Downloads. In a browser a
// download needs a click, so the Save button in the activity list is the
// gesture and this does nothing.
async function maybeAutoSave(id) {
  const transfer = state.transfers.get(id);
  if (!transfer?.result || !host.canAutoSave || transfer.savedPath) return;
  try {
    const path = await host.save(transfer.result);
    upsert(id, { savedPath: path });
    ui.toast(`Saved ${transfer.name}`);
  } catch (error) {
    ui.toast(`Could not save ${transfer.name}: ${error.message}`);
  }
}

async function sendTo(deviceId) {
  const files = state.pending.splice(0, state.pending.length);
  refresh();

  for (const file of files) {
    let name = file.name;
    if (state.autoName) {
      try {
        const suggested = await host.suggestName(file);
        if (suggested) name = suggested;
      } catch {
        // Naming is a convenience. A model that is not running must never stop
        // a transfer, so fall through with the original filename.
      }
    }

    const source = blobSource(file, { name });
    try {
      await client.send(deviceId, source);
    } catch (error) {
      ui.toast(`${name}: ${error.message}`);
    }
  }
}

function addFiles(files) {
  for (const file of files) state.pending.push(file);
  refresh();
}

const handlers = {
  onSend: (deviceId) => {
    if (state.pending.length === 0) {
      el("file-input").click();
      handlers._pendingTarget = deviceId;
      return;
    }
    sendTo(deviceId);
  },
  onTarget: (deviceId) => sendTo(deviceId),
  onClear: () => {
    state.pending = [];
    refresh();
  },
  onForget: async (deviceId) => {
    await client.unpair(deviceId);
    ui.toast("Device forgotten");
    refresh();
  },
  onSave: async (transfer) => {
    try {
      const path = await host.save(transfer.result);
      if (path) upsert(transfer.id, { savedPath: path });
      ui.toast(`Saved ${transfer.name}`);
    } catch (error) {
      ui.toast(error.message);
    }
  },
  onReveal: (transfer) => host.reveal(transfer.savedPath),
  onRetry: () => ui.toast("Pick the file again to retry")
};

// --- pairing dialog ---------------------------------------------------------

function setupPairing() {
  const dialog = el("pair-dialog");
  const status = el("pair-status");
  let mode = "show";
  let offer = null;
  let attempt = null;

  const setStatus = (message, tone = "") => {
    status.textContent = message;
    status.dataset.tone = tone;
  };

  // Showing a code starts listening straight away so the other device can type
  // it immediately. Switching to "enter" has to abandon that attempt, or the
  // room stays occupied by this device and the submit below is ignored.
  const cancel = () => {
    attempt?.abort();
    attempt = null;
  };

  const selectTab = (next) => {
    mode = next;
    cancel();
    for (const tab of dialog.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.tab === next);
    el("pair-show").hidden = next !== "show";
    el("pair-enter").hidden = next !== "enter";
    setStatus("");
    el("pair-submit").disabled = false;
    if (next === "show" && offer) run(offer.code);
  };

  for (const tab of dialog.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
  }

  const run = async (code) => {
    cancel();
    const controller = new AbortController();
    attempt = controller;
    setStatus("Waiting for the other device\u2026");
    try {
      const peer = await client.pair(code, { signal: controller.signal });
      setStatus(`Paired with ${peer.name}`, "good");
      refresh();
      setTimeout(() => dialog.close(), 900);
    } catch (error) {
      // A cancelled attempt was replaced by a newer one; its message is stale.
      if (!controller.signal.aborted) setStatus(error.message, "error");
    } finally {
      if (attempt === controller) attempt = null;
    }
  };

  el("pair-button").addEventListener("click", () => {
    offer = client.createPairingOffer();
    el("pair-code").textContent = offer.display;
    el("pair-input").value = "";
    // selectTab("show") starts listening on the shown code straight away, so
    // the other device can type it the moment it appears rather than after a
    // second button press here.
    selectTab("show");
    dialog.showModal();
  });

  el("pair-submit").addEventListener("click", () => {
    if (mode === "show") return offer && run(offer.code);
    try {
      run(parsePairingInput(el("pair-input").value));
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  el("pair-input").addEventListener("input", (event) => {
    const raw = event.target.value.replace(/[^0-9A-Za-z]/g, "").toUpperCase().slice(0, 12);
    event.target.value = raw.length > 4 ? formatPairingCode(raw) : raw;
  });

  el("pair-cancel").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    cancel();
    setStatus("");
  });
}

// --- settings dialog --------------------------------------------------------

function setupSettings() {
  const dialog = el("settings-dialog");

  el("settings-button").addEventListener("click", async () => {
    el("device-name").value = state.deviceName;
    el("server-url").value = (await host.storage.getItem(SERVER_KEY)) ?? defaultServerUrl();
    ui.renderIdentity(state);
    dialog.showModal();
  });

  el("settings-close").addEventListener("click", () => dialog.close());

  el("settings-save").addEventListener("click", async () => {
    const name = el("device-name").value.trim();
    const server = el("server-url").value.trim();
    const previous = (await host.storage.getItem(SERVER_KEY)) ?? defaultServerUrl();

    if (name && name !== state.deviceName) {
      await vault.rename(name);
      state.deviceName = name;
      ui.renderIdentity(state);
    }
    if (server && server !== previous) {
      await host.storage.setItem(SERVER_KEY, server);
      ui.toast("Server changed. Reloading\u2026");
      setTimeout(() => location.reload(), 700);
      return;
    }
    dialog.close();
    ui.toast("Saved");
  });
}

// --- file picking -----------------------------------------------------------

function setupPicker() {
  const zone = el("dropzone");
  const input = el("file-input");

  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });

  input.addEventListener("change", () => {
    addFiles([...input.files]);
    input.value = "";
    const target = handlers._pendingTarget;
    handlers._pendingTarget = null;
    if (target && state.pending.length > 0) sendTo(target);
  });

  for (const type of ["dragenter", "dragover"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    zone.addEventListener(type, () => zone.classList.remove("dragging"));
  }
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    addFiles([...(event.dataTransfer?.files ?? [])]);
  });
  // Without this the browser navigates away to the dropped file.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  el("clear-activity").addEventListener("click", () => {
    for (const [id, transfer] of state.transfers) {
      if (transfer.state === "complete" || transfer.state === "failed") {
        transfer.result?.release?.();
        state.transfers.delete(id);
      }
    }
    refresh();
  });

  const toggle = el("rename-toggle");
  toggle.checked = state.autoName;
  toggle.disabled = host.kind !== "tauri";
  toggle.parentElement.title = toggle.disabled
    ? "Content naming runs a local model, so it is only available on the desktop app"
    : "Names files from their content using a model running on this machine";
  toggle.addEventListener("change", async () => {
    state.autoName = toggle.checked;
    await host.storage.setItem(RENAME_KEY, String(state.autoName));
  });
}

// Files shared into the installed PWA from the Android share sheet arrive as a
// POST that the service worker parks for us.
async function collectShareTarget() {
  if (!location.search.includes("share-target")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("syncdrop-share");
    const response = await cache.match("/shared");
    if (!response) return;
    await cache.delete("/shared");
    const form = await response.formData();
    const files = form.getAll("files").filter((entry) => entry instanceof File);
    if (files.length) {
      addFiles(files);
      ui.toast(`${files.length} file${files.length === 1 ? "" : "s"} ready to send`);
    }
  } catch {
    // Nothing shared, or the cache was cleared between the POST and the load.
  }
}

// --- boot -------------------------------------------------------------------

async function boot() {
  host = createHost();

  const serverUrl = (await host.storage.getItem(SERVER_KEY)) ?? defaultServerUrl();
  state.autoName = (await host.storage.getItem(RENAME_KEY)) === "true" && host.kind === "tauri";

  vault = await openVault(host.storage, {
    name: await host.deviceName(),
    platform: host.platform
  });

  state.deviceName = vault.identity.name;
  state.deviceId = vault.identity.deviceId;
  ui.renderIdentity(state);

  client = createSyncDrop({
    vault,
    serverUrl,
    createSink: host.createSink,
    onEvent: onProtocolEvent
  });

  // A diagnostic handle. Anything with script access to this page already has
  // full access to it, so this exposes nothing new and makes the direct-path
  // behaviour inspectable from the console.
  globalThis.syncdrop = { client, vault, state, host };

  setupPairing();
  setupSettings();
  setupPicker();
  refresh();

  await collectShareTarget();

  try {
    await client.start();
  } catch (error) {
    state.status = "error";
    ui.renderStatus(state);
    ui.toast(`Cannot reach ${serverUrl}: ${error.message}`);
  }
  refresh();

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  // A phone suspends the socket in the background; coming back to the app is
  // the moment to re-check for anything that landed while it was away.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && client) {
      client.collect().catch(() => {});
    }
  });
}

boot().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel"><h2>SyncDrop could not start</h2><p class="muted">${error.message}</p></section></main>`;
});

// Wiring. Owns the view model, drives the protocol client, and translates its
// events into the shape the renderer wants.

import { createSyncDrop } from "../protocol/client.js";
import { openVault } from "../protocol/vault.js";
import { blobSource } from "../protocol/sources.js";
import { formatPairingCode, parsePairingInput } from "../protocol/pairing.js";
import { createHost, isNative } from "./host.js";
import * as ui from "./ui.js";

const SERVER_KEY = "syncdrop.server";
const RENAME_KEY = "syncdrop.autoname";
const HISTORY_KEY = "syncdrop.activity";
const DOWNLOAD_KEY = "syncdrop.downloads";
const HISTORY_LIMIT = 40;

const el = (id) => document.getElementById(id);

const state = {
  status: "connecting",
  deviceName: "",
  deviceId: "",
  serverUrl: "",
  connectError: "",
  peers: [],
  pending: [],
  transfers: new Map(),
  autoName: false,
  downloadDir: "",
  canReveal: false
};

let host;
let client;
let vault;
let namingWarned = false;

// Compiled in from SYNCDROP_SERVER at build time. This is what makes an
// installed app work without anyone typing an address: the packaged builds have
// no origin worth trusting, and asking a person to enter a URL on a phone before
// the app does anything is the whole reason setup used to fail.
const BUILT_IN_SERVER = typeof __SYNCDROP_SERVER__ === "string" ? __SYNCDROP_SERVER__ : "";

// Where `npm run serve` listens. Only a fallback for development; a shipped
// build has the address above.
const LOCAL_SERVER = "http://localhost:8787";

function defaultServerUrl() {
  if (BUILT_IN_SERVER) return BUILT_IN_SERVER;
  // The built web app is served by the relay itself, so its own origin is the
  // right guess - but only there. Vite's dev server is on another port, and a
  // native shell reports an origin that belongs to the shell, not to a server.
  if (!isNative() && !import.meta.env.DEV && location.protocol.startsWith("http")) {
    return location.origin;
  }
  return LOCAL_SERVER;
}

// Coalesced to one paint per frame. Progress arrives faster than a screen can
// show it, and rebuilding the panels on every event costs more time than the
// transfer itself - it also blocks the event loop the data channel runs on, so
// redrawing eagerly makes the transfer it is describing slower.
let frame = 0;
let fallback = 0;

function draw() {
  if (frame) cancelAnimationFrame(frame);
  clearTimeout(fallback);
  frame = 0;
  fallback = 0;
  state.peers = client
    ? client.peers().map((peer) => ({ ...peer, online: client.isOnline(peer.deviceId) }))
    : [];
  ui.render(state, handlers);
}

// A frame and a timer, whichever comes first. A hidden or backgrounded tab
// never gets an animation frame, and a transfer that finishes while the window
// is in the background must still leave the panel showing what happened.
function refresh() {
  if (frame || fallback) return;
  if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(draw);
  fallback = setTimeout(draw, 250);
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
  if (patch.state === "complete" || patch.state === "failed" || patch.savedPath) saveHistory();
  refresh();
}

// The list was held in a Map and nowhere else, so a reload emptied it and took
// the Show in folder button for every file already on disk with it. Only
// finished rows are kept, and the sink result is deliberately not: the file it
// points at does not survive the page either, so a restored row offers the
// folder rather than a Save button that cannot work.
function saveHistory() {
  const finished = [...state.transfers.values()]
    .filter((transfer) => transfer.state === "complete" || transfer.state === "failed")
    .slice(-HISTORY_LIMIT)
    .map(({ result, retry, ...rest }) => rest);
  host.storage.setItem(HISTORY_KEY, JSON.stringify(finished)).catch(() => {});
}

async function loadHistory() {
  try {
    for (const transfer of JSON.parse((await host.storage.getItem(HISTORY_KEY)) ?? "[]")) {
      state.transfers.set(transfer.id, transfer);
    }
  } catch {
    // A history that cannot be read is not worth saying anything about.
  }
}

function onProtocolEvent(event) {
  switch (event.type) {
    case "status": {
      state.status = event.status;
      // The signaling client retries forever rather than failing, so a wrong or
      // unreachable address never surfaces as a thrown error. This status is the
      // only moment we learn that the one thing setup depends on is not working.
      // Only a live connection clears the notice: the retry loop passes through
      // "offline" and "connecting" between attempts, and the card must not blink.
      let notice = state.connectError;
      if (event.status === "error") notice = event.detail ?? "Connection failed";
      if (event.status === "ready") notice = "";

      if (notice !== state.connectError) {
        state.connectError = notice;
        refresh();
        return;
      }
      ui.renderStatus(state);
      return;
    }

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
        // Stands in until the first chunk arrives with the real name, which is
        // the earliest anything here can know it.
        name: state.transfers.get(event.id)?.name || "Incoming file",
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

  // Naming runs wherever the model is, and for a file coming off a phone that is
  // this machine. Doing it only on the way out meant everything the phone sent
  // kept the name the phone gave it, which is the name the feature exists to
  // replace.
  if (state.autoName) {
    try {
      const suggested = await host.suggestName(arrivedSource(transfer.result));
      if (suggested) {
        transfer.result.name = suggested;
        upsert(id, { name: suggested });
      }
    } catch {
      if (!namingWarned) {
        namingWarned = true;
        ui.toast("Could not reach the naming model. Files keep their own names.", 4200);
      }
    }
  }

  const name = state.transfers.get(id)?.name ?? transfer.name;
  try {
    const path = await host.save(transfer.result, { dir: state.downloadDir });
    upsert(id, { savedPath: path });
    ui.toast(`Saved ${name}`);
  } catch (error) {
    ui.toast(`Could not save ${name}: ${error.message}`);
  }
}

// suggestName reads through readChunk, which is what a file on its way out
// offers. A file that has arrived is a blob instead, so this is the adapter.
function arrivedSource(result) {
  return {
    name: result.name,
    mime: result.mime,
    size: result.size,
    readChunk: async (offset, length) =>
      new Uint8Array(await result.file.slice(offset, offset + length).arrayBuffer())
  };
}

async function sendTo(deviceId) {
  const queued = state.pending.splice(0, state.pending.length);
  refresh();

  for (const source of queued) {
    if (state.autoName) {
      try {
        const suggested = await host.suggestName(source);
        if (suggested) source.name = suggested;
      } catch {
        // Naming is a convenience. A model that is not running must never stop
        // a transfer, so fall through with the original filename - but say so
        // once. The toggle can have been switched on while the model was up and
        // the model stopped since, and a file arriving under its old name is
        // otherwise indistinguishable from the feature not existing.
        if (!namingWarned) {
          namingWarned = true;
          ui.toast("Could not reach the naming model. Files keep their own names.", 4200);
        }
      }
    }

    try {
      await client.send(deviceId, source);
    } catch (error) {
      ui.toast(`${source.name}: ${error.message}`);
    } finally {
      // A share-sheet source holds an open handle on the other side of a
      // bridge; a file picked in the page has nothing to release.
      try {
        await source.close?.();
      } catch {
        // Releasing a handle we are done with cannot fail usefully.
      }
    }
  }
}

// Everything queued for sending is a source, whichever door it came in by: a
// file picked in the page, a share from the Android sheet, or a path from the
// Windows shell. They all read on demand and none of them is copied first.
function addSources(sources) {
  for (const source of sources) state.pending.push(source);
  refresh();
}

function addFiles(files) {
  addSources([...files].map((file) => blobSource(file)));
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
      const path = await host.save(transfer.result, { dir: state.downloadDir });
      if (path) upsert(transfer.id, { savedPath: path });
      ui.toast(`Saved ${transfer.name}`);
    } catch (error) {
      ui.toast(error.message);
    }
  },
  onReveal: (transfer) => host.reveal(transfer.savedPath),
  onRetry: () => ui.toast("Pick the file again to retry"),
  onConfigure: () => openSettings()
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

async function openSettings() {
  el("device-name").value = state.deviceName;
  el("server-url").value = (await host.storage.getItem(SERVER_KEY)) ?? defaultServerUrl();

  // Only the desktop app decides where a file lands. A browser and a phone hand
  // that to the system, so there is nothing here to offer them.
  const folder = el("download-field");
  folder.hidden = host.kind !== "tauri";
  if (!folder.hidden) {
    // Shown rather than left blank, so the box says where files go today even
    // when nothing has been chosen.
    el("download-dir").value =
      state.downloadDir || (await host.resolveDownloadDir("").catch(() => ""));
  }

  ui.renderIdentity(state);
  el("settings-dialog").showModal();
}

function setupSettings() {
  const dialog = el("settings-dialog");

  el("settings-button").addEventListener("click", openSettings);

  el("settings-close").addEventListener("click", () => dialog.close());

  el("settings-save").addEventListener("click", async () => {
    const name = el("device-name").value.trim();
    const server = el("server-url").value.trim();
    const previous = (await host.storage.getItem(SERVER_KEY)) ?? defaultServerUrl();

    if (host.kind === "tauri") {
      const wanted = el("download-dir").value.trim();
      const fallback = await host.resolveDownloadDir("").catch(() => "");
      // Typing the default back in is the same as choosing nothing, and storing
      // it would freeze today's Downloads folder into the settings for good.
      const chosen = wanted === fallback ? "" : wanted;
      try {
        await host.resolveDownloadDir(chosen);
      } catch (error) {
        ui.toast(error?.message ?? String(error), 4200);
        return;
      }
      state.downloadDir = chosen;
      await host.storage.setItem(DOWNLOAD_KEY, chosen);
    }

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

// --- the naming model -------------------------------------------------------

function formatBytes(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

function offerNamerDownload() {
  el("namer-progress").hidden = true;
  el("namer-start").disabled = false;
  el("namer-detail").textContent = "";
  el("namer-dialog").querySelector("#namer-progress .bar span").style.width = "0%";
  el("namer-dialog").showModal();
}

function setupNamer() {
  const dialog = el("namer-dialog");
  const bar = dialog.querySelector("#namer-progress .bar span");
  const detail = el("namer-detail");

  const show = ({ done, total }) => {
    if (!total) return;
    bar.style.width = `${Math.min(100, (done / total) * 100)}%`;
    detail.textContent = `${formatBytes(done)} of ${formatBytes(total)}`;
  };

  host.onNamerProgress(show)?.catch?.(() => {});

  el("namer-cancel").addEventListener("click", () => dialog.close());

  el("namer-start").addEventListener("click", async () => {
    el("namer-start").disabled = true;
    el("namer-progress").hidden = false;
    // Two size probes have to answer before the first byte, so name the wait
    // rather than leaving the dialog on a word that never changes.
    detail.textContent = "Asking Hugging Face how big the model is…";

    // Asking is the backstop for being told: if the event bridge is ever
    // unavailable again, the bar still moves instead of sitting on the line
    // above with no way to tell a stall from a download.
    const poll = setInterval(() => host.namerProgress().then(show).catch(() => {}), 500);
    try {
      await host.fetchNamer();
      dialog.close();
      el("rename-toggle").checked = true;
      state.autoName = true;
      await host.storage.setItem(RENAME_KEY, "true");
      ui.toast("Naming model ready. Files are now named by their content.", 4200);
    } catch (error) {
      detail.textContent = error?.message ?? String(error);
      el("namer-start").disabled = false;
    } finally {
      clearInterval(poll);
    }
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
    saveHistory();
    refresh();
  });

  const toggle = el("rename-toggle");
  // Naming reads the file with a vision model running on this machine, and a
  // phone has none to run. A switch that can never be moved only raises the
  // question of why not, so on those hosts the control is absent rather than
  // greyed out.
  if (host.kind !== "tauri") {
    toggle.closest("label").hidden = true;
    return;
  }
  toggle.checked = state.autoName;
  toggle.parentElement.title = "Names files from their content using a model running on this machine";
  toggle.addEventListener("change", async () => {
    // Switching this on is a promise the model has to keep. The weights are
    // fetched once and are not part of the installer, so the first time anyone
    // asks for this the honest answer is to say what it costs and offer it.
    if (toggle.checked && !(await host.namerReady())) {
      toggle.checked = false;
      state.autoName = false;
      await host.storage.setItem(RENAME_KEY, "false");
      offerNamerDownload();
      return;
    }
    state.autoName = toggle.checked;
    await host.storage.setItem(RENAME_KEY, String(state.autoName));
  });
}

// Shares handed over by the operating system: the Android share sheet in the
// installed app, and "Send to" or the right-click menu on Windows.
async function collectSystemShares({ announce = true } = {}) {
  const sources = await host.takeShares().catch(() => []);
  if (sources.length === 0) return;
  addSources(sources);
  if (announce) ui.toast(`${sources.length} file${sources.length === 1 ? "" : "s"} ready to send`);
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
  state.serverUrl = serverUrl;
  state.autoName = (await host.storage.getItem(RENAME_KEY)) === "true" && host.kind === "tauri";
  state.downloadDir = (await host.storage.getItem(DOWNLOAD_KEY)) ?? "";
  state.canReveal = host.kind === "tauri";
  await loadHistory();

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
  setupNamer();
  refresh();

  await host.sweep?.();

  await collectShareTarget();
  await collectSystemShares({ announce: false });
  host.onShare(() => collectSystemShares());

  // Only a real web page gets the worker. A packaged app already carries its
  // assets, so caching them buys nothing - and it costs everything: Tauri serves
  // the window from a custom protocol that a worker's own fetch cannot reach, so
  // every request fails to the cache, a shell cached by the previous version is
  // returned, and the script tag in it names a bundle this version no longer
  // has. The window then paints the markup and runs none of the code, which
  // looks exactly like an app whose buttons have stopped working.
  if ("serviceWorker" in navigator && !isNative()) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  } else if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .then(() => caches.keys())
      .then((keys) => Promise.all(keys.filter((key) => key !== "syncdrop-share").map((key) => caches.delete(key))))
      .catch(() => {});
  }

  // A phone suspends the socket in the background; coming back to the app is
  // the moment to re-check for anything that landed while it was away.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && client) {
      client.collect().catch(() => {});
    }
  });

  // Not awaited. The signaling client retries until it succeeds, so waiting here
  // would leave a device that started while its relay was down stuck before the
  // rest of this function - which is exactly the situation setup has to survive.
  client.start().catch((error) => {
    state.status = "error";
    state.connectError = error.message;
    refresh();
  });
  refresh();
}

boot().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel"><h2>SyncDrop could not start</h2><p class="muted">${error.message}</p></section></main>`;
});

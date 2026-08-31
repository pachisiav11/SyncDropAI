// Rendering. Holds no protocol state of its own - main.js owns the model and
// calls render() after every change.

import { formatBytes, formatDuration, formatRate } from "../protocol/util.js";
import { formatDeviceId } from "../protocol/identity.js";

const PLATFORM_ICON = {
  windows: "\u{1F5A5}",
  android: "\u{1F4F1}",
  ios: "\u{1F4F1}",
  macos: "\u{1F4BB}",
  linux: "\u{1F427}",
  web: "\u{1F310}"
};

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

export function toast(message, ms = 2600) {
  const node = el("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    node.hidden = true;
  }, ms);
}

export function renderStatus(state) {
  const node = el("link-status");
  const label = {
    connecting: "Connecting",
    ready: "Connected",
    offline: "Reconnecting",
    error: "Server unreachable",
    closed: "Disconnected"
  };
  node.dataset.state = state.status;
  node.querySelector(".status-text").textContent = label[state.status] ?? state.status;
}

function routeBadge(transfer) {
  if (transfer.via === "relay") return { route: "relay", label: "Relayed" };
  if (transfer.route?.route === "lan") return { route: "lan", label: "Local network" };
  if (transfer.route?.route === "relay") return { route: "relay", label: "TURN" };
  if (transfer.via === "p2p") return { route: "p2p", label: "Direct" };
  return null;
}

export function renderDevices(state, { onSend, onForget }) {
  const host = el("devices");
  host.textContent = "";

  if (state.peers.length === 0) {
    host.innerHTML =
      '<div class="empty">No devices yet. Pair one to start sending &mdash; there is no account to create.</div>';
    return;
  }

  for (const peer of state.peers) {
    const row = document.createElement("div");
    row.className = "device";
    row.innerHTML = `
      <span class="avatar" aria-hidden="true">${PLATFORM_ICON[peer.platform] ?? PLATFORM_ICON.web}</span>
      <span class="meta">
        <span class="name">${escapeHtml(peer.name)}
          <span class="presence" data-online="${peer.online}">${peer.online ? "online" : "offline"}</span>
        </span>
        <span class="sub">${escapeHtml(formatDeviceId(peer.deviceId))}</span>
      </span>`;

    const actions = document.createElement("span");
    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "Send files";
    send.addEventListener("click", () => onSend(peer.deviceId));

    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "ghost danger";
    forget.textContent = "Forget";
    forget.addEventListener("click", () => onForget(peer.deviceId));

    actions.append(send, forget);
    actions.style.display = "flex";
    actions.style.gap = "8px";
    row.append(actions);
    host.append(row);
  }
}

export function renderOutbox(state, { onTarget, onClear }) {
  const host = el("outbox");
  host.textContent = "";
  if (state.pending.length === 0) return;

  const wrap = document.createElement("div");
  wrap.className = "outbox";

  for (const file of state.pending) {
    const row = document.createElement("div");
    row.className = "pending";
    row.innerHTML = `
      <span class="meta">
        <span class="name">${escapeHtml(file.name)}</span>
        <span class="sub muted small">${formatBytes(file.size)}</span>
      </span>`;
    wrap.append(row);
  }

  const targets = document.createElement("div");
  targets.className = "send-targets";

  if (state.peers.length === 0) {
    const note = document.createElement("span");
    note.className = "muted small";
    note.textContent = "Pair a device to send these.";
    targets.append(note);
  }

  for (const peer of state.peers) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary";
    button.textContent = peer.online ? `Send to ${peer.name}` : `Queue for ${peer.name}`;
    button.title = peer.online
      ? "Sends directly if a direct path exists"
      : "That device is asleep, so this goes to the encrypted relay and waits";
    button.addEventListener("click", () => onTarget(peer.deviceId));
    targets.append(button);
  }

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "ghost";
  clear.textContent = "Clear";
  clear.addEventListener("click", onClear);
  targets.append(clear);

  wrap.append(targets);
  host.append(wrap);
}

export function renderActivity(state, { onSave, onReveal, onRetry }) {
  const host = el("activity");
  host.textContent = "";

  const transfers = [...state.transfers.values()].sort((a, b) => b.startedAt - a.startedAt);
  if (transfers.length === 0) {
    host.innerHTML = '<div class="empty">Nothing yet. Sent and received files show up here.</div>';
    return;
  }

  for (const transfer of transfers) {
    const percent = transfer.total > 0 ? Math.min(100, (transfer.transferred / transfer.total) * 100) : 0;
    const node = document.createElement("div");
    node.className = "transfer";
    node.dataset.state = transfer.state;

    const badge = routeBadge(transfer);
    const arrow = transfer.direction === "send" ? "\u2191" : "\u2193";

    let detail;
    if (transfer.state === "complete") {
      detail = `${transfer.direction === "send" ? "Sent" : "Received"} \u00b7 ${formatBytes(transfer.total)}`;
    } else if (transfer.state === "failed") {
      detail = transfer.error ?? "Failed";
    } else if (transfer.state === "queued") {
      detail = "Waiting for the other device to wake up";
    } else {
      const remaining = transfer.rate > 0 ? (transfer.total - transfer.transferred) / transfer.rate : null;
      detail = [
        `${formatBytes(transfer.transferred)} of ${formatBytes(transfer.total)}`,
        formatRate(transfer.rate),
        remaining ? `${formatDuration(remaining)} left` : ""
      ]
        .filter(Boolean)
        .join(" \u00b7 ");
    }

    node.innerHTML = `
      <div class="transfer-head">
        <span class="name">${arrow} ${escapeHtml(transfer.name)}</span>
        <span class="detail">${escapeHtml(detail)}</span>
      </div>
      <div class="bar"><span style="width:${percent}%"></span></div>`;

    const meta = document.createElement("div");
    meta.className = "transfer-actions";

    if (badge) {
      const chip = document.createElement("span");
      chip.className = "badge";
      chip.dataset.route = badge.route;
      chip.textContent = badge.label;
      meta.append(chip);
    }
    if (transfer.peerName) {
      const who = document.createElement("span");
      who.className = "detail";
      who.style.alignSelf = "center";
      who.textContent = transfer.direction === "send" ? `to ${transfer.peerName}` : `from ${transfer.peerName}`;
      meta.append(who);
    }

    if (transfer.state === "complete" && transfer.direction === "receive" && transfer.result) {
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = transfer.savedPath ? "Save again" : "Save";
      save.addEventListener("click", () => onSave(transfer));
      meta.append(save);
    }
    if (transfer.savedPath) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "ghost";
      reveal.textContent = "Show in folder";
      reveal.title = transfer.savedPath;
      reveal.addEventListener("click", () => onReveal(transfer));
      meta.append(reveal);
    }
    if (transfer.state === "failed" && transfer.retry) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => onRetry(transfer));
      meta.append(retry);
    }

    if (meta.childElementCount > 0) node.append(meta);
    host.append(node);
  }
}

export function renderIdentity(state) {
  el("device-name").value = state.deviceName;
  el("device-id").textContent = formatDeviceId(state.deviceId);
  el("settings-button").textContent = state.deviceName;
}

export function render(state, handlers) {
  renderStatus(state);
  renderDevices(state, handlers);
  renderOutbox(state, handlers);
  renderActivity(state, handlers);
}

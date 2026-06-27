import "./styles.css";

const STORAGE_KEYS = {
  files: "syncdrop.files",
  settings: "syncdrop.settings"
};

const DEFAULT_SETTINGS = {
  deviceName: window.syncdrop?.platform === "windows" ? "Windows desktop" : "This device",
  autoRename: true,
  wifiOnly: false
};

const sampleFiles = [
  {
    id: crypto.randomUUID(),
    filename_ai: "golden-retriever-playing.jpg",
    filename_original: "IMG_9042.jpg",
    mime_type: "image/jpeg",
    size: 2100000,
    uploaded_from: "windows",
    status: "synced",
    progress: 100,
    created_at: new Date().toISOString()
  },
  {
    id: crypto.randomUUID(),
    filename_ai: "project-proposal.pdf",
    filename_original: "Draft final final.pdf",
    mime_type: "application/pdf",
    size: 3700000,
    uploaded_from: "android",
    status: "synced",
    progress: 100,
    created_at: new Date(Date.now() - 86400000).toISOString()
  }
];

const app = document.querySelector("#app");

let files = loadJson(STORAGE_KEYS.files, sampleFiles);
let settings = loadJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
let activeView = "files";
let transferStatus = {
  label: "Ready",
  detail: "Choose or drop files to simulate a local transfer.",
  progress: 0
};

function loadJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function suggestLocalName(file) {
  const extension = file.name.match(/(\.[A-Za-z0-9]{1,12})$/)?.[1]?.toLowerCase() ?? "";
  const base = file.name
    .replace(/(\.[A-Za-z0-9]{1,12})$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 54);

  return `${base || "untitled-file"}${extension}`;
}

function queueFiles(fileList) {
  const queuedFiles = [...fileList].map((file) => ({
    id: crypto.randomUUID(),
    filename_ai: settings.autoRename ? suggestLocalName(file) : file.name,
    filename_original: file.name,
    mime_type: file.type || "application/octet-stream",
    size: file.size,
    uploaded_from: window.syncdrop?.platform ?? "web",
    status: "queued",
    progress: 0,
    created_at: new Date().toISOString()
  }));

  if (queuedFiles.length === 0) return;

  files = [...queuedFiles, ...files];
  saveJson(STORAGE_KEYS.files, files);
  transferStatus = {
    label: "Queued",
    detail: `${queuedFiles.length} file${queuedFiles.length === 1 ? "" : "s"} ready to sync.`,
    progress: 0
  };
  render();
  simulateTransfers(queuedFiles.map((file) => file.id));
}

function simulateTransfers(ids) {
  ids.forEach((id, index) => {
    const startDelay = index * 450;

    setTimeout(() => {
      updateFile(id, { status: "uploading", progress: 8 });
      tickUpload(id);
    }, startDelay);
  });
}

function tickUpload(id) {
  const file = files.find((item) => item.id === id);
  if (!file || file.status !== "uploading") return;

  const nextProgress = Math.min(100, file.progress + 14 + Math.round(Math.random() * 18));
  updateFile(id, {
    progress: nextProgress,
    status: nextProgress >= 100 ? "synced" : "uploading"
  });

  if (nextProgress < 100) {
    setTimeout(() => tickUpload(id), 420 + Math.round(Math.random() * 260));
  }
}

function updateFile(id, patch) {
  files = files.map((file) => (file.id === id ? { ...file, ...patch } : file));
  saveJson(STORAGE_KEYS.files, files);
  updateTransferStatus();
  render();
}

function updateTransferStatus() {
  const activeFiles = files.filter((file) => file.status === "queued" || file.status === "uploading");
  if (activeFiles.length === 0) {
    transferStatus = {
      label: "Synced",
      detail: "All local transfers are complete.",
      progress: files.length ? 100 : 0
    };
    return;
  }

  const average = Math.round(
    activeFiles.reduce((sum, file) => sum + file.progress, 0) / activeFiles.length
  );

  transferStatus = {
    label: "Syncing",
    detail: `${activeFiles.length} active transfer${activeFiles.length === 1 ? "" : "s"}.`,
    progress: average
  };
}

function removeFile(id) {
  files = files.filter((file) => file.id !== id);
  saveJson(STORAGE_KEYS.files, files);
  updateTransferStatus();
  render();
}

function saveSettings(form) {
  settings = {
    deviceName: form.deviceName.value.trim() || DEFAULT_SETTINGS.deviceName,
    autoRename: form.autoRename.checked,
    wifiOnly: form.wifiOnly.checked
  };
  saveJson(STORAGE_KEYS.settings, settings);
  transferStatus = {
    label: "Settings saved",
    detail: "Local preferences will be used for the next transfer.",
    progress: transferStatus.progress
  };
  render();
}

function renderFile(file) {
  const uploadedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(file.created_at));
  const status = file.status === "synced" ? "Synced" : file.status === "uploading" ? "Uploading" : "Queued";

  return `
    <li class="file-row" data-id="${file.id}">
      <div class="file-name">
        <strong>${escapeHtml(file.filename_ai)}</strong>
        <span>${escapeHtml(file.filename_original)}</span>
      </div>
      <div class="file-meta">
        <span>${formatBytes(file.size)}</span>
        <span>${escapeHtml(file.uploaded_from)}</span>
        <span>${uploadedAt}</span>
      </div>
      <div class="file-progress">
        <span class="status ${file.status}">${status}</span>
        <progress value="${file.progress}" max="100"></progress>
      </div>
      <div class="file-actions">
        <button type="button" data-action="download" data-id="${file.id}">Download</button>
        <button type="button" class="danger" data-action="delete" data-id="${file.id}">Delete</button>
      </div>
    </li>
  `;
}

function renderSettings() {
  return `
    <section class="settings-panel" aria-labelledby="settings-heading">
      <div>
        <h2 id="settings-heading">Settings</h2>
        <p>Stored locally for now. Supabase account sync arrives in the integration phase.</p>
      </div>
      <form id="settings-form">
        <label>
          <span>Device name</span>
          <input name="deviceName" value="${escapeHtml(settings.deviceName)}" maxlength="48" />
        </label>
        <label class="check-row">
          <input name="autoRename" type="checkbox" ${settings.autoRename ? "checked" : ""} />
          <span>Suggest clean filenames during upload</span>
        </label>
        <label class="check-row">
          <input name="wifiOnly" type="checkbox" ${settings.wifiOnly ? "checked" : ""} />
          <span>Prefer Wi-Fi transfers on mobile</span>
        </label>
        <button type="submit">Save settings</button>
      </form>
    </section>
  `;
}

function renderFiles() {
  return `
    <section class="files" aria-labelledby="files-heading">
      <div class="section-heading">
        <h2 id="files-heading">Files</h2>
        <span>${files.length} item${files.length === 1 ? "" : "s"}</span>
      </div>
      <ul>${files.map(renderFile).join("")}</ul>
    </section>
  `;
}

function render() {
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div>
          <h1>SyncDrop AI</h1>
          <span>${escapeHtml(settings.deviceName)}</span>
        </div>
        <nav aria-label="Primary">
          <button type="button" data-view="files" class="${activeView === "files" ? "active" : ""}">Files</button>
          <button type="button" data-action="open-picker">Upload</button>
          <button type="button" data-view="settings" class="${activeView === "settings" ? "active" : ""}">Settings</button>
        </nav>
      </header>

      <section class="drop-zone" aria-label="File upload drop zone">
        <input id="file-input" type="file" multiple />
        <label for="file-input">
          <strong>Drop files here</strong>
          <span>or choose files to add a mocked transfer from this device</span>
        </label>
      </section>

      <section class="transfer-panel" aria-live="polite">
        <div>
          <strong>${transferStatus.label}</strong>
          <span>${transferStatus.detail}</span>
        </div>
        <progress value="${transferStatus.progress}" max="100"></progress>
      </section>

      ${activeView === "settings" ? renderSettings() : renderFiles()}
    </main>
  `;

  attachEvents();
}

function attachEvents() {
  const fileInput = document.querySelector("#file-input");
  const dropZone = document.querySelector(".drop-zone");
  const settingsForm = document.querySelector("#settings-form");

  fileInput.addEventListener("change", (event) => {
    queueFiles(event.target.files);
    event.target.value = "";
  });

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("is-dragging");
  });

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    queueFiles(event.dataTransfer.files);
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view;
      render();
    });
  });

  document.querySelector("[data-action='open-picker']").addEventListener("click", () => {
    fileInput.click();
  });

  document.querySelectorAll("[data-action='delete']").forEach((button) => {
    button.addEventListener("click", () => removeFile(button.dataset.id));
  });

  document.querySelectorAll("[data-action='download']").forEach((button) => {
    button.addEventListener("click", () => {
      transferStatus = {
        label: "Download mocked",
        detail: "Real download links will be connected after Supabase storage is added.",
        progress: transferStatus.progress
      };
      render();
    });
  });

  settingsForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettings(settingsForm);
  });
}

render();

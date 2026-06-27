import "./styles.css";
import { isSupabaseConfigured, storageBucket, supabase } from "./supabaseClient.js";

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
let session = null;
let authEmail = "";
let isBusy = false;
let transferStatus = {
  label: isSupabaseConfigured ? "Connect" : "Local mode",
  detail: isSupabaseConfigured
    ? "Sign in to sync files through Supabase."
    : "Add Supabase env vars to enable cloud sync.",
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
  return String(value ?? "")
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

function cleanFilename(filename) {
  const extension = filename.match(/(\.[A-Za-z0-9]{1,12})$/)?.[1]?.toLowerCase() ?? "";
  const base = filename
    .replace(/(\.[A-Za-z0-9]{1,12})$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 54);

  return `${base || "untitled-file"}${extension}`;
}

function makeStoragePath(userId, id, filename) {
  return `${userId}/${id}-${cleanFilename(filename)}`;
}

function setStatus(label, detail, progress = transferStatus.progress) {
  transferStatus = { label, detail, progress };
  render();
}

function localFileRecord(file) {
  return {
    id: crypto.randomUUID(),
    filename_ai: settings.autoRename ? cleanFilename(file.name) : file.name,
    filename_original: file.name,
    mime_type: file.type || "application/octet-stream",
    size: file.size,
    uploaded_from: window.syncdrop?.platform ?? "web",
    status: "queued",
    progress: 0,
    created_at: new Date().toISOString()
  };
}

async function initSupabase() {
  if (!isSupabaseConfigured) return;

  const { data } = await supabase.auth.getSession();
  session = data.session;

  supabase.auth.onAuthStateChange((_event, nextSession) => {
    session = nextSession;
    if (session) {
      loadCloudFiles();
    } else {
      files = loadJson(STORAGE_KEYS.files, sampleFiles);
      render();
    }
  });

  if (session) {
    await loadCloudFiles();
  }
}

async function signInWithEmail(email) {
  if (!supabase || !email) return;
  isBusy = true;
  setStatus("Sending link", "Check your email for the Supabase magic link.", 20);

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.href
    }
  });

  isBusy = false;
  setStatus(error ? "Sign-in failed" : "Link sent", error?.message ?? "Open the link on this device to finish sign-in.", error ? 0 : 100);
}

async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
  session = null;
  setStatus("Signed out", "Local sample files are shown until you sign in again.", 0);
}

async function loadCloudFiles() {
  if (!session) return;
  isBusy = true;
  setStatus("Refreshing", "Loading file metadata from Supabase.", 35);

  const { data, error } = await supabase
    .from("files")
    .select("id, filename_ai, filename_original, storage_path, mime_type, size, uploaded_from, created_at")
    .order("created_at", { ascending: false });

  isBusy = false;

  if (error) {
    setStatus("Refresh failed", error.message, 0);
    return;
  }

  files = data.map((file) => ({
    ...file,
    status: "synced",
    progress: 100
  }));
  setStatus("Synced", `${files.length} cloud file${files.length === 1 ? "" : "s"} loaded.`, 100);
}

async function queueFiles(fileList) {
  const selectedFiles = [...fileList];
  if (selectedFiles.length === 0) return;

  if (isSupabaseConfigured && session) {
    await uploadCloudFiles(selectedFiles);
    return;
  }

  const queuedFiles = selectedFiles.map(localFileRecord);
  files = [...queuedFiles, ...files];
  saveJson(STORAGE_KEYS.files, files);
  setStatus("Queued", `${queuedFiles.length} file${queuedFiles.length === 1 ? "" : "s"} ready to sync.`, 0);
  simulateTransfers(queuedFiles.map((file) => file.id));
}

async function uploadCloudFiles(selectedFiles) {
  if (!session) return;
  isBusy = true;

  for (let index = 0; index < selectedFiles.length; index += 1) {
    const file = selectedFiles[index];
    const id = crypto.randomUUID();
    const filename_ai = settings.autoRename ? cleanFilename(file.name) : file.name;
    const storage_path = makeStoragePath(session.user.id, id, filename_ai);
    const progressBase = Math.round((index / selectedFiles.length) * 100);

    setStatus("Uploading", `${file.name} to Supabase storage.`, progressBase);

    const upload = await supabase.storage.from(storageBucket).upload(storage_path, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false
    });

    if (upload.error) {
      isBusy = false;
      setStatus("Upload failed", upload.error.message, progressBase);
      return;
    }

    const insert = await supabase.from("files").insert({
      id,
      user_id: session.user.id,
      filename_ai,
      filename_original: file.name,
      storage_path,
      mime_type: file.type || "application/octet-stream",
      size: file.size,
      uploaded_from: window.syncdrop?.platform ?? "web"
    });

    if (insert.error) {
      await supabase.storage.from(storageBucket).remove([storage_path]);
      isBusy = false;
      setStatus("Metadata failed", insert.error.message, progressBase);
      return;
    }
  }

  isBusy = false;
  await loadCloudFiles();
}

function simulateTransfers(ids) {
  ids.forEach((id, index) => {
    setTimeout(() => {
      updateLocalFile(id, { status: "uploading", progress: 8 });
      tickUpload(id);
    }, index * 450);
  });
}

function tickUpload(id) {
  const file = files.find((item) => item.id === id);
  if (!file || file.status !== "uploading") return;

  const nextProgress = Math.min(100, file.progress + 14 + Math.round(Math.random() * 18));
  updateLocalFile(id, {
    progress: nextProgress,
    status: nextProgress >= 100 ? "synced" : "uploading"
  });

  if (nextProgress < 100) {
    setTimeout(() => tickUpload(id), 420 + Math.round(Math.random() * 260));
  }
}

function updateLocalFile(id, patch) {
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

  transferStatus = {
    label: "Syncing",
    detail: `${activeFiles.length} active transfer${activeFiles.length === 1 ? "" : "s"}.`,
    progress: Math.round(activeFiles.reduce((sum, file) => sum + file.progress, 0) / activeFiles.length)
  };
}

async function removeFile(id) {
  const file = files.find((item) => item.id === id);
  if (!file) return;

  if (isSupabaseConfigured && session && file.storage_path) {
    const removeStorage = await supabase.storage.from(storageBucket).remove([file.storage_path]);
    if (removeStorage.error) {
      setStatus("Delete failed", removeStorage.error.message, 0);
      return;
    }

    const removeMetadata = await supabase.from("files").delete().eq("id", id);
    if (removeMetadata.error) {
      setStatus("Metadata delete failed", removeMetadata.error.message, 0);
      return;
    }

    await loadCloudFiles();
    return;
  }

  files = files.filter((item) => item.id !== id);
  saveJson(STORAGE_KEYS.files, files);
  updateTransferStatus();
  render();
}

async function downloadFile(id) {
  const file = files.find((item) => item.id === id);
  if (!file) return;

  if (isSupabaseConfigured && session && file.storage_path) {
    const { data, error } = await supabase.storage.from(storageBucket).createSignedUrl(file.storage_path, 60);
    if (error) {
      setStatus("Download failed", error.message, 0);
      return;
    }

    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    setStatus("Download ready", "Signed URL opened in a new tab.", 100);
    return;
  }

  setStatus("Download mocked", "Real download links are available after signing into Supabase.", transferStatus.progress);
}

function saveSettings(form) {
  settings = {
    deviceName: form.deviceName.value.trim() || DEFAULT_SETTINGS.deviceName,
    autoRename: form.autoRename.checked,
    wifiOnly: form.wifiOnly.checked
  };
  saveJson(STORAGE_KEYS.settings, settings);
  setStatus("Settings saved", "Local preferences will be used for the next transfer.", transferStatus.progress);
}

function renderAuthPanel() {
  if (!isSupabaseConfigured) {
    return `
      <section class="auth-panel" aria-label="Connection status">
        <strong>Supabase not configured</strong>
        <span>Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable cloud sync.</span>
      </section>
    `;
  }

  if (session) {
    return `
      <section class="auth-panel" aria-label="Connection status">
        <div>
          <strong>Signed in</strong>
          <span>${escapeHtml(session.user.email)}</span>
        </div>
        <div class="auth-actions">
          <button type="button" data-action="refresh" ${isBusy ? "disabled" : ""}>Refresh</button>
          <button type="button" data-action="sign-out" ${isBusy ? "disabled" : ""}>Sign out</button>
        </div>
      </section>
    `;
  }

  return `
    <section class="auth-panel" aria-label="Connection status">
      <div>
        <strong>Cloud sync</strong>
        <span>Sign in with a Supabase magic link.</span>
      </div>
      <form id="auth-form" class="auth-form">
        <input name="email" type="email" placeholder="you@example.com" value="${escapeHtml(authEmail)}" required />
        <button type="submit" ${isBusy ? "disabled" : ""}>Send link</button>
      </form>
    </section>
  `;
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
        <p>Stored locally. Cloud file data is tied to the signed-in Supabase account.</p>
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

      ${renderAuthPanel()}

      <section class="drop-zone" aria-label="File upload drop zone">
        <input id="file-input" type="file" multiple />
        <label for="file-input">
          <strong>Drop files here</strong>
          <span>${session ? "Files will upload to Supabase storage" : "or choose files to add a local mocked transfer"}</span>
        </label>
      </section>

      <section class="transfer-panel" aria-live="polite">
        <div>
          <strong>${escapeHtml(transferStatus.label)}</strong>
          <span>${escapeHtml(transferStatus.detail)}</span>
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
  const authForm = document.querySelector("#auth-form");

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
    button.addEventListener("click", () => downloadFile(button.dataset.id));
  });

  document.querySelector("[data-action='refresh']")?.addEventListener("click", loadCloudFiles);
  document.querySelector("[data-action='sign-out']")?.addEventListener("click", signOut);

  settingsForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettings(settingsForm);
  });

  authForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    authEmail = authForm.email.value.trim();
    signInWithEmail(authEmail);
  });
}

render();
initSupabase();

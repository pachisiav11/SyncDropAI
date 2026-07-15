import "./styles.css";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import {
  isSupabaseConfigured,
  storageBucket,
  supabase,
  supabaseAnonKey,
  supabaseUrl
} from "./supabaseClient.js";
import { cleanFilename, formatBytes, makeStoragePath } from "./core/filenames.js";

const LOGIN_CALLBACK_URL = "com.syncdrop.ai://login-callback";

const STORAGE_KEYS = {
  files: "syncdrop.files",
  cloudFiles: "syncdrop.cloudFiles",
  settings: "syncdrop.settings"
};

const LARGE_FILE_BYTES = 25 * 1024 * 1024;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

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
let otpRequested = false;
let isBusy = false;
// Per-upload override for the next batch of files chosen from the drop zone.
// Defaults to the global `autoRename` setting; the drop-zone toggle overrides
// it for that one upload only (mirrors the CLI's `--no-rename` flag).
let renameNextUpload = settings.autoRename;
let pendingCloudFiles = [];
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isOffline() {
  return typeof navigator !== "undefined" && "onLine" in navigator && !navigator.onLine;
}

function isRetryableError(error) {
  const status = error?.status ?? error?.cause?.status;
  return isOffline() || RETRYABLE_STATUS_CODES.has(Number(status)) || /network|timeout|failed to fetch/i.test(error?.message ?? "");
}

async function withRetry(operation, label, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableError(error)) break;
      setStatus(label, `Temporary connection issue. Retrying ${attempt + 1} of ${attempts}.`, transferStatus.progress);
      await sleep(700 * attempt);
    }
  }

  throw lastError;
}

function readCachedCloudFiles() {
  const cached = loadJson(STORAGE_KEYS.cloudFiles, []);
  return Array.isArray(cached) ? cached : [];
}

function cacheCloudFiles(nextFiles) {
  saveJson(STORAGE_KEYS.cloudFiles, nextFiles);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(label, detail, progress = transferStatus.progress) {
  transferStatus = { label, detail, progress };
  render();
}

function localFileRecord(file, autoRename = settings.autoRename) {
  return {
    id: crypto.randomUUID(),
    filename_ai: autoRename ? cleanFilename(file.name) : file.name,
    filename_original: file.name,
    mime_type: file.type || "application/octet-stream",
    size: file.size,
    uploaded_from: window.syncdrop?.platform ?? "web",
    status: "queued",
    progress: 0,
    created_at: new Date().toISOString()
  };
}

// Mirror the desktop session to the CLI's shared store (~/.syncdrop/session.json)
// via the Electron main process. No-op on web/Android — only the Electron
// preload exposes syncdrop.persistSession. Keeps CLI auth "app-only".
function mirrorSessionToCli(nextSession) {
  if (!window.syncdrop?.persistSession) return;
  if (nextSession) {
    window.syncdrop.persistSession({
      supabaseUrl,
      supabaseAnonKey,
      storageBucket,
      access_token: nextSession.access_token,
      refresh_token: nextSession.refresh_token,
      expires_at: nextSession.expires_at,
      user: nextSession.user ? { id: nextSession.user.id, email: nextSession.user.email } : null
    });
  } else {
    window.syncdrop.persistSession(null);
  }
}

async function initSupabase() {
  if (!isSupabaseConfigured) return;

  const { data } = await supabase.auth.getSession();
  session = data.session;
  mirrorSessionToCli(session);

  supabase.auth.onAuthStateChange((_event, nextSession) => {
    session = nextSession;
    mirrorSessionToCli(nextSession);
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

  if (Capacitor.isNativePlatform()) {
    App.addListener("appUrlOpen", ({ url }) => handleAuthCallback(url));
  }

  // Electron: the main process captures the email magic-link tokens via a loopback
  // server and forwards them here to complete sign-in.
  if (window.syncdrop?.onAuthTokens) {
    window.syncdrop.onAuthTokens(async ({ access_token, refresh_token }) => {
      if (!access_token || !refresh_token) return;

      isBusy = true;
      setStatus("Signing in", "Completing sign-in from email link.", 60);

      const { error } = await supabase.auth.setSession({ access_token, refresh_token });

      isBusy = false;
      otpRequested = false;
      setStatus(error ? "Sign-in failed" : "Signed in", error?.message ?? "Cloud sync is ready.", error ? 0 : 100);
    });
  }

  // Electron: the background worker names deferred files (including phone
  // uploads); refresh the list when it renames any so the new names appear.
  if (window.syncdrop?.onFilesRenamed) {
    window.syncdrop.onFilesRenamed(() => {
      loadCloudFiles();
    });
  }
}

async function handleAuthCallback(url) {
  const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return;

  isBusy = true;
  setStatus("Signing in", "Completing sign-in from email link.", 60);

  const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });

  isBusy = false;
  otpRequested = false;
  setStatus(error ? "Sign-in failed" : "Signed in", error?.message ?? "Cloud sync is ready.", error ? 0 : 100);
}

async function signInWithEmail(email) {
  if (!supabase || !email) return;
  isBusy = true;
  setStatus("Sending link", "Check your email for the sign-in link or code.", 20);

  const redirectTo = Capacitor.isNativePlatform()
    ? LOGIN_CALLBACK_URL
    : window.syncdrop?.authRedirectUrl ?? window.location.href;
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });

  otpRequested = !error;
  isBusy = false;
  setStatus(error ? "Sign-in failed" : "Link sent", error?.message ?? "Tap the link in your email, or enter a code below if your project sends one.", error ? 0 : 100);
}

async function verifyOtpCode(email, token) {
  if (!supabase || !email || !token) return;
  isBusy = true;
  setStatus("Verifying code", "Checking your sign-in code.", 60);

  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });

  isBusy = false;
  if (error) {
    setStatus("Verification failed", error.message, 0);
  } else {
    otpRequested = false;
    setStatus("Signed in", "Cloud sync is ready.", 100);
  }
}

async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
  session = null;
  otpRequested = false;
  setStatus("Signed out", "Local sample files are shown until you sign in again.", 0);
}

async function loadCloudFiles() {
  if (!session) return;
  isBusy = true;
  setStatus("Refreshing", "Loading file metadata from Supabase.", 35);

  let result;
  try {
    result = await withRetry(
      async () => {
        const response = await supabase
          .from("files")
          .select("id, filename_ai, filename_original, storage_path, mime_type, size, uploaded_from, created_at")
          .order("created_at", { ascending: false });

        if (response.error) throw response.error;
        return response;
      },
      "Refreshing"
    );
  } catch (error) {
    isBusy = false;
    const cached = readCachedCloudFiles();
    if (cached.length) {
      files = cached.map((file) => ({ ...file, status: "synced", progress: 100 }));
      setStatus("Offline cache", `${files.length} cached cloud file${files.length === 1 ? "" : "s"} shown.`, 100);
      return;
    }

    setStatus("Refresh failed", error.message, 0);
    return;
  }

  isBusy = false;

  files = result.data.map((file) => ({
    ...file,
    status: "synced",
    progress: 100
  }));
  cacheCloudFiles(result.data);
  setStatus("Synced", `${files.length} cloud file${files.length === 1 ? "" : "s"} loaded.`, 100);
}

async function queueFiles(fileList, autoRename = renameNextUpload) {
  const selectedFiles = [...fileList];
  if (selectedFiles.length === 0) return;

  if (isSupabaseConfigured && session) {
    if (isOffline()) {
      pendingCloudFiles = [...pendingCloudFiles, ...selectedFiles];
      setStatus("Queued offline", `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} will upload when the network returns.`, 0);
      return;
    }

    await uploadCloudFiles(selectedFiles, autoRename);
    return;
  }

  const queuedFiles = selectedFiles.map((file) => localFileRecord(file, autoRename));
  files = [...queuedFiles, ...files];
  saveJson(STORAGE_KEYS.files, files);
  setStatus("Queued", `${queuedFiles.length} file${queuedFiles.length === 1 ? "" : "s"} ready to sync.`, 0);
  simulateTransfers(queuedFiles.map((file) => file.id));
}

async function uploadCloudFiles(selectedFiles, autoRename = settings.autoRename) {
  if (!session) return;
  isBusy = true;

  for (let index = 0; index < selectedFiles.length; index += 1) {
    const file = selectedFiles[index];
    const id = crypto.randomUUID();
    const progressBase = Math.round((index / selectedFiles.length) * 100);

    if (isOffline()) {
      pendingCloudFiles = [...selectedFiles.slice(index), ...pendingCloudFiles];
      isBusy = false;
      setStatus("Queued offline", `${selectedFiles.length - index} file${selectedFiles.length - index === 1 ? "" : "s"} will upload when the network returns.`, progressBase);
      return;
    }

    // Deferred naming: upload with the original name and (when auto-rename is on)
    // flag the row for the desktop's local worker to rename later from content.
    // No naming API is called here, so uploads are instant and cost nothing.
    const filename_ai = file.name;
    const rename_requested = Boolean(autoRename);
    const storage_path = makeStoragePath(session.user.id, id, filename_ai);

    setStatus("Uploading", `${file.name} to Supabase storage.`, progressBase);

    let upload;
    try {
      upload = await withRetry(
        async () => {
          const response = await supabase.storage.from(storageBucket).upload(storage_path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false
          });

          if (response.error) throw response.error;
          return response;
        },
        "Uploading"
      );
    } catch (error) {
      isBusy = false;
      pendingCloudFiles = [file, ...selectedFiles.slice(index + 1), ...pendingCloudFiles];
      setStatus("Upload queued", `${error.message}. The upload will retry when the network returns.`, progressBase);
      return;
    }

    if (upload.error) {
      isBusy = false;
      setStatus("Upload failed", upload.error.message, progressBase);
      return;
    }

    let insert;
    try {
      insert = await withRetry(
        async () => {
          const response = await supabase.from("files").insert({
            id,
            user_id: session.user.id,
            filename_ai,
            filename_original: file.name,
            storage_path,
            mime_type: file.type || "application/octet-stream",
            size: file.size,
            rename_requested,
            uploaded_from: window.syncdrop?.platform ?? "web"
          });

          if (response.error) throw response.error;
          return response;
        },
        "Saving metadata"
      );
    } catch (error) {
      await supabase.storage.from(storageBucket).remove([storage_path]);
      isBusy = false;
      setStatus("Metadata failed", error.message, progressBase);
      return;
    }

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

async function retryPendingCloudFiles() {
  if (!session || isBusy || pendingCloudFiles.length === 0 || isOffline()) return;
  const queued = pendingCloudFiles;
  pendingCloudFiles = [];
  setStatus("Retrying uploads", `${queued.length} queued file${queued.length === 1 ? "" : "s"} ready to upload.`, transferStatus.progress);
  await uploadCloudFiles(queued);
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
    let data;
    try {
      const response = await withRetry(
        async () => {
          const signedUrl = await supabase.storage
            .from(storageBucket)
            .createSignedUrl(file.storage_path, 60, { download: file.filename_ai });
          if (signedUrl.error) throw signedUrl.error;
          return signedUrl;
        },
        "Preparing download"
      );
      data = response.data;
    } catch (error) {
      setStatus("Download failed", error.message, 0);
      return;
    }

    if (window.syncdrop?.saveUrl) {
      setStatus("Choose a location", `Pick where to save ${file.filename_ai}.`, 20);
      try {
        const saved = await window.syncdrop.saveUrl({
          url: data.signedUrl,
          filename: file.filename_ai
        });
        if (saved?.canceled) {
          setStatus("Download cancelled", "No location was chosen.", 0);
        } else {
          setStatus("Downloaded", `${saved.filename} saved to ${saved.path}.`, 100);
        }
      } catch (error) {
        setStatus("Download failed", error.message ?? "Could not save the file.", 0);
      }
      return;
    }

    const link = document.createElement("a");
    link.href = data.signedUrl;
    link.download = file.filename_ai;
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatus("Download ready", `${file.filename_ai} download started.`, 100);
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
          ${window.syncdrop?.openDownloads ? '<button type="button" data-action="open-downloads">Downloads</button>' : ""}
          <button type="button" data-action="sign-out" ${isBusy ? "disabled" : ""}>Sign out</button>
        </div>
      </section>
    `;
  }

  if (otpRequested) {
    return `
      <section class="auth-panel" aria-label="Connection status">
        <div>
          <strong>Enter your code</strong>
          <span>Sent to ${escapeHtml(authEmail)}.</span>
        </div>
        <form id="otp-form" class="auth-form">
          <input name="token" type="text" inputmode="numeric" placeholder="123456" required />
          <button type="submit" ${isBusy ? "disabled" : ""}>Verify</button>
        </form>
        <button type="button" data-action="otp-back" ${isBusy ? "disabled" : ""}>Use a different email</button>
      </section>
    `;
  }

  return `
    <section class="auth-panel" aria-label="Connection status">
      <div>
        <strong>Cloud sync</strong>
        <span>Sign in with an email code.</span>
      </div>
      <form id="auth-form" class="auth-form">
        <input name="email" type="email" placeholder="you@example.com" value="${escapeHtml(authEmail)}" required />
        <button type="submit" ${isBusy ? "disabled" : ""}>Send code</button>
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
        <label class="check-row upload-rename-toggle">
          <input id="rename-toggle" type="checkbox" ${renameNextUpload ? "checked" : ""} />
          <span>AI-rename this upload</span>
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
  const otpForm = document.querySelector("#otp-form");
  const renameToggle = document.querySelector("#rename-toggle");

  renameToggle?.addEventListener("change", (event) => {
    renameNextUpload = event.target.checked;
  });

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
  document.querySelector("[data-action='open-downloads']")?.addEventListener("click", () => {
    window.syncdrop?.openDownloads();
  });

  settingsForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettings(settingsForm);
  });

  authForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    authEmail = authForm.email.value.trim();
    signInWithEmail(authEmail);
  });

  otpForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    verifyOtpCode(authEmail, otpForm.token.value.trim());
  });

  document.querySelector("[data-action='otp-back']")?.addEventListener("click", () => {
    otpRequested = false;
    render();
  });
}

render();
initSupabase();

window.addEventListener("online", retryPendingCloudFiles);
window.addEventListener("offline", () => {
  setStatus("Offline", "Transfers will retry when the network returns.", transferStatus.progress);
});

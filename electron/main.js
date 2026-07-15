import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearSession, writeSession } from "../src/core/session-store.js";
import { getClient } from "../cli/lib/client.js";
import { processPendingRenames } from "../cli/lib/worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

const AUTH_CALLBACK_PORT = 3000;
// How often the background worker looks for files awaiting AI naming.
const RENAME_POLL_MS = 60000;
let mainWindow = null;
let authServer = null;
let renameTimer = null;
let renameRunning = false;

// Loopback server that receives the Supabase email-magic-link redirect.
// Supabase redirects the browser to http://localhost:3000/#access_token=...&refresh_token=...
// The tokens live in the URL hash, which browsers never send to the server, so we first
// serve a tiny shim page that moves the hash into a query string, then capture them.
function startAuthServer() {
  if (authServer) return;

  authServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://localhost:${AUTH_CALLBACK_PORT}`);

    if (requestUrl.pathname === "/token") {
      const accessToken = requestUrl.searchParams.get("access_token");
      const refreshToken = requestUrl.searchParams.get("refresh_token");

      if (accessToken && refreshToken && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("syncdrop:auth-tokens", {
          access_token: accessToken,
          refresh_token: refreshToken
        });
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<!doctype html><meta charset=utf-8><title>SyncDrop AI</title>" +
          "<body style=\"font-family:system-ui;padding:2rem;text-align:center\">" +
          "<h2>You're signed in to SyncDrop AI.</h2>" +
          "<p>You can close this tab and return to the app.</p>"
      );
      return;
    }

    // Initial landing: move the hash tokens into a query the server can read.
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<!doctype html><meta charset=utf-8><title>Signing in…</title>" +
        "<body style=\"font-family:system-ui;padding:2rem;text-align:center\">Completing sign-in…" +
        "<script>location.replace('/token?' + location.hash.slice(1));</script>"
    );
  });

  authServer.on("error", (error) => {
    console.error("Auth callback server failed", error);
  });

  authServer.listen(AUTH_CALLBACK_PORT, "127.0.0.1");
}

// Background deferred-naming worker. While the app is open it periodically names
// any files flagged rename_requested (including uploads from the phone) using
// the local vision model, reusing the same session the CLI does. Silently no-ops
// when not signed in or when the local model / Ollama isn't reachable — those
// files simply keep their flag and get retried on the next tick.
async function runRenamePass() {
  if (renameRunning) return;
  renameRunning = true;
  try {
    const { supabase, bucket } = await getClient();
    const summary = await processPendingRenames({ supabase, bucket, limit: 25 });
    if (summary.named > 0 && mainWindow && !mainWindow.isDestroyed()) {
      // Nudge the renderer to refresh its file list so new names show up.
      mainWindow.webContents.send("syncdrop:files-renamed", summary);
    }
  } catch {
    // Not signed in, Ollama down, or offline — try again next tick.
  } finally {
    renameRunning = false;
  }
}

function startRenameWorker() {
  if (renameTimer) return;
  renameTimer = setInterval(runRenamePass, RENAME_POLL_MS);
  runRenamePass(); // don't wait a full interval for the first pass
}

function sanitizeFilename(filename) {
  return path
    .basename(filename || "syncdrop-download")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "syncdrop-download";
}

function uniqueDownloadPath(filename) {
  const downloadsPath = app.getPath("downloads");
  const parsed = path.parse(sanitizeFilename(filename));
  let candidate = path.join(downloadsPath, `${parsed.name}${parsed.ext}`);
  let index = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(downloadsPath, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }

  return candidate;
}

function downloadToFile(url, destination, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;

    const request = client.get(parsedUrl, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        if (!response.headers.location || redirectCount >= 3) {
          reject(new Error("Download redirect failed"));
          return;
        }

        resolve(downloadToFile(new URL(response.headers.location, parsedUrl).toString(), destination, redirectCount + 1));
        return;
      }

      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.resume();
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      pipeline(response, fs.createWriteStream(destination)).then(resolve, reject);
    });

    request.on("error", reject);
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: "SyncDrop AI",
    icon: path.join(__dirname, "../build/icon.ico"),
    // Paint an opaque background and defer showing until the renderer is ready.
    // Without this the window can present before first paint and stay blank.
    show: false,
    backgroundColor: "#eef2f6",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (isDev) {
    window.loadURL("http://localhost:5173");
  } else {
    window.loadFile(path.join(__dirname, "..", "dist-app", "index.html"));
  }
}

// Prevent a second instance from spawning a duplicate (blank) window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  startAuthServer();

  ipcMain.handle("syncdrop:open-downloads", async () => {
    await shell.openPath(app.getPath("downloads"));
  });

  // App-only auth bridge: the renderer forwards its Supabase session here so the
  // syncdrop CLI can reuse it. The CLI never logs in on its own.
  ipcMain.handle("syncdrop:persist-session", async (_event, payload) => {
    if (!payload?.access_token || !payload?.refresh_token) {
      clearSession();
      return { cleared: true };
    }
    writeSession(payload);
    // A fresh sign-in may have a backlog waiting (e.g. phone uploads) — drain it
    // now rather than waiting for the next poll tick.
    runRenamePass();
    return { cleared: false };
  });

  ipcMain.handle("syncdrop:clear-session", async () => {
    clearSession();
    return { cleared: true };
  });

  ipcMain.handle("syncdrop:save-url", async (event, payload) => {
    const url = new URL(String(payload?.url ?? ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Only HTTP downloads are supported");
    }

    // Let the user choose where to save the file.
    const suggestedName = sanitizeFilename(payload?.filename);
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const result = await dialog.showSaveDialog(parentWindow, {
      title: "Save file",
      defaultPath: path.join(app.getPath("downloads"), suggestedName)
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const destination = result.filePath;
    await downloadToFile(url.toString(), destination);
    return {
      canceled: false,
      path: destination,
      filename: path.basename(destination)
    };
  });

  createWindow();
  startRenameWorker();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("will-quit", () => {
  if (authServer) {
    authServer.close();
    authServer = null;
  }
  if (renameTimer) {
    clearInterval(renameTimer);
    renameTimer = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

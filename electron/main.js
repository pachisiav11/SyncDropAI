import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    window.loadURL("http://localhost:5173");
  } else {
    window.loadFile(path.join(__dirname, "..", "dist-app", "index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("syncdrop:open-downloads", async () => {
    await shell.openPath(app.getPath("downloads"));
  });

  ipcMain.handle("syncdrop:save-url", async (_event, payload) => {
    const url = new URL(String(payload?.url ?? ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Only HTTP downloads are supported");
    }

    const destination = uniqueDownloadPath(payload?.filename);
    await downloadToFile(url.toString(), destination);
    return {
      path: destination,
      filename: path.basename(destination)
    };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

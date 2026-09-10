// The same local vision model the desktop app uses, reached the same way.
//
// The CLI is a device like any other, so it names files with the model that
// ships with SyncDrop rather than asking anyone to install a second one. The
// server is started on first use and killed when the command exits: a CLI run
// is short, and leaving a process holding 1.7 GB behind it would be rude.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

// Kept the same as REPO, MODEL_FILE and MMPROJ_FILE on the Rust side. Both
// download into the one directory below, so whichever of the two fetches the
// weights first, the other finds them already there.
const REPO = "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/main";
const MODEL_FILE = "MiniCPM-V-4_6-Q6_K.gguf";
const MMPROJ_FILE = "mmproj-model-f16.gguf";
const STARTUP_TIMEOUT_MS = 180000;
const REQUEST_TIMEOUT_MS = 180000;

function binaryName() {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

export function serverBinary() {
  const fromEnv = process.env.SYNCDROP_LLAMA_SERVER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const vendored = path.join(ROOT, "vendor", "llama.cpp", binaryName());
  return fs.existsSync(vendored) ? vendored : null;
}

// Matches `model_dir()` on the Rust side, so the desktop app and the CLI share
// one copy of the weights rather than each downloading their own.
export function modelDir() {
  if (process.env.SYNCDROP_MODEL_DIR) return process.env.SYNCDROP_MODEL_DIR;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA
      : process.env.XDG_DATA_HOME || path.join(process.env.HOME ?? ".", ".local", "share");
  return path.join(base ?? ".", "SyncDrop", "models");
}

export function modelsPresent() {
  return (
    fs.existsSync(path.join(modelDir(), MODEL_FILE)) &&
    fs.existsSync(path.join(modelDir(), MMPROJ_FILE))
  );
}

export function namerReady() {
  return Boolean(serverBinary()) && modelsPresent();
}

async function contentLength(name) {
  const response = await fetch(`${REPO}/${name}`, {
    method: "HEAD",
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`Cannot reach Hugging Face for ${name}: ${response.status}`);
  }
  const size = Number(response.headers.get("content-length"));
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Hugging Face did not say how large ${name} is`);
  }
  return size;
}

async function downloadOne(name, target, size, onChunk) {
  // Written beside the target and renamed at the end, so an interrupted
  // download can never be mistaken for a usable model.
  const part = `${target}.part`;
  const response = await fetch(`${REPO}/${name}`);
  if (!response.ok) throw new Error(`Cannot download ${name}: ${response.status}`);

  let written = 0;
  await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
    for await (const chunk of chunks) {
      written += chunk.length;
      onChunk(chunk.length);
      yield chunk;
    }
  }, fs.createWriteStream(part));

  if (written !== size) {
    fs.rmSync(part, { force: true });
    throw new Error(`${name} arrived incomplete (${written} of ${size} bytes)`);
  }
  fs.renameSync(part, target);
}

/// Download whichever weights are absent, reporting bytes as they land.
export async function fetchModels(onProgress = () => {}) {
  const dir = modelDir();
  fs.mkdirSync(dir, { recursive: true });

  const missing = [MODEL_FILE, MMPROJ_FILE]
    .map((name) => ({ name, target: path.join(dir, name) }))
    .filter((file) => !fs.existsSync(file.target));
  if (missing.length === 0) return dir;

  // Both sizes are needed before the first byte, or the count jumps when the
  // second file starts.
  let total = 0;
  for (const file of missing) {
    file.size = await contentLength(file.name);
    total += file.size;
  }

  let done = 0;
  onProgress(0, total);
  for (const file of missing) {
    await downloadOne(file.name, file.target, file.size, (bytes) => {
      done += bytes;
      onProgress(done, total);
    });
  }
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) return;
    } catch {
      // Not up yet. The loop below is the whole retry policy.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The model server did not come up in time");
}

let server = null;

async function ensureServer() {
  if (server) return server;

  const binary = serverBinary();
  if (!binary) throw new Error("llama-server is not in this checkout");
  if (!modelsPresent()) {
    throw new Error(`The naming model is not in ${modelDir()}`);
  }

  const port = await freePort();
  const child = spawn(
    binary,
    [
      "--model", path.join(modelDir(), MODEL_FILE),
      "--mmproj", path.join(modelDir(), MMPROJ_FILE),
      "--port", String(port),
      "--host", "127.0.0.1",
      "--ctx-size", "4096",
      "--jinja",
      "--no-webui"
    ],
    { stdio: "ignore", windowsHide: true }
  );

  child.unref();
  const stop = () => {
    if (!child.killed) child.kill();
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });

  try {
    await waitForHealth(port);
  } catch (error) {
    stop();
    throw error;
  }

  server = { port, stop };
  return server;
}

/// Ask the model to describe something. `image` is base64 JPEG, or null for a
/// text-only prompt.
export async function describe({ prompt, image = null }) {
  const { port } = await ensureServer();

  const content = image
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }
      ]
    : prompt;

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      messages: [{ role: "user", content }],
      temperature: 0.1,
      max_tokens: 40,
      stream: false,
      // Without this the reasoning backbone spends the whole budget thinking
      // and answers with an empty string.
      chat_template_kwargs: { enable_thinking: false }
    })
  });

  if (!res.ok) throw new Error(`The model returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

export function stopServer() {
  server?.stop();
  server = null;
}

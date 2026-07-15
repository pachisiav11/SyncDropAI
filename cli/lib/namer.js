// Local, zero-cost filename suggestion using a vision model served by Ollama
// (default: MiniCPM-V 4.6). Node/Electron only — never imported by the browser
// app, which can't reach a local model. The pure kebab/validation helpers still
// come from src/core/filenames.js so names match what the rest of the app makes.
//
// Design notes learned from benchmarking on CPU-only hardware (Iris Xe):
//   * `think: false` is MANDATORY. MiniCPM-V 4.6's backbone is a reasoning model
//     and without this it emits its chain-of-thought instead of an answer.
//   * Describe-then-format beats asking the model to format. We ask for a plain
//     3-6 word description and kebab-case it ourselves; asking the model for a
//     "kebab-case filename" sends it into a formatting reasoning spiral.
//   * Input resolution drives latency (the vision encoder tiles the image), so
//     we downscale to a modest edge before sending.

import { Jimp } from "jimp";
import { cleanFilename, getExtension, isValidAiFilename } from "../../src/core/filenames.js";

const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.SYNCDROP_NAMER_MODEL || "minicpm-v4.6";
const MAX_EDGE = Number(process.env.SYNCDROP_NAMER_MAX_EDGE || 512);
const TIMEOUT_MS = Number(process.env.SYNCDROP_NAMER_TIMEOUT_MS || 120000);
const PDF_TEXT_CHARS = 1200;

const IMAGE_PROMPT =
  "Name this image as a file: reply with a specific 3-6 word description of its " +
  "content. Include any app, brand, product, or document name you can read. " +
  "Description only, no punctuation, no extra text.";
const TEXT_PROMPT =
  "Below is the beginning of a document. In 3 to 6 words, describe what it is so " +
  "it can be named as a file. Description only, no extra text.\n\n";

// Ask Ollama to generate, with reasoning disabled and a short output cap.
async function ollamaDescribe({ prompt, images }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        prompt,
        images: images ?? [],
        think: false,
        stream: false,
        options: { temperature: 0.1, num_predict: 40 }
      })
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return String(data.response ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

// Downscale so the vision encoder sees fewer tiles, then hand back base64 JPEG.
async function toModelImage(buffer) {
  const image = await Jimp.read(buffer);
  if (Math.max(image.width, image.height) > MAX_EDGE) {
    image.scaleToFit({ w: MAX_EDGE, h: MAX_EDGE });
  }
  const jpeg = await image.getBuffer("image/jpeg", { quality: 82 });
  return jpeg.toString("base64");
}

// First page(s) of a PDF's text layer. Empty string for scanned/imageless PDFs
// (those fall through to keep-original — v1 does not rasterize).
async function extractPdfText(buffer) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false
  });
  const doc = await task.promise;
  let text = "";
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 3) && text.length < PDF_TEXT_CHARS; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      text += content.items.map((i) => i.str).join(" ") + "\n";
    }
  } finally {
    await task.destroy();
  }
  return text.replace(/\s+/g, " ").trim().slice(0, PDF_TEXT_CHARS);
}

// Turn a free-text description into a validated <base>-<words><ext> filename, or
// null if the model gave us nothing usable (caller then keeps the original).
function descriptionToFilename(description, originalFilename) {
  const cleaned = String(description ?? "")
    .split("\n")[0]
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!cleaned) return null;

  const extension = getExtension(originalFilename);
  // cleanFilename lowercases, hyphenates, trims to 54 chars, and re-attaches an
  // extension if the string carries one — feed it the description + real ext.
  const candidate = cleanFilename(`${cleaned}${extension}`);
  if (!isValidAiFilename(candidate, extension)) return null;
  // Reject the degenerate "untitled-file" cleanFilename emits for empty input.
  if (candidate.startsWith("untitled-file")) return null;
  return candidate;
}

// Route a file's bytes to the right describer and return a suggested filename,
// or null when the content can't be identified (→ keep the original name).
export async function suggestNameFromContent({ buffer, mimeType, originalFilename }) {
  const mime = String(mimeType || "").toLowerCase();
  let description = null;

  if (mime.startsWith("image/")) {
    const image = await toModelImage(buffer);
    description = await ollamaDescribe({ prompt: IMAGE_PROMPT, images: [image] });
  } else if (mime === "application/pdf") {
    const text = await extractPdfText(buffer);
    if (!text) return null; // scanned/imageless PDF — no text layer to read
    description = await ollamaDescribe({ prompt: TEXT_PROMPT + text });
  } else if (mime.startsWith("text/") || mime === "application/json") {
    const text = buffer.toString("utf8").replace(/\s+/g, " ").trim().slice(0, PDF_TEXT_CHARS);
    if (!text) return null;
    description = await ollamaDescribe({ prompt: TEXT_PROMPT + text });
  } else {
    return null; // unsupported type — keep original
  }

  return descriptionToFilename(description, originalFilename);
}

export const namerConfig = { OLLAMA_HOST, MODEL, MAX_EDGE };

// The deferred-naming worker. Claims files flagged `rename_requested`, generates
// a name from their content with the local vision model, writes it back, and
// clears the flag. Shared by the `syncdrop autoname` CLI command and the
// Electron app's background poll — both just call processPendingRenames().
//
// Naming never moves bytes: like the app's manual rename, it only updates
// filename_ai and leaves storage_path (which carries a cleaned copy of the name
// baked in at upload time) untouched.

import { getExtension, isValidAiFilename } from "../../src/core/filenames.js";
import { CliError } from "./client.js";
import { suggestNameFromContent } from "./namer.js";

const PENDING_COLUMNS =
  "id, filename_ai, filename_original, storage_path, mime_type, size, rename_requested";

// Fetch rows awaiting naming, oldest first so a backlog drains in upload order.
async function fetchPending({ supabase, limit }) {
  let query = supabase
    .from("files")
    .select(PENDING_COLUMNS)
    .eq("rename_requested", true)
    .order("created_at", { ascending: true });
  if (limit != null) query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw new CliError(error.message);
  return data ?? [];
}

// Clear the flag without renaming — used when the content can't be identified
// (unsupported type, scanned PDF, model gave nothing). The file simply keeps
// its original name instead of getting a UUID or an invented one.
async function clearFlag({ supabase, id, filename_ai }) {
  const { error } = await supabase
    .from("files")
    .update({ rename_requested: false, filename_ai })
    .eq("id", id);
  if (error) throw new CliError(`Could not clear rename flag for ${id}: ${error.message}`);
}

async function applyName({ supabase, id, filename_ai }) {
  const { error } = await supabase
    .from("files")
    .update({ rename_requested: false, filename_ai })
    .eq("id", id);
  if (error) throw new CliError(`Could not save name for ${id}: ${error.message}`);
}

// Process every pending file once. `onProgress` (optional) is called per file
// with { original, result, name } so callers can log. Returns tallies.
export async function processPendingRenames({ supabase, bucket, limit = 25, onProgress } = {}) {
  const pending = await fetchPending({ supabase, limit });
  const summary = { total: pending.length, named: 0, kept: 0, failed: 0 };

  for (const file of pending) {
    try {
      const download = await supabase.storage.from(bucket).download(file.storage_path);
      if (download.error) throw new Error(download.error.message);
      const buffer = Buffer.from(await download.data.arrayBuffer());

      const suggestion = await suggestNameFromContent({
        buffer,
        mimeType: file.mime_type,
        originalFilename: file.filename_original
      });

      // Only rename when we got a valid, content-derived name that differs from
      // what's already there; otherwise keep the current name and drop the flag.
      const extension = getExtension(file.filename_original);
      if (suggestion && isValidAiFilename(suggestion, extension) && suggestion !== file.filename_ai) {
        await applyName({ supabase, id: file.id, filename_ai: suggestion });
        summary.named++;
        onProgress?.({ original: file.filename_original, result: "named", name: suggestion });
      } else {
        await clearFlag({ supabase, id: file.id, filename_ai: file.filename_ai });
        summary.kept++;
        onProgress?.({ original: file.filename_original, result: "kept", name: file.filename_ai });
      }
    } catch (error) {
      // Leave the flag set so a later pass retries this file, but don't let one
      // bad file stop the batch.
      summary.failed++;
      onProgress?.({ original: file.filename_original, result: "failed", name: error.message });
    }
  }

  return summary;
}

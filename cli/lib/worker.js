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

// Take ownership of candidate rows before doing any work. Selecting pending rows
// is not enough: `syncdrop autoname` and the desktop app's poll run as separate
// processes against the same table, so without this both see the same row and
// both spend ~15s of CPU naming it, with the later write silently winning.
//
// Clearing the flag IS the claim, and `.eq("rename_requested", true)` makes it
// atomic — Postgres serializes the concurrent UPDATEs, so exactly one worker
// matches and the loser gets back zero rows. Only rows returned here are ours.
// Failures re-queue via requeue() below; a hard crash mid-pass leaves the file
// with its original name and no retry, which is the same outcome as an
// unidentifiable file, so no lease/timeout column is needed.
async function claimPending({ supabase, candidates }) {
  if (candidates.length === 0) return [];
  const { data, error } = await supabase
    .from("files")
    .update({ rename_requested: false })
    .in("id", candidates.map((file) => file.id))
    .eq("rename_requested", true)
    .select(PENDING_COLUMNS);
  if (error) throw new CliError(`Could not claim files for naming: ${error.message}`);
  return data ?? [];
}

// Hand a file back so a later pass retries it.
async function requeue({ supabase, id }) {
  await supabase.from("files").update({ rename_requested: true }).eq("id", id);
}

// The claim already cleared rename_requested, so this only writes the name.
async function applyName({ supabase, id, filename_ai }) {
  const { error } = await supabase.from("files").update({ filename_ai }).eq("id", id);
  if (error) throw new CliError(`Could not save name for ${id}: ${error.message}`);
}

// Process every pending file once. `onProgress` (optional) is called per file
// with { original, result, name } so callers can log. Returns tallies.
export async function processPendingRenames({ supabase, bucket, limit = 25, onProgress } = {}) {
  const candidates = await fetchPending({ supabase, limit });
  // Rows another worker got to first are dropped here, so we never duplicate its
  // inference — hence total reflects what we actually own, not what we saw.
  const pending = await claimPending({ supabase, candidates });
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
        // Unidentifiable: keep the current name. The claim already dropped the
        // flag, so there's nothing to write.
        summary.kept++;
        onProgress?.({ original: file.filename_original, result: "kept", name: file.filename_ai });
      }
    } catch (error) {
      // Hand the file back so a later pass retries it, but don't let one bad
      // file stop the batch.
      await requeue({ supabase, id: file.id });
      summary.failed++;
      onProgress?.({ original: file.filename_original, result: "failed", name: error.message });
    }
  }

  return summary;
}

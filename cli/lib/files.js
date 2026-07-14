// Supabase file operations for the CLI.
//
// These MIRROR the browser app's logic in src/app.js (loadCloudFiles,
// uploadCloudFiles, suggestCloudFilename, removeFile, downloadFile). The app is
// tightly coupled to the DOM / browser File objects, so its data calls are not
// importable here; this is a deliberate, minimal re-implementation. If you
// change the storage/metadata contract in one place, update the other.

import fs from "node:fs";
import path from "node:path";
import {
  fallbackUuidFilename,
  getExtension,
  isValidAiFilename,
  makeStoragePath
} from "../../src/core/filenames.js";
import { CliError } from "./client.js";
import { guessMimeType, looksLikeUuid } from "./util.js";

const SELECT_COLUMNS =
  "id, filename_ai, filename_original, storage_path, mime_type, size, uploaded_from, created_at";

export async function listFiles({ supabase, since, limit, search }) {
  let query = supabase.from("files").select(SELECT_COLUMNS).order("created_at", { ascending: false });

  if (since) query = query.gte("created_at", since.toISOString());
  if (search) query = query.ilike("filename_ai", `%${search}%`);
  if (limit != null) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw new CliError(error.message);
  return data ?? [];
}

// Resolve a file by UUID id or by (AI, then original) filename. Errors on no
// match or an ambiguous name match.
export async function resolveFile({ supabase, identifier }) {
  const value = String(identifier ?? "").trim();
  if (!value) throw new CliError("Provide a file name or id.");

  if (looksLikeUuid(value)) {
    const { data, error } = await supabase.from("files").select(SELECT_COLUMNS).eq("id", value).maybeSingle();
    if (error) throw new CliError(error.message);
    if (!data) throw new CliError(`No file found with id ${value}.`);
    return data;
  }

  const { data, error } = await supabase
    .from("files")
    .select(SELECT_COLUMNS)
    .or(`filename_ai.eq.${value},filename_original.eq.${value}`);
  if (error) throw new CliError(error.message);

  if (!data || data.length === 0) throw new CliError(`No file found named "${value}".`);
  if (data.length > 1) {
    const ids = data.map((f) => `  ${f.id}  ${f.filename_ai}`).join("\n");
    throw new CliError(`"${value}" matches ${data.length} files — use the id instead:\n${ids}`);
  }
  return data[0];
}

// Mirrors src/app.js suggestCloudFilename: ask the edge function, validate,
// fall back to a UUID-based name (or the original name when renaming is off).
export async function suggestFilename({ supabase, autoRename, originalFilename, mimeType, id }) {
  const fallback = autoRename ? fallbackUuidFilename(id, originalFilename) : originalFilename;
  if (!autoRename) return fallback;

  let result;
  try {
    result = await supabase.functions.invoke("suggest-filename", {
      body: { originalFilename, mimeType: mimeType || "application/octet-stream" }
    });
    if (result.error) throw result.error;
  } catch {
    return fallback;
  }

  const suggestion = String(result.data?.filename ?? "").trim();
  return isValidAiFilename(suggestion, getExtension(originalFilename)) ? suggestion : fallback;
}

export async function uploadFile({ supabase, bucket, userId, filePath, noRename }) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new CliError(`File not found: ${filePath}`);
  }

  const originalFilename = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  const mimeType = guessMimeType(originalFilename);
  const id = crypto.randomUUID();

  const filename_ai = await suggestFilename({
    supabase,
    autoRename: !noRename,
    originalFilename,
    mimeType,
    id
  });
  const storage_path = makeStoragePath(userId, id, filename_ai);

  const upload = await supabase.storage
    .from(bucket)
    .upload(storage_path, buffer, { contentType: mimeType, upsert: false });
  if (upload.error) throw new CliError(`Upload failed: ${upload.error.message}`);

  const insert = await supabase.from("files").insert({
    id,
    user_id: userId,
    filename_ai,
    filename_original: originalFilename,
    storage_path,
    mime_type: mimeType,
    size: buffer.length,
    uploaded_from: "windows"
  });

  if (insert.error) {
    // Roll back the orphaned storage object, same as the app does.
    await supabase.storage.from(bucket).remove([storage_path]);
    throw new CliError(`Saving metadata failed: ${insert.error.message}`);
  }

  return { id, filename_ai, filename_original: originalFilename, size: buffer.length, storage_path };
}

export async function getSignedUrl({ supabase, bucket, file }) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(file.storage_path, 60, { download: file.filename_ai });
  if (error) throw new CliError(`Could not create download link: ${error.message}`);
  return data.signedUrl;
}

export async function deleteFile({ supabase, bucket, file }) {
  const removeStorage = await supabase.storage.from(bucket).remove([file.storage_path]);
  if (removeStorage.error) throw new CliError(`Delete failed: ${removeStorage.error.message}`);

  const removeMetadata = await supabase.from("files").delete().eq("id", file.id);
  if (removeMetadata.error) throw new CliError(`Metadata delete failed: ${removeMetadata.error.message}`);
}

export async function renameFile({ supabase, file, newName }) {
  const name = String(newName ?? "").trim();
  if (!name) throw new CliError("Provide a new name.");

  const { data, error } = await supabase
    .from("files")
    .update({ filename_ai: name })
    .eq("id", file.id)
    .select(SELECT_COLUMNS)
    .maybeSingle();

  if (error) throw new CliError(`Rename failed: ${error.message}`);
  if (!data) {
    throw new CliError(
      "Rename affected no rows. If your database predates the rename feature, apply " +
        "supabase/migrations/0001_files_update_policy.sql."
    );
  }
  return data;
}

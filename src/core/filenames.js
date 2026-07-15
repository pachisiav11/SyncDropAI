// Pure filename / storage-path helpers shared by the browser app (src/app.js)
// and the syncdrop CLI (cli/index.js). No DOM, Node, or Supabase dependencies —
// keep it that way so both runtimes can import it unchanged.

export function cleanFilename(filename) {
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

export function getExtension(filename) {
  return filename.match(/(\.[A-Za-z0-9]{1,12})$/)?.[1]?.toLowerCase() ?? "";
}

export function isValidAiFilename(value, extension) {
  if (!value || value.length > 80) return false;
  if (extension && !value.endsWith(extension)) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*(\.[a-z0-9]{1,12})?$/.test(value);
}

export function makeStoragePath(userId, id, filename) {
  return `${userId}/${id}-${cleanFilename(filename)}`;
}

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

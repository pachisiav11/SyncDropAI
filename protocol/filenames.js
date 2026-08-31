// Filename shaping, shared by every namer so a name produced on the desktop
// looks like a name produced by the CLI. Pure string work: no DOM, no Node.

export function getExtension(filename) {
  return String(filename ?? "").match(/(\.[A-Za-z0-9]{1,12})$/)?.[1]?.toLowerCase() ?? "";
}

export function cleanFilename(filename) {
  const extension = getExtension(filename);
  const base = String(filename ?? "")
    .replace(/(\.[A-Za-z0-9]{1,12})$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 54)
    .replace(/^-+|-+$/g, "");

  return `${base || "untitled-file"}${extension}`;
}

export function isValidAiFilename(value, extension) {
  if (!value || value.length > 80) return false;
  if (extension && !value.endsWith(extension)) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*(\.[a-z0-9]{1,12})?$/.test(value);
}

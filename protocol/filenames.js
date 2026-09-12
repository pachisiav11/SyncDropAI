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

// A description says what is inside a file, so two files holding nearly the
// same thing come back with nearly the same name and the counter that told them
// apart is gone: tally-1.txt, tally-2.txt and tally-3.txt were named twice with
// the number and once without it, and the third no longer said which file it
// was. Carry a trailing counter or version across, unless the description
// already accounts for it. Three digits at most, so that a timestamp or a
// camera index is never mistaken for a counter.
export function keepTrailingIndex(candidate, originalFilename) {
  const marker = String(originalFilename ?? "")
    .replace(/(\.[A-Za-z0-9]{1,12})$/, "")
    .match(/[-_ ]([vV]?\d{1,3})$/)?.[1]
    ?.toLowerCase();
  if (!marker) return candidate;

  const extension = getExtension(candidate);
  const base = candidate.slice(0, candidate.length - extension.length);
  if (base.split("-").includes(marker)) return candidate;

  // Appended after the trim rather than before it, or a long description would
  // push the counter straight back off the end.
  const room = 54 - marker.length - 1;
  return `${base.slice(0, room).replace(/-+$/, "")}-${marker}${extension}`;
}

# SyncDrop AI CLI — Implementation Instructions

## Goal

Add a `syncdrop` CLI to this project for file operations against the same
Supabase project the Electron/Android app uses. This is an instruction file
for implementing the CLI — not a design doc to leave unfinished, build it.

## Scope decisions (already made, do not re-litigate)

- **Auth: app-only.** The CLI does NOT implement its own login/logout/OTP
  flow. It reads whatever session/credentials the desktop app already wrote
  to local storage (or a shared config location — figure out where the
  Electron app persists its Supabase session and reuse that; if nothing
  reusable exists, that's a prerequisite to flag back, not a reason to build
  a parallel auth flow).
- **No sync/automation.** No `watch`, no daemon, no background retry queue.
  Every command is a single one-shot invocation.
- **File ops: all of them.** upload, list, download, delete, rename, info.
- **Keep it simple**: no new backend endpoints — CLI talks to Supabase
  Storage/DB directly via `@supabase/supabase-js`, same as the web client.

## Commands to implement

### `syncdrop upload <path>`
- Uploads a file (by filename in cwd, or a full/relative path) to the same
  Supabase Storage bucket + `public.files` metadata table the app uses.
- `--no-rename` flag: skip AI naming for this upload and keep the original
  filename permanently (mirrors the app-side setting described below).
- Without `--no-rename`, naming is DEFERRED: the file uploads with its original
  name and the row is flagged `rename_requested`. A local worker on the desktop
  (`syncdrop autoname`, or the app's background poll) later names it from its
  content with a local vision model. Uploads never call a naming API.

### `syncdrop autoname`
- Names files awaiting AI rename, reading their content with a local vision
  model served by Ollama (default `minicpm-v4.6`). Zero API cost.
- `--limit <n>`: max files to name in one pass (default 25).
- Files whose content can't be identified (unsupported type, scanned PDF, model
  returned nothing) simply keep their original name — never a UUID.

### `syncdrop list`
- Lists files from `public.files` metadata table.
- Optional time-window filter, e.g. `--since 5h`, `--since 30m`, `--since 28d`.
  Without a time filter, support a plain count limit, e.g. `syncdrop list 5`
  or `--limit 5`.
- `--json` flag: print raw JSON instead of a human-readable table, for
  piping into scripts (e.g. `syncdrop list --json | jq '.[].name'`).
- `--search <query>` flag: filter by filename substring.

### `syncdrop download <name|id>`
- Resolves a signed download URL (same mechanism as the Electron preload
  bridge in `electron/main.js` / `electron/preload.cjs`) and saves the file
  locally.
- `--out <path>` to control the destination; default to cwd.

### `syncdrop delete <name|id>`
- Deletes the file from Storage and its metadata row.
- Prompt for confirmation unless `--yes` is passed.

### `syncdrop rename <name|id> <new-name>`
- Manual rename override — updates `filename_ai` (or equivalent metadata
  field) without re-invoking the AI naming function.

### `syncdrop info <name|id>`
- Shows metadata for a single file: original filename, AI-generated
  filename, size, upload timestamp, and any other columns already in
  `supabase/schema.sql`.
- Supports `--json` too.

### `syncdrop --version`
- Prints CLI version from `package.json`.

### `syncdrop --help` / `syncdrop help`
- Standard help output listing all commands and flags above.

## Companion app change (do this too, not CLI-only)

The app already has a global `autoRename` setting (checkbox in settings,
`src/app.js` ~line 721) that disables AI renaming for all uploads. Add a
**per-upload** override in the upload flow itself (not just buried in
settings) — e.g. a checkbox/toggle next to the file picker/drop area that
skips AI rename for that specific upload, mirroring the CLI's per-command
`--no-rename` flag. The existing global setting should remain as the
default; the per-upload toggle overrides it for that one upload only.

## Suggested implementation notes

- New CLI entry point, e.g. `cli/index.js`, using a lightweight arg parser
  (`commander` is already idiomatic for this kind of thing — add as a
  dependency).
- `src/app.js` currently couples Supabase calls directly to DOM/browser
  APIs (File objects, localStorage, fetch progress events) — do not import
  it directly into the CLI. Extract the shared bits (Supabase client setup,
  upload/list/download/delete/rename calls, filename-suggestion logic) into
  a module both the browser app and the CLI can import, OR duplicate the
  minimal Supabase calls in the CLI if extraction is too invasive — use
  judgment, but don't leave two silently-diverging copies of the same logic
  without a comment noting the duplication.
- Add a `bin` field to `package.json` and a `syncdrop` script entry so the
  CLI can be installed/linked (`npm link` or similar) for local testing.

# SyncDrop AI

SyncDrop AI is a cross-platform file transfer app for Windows and Android. It uses a shared HTML/CSS/JavaScript frontend, Electron for Windows, Capacitor for Android, Supabase for auth/storage/metadata, and a local vision model that names uploaded files from their content.

## Phase Plan

1. **Foundation**: project skeleton, shared frontend shell, Electron entry, Capacitor config, Supabase schema, AI naming function stub, docs.
2. **Local UI MVP**: upload area, file list, settings storage, progress states, mocked transfer flow.
3. **Supabase Integration**: auth, file metadata table, storage upload/list/delete/download, RLS policies.
4. **AI Rename Integration**: name files from their content with a local vision model, validate filename output, fall back to the original filename.
5. **Electron Packaging**: Windows download path behavior, preload bridge, installer build.
6. **Android Packaging**: Capacitor Android project, Android permissions, APK build docs.
7. **Hardening**: resumable/chunked large-file uploads, offline retry, local metadata cache, production deployment notes.

Each phase should be committed and pushed before the next phase starts. The push message/checkpoint should include what is done, what remains, and any issues.

## Development

```powershell
npm install
npm run dev
npm run electron
```

## Command-line interface (`syncdrop`)

`syncdrop` is a CLI for one-shot file operations against the same Supabase
project the desktop/mobile app uses. It does **not** have its own login: sign in
through the SyncDrop AI desktop app once, and the app writes its session to
`~/.syncdrop/session.json`, which the CLI reuses. Uploads that rename are named
locally by `syncdrop autoname`, the same worker the desktop app runs.

### Install

Run this once in PowerShell — it works from any folder afterward, in both
PowerShell and cmd, with no npm commands needed from you:

```powershell
iwr https://raw.githubusercontent.com/pachisiav11/SyncDropAI/main/install.ps1 -UseB | iex
```

The installer clones/updates the repo under `%LOCALAPPDATA%\Programs\syncdrop`,
installs the CLI's runtime dependencies, and adds a `syncdrop` command shim to
your user PATH. Open a new terminal (or reuse the current one) and run
`syncdrop help`. Re-run the same line anytime to update. To remove it:

```powershell
iwr https://raw.githubusercontent.com/pachisiav11/SyncDropAI/main/uninstall.ps1 -UseB | iex
```

Requires Git and Node.js (18+) on PATH. For local development from a repo
checkout instead, `npm install` then `npm link`, or `npm run syncdrop -- <command>`.

> `rename` needs the UPDATE policy from `supabase/migrations/0001_files_update_policy.sql`.
> Apply it once if your database predates the rename feature.

### Commands

| Command | Description |
| --- | --- |
| `syncdrop upload <path> [--no-rename]` | Upload a file. `--no-rename` keeps the original filename (skips AI rename for that upload). |
| `syncdrop list [count] [--since <w>] [--limit <n>] [--search <q>] [--json]` | List cloud files. `--since` accepts windows like `30m`, `5h`, `28d`, `2w`. |
| `syncdrop download <name\|id> [--out <path>]` | Download a file. `--out` sets a destination file or directory (default: current directory). |
| `syncdrop delete <name\|id> [--yes]` | Delete storage object + metadata. Prompts unless `--yes`. |
| `syncdrop rename <name\|id> <new-name>` | Manually set a file's display name (no AI re-naming). |
| `syncdrop info <name\|id> [--json]` | Show metadata for one file. |
| `syncdrop --version` | Print the CLI version. |
| `syncdrop help` / `syncdrop` | List all commands and flags. |

Files can be referenced by their AI/original filename or by their UUID id
(shown in `list`/`info`).

### Examples

```powershell
syncdrop upload ./report.pdf
syncdrop upload ./raw.png --no-rename
syncdrop list 5
syncdrop list --since 24h --search invoice
syncdrop list --json | jq '.[].filename_ai'
syncdrop download report.pdf --out ~/Downloads
syncdrop rename <id> quarterly-report.pdf
syncdrop delete report.pdf --yes
```

## Android

```powershell
npm run cap:add:android
npm run cap:sync
npm run cap:open:android
```

From Android Studio, build the APK. For command-line debug builds:

```powershell
cd android
.\gradlew assembleDebug
```

The Android Gradle plugin requires Java 17 or newer and a configured Android SDK. If the command-line build cannot find them, set `JAVA_HOME` to Android Studio's bundled JBR and set `ANDROID_HOME`, or create an untracked `android/local.properties` file with `sdk.dir=C:\\Users\\<you>\\AppData\\Local\\Android\\Sdk`.

## Configuration

Create `.env` from `.env.example`.

The browser client reads these Vite-exposed values:

```powershell
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_SUPABASE_BUCKET=files
```

Naming runs on a local model, so no AI API key is needed for normal use. The `suggest-filename` Edge Function remains deployed as an optional fallback; if you wire it back up, keep its Anthropic key in a Supabase Edge Function secret (`supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`) and call the function from the client. Never ship AI API keys inside Electron or Android builds.

## Supabase

The schema and RLS policy examples are in `supabase/schema.sql`. Create a private storage bucket named `files` and enable Row Level Security. Existing databases need the migrations in `supabase/migrations/` applied (0001 allows renames, 0002 adds the `rename_requested` flag the naming worker uses).

Phase 3 supports email magic-link auth, metadata loading from `public.files`, uploads into Supabase Storage, metadata inserts, signed download URLs, and delete flows. Without Supabase env vars, the app stays in local mock mode for UI development.

## AI naming (local)

Naming is **deferred and local**. An upload with auto-rename on lands with its original filename and sets `rename_requested`. A worker on the Windows desktop — the app's background poll while it's open, or `syncdrop autoname` — downloads the file, reads its content with a local vision model, writes `filename_ai`, and clears the flag. Uploads from the phone are named the next time the desktop is running. Nothing is sent to a paid API, and renaming never moves stored bytes.

Content routing: images go to the vision model; PDFs are named from their extracted text layer; text/JSON files from their opening characters. Anything else — unsupported types, scanned PDFs with no text, or a model that returns nothing usable — **keeps its original filename**. There are no UUID filenames.

Setup (Windows desktop only):

```bash
# Install Ollama from https://ollama.com, then:
ollama pull minicpm-v4.6
```

Tunable via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Where Ollama is listening |
| `SYNCDROP_NAMER_MODEL` | `minicpm-v4.6` | Vision model to use |
| `SYNCDROP_NAMER_MAX_EDGE` | `512` | Longest image edge sent to the model; higher is more accurate but slower |
| `SYNCDROP_NAMER_TIMEOUT_MS` | `120000` | Per-file inference timeout |

On CPU-only hardware expect roughly 10-20s per image, which is why naming is a background pass rather than part of upload. If Ollama isn't running, files simply keep their original names and are retried on the next pass.

Phase 5 adds the Electron preload bridge for Windows downloads. In Electron, signed Supabase download URLs are saved into the user's Downloads folder with sanitized, collision-safe filenames. Use `npm run build:electron` for the packaged renderer build and `npm run dist` to create the Windows installer with electron-builder. Installer artifacts are written to `release/`.

Phase 6 adds the generated Capacitor Android project under `android/`. Build the web app first, then run `npm run cap:sync` before opening Android Studio or running Gradle. The Android manifest includes internet access for Supabase sync.

Phase 7 adds production hardening in the shared client: cloud metadata is cached locally after refresh, cached metadata is shown when refresh fails, upload/download cloud calls retry transient network/server failures, selected files queue in memory while offline, and queued uploads retry when the browser reports connectivity again. Very large uploads use the same retry path and display an explicit large-file retry status; for production-scale multi-gigabyte transfers, replace Supabase's single-object browser upload with a dedicated resumable/chunked storage endpoint.

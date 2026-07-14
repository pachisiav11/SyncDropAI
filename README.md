# SyncDrop AI

SyncDrop AI is a cross-platform file transfer app for Windows and Android. It uses a shared HTML/CSS/JavaScript frontend, Electron for Windows, Capacitor for Android, Supabase for auth/storage/metadata, and an AI filename suggestion function during upload.

## Phase Plan

1. **Foundation**: project skeleton, shared frontend shell, Electron entry, Capacitor config, Supabase schema, AI naming function stub, docs.
2. **Local UI MVP**: upload area, file list, settings storage, progress states, mocked transfer flow.
3. **Supabase Integration**: auth, file metadata table, storage upload/list/delete/download, RLS policies.
4. **AI Rename Integration**: call the Supabase Edge Function once per upload, validate filename output, fall back to UUID filenames.
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
`~/.syncdrop/session.json`, which the CLI reuses. Uploads that rename go through
the same `suggest-filename` Edge Function as the app.

Install/link it for local use, then run `syncdrop` (or `syncdrop help`) to see
every command:

```powershell
npm install
npm link          # exposes the `syncdrop` command globally
# or, without linking:
npm run syncdrop -- <command>
```

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

Do not ship production OpenAI keys inside Electron or Android builds. The intended production path is to keep the OpenAI API key in a Supabase Edge Function secret and call that function from the client.

## Supabase

The schema and RLS policy examples are in `supabase/schema.sql`. Create a private storage bucket named `files`, enable Row Level Security, and deploy the `suggest-filename` function for AI naming.

Phase 3 supports email magic-link auth, metadata loading from `public.files`, uploads into Supabase Storage, metadata inserts, signed download URLs, and delete flows. Without Supabase env vars, the app stays in local mock mode for UI development.

Phase 4 calls the `suggest-filename` Edge Function once per cloud upload when auto-rename is enabled. The client validates the returned lowercase hyphenated filename and falls back to a UUID filename with the original extension when the function is unavailable or returns invalid output.

Phase 5 adds the Electron preload bridge for Windows downloads. In Electron, signed Supabase download URLs are saved into the user's Downloads folder with sanitized, collision-safe filenames. Use `npm run build:electron` for the packaged renderer build and `npm run dist` to create the Windows installer with electron-builder. Installer artifacts are written to `release/`.

Phase 6 adds the generated Capacitor Android project under `android/`. Build the web app first, then run `npm run cap:sync` before opening Android Studio or running Gradle. The Android manifest includes internet access for Supabase sync.

Phase 7 adds production hardening in the shared client: cloud metadata is cached locally after refresh, cached metadata is shown when refresh fails, upload/download cloud calls retry transient network/server failures, selected files queue in memory while offline, and queued uploads retry when the browser reports connectivity again. Very large uploads use the same retry path and display an explicit large-file retry status; for production-scale multi-gigabyte transfers, replace Supabase's single-object browser upload with a dedicated resumable/chunked storage endpoint.

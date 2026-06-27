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

## Configuration

Create `.env` from `.env.example`.

Do not ship production OpenAI keys inside Electron or Android builds. The intended production path is to keep the OpenAI API key in a Supabase Edge Function secret and call that function from the client.

## Supabase

The initial schema is in `supabase/schema.sql`. Create a private storage bucket named `files`, enable Row Level Security, and deploy the `suggest-filename` function for AI naming.

# SyncDrop AI — Sign-in Handoff

Purpose: give the next Claude Code session everything needed to help sign in to the SyncDrop desktop app. Written 2026-07-01.

## TL;DR for next session
1. **Restart already happened** — good. The app was installed mid-session last time, which is why it couldn't be computer-controlled. A fresh session should now see **"SyncDrop AI"** as a grantable app.
2. Launch the app (desktop shortcut **"SyncDrop AI"**, or `%LOCALAPPDATA%\Programs\syncdrop-ai\SyncDrop AI.exe`).
3. `request_access(["SyncDrop AI"])`, screenshot, confirm the UI renders (not blank).
4. In the auth panel: type the user's email, click **Send code**.
5. User reads the **6-digit code** from their email and it goes into the code field → **Verify**. (Claude may enter the email and the code; it must NOT handle passwords — but this flow has no password.)

## The sign-in flow (verified in source)
- Auth = **Supabase email OTP** (`supabase.auth.signInWithOtp` → `verifyOtp({ type: "email" })`).
- Code lives in `src/app.js`:
  - `signInWithEmail(email)` → line ~262, sends the code.
  - `verifyOtpCode(email, token)` → line ~275, verifies the 6-digit code.
  - `renderAuthPanel()` → line ~599, the UI.
- UI states:
  - Initial: heading "Cloud sync" / "Sign in with an email code", form `#auth-form` with `input[name=email]` + **Send code** button.
  - After sending: heading "Enter your code", form `#otp-form` with `input[name=token]` (6-digit) + **Verify** button. A "Use a different email" back button is also present.
  - Signed in: shows "Signed in" + email + Refresh / Downloads / Sign out.

### Important desktop caveat
The email contains BOTH a magic link and a 6-digit code. `signInWithEmail` sets `emailRedirectTo` to `window.location.href`, which in the packaged Electron app is a `file://` URL — clicking the magic **link** will NOT round-trip back into the app. **Use the 6-digit code path**, not the link. (`appUrlOpen` deep-link handling at line ~241 only fires on Capacitor native, not Electron.)

## Credentials / identity
- User's email (from session memory): **pachisiavihaan11@gmail.com** — confirm with user before sending a code to it.
- No password anywhere in this flow. Claude may type the email and the received code. Reading the code from the user's inbox is fine if a Gmail/Outlook MCP is authorized; otherwise ask the user to read it out.

## Environment / config status
- Supabase IS configured. `.env` present; build has `VITE_SUPABASE_URL=https://melgipimwaqwknzxfqml.supabase.co` baked in. `isSupabaseConfigured` will be true, so the real auth panel renders (not the "Supabase not configured" fallback).
- Env vars used: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_BUCKET` (default "files"). See `.env` / `.env.example`.

## What was already fixed (don't redo)
- **Blank-page bug**: root cause was Vite emitting absolute asset paths (`/assets/...`) that break under Electron's `file://` load. Fixed by adding `base: "./"` to `vite.config.js`.
- Rebuilt cleanly with `npm run build` + `npm run dist` (electron-builder). Fix is baked into both `release/win-unpacked/` and the installer.
- **Installed** to `%LOCALAPPDATA%\Programs\syncdrop-ai\`. Desktop shortcut **"SyncDrop AI"** points there.
- Removed the old blank-`index.html` desktop shortcut. Removed a duplicate AFK dev-build (`electron`) startup entry; installed `AFK` still autostarts.
- The old **"localhost refused"** was a stale **Chrome tab on localhost:5173** (Vite dev server), NOT the desktop app. Close that tab. The desktop app needs no dev server.

## Do NOT open index.html directly
`file:///D:/Projects/windows-android/index.html` will always be blank (ES module + absolute path over file://). Use the desktop app, or for dev use `npm run dev` → http://localhost:5173.

## Key paths
- Source: `D:\Projects\windows-android\`
- Auth code: `src\app.js`, `src\supabaseClient.js`
- Electron main (load logic): `electron\main.js` (`isDev ? loadURL(localhost:5173) : loadFile(dist-app/index.html)`)
- Installed exe: `%LOCALAPPDATA%\Programs\syncdrop-ai\SyncDrop AI.exe`
- Unpacked build: `release\win-unpacked\SyncDrop AI.exe`
- Installer: `release\SyncDrop AI Setup 0.1.0.exe`

## First message to paste next session
> Continue the SyncDrop sign-in from SIGNIN_HANDOFF.md in D:\Projects\windows-android. The app is installed now. Open it, grant computer access, and drive the email-code sign-in — I'll give you the 6-digit code from my email. Don't touch passwords (there are none in this flow).

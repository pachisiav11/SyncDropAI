# SyncDrop AI Finish Checklist

Use this checklist from PowerShell on Windows.

## 1. Confirm Project State

```powershell
cd D:\Projects\windows-android
git status --short
npm run build
npm run cap:sync
```

Expected:

- `npm run build` succeeds.
- `npm run cap:sync` succeeds.
- `git status --short` shows the Phase 5-7 changes and the new `android/` project.

## 2. Fix Android Build Requirements

Open Android Studio and install the Android SDK pieces:

1. Open Android Studio.
2. Go to `Settings > Languages & Frameworks > Android SDK`.
3. Install these SDK tools/platforms:
   - Android SDK Platform 35
   - Android SDK Build-Tools
   - Android SDK Platform-Tools
   - Android SDK Command-line Tools

Then find or confirm the SDK path. The default for this Windows user should be:

```powershell
C:\Users\vihaa\AppData\Local\Android\Sdk
```

If that folder exists, create `android/local.properties`:

```powershell
cd D:\Projects\windows-android
@"
sdk.dir=C\:\\Users\\vihaa\\AppData\\Local\\Android\\Sdk
"@ | Set-Content -Encoding ASCII android\local.properties
```

`android/local.properties` is intentionally untracked and should not be committed.

## 3. Build Android Debug APK

Use Android Studio's bundled Java runtime, because the Android Gradle plugin requires Java 17+.

```powershell
cd D:\Projects\windows-android\android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "C:\Users\vihaa\AppData\Local\Android\Sdk"
.\gradlew.bat assembleDebug
```

Expected APK output:

```powershell
D:\Projects\windows-android\android\app\build\outputs\apk\debug\app-debug.apk
```

If Gradle still says it cannot find the SDK, recheck that `android/local.properties` exists and that the `sdk.dir` path matches the SDK folder on your machine.

## 4. Fix Electron Packaging EPERM

The project code is configured to emit Electron installer artifacts into `release/`. If packaging fails with `EPERM: operation not permitted, rename`, close anything that might be holding files open:

- running SyncDrop AI or Electron windows
- Explorer windows inside `D:\Projects\windows-android\release` or `D:\Projects\windows-android\dist`
- terminals whose current directory is `release/` or `dist/`
- antivirus/security scan windows touching the project folder

Then clean generated output and rebuild:

```powershell
cd D:\Projects\windows-android
Remove-Item -Recurse -Force release, dist -ErrorAction SilentlyContinue
npm run build
npm run dist
```

If `npm run dist` still fails with the same `EPERM` rename error, open PowerShell as Administrator and retry:

```powershell
cd D:\Projects\windows-android
Remove-Item -Recurse -Force release, dist -ErrorAction SilentlyContinue
npm run build
npm run dist
```

Expected installer output will be under:

```powershell
D:\Projects\windows-android\release
```

## 5. Final Verification

Run these checks after Android and Electron builds are fixed:

```powershell
cd D:\Projects\windows-android
npm run build
npm run cap:sync
node --check electron\main.js
node --check electron\preload.js

cd D:\Projects\windows-android\android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "C:\Users\vihaa\AppData\Local\Android\Sdk"
.\gradlew.bat assembleDebug

cd D:\Projects\windows-android
npm run dist
```

## 6. Commit And Push

Only do this after the verification commands pass, or after deciding that any remaining local packaging blocker is documented.

```powershell
cd D:\Projects\windows-android
git status --short
git add .gitignore README.md package.json src\app.js electron\main.js electron\preload.js android TODO.md
git commit -m "Complete phases 5 through 7"
git push origin main
```

Suggested commit notes:

- Phase 5: Electron preload bridge saves signed downloads to the Windows Downloads folder.
- Phase 6: Capacitor Android project is generated and synced.
- Phase 7: Shared client has metadata cache fallback, transient retry handling, offline upload queue, and production hardening notes.

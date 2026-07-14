# Installs the `syncdrop` command so it works from any folder in both
# PowerShell and cmd, with no npm commands run by the user.
#
# Run in PowerShell:
#   iwr https://raw.githubusercontent.com/pachisiav11/SyncDropAI/main/install.ps1 -UseB | iex
#
# It clones/updates the repo under %LOCALAPPDATA%\Programs\syncdrop, installs the
# CLI's runtime dependencies, drops a `syncdrop.cmd` shim into a bin folder, and
# adds that bin folder to the user PATH.

$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\syncdrop'
$binDir = Join-Path $installDir 'bin'
$repoUrl = 'https://github.com/pachisiav11/SyncDropAI.git'

function Assert-Command {
    param([string] $Name, [string] $Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' was not found on PATH. $Hint"
    }
}

Assert-Command git 'Install Git for Windows: https://git-scm.com/download/win'
Assert-Command node 'Install Node.js (18+): https://nodejs.org'
Assert-Command npm  'npm ships with Node.js: https://nodejs.org'

# Clone the repo, or update an existing install in place.
if (Test-Path -LiteralPath (Join-Path $installDir '.git')) {
    Write-Host 'Updating existing syncdrop install...'
    git -C $installDir fetch --depth 1 origin main
    git -C $installDir reset --hard FETCH_HEAD
} elseif (Test-Path -LiteralPath $installDir) {
    $backupDir = "$installDir.backup-$(Get-Date -Format yyyyMMddHHmmss)"
    Move-Item -LiteralPath $installDir -Destination $backupDir
    git clone --depth 1 $repoUrl $installDir
} else {
    git clone --depth 1 $repoUrl $installDir
}

# Install only the CLI's runtime dependencies (skips electron and other dev deps).
Write-Host 'Installing CLI dependencies...'
npm --prefix $installDir install --omit=dev --no-audit --no-fund

# Put the shim on PATH.
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item -LiteralPath (Join-Path $installDir 'syncdrop.cmd') -Destination $binDir -Force

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $binDir) {
    $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $binDir } else { "$userPath;$binDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
}
if (($env:Path -split ';') -notcontains $binDir) {
    $env:Path = "$env:Path;$binDir"
}

Write-Host ''
Write-Host 'syncdrop installed.'
Write-Host 'Open a new terminal (or use this one) and try: syncdrop help'
Write-Host 'Sign in through the SyncDrop AI desktop app first so the CLI can reuse that session.'

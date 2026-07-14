# Removes the `syncdrop` command installed by install.ps1: deletes the install
# directory under %LOCALAPPDATA%\Programs\syncdrop and removes its bin folder
# from the user PATH. Does not touch ~/.syncdrop/session.json.
#
# Run in PowerShell:
#   iwr https://raw.githubusercontent.com/pachisiav11/SyncDropAI/main/uninstall.ps1 -UseB | iex

$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\syncdrop'
$binDir = Join-Path $installDir 'bin'

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
    $kept = ($userPath -split ';') | Where-Object { $_ -and $_ -ne $binDir }
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
}
$env:Path = (($env:Path -split ';') | Where-Object { $_ -and $_ -ne $binDir }) -join ';'

if (Test-Path -LiteralPath $installDir) {
    Remove-Item -LiteralPath $installDir -Recurse -Force
}

Write-Host 'syncdrop uninstalled.'
Write-Host 'Your session file (~/.syncdrop/session.json) was left in place; delete it manually if you want.'

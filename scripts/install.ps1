$ErrorActionPreference = "Stop"

# Purpose: Install local Windows launchers (`ff.ps1`, `ff.cmd`) in current directory and boot faustforge.
# How: Downloads launcher scripts from GitHub raw, then starts and opens localhost.

$targetDir = (Get-Location).Path
$ffPs1 = Join-Path $targetDir "ff.ps1"
$ffCmd = Join-Path $targetDir "ff.cmd"

$base = "https://raw.githubusercontent.com/orlarey/faustforge/main/scripts"

Write-Host "Installing ff launchers in $targetDir"
Invoke-WebRequest -UseBasicParsing -Uri "$base/ff.ps1" -OutFile $ffPs1
Invoke-WebRequest -UseBasicParsing -Uri "$base/ff.cmd" -OutFile $ffCmd

Write-Host "Starting faustforge..."
powershell -NoProfile -ExecutionPolicy Bypass -File $ffPs1 start

Write-Host "Opening http://localhost:3000"
Start-Process "http://localhost:3000" | Out-Null

Write-Host "Done. Use '.\ff.ps1 help' (or '.\ff.cmd help')."


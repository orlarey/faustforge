param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ArgsList
)

$ErrorActionPreference = "Stop"

# Purpose: Provide a simple end-user CLI for faustforge Docker lifecycle on Windows.
# How: Wraps docker commands behind short verbs (start/stop/update/logs/status/open/reset).

$FF_IMAGE = if ($env:FF_IMAGE) { $env:FF_IMAGE } else { "ghcr.io/orlarey/faustforge:latest" }
$FF_NAME = if ($env:FF_NAME) { $env:FF_NAME } else { "faustforge" }
$FF_PORT = if ($env:FF_PORT) { $env:FF_PORT } else { "3000" }
$FF_SESSIONS_DIR = if ($env:FF_SESSIONS_DIR) { $env:FF_SESSIONS_DIR } else { Join-Path $HOME ".faustforge\sessions" }
$FF_WORKSPACE_DIR = if ($env:FF_WORKSPACE_DIR) { $env:FF_WORKSPACE_DIR } else { Join-Path $HOME "faust-workspace" }
$FF_LIVE_AUTO_DISCOVER = if ($env:FF_LIVE_AUTO_DISCOVER) { $env:FF_LIVE_AUTO_DISCOVER } else { "1" }
$FF_LIVE_SCAN_INTERVAL_MS = if ($env:FF_LIVE_SCAN_INTERVAL_MS) { $env:FF_LIVE_SCAN_INTERVAL_MS } else { "1500" }
$FF_LIVE_IGNORE_DIRS = if ($env:FF_LIVE_IGNORE_DIRS) { $env:FF_LIVE_IGNORE_DIRS } else { "" }
$FF_MAX_SESSIONS = if ($env:FF_MAX_SESSIONS) { $env:FF_MAX_SESSIONS } else { "0" }
$URL = "http://localhost:$FF_PORT"
$WORKSPACE_TRACK_FILE = Join-Path $FF_SESSIONS_DIR ".ff-workspace"

function Show-Usage {
  @"
faustforge launcher (ff, Windows)

Usage:
  .\ff
  .\ff [workspace]
  .\ff [workspace] [command]
  .\ff start [workspace]
  .\ff --workspace <dir> [command]
  .\ff stop | restart | update | logs | status | open | reset | help
"@
}

function Ensure-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker is not installed or not in PATH."
  }
  docker info *> $null
}

function Container-Exists {
  $names = docker ps -a --format "{{.Names}}"
  return ($names -split "`n" | Where-Object { $_ -eq $FF_NAME }).Count -gt 0
}

function Container-Running {
  $names = docker ps --format "{{.Names}}"
  return ($names -split "`n" | Where-Object { $_ -eq $FF_NAME }).Count -gt 0
}

function Container-WorkspaceMount {
  $m = docker inspect -f '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' $FF_NAME 2>$null
  return ($m | Out-String).Trim()
}

function Container-SessionsMount {
  $m = docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/sessions"}}{{.Source}}{{end}}{{end}}' $FF_NAME 2>$null
  return ($m | Out-String).Trim()
}

function Container-HostPort {
  $p = docker inspect -f '{{(index (index .HostConfig.PortBindings "3000/tcp") 0).HostPort}}' $FF_NAME 2>$null
  return ($p | Out-String).Trim()
}

function Container-Image {
  $i = docker inspect -f '{{.Config.Image}}' $FF_NAME 2>$null
  return ($i | Out-String).Trim()
}

function Track-WorkspaceChange {
  $previous = ""
  if (Test-Path $WORKSPACE_TRACK_FILE) {
    $previous = (Get-Content $WORKSPACE_TRACK_FILE -ErrorAction SilentlyContinue | Select-Object -First 1)
  }
  if ($previous -and ($previous -ne $FF_WORKSPACE_DIR)) {
    Write-Host "Workspace changed:"
    Write-Host "  previous: $previous"
    Write-Host "  current : $FF_WORKSPACE_DIR"
    Write-Host "Live sessions will be realigned from workspace scan."
  }
  $FF_WORKSPACE_DIR | Set-Content -Path $WORKSPACE_TRACK_FILE -NoNewline
}

function Realign-LiveSessions {
  if ($FF_LIVE_AUTO_DISCOVER -ne "1") { return }
  Write-Host "Aligning live sessions with workspace: $FF_WORKSPACE_DIR"
  if (Test-Path $FF_SESSIONS_DIR) {
    Get-ChildItem -Path $FF_SESSIONS_DIR -Directory -Filter "live-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Open-Url {
  Start-Process $URL | Out-Null
}

function Start-Forge {
  Ensure-Docker
  New-Item -ItemType Directory -Force -Path $FF_SESSIONS_DIR | Out-Null
  New-Item -ItemType Directory -Force -Path $FF_WORKSPACE_DIR | Out-Null
  Track-WorkspaceChange
  Realign-LiveSessions

  Write-Host "Workspace: $FF_WORKSPACE_DIR"
  Write-Host "Sessions : $FF_SESSIONS_DIR"
  Write-Host "URL      : $URL"

  if (Container-Exists) {
    $mountedWorkspace = Container-WorkspaceMount
    $mountedSessions = Container-SessionsMount
    $mountedPort = Container-HostPort
    $mountedImage = Container-Image
    if ($mountedWorkspace -ne $FF_WORKSPACE_DIR -or $mountedSessions -ne $FF_SESSIONS_DIR -or $mountedPort -ne $FF_PORT -or $mountedImage -ne $FF_IMAGE) {
      Write-Host "Configuration changed. Recreating container '$FF_NAME'."
      docker rm -f $FF_NAME | Out-Null
    } elseif (Container-Running) {
      if ($FF_LIVE_AUTO_DISCOVER -eq "1") {
        Write-Host "Container already running. Restarting to rescan workspace."
        docker restart $FF_NAME | Out-Null
        Write-Host "faustforge started: $URL"
        return
      } else {
        Write-Host "faustforge is already running: $URL"
        return
      }
    } else {
      docker start $FF_NAME | Out-Null
      Write-Host "faustforge started: $URL"
      return
    }
  }

  docker run -d `
    --name $FF_NAME `
    -p "${FF_PORT}:3000" `
    -v "${FF_SESSIONS_DIR}:/app/sessions" `
    -v "${FF_WORKSPACE_DIR}:/workspace" `
    -v "/var/run/docker.sock:/var/run/docker.sock" `
    -e "SESSIONS_DIR=/app/sessions" `
    -e "HOST_SESSIONS_DIR=$FF_SESSIONS_DIR" `
    -e "FAUST_HTTP_URL=$URL" `
    -e "LIVE_AUTO_DISCOVER=$FF_LIVE_AUTO_DISCOVER" `
    -e "LIVE_WORKSPACE_ROOT=/workspace" `
    -e "HOST_LIVE_WORKSPACE_ROOT=$FF_WORKSPACE_DIR" `
    -e "LIVE_SCAN_INTERVAL_MS=$FF_LIVE_SCAN_INTERVAL_MS" `
    -e "LIVE_IGNORE_DIRS=$FF_LIVE_IGNORE_DIRS" `
    -e "MAX_SESSIONS=$FF_MAX_SESSIONS" `
    $FF_IMAGE | Out-Null

  Write-Host "faustforge started: $URL"
}

function Stop-Forge {
  Ensure-Docker
  if (-not (Container-Exists)) {
    Write-Host "No container named '$FF_NAME'."
    return
  }
  docker rm -f $FF_NAME | Out-Null
  Write-Host "faustforge stopped."
}

function Restart-Forge { Stop-Forge; Start-Forge }

function Update-Forge {
  Ensure-Docker
  Write-Host "Pulling latest image: $FF_IMAGE"
  docker pull $FF_IMAGE
  Restart-Forge
}

function Logs-Forge { Ensure-Docker; docker logs -f $FF_NAME }
function Status-Forge { Ensure-Docker; docker ps -a --filter "name=^/$FF_NAME$" --format "table {{.Names}}`t{{.Status}}`t{{.Ports}}" }

function Reset-Forge {
  Ensure-Docker
  $answer = Read-Host "Delete container and sessions in '$FF_SESSIONS_DIR'? [y/N]"
  if ($answer -match '^(y|Y|yes|YES)$') {
    if (Container-Exists) {
      docker rm -f $FF_NAME | Out-Null
    }
    if (Test-Path $FF_SESSIONS_DIR) {
      Remove-Item -Recurse -Force $FF_SESSIONS_DIR
    }
    New-Item -ItemType Directory -Force -Path $FF_SESSIONS_DIR | Out-Null
    Write-Host "faustforge reset complete."
  } else {
    Write-Host "Canceled."
  }
}

$cmdArgs = @($ArgsList)
if ($cmdArgs.Count -ge 2 -and $cmdArgs[0] -eq "--workspace") {
  $FF_WORKSPACE_DIR = (Resolve-Path -Path $cmdArgs[1]).Path
  if ($cmdArgs.Count -gt 2) {
    $cmdArgs = $cmdArgs[2..($cmdArgs.Count - 1)]
  } else {
    $cmdArgs = @()
  }
}

if ($cmdArgs.Count -ge 2 -and $cmdArgs[0] -eq "start" -and (Test-Path -Path $cmdArgs[1] -PathType Container)) {
  $FF_WORKSPACE_DIR = (Resolve-Path -Path $cmdArgs[1]).Path
  if ($cmdArgs.Count -gt 2) {
    $cmdArgs = @("start") + $cmdArgs[2..($cmdArgs.Count - 1)]
  } else {
    $cmdArgs = @("start")
  }
}

if ($cmdArgs.Count -ge 1 -and (Test-Path -Path $cmdArgs[0] -PathType Container)) {
  $FF_WORKSPACE_DIR = (Resolve-Path -Path $cmdArgs[0]).Path
  if ($cmdArgs.Count -gt 1) {
    $cmdArgs = @("start") + $cmdArgs[1..($cmdArgs.Count - 1)]
  } else {
    $cmdArgs = @("start")
  }
}

if ($cmdArgs.Count -eq 0) {
  $FF_WORKSPACE_DIR = (Get-Location).Path
  $cmdArgs = @("start")
}

$cmd = $cmdArgs[0]
switch ($cmd) {
  "start" { Start-Forge }
  "stop" { Stop-Forge }
  "restart" { Restart-Forge }
  "update" { Update-Forge }
  "logs" { Logs-Forge }
  "status" { Status-Forge }
  "open" { Open-Url }
  "reset" { Reset-Forge }
  "help" { Show-Usage }
  default {
    Write-Error "Unknown command: $cmd"
    Show-Usage
    exit 1
  }
}


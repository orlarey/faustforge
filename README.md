# faustforge
Web UI + MCP server for Faust prototyping, intended to run with Docker.

## Quick Start (Docker)

Prerequisite: Docker installed and running.

### 1) Run the container

```bash
docker run -d \
  --name faustforge \
  -p 3000:3000 \
  -v "$HOME/.faustforge/sessions:/app/sessions" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SESSIONS_DIR=/app/sessions \
  -e HOST_SESSIONS_DIR="$HOME/.faustforge/sessions" \
  -e FAUST_HTTP_URL=http://localhost:3000 \
  ghcr.io/orlarey/faustforge:latest
```

`docker run` pulls the image automatically if it is not present locally.
To force the latest image: `docker pull ghcr.io/orlarey/faustforge:latest` (or `docker run --pull always ...` if supported).

Then open:

```text
http://localhost:3000
```

Notes:
- Sessions are persisted in `~/.faustforge/sessions`.
- `/var/run/docker.sock` is required because the app launches the Faust Docker image for C++ compilation.
- `HOST_SESSIONS_DIR` must point to the host path of sessions so nested Docker mounts resolve correctly.

Optional overrides:

```bash
docker run -d \
  --name faustforge-dev \
  -p 3001:3000 \
  -v "$HOME/.faustforge-dev/sessions:/app/sessions" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SESSIONS_DIR=/app/sessions \
  -e HOST_SESSIONS_DIR="$HOME/.faustforge-dev/sessions" \
  -e FAUST_HTTP_URL=http://localhost:3001 \
  ghcr.io/orlarey/faustforge:latest
```

### Windows (PowerShell)

```powershell
$sessions = "$env:USERPROFILE\.faustforge\sessions"
New-Item -ItemType Directory -Force -Path $sessions | Out-Null

docker run -d `
  --name faustforge `
  -p 3000:3000 `
  -v "${sessions}:/app/sessions" `
  -v /var/run/docker.sock:/var/run/docker.sock `
  -e SESSIONS_DIR=/app/sessions `
  -e HOST_SESSIONS_DIR="$sessions" `
  -e FAUST_HTTP_URL=http://localhost:3000 `
  ghcr.io/orlarey/faustforge:latest
```

Then open `http://localhost:3000`.

## Build Locally (Maintainers)

### 1) Build the local image

```bash
make rebuild
```

### 2) Run with helper script

```bash
make run
```

The helper script uses:
- `PORT` (default `3000`)
- `NAME` (default `faustforge`)
- `HOST_SESSIONS_DIR` (default `$HOME/.faustforge/sessions`)

You can still use the raw scripts directly:
- `./scripts/rebuild.sh`
- `./scripts/run.sh`
- `./scripts/stop.sh`

## Claude Desktop MCP Setup

Edit:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add:

```json
{
  "mcpServers": {
    "faustforge": {
      "command": "docker",
      "args": ["exec", "-i", "faustforge", "node", "/app/mcp.mjs"]
    }
  }
}
```

Restart Claude Desktop.

## Using Faustforge with an AI client

With MCP configured, Claude Desktop can control Faustforge and work on the same sessions as the web UI.

What the AI can do:
- Forge: submit/edit Faust DSP code and inspect generated artifacts.
- Play: switch to `run`, start/stop audio transport, and control UI parameters.
- Analyze: capture and read spectrum snapshots to evaluate sonic changes.

Typical workflow:
```text
1) set_view("run")
2) get_run_ui()
3) run_transport("start")
4) set_run_param(...)
5) trigger_button_and_get_spectrum(...)
6) analyze series and aggregate.summary
7) iterate on DSP or parameters
```

Run control tools:
- `get_run_ui` -> return Faust UI JSON (parameter paths)
- `get_run_params` -> return current run parameters by path
- `set_run_param(path, value)` -> set one continuous parameter
- `run_transport(action)` -> `start`, `stop`, or `toggle`
- `trigger_button(path, holdMs?)` -> safe press/release cycle
- `trigger_button_and_get_spectrum(path, holdMs?, captureMs?, sampleEveryMs?, maxFrames?)` -> trigger + spectrum-summary time series + max-hold aggregate

Spectrum behavior:
- When audio is running in `run` view, the frontend pushes compact spectrum summaries to MCP state.
- `get_view_content` returns spectrum content when current view is `run`.
- `get_spectrum` returns the latest spectrum summary independently of current view.
- Capture starts at tool call time (only fresh snapshots are aggregated).
- Legacy fallback remains available when summary is not present.

Parameter behavior:
- `hslider`, `vslider`, `nentry`: value persists until changed.
- `button`: requires a full cycle (`1` then `0`) to retrigger correctly.
- `checkbox`: toggles between `0` and `1`, value persists.

## Useful Docker Commands

```bash
make help
make logs
make stop
```

## Published Image

```text
ghcr.io/orlarey/faustforge:latest
```

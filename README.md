# faustforge
Web UI + MCP server for Faust prototyping, intended to run with Docker.

## TL;DR

```bash
docker build -t faustforge:latest .
./scripts/run.sh
```

Open `http://localhost:3000`.

For Claude Desktop, set:

```json
{
  "mcpServers": {
    "faustmcp": {
      "command": "docker",
      "args": ["exec", "-i", "faustforge", "node", "/app/mcp.mjs"]
    }
  }
}
```

## Quick Start (Docker)

Prerequisite: Docker installed and running.

### 1) Build the image

```bash
docker build -t faustforge:latest .
```

### 2) Run the container

```bash
./scripts/run.sh
```

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
PORT=3001 NAME=faustforge-dev HOST_SESSIONS_DIR="$HOME/.faustforge-dev/sessions" ./scripts/run.sh
```

## Claude Desktop MCP Setup

Edit:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add:

```json
{
  "mcpServers": {
    "faustmcp": {
      "command": "docker",
      "args": ["exec", "-i", "faustforge", "node", "/app/mcp.mjs"]
    }
  }
}
```

Restart Claude Desktop.

## Useful Docker Commands

```bash
docker logs -f faustforge
./scripts/stop.sh
```

## MCP Audio Snapshot

When audio is running in `run` view, the frontend pushes spectrum snapshots to MCP state.

- `get_view_content` returns spectrum when current view is `run`
- `get_spectrum` returns latest spectrum independently of current view

## MCP Run Control (IA)

Run-related MCP tools:
- `get_run_ui` -> return Faust UI JSON (parameter paths)
- `get_run_params` -> return current run parameters by path
- `set_run_param(path, value)` -> set one continuous parameter
- `run_transport(action)` -> `start`, `stop`, or `toggle`
- `trigger_button(path, holdMs?)` -> safe press/release cycle
- `trigger_button_and_get_spectrum(path, holdMs?, captureMs?)` -> atomic trigger + max-hold spectrum capture

Capture notes:
- capture window starts at tool call time (only fresh snapshots are aggregated)
- non-finite FFT bins are clamped to `floorDb` before returning `spectrum.data`

Parameter behavior:
- `hslider`, `vslider`, `nentry`: value persists until changed
- `button`: requires a full cycle (`1` then `0`) to retrigger correctly
- `checkbox`: toggles between `0` and `1`, value persists

Recommended IA loop:
```text
1) set_view("run")
2) get_run_ui()
3) run_transport("start")
4) set_run_param(...)
5) trigger_button_and_get_spectrum(...)
6) analyze spectrum.data
7) iterate
```

## Target Image Name

Target publication name (later):

```text
ghcr.io/orlarey/faustforge:latest
```

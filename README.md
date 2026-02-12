# faustforge
Docker-first web UI + MCP server for Faust prototyping, featuring an Orbit UI for expressive multi-parameter exploration and tight AI-in-the-loop iteration.

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

## User Manual

### 1) Open faustforge

Open `http://localhost:3000`. The first thing before using FAUSTFORGE is to enable audio by clicking the **Enable Audio** button. This step is required because web browsers block audio playback until the user explicitly allows it (Web Audio API security policy).

![Home](docs/screenshots/01-home-page-unlock.png)

Once audio is enabled, you can start creating sessions by dropping Faust files.

![Home](docs/screenshots/01-home.png)

### 2) Create a session

A session is a Faust `.dsp` code associated with different views, including a run view where you can listen to and interact with the audio application.

In order to create a session you can:

- Drop a `.dsp` file into the page.
- Paste Faust code directly (`Ctrl+V` / `Cmd+V`), which creates a `clip-<timestamp>.dsp` session.

Note that you can create new sessions from any session and any view. For example, if you are in the block diagram view, you can drop a `.dsp` file to visualize its block diagram.

![Create session](docs/screenshots/02-create-session.png)

### 3) Navigate sessions and views

You can navigate between sessions using the left and right arrows, and between views using the up and down arrows or the view menu.

- Sessions: `◀` / `▶`
- Views menu order: `dsp`, `svg`, `run`, `cpp`, `tasks`, `signals`
- Keyboard shortcuts:
  - `←` / `→`: previous/next session
  - `↑` / `↓`: previous/next view

![Navigation](docs/screenshots/03-navigation.png)

### 4) Work with source and generated outputs

The following views let you inspect the Faust source and its generated artifacts:

- `dsp`: original Faust source code.
- `svg`: block diagram rendered as SVG.
- `cpp`: generated C++ code.
- `tasks`: task-level parallelism graph (see section 6).
- `signals`: internal signal graph (see section 6).

The `run` view is covered in detail in the next section.

![Code and diagram](docs/screenshots/04-code-svg.png)

### 5) Run audio

Go to `run` view to:

- start/stop audio
- view the produced spectrum or waveform
- interact with controls in `Regular UI` and `Orbit UI`
- play notes from the virtual MIDI keyboard in the top bar (`A W S E D F T G Y H U J`, octave `Z/X`)
- use MCP tools against the same active session

![Run view](docs/screenshots/05-run.png)

#### Orbit UI behavior

Orbit UI is a 2D control space for fast exploration of many parameters at once.

- Each slider is an icon around a central point.
- Slider value depends on icon distance to center:
  - on/inside inner disk: maximum
  - outside outer circle: minimum
  - between both: linear interpolation
- Drag a slider icon: changes only this slider (if active).
- Drag the center: changes all active sliders at once.
- Drag the outer circle ring (`grab` cursor): changes outer radius and updates all active sliders.
- `Shift+click` an icon: toggle slider active/disabled.
  - disabled slider is shown in dark gray
  - can move visually, but does not affect DSP parameter
  - ignored by center/radius gestures
  - ignored by parameter-to-orbit sync
- In polyphonic mode, frequency/gain-like sliders are auto-disabled to avoid conflicting controls.

### 6) Analyze graphs

These two views give access to internal representations used by the Faust compiler:

- `tasks`: task-level parallelism graph generated by `faust -vec -tg`. It shows how the compiler splits computation into parallel tasks.
- `signals`: signal-level graph generated by `faust -sg`. It shows the internal signal expression tree before compilation.

#### Tasks graph

![Tasks graph](docs/screenshots/06-tasks-graph.png)

Click the **Split view** button to show the `.dot` source code side by side with the rendered graph.

![Tasks graph split](docs/screenshots/06-tasks-graph-split.png)

#### Signals graph

![Signals graph](docs/screenshots/06-signals-graph.png)

#### Large graph fallback

If SVG rendering fails (typically because the graph is too large), faustforge displays an error banner and automatically switches to a DOT-only fallback view where you can still read and download the `.dot` source.

![Signals graph too big](docs/screenshots/06-signals-graph-too-big.png)


### 7) Toolbar actions

- **Refresh** (`↻`): regenerates all session artifacts (C++, SVG, graphs) from the current Faust source. Use this after editing the `.dsp` code.
- **Download**: exports the content of the current view. The exported format depends on the active view:
  - `dsp` → `<name>.dsp` (Faust source)
  - `svg` → `<name>.svg` (block diagram)
  - `cpp` → `<name>.cpp` (generated C++ code)
  - `tasks` → `<name>-tg.dot` (tasks graph in DOT format)
  - `signals` → `<name>-sig.dot` (signals graph in DOT format)
- **Delete**: deletes the current session and all its associated artifacts. The next available session is automatically selected.
- **Archive**: downloads all sessions as a single `.tar.gz` archive. This is useful for backing up your work or transferring sessions to another machine.

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
1) get_onboarding_guide()
2) set_view("run")
3) get_run_ui()
4) run_transport("start")
5) set_run_param(...)
6) set_run_param_and_get_spectrum(...)
7) trigger_button_and_get_spectrum(...)
8) analyze series and aggregate.summary
9) iterate on DSP or parameters
```

Run control tools:
- `get_onboarding_guide()` -> best-practice workflow + thresholds for autonomous AI behavior
- `get_run_ui` -> return Faust UI JSON (parameter paths)
- `get_run_params` -> return current run parameters by path
- `get_polyphony()` -> get current polyphony (`0` means mono)
- `set_polyphony(voices)` -> set polyphony (`0,1,2,4,8,16,32,64`; `0` means mono)
- `set_run_param(path, value)` -> set one continuous parameter
- `set_run_param_and_get_spectrum(path, value, settleMs?, captureMs?, sampleEveryMs?, maxFrames?)` -> set parameter + capture spectrum-summary time series + max-hold aggregate
- `run_transport(action)` -> `start`, `stop`, or `toggle`
- `trigger_button(path, holdMs?)` -> safe press/release cycle
- `trigger_button_and_get_spectrum(path, holdMs?, captureMs?, sampleEveryMs?, maxFrames?)` -> trigger + spectrum-summary time series + max-hold aggregate
- `midi_note_on(note, velocity?)` -> send MIDI note-on
- `midi_note_off(note)` -> send MIDI note-off
- `midi_note_pulse(note, velocity?, holdMs?)` -> send note-on then note-off automatically
- `midi_note_on_and_get_spectrum(note, velocity?, settleMs?, captureMs?, sampleEveryMs?, maxFrames?)` -> note-on + spectrum-summary time series + max-hold aggregate
- `midi_note_off_and_get_spectrum(note, settleMs?, captureMs?, sampleEveryMs?, maxFrames?)` -> note-off + spectrum-summary time series + max-hold aggregate
- `midi_note_pulse_and_get_spectrum(note, velocity?, holdMs?, captureMs?, sampleEveryMs?, maxFrames?)` -> note-pulse + spectrum-summary time series + max-hold aggregate

Faust library documentation tools:
- The Docker image ships with a prebuilt Faust doc index generated from `faustwasm` stdlib (`/usr/share/faust/stdfaust.lib`).
- No runtime fallback: MCP expects this prebuilt index to be present in the image.
- `search_faust_lib(query, limit?, module?)` -> search symbols without loading full docs in context
- `get_faust_symbol(symbol)` -> full symbol entry (summary, usage/signature, params, io with `inSignals`/`outSignals` when derivable, test snippet, source)
- `list_faust_module(module, limit?)` -> list symbols from one module (e.g. `delays`, `filters`)
- `get_faust_examples(symbolOrModule, limit?)` -> retrieve test/example snippets
- `explain_faust_symbol_for_goal(symbol, goal)` -> action-oriented guidance for a concrete DSP objective

Spectrum behavior:
- When audio is running in `run` view, the frontend pushes compact spectrum summaries to MCP state.
- `get_view_content` returns spectrum content when current view is `run`.
- `get_spectrum` returns the latest spectrum summary independently of current view.
- Capture starts at tool call time (only fresh snapshots are aggregated).
- Legacy fallback remains available when summary is not present.
- `spectrum_summary_v1` can include `audioQuality` feedback for temporal defects:
  - `peakDbFSQ`, `clipSampleCount`, `clipRatioQ`, `dcOffsetQ`, `clickCount`, `clickScoreQ`.

Audio quality quick interpretation (practical thresholds):
- `clipRatioQ > 1` (per-mille) -> clipping is likely audible.
- `clipRatioQ > 5` -> severe clipping.
- `clickScoreQ > 20` -> potential click/pop artifacts.
- `clickScoreQ > 40` -> strong click risk (usually clearly audible).
- `peakDbFSQ >= -1` with high `clipRatioQ` -> limiter/saturation region.

Browser note:
- On page open, faustforge requires an explicit `Enable Audio` click to unlock WebAudio in this tab.
- MCP audio tools (`run_transport start/toggle`, trigger/capture tools) are blocked until this unlock step is done.

Parameter behavior:
- `hslider`, `vslider`, `nentry`: value persists until changed.
- `button`: requires a full cycle (`1` then `0`) to retrigger correctly.
- `checkbox`: toggles between `0` and `1`, value persists.

Signals view:
- `signals` displays the Faust signal graph rendered from `signals.dot` (`faust -sg`).
- In `signals` view, Download exports `<name>-sig.dot`.

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

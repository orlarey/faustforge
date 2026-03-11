# Specification: MCP Interactions

This document describes how an AI assistant interacts with FaustForge through MCP. It is written from the AI's perspective: what it can do, what it can perceive, and how these two capabilities combine into a productive workflow.

## 1) Two Interaction Axes

The AI interacts with FaustForge along two complementary axes:

- **Code axis**: write Faust DSP code, submit it, read generated artifacts, understand compiler feedback, discover library functions.
- **Perception axis**: start audio, manipulate parameters, trigger events, capture spectral snapshots, and interpret the sonic result.

Neither axis is useful alone. Writing code without listening produces untested programs. Listening without writing code limits the AI to parameter tweaking. The value of the MCP integration is that the AI can close the loop: write code, hear it, measure it, and iterate.

## 2) Code Axis — Writing and Understanding

### 2.1) Submitting code

The AI writes Faust DSP code and submits it via `submit(code, filename?)`. This is the equivalent of a user dropping a `.dsp` file in the browser. On success, the new session becomes active and all views are regenerated (C++, SVG, graphs).

The `persistOnSuccessOnly` flag (default `true`) prevents broken code from polluting the session list. When compilation fails, the AI can read the error log with `get_errors(sha1)` and iterate without leaving dead sessions behind.

Typical code-submit cycle:

```
submit(code)  →  success?  →  set_view("run")  →  run_audio("on")
                  ↓ fail
              get_errors(sha1)  →  fix code  →  submit(code)
```

### 2.2) Reading artifacts

Once a session exists, the AI can inspect what the Faust compiler produced:

| View       | Content returned by `get_view_content()` | What the AI learns                        |
|------------|------------------------------------------|-------------------------------------------|
| `dsp`      | Faust source code                        | What was submitted                        |
| `cpp`      | Generated C++ code                       | How the compiler translates the DSP       |
| `svg`      | Block diagram (SVG)                      | Signal routing structure                  |
| `signals`  | Signal graph (DOT)                       | Internal signal expression tree           |
| `tasks`    | Task graph (DOT)                         | Parallelism structure for vectorized code |
| `run`      | Spectrum summary (JSON)                  | Current audio output (see perception)     |

The AI can also read artifacts independently of the active view using `get_spectrum()`.

### 2.3) Discovering library functions

Faust ships with a large standard library. The AI does not need to know it by heart. Four discovery tools give access to the full library documentation:

- `search_faust_lib(query)` — find symbols by keyword across all modules.
- `get_faust_symbol(symbol)` — get full documentation: usage, parameters, I/O, test snippet, source location.
- `list_faust_module(module)` — browse all symbols in a module (e.g. `filters`, `delays`, `oscillators`).
- `get_faust_examples(symbolOrModule)` — retrieve test/example code snippets.
- `explain_faust_symbol_for_goal(symbol, goal)` — get action-oriented guidance for a concrete DSP objective.

These tools allow the AI to learn incrementally: search for a concept, read the symbol doc, look at an example, then use it in submitted code.

### 2.4) Understanding compiler feedback

When compilation fails, `get_errors(sha1)` returns the Faust compiler stderr. The AI can parse error messages (line numbers, type errors, undefined symbols) and fix the code before resubmitting.

When compilation succeeds, the generated C++ and graphs provide structural feedback. The AI can verify that:

- the signal graph matches the intended routing,
- the task graph shows the expected parallelism,
- the C++ output reflects the expected compute structure.

## 3) Perception Axis — Hearing and Measuring

### 3.1) The perception problem

The AI has no ears. It cannot listen to audio output directly. FaustForge solves this by providing a spectral perception layer: the browser frontend continuously analyzes the audio output and publishes compact spectrum summaries to the shared state. The AI reads these summaries through MCP.

This gives the AI a form of "hearing" — not waveform-level, but frequency-domain, with features like peak frequencies, RMS level, spectral centroid, crest factor, and audio quality metrics (clipping, clicks, DC offset).

### 3.2) Starting audio

Before any perception is possible, audio must be running:

1. A human must click **ENTER** once in the browser to unlock WebAudio (browser security policy — cannot be bypassed by MCP).
2. The AI calls `run_audio("on")` to start the audio engine.
3. The AI calls `set_view("run")` to ensure the run view is active (spectrum capture requires it).

### 3.3) Reading the spectrum

The simplest perception tool is `get_spectrum()`, which returns the latest spectrum summary independently of the current view. The summary contains:

- `bandsDbQ`: per-band dB levels (quantized), giving a frequency-domain picture of the output.
- `peaks`: dominant frequency peaks with dB level and quality factor.
- `features`: spectral descriptors — `rmsDbQ`, `centroidHz`, `rolloff95Hz`, `flatnessQ`, `crestDbQ`.
- `audioQuality`: safety metrics — `peakDbFSQ`, `clipRatioQ`, `dcOffsetQ`, `clickScoreQ`.

### 3.4) Acting and measuring in one step

The most powerful interaction pattern combines an action (parameter change, button press, MIDI note) with an immediate spectrum capture. This is the AI's equivalent of "turn the knob and listen":

| Tool                                | Action                  | Perception                          |
|-------------------------------------|-------------------------|-------------------------------------|
| `set_run_param_and_get_spectrum`    | Change a continuous param | Capture spectrum series + aggregate |
| `trigger_button_and_get_spectrum`   | Press/release a button  | Capture transient spectrum          |
| `midi_note_on_and_get_spectrum`     | Play a note (sustain)   | Capture note onset spectrum         |
| `midi_note_off_and_get_spectrum`    | Release a note          | Capture release/decay spectrum      |
| `midi_note_pulse_and_get_spectrum`  | Play a note (one-shot)  | Capture full note lifecycle         |

Each of these tools returns:

- a **time series** of spectrum summaries captured over a configurable window,
- a **max-hold aggregate** summary (peak envelope across all frames),
- an optional **delta** (difference between first and last frame features).

This gives the AI temporal resolution: it can observe how the spectrum evolves after an action, detect transients, and compare before/after states.

### 3.5) Parameter interaction model

The AI discovers available parameters via `get_run_ui()` (returns the Faust UI JSON tree with paths, ranges, and types) and reads current values via `get_run_params()`.

Three parameter types require different interaction strategies:

- **Continuous** (`hslider`, `vslider`, `nentry`): set once, value persists. Use `set_run_param` or `set_run_param_and_get_spectrum`.
- **Button**: requires a full press/release cycle. Use `trigger_button` (safe cycle) rather than manual `set_run_param(path, 1)` / `set_run_param(path, 0)`.
- **Checkbox**: toggles between 0 and 1, value persists.

### 3.6) Polyphony and MIDI

For polyphonic DSP programs (synths, instruments), the AI can:

- Query and set polyphony with `get_polyphony()` / `set_polyphony(voices)`.
- Send MIDI events: `midi_note_on`, `midi_note_off`, `midi_note_pulse`.
- Combine MIDI with spectrum capture for tonal analysis.

Convention: `voices = 0` means mono mode (no voice allocation). Polyphonic mode requires `voices >= 1`.

### 3.7) Audio quality interpretation

The spectrum summary includes `audioQuality` metrics that the AI should monitor:

| Metric         | Warning threshold | Severe threshold | Meaning                       |
|----------------|-------------------|------------------|-------------------------------|
| `clipRatioQ`   | > 1               | > 5              | Clipping (per-mille)          |
| `clickScoreQ`  | > 20              | > 40             | Click/pop artifacts           |
| `peakDbFSQ`    | >= -1             | —                | Near full scale               |
| `dcOffsetQ`    | > 0               | —                | Non-zero DC component         |

The AI should flag severe clipping and click risk unless the user explicitly accepts them.

## 4) Combined Workflow

The full power of MCP interaction emerges when both axes are used together in a design loop:

```
    ┌─────────────────────────────────────────┐
    │                                         │
    │  ┌─────────┐    ┌──────────┐            │
    │  │  WRITE   │───▶│  SUBMIT  │            │
    │  │  code    │    │  + check │            │
    │  └─────────┘    └────┬─────┘            │
    │                      │                  │
    │                 ┌────▼─────┐            │
    │                 │  LISTEN   │            │
    │                 │  spectrum │            │
    │                 └────┬─────┘            │
    │                      │                  │
    │                 ┌────▼─────┐            │
    │                 │  TWEAK    │            │
    │                 │  params   │────────────┘
    │                 └────┬─────┘
    │                      │
    │                 ┌────▼─────┐
    │                 │ EVALUATE  │
    │                 │ quality   │
    │                 └──────────┘
    │
    └── iterate if needed
```

### 4.1) Example: designing a filter

1. **Discover**: `search_faust_lib("lowpass")` → find `fi.lowpass`.
2. **Learn**: `get_faust_symbol("fi.lowpass")` → read usage, params, I/O.
3. **Write**: compose a DSP program using `fi.lowpass` with exposed `freq` and `Q` parameters.
4. **Submit**: `submit(code)` → check for errors.
5. **Listen**: `run_audio("on")` → `get_run_ui()` → identify parameter paths.
6. **Explore**: `set_run_param_and_get_spectrum("/filter/freq", 1000)` → read centroid, rolloff.
7. **Sweep**: repeat with `freq = 500, 2000, 5000` → compare spectral shapes.
8. **Evaluate**: check `audioQuality` for clipping, adjust gain if needed.
9. **Iterate**: modify the DSP code (add saturation, change topology) → resubmit → relisten.

### 4.2) Example: testing a polyphonic synth

1. **Write**: compose a polyphonic DSP with `freq`, `gate`, `gain` convention.
2. **Submit**: `submit(code)` → `set_polyphony(4)`.
3. **Play**: `midi_note_pulse_and_get_spectrum(60, 0.8, 200)` → capture the note.
4. **Analyze**: read peaks (fundamental + harmonics), crest, quality metrics.
5. **Compare**: test different notes (48, 60, 72) to verify pitch tracking.
6. **Stress**: `midi_note_on(60)` + `midi_note_on(67)` → check polyphonic behavior.
7. **Release**: `midi_note_off_and_get_spectrum(60)` → check for release clicks.

## 5) Session and Navigation

The AI shares the session space with the browser user. Both see the same active session and view.

- `list_sessions()` — browse available sessions.
- `set_session(sha1)` — switch to a specific session.
- `prev_session()` / `next_session()` — navigate sequentially.
- `get_state()` — read current session + view.

When the AI submits code, the new session becomes active for both the AI and the user. When the user drops a file in the browser, the AI sees the new session on its next state read. This shared-state model means the AI and the user collaborate on the same workspace in real time.

## 6) Onboarding

The `get_onboarding_guide()` tool returns a structured guide with:

- recommended workflow steps,
- quality thresholds,
- policy constraints (e.g. do not ignore audio quality),
- library discovery hints.

An AI client should call this tool at the start of a session to calibrate its behavior.

## 7) Limitations and Constraints

- **Audio unlock**: the browser requires one human click before audio can start. The AI cannot bypass this.
- **Spectral resolution**: the AI perceives frequency-domain summaries, not raw audio. It cannot detect phase issues, subtle stereo artifacts, or perceptual qualities that require waveform-level analysis.
- **Latency**: spectrum summaries are pushed by the frontend at ~60 Hz. MCP polling adds latency. The `settleMs` parameter on capture tools compensates for this.
- **Single active session**: only one session is active at a time. The AI cannot A/B test two sessions simultaneously — it must switch between them.
- **Shared state**: parameter changes from the AI are visible to the user and vice versa. There is no private sandbox.

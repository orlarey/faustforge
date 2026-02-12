/**
 * Vue Run
 * Exécute le DSP en WebAudio via FaustWASM
 */
import { FaustOrbitUI } from '../vendor/faust-orbit-ui/faust-orbit-ui.js';
import { TOOLTIP_TEXTS } from '../tooltip-texts.js';

let audioContext = null;
let dspNode = null;
let analyserNode = null;
let outputNode = null;
let audioRunning = false;
let scopeRafId = null;
let scopeState = null;
let currentSha = null;
let compiledGenerator = null;
let compiledGeneratorMode = 'mono';
let compiledUI = null;
let faustUIInstance = null;
let currentUiRoot = null;
let controlsBg = null;
let controlsContent = null;
let controlsSplit = null;
let controlsClassicPane = null;
let controlsOrbitPane = null;
let paramValues = {};
let uiParamPaths = [];
let uiButtonPaths = new Set();
let uiButtonOrder = [];
let lastUiButtonPath = null;
let pressedUiButtons = new Set();
let uiReleaseHandlersInstalled = false;
let uiReleaseGuardHandler = null;
let emitRunStateFn = null;
let lastSpectrumSentAt = 0;
let lastSpectrumSummary = null;
let lastAudioQuality = null;
let polyVoices = 0;
let midiTargets = null;
let activeMidiNote = null;
let midiAccess = null;
let midiSource = 'virtual';
let midiInput = null;
let midiOnly = true;
let midiKeyboardKeyDownHandler = null;
let midiKeyboardKeyUpHandler = null;
let midiKeyboardBlurHandler = null;
let midiComputerActiveNotes = new Map();
let midiUiKeyByNote = new Map();
let runSpaceKeyHandler = null;
let runSpaceKeyUpHandler = null;
let runSpaceBlurHandler = null;
let runSpacePressedPath = null;
let paramPollId = null;
let outputParamHandlerAttached = false;
let uiZoom = 'auto';
let orbitZoom = '100';
let uiZoomWrap = null;
let uiZoomStage = null;
let uiResizeObserver = null;
let remoteSyncTimer = null;
let lastRunParamsSentAt = 0;
let lastAppliedTransportNonce = 0;
let lastAppliedTriggerNonce = 0;
let lastAppliedMidiNonce = 0;
let isSwitchingPolyphony = false;
let runViewEnteredAt = 0;
let lastAppliedRemoteRunParamsUpdatedAt = 0;
let lastAppliedRemoteOrbitNonce = 0;
let orbitCanvas = null;
let orbitBody = null;
let orbitCtx = null;
let orbitState = null;
let orbitPointer = null;
let orbitNeedsDraw = false;
let orbitRafId = null;
let orbitResizeObserver = null;
let lastRunOrbitSentAt = 0;
let pendingOrbitUi = null;
let orbitBaseWidth = 0;
let orbitBaseHeight = 0;
let orbitRenderScale = 1;
let orbitRenderOffsetX = 0;
let orbitRenderOffsetY = 0;
let lastOrbitParamSyncAt = 0;
let orbitParamSyncTimer = null;
let orbitUiInstance = null;
let orbitUiBatchDepth = 0;
let orbitUiBatchSnapshotPending = false;
let remoteSyncInFlight = false;
const PARAM_SMOOTH_INTERVAL_MS = 16;
const PARAM_SMOOTH_EPSILON = 1e-4;
const ORBIT_PARAM_SYNC_INTERVAL_MS = 33;
const ORBIT_POSITION_EPSILON = 0.25;
const paramSmooth = new Map();

export function getName() {
  return 'Run';
}

export async function render(container, { sha, runState, onRunStateChange }) {
  cleanupAudio();
  currentSha = sha;
  runViewEnteredAt = Date.now();
  lastAppliedRemoteRunParamsUpdatedAt = 0;
  lastSpectrumSummary = null;
  lastAudioQuality = null;

  container.innerHTML = `
    <div class="run-view">
      <div class="run-header">
        <span class="run-note run-header-title">RUN</span>
        <div class="run-midi-inline hidden" id="run-midi-inline"></div>
        <div class="run-header-controls">
          <div class="run-header-pill">
            <span>Audio</span>
            <select id="run-audio-state" aria-label="Audio state">
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </div>
          <label class="run-header-pill">
            <span>Mode</span>
            <select id="run-mode">
              <option value="mono">Mono</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="4">4</option>
              <option value="8">8</option>
              <option value="16">16</option>
              <option value="32">32</option>
              <option value="64">64</option>
            </select>
          </label>
          <label class="run-header-pill">
            <span>MIDI</span>
            <select id="midi-input"></select>
          </label>
        </div>
      </div>
      <div class="run-controls" id="run-controls">
        <div class="info">Compiling...</div>
      </div>
      <div class="run-scope">
        <div class="run-scope-header">
          <span class="run-scope-title">Oscilloscope</span>
          <div class="run-scope-controls">
            <label class="run-scope-pill">View
              <select id="scope-view">
                <option value="time">Waveform</option>
                <option value="freq">Spectrum</option>
              </select>
            </label>
            <label class="run-scope-pill">Scale
              <select id="scope-scale">
                <option value="log">Log</option>
                <option value="linear">Linear</option>
              </select>
            </label>
            <label class="run-scope-pill">Trigger
              <select id="scope-mode">
                <option value="auto">Auto</option>
                <option value="normal">Normal</option>
              </select>
            </label>
            <label class="run-scope-pill">Slope
              <select id="scope-slope">
                <option value="rising">Rising</option>
                <option value="falling">Falling</option>
              </select>
            </label>
            <label class="run-scope-pill">Threshold
              <input id="scope-threshold" class="scope-input" type="number" step="0.01" value="0.0">
            </label>
            <label class="run-scope-pill">Holdoff (ms)
              <input id="scope-holdoff" class="scope-input" type="number" step="1" value="20">
            </label>
          </div>
        </div>
        <canvas id="scope-canvas" width="640" height="160"></canvas>
      </div>
    </div>
  `;

  const audioStateSelect = container.querySelector('#run-audio-state');
  const modeSelect = container.querySelector('#run-mode');
  const midiInputSelect = container.querySelector('#midi-input');
  const midiInlineEl = container.querySelector('#run-midi-inline');
  const controlsEl = container.querySelector('#run-controls');
  const scopeCanvas = container.querySelector('#scope-canvas');
  const scopeView = container.querySelector('#scope-view');
  const scopeScale = container.querySelector('#scope-scale');
  const scopeMode = container.querySelector('#scope-mode');
  const scopeSlope = container.querySelector('#scope-slope');
  const scopeThreshold = container.querySelector('#scope-threshold');
  const scopeHoldoff = container.querySelector('#scope-holdoff');
  const noteEl = container.querySelector('.run-note');
  let audioLocked = false;
  const setAudioToggleState = (isOn) => {
    if (!audioStateSelect) return;
    audioStateSelect.value = isOn ? 'on' : 'off';
  };

  function updateRunNote() {
    if (!noteEl) return;
    noteEl.textContent = 'RUN';
    noteEl.classList.toggle('run-note-locked', audioLocked);
    noteEl.title = audioLocked ? 'Audio is locked in this browser tab' : 'Run view';
  }

  function setAudioLocked(locked) {
    audioLocked = !!locked;
    updateRunNote();
  }

  updateRunNote();

  scopeState = createScopeState(scopeCanvas);
  applyRunState(runState, {
    scopeView,
    scopeScale,
    scopeMode,
    scopeSlope,
    scopeThreshold,
    scopeHoldoff,
    modeSelect,
    midiInputSelect
  });
  // Keep control labels aligned with effective internal scope state.
  scopeView.value = scopeState.view;
  scopeScale.value = scopeState.spectrumScale;
  scopeMode.value = scopeState.mode;
  scopeSlope.value = scopeState.slope;
  scopeThreshold.value = String(scopeState.threshold);
  scopeHoldoff.value = String(scopeState.holdoffMs);
  paramValues = runState && runState.params ? { ...runState.params } : {};
  pendingOrbitUi = runState && runState.orbitUi ? runState.orbitUi : null;
  const emitRunState = () => {
    if (typeof onRunStateChange === 'function') {
      onRunStateChange(getState());
    }
  };
  emitRunStateFn = emitRunState;
  scopeView.addEventListener('change', () => {
    scopeState.view = scopeView.value;
    emitRunState();
  });
  scopeScale.addEventListener('change', () => {
    scopeState.spectrumScale = scopeScale.value;
    emitRunState();
  });
  scopeMode.addEventListener('change', () => {
    scopeState.mode = scopeMode.value;
    emitRunState();
  });
  scopeSlope.addEventListener('change', () => {
    scopeState.slope = scopeSlope.value;
    emitRunState();
  });
  scopeThreshold.addEventListener('change', () => {
    scopeState.threshold = parseFloat(scopeThreshold.value);
    emitRunState();
  });
  scopeHoldoff.addEventListener('change', () => {
    scopeState.holdoffMs = parseFloat(scopeHoldoff.value);
    emitRunState();
  });

  const renderInlineVirtualKeyboard = () => {
    if (!midiInlineEl) return;
    renderMidiKeyboard(midiInlineEl, compiledUI, {
      noteOn: async (note, velocity) => {
        if (!audioRunning) await startAudio();
        noteOnMidi(note, velocity);
      },
      noteOff: (note) => noteOffMidi(note)
    }, { compact: true, showHint: false, showEmptyMessage: false });
  };

  const updateMidi = async () => {
    if (!midiInlineEl) return;
    if (polyVoices > 0) {
      renderInlineVirtualKeyboard();
      if (midiSource === 'virtual') {
        midiInlineEl.classList.remove('hidden');
      } else {
        midiInlineEl.classList.add('hidden');
        midiInlineEl.innerHTML = '';
        detachComputerMidiKeyboard();
      }
    } else {
      midiInlineEl.classList.add('hidden');
      midiInlineEl.innerHTML = '';
      detachComputerMidiKeyboard();
      noteOffMidi();
    }
    await updateMidiSourceUi();
  };

  const updateMidiSourceUi = async (selectedValue = null) => {
    if (!midiInputSelect) return;
    const preferred =
      selectedValue || midiSource || midiInputSelect.value || 'virtual';
    await refreshMidiInputs(midiInputSelect, preferred);
    const value = midiInputSelect.value || preferred || 'virtual';
    midiSource = value;
    if (value === 'virtual') {
      disconnectMidiDevice();
      if (polyVoices > 0) {
        midiInlineEl.classList.remove('hidden');
        if (!midiInlineEl.firstElementChild) {
          renderInlineVirtualKeyboard();
        }
      }
    } else {
      midiInlineEl.classList.add('hidden');
      midiInlineEl.innerHTML = '';
      detachComputerMidiKeyboard();
      await selectMidiDevice(value);
    }
    midiOnly = true;
  };

  async function publishPolyphonyState() {
    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runPolyphony: polyVoices })
      });
    } catch {
      // ignore
    }
  }

  async function applyPolyphonyChange(nextVoices) {
    if (isSwitchingPolyphony) return;
    const allowed = new Set([0, 1, 2, 4, 8, 16, 32, 64]);
    const normalized = Math.max(0, Math.round(Number(nextVoices) || 0));
    const safeVoices = allowed.has(normalized) ? normalized : 0;
    if (safeVoices === polyVoices) return;
    isSwitchingPolyphony = true;
    polyVoices = safeVoices;
    modeSelect.value = polyVoices > 0 ? String(polyVoices) : 'mono';
    audioStateSelect.disabled = true;
    setAudioToggleState(audioRunning);
    emitRunState();
    const wasRunning = audioRunning;
    try {
      cleanupAudio();
      compiledGenerator = null;
      compiledGeneratorMode = 'mono';
      await compileAndRenderUI(controlsEl, sha, polyVoices);
      await updateMidi();
      await publishPolyphonyState();
      if (wasRunning) {
        await startAudio();
      } else {
        setAudioToggleState(false);
      }
    } finally {
      audioStateSelect.disabled = false;
      isSwitchingPolyphony = false;
    }
  }

  midiInputSelect.addEventListener('change', async () => {
    await updateMidiSourceUi(midiInputSelect.value);
    emitRunState();
  });

  modeSelect.addEventListener('change', async () => {
    const value = modeSelect.value;
    const voices = value === 'mono' ? 0 : Math.max(1, parseInt(value, 10));
    await applyPolyphonyChange(voices);
  });

  const prepared = prepareControlsContainer(controlsEl);
  controlsBg = prepared.bg;
  controlsContent = prepared.content;
  controlsContent.innerHTML = '<div class="info">Compiling...</div>';

  audioStateSelect.disabled = true;
  setAudioToggleState(audioRunning);

  try {
    await compileAndRenderUI(controlsEl, sha, polyVoices);
    await updateMidi();
    setAudioToggleState(audioRunning);
  } catch (err) {
    setAudioToggleState(false);
    const message = err && err.message ? err.message : String(err);
    controlsContent.innerHTML = `<div class="error">Error: ${message}</div>`;
  } finally {
    audioStateSelect.disabled = false;
  }

  const startAudio = async () => {
    if (audioRunning) return;
    audioStateSelect.disabled = true;
    setAudioToggleState(false);

    try {
      const desiredMode = polyVoices > 0 ? `poly:${polyVoices}` : 'mono';
      if (!compiledGenerator || compiledGeneratorMode !== desiredMode) {
        await compileAndRenderUI(controlsEl, sha, polyVoices);
      }
      if (!compiledGenerator) {
        throw new Error('Compilation failed');
      }

      if (!audioContext) {
        audioContext = new AudioContext();
        dspNode =
          polyVoices > 0
            ? await compiledGenerator.createNode(audioContext, polyVoices)
            : await compiledGenerator.createNode(audioContext);
        attachOutputParamHandler();
        outputNode = setupScope(audioContext, dspNode, scopeState);
      }
      applyParamValues();
      await resumeAudioContext();
      setAudioLocked(false);
      startAudioOutput();
      startParamPolling();

      setAudioToggleState(true);
      emitRunState();
    } catch (err) {
      console.error('Run view error:', err);
      const message = err && err.message ? err.message : String(err);
      const isLocked =
        typeof message === 'string' &&
        message.toLowerCase().includes('audio start blocked by browser policy');
      if (isLocked) {
        setAudioLocked(true);
      }
      cleanupAudio();
      setAudioToggleState(false);
      const stack = err && err.stack ? err.stack : '';
      controlsContent.innerHTML = `
        <div class="error">Error: ${message}</div>
        <pre class="run-stack">${stack}</pre>
      `;
    } finally {
      audioStateSelect.disabled = false;
    }
  };

  const stopAudio = () => {
    if (!audioRunning) return;
    stopAudioOutput();
    noteOffMidi();
    stopParamPolling();
    setAudioToggleState(false);
    emitRunState();
  };

  audioStateSelect.addEventListener('change', async () => {
    if (audioStateSelect.disabled) return;
    if (audioStateSelect.value === 'on') {
      await startAudio();
    } else {
      stopAudio();
    }
  });

  const handleRunAreaClick = async (event) => {
    if (audioStateSelect.disabled) return;
    const target = event.target;
    const inUiRoot = !!(currentUiRoot && target instanceof Element && currentUiRoot.contains(target));
    const inOrbit = !!(controlsOrbitPane && target instanceof Element && controlsOrbitPane.contains(target));
    if (inUiRoot || inOrbit) {
      return;
    }
    if (audioRunning) {
      stopAudio();
    } else {
      await startAudio();
    }
  };

  controlsEl.addEventListener('click', handleRunAreaClick);

  remoteSyncTimer = setInterval(syncRemoteRunState, 120);
  await syncRemoteRunState();

  await updateMidi();
  if (runState && runState.audioRunning) {
    await startAudio();
  }
  await publishPolyphonyState();
  emitRunState();

  async function executeRemoteMidi(runMidi) {
    if (!runMidi || typeof runMidi !== 'object') return;
    const action = runMidi.action;
    const note =
      typeof runMidi.note === 'number' && Number.isFinite(runMidi.note)
        ? Math.max(0, Math.min(127, Math.round(runMidi.note)))
        : 60;
    const velocity =
      typeof runMidi.velocity === 'number' && Number.isFinite(runMidi.velocity)
        ? Math.max(0, Math.min(1, runMidi.velocity))
        : 0.8;
    const holdMs =
      typeof runMidi.holdMs === 'number' && Number.isFinite(runMidi.holdMs)
        ? Math.max(1, Math.min(5000, Math.round(runMidi.holdMs)))
        : 120;
    if (action === 'on') {
      if (!audioRunning) await startAudio();
      noteOnMidi(note, velocity);
      return;
    }
    if (action === 'off') {
      noteOffMidi(note);
      return;
    }
    if (action === 'pulse') {
      if (!audioRunning) await startAudio();
      noteOnMidi(note, velocity);
      await sleep(holdMs);
      noteOffMidi(note);
    }
  }

async function syncRemoteRunState() {
    if (!currentSha) return;
    if (remoteSyncInFlight) return;
    remoteSyncInFlight = true;
    try {
      const response = await fetch('/api/state');
      if (!response.ok) return;
      const remote = await response.json();
      if (!remote || remote.sha1 !== currentSha) return;

      if (remote.runParams && typeof remote.runParams === 'object') {
        const remoteParamsUpdatedAt =
          typeof remote.runParamsUpdatedAt === 'number' ? remote.runParamsUpdatedAt : 0;
        if (!remoteParamsUpdatedAt || remoteParamsUpdatedAt > lastAppliedRemoteRunParamsUpdatedAt) {
          applyRemoteRunParams(remote.runParams);
          if (remoteParamsUpdatedAt) {
            lastAppliedRemoteRunParamsUpdatedAt = remoteParamsUpdatedAt;
          }
        }
      }

      if (remote.runTransport && typeof remote.runTransport.nonce === 'number') {
        const cmd = remote.runTransport;
        if (cmd.nonce !== lastAppliedTransportNonce) {
          lastAppliedTransportNonce = cmd.nonce;
          if (!isSwitchingPolyphony) {
            if (cmd.action === 'start') {
              if (!audioRunning) await startAudio();
            } else if (cmd.action === 'stop') {
              if (audioRunning) stopAudio();
            } else if (cmd.action === 'toggle') {
              if (audioRunning) {
                stopAudio();
              } else {
                await startAudio();
              }
            }
          } else {
            // Re-apply later once polyphony switch is complete.
            lastAppliedTransportNonce = cmd.nonce - 1;
          }
        }
      }

      if (typeof remote.runPolyphony === 'number' && Number.isFinite(remote.runPolyphony)) {
        const remoteVoices = Math.max(0, Math.round(remote.runPolyphony));
        if (remoteVoices !== polyVoices) {
          await applyPolyphonyChange(remoteVoices);
        }
      }

      if (remote.runTrigger && typeof remote.runTrigger.nonce === 'number') {
        const trigger = remote.runTrigger;
        if (trigger.nonce !== lastAppliedTriggerNonce && trigger.nonce >= runViewEnteredAt) {
          lastAppliedTriggerNonce = trigger.nonce;
          await executeLocalTrigger(trigger.path, trigger.holdMs);
        }
      }

      if (remote.runMidi && typeof remote.runMidi.nonce === 'number') {
        const cmd = remote.runMidi;
        if (cmd.nonce !== lastAppliedMidiNonce && cmd.nonce >= runViewEnteredAt) {
          lastAppliedMidiNonce = cmd.nonce;
          await executeRemoteMidi(cmd);
        }
      }

      if (remote.runOrbitUi && typeof remote.runOrbitUi === 'object') {
        const nonce =
          typeof remote.runOrbitUi.nonce === 'number'
            ? remote.runOrbitUi.nonce
            : 0;
        if (nonce > lastAppliedRemoteOrbitNonce) {
          lastAppliedRemoteOrbitNonce = nonce;
          applyRemoteOrbitUi(remote.runOrbitUi);
        }
      }
    } catch {
      // ignore sync errors
    } finally {
      remoteSyncInFlight = false;
    }
  }
}

export function getState() {
  if (!scopeState) return null;
  return {
    audioRunning,
    polyVoices,
    midiSource,
    uiZoom,
    orbitZoom,
    scope: {
      view: scopeState.view,
      spectrumScale: scopeState.spectrumScale,
      mode: scopeState.mode,
      slope: scopeState.slope,
      threshold: scopeState.threshold,
      holdoffMs: scopeState.holdoffMs
    },
    params: { ...paramValues },
    orbitUi: buildRunOrbitSnapshot(false)
  };
}

async function compileAndRenderUI(container, sha, voices = 0) {
  const codeResponse = await fetch(`/api/${sha}/user_code.dsp`);
  if (!codeResponse.ok) {
    throw new Error('DSP code not found');
  }
  const code = await codeResponse.text();

  const {
    FaustCompiler,
    LibFaust,
    FaustMonoDspGenerator,
    FaustPolyDspGenerator,
    instantiateFaustModuleFromFile
  } = await import('../vendor/faustwasm/index.js');

  const base = `${window.location.origin}/libfaust-wasm/libfaust-wasm.js`;
  const module = await instantiateFaustModuleFromFile(
    base,
    base.replace(/\.js$/, '.data'),
    base.replace(/\.js$/, '.wasm')
  );
  const compiler = new FaustCompiler(new LibFaust(module));
  const generator = voices > 0 ? new FaustPolyDspGenerator() : new FaustMonoDspGenerator();
  const compiled = await generator.compile(compiler, 'dsp', code, '-ftz 2');
  if (!compiled) {
    throw new Error('Compilation failed');
  }

  compiledGenerator = generator;
  compiledGeneratorMode = voices > 0 ? `poly:${voices}` : 'mono';
  compiledUI = generator.getUI();
  seedParamValuesFromUiDefaults(compiledUI);
  uiParamPaths = collectParamPaths(compiledUI);
  uiButtonOrder = collectButtonPaths(compiledUI);
  uiButtonPaths = new Set(uiButtonOrder);
  if (lastUiButtonPath && !uiButtonPaths.has(lastUiButtonPath)) {
    lastUiButtonPath = null;
  }
  const hadLatchedButtons = normalizeLatchedButtonParams();
  pressedUiButtons.clear();
  if (hadLatchedButtons) {
    // Persist normalization so first Run entry does not replay stale button=1 state.
    sendRunParamsSnapshot(true);
  }
  try {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui: compiledUI })
    });
  } catch {
    // ignore
  }
  const prepared = prepareControlsContainer(container);
  controlsBg = prepared.bg;
  controlsContent = prepared.content;
  controlsSplit = prepared.split;
  controlsClassicPane = prepared.classicPane;
  controlsOrbitPane = prepared.orbitPane;
  renderControls(controlsContent, compiledUI);
  updateUiRoot(controlsContent);
}

function renderControls(container, ui) {
  if (Array.isArray(ui) && ui.length > 0) {
    renderFaustUi(controlsClassicPane || container, ui);
    renderOrbitUi(controlsOrbitPane || container, ui);
    return;
  }

  container.innerHTML = '<div class="info">No parameters.</div>';
  updateUiRoot(container);
}

function collectParamPaths(ui) {
  if (!Array.isArray(ui)) return [];
  const paths = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.items) node.items.forEach(walk);
    const address = node.address || node.path;
    if (node.type && address) {
      paths.push(address);
    }
  };
  walk(ui);
  return paths;
}

function seedParamValuesFromUiDefaults(ui) {
  if (!Array.isArray(ui)) return;
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Array.isArray(node.items)) node.items.forEach(walk);
    const path = node.address || node.path;
    if (!path) return;
    const init = node.init;
    if (!Number.isFinite(init)) return;
    if (typeof paramValues[path] === 'number' && Number.isFinite(paramValues[path])) return;
    paramValues[path] = Number(init);
  };
  walk(ui);
}

function renderMidiKeyboard(container, ui, handlers, options = {}) {
  if (!container) return;
  detachComputerMidiKeyboard();
  const compact = options && options.compact === true;
  const showHint = options ? options.showHint !== false : true;
  const showEmptyMessage = options ? options.showEmptyMessage !== false : true;
  const targets = findMidiTargets(ui);
  midiTargets = targets;
  container.innerHTML = '';

  if (!targets || (!targets.freq && !targets.key && !targets.gate)) {
    if (showEmptyMessage) {
      container.innerHTML = '<div class="info">No MIDI parameters detected.</div>';
    }
    return;
  }

  const keyboard = document.createElement('div');
  keyboard.className = compact ? 'midi-keyboard midi-keyboard-compact' : 'midi-keyboard';
  const notes = [
    { note: 60, label: 'C4', black: false },
    { note: 61, label: 'C#', black: true },
    { note: 62, label: 'D', black: false },
    { note: 63, label: 'D#', black: true },
    { note: 64, label: 'E', black: false },
    { note: 65, label: 'F', black: false },
    { note: 66, label: 'F#', black: true },
    { note: 67, label: 'G', black: false },
    { note: 68, label: 'G#', black: true },
    { note: 69, label: 'A', black: false },
    { note: 70, label: 'A#', black: true },
    { note: 71, label: 'B', black: false }
  ];

  notes.forEach((entry) => {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = `midi-key ${entry.black ? 'black' : 'white'}`;
    key.dataset.note = String(entry.note);
    key.textContent = entry.label;
    keyboard.appendChild(key);
    midiUiKeyByNote.set(entry.note, key);
  });

  const noteOn = async (note) => {
    if (activeMidiNote !== null) return;
    activeMidiNote = note;
    setMidiUiKeyActive(note, true);
    if (handlers && handlers.noteOn) {
      await handlers.noteOn(note, 0.8);
    }
  };
  const noteOff = () => {
    if (activeMidiNote === null) return;
    const note = activeMidiNote;
    activeMidiNote = null;
    setMidiUiKeyActive(note, false);
    if (handlers && handlers.noteOff) {
      handlers.noteOff(note);
    }
  };

  const onPointerDown = async (event) => {
    const key = event.target.closest('.midi-key');
    if (!key) return;
    event.preventDefault();
    key.setPointerCapture(event.pointerId);
    const note = parseInt(key.dataset.note, 10);
    await noteOn(note);
  };
  const onPointerUp = (event) => {
    const key = event.target.closest('.midi-key');
    if (key) {
      key.releasePointerCapture(event.pointerId);
    }
    noteOff();
  };

  keyboard.addEventListener('pointerdown', onPointerDown);
  keyboard.addEventListener('pointerup', onPointerUp);
  keyboard.addEventListener('pointercancel', () => {
    noteOff();
  });

  let octaveShift = 0;
  const baseNote = 60; // C4
  const keyToSemitone = {
    KeyA: 0,
    KeyW: 1,
    KeyS: 2,
    KeyE: 3,
    KeyD: 4,
    KeyF: 5,
    KeyT: 6,
    KeyG: 7,
    KeyY: 8,
    KeyH: 9,
    KeyU: 10,
    KeyJ: 11
  };

  midiKeyboardKeyDownHandler = (event) => {
    if (event.repeat) return;
    if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
    const pressedKey = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (pressedKey === 'z' || pressedKey === 'x') {
      event.preventDefault();
      if (pressedKey === 'z') {
        if (octaveShift > -4) {
          releaseComputerMidiNotes(handlers);
          octaveShift -= 1;
          updateMidiHint();
        }
      } else if (octaveShift < 4) {
        releaseComputerMidiNotes(handlers);
        octaveShift += 1;
        updateMidiHint();
      }
      return;
    }
    const semitone = keyToSemitone[event.code];
    if (!Number.isFinite(semitone)) return;
    const note = Math.max(0, Math.min(127, baseNote + semitone + octaveShift * 12));
    if (!Number.isFinite(note)) return;
    event.preventDefault();
    if (midiComputerActiveNotes.has(event.code)) return;
    midiComputerActiveNotes.set(event.code, note);
    setMidiUiKeyActive(note, true);
    if (handlers && handlers.noteOn) {
      Promise.resolve(handlers.noteOn(note, 0.8)).catch(() => {});
    }
  };

  midiKeyboardKeyUpHandler = (event) => {
    const note = midiComputerActiveNotes.get(event.code);
    if (!Number.isFinite(note)) return;
    event.preventDefault();
    midiComputerActiveNotes.delete(event.code);
    setMidiUiKeyActive(note, false);
    if (handlers && handlers.noteOff) {
      handlers.noteOff(note);
    }
  };

  midiKeyboardBlurHandler = () => {
    releaseComputerMidiNotes(handlers);
  };

  window.addEventListener('keydown', midiKeyboardKeyDownHandler);
  window.addEventListener('keyup', midiKeyboardKeyUpHandler);
  window.addEventListener('blur', midiKeyboardBlurHandler);

  let hint = null;
  if (showHint) {
    hint = document.createElement('div');
    hint.className = 'midi-hint';
  }
  const updateMidiHint = () => {
    if (!hint) return;
    const low = baseNote + octaveShift * 12;
    const high = low + 11;
    const octaveLabel = 4 + octaveShift;
    hint.textContent = `Click to play or keyboard: A W S E D F T G Y H U J (${low}-${high}, C${octaveLabel}-B${octaveLabel}). Octave: Z/X.`;
  };
  updateMidiHint();

  container.appendChild(keyboard);
  if (hint) {
    container.appendChild(hint);
  }
}

function setMidiUiKeyActive(note, active) {
  const key = midiUiKeyByNote.get(note);
  if (!key) return;
  key.classList.toggle('active', active);
}

function releaseComputerMidiNotes(handlers) {
  const notes = new Set(midiComputerActiveNotes.values());
  midiComputerActiveNotes.clear();
  for (const note of notes) {
    setMidiUiKeyActive(note, false);
    if (handlers && handlers.noteOff) {
      handlers.noteOff(note);
    }
  }
}

function detachComputerMidiKeyboard() {
  if (midiKeyboardKeyDownHandler) {
    window.removeEventListener('keydown', midiKeyboardKeyDownHandler);
    midiKeyboardKeyDownHandler = null;
  }
  if (midiKeyboardKeyUpHandler) {
    window.removeEventListener('keyup', midiKeyboardKeyUpHandler);
    midiKeyboardKeyUpHandler = null;
  }
  if (midiKeyboardBlurHandler) {
    window.removeEventListener('blur', midiKeyboardBlurHandler);
    midiKeyboardBlurHandler = null;
  }
  const notes = new Set(midiComputerActiveNotes.values());
  midiComputerActiveNotes.clear();
  for (const note of notes) {
    noteOffMidi(note);
  }
  for (const key of midiUiKeyByNote.values()) {
    key.classList.remove('active');
  }
  midiUiKeyByNote.clear();
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

async function renderFaustUi(container, ui) {
  ensureFaustUiCss();
  container.innerHTML = `
    <div class="regular-wrap">
      <div class="regular-header">
        <span class="regular-title">Regular UI</span>
        <div class="regular-zoom-wrap">
          <div class="regular-zoom-group" aria-label="Regular UI zoom selector">
            <span class="regular-zoom-label">Zoom</span>
            <select class="regular-zoom">
              <option value="auto">Auto</option>
              <option value="50">50%</option>
              <option value="75">75%</option>
              <option value="100">100%</option>
              <option value="125">125%</option>
              <option value="150">150%</option>
            </select>
          </div>
        </div>
      </div>
      <div class="regular-content"><div class="info">Loading UI...</div></div>
    </div>
  `;
  const regularContent = container.querySelector('.regular-content') || container;
  const regularZoomSelect = container.querySelector('.regular-zoom');
  if (regularZoomSelect) {
    regularZoomSelect.value = uiZoom;
    regularZoomSelect.addEventListener('change', () => {
      uiZoom = regularZoomSelect.value;
      applyUiZoom();
      if (emitRunStateFn) emitRunStateFn();
    });
  }

  try {
    const { FaustUI } = await import('../vendor/faust-ui/index.js');
    regularContent.innerHTML = '';
    const zoomWrap = document.createElement('div');
    zoomWrap.className = 'run-ui-zoom-wrap';
    const stage = document.createElement('div');
    stage.className = 'run-ui-zoom-stage';
    const uiRoot = document.createElement('div');
    uiRoot.className = 'faust-ui-root';
    stage.appendChild(uiRoot);
    zoomWrap.appendChild(stage);
    regularContent.appendChild(zoomWrap);
    uiZoomWrap = zoomWrap;
    uiZoomStage = stage;
    currentUiRoot = uiRoot;

    faustUIInstance = new FaustUI({
      root: uiRoot,
      ui,
      listenWindowMessage: false,
      listenWindowResize: true
    });

    faustUIInstance.paramChangeByUI = (path, value) => {
      try {
        let forceSnapshot = false;
        const isButton = uiButtonPaths.has(path);
        if (uiButtonPaths.has(path)) {
          forceSnapshot = true;
          if (value > 0) {
            pressedUiButtons.add(path);
            lastUiButtonPath = path;
          } else {
            pressedUiButtons.delete(path);
          }
        }
        setParamValue(path, value, {
          smooth: !isButton,
          skipSnapshot: isButton
        });
        if (forceSnapshot) {
          sendRunParamsSnapshot(true);
        }
      } catch {
        // ignore
      }
    };

    applyParamValues();
    resetUiButtonsToZero();
    installUiReleaseGuard();
    installRunSpaceShortcut();
    setupUiZoomObserver();
    applyUiZoom();
  } catch (err) {
    console.error('Faust UI render error:', err);
    regularContent.innerHTML = '<div class="error">Failed to load Faust UI.</div>';
    updateUiRoot(regularContent);
  }
}

function renderOrbitUi(container, ui) {
  if (!container) return;
  if (orbitUiInstance) {
    orbitUiInstance.destroy();
    orbitUiInstance = null;
  }

  orbitUiInstance = new FaustOrbitUI(
    container,
    (path, value) => {
      const isButton = uiButtonPaths.has(path);
      setParamValue(path, value, {
        smooth: !isButton,
        skipSnapshot: true,
        skipEmit: true,
        skipOrbitSync: true
      });
      if (orbitUiBatchDepth > 0) {
        orbitUiBatchSnapshotPending = true;
      } else {
        sendRunParamsSnapshot();
      }
      if (emitRunStateFn) emitRunStateFn();
    },
    {
      tooltips: TOOLTIP_TEXTS.orbit,
      onInteractionStart: () => {
        orbitUiBatchDepth += 1;
      },
      onInteractionEnd: () => {
        orbitUiBatchDepth = Math.max(0, orbitUiBatchDepth - 1);
        if (orbitUiBatchDepth === 0 && orbitUiBatchSnapshotPending) {
          orbitUiBatchSnapshotPending = false;
          sendRunParamsSnapshot(true);
        }
      },
      onOrbitStateChange: (state) => {
        orbitZoom = String(Math.round(state.zoom));
        sendRunOrbitSnapshot();
        if (emitRunStateFn) emitRunStateFn();
      }
    }
  );

  orbitUiInstance.beginUpdate();
  try {
    let nextState = orbitUiInstance.buildControlsFromUnknown(ui);
    if (pendingOrbitUi && typeof pendingOrbitUi === 'object') {
      nextState = mergeRemoteOrbitState(nextState, pendingOrbitUi);
    }
    const parsedZoom = parseInt(orbitZoom, 10);
    nextState.zoom = Number.isFinite(parsedZoom) ? parsedZoom : 100;
    orbitUiInstance.setOrbitState(nextState);
    orbitZoom = String(Math.round(orbitUiInstance.getZoom()));
    pendingOrbitUi = null;
  } finally {
    orbitUiInstance.endUpdate();
  }

  requestOrbitSyncFromParams(true);
  sendRunOrbitSnapshot(true);
}

function collectOrbitSliders(ui) {
  if (!Array.isArray(ui)) return [];
  const sliders = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Array.isArray(node.items)) node.items.forEach(walk);
    const type = node.type;
    const path = node.address || node.path;
    if (!path) return;
    if (type !== 'hslider' && type !== 'vslider' && type !== 'nentry') return;
    const min = Number.isFinite(node.min) ? Number(node.min) : 0;
    const max = Number.isFinite(node.max) ? Number(node.max) : 1;
    if (max <= min) return;
    sliders.push({
      path,
      label: String(node.label || path.split('/').filter(Boolean).pop() || path),
      min,
      max,
      step: Number.isFinite(node.step) ? Number(node.step) : 0,
      color: colorFromPath(path)
    });
  };
  walk(ui);
  return sliders;
}

function colorFromPath(path) {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 68% 62%)`;
}

function shouldAutoDisableOrbitSlider(slider) {
  if (!slider) return false;
  if (polyVoices <= 0) return false;
  const text = `${slider.path || ''} ${slider.label || ''}`.toLowerCase();
  return /(^|[^a-z])(freq|frequency|hz|pitch|gain|amp|velocity|vel)([^a-z]|$)/.test(text);
}

function isOrbitSliderDisabled(path) {
  return !!(orbitState && orbitState.disabledPaths && orbitState.disabledPaths.has(path));
}

function toggleOrbitSliderDisabled(path) {
  if (!orbitState || !path) return false;
  if (!orbitState.disabledPaths) {
    orbitState.disabledPaths = new Set();
  }
  if (orbitState.disabledPaths.has(path)) {
    orbitState.disabledPaths.delete(path);
    requestOrbitSyncFromParams(true);
    return false;
  }
  orbitState.disabledPaths.add(path);
  return true;
}

function setupOrbitCanvasResize() {
  teardownOrbitCanvasResize();
  if (!orbitCanvas) return;
  orbitResizeObserver = new ResizeObserver(() => {
    const resized = resizeOrbitCanvas();
    if (!resized) return;
    if (orbitState) {
      orbitState.width = orbitBaseWidth || orbitState.width;
      orbitState.height = orbitBaseHeight || orbitState.height;
      orbitState.center.x = clamp(orbitState.center.x, 0, orbitState.width);
      orbitState.center.y = clamp(orbitState.center.y, 0, orbitState.height);
      ensureOrbitRadii();
      constrainOrbitPositions();
      scheduleOrbitDraw();
    }
  });
  orbitResizeObserver.observe(orbitCanvas);
  resizeOrbitCanvas();
}

function teardownOrbitCanvasResize() {
  if (orbitResizeObserver) {
    orbitResizeObserver.disconnect();
    orbitResizeObserver = null;
  }
}

function resizeOrbitCanvas(options = {}) {
  if (!orbitCanvas || !orbitCtx || !orbitBody) return false;
  const keepViewportCenter = !!options.keepViewportCenter;
  const oldScale = orbitRenderScale || 1;
  const oldOffsetX = orbitRenderOffsetX || 0;
  const oldOffsetY = orbitRenderOffsetY || 0;
  const centerWorldX = ((orbitBody.scrollLeft + (orbitBody.clientWidth / 2)) - oldOffsetX) / oldScale;
  const centerWorldY = ((orbitBody.scrollTop + (orbitBody.clientHeight / 2)) - oldOffsetY) / oldScale;
  const dpr = window.devicePixelRatio || 1;
  const rawWidth = orbitBody.clientWidth || 0;
  const rawHeight = orbitBody.clientHeight || 0;
  // Ignore transient hidden/collapsed layout states to avoid collapsing orbit
  // dimensions and snapping center to top-left.
  if (rawWidth < 2 || rawHeight < 2) return false;
  const baseWidth = rawWidth;
  const baseHeight = rawHeight;
  orbitBaseWidth = baseWidth;
  orbitBaseHeight = baseHeight;
  const parsed = parseInt(orbitZoom, 10);
  const scale = Number.isFinite(parsed) ? clamp(parsed / 100, 0.5, 3) : 1;
  // Keep the canvas filling the pane when zooming out so the grid background
  // still occupies the entire Orbit area.
  const cssWidth = scale < 1 ? baseWidth : Math.max(1, Math.round(baseWidth * scale));
  const cssHeight = scale < 1 ? baseHeight : Math.max(1, Math.round(baseHeight * scale));
  const offsetX = scale < 1 ? (baseWidth - (baseWidth * scale)) / 2 : 0;
  const offsetY = scale < 1 ? (baseHeight - (baseHeight * scale)) / 2 : 0;
  orbitCanvas.style.width = `${cssWidth}px`;
  orbitCanvas.style.height = `${cssHeight}px`;
  orbitCanvas.width = Math.round((scale < 1 ? baseWidth : cssWidth) * dpr);
  orbitCanvas.height = Math.round((scale < 1 ? baseHeight : cssHeight) * dpr);
  orbitRenderScale = scale;
  orbitRenderOffsetX = offsetX;
  orbitRenderOffsetY = offsetY;
  orbitCtx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offsetX, dpr * offsetY);
  if (keepViewportCenter) {
    const targetCenterX = centerWorldX * scale + offsetX;
    const targetCenterY = centerWorldY * scale + offsetY;
    const maxScrollLeft = Math.max(0, cssWidth - orbitBody.clientWidth);
    const maxScrollTop = Math.max(0, cssHeight - orbitBody.clientHeight);
    orbitBody.scrollLeft = clamp(targetCenterX - (orbitBody.clientWidth / 2), 0, maxScrollLeft);
    orbitBody.scrollTop = clamp(targetCenterY - (orbitBody.clientHeight / 2), 0, maxScrollTop);
  }
  return true;
}

function initOrbitState(sliders, persisted) {
  if (!orbitCanvas) return;
  const width = Math.max(1, orbitBaseWidth || orbitCanvas.clientWidth || 1);
  const height = Math.max(1, orbitBaseHeight || orbitCanvas.clientHeight || 1);
  const defaultOuter = Math.max(60, Math.min(width, height) * 0.36);
  const defaultInner = Math.max(14, defaultOuter * 0.18);
  const center = persisted && persisted.center
    ? { x: Number(persisted.center.x) || width / 2, y: Number(persisted.center.y) || height / 2 }
    : { x: width / 2, y: height / 2 };
  orbitState = {
    width,
    height,
    center: {
      x: clamp(center.x, 0, width),
      y: clamp(center.y, 0, height)
    },
    innerRadius:
      persisted && Number.isFinite(persisted.innerRadius)
        ? Math.max(8, Number(persisted.innerRadius))
        : defaultInner,
    outerRadius:
      persisted && Number.isFinite(persisted.outerRadius)
        ? Math.max(defaultInner + 10, Number(persisted.outerRadius))
        : defaultOuter,
    sliders,
    positions: {},
    disabledPaths: new Set(),
    initialOuterRadius: 0,
    gridOrigin: { x: 0, y: 0 }
  };
  ensureOrbitRadii();
  orbitState.initialOuterRadius = orbitState.outerRadius;
  orbitState.gridOrigin = { x: orbitState.center.x, y: orbitState.center.y };

  const persistedPositions =
    persisted && persisted.positions && typeof persisted.positions === 'object'
      ? persisted.positions
      : {};
  const persistedDisabled =
    persisted && Array.isArray(persisted.disabledPaths)
      ? persisted.disabledPaths
      : [];
  for (const path of persistedDisabled) {
    if (typeof path === 'string') {
      orbitState.disabledPaths.add(path);
    }
  }
  for (const slider of sliders) {
    if (shouldAutoDisableOrbitSlider(slider)) {
      orbitState.disabledPaths.add(slider.path);
    }
  }

  const count = Math.max(1, sliders.length);
  sliders.forEach((slider, index) => {
    const p = persistedPositions[slider.path];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      orbitState.positions[slider.path] = {
        x: clamp(Number(p.x), 0, orbitState.width),
        y: clamp(Number(p.y), 0, orbitState.height)
      };
      return;
    }
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const raw = paramValues[slider.path];
    const current = Number.isFinite(raw) ? raw : slider.min;
    const u = clamp((current - slider.min) / (slider.max - slider.min), 0, 1);
    const distance = distanceFromNormalized(u);
    orbitState.positions[slider.path] = {
      x: orbitState.center.x + Math.cos(angle) * distance,
      y: orbitState.center.y + Math.sin(angle) * distance
    };
  });
  constrainOrbitPositions();
}

function ensureOrbitRadii() {
  if (!orbitState) return;
  const maxOuter = Math.max(40, Math.min(orbitState.width, orbitState.height) * 0.47);
  orbitState.outerRadius = clamp(orbitState.outerRadius, 30, maxOuter);
  orbitState.innerRadius = clamp(orbitState.innerRadius, 8, orbitState.outerRadius - 6);
}

function installOrbitPointerHandlers() {
  if (!orbitCanvas) return;
  orbitCanvas.onpointerdown = (event) => {
    if (!orbitState) return;
    const p = orbitPointerPosition(event);
    const hit = hitTestOrbit(p.x, p.y);
    if (!hit) return;
    if (hit.mode === 'slider' && hit.path && event.shiftKey) {
      event.preventDefault();
      toggleOrbitSliderDisabled(hit.path);
      scheduleOrbitDraw();
      sendRunOrbitSnapshot(true);
      return;
    }
    event.preventDefault();
    orbitCanvas.setPointerCapture(event.pointerId);
    orbitPointer = {
      pointerId: event.pointerId,
      mode: hit.mode,
      path: hit.path || null
    };
    updateOrbitCursor(orbitPointer.mode);
  };
  orbitCanvas.onpointermove = (event) => {
    const p = orbitPointerPosition(event);
    if (!orbitState) return;
    if (!orbitPointer) {
      const hit = hitTestOrbit(p.x, p.y);
      updateOrbitCursor(hit ? hit.mode : null);
      return;
    }
    if (event.pointerId !== orbitPointer.pointerId) return;
    if (orbitPointer.mode === 'slider' && orbitPointer.path) {
      const nextPos = {
        x: clamp(p.x, 0, orbitState.width),
        y: clamp(p.y, 0, orbitState.height)
      };
      orbitState.positions[orbitPointer.path] = nextPos;
      applyOrbitValueForPath(orbitPointer.path);
      scheduleOrbitDraw();
      sendRunOrbitSnapshot();
      return;
    }
    if (orbitPointer.mode === 'outer') {
      const d = Math.hypot(p.x - orbitState.center.x, p.y - orbitState.center.y);
      orbitState.outerRadius = d;
      ensureOrbitRadii();
      applyOrbitValuesForAll();
      scheduleOrbitDraw();
      sendRunOrbitSnapshot();
      return;
    }
    if (orbitPointer.mode === 'center') {
      orbitState.center.x = clamp(p.x, 0, orbitState.width);
      orbitState.center.y = clamp(p.y, 0, orbitState.height);
      applyOrbitValuesForAll();
      scheduleOrbitDraw();
      sendRunOrbitSnapshot();
    }
  };
  orbitCanvas.onpointerup = (event) => {
    if (!orbitPointer || event.pointerId !== orbitPointer.pointerId) return;
    if (orbitPointer.mode === 'slider' && orbitPointer.path) {
      const path = orbitPointer.path;
      const value = paramValues[path];
      if (typeof value === 'number' && !isOrbitSliderDisabled(path)) {
        applyParamToDsp(path, value, { smooth: true, commit: true });
      }
    } else if (orbitPointer.mode === 'center' && orbitState) {
      for (const slider of orbitState.sliders) {
        if (isOrbitSliderDisabled(slider.path)) continue;
        const value = paramValues[slider.path];
        if (typeof value === 'number') {
          applyParamToDsp(slider.path, value, { smooth: true, commit: true });
        }
      }
    } else if (orbitPointer.mode === 'outer' && orbitState) {
      for (const slider of orbitState.sliders) {
        if (isOrbitSliderDisabled(slider.path)) continue;
        const value = paramValues[slider.path];
        if (typeof value === 'number') {
          applyParamToDsp(slider.path, value, { smooth: true, commit: true });
        }
      }
    }
    orbitPointer = null;
    updateOrbitCursor(null);
    sendRunOrbitSnapshot(true);
  };
  orbitCanvas.onpointercancel = () => {
    orbitPointer = null;
    updateOrbitCursor(null);
  };
  orbitCanvas.onpointerleave = () => {
    if (!orbitPointer) {
      updateOrbitCursor(null);
    }
  };
}

function orbitPointerPosition(event) {
  const rect = orbitCanvas.getBoundingClientRect();
  const scale = orbitRenderScale || 1;
  const offsetX = orbitRenderOffsetX || 0;
  const offsetY = orbitRenderOffsetY || 0;
  const rawX = event.clientX - rect.left;
  const rawY = event.clientY - rect.top;
  return {
    x: (rawX - offsetX) / scale,
    y: (rawY - offsetY) / scale
  };
}

function hitTestOrbit(x, y) {
  if (!orbitState) return null;
  const iconRadius = 9;
  for (const slider of orbitState.sliders) {
    const p = orbitState.positions[slider.path];
    if (!p) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= iconRadius + 4) {
      return { mode: 'slider', path: slider.path };
    }
  }
  const centerDistance = Math.hypot(orbitState.center.x - x, orbitState.center.y - y);
  if (centerDistance <= orbitState.innerRadius + 6) {
    return { mode: 'center' };
  }
  if (Math.abs(centerDistance - orbitState.outerRadius) <= 8) {
    return { mode: 'outer' };
  }
  return null;
}

function updateOrbitCursor(mode) {
  if (!orbitCanvas) return;
  if (mode === 'slider') {
    orbitCanvas.style.cursor = 'pointer';
    return;
  }
  if (mode === 'center') {
    orbitCanvas.style.cursor = 'move';
    return;
  }
  if (mode === 'outer') {
    orbitCanvas.style.cursor = orbitPointer ? 'grabbing' : 'grab';
    return;
  }
  orbitCanvas.style.cursor = 'default';
}

function applyOrbitValueForPath(path) {
  if (!orbitState) return;
  if (isOrbitSliderDisabled(path)) return;
  const slider = orbitState.sliders.find((s) => s.path === path);
  const p = orbitState.positions[path];
  if (!slider || !p) return;
  const value = sliderValueFromPosition(slider, p.x, p.y);
  setParamValue(path, value, {
    skipSnapshot: true,
    skipEmit: true,
    skipOrbitSync: true,
    smooth: true
  });
  sendRunParamsSnapshot();
  if (emitRunStateFn) emitRunStateFn();
}

function applyOrbitValuesForAll() {
  if (!orbitState) return;
  for (const slider of orbitState.sliders) {
    if (isOrbitSliderDisabled(slider.path)) continue;
    const p = orbitState.positions[slider.path];
    if (!p) continue;
    const value = sliderValueFromPosition(slider, p.x, p.y);
    setParamValue(slider.path, value, {
      skipSnapshot: true,
      skipEmit: true,
      skipOrbitSync: true,
      smooth: true
    });
  }
  sendRunParamsSnapshot();
  if (emitRunStateFn) emitRunStateFn();
}

function sliderValueFromPosition(slider, x, y) {
  if (!orbitState) return slider.min;
  const d = Math.hypot(x - orbitState.center.x, y - orbitState.center.y);
  const u = normalizedFromDistance(d);
  let value = slider.min + u * (slider.max - slider.min);
  if (slider.step > 0) {
    const steps = Math.round((value - slider.min) / slider.step);
    value = slider.min + steps * slider.step;
  }
  return clamp(value, slider.min, slider.max);
}

function normalizedFromDistance(distance) {
  if (!orbitState) return 0;
  if (distance <= orbitState.innerRadius) return 1;
  if (distance >= orbitState.outerRadius) return 0;
  return (orbitState.outerRadius - distance) / (orbitState.outerRadius - orbitState.innerRadius);
}

function distanceFromNormalized(u) {
  if (!orbitState) return 0;
  const clamped = clamp(u, 0, 1);
  return orbitState.outerRadius - clamped * (orbitState.outerRadius - orbitState.innerRadius);
}

function syncOrbitFromParams() {
  if (!orbitState) return;
  if (orbitPointer) {
    // During any local drag, icon positions are user-authoritative.
    // This prevents unrelated icon motion while dragging one slider or the center.
    return false;
  }
  const sliders = orbitState.sliders;
  const count = Math.max(1, sliders.length);
  let changed = false;
  sliders.forEach((slider, index) => {
    if (isOrbitSliderDisabled(slider.path)) {
      return;
    }
    const raw = paramValues[slider.path];
    const current = Number.isFinite(raw) ? raw : slider.min;
    const u = clamp((current - slider.min) / (slider.max - slider.min), 0, 1);
    const distance = distanceFromNormalized(u);
    const p = orbitState.positions[slider.path] || { x: orbitState.center.x, y: orbitState.center.y };
    let dx = p.x - orbitState.center.x;
    let dy = p.y - orbitState.center.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 1e-6) {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    } else {
      dx /= mag;
      dy /= mag;
    }
    const nextX = clamp(orbitState.center.x + dx * distance, 0, orbitState.width);
    const nextY = clamp(orbitState.center.y + dy * distance, 0, orbitState.height);
    const prev = orbitState.positions[slider.path];
    if (!prev || Math.abs(prev.x - nextX) > ORBIT_POSITION_EPSILON || Math.abs(prev.y - nextY) > ORBIT_POSITION_EPSILON) {
      orbitState.positions[slider.path] = { x: nextX, y: nextY };
      changed = true;
    }
  });
  if (changed) {
    scheduleOrbitDraw();
  }
  return changed;
}

function requestOrbitSyncFromParams(force = false) {
  if (!orbitUiInstance) return;
  if (force) {
    if (orbitParamSyncTimer) {
      clearTimeout(orbitParamSyncTimer);
      orbitParamSyncTimer = null;
    }
    lastOrbitParamSyncAt = Date.now();
    orbitUiInstance.setParams(paramValues);
    return;
  }
  const now = Date.now();
  const elapsed = now - lastOrbitParamSyncAt;
  if (elapsed >= ORBIT_PARAM_SYNC_INTERVAL_MS) {
    lastOrbitParamSyncAt = now;
    orbitUiInstance.setParams(paramValues);
    return;
  }
  if (orbitParamSyncTimer) return;
  orbitParamSyncTimer = setTimeout(() => {
    orbitParamSyncTimer = null;
    lastOrbitParamSyncAt = Date.now();
    if (!orbitUiInstance) return;
    orbitUiInstance.setParams(paramValues);
  }, Math.max(0, ORBIT_PARAM_SYNC_INTERVAL_MS - elapsed));
}

function drawOrbitNow() {
  if (!orbitState || !orbitCtx || !orbitCanvas) return;
  const ctx = orbitCtx;
  const scale = orbitRenderScale || 1;
  const offsetX = orbitRenderOffsetX || 0;
  const offsetY = orbitRenderOffsetY || 0;
  const width = orbitState.width;
  const height = orbitState.height;
  const canvasCssWidth = Math.max(1, orbitCanvas.clientWidth || width);
  const canvasCssHeight = Math.max(1, orbitCanvas.clientHeight || height);
  const minX = -offsetX / scale;
  const minY = -offsetY / scale;
  const drawWidth = canvasCssWidth / scale;
  const drawHeight = canvasCssHeight / scale;
  const maxX = minX + drawWidth;
  const maxY = minY + drawHeight;
  ctx.clearRect(minX, minY, drawWidth, drawHeight);
  ctx.fillStyle = '#111';
  ctx.fillRect(minX, minY, drawWidth, drawHeight);

  // Discrete centered grid to suggest draggable 2D space.
  const gridStep = Math.max(8, (orbitState.initialOuterRadius || orbitState.outerRadius) / 2);
  const gridOrigin = orbitState.gridOrigin || orbitState.center;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let x = gridOrigin.x; x <= maxX; x += gridStep) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, minY);
    ctx.lineTo(Math.round(x) + 0.5, maxY);
    ctx.stroke();
  }
  for (let x = gridOrigin.x - gridStep; x >= minX; x -= gridStep) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, minY);
    ctx.lineTo(Math.round(x) + 0.5, maxY);
    ctx.stroke();
  }
  for (let y = gridOrigin.y; y <= maxY; y += gridStep) {
    ctx.beginPath();
    ctx.moveTo(minX, Math.round(y) + 0.5);
    ctx.lineTo(maxX, Math.round(y) + 0.5);
    ctx.stroke();
  }
  for (let y = gridOrigin.y - gridStep; y >= minY; y -= gridStep) {
    ctx.beginPath();
    ctx.moveTo(minX, Math.round(y) + 0.5);
    ctx.lineTo(maxX, Math.round(y) + 0.5);
    ctx.stroke();
  }

  // Outer circle = min zone frontier.
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(orbitState.center.x, orbitState.center.y, orbitState.outerRadius, 0, Math.PI * 2);
  ctx.stroke();

  // Inner disk = max zone.
  ctx.fillStyle = 'rgba(250,250,250,0.15)';
  ctx.beginPath();
  ctx.arc(orbitState.center.x, orbitState.center.y, orbitState.innerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(250,250,250,0.35)';
  ctx.stroke();

  ctx.font = '11px system-ui, sans-serif';
  for (const slider of orbitState.sliders) {
    const p = orbitState.positions[slider.path];
    if (!p) continue;
    const disabled = isOrbitSliderDisabled(slider.path);
    const iconColor = disabled ? 'rgba(85,85,85,0.5)' : slider.color;
    const labelColor = disabled ? 'rgba(105,105,105,0.68)' : 'rgba(255,255,255,0.85)';
    ctx.fillStyle = iconColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = disabled ? 'rgba(60,60,60,0.82)' : 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const label = shortOrbitLabel(slider.label);
    ctx.fillStyle = labelColor;
    ctx.fillText(label, p.x + 10, p.y - 10);
  }
}

function shortOrbitLabel(label) {
  if (!label) return '';
  const max = 16;
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function scheduleOrbitDraw() {
  orbitNeedsDraw = true;
  if (orbitRafId) return;
  orbitRafId = requestAnimationFrame(() => {
    orbitRafId = null;
    if (!orbitNeedsDraw) return;
    orbitNeedsDraw = false;
    drawOrbitNow();
  });
}

function constrainOrbitPositions() {
  if (!orbitState) return;
  for (const slider of orbitState.sliders) {
    const p = orbitState.positions[slider.path];
    if (!p) continue;
    p.x = clamp(p.x, 0, orbitState.width);
    p.y = clamp(p.y, 0, orbitState.height);
  }
}

function buildRunOrbitSnapshot(includeNonce = true) {
  if (!orbitUiInstance) return null;
  const orbitStateNow = orbitUiInstance.getOrbitState();
  const snapshot = {
    zoom: Math.round(orbitStateNow.zoom),
    center: {
      x: Math.round(orbitStateNow.center.x),
      y: Math.round(orbitStateNow.center.y)
    },
    innerRadius: Math.round(orbitStateNow.innerRadius),
    outerRadius: Math.round(orbitStateNow.outerRadius),
    controls: orbitStateNow.controls
  };
  if (includeNonce) {
    snapshot.nonce = Date.now();
  }
  return snapshot;
}

function sendRunOrbitSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - lastRunOrbitSentAt < 120) return;
  lastRunOrbitSentAt = now;
  const snapshot = buildRunOrbitSnapshot(true);
  if (!snapshot) return;
  lastAppliedRemoteOrbitNonce = snapshot.nonce;
  fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runOrbitUi: snapshot })
  }).catch(() => {});
}

function applyRemoteOrbitUi(remoteOrbit) {
  if (!remoteOrbit || typeof remoteOrbit !== 'object') return;
  if (!orbitUiInstance) {
    pendingOrbitUi = remoteOrbit;
    return;
  }
  const base = orbitUiInstance.getOrbitState();
  const merged = mergeRemoteOrbitState(base, remoteOrbit);
  orbitUiInstance.setOrbitState(merged);
}

function mergeRemoteOrbitState(baseState, remoteOrbit) {
  const next = {
    zoom: Number.isFinite(remoteOrbit.zoom) ? Number(remoteOrbit.zoom) : baseState.zoom,
    center: {
      x: Number.isFinite(remoteOrbit.center && remoteOrbit.center.x)
        ? Number(remoteOrbit.center.x)
        : baseState.center.x,
      y: Number.isFinite(remoteOrbit.center && remoteOrbit.center.y)
        ? Number(remoteOrbit.center.y)
        : baseState.center.y
    },
    innerRadius: Number.isFinite(remoteOrbit.innerRadius) ? Number(remoteOrbit.innerRadius) : baseState.innerRadius,
    outerRadius: Number.isFinite(remoteOrbit.outerRadius) ? Number(remoteOrbit.outerRadius) : baseState.outerRadius,
    controls: { ...baseState.controls }
  };

  if (remoteOrbit.controls && typeof remoteOrbit.controls === 'object') {
    for (const [path, local] of Object.entries(baseState.controls)) {
      const incoming = remoteOrbit.controls[path];
      if (!incoming || typeof incoming !== 'object') continue;
      next.controls[path] = {
        ...local,
        x: Number.isFinite(incoming.x) ? Number(incoming.x) : local.x,
        y: Number.isFinite(incoming.y) ? Number(incoming.y) : local.y,
        enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : local.enabled,
        label: typeof incoming.label === 'string' ? incoming.label : local.label,
        color: typeof incoming.color === 'string' ? incoming.color : local.color,
        step: Number.isFinite(incoming.step) ? Number(incoming.step) : local.step
      };
    }
    return next;
  }

  const positions = remoteOrbit.positions && typeof remoteOrbit.positions === 'object' ? remoteOrbit.positions : {};
  const disabledPaths = new Set(Array.isArray(remoteOrbit.disabledPaths) ? remoteOrbit.disabledPaths : []);
  for (const [path, local] of Object.entries(baseState.controls)) {
    const incoming = positions[path];
    next.controls[path] = {
      ...local,
      x: incoming && Number.isFinite(incoming.x) ? Number(incoming.x) : local.x,
      y: incoming && Number.isFinite(incoming.y) ? Number(incoming.y) : local.y,
      enabled: disabledPaths.has(path) ? false : local.enabled
    };
  }
  return next;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function collectButtonPaths(ui) {
  const paths = [];
  if (!Array.isArray(ui)) return paths;
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Array.isArray(node.items)) node.items.forEach(walk);
    if (node.type === 'button') {
      const address = node.address || node.path;
      if (address && !paths.includes(address)) paths.push(address);
    }
  };
  walk(ui);
  return paths;
}

function installRunSpaceShortcut() {
  if (runSpaceKeyHandler || runSpaceKeyUpHandler) return;
  runSpaceKeyHandler = async (event) => {
    if (event.defaultPrevented) return;
    if (event.code !== 'Space') return;
    if (event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
    const targetPath =
      (lastUiButtonPath && uiButtonPaths.has(lastUiButtonPath) ? lastUiButtonPath : null) ||
      (uiButtonOrder.length > 0 ? uiButtonOrder[0] : null);
    if (!targetPath) return;
    event.preventDefault();
    if (runSpacePressedPath) return;
    if (!audioRunning && typeof outputNode !== 'undefined') {
      startAudioOutput();
    }
    runSpacePressedPath = targetPath;
    pressedUiButtons.add(targetPath);
    setParamValue(targetPath, 1, { skipSnapshot: true });
    sendRunParamsSnapshot(true);
  };
  runSpaceKeyUpHandler = (event) => {
    if (event.code !== 'Space') return;
    if (!runSpacePressedPath) return;
    event.preventDefault();
    const path = runSpacePressedPath;
    runSpacePressedPath = null;
    pressedUiButtons.delete(path);
    setParamValue(path, 0, { skipSnapshot: true });
    sendRunParamsSnapshot(true);
  };
  runSpaceBlurHandler = () => {
    if (!runSpacePressedPath) return;
    const path = runSpacePressedPath;
    runSpacePressedPath = null;
    pressedUiButtons.delete(path);
    setParamValue(path, 0, { skipSnapshot: true });
    sendRunParamsSnapshot(true);
  };
  window.addEventListener('keydown', runSpaceKeyHandler);
  window.addEventListener('keyup', runSpaceKeyUpHandler);
  window.addEventListener('blur', runSpaceBlurHandler, true);
}

function uninstallRunSpaceShortcut() {
  if (runSpaceKeyHandler) {
    window.removeEventListener('keydown', runSpaceKeyHandler);
    runSpaceKeyHandler = null;
  }
  if (runSpaceKeyUpHandler) {
    window.removeEventListener('keyup', runSpaceKeyUpHandler);
    runSpaceKeyUpHandler = null;
  }
  if (runSpaceBlurHandler) {
    window.removeEventListener('blur', runSpaceBlurHandler, true);
    runSpaceBlurHandler = null;
  }
  if (runSpacePressedPath) {
    const path = runSpacePressedPath;
    runSpacePressedPath = null;
    pressedUiButtons.delete(path);
    setParamValue(path, 0, { skipSnapshot: true });
    sendRunParamsSnapshot(true);
  }
}

function releasePressedUiButtons() {
  if (pressedUiButtons.size === 0) return;
  const protectedPath = runSpacePressedPath;
  let releasedAny = false;
  for (const path of Array.from(pressedUiButtons)) {
    if (protectedPath && path === protectedPath) {
      continue;
    }
    setParamValue(path, 0);
    releasedAny = true;
  }
  if (protectedPath) {
    pressedUiButtons = new Set([protectedPath]);
  } else {
    pressedUiButtons.clear();
  }
  if (releasedAny) {
    sendRunParamsSnapshot(true);
  }
}

function installUiReleaseGuard() {
  if (uiReleaseHandlersInstalled) return;
  const handler = () => releasePressedUiButtons();
  window.addEventListener('pointerup', handler, true);
  window.addEventListener('pointercancel', handler, true);
  window.addEventListener('blur', handler, true);
  uiReleaseGuardHandler = handler;
  uiReleaseHandlersInstalled = true;
}

function uninstallUiReleaseGuard() {
  if (!uiReleaseHandlersInstalled) return;
  const handler = uiReleaseGuardHandler;
  if (handler) {
    window.removeEventListener('pointerup', handler, true);
    window.removeEventListener('pointercancel', handler, true);
    window.removeEventListener('blur', handler, true);
  }
  uiReleaseGuardHandler = null;
  uiReleaseHandlersInstalled = false;
}

function applyUiZoom() {
  const zoomHost = controlsClassicPane || controlsContent;
  if (!zoomHost || !uiZoomWrap || !uiZoomStage || !currentUiRoot) return;
  const naturalWidth = Math.max(currentUiRoot.scrollWidth, currentUiRoot.offsetWidth, 1);
  const naturalHeight = Math.max(currentUiRoot.scrollHeight, currentUiRoot.offsetHeight, 1);
  const availableWidth = Math.max(zoomHost.clientWidth - 20, 1);
  const availableHeight = Math.max(zoomHost.clientHeight - 20, 1);
  const fitScale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
  const manualScale =
    uiZoom === 'auto'
      ? fitScale
      : Math.max(0.25, Math.min(2, parseInt(uiZoom, 10) / 100));
  const scale = Number.isFinite(manualScale) ? manualScale : fitScale;
  uiZoomStage.style.transform = `scale(${scale})`;
  uiZoomStage.style.width = `${naturalWidth * scale}px`;
  uiZoomStage.style.height = `${naturalHeight * scale}px`;
}

function setupUiZoomObserver() {
  teardownUiZoomObserver();
  const zoomHost = controlsClassicPane || controlsContent;
  if (!zoomHost || !currentUiRoot) return;
  uiResizeObserver = new ResizeObserver(() => applyUiZoom());
  uiResizeObserver.observe(zoomHost);
  uiResizeObserver.observe(currentUiRoot);
}

function teardownUiZoomObserver() {
  if (uiResizeObserver) {
    uiResizeObserver.disconnect();
    uiResizeObserver = null;
  }
}

async function ensureMidiAccess() {
  if (!('requestMIDIAccess' in navigator)) {
    midiAccess = null;
    return null;
  }
  if (midiAccess) return midiAccess;
  try {
    midiAccess = await navigator.requestMIDIAccess();
    return midiAccess;
  } catch {
    midiAccess = null;
    return null;
  }
}

async function refreshMidiInputs(selectEl, preferredValue) {
  selectEl.innerHTML = '';
  const virtualOption = document.createElement('option');
  virtualOption.value = 'virtual';
  virtualOption.textContent = 'Virtual';
  selectEl.appendChild(virtualOption);

  const access = await ensureMidiAccess();
  if (!access) {
    selectEl.disabled = false;
    selectEl.value = 'virtual';
    return;
  }

  const inputs = Array.from(access.inputs.values());
  selectEl.disabled = false;
  inputs.forEach((input, idx) => {
    const option = document.createElement('option');
    option.value = input.id;
    option.textContent = input.name || `MIDI Device ${idx + 1}`;
    selectEl.appendChild(option);
  });

  // Preserve explicit virtual selection before falling back to previous device.
  if (preferredValue === 'virtual') {
    selectEl.value = 'virtual';
  } else if (preferredValue && inputs.some((i) => i.id === preferredValue)) {
    selectEl.value = preferredValue;
  } else if (midiInput && inputs.some((i) => i.id === midiInput.id)) {
    selectEl.value = midiInput.id;
  } else {
    selectEl.value = 'virtual';
  }
}

async function selectMidiDevice(id) {
  const access = await ensureMidiAccess();
  if (!access) return;
  const input = Array.from(access.inputs.values()).find((i) => i.id === id);
  if (!input) return;
  disconnectMidiDevice();
  midiInput = input;
  midiInput.onmidimessage = async (event) => {
    const data = event.data;
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const note = data[1];
    const velocity = data.length > 2 ? data[2] : 0;
    if (status === 0x90 && velocity > 0) {
      if (!audioRunning) await startAudio();
      noteOnMidi(note, velocity / 127);
    } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
      noteOffMidi(note);
    } else if (dspNode && typeof dspNode.midiMessage === 'function') {
      try {
        dspNode.midiMessage(data);
      } catch {
        // ignore
      }
    }
  };
}

function disconnectMidiDevice() {
  if (midiInput) {
    midiInput.onmidimessage = null;
    midiInput = null;
  }
}

function findMidiTargets(ui) {
  if (!Array.isArray(ui)) return null;
  const items = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.items) {
      node.items.forEach(walk);
    }
    if (node.type && node.address) {
      items.push(node);
    } else if (node.type && node.path) {
      items.push(node);
    }
  };
  walk(ui);

  const findMatch = (pattern) => {
    const regex = new RegExp(pattern, 'i');
    const match = items.find((item) => {
      const label = item.label || '';
      const address = item.address || item.path || '';
      return regex.test(label) || regex.test(address);
    });
    return match ? match.address || match.path : null;
  };

  return {
    gate: findMatch('gate|trig|trigger|noteon|keyon|on'),
    freq: findMatch('freq|frequency|hz|pitch'),
    key: findMatch('midi|key|note'),
    gain: findMatch('gain|amp|velocity|vel')
  };
}

function setParamValue(path, value, options = {}) {
  if (!path) return;
  const skipSnapshot = options && options.skipSnapshot === true;
  const skipEmit = options && options.skipEmit === true;
  const skipOrbitSync = options && options.skipOrbitSync === true;
  const smooth = options && options.smooth === true;
  const commit = options && options.commit === true;
  if (paramValues[path] === value) return;
  try {
    applyParamToDsp(path, value, { smooth, commit });
    paramValues[path] = value;
    if (faustUIInstance) {
      faustUIInstance.paramChangeByDSP(path, value);
    }
    if (!skipSnapshot) {
      sendRunParamsSnapshot();
    }
    if (!skipOrbitSync) {
      requestOrbitSyncFromParams();
    }
    if (!skipEmit && emitRunStateFn) emitRunStateFn();
  } catch {
    // ignore
  }
}

function applyParamToDsp(path, value, options = {}) {
  if (!dspNode) return;
  const smooth = options && options.smooth === true;
  const commit = options && options.commit === true;
  if (!smooth || uiButtonPaths.has(path)) {
    clearParamSmooth(path);
    try {
      dspNode.setParamValue(path, value);
    } catch {
      // ignore
    }
    return;
  }

  const now = Date.now();
  let entry = paramSmooth.get(path);
  if (!entry) {
    entry = {
      lastSentAt: 0,
      lastSentValue: undefined,
      pendingValue: undefined,
      timer: null
    };
    paramSmooth.set(path, entry);
  }

  const sendNow = (targetValue) => {
    if (!dspNode) return;
    if (
      typeof entry.lastSentValue === 'number' &&
      Math.abs(targetValue - entry.lastSentValue) < PARAM_SMOOTH_EPSILON
    ) {
      return;
    }
    try {
      dspNode.setParamValue(path, targetValue);
      entry.lastSentAt = Date.now();
      entry.lastSentValue = targetValue;
    } catch {
      // ignore
    }
  };

  if (commit) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.pendingValue = undefined;
    sendNow(value);
    return;
  }

  const elapsed = now - entry.lastSentAt;
  if (elapsed >= PARAM_SMOOTH_INTERVAL_MS) {
    sendNow(value);
    return;
  }

  entry.pendingValue = value;
  if (!entry.timer) {
    const wait = Math.max(0, PARAM_SMOOTH_INTERVAL_MS - elapsed);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (typeof entry.pendingValue === 'number') {
        const target = entry.pendingValue;
        entry.pendingValue = undefined;
        sendNow(target);
      }
    }, wait);
  }
}

function clearParamSmooth(path) {
  const entry = paramSmooth.get(path);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  paramSmooth.delete(path);
}

function clearAllParamSmoothing() {
  for (const [path, entry] of paramSmooth.entries()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    paramSmooth.delete(path);
  }
}

function applyRemoteRunParams(remoteParams) {
  let changed = false;
  for (const [path, value] of Object.entries(remoteParams)) {
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    if (uiButtonPaths.has(path) && pressedUiButtons.has(path)) {
      // Keep local hold authoritative while button is actively pressed by user.
      continue;
    }
    // Runtime remote sync must preserve actual values, including button=1.
    // Legacy button reset normalization is only for cold restore paths.
    const normalizedValue = value;
    if (paramValues[path] === normalizedValue) continue;
    try {
      if (dspNode) {
        dspNode.setParamValue(path, normalizedValue);
      }
      paramValues[path] = normalizedValue;
      if (faustUIInstance) {
        faustUIInstance.paramChangeByDSP(path, normalizedValue);
      }
      changed = true;
    } catch {
      // ignore
    }
  }
  if (changed) {
    requestOrbitSyncFromParams();
    if (emitRunStateFn) emitRunStateFn();
    sendRunParamsSnapshot();
  }
}

function noteOnMidi(note, velocity) {
  if (dspNode && typeof dspNode.keyOn === 'function') {
    const vel = Math.max(0, Math.min(127, Math.round(velocity * 127)));
    try {
      dspNode.keyOn(0, note, vel);
    } catch {
      // ignore
    }
    return;
  }
  if (midiOnly) return;
  if (!midiTargets) return;
  const freq = 440 * Math.pow(2, (note - 69) / 12);
  if (midiTargets.key) {
    setParamValue(midiTargets.key, note);
  }
  if (midiTargets.freq) {
    setParamValue(midiTargets.freq, freq);
  }
  if (midiTargets.gain) {
    setParamValue(midiTargets.gain, Math.max(0, Math.min(1, velocity)));
  }
  if (midiTargets.gate) {
    setParamValue(midiTargets.gate, 1);
  }
}

function noteOffMidi(note = null) {
  if (dspNode && typeof dspNode.keyOff === 'function') {
    try {
      if (note !== null) {
        dspNode.keyOff(0, note, 0);
      } else if (activeMidiNote !== null) {
        dspNode.keyOff(0, activeMidiNote, 0);
      } else if (typeof dspNode.allNotesOff === 'function') {
        dspNode.allNotesOff(true);
      }
    } catch {
      // ignore
    }
    return;
  }
  if (midiOnly) return;
  if (!midiTargets) return;
  if (midiTargets.gate) {
    setParamValue(midiTargets.gate, 0);
  }
}

function applyParamValues() {
  for (const [path, value] of Object.entries(paramValues)) {
    const normalizedValue = normalizeRestoredParamValue(path, value);
    try {
      if (dspNode) {
        dspNode.setParamValue(path, normalizedValue);
      }
      if (faustUIInstance) {
        faustUIInstance.paramChangeByDSP(path, normalizedValue);
      }
      if (paramValues[path] !== normalizedValue) {
        paramValues[path] = normalizedValue;
      }
    } catch {
      // ignore
    }
  }
  requestOrbitSyncFromParams(true);
}

function normalizeRestoredParamValue(path, value) {
  // Faust buttons are impulse controls and must not stay latched on restore.
  if (uiButtonPaths.has(path) && value > 0) return 0;
  return value;
}

function normalizeLatchedButtonParams() {
  let changed = false;
  for (const path of uiButtonPaths) {
    const current = paramValues[path];
    if (typeof current === 'number' && current > 0) {
      paramValues[path] = 0;
      changed = true;
    }
  }
  return changed;
}

function resetUiButtonsToZero() {
  if (uiButtonPaths.size === 0) return;
  let changed = false;
  for (const path of uiButtonPaths) {
    if (paramValues[path] !== 0) {
      changed = true;
    }
    try {
      if (dspNode) {
        dspNode.setParamValue(path, 0);
      }
      if (faustUIInstance) {
        faustUIInstance.paramChangeByDSP(path, 0);
      }
    } catch {
      // ignore
    }
    paramValues[path] = 0;
  }
  pressedUiButtons.clear();
  if (changed) {
    sendRunParamsSnapshot(true);
  }
}

function attachOutputParamHandler() {
  if (!dspNode || typeof dspNode.setOutputParamHandler !== 'function') return;
  dspNode.setOutputParamHandler((path, value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    if (typeof paramValues[path] === 'number' && Math.abs(paramValues[path] - value) < PARAM_SMOOTH_EPSILON) {
      return;
    }
    paramValues[path] = value;
    if (faustUIInstance) {
      faustUIInstance.paramChangeByDSP(path, value);
    }
    requestOrbitSyncFromParams();
    sendRunParamsSnapshot();
    if (emitRunStateFn) emitRunStateFn();
  });
  outputParamHandlerAttached = true;
}

function startParamPolling() {
  if (outputParamHandlerAttached) return;
  if (paramPollId) return;
  if (!dspNode || typeof dspNode.getParamValue !== 'function') return;
  if (!faustUIInstance) return;
  const paths = uiParamPaths.length > 0 ? uiParamPaths : Object.keys(paramValues);
  if (paths.length === 0) return;
  paramPollId = setInterval(() => {
    if (!dspNode || !faustUIInstance) return;
    let changed = false;
    for (const path of paths) {
      try {
        const value = dspNode.getParamValue(path);
        if (typeof value !== 'number' || Number.isNaN(value)) continue;
        if (typeof paramValues[path] !== 'number' || Math.abs(paramValues[path] - value) >= PARAM_SMOOTH_EPSILON) {
          paramValues[path] = value;
          faustUIInstance.paramChangeByDSP(path, value);
          changed = true;
        }
      } catch {
        // ignore
      }
    }
    if (changed) {
      requestOrbitSyncFromParams();
      if (emitRunStateFn) emitRunStateFn();
    }
  }, 150);
}

function stopParamPolling() {
  if (paramPollId) {
    clearInterval(paramPollId);
    paramPollId = null;
  }
}

function updateUiRoot(container) {
  currentUiRoot =
    container.querySelector('.faust-ui-root') || container.firstElementChild || null;
}

function prepareControlsContainer(container) {
  container.innerHTML = '';
  const bg = document.createElement('div');
  bg.className = 'run-controls-bg';
  const content = document.createElement('div');
  content.className = 'run-controls-content';
  const split = document.createElement('div');
  split.className = 'run-controls-split';
  const classicPane = document.createElement('div');
  classicPane.className = 'run-controls-pane run-controls-pane-classic';
  const orbitPane = document.createElement('div');
  orbitPane.className = 'run-controls-pane run-controls-pane-orbit';
  split.appendChild(classicPane);
  split.appendChild(orbitPane);
  content.appendChild(split);
  container.appendChild(bg);
  container.appendChild(content);
  return { bg, content, split, classicPane, orbitPane };
}

function ensureFaustUiCss() {
  if (document.getElementById('faust-ui-css')) return;
  const link = document.createElement('link');
  link.id = 'faust-ui-css';
  link.rel = 'stylesheet';
  link.href = '/vendor/faust-ui/index.css';
  document.head.appendChild(link);
}

function sendSpectrumSnapshot(scope, data, meta) {
  const now = Date.now();
  if (now - lastSpectrumSentAt < 100) return;
  lastSpectrumSentAt = now;
  const floorDb = typeof meta.floorDb === 'number' ? meta.floorDb : -110;
  const safeData = Array.from(data, (v) => (Number.isFinite(v) ? v : floorDb));
  const summary = buildSpectrumSummary(scope, safeData, {
    capturedAt: now,
    fmin: meta.fmin,
    fmax: meta.fmax,
    floorDb,
    audioQuality: meta.audioQuality
  });
  if (summary) {
    lastSpectrumSummary = summary;
  }
  const payload = {
    capturedAt: now,
    scale: meta.scale,
    fftSize: scope.fftSize || 2048,
    sampleRate: scope.sampleRate || 44100,
    fmin: meta.fmin,
    fmax: meta.fmax,
    floorDb,
    data: safeData
  };
  fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spectrum: payload,
      spectrumSummary: summary || undefined
    })
  }).catch(() => {});
}

function buildSpectrumSummary(scope, data, meta) {
  if (!Array.isArray(data) || data.length < 8) return null;
  const sampleRate = Number.isFinite(scope.sampleRate) ? scope.sampleRate : 44100;
  const fftSize = Number.isFinite(scope.fftSize) ? scope.fftSize : 2048;
  const fmin = Number.isFinite(meta.fmin) ? meta.fmin : 20;
  const fmax = Number.isFinite(meta.fmax) ? meta.fmax : sampleRate / 2;
  const floorDb = Number.isFinite(meta.floorDb) ? meta.floorDb : -110;
  const bandsCount = 32;
  const peaksCount = 8;
  const bandsDbQ = buildLogBands(data, sampleRate, fmin, fmax, bandsCount, floorDb);
  const peaks = detectTopPeaks(data, sampleRate, fmax, floorDb, peaksCount);
  const features = computeSpectrumFeatures(data, sampleRate, fmax, floorDb);
  const previous = lastSpectrumSummary && lastSpectrumSummary.features ? lastSpectrumSummary.features : null;
  const delta = previous
    ? {
        rmsDbQ: features.rmsDbQ - previous.rmsDbQ,
        centroidHz: features.centroidHz - previous.centroidHz,
        rolloff95Hz: features.rolloff95Hz - previous.rolloff95Hz,
        flatnessQ: features.flatnessQ - previous.flatnessQ,
        crestDbQ: features.crestDbQ - previous.crestDbQ
      }
    : undefined;
  return {
    type: 'spectrum_summary_v1',
    capturedAt: meta.capturedAt,
    frame: {
      sampleRate: Math.round(sampleRate),
      fftSize: Math.round(fftSize),
      fmin: Math.round(fmin),
      fmax: Math.round(fmax),
      floorDb: Math.round(floorDb),
      bandsCount
    },
    bandsDbQ,
    peaks,
    features,
    audioQuality: meta.audioQuality || undefined,
    delta
  };
}

function buildLogBands(data, sampleRate, fmin, fmax, count, floorDb) {
  const bands = [];
  const binCount = data.length;
  const nyquist = sampleRate / 2;
  const low = Math.max(1, fmin);
  const high = Math.min(fmax, nyquist);
  const logMin = Math.log(low);
  const logMax = Math.log(high);
  for (let b = 0; b < count; b++) {
    const t0 = b / count;
    const t1 = (b + 1) / count;
    const bandF0 = Math.exp(logMin + (logMax - logMin) * t0);
    const bandF1 = Math.exp(logMin + (logMax - logMin) * t1);
    const i0 = Math.max(1, Math.floor((bandF0 / high) * (binCount - 1)));
    const i1 = Math.max(i0 + 1, Math.ceil((bandF1 / high) * (binCount - 1)));
    let maxDb = floorDb;
    for (let i = i0; i <= Math.min(binCount - 1, i1); i++) {
      const v = data[i];
      if (Number.isFinite(v) && v > maxDb) maxDb = v;
    }
    bands.push(Math.round(maxDb));
  }
  return bands;
}

function detectTopPeaks(data, sampleRate, fmax, floorDb, peaksCount) {
  const binCount = data.length;
  const threshold = floorDb + 10;
  const peaks = [];
  for (let i = 2; i < binCount - 2; i++) {
    const v = data[i];
    if (!Number.isFinite(v) || v < threshold) continue;
    if (v < data[i - 1] || v < data[i + 1]) continue;
    const hz = (i / (binCount - 1)) * fmax;
    const q = estimatePeakQ(data, i, sampleRate);
    peaks.push({ hz: Math.round(hz), dbQ: Math.round(v), q });
  }
  peaks.sort((a, b) => b.dbQ - a.dbQ);
  return peaks.slice(0, peaksCount);
}

function estimatePeakQ(data, peakIndex, sampleRate) {
  const peakDb = data[peakIndex];
  if (!Number.isFinite(peakDb)) return 0;
  const target = peakDb - 3;
  let left = peakIndex;
  let right = peakIndex;
  while (left > 1 && data[left] > target) left--;
  while (right < data.length - 2 && data[right] > target) right++;
  const nyquist = sampleRate / 2;
  const peakHz = (peakIndex / (data.length - 1)) * nyquist;
  const leftHz = (left / (data.length - 1)) * nyquist;
  const rightHz = (right / (data.length - 1)) * nyquist;
  const bandwidth = Math.max(1, rightHz - leftHz);
  return Number((peakHz / bandwidth).toFixed(2));
}

function computeSpectrumFeatures(data, sampleRate, fmax, floorDb) {
  const eps = 1e-12;
  const powers = data.map((db) => Math.max(eps, Math.pow(10, ((Number.isFinite(db) ? db : floorDb) / 10))));
  let powerSum = 0;
  let weightedFreq = 0;
  let maxDb = floorDb;
  for (let i = 0; i < powers.length; i++) {
    const p = powers[i];
    const hz = (i / (powers.length - 1)) * fmax;
    powerSum += p;
    weightedFreq += p * hz;
    if (data[i] > maxDb) maxDb = data[i];
  }
  const avgPower = powerSum / Math.max(1, powers.length);
  const rmsDb = 10 * Math.log10(Math.max(eps, avgPower));
  const centroidHz = powerSum > 0 ? weightedFreq / powerSum : 0;
  const rolloff95Hz = computeRolloff95(powers, fmax);
  const flatness = computeFlatness(powers);
  return {
    rmsDbQ: Math.round(rmsDb),
    centroidHz: Math.round(centroidHz),
    rolloff95Hz: Math.round(rolloff95Hz),
    flatnessQ: Math.round(Math.max(0, Math.min(1, flatness)) * 100),
    crestDbQ: Math.round(maxDb - rmsDb)
  };
}

function computeAudioQuality(samples) {
  if (!samples || samples.length < 2) {
    return {
      peakDbFSQ: -120,
      clipSampleCount: 0,
      clipRatioQ: 0,
      dcOffsetQ: 0,
      clickCount: 0,
      clickScoreQ: 0
    };
  }

  const clipThreshold = 0.999;
  const clickDerivThreshold = 0.35;
  const clickRefractory = 8;
  let maxAbs = 0;
  let sum = 0;
  let clipSampleCount = 0;
  let clickCount = 0;
  let lastClickIndex = -clickRefractory;
  let maxDeriv = 0;

  for (let i = 0; i < samples.length; i++) {
    const x = Number.isFinite(samples[i]) ? samples[i] : 0;
    const ax = Math.abs(x);
    if (ax > maxAbs) maxAbs = ax;
    if (ax >= clipThreshold) clipSampleCount += 1;
    sum += x;
    if (i === 0) continue;
    const d = Math.abs(x - samples[i - 1]);
    if (d > maxDeriv) maxDeriv = d;
    if (d > clickDerivThreshold && i - lastClickIndex >= clickRefractory) {
      clickCount += 1;
      lastClickIndex = i;
    }
  }

  const n = samples.length;
  const mean = sum / n;
  const peakDbFS = maxAbs > 1e-6 ? 20 * Math.log10(maxAbs) : -120;
  const clipRatioQ = Math.round((1000 * clipSampleCount) / n);
  const dcOffsetQ = Math.round(Math.abs(mean) * 1000);
  const clickDensity = (clickCount / Math.max(1, n / 64)) * 100;
  const clickScoreQ = Math.max(
    0,
    Math.min(100, Math.round(clickDensity + Math.max(0, maxDeriv - 0.25) * 120 + clipRatioQ * 0.5))
  );

  return {
    peakDbFSQ: Math.round(Math.max(-120, Math.min(0, peakDbFS))),
    clipSampleCount,
    clipRatioQ,
    dcOffsetQ,
    clickCount,
    clickScoreQ
  };
}

function computeRolloff95(powers, fmax) {
  let total = 0;
  for (const p of powers) total += p;
  if (total <= 0) return 0;
  const threshold = total * 0.95;
  let cumulative = 0;
  for (let i = 0; i < powers.length; i++) {
    cumulative += powers[i];
    if (cumulative >= threshold) {
      return (i / (powers.length - 1)) * fmax;
    }
  }
  return fmax;
}

function computeFlatness(powers) {
  const eps = 1e-12;
  let sumLog = 0;
  let sum = 0;
  for (const p of powers) {
    const x = Math.max(eps, p);
    sumLog += Math.log(x);
    sum += x;
  }
  const n = Math.max(1, powers.length);
  const gm = Math.exp(sumLog / n);
  const am = sum / n;
  return am > 0 ? gm / am : 0;
}

function sendRunParamsSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - lastRunParamsSentAt < 150) return;
  lastRunParamsSentAt = now;
  fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runParams: { ...paramValues } })
  }).catch(() => {});
}

async function executeLocalTrigger(path, holdMs) {
  if (!path || typeof path !== 'string') return;
  const duration =
    typeof holdMs === 'number' && Number.isFinite(holdMs)
      ? Math.max(1, Math.min(5000, Math.round(holdMs)))
      : 80;
  if (!audioRunning && typeof outputNode !== 'undefined') {
    startAudioOutput();
  }
  setParamValue(path, 1);
  await sleep(duration);
  setParamValue(path, 0);
  // Ensure remote shared state reflects button release even with throttle.
  sendRunParamsSnapshot(true);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyRunState(runState, controls) {
  if (!runState) return;
  if (runState.orbitUi && typeof runState.orbitUi === 'object') {
    pendingOrbitUi = runState.orbitUi;
  }
  if (runState.uiZoom) {
    uiZoom = String(runState.uiZoom);
  }
  if (runState.orbitZoom) {
    orbitZoom = String(runState.orbitZoom);
  }
  if (typeof runState.midiSource === 'string') {
    midiSource = runState.midiSource;
    if (controls.midiInputSelect) {
      controls.midiInputSelect.value = midiSource;
    }
  }
  const scope = runState.scope || {};
  if (typeof runState.polyVoices === 'number' && controls.modeSelect) {
    polyVoices = Math.max(0, runState.polyVoices);
    const desired = polyVoices > 0 ? String(polyVoices) : 'mono';
    if ([...controls.modeSelect.options].some((opt) => opt.value === desired)) {
      controls.modeSelect.value = desired;
    } else {
      controls.modeSelect.value = 'mono';
      polyVoices = 0;
    }
  }
  if (scope.view) {
    scopeState.view = scope.view;
    controls.scopeView.value = scope.view;
  }
  if (scope.spectrumScale) {
    scopeState.spectrumScale = scope.spectrumScale;
    controls.scopeScale.value = scope.spectrumScale;
  }
  if (scope.mode) {
    scopeState.mode = scope.mode;
    controls.scopeMode.value = scope.mode;
  }
  if (scope.slope) {
    scopeState.slope = scope.slope;
    controls.scopeSlope.value = scope.slope;
  }
  if (typeof scope.threshold === 'number') {
    scopeState.threshold = scope.threshold;
    controls.scopeThreshold.value = String(scope.threshold);
  }
  if (typeof scope.holdoffMs === 'number') {
    scopeState.holdoffMs = scope.holdoffMs;
    controls.scopeHoldoff.value = String(scope.holdoffMs);
  }
}

export function dispose() {
  uninstallRunSpaceShortcut();
  detachComputerMidiKeyboard();
  releasePressedUiButtons();
  uninstallUiReleaseGuard();
  cleanupAudio();
  compiledGenerator = null;
  compiledUI = null;
  faustUIInstance = null;
  emitRunStateFn = null;
  midiTargets = null;
  activeMidiNote = null;
  midiAccess = null;
  midiSource = 'virtual';
  midiInput = null;
  uiParamPaths = [];
  uiButtonPaths = new Set();
  uiButtonOrder = [];
  lastUiButtonPath = null;
  pressedUiButtons.clear();
  stopParamPolling();
  outputParamHandlerAttached = false;
  uiZoom = 'auto';
  orbitZoom = '100';
  orbitUiBatchDepth = 0;
  orbitUiBatchSnapshotPending = false;
  if (orbitUiInstance) {
    orbitUiInstance.destroy();
    orbitUiInstance = null;
  }
  uiZoomWrap = null;
  uiZoomStage = null;
  teardownUiZoomObserver();
  teardownOrbitCanvasResize();
  if (orbitRafId) {
    cancelAnimationFrame(orbitRafId);
    orbitRafId = null;
  }
  orbitCanvas = null;
  orbitBody = null;
  orbitCtx = null;
  orbitState = null;
  orbitPointer = null;
  orbitNeedsDraw = false;
  orbitBaseWidth = 0;
  orbitBaseHeight = 0;
  lastOrbitParamSyncAt = 0;
  if (orbitParamSyncTimer) {
    clearTimeout(orbitParamSyncTimer);
    orbitParamSyncTimer = null;
  }
  remoteSyncInFlight = false;
  controlsSplit = null;
  controlsClassicPane = null;
  controlsOrbitPane = null;
  if (remoteSyncTimer) {
    clearInterval(remoteSyncTimer);
    remoteSyncTimer = null;
  }
  lastAppliedTriggerNonce = 0;
  lastAppliedRemoteOrbitNonce = 0;
  pendingOrbitUi = null;
  lastSpectrumSummary = null;
  clearAllParamSmoothing();
}

function cleanupAudio() {
  releasePressedUiButtons();
  uninstallUiReleaseGuard();
  if (scopeRafId) {
    cancelAnimationFrame(scopeRafId);
    scopeRafId = null;
  }
  noteOffMidi();
  stopParamPolling();
  disconnectMidiDevice();
  stopAudioOutput();
  if (dspNode) {
    try {
      dspNode.disconnect();
    } catch {
      // ignore
    }
    dspNode = null;
  }
  if (audioContext) {
    try {
      audioContext.close();
    } catch {
      // ignore
    }
    audioContext = null;
  }
  analyserNode = null;
  outputNode = null;
  audioRunning = false;
  outputParamHandlerAttached = false;
  teardownUiZoomObserver();
  uiZoomWrap = null;
  uiZoomStage = null;
  clearAllParamSmoothing();
}

function createScopeState(canvas) {
  const ctx = canvas.getContext('2d');
  resizeCanvasToDisplaySize(canvas, ctx);
  return {
    canvas,
    ctx,
    view: 'freq',
    spectrumScale: 'log',
    mode: 'auto',
    slope: 'rising',
    threshold: 0.0,
    holdoffMs: 20,
    windowSize: 1024,
    sampleRate: 44100,
    fftSize: 2048,
    lastTriggerSample: -Infinity,
    sampleCounter: 0,
    lastWindow: null
  };
}

function setupScope(context, node, scope) {
  resizeCanvasToDisplaySize(scope.canvas, scope.ctx);
  analyserNode = context.createAnalyser();
  analyserNode.fftSize = Math.max(8192, scope.windowSize * 2);
  analyserNode.smoothingTimeConstant = 0;
  scope.sampleRate = context.sampleRate;
  scope.fftSize = analyserNode.fftSize;

  node.connect(analyserNode);
  const gain = context.createGain();
  analyserNode.connect(gain);

  const buffer = new Float32Array(analyserNode.fftSize);
  const freqBuffer = new Float32Array(analyserNode.frequencyBinCount);

  const draw = () => {
    analyserNode.getFloatTimeDomainData(buffer);
    lastAudioQuality = computeAudioQuality(buffer);
    if (scope.view === 'freq') {
      analyserNode.getFloatFrequencyData(freqBuffer);
      drawSpectrum(scope, freqBuffer);
    } else {
      scope.sampleCounter += buffer.length;
      const window = findTriggeredWindow(buffer, scope);
      if (window) {
        scope.lastWindow = window;
        drawScope(scope, window);
      } else if (scope.mode === 'auto') {
        const fallback = buffer.slice(0, scope.windowSize);
        scope.lastWindow = fallback;
        drawScope(scope, fallback);
      } else if (scope.lastWindow) {
        drawScope(scope, scope.lastWindow);
      }
    }
    scopeRafId = requestAnimationFrame(draw);
  };

  scopeRafId = requestAnimationFrame(draw);
  return gain;
}

function startAudioOutput() {
  if (!audioContext || !outputNode) return;
  if (audioRunning) return;
  try {
    outputNode.connect(audioContext.destination);
    audioRunning = true;
  } catch {
    // ignore
  }
}

function stopAudioOutput() {
  if (!outputNode) return;
  try {
    outputNode.disconnect();
  } catch {
    // ignore
  }
  audioRunning = false;
}

async function resumeAudioContext() {
  if (!audioContext) return;
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  if (audioContext.state !== 'running') {
    throw new Error(
      'Audio start blocked by browser policy. Click "Audio | Off" once in Run view to unlock audio.'
    );
  }
}

function findTriggeredWindow(buffer, scope) {
  const threshold = scope.threshold;
  const slope = scope.slope;
  const holdoffSamples = Math.floor((scope.holdoffMs / 1000) * scope.sampleRate);
  if (scope.sampleCounter - scope.lastTriggerSample < holdoffSamples) {
    return null;
  }

  for (let i = 1; i < buffer.length; i++) {
    const prev = buffer[i - 1];
    const curr = buffer[i];
    const crossing =
      slope === 'rising'
        ? prev < threshold && curr >= threshold
        : prev > threshold && curr <= threshold;
    if (crossing) {
      scope.lastTriggerSample = scope.sampleCounter - (buffer.length - i);
      return extractWindow(buffer, i, scope.windowSize);
    }
  }
  return null;
}

function extractWindow(buffer, start, size) {
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = buffer[(start + i) % buffer.length];
  }
  return out;
}

function drawScope(scope, data) {
  resizeCanvasToDisplaySize(scope.canvas, scope.ctx);
  const { ctx, canvas } = scope;
  if (!ctx) return;
  const { width, height } = getCanvasSize(canvas);
  const innerWidth = Math.max(0, width - 1);
  const innerHeight = Math.max(0, height - 1);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, width, height);
  drawScopeGrid(ctx, innerWidth, innerHeight);
  ctx.strokeStyle = '#4bd';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const midY = innerHeight / 2;
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * innerWidth;
    const y = midY - data[i] * (innerHeight * 0.45);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // draw threshold
  const tY = midY - scope.threshold * (innerHeight * 0.45);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.beginPath();
  ctx.moveTo(0, tY);
  ctx.lineTo(innerWidth, tY);
  ctx.stroke();
}

function drawScopeGrid(ctx, width, height) {
  const major = 4;
  const minor = 5;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;

  // Vertical major
  for (let i = 1; i < major; i++) {
    const x = (i / major) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // Horizontal major
  for (let i = 1; i < major; i++) {
    const y = (i / major) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Minor grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  for (let i = 1; i < major * minor; i++) {
    const x = (i / (major * minor)) * width;
    if (i % minor !== 0) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }
  for (let i = 1; i < major * minor; i++) {
    const y = (i / (major * minor)) * height;
    if (i % minor !== 0) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawSpectrum(scope, data) {
  resizeCanvasToDisplaySize(scope.canvas, scope.ctx);
  const { ctx, canvas } = scope;
  if (!ctx) return;
  const { width, height } = getCanvasSize(canvas);
  const innerWidth = Math.max(0, width - 1);
  const innerHeight = Math.max(0, height - 1);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, width, height);
  drawSpectrumGrid(ctx, innerWidth, innerHeight, scope);

  const sampleRate = scope.sampleRate || 44100;
  const fftSize = scope.fftSize || 2048;
  const linear = scope.spectrumScale === 'linear';
  const fmin = linear ? 0 : 20;
  const fmax = sampleRate / 2;
  const logMin = Math.log10(fmin || 1);
  const logMax = Math.log10(fmax);
  ctx.fillStyle = '#4bd';
  const binCount = data.length;
  if (true) {
    const floorDb = -110;
    const smoothRadius = 2;
    const smoothed = new Float32Array(binCount);
    for (let i = 0; i < binCount; i++) {
      let sum = 0;
      let count = 0;
      for (let k = -smoothRadius; k <= smoothRadius; k++) {
        const idx = i + k;
        if (idx < 0 || idx >= binCount) continue;
        sum += data[idx];
        count += 1;
      }
      smoothed[i] = count > 0 ? sum / count : data[i];
    }
    ctx.save();
    ctx.translate(0.5, 0.5);
    ctx.strokeStyle = '#4bd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = 1; i < binCount; i++) {
      const f = (i / binCount) * fmax;
      if (!linear && f < fmin) continue;
      const x = linear
        ? (i / (binCount - 1)) * innerWidth
        : ((Math.log10(f) - logMin) / (logMax - logMin)) * innerWidth;
      const v = smoothed[i];
      const norm = Math.max(0, Math.min(1, (v - floorDb) / (-floorDb)));
      const y = innerHeight - norm * innerHeight;
      const px = Math.round(x);
      const py = Math.round(y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
    ctx.restore();
    // Nettoyage : efface les pixels résiduels sous le niveau minimal
    ctx.fillStyle = '#111';
    ctx.fillRect(0, innerHeight+1, innerWidth, 2);
    sendSpectrumSnapshot(scope, smoothed, {
      scale: linear ? 'linear' : 'log',
      fmin,
      fmax,
      floorDb,
      audioQuality: lastAudioQuality || undefined
    });
  }

  drawFreqAxis(ctx, innerWidth, innerHeight, fmin, fmax, scope.spectrumScale);
}

function drawFreqAxis(ctx, width, height, fmin, fmax, scale) {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const linear = scale === 'linear';
  const ticks = linear
    ? [0, 1000, 2000, 5000, 10000, 15000, 20000]
    : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const logMin = Math.log10(fmin || 1);
  const logMax = Math.log10(fmax);

  ticks.forEach((f) => {
    if (f < fmin || f > fmax) return;
    const x = linear
      ? ((f - fmin) / (fmax - fmin)) * width
      : ((Math.log10(f) - logMin) / (logMax - logMin)) * width;
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, height - 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(x, height - 18);
    ctx.lineTo(x, height);
    ctx.stroke();
  });

  ctx.restore();
}

function drawSpectrumGrid(ctx, width, height, scope) {
  const linear = scope.spectrumScale === 'linear';
  const fmin = linear ? 0 : 20;
  const fmax = scope.sampleRate ? scope.sampleRate / 2 : 22050;
  const logMin = Math.log10(fmin || 1);
  const logMax = Math.log10(fmax);

  // Horizontal amplitude grid (discrete)
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  const rows = 4;
  for (let i = 1; i < rows; i++) {
    const y = (i / rows) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();

  if (linear) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    const cols = 10;
    for (let i = 1; i < cols; i++) {
      const x = (i / cols) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // Musical grid (octaves + semitones)
  const midiMin = Math.ceil(69 + 12 * Math.log2(fmin / 440));
  const midiMax = Math.floor(69 + 12 * Math.log2(fmax / 440));

  for (let m = midiMin; m <= midiMax; m++) {
    const freq = 440 * Math.pow(2, (m - 69) / 12);
    const x = ((Math.log10(freq) - logMin) / (logMax - logMin)) * width;
    const isOctave = m % 12 === 0; // C notes
    ctx.strokeStyle = isOctave ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();

    if (isOctave) {
      const octave = Math.floor(m / 12) - 1;
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`C${octave}`, x + 2, 2);
    }
  }
}

function getCanvasSize(canvas) {
  return { width: canvas.clientWidth, height: canvas.clientHeight };
}

function resizeCanvasToDisplaySize(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}

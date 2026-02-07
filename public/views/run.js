/**
 * Vue Run
 * Exécute le DSP en WebAudio via FaustWASM
 */

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
let paramValues = {};
let uiParamPaths = [];
let uiButtonPaths = new Set();
let pressedUiButtons = new Set();
let uiReleaseHandlersInstalled = false;
let uiReleaseGuardHandler = null;
let emitRunStateFn = null;
let lastSpectrumSentAt = 0;
let lastSpectrumSummary = null;
let polyVoices = 0;
let midiTargets = null;
let activeMidiNote = null;
let midiAccess = null;
let midiSource = 'virtual';
let midiInput = null;
let midiOnly = true;
let paramPollId = null;
let outputParamHandlerAttached = false;
let uiZoom = 'auto';
let uiZoomWrap = null;
let uiZoomStage = null;
let uiResizeObserver = null;
let remoteSyncTimer = null;
let lastRunParamsSentAt = 0;
let lastAppliedTransportNonce = 0;
let lastAppliedTriggerNonce = 0;

export function getName() {
  return 'Run';
}

export async function render(container, { sha, runState, onRunStateChange }) {
  cleanupAudio();
  currentSha = sha;
  lastSpectrumSummary = null;

  container.innerHTML = `
    <div class="run-view">
      <div class="run-header">
        <button class="primary-btn" id="run-toggle">Start Audio</button>
        <span class="run-status">Idle</span>
        <label class="run-mode">Mode
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
        <label class="run-midi-source">MIDI
          <select id="midi-input"></select>
        </label>
        <label class="run-zoom">Zoom
          <select id="run-zoom">
            <option value="auto">Auto</option>
            <option value="50">50%</option>
            <option value="75">75%</option>
            <option value="100">100%</option>
            <option value="125">125%</option>
            <option value="150">150%</option>
          </select>
        </label>
        <div class="spacer"></div>
        <span class="run-note">FaustWASM</span>
      </div>
      <div class="run-controls" id="run-controls">
        <div class="info">Compiling...</div>
      </div>
      <div class="run-midi hidden" id="run-midi"></div>
      <div class="run-scope">
        <div class="run-scope-header">
          <span>Oscilloscope</span>
          <div class="run-scope-controls">
            <label>View
              <select id="scope-view">
                <option value="time">Waveform</option>
                <option value="freq">Spectrum</option>
              </select>
            </label>
            <label>Scale
              <select id="scope-scale">
                <option value="log">Log</option>
                <option value="linear">Linear</option>
              </select>
            </label>
            <label>Trigger
              <select id="scope-mode">
                <option value="auto">Auto</option>
                <option value="normal">Normal</option>
              </select>
            </label>
            <label>Slope
              <select id="scope-slope">
                <option value="rising">Rising</option>
                <option value="falling">Falling</option>
              </select>
            </label>
            <label>Threshold
              <input id="scope-threshold" class="scope-input" type="number" step="0.01" value="0.0">
            </label>
            <label>Holdoff (ms)
              <input id="scope-holdoff" class="scope-input" type="number" step="1" value="20">
            </label>
          </div>
        </div>
        <canvas id="scope-canvas" width="640" height="160"></canvas>
      </div>
    </div>
  `;

  const toggleBtn = container.querySelector('#run-toggle');
  const statusEl = container.querySelector('.run-status');
  const modeSelect = container.querySelector('#run-mode');
  const midiInputSelect = container.querySelector('#midi-input');
  const zoomSelect = container.querySelector('#run-zoom');
  const controlsEl = container.querySelector('#run-controls');
  const midiEl = container.querySelector('#run-midi');
  const scopeCanvas = container.querySelector('#scope-canvas');
  const scopeView = container.querySelector('#scope-view');
  const scopeScale = container.querySelector('#scope-scale');
  const scopeMode = container.querySelector('#scope-mode');
  const scopeSlope = container.querySelector('#scope-slope');
  const scopeThreshold = container.querySelector('#scope-threshold');
  const scopeHoldoff = container.querySelector('#scope-holdoff');

  scopeState = createScopeState(scopeCanvas);
  applyRunState(runState, {
    scopeView,
    scopeScale,
    scopeMode,
    scopeSlope,
    scopeThreshold,
    scopeHoldoff,
    modeSelect,
    midiInputSelect,
    zoomSelect
  });
  paramValues = runState && runState.params ? { ...runState.params } : {};
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

  const updateMidi = async () => {
    if (!midiEl) return;
    if (polyVoices > 0) {
      midiEl.classList.remove('hidden');
      renderMidiKeyboard(midiEl, compiledUI, {
        noteOn: async (note, velocity) => {
          if (!audioRunning) await startAudio();
          noteOnMidi(note, velocity);
        },
        noteOff: (note) => noteOffMidi(note)
      });
    } else {
      midiEl.classList.add('hidden');
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
        midiEl.classList.remove('hidden');
      }
    } else {
      midiEl.classList.add('hidden');
      await selectMidiDevice(value);
    }
    midiOnly = true;
  };

  midiInputSelect.addEventListener('change', async () => {
    await updateMidiSourceUi(midiInputSelect.value);
    emitRunState();
  });

  zoomSelect.addEventListener('change', () => {
    uiZoom = zoomSelect.value;
    applyUiZoom();
    emitRunState();
  });

  modeSelect.addEventListener('change', async () => {
    const value = modeSelect.value;
    polyVoices = value === 'mono' ? 0 : Math.max(1, parseInt(value, 10));
    emitRunState();
    const wasRunning = audioRunning;
    cleanupAudio();
    compiledGenerator = null;
    compiledGeneratorMode = 'mono';
    await updateMidi();
    if (wasRunning) {
      await startAudio();
    }
  });

  const prepared = prepareControlsContainer(controlsEl);
  controlsBg = prepared.bg;
  controlsContent = prepared.content;
  controlsContent.innerHTML = '<div class="info">Compiling...</div>';

  toggleBtn.disabled = true;
  statusEl.textContent = 'Compiling...';

  try {
    await compileAndRenderUI(controlsEl, sha, polyVoices);
    await updateMidi();
    statusEl.textContent = 'Ready';
  } catch (err) {
    statusEl.textContent = 'Error';
    const message = err && err.message ? err.message : String(err);
    controlsContent.innerHTML = `<div class="error">Error: ${message}</div>`;
  } finally {
    toggleBtn.disabled = false;
  }

  const startAudio = async () => {
    if (audioRunning) return;
    statusEl.textContent = 'Starting...';
    toggleBtn.disabled = true;

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
      startAudioOutput();
      startParamPolling();

      statusEl.textContent = 'Running';
      toggleBtn.textContent = 'Stop Audio';
      emitRunState();
    } catch (err) {
      console.error('Run view error:', err);
      cleanupAudio();
      statusEl.textContent = 'Error';
      const message = err && err.message ? err.message : String(err);
      const stack = err && err.stack ? err.stack : '';
      controlsContent.innerHTML = `
        <div class="error">Error: ${message}</div>
        <pre class="run-stack">${stack}</pre>
      `;
    } finally {
      toggleBtn.disabled = false;
    }
  };

  const stopAudio = () => {
    if (!audioRunning) return;
    stopAudioOutput();
    noteOffMidi();
    stopParamPolling();
    statusEl.textContent = 'Stopped';
    toggleBtn.textContent = 'Start Audio';
    emitRunState();
  };

  toggleBtn.addEventListener('click', async () => {
    if (audioRunning) {
      stopAudio();
    } else {
      await startAudio();
    }
  });

  const handleRunAreaClick = async (event) => {
    if (toggleBtn.disabled) return;
    const target = event.target;
    const inUiRoot = !!(currentUiRoot && target instanceof Element && currentUiRoot.contains(target));
    if (inUiRoot) {
      return;
    }
    if (audioRunning) {
      stopAudio();
    } else {
      await startAudio();
    }
  };

  controlsEl.addEventListener('click', handleRunAreaClick);

  remoteSyncTimer = setInterval(syncRemoteRunState, 100);
  await syncRemoteRunState();

  await updateMidi();
  if (runState && runState.audioRunning) {
    await startAudio();
  }
  emitRunState();

  async function syncRemoteRunState() {
    if (!currentSha) return;
    try {
      const response = await fetch('/api/state');
      if (!response.ok) return;
      const remote = await response.json();
      if (!remote || remote.sha1 !== currentSha) return;

      if (remote.runParams && typeof remote.runParams === 'object') {
        applyRemoteRunParams(remote.runParams);
      }

      if (remote.runTransport && typeof remote.runTransport.nonce === 'number') {
        const cmd = remote.runTransport;
        if (cmd.nonce !== lastAppliedTransportNonce) {
          lastAppliedTransportNonce = cmd.nonce;
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
        }
      }

      if (remote.runTrigger && typeof remote.runTrigger.nonce === 'number') {
        const trigger = remote.runTrigger;
        if (trigger.nonce !== lastAppliedTriggerNonce) {
          lastAppliedTriggerNonce = trigger.nonce;
          await executeLocalTrigger(trigger.path, trigger.holdMs);
        }
      }
    } catch {
      // ignore sync errors
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
    scope: {
      view: scopeState.view,
      spectrumScale: scopeState.spectrumScale,
      mode: scopeState.mode,
      slope: scopeState.slope,
      threshold: scopeState.threshold,
      holdoffMs: scopeState.holdoffMs
    },
    params: { ...paramValues }
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
  uiParamPaths = collectParamPaths(compiledUI);
  uiButtonPaths = collectButtonPaths(compiledUI);
  pressedUiButtons.clear();
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
  renderControls(controlsContent, compiledUI);
  updateUiRoot(controlsContent);
}

function renderControls(container, ui) {
  if (Array.isArray(ui) && ui.length > 0) {
    renderFaustUi(container, ui);
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

function renderMidiKeyboard(container, ui, handlers) {
  if (!container) return;
  const targets = findMidiTargets(ui);
  midiTargets = targets;
  container.innerHTML = '';

  if (!targets || (!targets.freq && !targets.key && !targets.gate)) {
    container.innerHTML = '<div class="info">No MIDI parameters detected.</div>';
    return;
  }

  const keyboard = document.createElement('div');
  keyboard.className = 'midi-keyboard';
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
  });

  const noteOn = async (note) => {
    if (activeMidiNote !== null) return;
    activeMidiNote = note;
    if (handlers && handlers.noteOn) {
      await handlers.noteOn(note, 0.8);
    }
  };
  const noteOff = () => {
    if (activeMidiNote === null) return;
    const note = activeMidiNote;
    activeMidiNote = null;
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

  const hint = document.createElement('div');
  hint.className = 'midi-hint';
  hint.textContent = 'Click to play (C4–B4).';

  container.appendChild(keyboard);
  container.appendChild(hint);
}

async function renderFaustUi(container, ui) {
  ensureFaustUiCss();
  container.innerHTML = '<div class="info">Loading UI...</div>';

  try {
    const { FaustUI } = await import('../vendor/faust-ui/index.js');
    container.innerHTML = '';
    const zoomWrap = document.createElement('div');
    zoomWrap.className = 'run-ui-zoom-wrap';
    const stage = document.createElement('div');
    stage.className = 'run-ui-zoom-stage';
    const uiRoot = document.createElement('div');
    uiRoot.className = 'faust-ui-root';
    stage.appendChild(uiRoot);
    zoomWrap.appendChild(stage);
    container.appendChild(zoomWrap);
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
      if (!dspNode) return;
      try {
        dspNode.setParamValue(path, value);
        paramValues[path] = value;
        if (uiButtonPaths.has(path)) {
          if (value > 0) pressedUiButtons.add(path);
          else pressedUiButtons.delete(path);
        }
        sendRunParamsSnapshot();
        if (emitRunStateFn) emitRunStateFn();
      } catch {
        // ignore
      }
    };

    applyParamValues();
    installUiReleaseGuard();
    setupUiZoomObserver();
    applyUiZoom();
  } catch (err) {
    console.error('Faust UI render error:', err);
    container.innerHTML = '<div class="error">Failed to load Faust UI.</div>';
    updateUiRoot(container);
  }
}

function collectButtonPaths(ui) {
  const paths = new Set();
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
      if (address) paths.add(address);
    }
  };
  walk(ui);
  return paths;
}

function releasePressedUiButtons() {
  if (pressedUiButtons.size === 0) return;
  for (const path of Array.from(pressedUiButtons)) {
    setParamValue(path, 0);
  }
  pressedUiButtons.clear();
  sendRunParamsSnapshot(true);
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
  if (!controlsContent || !uiZoomWrap || !uiZoomStage || !currentUiRoot) return;
  const naturalWidth = Math.max(currentUiRoot.scrollWidth, currentUiRoot.offsetWidth, 1);
  const naturalHeight = Math.max(currentUiRoot.scrollHeight, currentUiRoot.offsetHeight, 1);
  const availableWidth = Math.max(controlsContent.clientWidth - 20, 1);
  const availableHeight = Math.max(controlsContent.clientHeight - 20, 1);
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
  if (!controlsContent || !currentUiRoot) return;
  uiResizeObserver = new ResizeObserver(() => applyUiZoom());
  uiResizeObserver.observe(controlsContent);
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

function setParamValue(path, value) {
  if (!path) return;
  try {
    if (dspNode) {
      dspNode.setParamValue(path, value);
    }
    paramValues[path] = value;
    if (faustUIInstance) {
      faustUIInstance.paramChangeByDSP(path, value);
    }
    sendRunParamsSnapshot();
    if (emitRunStateFn) emitRunStateFn();
  } catch {
    // ignore
  }
}

function applyRemoteRunParams(remoteParams) {
  let changed = false;
  for (const [path, value] of Object.entries(remoteParams)) {
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    if (paramValues[path] === value) continue;
    try {
      if (dspNode) {
        dspNode.setParamValue(path, value);
      }
      paramValues[path] = value;
      if (faustUIInstance) {
        faustUIInstance.paramChangeByDSP(path, value);
      }
      changed = true;
    } catch {
      // ignore
    }
  }
  if (changed) {
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
    try {
      if (dspNode) {
        dspNode.setParamValue(path, value);
      }
      if (faustUIInstance) {
        faustUIInstance.paramChangeByDSP(path, value);
      }
    } catch {
      // ignore
    }
  }
}

function attachOutputParamHandler() {
  if (!dspNode || typeof dspNode.setOutputParamHandler !== 'function') return;
  dspNode.setOutputParamHandler((path, value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    paramValues[path] = value;
    if (faustUIInstance) {
      faustUIInstance.paramChangeByDSP(path, value);
    }
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
    for (const path of paths) {
      try {
        const value = dspNode.getParamValue(path);
        if (typeof value !== 'number' || Number.isNaN(value)) continue;
        if (paramValues[path] !== value) {
          paramValues[path] = value;
          faustUIInstance.paramChangeByDSP(path, value);
        }
      } catch {
        // ignore
      }
    }
    if (emitRunStateFn) emitRunStateFn();
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
  container.appendChild(bg);
  container.appendChild(content);
  return { bg, content };
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
    floorDb
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
  if (typeof runState.midiSource === 'string') {
    midiSource = runState.midiSource;
    if (controls.midiInputSelect) {
      controls.midiInputSelect.value = midiSource;
    }
  }
  if (runState.uiZoom && controls.zoomSelect) {
    uiZoom = String(runState.uiZoom);
    controls.zoomSelect.value = uiZoom;
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
  pressedUiButtons.clear();
  stopParamPolling();
  outputParamHandlerAttached = false;
  uiZoom = 'auto';
  uiZoomWrap = null;
  uiZoomStage = null;
  teardownUiZoomObserver();
  if (remoteSyncTimer) {
    clearInterval(remoteSyncTimer);
    remoteSyncTimer = null;
  }
  lastAppliedTriggerNonce = 0;
  lastSpectrumSummary = null;
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
    if (scope.view === 'freq') {
      analyserNode.getFloatFrequencyData(freqBuffer);
      drawSpectrum(scope, freqBuffer);
    } else {
      analyserNode.getFloatTimeDomainData(buffer);
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
    try {
      await audioContext.resume();
    } catch {
      // ignore
    }
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
      floorDb
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

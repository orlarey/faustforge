/**
 * faustforge Frontend Application
 * Navigation de sessions inspirée de faustservice
 */

// État de l'application
const state = {
  currentSha: null,
  currentView: 'dsp',
  views: [],
  sessions: [],        // Sessions triées par date (plus anciennes d'abord)
  sessionIndex: -1,    // -1 = pas initialisé, sessions.length = session vide
  dragCounter: 0,      // Compteur pour gérer dragenter/dragleave
  runStateBySha: {},   // État Run par session (params)
  audioUnlocked: false,
  runGlobal: {
    audioRunning: false,
    scope: null,
    polyVoices: 0,
    midiSource: 'virtual',
    uiZoom: 'auto',
    orbitZoom: '100',
    orbitUi: null
  },
  viewScroll: {
    dsp: { line: 1 },
    cpp: { line: 1 }
  },
  viewScrollBySha: {}
};

// Éléments DOM
const fileInput = document.getElementById('file-input');
const downloadBtn = document.getElementById('download-btn');
const errorBanner = document.getElementById('error-banner');
const viewContainer = document.getElementById('view-container');
const sessionLabel = document.getElementById('session-label');
const sessionPrev = document.getElementById('session-prev');
const sessionNext = document.getElementById('session-next');
const viewSelect = document.getElementById('view-select');
const dropOverlay = document.getElementById('drop-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const footerVersion = document.getElementById('footer-version');
const deleteSessionBtn = document.getElementById('delete-session');
const refreshSessionBtn = document.getElementById('refresh-session');
const audioGate = document.getElementById('audio-gate');
const audioGateButton = document.getElementById('audio-gate-button');
const audioGateStatus = document.getElementById('audio-gate-status');
let lastStateTs = 0;
let pasteSink = null;

/**
 * Charge dynamiquement les modules de vue
 */
async function loadViews() {
  const viewModules = ['dsp', 'svg', 'run', 'cpp', 'tasks', 'signals'];

  for (const viewName of viewModules) {
    try {
      const module = await import(`./views/${viewName}.js`);
      state.views.push({
        id: viewName,
        name: module.getName(),
        render: module.render,
        dispose: module.dispose
      });
    } catch (err) {
      console.error(`Failed to load view ${viewName}:`, err);
    }
  }

  // Générer le sélecteur de vue
  generateViewSelect();
}

/**
 * Génère le sélecteur de vue
 */
function generateViewSelect() {
  viewSelect.innerHTML = '';
  for (const view of state.views) {
    const option = document.createElement('option');
    option.value = view.id;
    option.textContent = view.name;
    if (view.id === state.currentView) {
      option.selected = true;
    }
    viewSelect.appendChild(option);
  }
}

/**
 * Change la vue active
 */
async function switchView(viewId) {
  hideError();
  if (viewId !== state.currentView) {
    captureScrollLine();
    const currentView = state.views.find(v => v.id === state.currentView);
    if (currentView && typeof currentView.dispose === 'function') {
      try {
        currentView.dispose();
      } catch {
        // Ignorer les erreurs de cleanup
      }
    }
  }

  state.currentView = viewId;
  if (viewSelect.value !== viewId) {
    viewSelect.value = viewId;
  }

  // Persist view first to avoid race with Run view state updates (/api/state).
  await syncState({ view: viewId });

  // Afficher la vue
  await renderCurrentView();
}

/**
 * Affiche la vue courante
 */
async function renderCurrentView() {
  if (!state.currentSha) return;

  const view = state.views.find(v => v.id === state.currentView);
  if (!view) return;

  viewContainer.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const runState =
      view.id === 'run' && state.currentSha
        ? {
            audioRunning: state.runGlobal.audioRunning,
            scope: state.runGlobal.scope,
            polyVoices: state.runGlobal.polyVoices,
            midiSource: state.runGlobal.midiSource,
            uiZoom: state.runGlobal.uiZoom,
            orbitZoom: state.runGlobal.orbitZoom,
            params: state.runStateBySha[state.currentSha]?.params,
            orbitUi: state.runStateBySha[state.currentSha]?.orbitUi || state.runGlobal.orbitUi
          }
        : undefined;
    const perSession =
      state.currentSha && state.viewScrollBySha[state.currentSha]
        ? state.viewScrollBySha[state.currentSha][view.id]
        : null;
    const scrollState = perSession || state.viewScroll[view.id];
    await view.render(viewContainer, {
      sha: state.currentSha,
      runState,
      scrollState,
      onError: (message) => {
        if (typeof message === 'string' && message.trim()) {
          showError(message);
        }
      },
      onClearError: () => {
        hideError();
      },
      onRunStateChange: (snapshot) => {
        if (!state.currentSha || !snapshot) return;
        if (snapshot.scope) {
          state.runGlobal.scope = snapshot.scope;
        }
        if (typeof snapshot.audioRunning === 'boolean') {
          state.runGlobal.audioRunning = snapshot.audioRunning;
        }
        if (typeof snapshot.polyVoices === 'number') {
          state.runGlobal.polyVoices = snapshot.polyVoices;
        }
        if (typeof snapshot.midiSource === 'string') {
          state.runGlobal.midiSource = snapshot.midiSource;
        }
        if (snapshot.uiZoom) {
          state.runGlobal.uiZoom = String(snapshot.uiZoom);
        }
        if (snapshot.orbitZoom) {
          state.runGlobal.orbitZoom = String(snapshot.orbitZoom);
        }
        if (snapshot.orbitUi && typeof snapshot.orbitUi === 'object') {
          state.runGlobal.orbitUi = snapshot.orbitUi;
          state.runStateBySha[state.currentSha] = {
            ...(state.runStateBySha[state.currentSha] || {}),
            orbitUi: snapshot.orbitUi
          };
        }
        if (snapshot.params) {
          state.runStateBySha[state.currentSha] = {
            ...(state.runStateBySha[state.currentSha] || {}),
            params: snapshot.params
          };
        }
      },
      onScrollChange: (line) => {
        if (!scrollState || typeof line !== 'number') return;
        scrollState.line = line;
        if (state.currentSha) {
          if (!state.viewScrollBySha[state.currentSha]) {
            state.viewScrollBySha[state.currentSha] = {};
          }
          state.viewScrollBySha[state.currentSha][view.id] = { line };
        }
      }
    });
  } catch (err) {
    viewContainer.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}

/**
 * Charge les sessions existantes (ordre de création, plus anciennes d'abord)
 */
async function loadSessions() {
  try {
    const response = await fetch('/api/sessions?limit=100');
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to load sessions');
    }
    state.sessions = result.sessions || [];
  } catch (err) {
    console.warn('Failed to load sessions:', err);
    state.sessions = [];
  }
}

/**
 * Met à jour l'index de session pour le SHA courant
 */
function refreshSessionIndex() {
  if (!state.currentSha) {
    // Session vide = index au-delà du tableau
    state.sessionIndex = state.sessions.length;
    return;
  }
  const idx = state.sessions.findIndex(s => s.sha1 === state.currentSha);
  state.sessionIndex = idx >= 0 ? idx : state.sessions.length;
}

/**
 * Met à jour l'affichage de la navigation de session
 */
function updateSessionNavigation() {
  const isEmpty = state.sessionIndex >= state.sessions.length || state.sessionIndex < 0;

  if (isEmpty) {
    // Session vide
    sessionLabel.textContent = 'Empty | Drop or Click';
    sessionLabel.classList.add('clickable');
    sessionPrev.disabled = state.sessions.length === 0;
    sessionNext.disabled = true;
    if (deleteSessionBtn) deleteSessionBtn.classList.add('hidden');
    if (refreshSessionBtn) refreshSessionBtn.classList.add('hidden');
    if (downloadBtn) downloadBtn.classList.add('hidden');
  } else {
    // Session active
    const session = state.sessions[state.sessionIndex];
    const shortSha = session.sha1.slice(0, 8);
    sessionLabel.textContent = `${shortSha}… | ${session.filename}`;
    sessionLabel.classList.remove('clickable');
    sessionPrev.disabled = state.sessionIndex === 0;
    sessionNext.disabled = false; // On peut toujours aller vers session vide
    if (deleteSessionBtn) deleteSessionBtn.classList.remove('hidden');
    if (refreshSessionBtn) refreshSessionBtn.classList.remove('hidden');
    if (downloadBtn) downloadBtn.classList.remove('hidden');
  }
}

/**
 * Navigue vers la session précédente (plus ancienne)
 */
async function navigateToPrevious() {
  if (state.sessionIndex > 0) {
    state.sessionIndex--;
    await loadSessionByIndex(state.sessionIndex);
  }
}

/**
 * Navigue vers la session suivante (plus récente) ou session vide
 */
async function navigateToNext() {
  if (state.sessionIndex < state.sessions.length) {
    state.sessionIndex++;
    if (state.sessionIndex < state.sessions.length) {
      await loadSessionByIndex(state.sessionIndex);
    } else {
      // Aller vers session vide
      await loadEmptySession();
    }
  }
}

/**
 * Charge une session par son index
 */
async function loadSessionByIndex(index) {
  if (index < 0 || index >= state.sessions.length) return;

  captureScrollLine();

  const session = state.sessions[index];
  state.currentSha = session.sha1;
  state.sessionIndex = index;

  updateSessionNavigation();
  hideError();

  // Charger les erreurs de la session
  try {
    const errorsResponse = await fetch(`/api/${session.sha1}/errors.log`);
    if (errorsResponse.ok) {
      const errors = await errorsResponse.text();
      if (errors.trim()) {
        showError(errors);
      }
    }
  } catch {
    // Ignorer les erreurs de chargement des erreurs
  }

  showInterface();
  await renderCurrentView();
  syncState({ sha1: session.sha1, view: state.currentView });
}

/**
 * Charge une session vide
 */
async function loadEmptySession() {
  captureScrollLine();
  state.currentSha = null;
  state.sessionIndex = state.sessions.length;

  updateSessionNavigation();
  hideError();
  hideInterface();
  syncState({ sha1: null, view: state.currentView });
}

/**
 * Affiche l'overlay de chargement
 */
function showLoading() {
  loadingOverlay.classList.remove('hidden');
}

/**
 * Cache l'overlay de chargement
 */
function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

function showAudioGate(message = '') {
  if (!audioGate) return;
  audioGate.classList.remove('hidden');
  if (audioGateStatus) {
    if (message) {
      audioGateStatus.textContent = message;
      audioGateStatus.classList.remove('hidden');
    } else {
      audioGateStatus.textContent = '';
      audioGateStatus.classList.add('hidden');
    }
  }
}

function hideAudioGate() {
  if (!audioGate) return;
  audioGate.classList.add('hidden');
  if (audioGateStatus) {
    audioGateStatus.textContent = '';
    audioGateStatus.classList.add('hidden');
  }
}

async function unlockAudioGate() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    throw new Error('WebAudio is not available in this browser.');
  }
  const ctx = new Ctx();
  try {
    await ctx.resume();
    if (ctx.state !== 'running') {
      throw new Error('Audio unlock failed. Please click again.');
    }
  } finally {
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Soumet du code Faust au serveur
 */
async function submitCode(code, filename) {
  // Afficher l'état de chargement
  showLoading();
  hideError();

  try {
    captureScrollLine();
    const response = await fetch('/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ code, filename })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Submission failed');
    }

    // Mettre à jour l'état
    state.currentSha = result.sha1;

    // Recharger la liste des sessions
    await loadSessions();
    refreshSessionIndex();
    updateSessionNavigation();

    // Afficher les erreurs s'il y en a
    if (result.errors && result.errors.trim()) {
      showError(result.errors);
    }

    // Afficher l'interface
    showInterface();

    // Persist new active session first to avoid poll race reverting to previous session.
    await syncState({ sha1: state.currentSha, view: state.currentView });

    // Rendre la vue courante
    await renderCurrentView();

  } catch (err) {
    showError(`Error: ${err.message}`);
  } finally {
    hideLoading();
  }
}

/**
 * Soumet un fichier .dsp
 */
async function submitFile(file) {
  const code = await file.text();
  const filename = file.name;
  await submitCode(code, filename);
}

function makeClipFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `clip-${ts}.dsp`;
}

function isTextInputTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return !!target.closest('[contenteditable="true"]');
}

function getCurrentViewIndex() {
  if (!Array.isArray(state.views) || state.views.length === 0) return -1;
  return state.views.findIndex((v) => v.id === state.currentView);
}

async function navigateViewByOffset(offset) {
  if (!Array.isArray(state.views) || state.views.length === 0) return;
  const currentIndex = getCurrentViewIndex();
  if (currentIndex < 0) return;
  const nextIndex = (currentIndex + offset + state.views.length) % state.views.length;
  const nextView = state.views[nextIndex];
  if (!nextView) return;
  await switchView(nextView.id);
}

function ensurePasteSink() {
  if (pasteSink) return pasteSink;
  const sink = document.createElement('textarea');
  sink.setAttribute('aria-hidden', 'true');
  sink.tabIndex = -1;
  sink.autocapitalize = 'off';
  sink.autocomplete = 'off';
  sink.style.position = 'fixed';
  sink.style.left = '-10000px';
  sink.style.top = '0';
  sink.style.width = '1px';
  sink.style.height = '1px';
  sink.style.opacity = '0';
  sink.style.pointerEvents = 'none';
  document.body.appendChild(sink);
  pasteSink = sink;
  return sink;
}

function captureScrollLine() {
  if (!state.currentSha) return;
  if (state.currentView !== 'dsp' && state.currentView !== 'cpp') return;
  const content = viewContainer.querySelector('.code-content');
  if (!content) return;
  const lineHeight = parseFloat(getComputedStyle(content).lineHeight) || 16;
  const topLine = Math.floor(content.scrollTop / lineHeight) + 1;
  const entry = state.viewScroll[state.currentView];
  if (entry) {
    entry.line = topLine;
  }
  if (!state.viewScrollBySha[state.currentSha]) {
    state.viewScrollBySha[state.currentSha] = {};
  }
  state.viewScrollBySha[state.currentSha][state.currentView] = { line: topLine };
}

/**
 * Affiche le bandeau d'erreur
 */
function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

/**
 * Cache le bandeau d'erreur
 */
function hideError() {
  errorBanner.classList.add('hidden');
  errorBanner.textContent = '';
}

/**
 * Affiche l'interface (conteneur de vue)
 */
function showInterface() {
  viewContainer.classList.remove('hidden');
  viewContainer.innerHTML = '';
}

/**
 * Cache l'interface
 */
function hideInterface() {
  const claudeConfig = getClaudeMcpConfigText();
  viewContainer.classList.remove('hidden');
  viewContainer.innerHTML = `
    <div class="empty-state">
      <div class="empty-center">
        <div class="empty-icon" aria-hidden="true"></div>
        <div class="empty-title">Drop a .dsp file here</div>
        <div class="empty-subtitle">or click to select a file</div>
      </div>
      <div class="empty-mcp-wrap">
        <button type="button" class="empty-mcp-copy" data-copy="mcp-config">Copy</button>
        <pre class="empty-mcp"><code>${escapeHtml(claudeConfig)}</code></pre>
      </div>
    </div>
  `;
  const copyConfigBtn = viewContainer.querySelector('[data-copy="mcp-config"]');
  if (copyConfigBtn) {
    copyConfigBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await copyToClipboard(claudeConfig);
    });
  }
}

function getClaudeMcpConfigText() {
  return JSON.stringify(
    {
      mcpServers: {
        faustforge: {
          command: 'docker',
          args: ['exec', '-i', 'faustforge', 'node', '/app/mcp.mjs']
        }
      }
    },
    null,
    2
  );
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore clipboard errors silently
  }
}

// Event listeners
if (downloadBtn) {
  downloadBtn.addEventListener('click', async () => {
    if (state.sessionIndex >= state.sessions.length || state.sessionIndex < 0) return;
    const session = state.sessions[state.sessionIndex];
    if (!session) return;

    const base = session.filename.replace(/\.dsp$/i, '') || 'session';
    let url = `/api/${session.sha1}/download/dsp`;
    let filename = `${base}.dsp`;

    if (state.currentView === 'cpp') {
      url = `/api/${session.sha1}/download/cpp`;
      filename = `${base}.cpp`;
    } else if (state.currentView === 'signals') {
      url = `/api/${session.sha1}/download/signals`;
      filename = `${base}-sig.dot`;
    } else if (state.currentView === 'tasks') {
      url = `/api/${session.sha1}/download/tasks`;
      filename = `${base}.dsp.dot`;
    } else if (state.currentView === 'svg') {
      url = `/api/${session.sha1}/download/svg`;
      filename = `${base}-svg.zip`;
    } else if (state.currentView === 'run') {
      url = `/api/${session.sha1}/download/pwa`;
      filename = `${base}-pwa.zip`;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Download failed');
      }
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      showError(`Error: ${err.message}`);
    }
  });
}

async function syncState(partial) {
  try {
    const response = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial)
    });
    if (response.ok) {
      const result = await response.json();
      if (result && typeof result.updatedAt === 'number') {
        lastStateTs = Math.max(lastStateTs, result.updatedAt);
      }
    }
  } catch {
    // ignore
  }
}

async function pollState() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) return;
    const remote = await response.json();
    if (!remote || typeof remote.updatedAt !== 'number') return;
    if (remote.updatedAt <= lastStateTs) return;

    lastStateTs = remote.updatedAt;
    if (typeof remote.audioUnlocked === 'boolean') {
      state.audioUnlocked = remote.audioUnlocked;
      if (state.audioUnlocked) {
        hideAudioGate();
      } else {
        showAudioGate();
      }
    }

    if (remote.view && remote.view !== state.currentView) {
      await switchView(remote.view);
    }

    if (remote.sha1 && remote.sha1 !== state.currentSha) {
      let idx = state.sessions.findIndex(s => s.sha1 === remote.sha1);
      if (idx < 0) {
        await loadSessions();
        refreshSessionIndex();
        updateSessionNavigation();
        idx = state.sessions.findIndex(s => s.sha1 === remote.sha1);
      }
      if (idx >= 0) {
        await loadSessionByIndex(idx);
      }
    } else if (remote.sha1 === null && state.currentSha !== null) {
      await loadEmptySession();
    }
  } catch {
    // ignore
  }
}

// Clic sur le label de session (pour charger un fichier si vide)
sessionLabel.addEventListener('click', () => {
  if (state.sessionIndex >= state.sessions.length) {
    fileInput.click();
  }
});

viewContainer.addEventListener('click', (event) => {
  if (state.sessionIndex >= state.sessions.length) {
    if (event.target && event.target.closest('.empty-mcp-wrap')) {
      return;
    }
    fileInput.click();
  }
});

viewSelect.addEventListener('change', (e) => {
  const viewId = e.target.value;
  switchView(viewId);
});

sessionPrev.addEventListener('click', navigateToPrevious);
sessionNext.addEventListener('click', navigateToNext);

if (deleteSessionBtn) {
  deleteSessionBtn.addEventListener('click', async () => {
    if (state.sessionIndex >= state.sessions.length || state.sessionIndex < 0) return;
    const session = state.sessions[state.sessionIndex];
    if (!session) return;

    const confirmed = window.confirm(`Delete session ${session.filename}?`);
    if (!confirmed) return;

    try {
      const response = await fetch(`/api/${session.sha1}`, { method: 'DELETE' });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || 'Delete failed');
      }

      await loadSessions();
      // Move to previous session if possible, else empty
      if (state.sessions.length === 0) {
        await loadEmptySession();
      } else if (state.sessionIndex > 0) {
        await loadSessionByIndex(state.sessionIndex - 1);
      } else {
        await loadSessionByIndex(0);
      }
    } catch (err) {
      showError(`Error: ${err.message}`);
    }
  });
}

if (refreshSessionBtn) {
  refreshSessionBtn.addEventListener('click', async () => {
    if (state.sessionIndex >= state.sessions.length || state.sessionIndex < 0) return;
    const session = state.sessions[state.sessionIndex];
    if (!session) return;

    showLoading();
    hideError();

    try {
      const response = await fetch(`/api/${session.sha1}/refresh`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Refresh failed');
      }

      await loadSessions();
      refreshSessionIndex();
      updateSessionNavigation();

      if (result.errors && result.errors.trim()) {
        showError(result.errors);
      }

      showInterface();
      await renderCurrentView();
    } catch (err) {
      showError(`Error: ${err.message}`);
    } finally {
      hideLoading();
    }
  });
}

if (audioGateButton) {
  audioGateButton.addEventListener('click', async () => {
    if (state.audioUnlocked) {
      hideAudioGate();
      return;
    }
    audioGateButton.disabled = true;
    showAudioGate();
    try {
      await unlockAudioGate();
      state.audioUnlocked = true;
      await syncState({ audioUnlocked: true });
      hideAudioGate();
      hideError();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      showAudioGate(message);
      showError(`Audio unlock required: ${message}`);
    } finally {
      audioGateButton.disabled = false;
    }
  });
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) {
    submitFile(file);
  }
});

// Drag & drop pleine page
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  state.dragCounter++;
  if (state.dragCounter === 1) {
    dropOverlay.classList.remove('hidden');
  }
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  state.dragCounter--;
  if (state.dragCounter === 0) {
    dropOverlay.classList.add('hidden');
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  state.dragCounter = 0;
  dropOverlay.classList.add('hidden');

  const file = e.dataTransfer?.files?.[0];
  if (file && file.name.endsWith('.dsp')) {
    submitFile(file);
  } else if (file) {
    showError('Please drop a .dsp file');
  }
});

// Paste plain text code directly as a new DSP session.
window.addEventListener('paste', (e) => {
  const target = e.target;
  if (isTextInputTarget(target) && target !== pasteSink) return;
  const text = e.clipboardData?.getData('text/plain') || '';
  if (!text.trim()) return;
  e.preventDefault();
  submitCode(text, makeClipFilename());
}, true);

document.addEventListener('keydown', (e) => {
  const isPasteShortcut = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V');
  if (!isPasteShortcut) return;
  if (isTextInputTarget(e.target)) return;
  const sink = ensurePasteSink();
  sink.value = '';
  sink.focus();
  sink.select();
});

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTextInputTarget(e.target)) return;

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    navigateToPrevious();
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    navigateToNext();
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    navigateViewByOffset(-1);
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    navigateViewByOffset(1);
  }
});

// Initialisation
async function init() {
  await loadViews();
  await loadSessions();

  // Initialiser à la session vide
  state.sessionIndex = state.sessions.length;
  updateSessionNavigation();
  hideInterface();
  showAudioGate();
  state.audioUnlocked = false;

  // Sync initial state and require explicit audio unlock per opened tab.
  syncState({ sha1: null, view: state.currentView, audioUnlocked: false });

  // Charger la version Faust pour le footer
  if (footerVersion) {
    try {
      const response = await fetch('/api/version');
      const result = await response.json();
      if (response.ok && result.version) {
        footerVersion.textContent = result.version;
      }
    } catch {
      // Ignorer si indisponible
    }
  }

  // Poll shared state (MCP may update it)
  setInterval(pollState, 1500);
}

init();

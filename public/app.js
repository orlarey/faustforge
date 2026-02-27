/**
 * faustforge Frontend Application
 * Navigation de sessions inspirée de faustservice
 */
import { TOOLTIP_TEXTS } from './tooltip-texts.js';

// État de l'application
const state = {
  currentSha: null,
  currentView: 'dsp',
  sessionOrder: 'chronological', // chronological | usage
  views: [],
  sessions: [],        // Sessions triées selon sessionOrder
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
  viewScrollBySha: {},
  showcase: {
    active: false,
    sha: null,
    viewTimer: null
  }
};

const SHOWCASE_FILENAME = 'showcase-organ.dsp';
const SHOWCASE_CODE = `import("stdfaust.lib");

process = organ;

organ = timbre (freq) * gate * gain * volume
with {
    freq = hslider("freq", 440, 40, 8000, 1);
    gate = button("gate") : fi.lowpass(1,1);
    gain = hslider("gain", 0, 0, 1, 0.01);
    volume = hslider("volume", 0.25, 0, 1, 0.01);
    timbre(f) = osc(f) * 0.5 + osc(2*f) * 0.25;
    osc(f) = phase(f) * 2 * ma.PI : sin;
    phase(f) = f/ma.SR : (+ : %(1.0)) ~ _;
};
`;

// Éléments DOM
const fileInput = document.getElementById('file-input');
const downloadBtn = document.getElementById('download-btn');
const errorBanner = document.getElementById('error-banner');
const viewContainer = document.getElementById('view-container');
const sessionLabel = document.getElementById('session-label');
const sessionOrderIndicator = document.getElementById('session-order-indicator');
const sessionPrev = document.getElementById('session-prev');
const sessionNext = document.getElementById('session-next');
const viewSelect = document.getElementById('view-select');
const dropOverlay = document.getElementById('drop-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const footerVersion = document.getElementById('footer-version');
const headerAppVersion = document.getElementById('header-app-version');
const deleteSessionBtn = document.getElementById('delete-session');
const refreshSessionBtn = document.getElementById('refresh-session');
const editSessionBtn = document.getElementById('edit-session');
const archiveBtn = document.getElementById('archive-btn');
const audioGate = document.getElementById('audio-gate');
const audioGateButton = document.getElementById('audio-gate-button');
const audioGateStatus = document.getElementById('audio-gate-status');
let lastStateTs = 0;
let pasteSink = null;
let localViewStickyUntil = 0;
let lastLocalViewResyncAt = 0;
let tooltipApplyRaf = null;
let liveRefreshInFlight = false;
const liveContentShaBySha = Object.create(null);
const lastUsePingBySha = Object.create(null);
let sessionPickerEl = null;
let sessionPickerSearchInput = null;
let sessionPickerListEl = null;
let sessionPickerOrderChronoBtn = null;
let sessionPickerOrderUsageBtn = null;
let sessionPickerOpen = false;
let sessionPickerDocPointerDownHandler = null;
let sessionPickerDocKeydownHandler = null;
let sessionPickerResizeHandler = null;
const SESSION_ORDER_STORAGE_KEY = 'faustforge.sessionOrder.v1';
const VIEW_FADE_DURATION_MS = 3000;
let viewTransitionSeq = 0;
let activeViewTransition = null;

function extractLabelText(el) {
  const label = el.closest('label');
  if (!label) return '';
  const clone = label.cloneNode(true);
  clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function inferTooltip(el) {
  if (!el || !(el instanceof HTMLElement)) return '';
  const ariaLabel = (el.getAttribute('aria-label') || '').trim();
  if (ariaLabel) {
    const key = ariaLabel.toLowerCase();
    if (TOOLTIP_TEXTS.byLabel[key]) return TOOLTIP_TEXTS.byLabel[key];
    return ariaLabel;
  }

  if (el.id === 'session-label' && !el.classList.contains('clickable')) {
    return 'Current session';
  }

  const byId = el.id && TOOLTIP_TEXTS.byId[el.id] ? TOOLTIP_TEXTS.byId[el.id] : '';
  if (byId) return byId;

  const labelText = extractLabelText(el);
  if (labelText) {
    const key = labelText.toLowerCase();
    if (TOOLTIP_TEXTS.byLabel[key]) return TOOLTIP_TEXTS.byLabel[key];
    if (el.tagName === 'SELECT') return `Select ${labelText.toLowerCase()}`;
    if (el.tagName === 'INPUT') return `Set ${labelText.toLowerCase()}`;
    return labelText;
  }

  if (el.matches('.midi-key')) {
    const note = (el.textContent || '').trim();
    return note ? `${TOOLTIP_TEXTS.generic.playMidiNote} ${note}` : TOOLTIP_TEXTS.generic.playMidiNote;
  }

  if (el.tagName === 'BUTTON') {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const key = text.toLowerCase();
    if (TOOLTIP_TEXTS.byButtonText[key]) return TOOLTIP_TEXTS.byButtonText[key];
    return text ? `Activate ${text.toLowerCase()}` : TOOLTIP_TEXTS.generic.activateControl;
  }

  if (el.tagName === 'SELECT') {
    return TOOLTIP_TEXTS.generic.selectOption;
  }

  if (el.tagName === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'number' || type === 'range') return TOOLTIP_TEXTS.generic.setValue;
    if (type === 'checkbox') return TOOLTIP_TEXTS.generic.toggleOption;
    if (type === 'file') return TOOLTIP_TEXTS.byId['file-input'] || TOOLTIP_TEXTS.generic.enterValue;
    return TOOLTIP_TEXTS.generic.enterValue;
  }

  if (el.tagName === 'TEXTAREA') {
    return TOOLTIP_TEXTS.generic.enterText;
  }

  if (el.getAttribute('role') === 'button') {
    return TOOLTIP_TEXTS.generic.activateControl;
  }

  return '';
}

function applyTooltips(root = document) {
  const selectors = [
    'button',
    'select',
    'input',
    'textarea',
    '[role="button"]',
    '.midi-key',
    '#session-label.clickable'
  ].join(', ');
  root.querySelectorAll(selectors).forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const hint = inferTooltip(el);
    if (hint) el.setAttribute('title', hint);
  });
}

function scheduleTooltipApply(root = document) {
  if (tooltipApplyRaf) return;
  tooltipApplyRaf = requestAnimationFrame(() => {
    tooltipApplyRaf = null;
    applyTooltips(root);
  });
}

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
  const currentSession = getCurrentSession();
  const draftOnlyDsp = isDraftLiveSession(currentSession);
  if (draftOnlyDsp && state.currentView !== 'dsp') {
    state.currentView = 'dsp';
  }
  viewSelect.innerHTML = '';
  for (const view of state.views) {
    const option = document.createElement('option');
    option.value = view.id;
    option.textContent = view.name;
    if (draftOnlyDsp && view.id !== 'dsp') {
      option.disabled = true;
    }
    if (view.id === state.currentView) {
      option.selected = true;
    }
    viewSelect.appendChild(option);
  }
}

function getCurrentSession() {
  if (state.sessionIndex < 0 || state.sessionIndex >= state.sessions.length) return null;
  return state.sessions[state.sessionIndex] || null;
}

function isDraftLiveSession(session) {
  return !!(session && session.kind === 'live' && session.live_draft === true);
}

function markSessionUsed(reason = 'ui-action', weight = 1) {
  const sha = state.currentSha;
  if (!sha) return;
  const now = Date.now();
  const last = Number(lastUsePingBySha[sha] || 0);
  if (now - last < 700) return;
  lastUsePingBySha[sha] = now;
  const safeWeight = Number.isFinite(weight) ? Math.max(0, Math.min(5, Number(weight))) : 1;

  // Optimistic local update so score is immediately visible in the session menu.
  const session = state.sessions.find((s) => s.sha1 === sha);
  if (session) {
    const prevScore =
      typeof session.usage_score === 'number' && Number.isFinite(session.usage_score)
        ? session.usage_score
        : 0;
    session.last_used_time = now;
    session.usage_score = prevScore + safeWeight;
    if (state.sessionOrder === 'usage') {
      state.sessions.sort((a, b) => {
        const aScore = Number.isFinite(a.usage_score) ? Number(a.usage_score) : 0;
        const bScore = Number.isFinite(b.usage_score) ? Number(b.usage_score) : 0;
        if (aScore !== bScore) return bScore - aScore;
        const aLast = Number.isFinite(a.last_used_time) ? Number(a.last_used_time) : Number(a.compilation_time || 0);
        const bLast = Number.isFinite(b.last_used_time) ? Number(b.last_used_time) : Number(b.compilation_time || 0);
        return bLast - aLast;
      });
      refreshSessionIndex();
      updateSessionNavigation();
    }
    if (sessionPickerOpen) {
      renderSessionPickerList(sessionPickerSearchInput ? sessionPickerSearchInput.value || '' : '');
    }
  }

  fetch(`/api/${sha}/use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, weight: safeWeight })
  }).catch(() => {});
}

function loadSessionOrderPreference() {
  try {
    const value = localStorage.getItem(SESSION_ORDER_STORAGE_KEY);
    if (value === 'usage' || value === 'chronological') {
      state.sessionOrder = value;
    }
  } catch {
    // ignore
  }
}

function saveSessionOrderPreference() {
  try {
    localStorage.setItem(SESSION_ORDER_STORAGE_KEY, state.sessionOrder);
  } catch {
    // ignore
  }
}

function updateSessionOrderIndicator() {
  if (!sessionOrderIndicator) return;
  if (state.sessionOrder === 'usage') {
    sessionOrderIndicator.textContent = '★';
    sessionOrderIndicator.title = 'Order: Usage';
    return;
  }
  sessionOrderIndicator.textContent = '⏱';
  sessionOrderIndicator.title = 'Order: Chronological';
}

function formatSessionEntryLabel(session) {
  const isLive = session.kind === 'live';
  const isDraft = isDraftLiveSession(session);
  const idText = isLive
    ? `live:${session.sha1.slice(5, 13)}`
    : `${session.sha1.slice(0, 8)}…`;
  return `${isLive ? 'LIVE | ' : ''}${idText} | ${session.filename}${isDraft ? ' (draft)' : ''}`;
}

function ensureSessionPicker() {
  if (sessionPickerEl) return;
  const picker = document.createElement('div');
  picker.className = 'session-picker hidden';
  picker.innerHTML = `
    <div class="session-picker-header">
      <div class="session-picker-order">
        <button type="button" class="session-picker-order-btn" data-order="chronological" title="Order by creation time">⏱ Chronological</button>
        <button type="button" class="session-picker-order-btn" data-order="usage" title="Order by cumulative usage">★ Usage</button>
      </div>
      <input
        class="session-picker-search"
        type="text"
        placeholder="Search by filename or id"
        aria-label="Search sessions"
      />
    </div>
    <div class="session-picker-list"></div>
  `;
  document.body.appendChild(picker);
  sessionPickerEl = picker;
  sessionPickerSearchInput = picker.querySelector('.session-picker-search');
  sessionPickerListEl = picker.querySelector('.session-picker-list');
  sessionPickerOrderChronoBtn = picker.querySelector('.session-picker-order-btn[data-order="chronological"]');
  sessionPickerOrderUsageBtn = picker.querySelector('.session-picker-order-btn[data-order="usage"]');

  if (sessionPickerSearchInput) {
    sessionPickerSearchInput.addEventListener('input', () => {
      renderSessionPickerList(sessionPickerSearchInput.value || '');
    });
  }

  picker.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const orderBtn = target.closest('.session-picker-order-btn');
    if (!orderBtn) return;
    const order = orderBtn.getAttribute('data-order');
    if (order !== 'chronological' && order !== 'usage') return;
    if (state.sessionOrder === order) return;
    state.sessionOrder = order;
    saveSessionOrderPreference();
    updateSessionOrderIndicator();
    const currentSha = state.currentSha;
    await loadSessions();
    if (currentSha) {
      const idx = state.sessions.findIndex((s) => s.sha1 === currentSha);
      state.sessionIndex = idx >= 0 ? idx : state.sessions.length;
    }
    updateSessionNavigation();
    renderSessionPickerList(sessionPickerSearchInput ? sessionPickerSearchInput.value || '' : '');
  });

  if (sessionPickerListEl) {
    sessionPickerListEl.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const item = target.closest('.session-picker-item');
      if (!item) return;
      const sha = item.getAttribute('data-sha');
      if (!sha) return;
      if (sha === '__empty__') {
        closeSessionPicker();
        await loadEmptySession();
        return;
      }
      const index = state.sessions.findIndex((s) => s.sha1 === sha);
      if (index < 0) return;
      closeSessionPicker();
      await loadSessionByIndex(index);
    });
  }
}

function positionSessionPicker() {
  if (!sessionPickerOpen || !sessionPickerEl) return;
  const rect = sessionLabel.getBoundingClientRect();
  const navRect =
    sessionLabel.parentElement && sessionLabel.parentElement.getBoundingClientRect
      ? sessionLabel.parentElement.getBoundingClientRect()
      : null;
  const viewportWidth = Math.max(320, window.innerWidth || 0);
  const width = Math.min(560, Math.max(320, rect.width + 180), viewportWidth - 16);
  const margin = 8;
  const anchorCenterX = navRect ? navRect.left + (navRect.width / 2) : rect.left + (rect.width / 2);
  let left = anchorCenterX - (width / 2);
  left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
  let top = rect.bottom + 6;
  const maxHeight = Math.max(180, window.innerHeight - top - 16);
  if (maxHeight < 180) {
    top = Math.max(8, rect.top - 320);
  }
  sessionPickerEl.style.left = `${Math.round(left)}px`;
  sessionPickerEl.style.top = `${Math.round(top)}px`;
  sessionPickerEl.style.width = `${Math.round(width)}px`;
}

function renderSessionPickerList(rawQuery = '') {
  if (!sessionPickerListEl) return;
  if (sessionPickerOrderChronoBtn) {
    sessionPickerOrderChronoBtn.classList.toggle('active', state.sessionOrder === 'chronological');
  }
  if (sessionPickerOrderUsageBtn) {
    sessionPickerOrderUsageBtn.classList.toggle('active', state.sessionOrder === 'usage');
  }
  const query = String(rawQuery || '').trim().toLowerCase();
  const sessions = state.sessions.slice();
  if (state.sessionOrder === 'chronological') {
    // Chronological menu is displayed newest -> oldest.
    sessions.reverse();
  }
  const filteredSessions = query
    ? sessions.filter((s) => {
      const idText = s.kind === 'live' ? `live:${s.sha1.slice(5, 13)}` : s.sha1.slice(0, 8);
      return (
        (s.filename || '').toLowerCase().includes(query)
        || s.sha1.toLowerCase().includes(query)
        || idText.toLowerCase().includes(query)
      );
    })
    : sessions;
  const showEmpty = !query || 'empty session'.includes(query);

  if (!showEmpty && filteredSessions.length === 0) {
    sessionPickerListEl.innerHTML = '<div class="session-picker-empty">No matching session</div>';
    return;
  }
  const rows = [];
  if (showEmpty) {
    const activeEmpty = !state.currentSha;
    rows.push(`
      <button
        type="button"
        class="session-picker-item${activeEmpty ? ' active' : ''}"
        data-sha="__empty__"
      >
        <span class="session-picker-item-main-row">
          <span class="session-picker-item-main">EMPTY | Drop .dsp</span>
          <span class="session-picker-item-check" aria-hidden="true">${activeEmpty ? '✓' : ''}</span>
        </span>
        <span class="session-picker-item-meta">No active session</span>
      </button>
    `);
  }

  rows.push(...filteredSessions.map((s) => {
    const active = s.sha1 === state.currentSha;
    const usedAt =
      typeof s.last_used_time === 'number' && Number.isFinite(s.last_used_time)
        ? s.last_used_time
        : s.compilation_time;
    const score =
      typeof s.usage_score === 'number' && Number.isFinite(s.usage_score)
        ? Math.round(s.usage_score)
        : 0;
    const details =
      state.sessionOrder === 'usage'
        ? `${s.kind === 'live' ? 'LIVE' : 'STATIC'} · score ${score}`
        : `${s.kind === 'live' ? 'LIVE' : 'STATIC'} · created ${new Date(s.compilation_time).toLocaleString()}`;
    return `
      <button
        type="button"
        class="session-picker-item${active ? ' active' : ''}"
        data-sha="${s.sha1}"
      >
        <span class="session-picker-item-main-row">
          <span class="session-picker-item-main">${escapeHtml(formatSessionEntryLabel(s))}</span>
          <span class="session-picker-item-check" aria-hidden="true">${active ? '✓' : ''}</span>
        </span>
        <span class="session-picker-item-meta">${escapeHtml(details)}</span>
      </button>
    `;
  }));
  sessionPickerListEl.innerHTML = rows.join('');

  // Keep current session in view and centered when possible.
  requestAnimationFrame(() => {
    if (!sessionPickerListEl) return;
    const active = sessionPickerListEl.querySelector('.session-picker-item.active');
    if (!(active instanceof HTMLElement)) return;
    const listRect = sessionPickerListEl.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    const delta = (itemRect.top + itemRect.height / 2) - (listRect.top + listRect.height / 2);
    sessionPickerListEl.scrollTop += delta;
  });
}

function closeSessionPicker() {
  if (!sessionPickerOpen) return;
  sessionPickerOpen = false;
  if (sessionPickerEl) {
    sessionPickerEl.classList.add('hidden');
  }
  if (sessionPickerSearchInput) {
    sessionPickerSearchInput.value = '';
  }
  if (sessionPickerDocPointerDownHandler) {
    document.removeEventListener('pointerdown', sessionPickerDocPointerDownHandler, true);
    sessionPickerDocPointerDownHandler = null;
  }
  if (sessionPickerDocKeydownHandler) {
    document.removeEventListener('keydown', sessionPickerDocKeydownHandler, true);
    sessionPickerDocKeydownHandler = null;
  }
  if (sessionPickerResizeHandler) {
    window.removeEventListener('resize', sessionPickerResizeHandler);
    window.removeEventListener('scroll', sessionPickerResizeHandler, true);
    sessionPickerResizeHandler = null;
  }
}

function openSessionPicker() {
  ensureSessionPicker();
  renderSessionPickerList('');
  positionSessionPicker();
  if (!sessionPickerEl) return;
  sessionPickerEl.classList.remove('hidden');
  sessionPickerOpen = true;

  if (sessionPickerSearchInput) {
    sessionPickerSearchInput.value = '';
    sessionPickerSearchInput.focus();
    sessionPickerSearchInput.select();
  }
  requestAnimationFrame(() => {
    positionSessionPicker();
  });

  sessionPickerDocPointerDownHandler = (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (sessionPickerEl && sessionPickerEl.contains(target)) return;
    if (sessionLabel.contains(target)) return;
    closeSessionPicker();
  };
  document.addEventListener('pointerdown', sessionPickerDocPointerDownHandler, true);

  sessionPickerDocKeydownHandler = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSessionPicker();
    }
  };
  document.addEventListener('keydown', sessionPickerDocKeydownHandler, true);

  sessionPickerResizeHandler = () => {
    positionSessionPicker();
  };
  window.addEventListener('resize', sessionPickerResizeHandler);
  window.addEventListener('scroll', sessionPickerResizeHandler, true);
}

function toggleSessionPicker() {
  if (sessionPickerOpen) {
    closeSessionPicker();
  } else {
    openSessionPicker();
  }
}

function getEffectiveView(viewId) {
  const session = getCurrentSession();
  if (isDraftLiveSession(session)) {
    return 'dsp';
  }
  return viewId;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function disposeViewById(viewId) {
  const oldView = state.views.find((v) => v.id === viewId);
  if (!oldView || typeof oldView.dispose !== 'function') return;
  try {
    oldView.dispose();
  } catch {
    // Ignore cleanup errors
  }
}

function extractChildren(fromEl, toEl) {
  while (fromEl.firstChild) {
    toEl.appendChild(fromEl.firstChild);
  }
}

function cancelViewTransition() {
  viewTransitionSeq += 1;
  const active = activeViewTransition;
  activeViewTransition = null;
  if (!active) return;
  if (!viewContainer.classList.contains('view-crossfade-host')) return;

  const { oldLayer, newLayer } = active;
  viewContainer.innerHTML = '';
  if (newLayer) {
    extractChildren(newLayer, viewContainer);
  }
  if (!viewContainer.firstChild && oldLayer) {
    extractChildren(oldLayer, viewContainer);
  }
  viewContainer.classList.remove('view-crossfade-host');
}

async function renderCurrentViewWithFade(enabled, previousViewId = null) {
  if (!enabled) {
    await renderCurrentView();
    if (previousViewId) disposeViewById(previousViewId);
    return;
  }
  viewTransitionSeq += 1;
  const seq = viewTransitionSeq;
  const oldLayer = document.createElement('div');
  oldLayer.className = 'view-crossfade-layer view-crossfade-old';
  extractChildren(viewContainer, oldLayer);

  const newLayer = document.createElement('div');
  newLayer.className = 'view-crossfade-layer view-crossfade-new';
  activeViewTransition = { seq, oldLayer, newLayer };

  viewContainer.innerHTML = '';
  viewContainer.classList.add('view-crossfade-host');
  viewContainer.appendChild(oldLayer);
  viewContainer.appendChild(newLayer);

  await renderCurrentView(newLayer);
  if (seq !== viewTransitionSeq) return;

  requestAnimationFrame(() => {
    oldLayer.classList.add('fade-out');
    newLayer.classList.add('fade-in');
  });

  await wait(VIEW_FADE_DURATION_MS);
  if (seq !== viewTransitionSeq) return;

  viewContainer.innerHTML = '';
  extractChildren(newLayer, viewContainer);
  viewContainer.classList.remove('view-crossfade-host');
  activeViewTransition = null;
  if (previousViewId) disposeViewById(previousViewId);
}

/**
 * Change la vue active
 */
async function switchView(viewId, options = {}) {
  const isRemote = options && options.source === 'remote';
  const persist = options && options.persist === false ? false : true;
  const trackUsage = options && options.trackUsage === false ? false : true;
  const animate = options && options.animate === true ? true : false;
  const effectiveViewId = getEffectiveView(viewId);
  const previousViewId = state.currentView;
  const changed = effectiveViewId !== state.currentView;
  hideError();
  if (changed) {
    captureScrollLine();
  }

  state.currentView = effectiveViewId;
  generateViewSelect();

  if (!isRemote) {
    // Protect against transient POST failures that could make pollState restore an old remote view.
    localViewStickyUntil = Date.now() + 8000;
  }

  // Persist view first to avoid race with Run view state updates (/api/state).
  if (persist) {
    await syncState({ view: effectiveViewId });
  }

  // Afficher la vue
  await renderCurrentViewWithFade(changed && animate, changed ? previousViewId : null);
  if (changed && state.currentSha && trackUsage) {
    markSessionUsed('view-change');
  }
}

/**
 * Affiche la vue courante
 */
async function renderCurrentView(targetContainer = viewContainer) {
  if (!state.currentSha) return;
  const effectiveView = getEffectiveView(state.currentView);
  if (effectiveView !== state.currentView) {
    state.currentView = effectiveView;
    generateViewSelect();
  }

  const view = state.views.find(v => v.id === state.currentView);
  if (!view) return;

  targetContainer.innerHTML = '<div class="loading">Loading...</div>';

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
            paramCells: state.runStateBySha[state.currentSha]?.paramCells,
            orbitUi: state.runStateBySha[state.currentSha]?.orbitUi || state.runGlobal.orbitUi
          }
        : undefined;
    const perSession =
      state.currentSha && state.viewScrollBySha[state.currentSha]
        ? state.viewScrollBySha[state.currentSha][view.id]
        : null;
    const scrollState = perSession || state.viewScroll[view.id];
    await view.render(targetContainer, {
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
        if (snapshot.paramCells) {
          state.runStateBySha[state.currentSha] = {
            ...(state.runStateBySha[state.currentSha] || {}),
            paramCells: snapshot.paramCells
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
          markSessionUsed('scroll');
        }
      }
    });
    scheduleTooltipApply(targetContainer);
  } catch (err) {
    targetContainer.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    scheduleTooltipApply(targetContainer);
  }
}

/**
 * Charge les sessions existantes selon l'ordre courant.
 */
async function loadSessions() {
  try {
    const response = await fetch(`/api/sessions?limit=100&order=${encodeURIComponent(state.sessionOrder)}`);
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to load sessions');
    }
    state.sessions = (result.sessions || []).map((s) => ({
      ...s,
      kind: s && s.kind === 'live' ? 'live' : 'static'
    }));
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
    sessionLabel.textContent = 'Empty | Drop .dsp';
    sessionLabel.classList.add('clickable');
    sessionPrev.disabled = state.sessions.length === 0;
    sessionNext.disabled = true;
    if (deleteSessionBtn) deleteSessionBtn.classList.add('hidden');
    if (refreshSessionBtn) refreshSessionBtn.classList.add('hidden');
    if (editSessionBtn) editSessionBtn.classList.add('hidden');
    if (downloadBtn) downloadBtn.classList.add('hidden');
  } else {
    // Session active
    const session = state.sessions[state.sessionIndex];
    const isLive = session.kind === 'live';
    const isDraft = isDraftLiveSession(session);
    const shortId = isLive
      ? `live:${session.sha1.slice(5, 13)}`
      : `${session.sha1.slice(0, 8)}…`;
    sessionLabel.textContent = `${isLive ? 'LIVE | ' : ''}${shortId} | ${session.filename}${isDraft ? ' (draft)' : ''}`;
    sessionLabel.classList.add('clickable');
    sessionPrev.disabled = state.sessionIndex === 0;
    sessionNext.disabled = false; // On peut toujours aller vers session vide
    if (deleteSessionBtn) deleteSessionBtn.classList.remove('hidden');
    if (refreshSessionBtn) refreshSessionBtn.classList.remove('hidden');
    if (editSessionBtn) {
      if (isLive) {
        editSessionBtn.classList.add('hidden');
      } else {
        editSessionBtn.classList.remove('hidden');
      }
    }
    if (downloadBtn) downloadBtn.classList.remove('hidden');
  }
  generateViewSelect();
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
  if (session.kind === 'live' && typeof session.content_sha1 === 'string') {
    liveContentShaBySha[session.sha1] = session.content_sha1;
  }
  state.sessionIndex = index;
  state.currentView = getEffectiveView(state.currentView);

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
  cancelViewTransition();
  captureScrollLine();
  state.currentSha = null;
  state.sessionIndex = state.sessions.length;
  state.currentView = 'dsp';

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
  stopShowcasePreview();
  audioGate.classList.add('hidden');
  if (audioGateStatus) {
    audioGateStatus.textContent = '';
    audioGateStatus.classList.add('hidden');
  }
}

async function submitShowcaseSession() {
  const response = await fetch('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: SHOWCASE_CODE,
      filename: SHOWCASE_FILENAME
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result || typeof result.sha1 !== 'string') {
    throw new Error(result.error || 'Showcase submit failed');
  }
  return result.sha1;
}

function stopShowcasePreview() {
  cancelViewTransition();
  const timer = state.showcase.viewTimer;
  if (typeof timer === 'number') {
    clearInterval(timer);
  }
  state.showcase.viewTimer = null;
  state.showcase.active = false;
}

function isShowcaseGateActive() {
  return (
    state.showcase.active
    && !state.audioUnlocked
    && !!audioGate
    && !audioGate.classList.contains('hidden')
  );
}

async function startShowcasePreview() {
  if (state.audioUnlocked || !audioGate || audioGate.classList.contains('hidden')) return;
  stopShowcasePreview();
  state.showcase.active = true;

  try {
    const showcaseSha = await submitShowcaseSession();
    state.showcase.sha = showcaseSha;
    state.currentSha = showcaseSha;
    await loadSessions();
    refreshSessionIndex();
    updateSessionNavigation();
    showInterface();
    await switchView('dsp', { persist: false, trackUsage: false, animate: true });

    const showcaseViews = state.views.map((v) => v.id);
    if (showcaseViews.length === 0) return;
    state.showcase.viewTimer = window.setInterval(async () => {
      if (!state.showcase.active || state.audioUnlocked || !audioGate || audioGate.classList.contains('hidden')) {
        stopShowcasePreview();
        return;
      }
      if (state.currentSha !== state.showcase.sha) {
        state.currentSha = state.showcase.sha;
        refreshSessionIndex();
        updateSessionNavigation();
      }
      const currentIndex = showcaseViews.findIndex((id) => id === state.currentView);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % showcaseViews.length : 0;
      await switchView(showcaseViews[nextIndex], { persist: false, trackUsage: false, animate: true });
    }, 6000);
  } catch (err) {
    stopShowcasePreview();
    const message = err && err.message ? err.message : String(err);
    showAudioGate(`Showcase unavailable: ${message}`);
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
        <div class="empty-subtitle">or paste Faust code</div>
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
  scheduleTooltipApply(viewContainer);
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

async function downloadFromUrl(url, filename, fallbackError = 'Download failed') {
  const response = await fetch(url);
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || fallbackError);
  }
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function openEditorUrl(url) {
  if (!url || typeof url !== 'string') return;
  // Fire-and-forget custom URI dispatch without leaving current page.
  const probe = document.createElement('iframe');
  probe.style.display = 'none';
  probe.src = url;
  document.body.appendChild(probe);
  setTimeout(() => {
    probe.remove();
  }, 1500);
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
      filename = `${base}-svg.tar.gz`;
    } else if (state.currentView === 'run') {
      url = `/api/${session.sha1}/download/pwa`;
      filename = `${base}-pwa.tar.gz`;
    }

    try {
      await downloadFromUrl(url, filename, 'Download failed');
    } catch (err) {
      showError(`Error: ${err.message}`);
    }
  });
}

if (archiveBtn) {
  archiveBtn.addEventListener('click', async () => {
    try {
      await downloadFromUrl('/api/download/archive/dsp', 'faustforge-dsp-archive.tar.gz', 'Archive failed');
      hideError();
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
  if (isShowcaseGateActive()) {
    // Keep showcase stable while onboarding overlay is visible.
    return;
  }
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

    if (remote.view && getEffectiveView(remote.view) !== state.currentView) {
      const now = Date.now();
      if (now < localViewStickyUntil) {
        // Keep local choice authoritative for a short window after user view changes.
        if (now - lastLocalViewResyncAt > 1200) {
          lastLocalViewResyncAt = now;
          syncState({ view: state.currentView });
        }
      } else {
        await switchView(remote.view, { source: 'remote', persist: false });
      }
    } else if (getEffectiveView(remote.view) === state.currentView) {
      localViewStickyUntil = 0;
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

async function pollLiveSessionRefresh() {
  if (liveRefreshInFlight) return;
  if (!state.currentSha) return;

  const session = state.sessions.find((s) => s.sha1 === state.currentSha);
  if (!session || session.kind !== 'live') return;

  const sha = state.currentSha;
  const knownContentSha =
    typeof liveContentShaBySha[sha] === 'string'
      ? liveContentShaBySha[sha]
      : (typeof session.content_sha1 === 'string' ? session.content_sha1 : '');
  liveRefreshInFlight = true;
  try {
    const response = await fetch(`/api/${sha}/live/refresh`, { method: 'POST' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return;

    const latestContentSha = typeof result.contentSha1 === 'string' ? result.contentSha1 : '';
    if (latestContentSha) {
      liveContentShaBySha[sha] = latestContentSha;
    }

    if (result.errors && String(result.errors).trim()) {
      showError(result.errors);
    } else {
      hideError();
    }

    const contentChanged = !!latestContentSha && latestContentSha !== knownContentSha;
    if ((result.changed || contentChanged) && state.currentSha === sha) {
      await loadSessions();
      refreshSessionIndex();
      updateSessionNavigation();
      showInterface();
      await renderCurrentView();
    }
  } catch {
    // ignore
  } finally {
    liveRefreshInFlight = false;
  }
}

function tickRunUsageScore() {
  if (!state.currentSha) return;
  if (state.currentView !== 'run') return;
  if (state.runGlobal.audioRunning) {
    markSessionUsed('run-active-time', 3);
    return;
  }
  markSessionUsed('run-view-time', 1);
}

// Clic sur le label de session vide: no-op (load via drop/paste).
sessionLabel.addEventListener('click', (event) => {
  event.preventDefault();
  if (state.sessions.length === 0) return;
  toggleSessionPicker();
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
      const refreshUrl =
        session.kind === 'live'
          ? `/api/${session.sha1}/live/refresh`
          : `/api/${session.sha1}/refresh`;
      const response = await fetch(refreshUrl, { method: 'POST' });
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

if (editSessionBtn) {
  editSessionBtn.addEventListener('click', async () => {
    if (state.sessionIndex >= state.sessions.length || state.sessionIndex < 0) return;
    const session = state.sessions[state.sessionIndex];
    if (!session || session.kind === 'live') return;

    showLoading();
    hideError();
    try {
      const response = await fetch(`/api/${session.sha1}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editor: 'vscode',
          openEditor: true
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || 'Edit failed');
      }

      if (result.editorUrl && result.openEditorRequested) {
        openEditorUrl(result.editorUrl);
      }

      await loadSessions();
      const liveSha = typeof result.liveSha1 === 'string' ? result.liveSha1 : null;
      if (liveSha) {
        const liveIndex = state.sessions.findIndex((s) => s.sha1 === liveSha);
        if (liveIndex >= 0) {
          await loadSessionByIndex(liveIndex);
        } else {
          state.currentSha = liveSha;
          refreshSessionIndex();
          updateSessionNavigation();
          showInterface();
          await renderCurrentView();
          await syncState({ sha1: liveSha, view: state.currentView });
        }
      }

      if (!result.editorUrl) {
        showError('Live session created. Editor URL unavailable (configure HOST_LIVE_WORKSPACE_ROOT).');
      } else {
        hideError();
      }
    } catch (err) {
      showError(`Error: ${err.message}`);
    } finally {
      hideLoading();
    }
  });
}

if (audioGateButton) {
  audioGateButton.addEventListener('click', async () => {
    stopShowcasePreview();
    if (state.audioUnlocked) {
      await loadEmptySession();
      hideAudioGate();
      return;
    }
    audioGateButton.disabled = true;
    showAudioGate();
    try {
      await unlockAudioGate();
      state.audioUnlocked = true;
      await syncState({ audioUnlocked: true });
      await loadEmptySession();
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
  loadSessionOrderPreference();
  updateSessionOrderIndicator();
  await loadViews();
  await loadSessions();

  state.sessionIndex = state.sessions.length;
  updateSessionNavigation();
  hideInterface();
  showAudioGate();
  state.audioUnlocked = false;
  await startShowcasePreview();

  // Require explicit audio unlock per opened tab.
  syncState({ audioUnlocked: false });

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

  // Charger la version de faustforge pour le bandeau
  if (headerAppVersion) {
    try {
      const response = await fetch('/api/app-version');
      const result = await response.json();
      if (response.ok && result.version) {
        headerAppVersion.textContent = `v${result.version}`;
      }
    } catch {
      // Ignorer si indisponible
    }
  }

  // Poll shared state (MCP may update it)
  setInterval(pollState, 1500);
  // Auto-refresh live session in the active view when source file changes on disk.
  setInterval(pollLiveSessionRefresh, 800);
  // Weighted usage accumulation for run exploration time.
  setInterval(tickRunUsageScore, 5000);

  applyTooltips(document);
  const tooltipObserver = new MutationObserver(() => {
    scheduleTooltipApply(document);
  });
  tooltipObserver.observe(document.body, { childList: true, subtree: true });
}

init();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

const HTTP_BASE = process.env.FAUST_HTTP_URL || 'http://localhost:3000';

function toResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data
  };
}

const ONBOARDING_GUIDE = {
  version: 1,
  goals: [
    'Design and iterate Faust DSP',
    'Control run parameters safely',
    'Measure spectral impact and audio quality',
    'Control polyphony and MIDI notes when relevant'
  ],
  prerequisites: [
    'If audio tools fail with "Audio is locked", ask the user to click "Enable Audio" once in Faustforge UI.'
  ],
  workflow: [
    '1) set_view("run")',
    '2) get_polyphony() then set_polyphony(...) if needed (0=mono)',
    '3) get_run_ui() and get_run_params()',
    '4) For continuous params: set_run_param_and_get_spectrum(...)',
    '5) For transient buttons: trigger_button_and_get_spectrum(...)',
    '6) For note events: midi_note_on/off/pulse(...)',
    '7) Compare aggregate.summary and iterate one parameter at a time'
  ],
  toolHints: {
    polyphony: 'Use set_polyphony(0) for mono, else 1/2/4/8/16/32/64.',
    midi: 'Prefer midi_note_pulse(note, velocity, holdMs) for deterministic one-shot tests.'
  },
  qualityThresholds: {
    clipRatioQ_warn: 1,
    clipRatioQ_severe: 5,
    clickScoreQ_warn: 20,
    clickScoreQ_severe: 40
  },
  policy: [
    'Do not optimize timbre while ignoring audioQuality.',
    'Flag severe clipping and click risk unless explicitly requested.'
  ]
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setRunParam(path, value) {
  return requestJson('/api/run/param', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, value })
  });
}

async function runTransport(action) {
  return requestJson('/api/run/transport', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  });
}

async function getPolyphony() {
  return requestJson('/api/run/polyphony');
}

async function setPolyphony(voices) {
  return requestJson('/api/run/polyphony', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voices })
  });
}

async function sendMidi(action, note, velocity, holdMs) {
  return requestJson('/api/run/midi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, note, velocity, holdMs })
  });
}

async function ensureRunView() {
  await requestJson('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ view: 'run' })
  });
}

async function ensureAudioUnlocked() {
  const state = await requestJson('/api/state');
  if (state && state.audioUnlocked === true) return;
  throw new McpError(
    ErrorCode.InvalidParams,
    'Audio is locked. Open Faustforge UI and click "Enable Audio" once.'
  );
}

async function triggerRunButton(path, holdMs) {
  return requestJson('/api/run/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, holdMs })
  });
}

function getLatestSpectrumContent(state) {
  if (state && state.spectrumSummary && state.spectrumSummary.type === 'spectrum_summary_v1') {
    return state.spectrumSummary;
  }
  if (state && state.spectrum) {
    return state.spectrum;
  }
  return null;
}

async function collectSpectrumSummarySeries(captureMs, sampleEveryMs = 80, maxFrames = 10) {
  const startedAt = Date.now();
  let lastCapturedAt = startedAt - 1;
  const series = [];

  while (Date.now() - startedAt < captureMs && series.length < maxFrames) {
    const state = await requestJson('/api/state');
    const summary = state && state.spectrumSummary ? state.spectrumSummary : null;
    if (summary && summary.type === 'spectrum_summary_v1') {
      const capturedAt =
        typeof summary.capturedAt === 'number' ? summary.capturedAt : state.updatedAt || Date.now();
      if (capturedAt > lastCapturedAt) {
        lastCapturedAt = capturedAt;
        series.push({
          tMs: Math.max(0, capturedAt - startedAt),
          summary
        });
      }
    }
    await sleep(sampleEveryMs);
  }

  return series;
}

function aggregateSpectrumSeries(series) {
  if (!Array.isArray(series) || series.length === 0) return null;
  const base = series[0].summary;
  const bandsCount = Array.isArray(base.bandsDbQ) ? base.bandsDbQ.length : 0;
  const bandsDbQ = new Array(bandsCount).fill(-120);
  const peakMap = new Map();
  let rmsDbQ = -120;
  let centroidHzSum = 0;
  let rolloff95HzSum = 0;
  let flatnessQ = 0;
  let crestDbQ = -120;
  let peakDbFSQ = -120;
  let clipSampleCount = 0;
  let clipRatioQ = 0;
  let dcOffsetQ = 0;
  let clickCount = 0;
  let clickScoreQ = 0;

  for (const sample of series) {
    const summary = sample.summary;
    if (!summary) continue;
    const bands = Array.isArray(summary.bandsDbQ) ? summary.bandsDbQ : [];
    for (let i = 0; i < Math.min(bandsDbQ.length, bands.length); i++) {
      if (bands[i] > bandsDbQ[i]) bandsDbQ[i] = bands[i];
    }

    const peaks = Array.isArray(summary.peaks) ? summary.peaks : [];
    for (const peak of peaks) {
      const hz = Math.round(peak.hz || 0);
      const existing = peakMap.get(hz);
      if (!existing || peak.dbQ > existing.dbQ) {
        peakMap.set(hz, {
          hz,
          dbQ: Math.round(peak.dbQ || -120),
          q: Number.isFinite(peak.q) ? peak.q : 0
        });
      }
    }

    const f = summary.features || {};
    if (Number.isFinite(f.rmsDbQ) && f.rmsDbQ > rmsDbQ) rmsDbQ = f.rmsDbQ;
    if (Number.isFinite(f.centroidHz)) centroidHzSum += f.centroidHz;
    if (Number.isFinite(f.rolloff95Hz)) rolloff95HzSum += f.rolloff95Hz;
    if (Number.isFinite(f.flatnessQ) && f.flatnessQ > flatnessQ) flatnessQ = f.flatnessQ;
    if (Number.isFinite(f.crestDbQ) && f.crestDbQ > crestDbQ) crestDbQ = f.crestDbQ;

    const q = summary.audioQuality || {};
    if (Number.isFinite(q.peakDbFSQ) && q.peakDbFSQ > peakDbFSQ) peakDbFSQ = q.peakDbFSQ;
    if (Number.isFinite(q.clipSampleCount)) clipSampleCount += Math.max(0, Math.round(q.clipSampleCount));
    if (Number.isFinite(q.clipRatioQ) && q.clipRatioQ > clipRatioQ) clipRatioQ = q.clipRatioQ;
    if (Number.isFinite(q.dcOffsetQ) && q.dcOffsetQ > dcOffsetQ) dcOffsetQ = q.dcOffsetQ;
    if (Number.isFinite(q.clickCount)) clickCount += Math.max(0, Math.round(q.clickCount));
    if (Number.isFinite(q.clickScoreQ) && q.clickScoreQ > clickScoreQ) clickScoreQ = q.clickScoreQ;
  }

  const peaks = Array.from(peakMap.values())
    .sort((a, b) => b.dbQ - a.dbQ)
    .slice(0, 8);
  const n = series.length;
  const features = {
    rmsDbQ: Math.round(rmsDbQ),
    centroidHz: Math.round(centroidHzSum / n),
    rolloff95Hz: Math.round(rolloff95HzSum / n),
    flatnessQ: Math.round(flatnessQ),
    crestDbQ: Math.round(crestDbQ)
  };
  const firstFeatures = (series[0] && series[0].summary && series[0].summary.features) || null;
  const delta = firstFeatures
    ? {
        rmsDbQ: features.rmsDbQ - (firstFeatures.rmsDbQ || 0),
        centroidHz: features.centroidHz - (firstFeatures.centroidHz || 0),
        rolloff95Hz: features.rolloff95Hz - (firstFeatures.rolloff95Hz || 0),
        flatnessQ: features.flatnessQ - (firstFeatures.flatnessQ || 0),
        crestDbQ: features.crestDbQ - (firstFeatures.crestDbQ || 0)
      }
    : undefined;

  return {
    type: 'spectrum_summary_v1',
    capturedAt: series[series.length - 1].summary.capturedAt,
    frame: base.frame,
    bandsDbQ,
    peaks,
    features,
    audioQuality: {
      peakDbFSQ: Math.round(peakDbFSQ),
      clipSampleCount: Math.round(clipSampleCount),
      clipRatioQ: Math.round(clipRatioQ),
      dcOffsetQ: Math.round(dcOffsetQ),
      clickCount: Math.round(clickCount),
      clickScoreQ: Math.round(clickScoreQ)
    },
    delta
  };
}

function autoFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `ai-${ts}.dsp`;
}

async function requestJson(path, options = {}) {
  const url = `${HTTP_BASE}${path}`;
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new McpError(
        ErrorCode.InternalError,
        `HTTP ${response.status} ${response.statusText}: ${text || url}`
      );
    }
    return await response.json();
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(
      ErrorCode.InternalError,
      `HTTP server not available at ${HTTP_BASE}`
    );
  }
}

async function requestText(path) {
  const url = `${HTTP_BASE}${path}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new McpError(
        ErrorCode.InternalError,
        `HTTP ${response.status} ${response.statusText}: ${text || url}`
      );
    }
    return await response.text();
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(
      ErrorCode.InternalError,
      `HTTP server not available at ${HTTP_BASE}`
    );
  }
}

const server = new McpServer({
  name: 'faustforge',
  version: '0.1.0'
});

server.registerTool(
  'get_onboarding_guide',
  {
    description:
      'Return best-practice workflow and thresholds so an AI client can operate Faustforge autonomously.',
    inputSchema: {}
  },
  async () => {
    return toResult(ONBOARDING_GUIDE);
  }
);

server.registerTool(
  'submit',
  {
    description:
      'Submit Faust code (equivalent to dropping a .dsp file). If persisted, it becomes the active shared session.',
    inputSchema: {
      code: z.string(),
      filename: z.string().optional(),
      persistOnSuccessOnly: z.boolean().optional()
    }
  },
  async ({ code, filename, persistOnSuccessOnly }) => {
    if (!code || typeof code !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid code');
    }
    const safeFilename = filename && filename.endsWith('.dsp') ? filename : autoFilename();
    const shouldPersistOnSuccessOnly =
      typeof persistOnSuccessOnly === 'boolean' ? persistOnSuccessOnly : true;
    const result = await requestJson('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        filename: safeFilename,
        persistOnSuccessOnly: shouldPersistOnSuccessOnly
      })
    });

    // Keep UI and MCP in sync: when submission produced/persisted a session,
    // make it the active shared session so web UI switches immediately.
    if (result && result.sha1 && result.persisted !== false) {
      await requestJson('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha1: result.sha1 })
      });
    }

    return toResult({
      sha1: result.sha1,
      errors: result.errors || '',
      persisted: result.persisted !== false,
      persistOnSuccessOnly: shouldPersistOnSuccessOnly
    });
  }
);

server.registerTool(
  'get_errors',
  {
    description: 'Get errors.log for a given session.',
    inputSchema: {
      sha1: z.string()
    }
  },
  async ({ sha1 }) => {
    const errors = await requestText(`/api/${sha1}/errors.log`);
    return toResult({ sha1, errors });
  }
);

server.registerTool(
  'get_state',
  {
    description: 'Get current session and view state.',
    inputSchema: {}
  },
  async () => {
    const state = await requestJson('/api/state');
    return toResult({ sha1: state.sha1, filename: state.filename, view: state.view });
  }
);

server.registerTool(
  'get_session',
  {
    description: 'Get current session.',
    inputSchema: {}
  },
  async () => {
    const state = await requestJson('/api/state');
    return toResult({ sha1: state.sha1, filename: state.filename });
  }
);

server.registerTool(
  'set_view',
  {
    description: 'Set current view (dsp, cpp, svg, run).',
    inputSchema: {
      view: z.enum(['dsp', 'cpp', 'svg', 'run'])
    }
  },
  async ({ view }) => {
    const next = await requestJson('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view })
    });
    return toResult({ view: next.view });
  }
);

server.registerTool(
  'get_view_content',
  {
    description:
      'Get content corresponding to the current view. For view=run, returns the latest spectrum summary.',
    inputSchema: {}
  },
  async () => {
    const state = await requestJson('/api/state');
    if (!state.sha1) {
      throw new McpError(ErrorCode.InvalidParams, 'No active session');
    }

    if (state.view === 'dsp') {
      const content = await requestText(`/api/${state.sha1}/user_code.dsp`);
      return toResult({ view: 'dsp', mime: 'text/plain', content });
    }

    if (state.view === 'cpp') {
      const content = await requestText(`/api/${state.sha1}/generated.cpp`);
      return toResult({ view: 'cpp', mime: 'text/plain', content });
    }

    if (state.view === 'svg') {
      const result = await requestJson(`/api/${state.sha1}/svg`);
      const files = result.files || [];
      if (!files.length) {
        throw new McpError(ErrorCode.InvalidParams, 'SVG not found');
      }
      const name = files.includes('process.svg') ? 'process.svg' : files[0];
      const content = await requestText(`/api/${state.sha1}/svg/${name}`);
      return toResult({ view: 'svg', mime: 'image/svg+xml', content });
    }

    if (state.view === 'run') {
      const content = getLatestSpectrumContent(state);
      if (content) {
        return toResult({ view: 'run', mime: 'application/json', content });
      }
      throw new McpError(ErrorCode.InvalidParams, 'Run spectrum not available');
    }

    throw new McpError(ErrorCode.InvalidParams, 'Unsupported view');
  }
);

server.registerTool(
  'get_spectrum',
  {
    description: [
      'Get latest spectrum summary (independent of current view).',
      'May include audioQuality feedback: clipping and click risk.',
      'Practical thresholds: clipRatioQ>1 warn, >5 severe; clickScoreQ>20 warn, >40 severe.'
    ].join('\n'),
    inputSchema: {}
  },
  async () => {
    const state = await requestJson('/api/state');
    const content = getLatestSpectrumContent(state);
    if (!content) {
      throw new McpError(ErrorCode.InvalidParams, 'Spectrum not available');
    }
    return toResult({ mime: 'application/json', content });
  }
);

server.registerTool(
  'get_run_ui',
  {
    description:
      'Get current run UI structure (Faust UI JSON). Use returned parameter paths with set_run_param.',
    inputSchema: {}
  },
  async () => {
    const result = await requestJson('/api/run/ui');
    return toResult({ sha1: result.sha1, ui: result.ui });
  }
);

server.registerTool(
  'get_run_params',
  {
    description: 'Get current run parameter values by path.',
    inputSchema: {}
  },
  async () => {
    const result = await requestJson('/api/run/params');
    return toResult({ sha1: result.sha1, params: result.params || {} });
  }
);

server.registerTool(
  'get_polyphony',
  {
    description: 'Get current polyphony voices for Run mode (0 = mono).',
    inputSchema: {}
  },
  async () => {
    const result = await getPolyphony();
    return toResult({ sha1: result.sha1, voices: result.voices || 0 });
  }
);

server.registerTool(
  'set_polyphony',
  {
    description: 'Set Run polyphony voices. Convention: 0 = mono. Allowed: 0,1,2,4,8,16,32,64.',
    inputSchema: {
      voices: z.number().int().min(0).max(64)
    }
  },
  async ({ voices }) => {
    await ensureRunView().catch(() => {});
    const result = await setPolyphony(voices);
    return toResult({ sha1: result.sha1, voices: result.voices || 0 });
  }
);

server.registerTool(
  'set_run_param',
  {
    description: [
      'Set one run parameter by path.',
      '',
      'Parameter behavior by Faust UI type:',
      '- hslider, vslider, nentry: value persists until changed again',
      '- button: requires a full press/release cycle to retrigger properly:',
      '  1) set_run_param(path, 1)',
      '  2) set_run_param(path, 0)',
      '  Without release, envelopes can remain latched and cannot be retriggered.',
      '- checkbox: toggles between 0 and 1, value persists'
    ].join('\n'),
    inputSchema: {
      path: z.string(),
      value: z.number()
    }
  },
  async ({ path, value }) => {
    const result = await requestJson('/api/run/param', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, value })
    });
    return toResult({ sha1: result.sha1, path: result.path, value: result.value });
  }
);

server.registerTool(
  'midi_note_on',
  {
    description: 'Send MIDI note-on to Run engine. Requires polyphonic DSP in most cases.',
    inputSchema: {
      note: z.number().int().min(0).max(127),
      velocity: z.number().min(0).max(1).optional()
    }
  },
  async ({ note, velocity }) => {
    await ensureRunView().catch(() => {});
    await ensureAudioUnlocked();
    await runTransport('start').catch(() => {});
    const safeVelocity = typeof velocity === 'number' ? velocity : 0.8;
    const result = await sendMidi('on', note, safeVelocity);
    return toResult({
      sha1: result.sha1,
      midi: result.runMidi,
      sent: { action: 'on', note, velocity: safeVelocity }
    });
  }
);

server.registerTool(
  'midi_note_off',
  {
    description: 'Send MIDI note-off to Run engine.',
    inputSchema: {
      note: z.number().int().min(0).max(127)
    }
  },
  async ({ note }) => {
    await ensureRunView().catch(() => {});
    await ensureAudioUnlocked();
    const result = await sendMidi('off', note);
    return toResult({
      sha1: result.sha1,
      midi: result.runMidi,
      sent: { action: 'off', note }
    });
  }
);

server.registerTool(
  'midi_note_pulse',
  {
    description: 'Send MIDI note-on then note-off automatically after holdMs.',
    inputSchema: {
      note: z.number().int().min(0).max(127),
      velocity: z.number().min(0).max(1).optional(),
      holdMs: z.number().int().min(1).max(5000).optional()
    }
  },
  async ({ note, velocity, holdMs }) => {
    await ensureRunView().catch(() => {});
    await ensureAudioUnlocked();
    await runTransport('start').catch(() => {});
    const safeVelocity = typeof velocity === 'number' ? velocity : 0.8;
    const safeHoldMs = typeof holdMs === 'number' ? holdMs : 120;
    const result = await sendMidi('pulse', note, safeVelocity, safeHoldMs);
    return toResult({
      sha1: result.sha1,
      midi: result.runMidi,
      sent: { action: 'pulse', note, velocity: safeVelocity, holdMs: safeHoldMs }
    });
  }
);

server.registerTool(
  'set_run_param_and_get_spectrum',
  {
    description: [
      'Set one run parameter, wait briefly, then capture a compact spectrum-summary series.',
      'Returns a max-hold aggregate summary over the capture window.',
      'Recommended for objective A/B parameter impact measurement.'
    ].join('\n'),
    inputSchema: {
      path: z.string(),
      value: z.number(),
      settleMs: z.number().int().min(0).max(5000).optional(),
      captureMs: z.number().int().min(50).max(10000).optional(),
      sampleEveryMs: z.number().int().min(40).max(500).optional(),
      maxFrames: z.number().int().min(1).max(20).optional()
    }
  },
  async ({ path, value, settleMs, captureMs, sampleEveryMs, maxFrames }) => {
    const settle = typeof settleMs === 'number' ? settleMs : 120;
    const windowMs = typeof captureMs === 'number' ? captureMs : 300;
    const pollMs = typeof sampleEveryMs === 'number' ? sampleEveryMs : 80;
    const frameCap = typeof maxFrames === 'number' ? maxFrames : 10;
    await ensureRunView().catch(() => {});
    await ensureAudioUnlocked();
    await runTransport('start').catch(() => {});
    await setRunParam(path, value);
    if (settle > 0) {
      await sleep(settle);
    }
    const series = await collectSpectrumSummarySeries(windowMs, pollMs, frameCap);
    if (!series || series.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No spectrum summary captured. Ensure Run view is active and audio is running.'
      );
    }
    const aggregateSummary = aggregateSpectrumSeries(series);
    return toResult({
      path,
      value,
      settleMs: settle,
      captureMs: windowMs,
      sampleEveryMs: pollMs,
      series,
      aggregate: {
        mode: 'max_hold',
        summary: aggregateSummary
      }
    });
  }
);

server.registerTool(
  'trigger_button',
  {
    description: [
      'Trigger a Faust button parameter safely with a full press/release cycle.',
      'Equivalent to: set_run_param(path, 1) then set_run_param(path, 0).',
      'Use this instead of manual calls to avoid latched button states.'
    ].join('\n'),
    inputSchema: {
      path: z.string(),
      holdMs: z.number().int().min(1).max(5000).optional()
    }
  },
  async ({ path, holdMs }) => {
    const duration = typeof holdMs === 'number' ? holdMs : 80;
    await ensureRunView().catch(() => {});
    await ensureAudioUnlocked();
    await runTransport('start').catch(() => {});
    await triggerRunButton(path, duration);
    return toResult({ path, holdMs: duration, triggered: true });
  }
);

server.registerTool(
  'trigger_button_and_get_spectrum',
  {
    description: [
      'Trigger a button and capture a time series of compact spectrum summaries.',
      'Also returns a max-hold aggregate summary over the capture window.',
      'Use for transient/percussive analysis.'
    ].join('\n'),
    inputSchema: {
      path: z.string(),
      holdMs: z.number().int().min(1).max(5000).optional(),
      captureMs: z.number().int().min(50).max(10000).optional(),
      sampleEveryMs: z.number().int().min(40).max(500).optional(),
      maxFrames: z.number().int().min(1).max(20).optional()
    }
  },
  async ({ path, holdMs, captureMs, sampleEveryMs, maxFrames }) => {
    const duration = typeof holdMs === 'number' ? holdMs : 80;
    const windowMs = typeof captureMs === 'number' ? captureMs : 300;
    const pollMs = typeof sampleEveryMs === 'number' ? sampleEveryMs : 80;
    const frameCap = typeof maxFrames === 'number' ? maxFrames : 10;
    await ensureRunView().catch(() => {});
    await ensureAudioUnlocked();
    await runTransport('start').catch(() => {});
    const capturePromise = collectSpectrumSummarySeries(windowMs, pollMs, frameCap);
    await triggerRunButton(path, duration);
    const series = await capturePromise;
    if (!series || series.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No spectrum summary captured. Ensure Run view is active and audio is running.'
      );
    }
    const aggregateSummary = aggregateSpectrumSeries(series);
    return toResult({
      path,
      holdMs: duration,
      captureMs: windowMs,
      sampleEveryMs: pollMs,
      series,
      aggregate: {
        mode: 'max_hold',
        summary: aggregateSummary
      }
    });
  }
);

server.registerTool(
  'run_transport',
  {
    description:
      'Control run transport: start, stop, or toggle audio. Start/toggle require audio unlocked by one UI click ("Enable Audio").',
    inputSchema: {
      action: z.enum(['start', 'stop', 'toggle'])
    }
  },
  async ({ action }) => {
    await ensureRunView().catch(() => {});
    if (action === 'start' || action === 'toggle') {
      await ensureAudioUnlocked();
    }
    const result = await requestJson('/api/run/transport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    return toResult({ sha1: result.sha1, runTransport: result.runTransport });
  }
);

server.registerTool(
  'list_sessions',
  {
    description: 'List sessions (creation order).',
    inputSchema: {}
  },
  async () => {
    const result = await requestJson('/api/sessions?limit=100');
    return toResult({ sessions: result.sessions || [] });
  }
);

server.registerTool(
  'set_session',
  {
    description: 'Set current session by sha1.',
    inputSchema: {
      sha1: z.string()
    }
  },
  async ({ sha1 }) => {
    const next = await requestJson('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha1 })
    });
    return toResult({ sha1: next.sha1, filename: next.filename });
  }
);

server.registerTool(
  'prev_session',
  {
    description: 'Move to previous session (creation order).',
    inputSchema: {}
  },
  async () => {
    const sessionsResult = await requestJson('/api/sessions?limit=100');
    const sessions = sessionsResult.sessions || [];
    const state = await requestJson('/api/state');
    if (sessions.length === 0) {
      const next = await requestJson('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha1: null })
      });
      return toResult({ sha1: next.sha1, filename: next.filename });
    }
    if (!state.sha1) {
      const last = sessions[sessions.length - 1];
      const next = await requestJson('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha1: last.sha1 })
      });
      return toResult({ sha1: next.sha1, filename: next.filename });
    }
    const idx = sessions.findIndex((s) => s.sha1 === state.sha1);
    if (idx > 0) {
      const prev = sessions[idx - 1];
      const next = await requestJson('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha1: prev.sha1 })
      });
      return toResult({ sha1: next.sha1, filename: next.filename });
    }
    return toResult({ sha1: state.sha1, filename: state.filename });
  }
);

server.registerTool(
  'next_session',
  {
    description: 'Move to next session (creation order) or empty.',
    inputSchema: {}
  },
  async () => {
    const sessionsResult = await requestJson('/api/sessions?limit=100');
    const sessions = sessionsResult.sessions || [];
    const state = await requestJson('/api/state');
    if (sessions.length === 0) {
      const next = await requestJson('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha1: null })
      });
      return toResult({ sha1: next.sha1, filename: next.filename });
    }
    if (!state.sha1) {
      const first = sessions[0];
      const next = await requestJson('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha1: first.sha1 })
      });
      return toResult({ sha1: next.sha1, filename: next.filename });
    }
    const idx = sessions.findIndex((s) => s.sha1 === state.sha1);
    if (idx >= 0 && idx < sessions.length - 1) {
      const nextSession = sessions[idx + 1];
      const next = await requestJson('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha1: nextSession.sha1 })
      });
      return toResult({ sha1: next.sha1, filename: next.filename });
    }
    const next = await requestJson('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha1: null })
    });
    return toResult({ sha1: next.sha1, filename: next.filename });
  }
);

server.registerTool(
  'get_audio_snapshot',
  {
    description:
      'Compatibility tool. Returns the latest available spectrum content (summary preferred).',
    inputSchema: {
      duration_ms: z.number().int().optional(),
      format: z.enum(['wav', 'pcm']).optional()
    }
  },
  async ({ duration_ms, format }) => {
    await ensureAudioUnlocked();
    const state = await requestJson('/api/state');
    const content = getLatestSpectrumContent(state);
    if (!content) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Audio snapshot not available. Ensure Run view is active and audio is running.'
      );
    }
    return toResult({
      compatibility: true,
      tool: 'get_audio_snapshot',
      note: 'Raw audio export is not implemented; returning latest spectrum content instead.',
      requested: {
        duration_ms: typeof duration_ms === 'number' ? duration_ms : undefined,
        format: typeof format === 'string' ? format : undefined
      },
      mime: 'application/json',
      content
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

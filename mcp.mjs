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

async function triggerRunButton(path, holdMs) {
  return requestJson('/api/run/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, holdMs })
  });
}

async function collectSpectrumMaxHold(captureMs, pollMs = 80) {
  const startedAt = Date.now();
  let lastCapturedAt = startedAt - 1;
  let maxData = null;
  let meta = null;

  while (Date.now() - startedAt < captureMs) {
    const state = await requestJson('/api/state');
    const s = state && state.spectrum ? state.spectrum : null;
    if (s && Array.isArray(s.data) && s.data.length > 0) {
      const capturedAt =
        typeof s.capturedAt === 'number' ? s.capturedAt : state.updatedAt || Date.now();
      if (capturedAt > lastCapturedAt) {
        lastCapturedAt = capturedAt;
        const floorDb = typeof s.floorDb === 'number' ? s.floorDb : -110;
        const safeData = s.data.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : floorDb));
        if (!maxData) {
          maxData = Array.from(safeData);
          meta = {
            capturedAt,
            scale: s.scale,
            fftSize: s.fftSize,
            sampleRate: s.sampleRate,
            fmin: s.fmin,
            fmax: s.fmax,
            floorDb
          };
        } else {
          const n = Math.min(maxData.length, safeData.length);
          for (let i = 0; i < n; i++) {
            if (safeData[i] > maxData[i]) maxData[i] = safeData[i];
          }
          if (meta) meta.capturedAt = capturedAt;
        }
      }
    }
    await sleep(pollMs);
  }

  if (!maxData || !meta) return null;
  return { ...meta, data: maxData };
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
  'submit',
  {
    description: 'Submit Faust code (equivalent to dropping a .dsp file).',
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
      'Get content corresponding to the current view. For view=run, returns the latest spectrum snapshot.',
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
      if (state.spectrum) {
        return toResult({ view: 'run', mime: 'application/json', content: state.spectrum });
      }
      throw new McpError(ErrorCode.InvalidParams, 'Run spectrum not available');
    }

    throw new McpError(ErrorCode.InvalidParams, 'Unsupported view');
  }
);

server.registerTool(
  'get_spectrum',
  {
    description: 'Get the latest spectrum snapshot (independent of current view).',
    inputSchema: {}
  },
  async () => {
    const state = await requestJson('/api/state');
    if (!state.spectrum) {
      throw new McpError(ErrorCode.InvalidParams, 'Spectrum not available');
    }
    return toResult({ mime: 'application/json', content: state.spectrum });
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
    await runTransport('start').catch(() => {});
    await triggerRunButton(path, duration);
    return toResult({ path, holdMs: duration, triggered: true });
  }
);

server.registerTool(
  'trigger_button_and_get_spectrum',
  {
    description: [
      'Trigger a button and capture a max-hold spectrum window in one atomic call.',
      'Useful for transient/percussive sounds where separate calls are too slow.'
    ].join('\n'),
    inputSchema: {
      path: z.string(),
      holdMs: z.number().int().min(1).max(5000).optional(),
      captureMs: z.number().int().min(50).max(10000).optional()
    }
  },
  async ({ path, holdMs, captureMs }) => {
    const duration = typeof holdMs === 'number' ? holdMs : 80;
    const windowMs = typeof captureMs === 'number' ? captureMs : 300;
    await runTransport('start').catch(() => {});
    const capturePromise = collectSpectrumMaxHold(windowMs);
    await triggerRunButton(path, duration);
    const spectrum = await capturePromise;
    if (!spectrum) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No spectrum captured. Ensure Run view is active and audio is running.'
      );
    }
    return toResult({
      path,
      holdMs: duration,
      captureMs: windowMs,
      spectrum
    });
  }
);

server.registerTool(
  'run_transport',
  {
    description: 'Control run transport: start, stop, or toggle audio.',
    inputSchema: {
      action: z.enum(['start', 'stop', 'toggle'])
    }
  },
  async ({ action }) => {
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
    description: 'Get recent audio snapshot (not implemented yet).',
    inputSchema: {
      duration_ms: z.number().int().optional(),
      format: z.enum(['wav', 'pcm']).optional()
    }
  },
  async () => {
    throw new McpError(ErrorCode.MethodNotFound, 'get_audio_snapshot not implemented');
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

import { Request, Response, Router } from 'express';
import { AppState, RunParamCell, StateStore } from '../state';

type RunParamMap = Record<string, RunParamCell>;

interface RegisterRunStateRoutesOptions {
  router: Router;
  stateStore: StateStore;
  markUsed: (sha1: string | null | undefined, weight?: number) => void;
  toFiniteNumber: (input: unknown) => number | null;
  getRunParamMap: (state: AppState) => RunParamMap;
  toRunParamValues: (params: RunParamMap) => Record<string, number>;
  mergeRunParamMaps: (current: RunParamMap, incoming: RunParamMap) => RunParamMap;
}

/**
 * Purpose: Register run-state endpoints on the API router.
 * How: Mounts all `/run/*` handlers while reusing state merge helpers injected from api.ts.
 */
export function registerRunStateRoutes({
  router,
  stateStore,
  markUsed,
  toFiniteNumber,
  getRunParamMap,
  toRunParamValues,
  mergeRunParamMaps
}: RegisterRunStateRoutesOptions): void {
  /**
   * Purpose: Return the run-view UI schema for the active session.
   * How: Validates active session presence, checks stored UI payload, and responds with `{ sha1, ui }`.
   */
  router.get('/run/ui', (_req: Request, res: Response) => {
    const state = stateStore.read();
    if (!state.sha1) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    if (!state.ui) {
      res.status(404).json({ error: 'Run UI not available' });
      return;
    }
    res.json({ sha1: state.sha1, ui: state.ui });
  });

  /**
   * Purpose: Return normalized run parameters for the active session.
   * How: Reads run parameter cells from shared state and exposes both value-only and full-cell maps.
   */
  router.get('/run/params', (_req: Request, res: Response) => {
    const state = stateStore.read();
    if (!state.sha1) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    const cells = getRunParamMap(state);
    res.json({ sha1: state.sha1, params: toRunParamValues(cells), cells });
  });

  /**
   * Purpose: Update one run parameter cell by parameter path.
   * How: Validates payload, merges one incoming cell with timestamp arbitration, and persists updated state.
   */
  router.post('/run/param', (req: Request, res: Response) => {
    const state = stateStore.read();
    if (!state.sha1) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    const { path: paramPath, value } = req.body || {};
    if (!paramPath || typeof paramPath !== 'string') {
      res.status(400).json({ error: 'Missing or invalid path' });
      return;
    }
    if (typeof value !== 'number' || Number.isNaN(value)) {
      res.status(400).json({ error: 'Missing or invalid value' });
      return;
    }
    const now = Date.now();
    const requestedTs = toFiniteNumber(req.body?.d);
    const incomingCell: RunParamCell = {
      v: value,
      d: requestedTs === null ? now : requestedTs,
      owner: null
    };
    const currentParams = getRunParamMap(state);
    const nextParams = mergeRunParamMaps(currentParams, { [paramPath]: incomingCell });
    const applied = nextParams[paramPath] || currentParams[paramPath] || { v: value, d: now, owner: null };
    const next = stateStore.update({ runParams: nextParams });
    markUsed(next.sha1, 0);
    res.json({
      sha1: next.sha1,
      path: paramPath,
      value: applied.v,
      cell: applied,
      params: toRunParamValues(nextParams),
      cells: nextParams
    });
  });

  /**
   * Purpose: Emit a run transport command for the active session.
   * How: Validates transport action, writes a nonce-tagged command object in shared state, and returns it.
   */
  router.post('/run/transport', (req: Request, res: Response) => {
    const state = stateStore.read();
    if (!state.sha1) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    const { action } = req.body || {};
    if (action !== 'start' && action !== 'stop' && action !== 'toggle') {
      res.status(400).json({ error: 'Invalid action' });
      return;
    }
    const next = stateStore.update({
      runTransport: {
        action,
        nonce: Date.now()
      }
    });
    markUsed(next.sha1, 0);
    res.json({ sha1: next.sha1, runTransport: next.runTransport });
  });

  /**
   * Purpose: Trigger a frontend run button press/release cycle.
   * How: Validates target path, bounds hold duration, stores trigger command with nonce, and returns it.
   */
  router.post('/run/trigger', (req: Request, res: Response) => {
    const state = stateStore.read();
    if (!state.sha1) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    const { path: paramPath, holdMs } = req.body || {};
    if (!paramPath || typeof paramPath !== 'string') {
      res.status(400).json({ error: 'Missing or invalid path' });
      return;
    }
    const safeHoldMs =
      typeof holdMs === 'number' && Number.isFinite(holdMs)
        ? Math.max(1, Math.min(5000, Math.round(holdMs)))
        : 80;
    const next = stateStore.update({
      runTrigger: {
        path: paramPath,
        holdMs: safeHoldMs,
        nonce: Date.now()
      }
    });
    markUsed(next.sha1, 0);
    res.json({ sha1: next.sha1, runTrigger: next.runTrigger });
  });

  /**
   * Purpose: Return the current run polyphony mode for the active session.
   * How: Reads `runPolyphony` from shared state, normalizes it to a bounded integer, and responds with voices count.
   */
  router.get('/run/polyphony', (_req: Request, res: Response) => {
    const state = stateStore.read();
    if (!state.sha1) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    const voices = Number.isFinite(state.runPolyphony) ? Math.max(0, Math.round(state.runPolyphony || 0)) : 0;
    res.json({ sha1: state.sha1, voices });
  });

  /**
   * Purpose: Update the active session polyphony mode.
   * How: Validates allowed voices values, stores normalized polyphony, and returns the persisted value.
   */
  router.post('/run/polyphony', (req: Request, res: Response) => {
    const state = stateStore.read();
    if (!state.sha1) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    const { voices } = req.body || {};
    if (typeof voices !== 'number' || !Number.isFinite(voices)) {
      res.status(400).json({ error: 'Missing or invalid voices' });
      return;
    }
    const safeVoices = Math.max(0, Math.round(voices));
    const allowed = new Set([0, 1, 2, 4, 8, 16, 32, 64]);
    if (!allowed.has(safeVoices)) {
      res.status(400).json({ error: 'Invalid voices (allowed: 0,1,2,4,8,16,32,64)' });
      return;
    }
    const next = stateStore.update({ runPolyphony: safeVoices });
    markUsed(next.sha1, 0);
    res.json({ sha1: next.sha1, voices: next.runPolyphony || 0 });
  });

  /**
   * Purpose: Publish one atomic run MIDI command.
   * How: Validates MIDI payload, clamps note/velocity/hold values, stores a nonce-tagged command, and returns it.
   */
  router.post('/run/midi', (req: Request, res: Response) => {
    const state = stateStore.read();
    if (!state.sha1) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    const { action, note, velocity, holdMs } = req.body || {};
    if (action !== 'on' && action !== 'off' && action !== 'pulse') {
      res.status(400).json({ error: 'Invalid action' });
      return;
    }
    if (typeof note !== 'number' || !Number.isFinite(note)) {
      res.status(400).json({ error: 'Missing or invalid note' });
      return;
    }
    const safeNote = Math.max(0, Math.min(127, Math.round(note)));
    const safeVelocity =
      typeof velocity === 'number' && Number.isFinite(velocity)
        ? Math.max(0, Math.min(1, velocity))
        : 0.8;
    const safeHoldMs =
      typeof holdMs === 'number' && Number.isFinite(holdMs)
        ? Math.max(1, Math.min(5000, Math.round(holdMs)))
        : 120;

    const next = stateStore.update({
      runMidi: {
        action,
        note: safeNote,
        velocity: safeVelocity,
        holdMs: safeHoldMs,
        nonce: Date.now()
      }
    });
    markUsed(next.sha1, 1);
    res.json({ sha1: next.sha1, runMidi: next.runMidi });
  });
}

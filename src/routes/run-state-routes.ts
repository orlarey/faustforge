import { Request, Response, Router } from 'express';
import { AppState, RunParamCell, StateStore } from '../state';

type RunParamMap = Record<string, RunParamCell>;

interface RegisterRunStateRoutesOptions {
  router: Router;
  stateStore: StateStore;
  markUsed: (sha1: string | null | undefined, weight?: number) => void;
  toFiniteNumber: (input: unknown) => number | null;
  normalizeOwner: (input: unknown) => string | null | undefined;
  getRunParamMap: (state: AppState) => RunParamMap;
  toRunParamValues: (params: RunParamMap) => Record<string, number>;
  mergeRunParamMaps: (current: RunParamMap, incoming: RunParamMap, writer: string | null) => RunParamMap;
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
  normalizeOwner,
  getRunParamMap,
  toRunParamValues,
  mergeRunParamMaps
}: RegisterRunStateRoutesOptions): void {
  /**
   * GET /run/ui
   * Récupère la structure UI de la session courante en vue run
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
   * GET /run/params
   * Récupère les paramètres run courants
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
   * POST /run/param
   * Met à jour un paramètre run par path
   * Body: { path: string, value: number, uiId?: string|null, owner?: string|null, d?: number }
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
    const writer = normalizeOwner(req.body?.uiId) ?? 'ui:mcp';
    const requestedOwner = normalizeOwner(req.body?.owner);
    const requestedTs = toFiniteNumber(req.body?.d);
    const incomingCell: RunParamCell = {
      v: value,
      d: requestedTs === null ? now : requestedTs,
      owner: requestedOwner === undefined ? null : requestedOwner
    };
    const currentParams = getRunParamMap(state);
    const nextParams = mergeRunParamMaps(currentParams, { [paramPath]: incomingCell }, writer);
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
   * POST /run/transport
   * Contrôle transport run (start/stop/toggle)
   * Body: { action: "start" | "stop" | "toggle" }
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
   * POST /run/trigger
   * Déclenche un bouton run côté frontend (cycle press/release atomique)
   * Body: { path: string, holdMs?: number }
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
   * GET /run/polyphony
   * Récupère le mode polyphonique courant (0 = mono)
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
   * POST /run/polyphony
   * Met à jour le mode polyphonique (0 = mono)
   * Body: { voices: number }
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
   * POST /run/midi
   * Publie une commande MIDI run atomique
   * Body: { action: "on" | "off" | "pulse", note: number, velocity?: number, holdMs?: number }
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

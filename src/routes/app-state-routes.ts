import { Request, Response, Router } from 'express';
import { AppState, RunParamCell, StateStore, View } from '../state';
import { SessionManager } from '../sessions';

type RunParamMap = Record<string, RunParamCell>;

interface RegisterAppStateRoutesOptions {
  router: Router;
  stateStore: StateStore;
  sessionManager: SessionManager;
  markUsed: (sha1: string | null | undefined, weight?: number) => void;
  getRunParamMap: (state: AppState) => RunParamMap;
  normalizeRunParamMap: (input: unknown, fallbackTs: number) => RunParamMap;
  mergeRunParamMaps: (current: RunParamMap, incoming: RunParamMap) => RunParamMap;
}

/**
 * Purpose: Register shared application state routes.
 * How: Mounts read/write endpoints for session/view state and applies deterministic merge rules for run-scoped payloads.
 */
export function registerAppStateRoutes({
  router,
  stateStore,
  sessionManager,
  markUsed,
  getRunParamMap,
  normalizeRunParamMap,
  mergeRunParamMaps
}: RegisterAppStateRoutesOptions): void {
  /**
   * Purpose: Return current shared application state.
   * How: Reads state store and returns the full serialized payload.
   */
  router.get('/state', (_req: Request, res: Response) => {
    const state = stateStore.read();
    res.json(state);
  });

  /**
   * Purpose: Merge client-provided partial state updates into shared application state.
   * How: Validates session/view/run payloads, applies scoped run-state arbitration, and persists deterministic merged state.
   */
  router.post('/state', (req: Request, res: Response) => {
    const currentState = stateStore.read();
    const currentSha = typeof currentState.sha1 === 'string' ? currentState.sha1 : null;
    const {
      sha1,
      view,
      audioUnlocked,
      ui,
      runStateSha,
      runParams,
      runTransport,
      runTrigger,
      runPolyphony,
      runMidi,
      spectrum,
      spectrumSummary
    } =
      req.body || {};
    const partial: {
      sha1?: string | null;
      filename?: string | null;
      view?: View;
      audioUnlocked?: boolean;
      ui?: unknown;
      runParams?: AppState['runParams'];
      runTransport?: AppState['runTransport'];
      runTrigger?: AppState['runTrigger'];
      runPolyphony?: number;
      runMidi?: AppState['runMidi'];
      runOrbitUi?: AppState['runOrbitUi'];
      spectrum?: AppState['spectrum'];
      spectrumSummary?: AppState['spectrumSummary'];
    } = {};

    if (typeof view === 'string') {
      partial.view = view as View;
    }
    if (typeof audioUnlocked === 'boolean') {
      partial.audioUnlocked = audioUnlocked;
    }

    if (sha1 === null) {
      partial.sha1 = null;
      partial.filename = null;
    } else if (typeof sha1 === 'string') {
      const session = sessionManager.getSession(sha1);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      partial.sha1 = session.sha1;
      partial.filename = session.filename;
    }

    if (ui !== undefined) {
      partial.ui = ui;
    }
    const targetShaForRunState =
      partial.sha1 === undefined
        ? currentSha
        : (typeof partial.sha1 === 'string' ? partial.sha1 : null);
    const runStateShaTag = typeof runStateSha === 'string' && runStateSha.trim() ? runStateSha.trim() : null;
    const acceptRunScopedWrite = !runStateShaTag || runStateShaTag === targetShaForRunState;

    if (runParams !== undefined) {
      if (acceptRunScopedWrite) {
        const now = Date.now();
        const currentParams = getRunParamMap(currentState);
        const incomingParams = normalizeRunParamMap(runParams, now);
        // Merge per-path by timestamp instead of blind overwrite.
        partial.runParams = mergeRunParamMaps(currentParams, incomingParams);
      }
    }
    if (runTransport !== undefined) {
      if (acceptRunScopedWrite) {
        partial.runTransport = runTransport as AppState['runTransport'];
      }
    }
    if (runTrigger !== undefined) {
      if (acceptRunScopedWrite) {
        partial.runTrigger = runTrigger as AppState['runTrigger'];
      }
    }
    if (typeof runPolyphony === 'number' && Number.isFinite(runPolyphony)) {
      if (acceptRunScopedWrite) {
        partial.runPolyphony = Math.max(0, Math.round(runPolyphony));
      }
    }
    if (runMidi !== undefined) {
      if (acceptRunScopedWrite) {
        partial.runMidi = runMidi as AppState['runMidi'];
      }
    }
    // `runOrbitUi` is intentionally not merged from frontend writes:
    // Orbit geometry is local presentation state, not shared session state.
    if (spectrum !== undefined) {
      if (acceptRunScopedWrite) {
        partial.spectrum = spectrum as AppState['spectrum'];
      }
    }
    if (spectrumSummary !== undefined) {
      if (acceptRunScopedWrite) {
        partial.spectrumSummary = spectrumSummary as AppState['spectrumSummary'];
      }
    }

    const nextSha =
      partial.sha1 === undefined
        ? currentSha
        : (typeof partial.sha1 === 'string' ? partial.sha1 : null);
    const sessionChanged = nextSha !== currentSha;
    if (sessionChanged) {
      // Run runtime state is session-scoped: when active session changes, stale
      // run payloads must not bleed into the new session unless explicitly provided.
      if (runParams === undefined) partial.runParams = {};
      if (runTransport === undefined) partial.runTransport = undefined;
      if (runTrigger === undefined) partial.runTrigger = undefined;
      if (runMidi === undefined) partial.runMidi = undefined;
      partial.runOrbitUi = undefined;
      if (spectrum === undefined) partial.spectrum = undefined;
      if (spectrumSummary === undefined) partial.spectrumSummary = undefined;
      if (partial.runPolyphony === undefined) partial.runPolyphony = 0;
    }

    const next = stateStore.update(partial);
    if (partial.view !== undefined) {
      markUsed(next.sha1, 1);
    }
    res.json(next);
  });
}

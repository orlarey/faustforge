import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from '../sessions';
import { StateStore, View, AppState, RunParamCell } from '../state';
import {
  analyzeFaust,
  compileFaustCpp,
  compileFaustWasm,
  compileFaustWasmRun,
  compileFaustWebapp,
  getFaustVersion,
  getFaustHelp
} from '../docker';

export function createApiRouter(sessionManager: SessionManager, stateStore: StateStore): Router {
  const router = Router();
  const sessionsBaseDir = process.env.SESSIONS_DIR || '/app/sessions';
  const liveWorkspaceRoot = process.env.LIVE_WORKSPACE_ROOT || '/workspace';
  const hostLiveWorkspaceRoot = process.env.HOST_LIVE_WORKSPACE_ROOT || '';
  const appVersion = readAppVersion();
  // Canonical in-memory shape for run parameter synchronization.
  // Every parameter is represented as a timestamped cell.
  type RunParamMap = Record<string, RunParamCell>;

  function toFiniteNumber(input: unknown): number | null {
    if (typeof input !== 'number' || !Number.isFinite(input)) return null;
    return input;
  }

  function normalizeOwner(input: unknown): string | null | undefined {
    if (input === undefined) return undefined;
    if (input === null) return null;
    if (typeof input !== 'string') return undefined;
    const trimmed = input.trim();
    return trimmed ? trimmed : null;
  }

  function normalizeRunParamCell(input: unknown, fallbackTs: number): RunParamCell | null {
    // Backward compatibility: accept legacy numeric payloads and upgrade to cells.
    if (typeof input === 'number' && Number.isFinite(input)) {
      return { v: input, d: fallbackTs, owner: null };
    }
    if (!input || typeof input !== 'object') return null;
    const obj = input as { v?: unknown; d?: unknown; owner?: unknown };
    const value = toFiniteNumber(obj.v);
    if (value === null) return null;
    const d = toFiniteNumber(obj.d);
    const owner = normalizeOwner(obj.owner);
    return {
      v: value,
      d: d === null ? fallbackTs : d,
      owner: owner === undefined ? null : owner
    };
  }

  function normalizeRunParamMap(input: unknown, fallbackTs: number): RunParamMap {
    // Defensive normalization: malformed entries are dropped, never partially trusted.
    const map: RunParamMap = {};
    if (!input || typeof input !== 'object') return map;
    for (const [path, rawCell] of Object.entries(input as Record<string, unknown>)) {
      if (!path) continue;
      const cell = normalizeRunParamCell(rawCell, fallbackTs);
      if (!cell) continue;
      map[path] = cell;
    }
    return map;
  }

  function getRunParamMap(state: AppState): RunParamMap {
    return normalizeRunParamMap(state.runParams || {}, 0);
  }

  function toRunParamValues(params: RunParamMap): Record<string, number> {
    const values: Record<string, number> = {};
    for (const [path, cell] of Object.entries(params)) {
      values[path] = cell.v;
    }
    return values;
  }

  function mergeRunParamMaps(current: RunParamMap, incoming: RunParamMap, writer: string | null): RunParamMap {
    // Per-param arbitration rules:
    // 1) lock ownership: writer must own lock (or lock must be free),
    // 2) freshness: incoming timestamp must be >= current timestamp,
    // 3) lock transitions are explicit via incoming `owner`.
    const merged: RunParamMap = { ...current };
    for (const [path, incomingCell] of Object.entries(incoming)) {
      const existing = merged[path];
      if (!existing) {
        merged[path] = {
          v: incomingCell.v,
          d: incomingCell.d,
          owner: incomingCell.owner ?? null
        };
        continue;
      }
      const existingOwner = normalizeOwner(existing.owner) ?? null;
      const writerOwnsLock = !!writer && existingOwner === writer;
      if (existingOwner && !writerOwnsLock) {
        continue;
      }
      if (incomingCell.d < existing.d) {
        continue;
      }

      let nextOwner = existingOwner;
      const requestedOwner = normalizeOwner(incomingCell.owner);
      if (requestedOwner !== undefined) {
        if (requestedOwner === null) {
          nextOwner = writerOwnsLock || !existingOwner ? null : existingOwner;
        } else if (!existingOwner || writerOwnsLock || existingOwner === requestedOwner) {
          nextOwner = requestedOwner;
        }
      }

      merged[path] = {
        v: incomingCell.v,
        d: incomingCell.d,
        owner: nextOwner
      };
    }
    return merged;
  }

  function clearSessionArtifacts(sessionPath: string): void {
    const targets = ['generated.cpp', 'signals.dot', 'tasks.dot', 'svg', 'wasm', 'webapp'];
    for (const relative of targets) {
      const fullPath = path.join(sessionPath, relative);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {
        // Ignorer les erreurs de nettoyage
      }
    }
  }

  function isLiveSessionId(id: string): boolean {
    return /^live-[0-9a-f]{40}$/.test(id);
  }

  function sanitizeEditableFilename(input: string): string {
    const base = path.basename(String(input || 'session.dsp'));
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (cleaned.toLowerCase().endsWith('.dsp')) {
      return cleaned;
    }
    return `${cleaned}.dsp`;
  }

  function buildEditorUrl(editor: string, hostPath: string): string | null {
    if (editor !== 'vscode') return null;
    const normalized = hostPath.replace(/\\/g, '/');
    return `vscode://file/${encodeURI(normalized)}`;
  }

  async function tarGzDirectory(
    sessionPath: string,
    dirName: string,
    outFile: string
  ): Promise<{ success: boolean; errors: string; archivePath?: string }> {
    const dirPath = path.join(sessionPath, dirName);
    if (!fs.existsSync(dirPath)) {
      return { success: false, errors: 'Directory not found' };
    }

    const archivePath = path.join(sessionPath, outFile);
    const archived = await createTarGzArchive(sessionPath, archivePath, dirName);
    if (!archived.success || !fs.existsSync(archivePath)) {
      return { success: false, errors: archived.errors || 'Archive failed' };
    }
    return { success: true, errors: '', archivePath };
  }

  async function tarGzFromDirectory(
    sourceDir: string,
    outArchivePath: string
  ): Promise<{ success: boolean; errors: string }> {
    return createTarGzArchive(sourceDir, outArchivePath, '.');
  }

  async function createTarGzArchive(
    cwd: string,
    outArchivePath: string,
    targetPath: string
  ): Promise<{ success: boolean; errors: string }> {
    const tarCmd = await runTarCommand(cwd, outArchivePath, targetPath);
    if (tarCmd.success) {
      return tarCmd;
    }
    if (!tarCmd.notFound) {
      return tarCmd;
    }

    // Fallback when `tar` is not installed.
    return runPythonTar(cwd, outArchivePath, targetPath);
  }

  async function runTarCommand(
    cwd: string,
    outArchivePath: string,
    targetPath: string
  ): Promise<{ success: boolean; errors: string; notFound?: boolean }> {
    return new Promise((resolve) => {
      const args = ['-czf', outArchivePath, targetPath];
      const proc = spawn('tar', args, { cwd });
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(outArchivePath)) {
          resolve({ success: false, errors: stderr || 'tar failed' });
          return;
        }
        resolve({ success: true, errors: '' });
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        if (err && err.code === 'ENOENT') {
          resolve({ success: false, errors: 'tar command not found', notFound: true });
          return;
        }
        resolve({ success: false, errors: `tar error: ${err.message}` });
      });
    });
  }

  async function runPythonTar(
    cwd: string,
    outArchivePath: string,
    targetPath: string
  ): Promise<{ success: boolean; errors: string }> {
    return new Promise((resolve) => {
      const pythonCode = [
        'import os, sys, tarfile',
        'base = sys.argv[1]',
        'out_path = sys.argv[2]',
        'target = sys.argv[3]',
        "target_path = os.path.normpath(os.path.join(base, target))",
        'if not os.path.exists(target_path):',
        "    print('Target not found', file=sys.stderr)",
        '    sys.exit(2)',
        "tf = tarfile.open(out_path, 'w:gz')",
        'if os.path.isfile(target_path):',
        '    rel = os.path.relpath(target_path, base)',
        '    tf.add(target_path, arcname=rel)',
        'else:',
        '    rel = os.path.relpath(target_path, base)',
        '    tf.add(target_path, arcname=rel)',
        'tf.close()'
      ].join('; ');
      const proc = spawn('python3', ['-c', pythonCode, cwd, outArchivePath, targetPath], { cwd });
      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      proc.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(outArchivePath)) {
          resolve({ success: false, errors: stderr || 'tar.gz failed (python fallback)' });
          return;
        }
        resolve({ success: true, errors: '' });
      });
      proc.on('error', (err: NodeJS.ErrnoException) => {
        if (err && err.code === 'ENOENT') {
          resolve({ success: false, errors: 'Neither tar nor python3 is available to create archives' });
          return;
        }
        resolve({ success: false, errors: `Python tar error: ${err.message}` });
      });
    });
  }

  /**
   * POST /submit
   * Soumet du code Faust, crée une session et lance l'analyse
   * Body: { code: string, filename: string, persistOnSuccessOnly?: boolean }
   * Response: { sha1: string, errors: string, persisted: boolean }
   */
  router.post('/submit', async (req: Request, res: Response) => {
    const { code, filename, persistOnSuccessOnly } = req.body;

    // Validation
    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'Missing or invalid code' });
      return;
    }

    if (!filename || typeof filename !== 'string' || !filename.endsWith('.dsp')) {
      res.status(400).json({ error: 'Missing or invalid filename (must end with .dsp)' });
      return;
    }

    try {
      const persistOnlyIfSuccess = persistOnSuccessOnly === true;
      const sha1 = sessionManager.computeSha1(code);

      // Existing session: return as-is.
      if (sessionManager.exists(sha1)) {
        const errors = sessionManager.getErrors(sha1);
        res.json({ sha1, errors, persisted: true });
        return;
      }

      if (persistOnlyIfSuccess) {
        // Analyze in a temporary workspace under sessions dir.
        // This is required when running inside Docker with host docker.sock:
        // the mounted source path must exist on host side too.
        const tempBase = fs.existsSync(sessionsBaseDir) ? sessionsBaseDir : osTmpFallback();
        const tempRoot = fs.mkdtempSync(path.join(tempBase, 'faust-submit-'));
        const sourceDir = path.join(tempRoot, 'sourcecode');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, filename), code, 'utf8');

        const result = await analyzeFaust(tempRoot, filename);

        if (!result.success) {
          fs.rmSync(tempRoot, { recursive: true, force: true });
          res.json({ sha1, errors: result.errors, persisted: false });
          return;
        }

        const session = sessionManager.createSession(code, filename);
        const tempCpp = path.join(tempRoot, 'generated.cpp');
        const tempSvg = path.join(tempRoot, 'svg');
        const tempSignalsDot = path.join(tempRoot, 'signals.dot');
        const tempTasksDot = path.join(tempRoot, 'tasks.dot');

        if (fs.existsSync(tempCpp)) {
          fs.copyFileSync(tempCpp, path.join(session.path, 'generated.cpp'));
        }
        if (fs.existsSync(tempSvg)) {
          fs.cpSync(tempSvg, path.join(session.path, 'svg'), { recursive: true });
        }
        if (fs.existsSync(tempSignalsDot)) {
          fs.copyFileSync(tempSignalsDot, path.join(session.path, 'signals.dot'));
        }
        if (fs.existsSync(tempTasksDot)) {
          fs.copyFileSync(tempTasksDot, path.join(session.path, 'tasks.dot'));
        }
        fs.writeFileSync(path.join(session.path, 'errors.log'), result.errors || '', 'utf8');
        fs.rmSync(tempRoot, { recursive: true, force: true });

        res.json({
          sha1: session.sha1,
          errors: result.errors,
          persisted: true
        });
        return;
      }

      // Créer ou récupérer la session
      const session = sessionManager.createSession(code, filename);

      // Vérifier si l'analyse a déjà été faite (generated.cpp existe)
      const existingCpp = sessionManager.getFile(session.sha1, 'generated.cpp');
      if (existingCpp) {
        // Session existante avec analyse déjà faite
        const errors = sessionManager.getErrors(session.sha1);
        res.json({ sha1: session.sha1, errors, persisted: true });
        return;
      }

      // Lancer l'analyse Faust
      const result = await analyzeFaust(session.path, filename);

      res.json({
        sha1: session.sha1,
        errors: result.errors,
        persisted: true
      });
    } catch (err) {
      console.error('Error in /submit:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /sessions
   * Liste les sessions par ordre de création
   * Query: ?limit=number
   * Response: { sessions: Array<{ sha1, kind, filename, compilation_time }> }
   */
  router.get('/sessions', (req: Request, res: Response) => {
    const limitParam = req.query.limit;
    const limit = typeof limitParam === 'string' ? parseInt(limitParam, 10) : undefined;
    const sessions = sessionManager.listSessionsByCreation(limit);
    res.json({ sessions });
  });

  /**
   * POST /live/open
   * Ouvre (ou met à jour) une session live à partir d'un fichier .dsp local.
   * Body: { filePath: string }
   */
  router.post('/live/open', async (req: Request, res: Response) => {
    const { filePath } = req.body || {};
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'Missing or invalid filePath' });
      return;
    }
    try {
      const session = sessionManager.createOrUpdateLiveSessionFromFile(filePath);
      const code = sessionManager.getFile(session.sha1, 'user_code.dsp')?.toString('utf8') || '';
      if (code.trim().length === 0) {
        sessionManager.setErrors(session.sha1, '');
        res.json({ sha1: session.sha1, kind: 'live', filename: session.filename, errors: '' });
        return;
      }
      const result = await analyzeFaust(session.path, session.filename);
      res.json({ sha1: session.sha1, kind: 'live', filename: session.filename, errors: result.errors });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to open live session';
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /:sha/live/refresh
   * Rafraîchit une session live depuis son fichier source.
   */
  router.post('/:sha/live/refresh', async (req: Request, res: Response) => {
    const { sha } = req.params;
    try {
      const refreshed = sessionManager.refreshLiveSession(sha);
      if (!refreshed.session) {
        res.status(404).json({ error: 'Live session not found or not refreshable' });
        return;
      }
      if (!refreshed.changed) {
        res.json({
          sha1: refreshed.session.sha1,
          kind: 'live',
          changed: false,
          contentSha1: refreshed.contentSha1,
          errors: sessionManager.getErrors(sha)
        });
        return;
      }
      const result = await analyzeFaust(refreshed.session.path, refreshed.session.filename);
      res.json({
        sha1: refreshed.session.sha1,
        kind: 'live',
        changed: true,
        contentSha1: refreshed.contentSha1,
        errors: result.errors
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to refresh live session';
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /:sha/edit
   * Convertit une session statique en session live éditable via fichier workspace.
   * Body: { editor?: "vscode", openEditor?: boolean }
   */
  router.post('/:sha/edit', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const { editor, openEditor } = req.body || {};
    const chosenEditor = typeof editor === 'string' && editor.trim() ? editor.trim() : 'vscode';
    const openEditorRequested = openEditor !== false;

    if (!sessionManager.exists(sha)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (isLiveSessionId(sha)) {
      res.status(409).json({ error: 'Edit is only available for static sessions' });
      return;
    }
    if (!liveWorkspaceRoot || !fs.existsSync(liveWorkspaceRoot)) {
      res.status(400).json({
        error: 'LIVE_WORKSPACE_ROOT is not available. Mount a workspace and configure LIVE_WORKSPACE_ROOT.'
      });
      return;
    }

    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const source = sessionManager.getFile(sha, 'user_code.dsp');
    if (!source) {
      res.status(404).json({ error: 'Source DSP not found' });
      return;
    }

    const safeName = sanitizeEditableFilename(session.filename || 'session.dsp');
    const targetDir = path.join(liveWorkspaceRoot, 'faustforge-edit');
    const targetFile = path.join(targetDir, `${sha}-${safeName}`);

    try {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetFile, source);

      const liveSession = sessionManager.createOrUpdateLiveSessionFromFile(targetFile);
      const code = source.toString('utf8');
      const isBlank = code.trim().length === 0;
      let errors = '';
      if (!isBlank) {
        const result = await analyzeFaust(liveSession.path, liveSession.filename);
        errors = result.errors || '';
      } else {
        sessionManager.setErrors(liveSession.sha1, '');
      }

      const state = stateStore.update({
        sha1: liveSession.sha1,
        filename: liveSession.filename
      });

      let hostPath: string | undefined;
      let editorUrl: string | undefined;
      if (hostLiveWorkspaceRoot) {
        hostPath = path.join(hostLiveWorkspaceRoot, 'faustforge-edit', `${sha}-${safeName}`);
        const computedEditorUrl = buildEditorUrl(chosenEditor, hostPath);
        if (computedEditorUrl) {
          editorUrl = computedEditorUrl;
        }
      }

      res.json({
        sourceSha1: sha,
        liveSha1: liveSession.sha1,
        filename: liveSession.filename,
        containerPath: targetFile,
        hostPath,
        editorUrl,
        openEditorRequested,
        errors,
        state: {
          sha1: state.sha1,
          filename: state.filename
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create editable live session';
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /version
   * Récupère la version du compilateur Faust (via Docker)
   * Response: { version: string }
   */
  router.get('/version', async (_req: Request, res: Response) => {
    try {
      const version = await getFaustVersion();
      res.json({ version });
    } catch {
      res.json({ version: 'Faust version unknown' });
    }
  });

  /**
   * GET /faust/help
   * Récupère l'aide du compilateur Faust (options disponibles).
   */
  router.get('/faust/help', async (_req: Request, res: Response) => {
    try {
      const help = await getFaustHelp();
      res.json({ help });
    } catch {
      res.json({ help: 'Faust help unavailable' });
    }
  });

  /**
   * GET /app-version
   * Récupère la version de faustforge (package.json)
   * Response: { version: string }
   */
  router.get('/app-version', (_req: Request, res: Response) => {
    res.json({ version: appVersion });
  });

  /**
   * GET /state
   * Récupère l'état courant (session + vue)
   */
  router.get('/state', (_req: Request, res: Response) => {
    const state = stateStore.read();
    res.json(state);
  });

  /**
   * POST /state
   * Met à jour l'état courant (session + vue)
   * Body: { sha1?: string|null, view?: View, audioUnlocked?: boolean, ui?: any, runParams?: any, runParamsUi?: string|null, runTransport?: any, runTrigger?: any, runPolyphony?: number, runMidi?: any, runOrbitUi?: any, spectrum?: any, spectrumSummary?: any }
   */
  router.post('/state', (req: Request, res: Response) => {
    const {
      sha1,
      view,
      audioUnlocked,
      ui,
      runParams,
      runParamsUi,
      runTransport,
      runTrigger,
      runPolyphony,
      runMidi,
      runOrbitUi,
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
    if (runParams !== undefined) {
      const now = Date.now();
      const writer = normalizeOwner(runParamsUi) ?? null;
      const currentParams = getRunParamMap(stateStore.read());
      const incomingParams = normalizeRunParamMap(runParams, now);
      // Merge instead of blind overwrite so concurrent writers remain deterministic.
      partial.runParams = mergeRunParamMaps(currentParams, incomingParams, writer);
    }
    if (runTransport !== undefined) {
      partial.runTransport = runTransport as AppState['runTransport'];
    }
    if (runTrigger !== undefined) {
      partial.runTrigger = runTrigger as AppState['runTrigger'];
    }
    if (typeof runPolyphony === 'number' && Number.isFinite(runPolyphony)) {
      partial.runPolyphony = Math.max(0, Math.round(runPolyphony));
    }
    if (runMidi !== undefined) {
      partial.runMidi = runMidi as AppState['runMidi'];
    }
    if (runOrbitUi !== undefined) {
      partial.runOrbitUi = runOrbitUi as AppState['runOrbitUi'];
    }
    if (spectrum !== undefined) {
      partial.spectrum = spectrum as AppState['spectrum'];
    }
    if (spectrumSummary !== undefined) {
      partial.spectrumSummary = spectrumSummary as AppState['spectrumSummary'];
    }

    const next = stateStore.update(partial);
    res.json(next);
  });

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
   * POST /:sha/refresh
   * Régénère les artefacts de session à partir du code source existant
   */
  router.post('/:sha/refresh', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    try {
      clearSessionArtifacts(session.path);
      const result = await analyzeFaust(session.path, session.filename);
      res.json({
        sha1: session.sha1,
        errors: result.errors
      });
    } catch (err) {
      console.error('Error in /:sha/refresh:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
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
    // `params` is the compatibility view (numeric values only).
    // `cells` is the canonical synchronization view used by newer clients.
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
    res.json({ sha1: next.sha1, runMidi: next.runMidi });
  });

  /**
   * GET /:sha/user_code.dsp
   * Récupère le code source original
   */
  router.get('/:sha/user_code.dsp', (req: Request, res: Response) => {
    const { sha } = req.params;

    const content = sessionManager.getFile(sha, 'user_code.dsp');
    if (!content) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.type('text/plain').send(content);
  });

  /**
   * GET /:sha/generated.cpp
   * Récupère le code C++ généré
   */
  router.get('/:sha/generated.cpp', (req: Request, res: Response) => {
    const { sha } = req.params;

    const content = sessionManager.getFile(sha, 'generated.cpp');
    if (!content) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.type('text/plain').send(content);
  });

  /**
   * GET /:sha/errors.log
   * Récupère le log d'erreurs
   */
  router.get('/:sha/errors.log', (req: Request, res: Response) => {
    const { sha } = req.params;

    if (!sessionManager.exists(sha)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const errors = sessionManager.getErrors(sha);
    res.type('text/plain').send(errors);
  });

  /**
   * GET /:sha/metadata.json
   * Récupère les métadonnées de session
   */
  router.get('/:sha/metadata.json', (req: Request, res: Response) => {
    const { sha } = req.params;

    const content = sessionManager.getFile(sha, 'metadata.json');
    if (!content) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.type('application/json').send(content);
  });

  /**
   * GET /:sha/svg
   * Liste les fichiers SVG disponibles
   */
  router.get('/:sha/svg', (req: Request, res: Response) => {
    const { sha } = req.params;

    const files = sessionManager.listSvgFiles(sha);
    if (!files) {
      res.status(404).json({ error: 'SVG directory not found' });
      return;
    }

    res.json({ files });
  });

  /**
   * GET /:sha/svg/:name
   * Récupère un fichier SVG spécifique
   */
  router.get('/:sha/svg/:name', (req: Request, res: Response) => {
    const { sha, name } = req.params;

    const content = sessionManager.getFile(sha, `svg/${name}`);
    if (!content) {
      res.status(404).json({ error: 'SVG file not found' });
      return;
    }

    res.type('image/svg+xml').send(content);
  });

  /**
   * GET /:sha/signals.dot
   * Récupère le graphe de signaux DOT
   */
  router.get('/:sha/signals.dot', (req: Request, res: Response) => {
    const { sha } = req.params;

    const content = sessionManager.getFile(sha, 'signals.dot');
    if (!content) {
      res.status(404).json({ error: 'Signals dot not found' });
      return;
    }

    res.type('text/plain').send(content);
  });

  /**
   * GET /:sha/tasks.dot
   * Récupère le graphe de tâches DOT
   */
  router.get('/:sha/tasks.dot', (req: Request, res: Response) => {
    const { sha } = req.params;

    const content = sessionManager.getFile(sha, 'tasks.dot');
    if (!content) {
      res.status(404).json({ error: 'Tasks dot not found' });
      return;
    }

    res.type('text/plain').send(content);
  });

  /**
   * POST /:sha/compile/cpp
   * Recompile le C++ avec des options Faust personnalisées.
   * Body: { flags?: string }
   */
  router.post('/:sha/compile/cpp', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const rawFlags = req.body?.flags;
    if (rawFlags !== undefined && typeof rawFlags !== 'string') {
      res.status(400).json({ error: 'Invalid flags' });
      return;
    }
    const flags = typeof rawFlags === 'string' ? rawFlags : '';
    try {
      const result = await compileFaustCpp(session.path, session.filename, flags);
      if (!result.success) {
        res.status(400).json({ success: false, error: result.errors || 'C++ compilation failed' });
        return;
      }
      res.json({ success: true, flags, errors: result.errors || '' });
    } catch (err) {
      console.error('Error in /compile/cpp:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /:sha/compile/wasm
   * Déclenche la compilation WebAssembly
   */
  router.get('/:sha/compile/wasm', async (req: Request, res: Response) => {
    const { sha } = req.params;

    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Vérifier qu'il n'y a pas d'erreurs de compilation
    const errors = sessionManager.getErrors(sha);
    if (errors.trim()) {
      res.status(400).json({ error: 'Cannot compile: analysis has errors' });
      return;
    }

    try {
      const result = await compileFaustWasm(session.path, session.filename);
      res.json({
        success: result.success,
        errors: result.errors
      });
    } catch (err) {
      console.error('Error in /compile/wasm:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /:sha/compile/run
   * Déclenche la compilation WebAssembly pour exécution web (wasm-i)
   */
  router.get('/:sha/compile/run', async (req: Request, res: Response) => {
    const { sha } = req.params;

    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const errors = sessionManager.getErrors(sha);
    if (errors.trim()) {
      res.status(400).json({ error: 'Cannot compile: analysis has errors' });
      return;
    }

    try {
      const result = await compileFaustWasmRun(session.path, session.filename);
      res.json({
        success: result.success,
        errors: result.errors
      });
    } catch (err) {
      console.error('Error in /compile/run:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /:sha/wasm/:file
   * Récupère un fichier du répertoire wasm/
   */
  router.get('/:sha/wasm/:file', (req: Request, res: Response) => {
    const { sha, file } = req.params;

    const content = sessionManager.getFile(sha, `wasm/${file}`);
    if (!content) {
      res.status(404).json({ error: 'WASM file not found' });
      return;
    }

    // Déterminer le type MIME
    if (file.endsWith('.wasm')) {
      res.type('application/wasm');
    } else if (file.endsWith('.js')) {
      res.type('application/javascript');
    } else if (file.endsWith('.json')) {
      res.type('application/json');
    }

    res.send(content);
  });

  /**
   * GET /:sha/download/dsp
   * Télécharge le fichier DSP original
   */
  router.get('/:sha/download/dsp', (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const content = sessionManager.getFile(sha, 'user_code.dsp');
    if (!content) {
      res.status(404).json({ error: 'DSP file not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${session.filename}"`);
    res.send(content);
  });

  /**
   * GET /:sha/download/cpp
   * Télécharge le fichier C++ généré
   */
  router.get('/:sha/download/cpp', (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const content = sessionManager.getFile(sha, 'generated.cpp');
    if (!content) {
      res.status(404).json({ error: 'C++ file not found' });
      return;
    }

    const base = session.filename.replace(/\.dsp$/i, '') || 'session';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.cpp"`);
    res.send(content);
  });

  /**
   * GET /:sha/download/svg
   * Télécharge les SVG sous forme de tar.gz
   */
  router.get('/:sha/download/svg', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const result = await tarGzDirectory(session.path, 'svg', 'svg.tar.gz');
    if (!result.success || !result.archivePath) {
      res.status(404).json({ error: result.errors || 'SVG not available' });
      return;
    }

    const base = session.filename.replace(/\.dsp$/i, '') || 'session';
    res.download(result.archivePath, `${base}-svg.tar.gz`);
  });

  /**
   * GET /:sha/download/signals
   * Télécharge le graphe de signaux DOT
   */
  router.get('/:sha/download/signals', (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const content = sessionManager.getFile(sha, 'signals.dot');
    if (!content) {
      res.status(404).json({ error: 'Signals dot not found' });
      return;
    }

    const base = session.filename.replace(/\.dsp$/i, '') || 'session';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${base}-sig.dot"`);
    res.send(content);
  });

  /**
   * GET /:sha/download/tasks
   * Télécharge le graphe de tâches DOT
   */
  router.get('/:sha/download/tasks', (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const content = sessionManager.getFile(sha, 'tasks.dot');
    if (!content) {
      res.status(404).json({ error: 'Tasks dot not found' });
      return;
    }

    const base = session.filename.replace(/\.dsp$/i, '') || 'session';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.dsp.dot"`);
    res.send(content);
  });

  /**
   * GET /:sha/download/pwa
   * Télécharge l'application PWA (webapp) sous forme de tar.gz
   */
  router.get('/:sha/download/pwa', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const compile = await compileFaustWebapp(session.path, session.filename);
    if (!compile.success) {
      res.status(500).json({ error: compile.errors || 'PWA generation failed' });
      return;
    }

    const result = await tarGzDirectory(session.path, 'webapp', 'webapp.tar.gz');
    if (!result.success || !result.archivePath) {
      res.status(404).json({ error: result.errors || 'Webapp not available' });
      return;
    }

    const base = session.filename.replace(/\.dsp$/i, '') || 'session';
    res.download(result.archivePath, `${base}-pwa.tar.gz`);
  });

  /**
   * GET /download/archive/dsp
   * Télécharge une archive tar.gz de tous les fichiers DSP des sessions.
   */
  router.get('/download/archive/dsp', async (_req: Request, res: Response) => {
    const tempBase = fs.existsSync(sessionsBaseDir) ? sessionsBaseDir : osTmpFallback();
    const tempRoot = fs.mkdtempSync(path.join(tempBase, 'faust-archive-'));
    const stagingDir = path.join(tempRoot, 'dsp-archive');
    const archivePath = path.join(tempRoot, 'faustforge-dsp-archive.tar.gz');
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
      const sessions = sessionManager.listSessionsByCreation();
      let copied = 0;

      for (const session of sessions) {
        const sessionDir = path.join(sessionsBaseDir, session.sha1);
        const sourceDsp = path.join(sessionDir, 'sourcecode', session.filename);
        const fallbackDsp = path.join(sessionDir, 'user_code.dsp');
        const sessionOutDir = path.join(stagingDir, session.sha1);
        fs.mkdirSync(sessionOutDir, { recursive: true });

        if (fs.existsSync(sourceDsp)) {
          fs.copyFileSync(sourceDsp, path.join(sessionOutDir, session.filename));
          copied += 1;
          continue;
        }

        if (fs.existsSync(fallbackDsp)) {
          const fallbackName = session.filename && session.filename.endsWith('.dsp')
            ? session.filename
            : 'user_code.dsp';
          fs.copyFileSync(fallbackDsp, path.join(sessionOutDir, fallbackName));
          copied += 1;
        }
      }

      if (copied === 0) {
        res.status(404).json({ error: 'No DSP files found to archive' });
        return;
      }

      const archived = await tarGzFromDirectory(stagingDir, archivePath);
      if (!archived.success) {
        res.status(500).json({ error: archived.errors || 'Archive generation failed' });
        return;
      }

      res.download(archivePath, 'faustforge-dsp-archive.tar.gz');
    } finally {
      res.on('finish', () => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      });
      res.on('close', () => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      });
    }
  });

  /**
   * DELETE /:sha
   * Supprime une session
   */
  router.delete('/:sha', (req: Request, res: Response) => {
    const { sha } = req.params;

    const ok = sessionManager.deleteSession(sha);
    if (!ok) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json({ success: true });
  });

  return router;
}

function osTmpFallback(): string {
  return '/tmp';
}

function readAppVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // ignore and fallback
  }
  return '1.0.0';
}

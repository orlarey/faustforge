import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from '../sessions';
import { StateStore, View, AppState, RunParamCell } from '../state';
import { CONFIG } from '../config';
import {
  analyzeFaust,
  getFaustVersion,
  getFaustHelp
} from '../docker';
import { registerCompileDownloadRoutes } from './compile-download-routes';
import { registerRunStateRoutes } from './run-state-routes';

/**
 * Purpose: Build the main API router for session, state, run, compile, and download workflows.
 * How: Creates shared helper functions, mounts core endpoints, then delegates specialized route groups to sub-registrars.
 */
export function createApiRouter(sessionManager: SessionManager, stateStore: StateStore): Router {
  const router = Router();
  const sessionsBaseDir = CONFIG.sessionsDir || '/app/sessions';
  const liveWorkspaceRoot = CONFIG.liveWorkspaceRoot || '/workspace';
  const hostLiveWorkspaceRoot = CONFIG.hostLiveWorkspaceRoot || '';
  const appVersion = readAppVersion();
  // Canonical in-memory shape for run parameter synchronization.
  // Every parameter is represented as a timestamped cell.
  type RunParamMap = Record<string, RunParamCell>;

  /**
   * Purpose: Normalize numeric inputs used by run-state arbitration.
   * How: Accepts only finite numbers and returns `null` for invalid values.
   */
  function toFiniteNumber(input: unknown): number | null {
    if (typeof input !== 'number' || !Number.isFinite(input)) return null;
    return input;
  }

  /**
   * Purpose: Normalize lock-owner identifiers for run parameters.
   * How: Converts `undefined`/`null` consistently and trims non-empty owner strings.
   */
  function normalizeOwner(input: unknown): string | null | undefined {
    if (input === undefined) return undefined;
    if (input === null) return null;
    if (typeof input !== 'string') return undefined;
    const trimmed = input.trim();
    return trimmed ? trimmed : null;
  }

  /**
   * Purpose: Normalize one incoming run-parameter cell payload.
   * How: Supports legacy numeric values, validates structured cell fields, and applies timestamp/owner defaults.
   */
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

  /**
   * Purpose: Normalize a run-parameter map payload into safe canonical cells.
   * How: Iterates object entries, normalizes each cell, and drops malformed paths or values.
   */
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

  /**
   * Purpose: Read canonical run-parameter cells from persisted app state.
   * How: Re-normalizes stored `runParams` through the safe map normalizer.
   */
  function getRunParamMap(state: AppState): RunParamMap {
    return normalizeRunParamMap(state.runParams || {}, 0);
  }

  /**
   * Purpose: Extract scalar parameter values from canonical run cells.
   * How: Builds a flat `{ path: value }` object from each cell's `v` field.
   */
  function toRunParamValues(params: RunParamMap): Record<string, number> {
    const values: Record<string, number> = {};
    for (const [path, cell] of Object.entries(params)) {
      values[path] = cell.v;
    }
    return values;
  }

  /**
   * Purpose: Merge two run-parameter maps with ownership and freshness arbitration.
   * How: Applies lock checks, timestamp ordering, and explicit owner transition rules per parameter path.
   */
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

  /**
   * Purpose: Remove generated artifacts before forced session regeneration.
   * How: Deletes known artifact files/directories with recursive-force semantics and ignores cleanup failures.
   */
  function clearSessionArtifacts(sessionPath: string): void {
    const targets = ['generated.cpp', 'signals.dot', 'tasks.dot', 'svg', 'wasm', 'webapp'];
    for (const relative of targets) {
      const fullPath = path.join(sessionPath, relative);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
  }

  /**
   * Purpose: Record session usage with an optional weighted increment.
   * How: Validates session ID and delegates usage update to session manager with current timestamp.
   */
  function markUsed(sha1: string | null | undefined, weight: number = 1): void {
    if (!sha1 || typeof sha1 !== 'string') return;
    sessionManager.markSessionUsed(sha1, Date.now(), weight);
  }

  /**
   * Purpose: Identify whether a session ID refers to a live session.
   * How: Matches IDs against the `live-<sha1>` format.
   */
  function isLiveSessionId(id: string): boolean {
    return /^live-[0-9a-f]{40}$/.test(id);
  }

  /**
   * Purpose: Produce a safe editable filename for workspace export.
   * How: Keeps basename only, replaces unsafe characters, and enforces `.dsp` extension.
   */
  function sanitizeEditableFilename(input: string): string {
    const base = path.basename(String(input || 'session.dsp'));
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (cleaned.toLowerCase().endsWith('.dsp')) {
      return cleaned;
    }
    return `${cleaned}.dsp`;
  }

  /**
   * Purpose: Split a filename into sanitized base name and extension.
   * How: Uses `path.extname/basename` with `.dsp` and `session` fallbacks.
   */
  function splitBaseAndExt(filename: string): { base: string; ext: string } {
    const ext = path.extname(filename) || '.dsp';
    const base = path.basename(filename, ext) || 'session';
    return { base, ext };
  }

  /**
   * Purpose: Resolve the stable base name used for derived artifact filenames.
   * How: Returns the base component from the filename split helper with a safety fallback.
   */
  function getSessionBaseFilename(filename: string): string {
    return splitBaseAndExt(filename).base || 'session';
  }

  /**
   * Purpose: Resolve a session from request path params with standard 404 response handling.
   * How: Loads session by ID and writes JSON 404 error when missing.
   */
  function requireSession(sha: string, res: Response) {
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return session;
  }

  /**
   * Purpose: Choose a deterministic editable filename in workspace root without collisions.
   * How: Reuses matching-content files when possible or appends incrementing numeric suffixes.
   */
  function chooseEditableFilename(targetDir: string, preferredFilename: string, sourceContent: Buffer): string {
    const safePreferred = sanitizeEditableFilename(preferredFilename);
    const { base, ext } = splitBaseAndExt(safePreferred);
    const directPath = path.join(targetDir, safePreferred);
    if (!fs.existsSync(directPath)) {
      return safePreferred;
    }
    try {
      const existing = fs.readFileSync(directPath);
      if (Buffer.compare(existing, sourceContent) === 0) {
        return safePreferred;
      }
    } catch {
      // Ignore read errors and fallback to unique suffix strategy.
    }

    let n = 1;
    while (true) {
      const candidate = `${base}-${n}${ext}`;
      const candidatePath = path.join(targetDir, candidate);
      if (!fs.existsSync(candidatePath)) {
        return candidate;
      }
      try {
        const existing = fs.readFileSync(candidatePath);
        if (Buffer.compare(existing, sourceContent) === 0) {
          return candidate;
        }
      } catch {
        // ignore and continue
      }
      n += 1;
    }
  }

  /**
   * Purpose: Build editor deep-link URLs for host-side file opening.
   * How: Currently supports VS Code via `vscode://file/...` URLs from normalized host paths.
   */
  function buildEditorUrl(editor: string, hostPath: string): string | null {
    if (editor !== 'vscode') return null;
    const normalized = hostPath.replace(/\\/g, '/');
    return `vscode://file/${encodeURI(normalized)}`;
  }

  /**
   * Purpose: Archive a session subdirectory to `tar.gz`.
   * How: Validates source directory existence and delegates archive creation to shared tar helpers.
   */
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

  /**
   * Purpose: Archive a full directory tree into one `tar.gz` file.
   * How: Invokes the generic archive creator with `.` target path.
   */
  async function tarGzFromDirectory(
    sourceDir: string,
    outArchivePath: string
  ): Promise<{ success: boolean; errors: string }> {
    return createTarGzArchive(sourceDir, outArchivePath, '.');
  }

  /**
   * Purpose: Create a `tar.gz` archive with robust fallback behavior.
   * How: Tries native `tar` first and falls back to Python `tarfile` when `tar` is unavailable.
   */
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

  /**
   * Purpose: Run native `tar` archiving command.
   * How: Spawns `tar -czf`, captures stderr, checks output file existence, and reports command-not-found explicitly.
   */
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

  /**
   * Purpose: Create a `tar.gz` archive using Python fallback runtime.
   * How: Executes an inline `python3` script relying on `tarfile` and validates archive output.
   */
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
   * Purpose: Submit Faust source code and create/refresh its session artifacts.
   * How: Validates payload, reuses existing sessions when available, or analyzes and persists a new session flow.
   */
  router.post('/submit', async (req: Request, res: Response) => {
    const { code, filename, persistOnSuccessOnly } = req.body;

    // Validate request payload.
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

      // Create or fetch the session.
      const session = sessionManager.createSession(code, filename);

      // Reuse existing analysis when generated artifacts are already present.
      const existingCpp = sessionManager.getFile(session.sha1, 'generated.cpp');
      if (existingCpp) {
        // Existing session with completed analysis.
        const errors = sessionManager.getErrors(session.sha1);
        res.json({ sha1: session.sha1, errors, persisted: true });
        return;
      }

      // Run Faust analysis for the newly persisted session.
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
   * Purpose: List sessions with selectable ordering strategy.
   * How: Reads query parameters, dispatches chronological or usage ordering, and returns normalized summaries.
   */
  router.get('/sessions', (req: Request, res: Response) => {
    const limitParam = req.query.limit;
    const limit = typeof limitParam === 'string' ? parseInt(limitParam, 10) : undefined;
    const orderParam = typeof req.query.order === 'string' ? req.query.order : 'chronological';
    const sessions =
      orderParam === 'usage'
        ? sessionManager.listSessionsByUsage(limit)
        : sessionManager.listSessionsByCreation(limit);
    res.json({ sessions });
  });

  /**
   * Purpose: Explicitly mark one session as used from UI workflows.
   * How: Validates session existence, bounds optional weight, and applies usage update.
   */
  router.post('/:sha/use', (req: Request, res: Response) => {
    const { sha } = req.params;
    if (!sessionManager.exists(sha)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const rawWeight = Number(req.body?.weight);
    const weight = Number.isFinite(rawWeight) ? Math.max(0, Math.min(5, rawWeight)) : 1;
    const ok = sessionManager.markSessionUsed(sha, Date.now(), weight);
    if (!ok) {
      res.status(500).json({ error: 'Failed to update last_used_time' });
      return;
    }
    res.json({ success: true, sha1: sha, reason: req.body?.reason || null, weight });
  });

  /**
   * Purpose: Open or update a live session from a local DSP file.
   * How: Resolves live session from file path, skips analysis for blank drafts, otherwise analyzes and returns latest errors.
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
   * Purpose: Refresh one live session from its backing source file.
   * How: Checks whether file content changed, re-analyzes only when needed, and returns updated change metadata.
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
   * Purpose: Convert a static session into an editable live workspace session.
   * How: Copies source into workspace root with collision-safe naming, creates live session, analyzes, and returns editor metadata.
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

    const session = requireSession(sha, res);
    if (!session) return;

    const source = sessionManager.getFile(sha, 'user_code.dsp');
    if (!source) {
      res.status(404).json({ error: 'Source DSP not found' });
      return;
    }

    const safeName = sanitizeEditableFilename(session.filename || 'session.dsp');
    const targetDir = liveWorkspaceRoot;
    const targetName = chooseEditableFilename(targetDir, safeName, source);
    const targetFile = path.join(targetDir, targetName);

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
      markUsed(liveSession.sha1, 3);

      let hostPath: string | undefined;
      let editorUrl: string | undefined;
      if (hostLiveWorkspaceRoot) {
        hostPath = path.join(hostLiveWorkspaceRoot, targetName);
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
   * Purpose: Return Faust compiler version string.
   * How: Fetches cached docker-based version and falls back to a generic message on errors.
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
   * Purpose: Return Faust compiler help text.
   * How: Fetches cached docker-based help output and falls back to an unavailable message on errors.
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
   * Purpose: Return faustforge application version.
   * How: Responds with version cached at router construction time from `package.json`.
   */
  router.get('/app-version', (_req: Request, res: Response) => {
    res.json({ version: appVersion });
  });

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
      runParamsUi,
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
        const writer = normalizeOwner(runParamsUi) ?? null;
        const currentParams = getRunParamMap(currentState);
        const incomingParams = normalizeRunParamMap(runParams, now);
        // Merge instead of blind overwrite so concurrent writers remain deterministic.
        partial.runParams = mergeRunParamMaps(currentParams, incomingParams, writer);
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

  registerRunStateRoutes({
    router,
    stateStore,
    markUsed,
    toFiniteNumber,
    normalizeOwner,
    getRunParamMap,
    toRunParamValues,
    mergeRunParamMaps
  });

  /**
   * Purpose: Regenerate all analysis artifacts for one existing session.
   * How: Clears generated files, reruns Faust analysis, and returns updated error output.
   */
  router.post('/:sha/refresh', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = requireSession(sha, res);
    if (!session) return;

    try {
      clearSessionArtifacts(session.path);
      const result = await analyzeFaust(session.path, session.filename);
      markUsed(session.sha1, 3);
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
   * Purpose: Return original DSP source file for one session.
   * How: Loads `user_code.dsp` from session storage and responds as plain text.
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
   * Purpose: Return generated C++ source for one session.
   * How: Loads `generated.cpp` from session storage and responds as plain text.
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
   * Purpose: Return compiler diagnostics for one session.
   * How: Validates session existence then serves `errors.log` as plain text.
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
   * Purpose: Return session metadata JSON.
   * How: Loads `metadata.json` from session storage and serves it as JSON content.
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
   * Purpose: List available SVG artifact files for one session.
   * How: Reads SVG directory entries and returns filenames as JSON.
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
   * Purpose: Return one SVG artifact by name.
   * How: Loads `svg/<name>` from session storage and serves it with SVG MIME type.
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
   * Purpose: Return generated signals DOT graph.
   * How: Loads `signals.dot` from session storage and serves it as plain text.
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
   * Purpose: Return generated tasks DOT graph.
   * How: Loads `tasks.dot` from session storage and serves it as plain text.
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

  registerCompileDownloadRoutes({
    router,
    sessionManager,
    sessionsBaseDir,
    requireSession,
    markUsed,
    getSessionBaseFilename,
    tarGzDirectory,
    tarGzFromDirectory
  });

  /**
   * Purpose: Delete one session and its stored artifacts.
   * How: Delegates to session manager deletion and returns success or not-found status.
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

/**
 * Purpose: Provide fallback temporary directory path.
 * How: Returns POSIX `/tmp`.
 */
function osTmpFallback(): string {
  return '/tmp';
}

/**
 * Purpose: Read faustforge version from local package metadata.
 * How: Parses `package.json`, validates non-empty version string, and returns default fallback on failures.
 */
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

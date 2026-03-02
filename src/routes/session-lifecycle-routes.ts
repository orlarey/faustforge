import { Request, Response, Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager, Session } from '../sessions';
import { StateStore } from '../state';

interface RegisterSessionLifecycleRoutesOptions {
  router: Router;
  sessionManager: SessionManager;
  stateStore: StateStore;
  sessionsBaseDir: string;
  liveWorkspaceRoot: string;
  hostLiveWorkspaceRoot: string;
  analyzeFaust: (sessionPath: string, filename: string) => Promise<{ success: boolean; errors: string }>;
  requireSession: (sha: string, res: Response) => Session | null;
  markUsed: (sha1: string | null | undefined, weight?: number) => void;
  isLiveSessionId: (id: string) => boolean;
  sanitizeEditableFilename: (input: string) => string;
  chooseEditableFilename: (targetDir: string, preferredFilename: string, sourceContent: Buffer) => string;
  buildEditorUrl: (editor: string, hostPath: string) => string | null;
  osTmpFallback: () => string;
}

/**
 * Purpose: Register session lifecycle routes (submit/list/use/live/edit workflows).
 * How: Mounts session creation, listing, usage, live open/refresh, and editable live conversion endpoints with shared helpers.
 */
export function registerSessionLifecycleRoutes({
  router,
  sessionManager,
  stateStore,
  sessionsBaseDir,
  liveWorkspaceRoot,
  hostLiveWorkspaceRoot,
  analyzeFaust,
  requireSession,
  markUsed,
  isLiveSessionId,
  sanitizeEditableFilename,
  chooseEditableFilename,
  buildEditorUrl,
  osTmpFallback
}: RegisterSessionLifecycleRoutesOptions): void {
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
}

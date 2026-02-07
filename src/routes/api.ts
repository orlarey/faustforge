import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SessionManager } from '../sessions';
import { StateStore, View, AppState } from '../state';
import {
  analyzeFaust,
  compileFaustWasm,
  compileFaustWasmRun,
  compileFaustWebapp,
  getFaustVersion
} from '../docker';

export function createApiRouter(sessionManager: SessionManager, stateStore: StateStore): Router {
  const router = Router();

  async function zipDirectory(
    sessionPath: string,
    dirName: string,
    outFile: string
  ): Promise<{ success: boolean; errors: string; zipPath?: string }> {
    return new Promise((resolve) => {
      const dirPath = path.join(sessionPath, dirName);
      if (!fs.existsSync(dirPath)) {
        resolve({ success: false, errors: 'Directory not found' });
        return;
      }

      const zipPath = path.join(sessionPath, outFile);
      const args = ['-r', '-q', outFile, dirName];
      const proc = spawn('zip', args, { cwd: sessionPath });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(zipPath)) {
          resolve({ success: false, errors: stderr || 'Zip failed' });
          return;
        }
        resolve({ success: true, errors: '', zipPath });
      });

      proc.on('error', (err) => {
        resolve({ success: false, errors: `Zip error: ${err.message}` });
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
        // Analyze in a temporary workspace. Persist only on success.
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faust-submit-'));
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

        if (fs.existsSync(tempCpp)) {
          fs.copyFileSync(tempCpp, path.join(session.path, 'generated.cpp'));
        }
        if (fs.existsSync(tempSvg)) {
          fs.cpSync(tempSvg, path.join(session.path, 'svg'), { recursive: true });
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
   * Response: { sessions: Array<{ sha1, filename, compilation_time }> }
   */
  router.get('/sessions', (req: Request, res: Response) => {
    const limitParam = req.query.limit;
    const limit = typeof limitParam === 'string' ? parseInt(limitParam, 10) : undefined;
    const sessions = sessionManager.listSessionsByCreation(limit);
    res.json({ sessions });
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
   * Body: { sha1?: string|null, view?: View, ui?: any, runParams?: any, runTransport?: any, runTrigger?: any, spectrum?: any }
   */
  router.post('/state', (req: Request, res: Response) => {
    const { sha1, view, ui, runParams, runTransport, runTrigger, spectrum } = req.body || {};
    const partial: {
      sha1?: string | null;
      filename?: string | null;
      view?: View;
      ui?: unknown;
      runParams?: AppState['runParams'];
      runTransport?: AppState['runTransport'];
      runTrigger?: AppState['runTrigger'];
      spectrum?: AppState['spectrum'];
    } = {};

    if (typeof view === 'string') {
      partial.view = view as View;
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
      partial.runParams = runParams as AppState['runParams'];
    }
    if (runTransport !== undefined) {
      partial.runTransport = runTransport as AppState['runTransport'];
    }
    if (runTrigger !== undefined) {
      partial.runTrigger = runTrigger as AppState['runTrigger'];
    }
    if (spectrum !== undefined) {
      partial.spectrum = spectrum as AppState['spectrum'];
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
   * GET /run/params
   * Récupère les paramètres run courants
   */
  router.get('/run/params', (_req: Request, res: Response) => {
    const state = stateStore.read();
    if (!state.sha1) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    res.json({ sha1: state.sha1, params: state.runParams || {} });
  });

  /**
   * POST /run/param
   * Met à jour un paramètre run par path
   * Body: { path: string, value: number }
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
    const nextParams = { ...(state.runParams || {}), [paramPath]: value };
    const next = stateStore.update({ runParams: nextParams });
    res.json({ sha1: next.sha1, path: paramPath, value, params: next.runParams || {} });
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
   * Télécharge les SVG sous forme de zip
   */
  router.get('/:sha/download/svg', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = sessionManager.getSession(sha);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const result = await zipDirectory(session.path, 'svg', 'svg.zip');
    if (!result.success || !result.zipPath) {
      res.status(404).json({ error: result.errors || 'SVG not available' });
      return;
    }

    const base = session.filename.replace(/\.dsp$/i, '') || 'session';
    res.download(result.zipPath, `${base}-svg.zip`);
  });

  /**
   * GET /:sha/download/pwa
   * Télécharge l'application PWA (webapp) sous forme de zip
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

    const result = await zipDirectory(session.path, 'webapp', 'webapp.zip');
    if (!result.success || !result.zipPath) {
      res.status(404).json({ error: result.errors || 'Webapp not available' });
      return;
    }

    const base = session.filename.replace(/\.dsp$/i, '') || 'session';
    res.download(result.zipPath, `${base}-pwa.zip`);
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

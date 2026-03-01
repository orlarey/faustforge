import { Request, Response, Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager, Session } from '../sessions';
import {
  compileFaustCpp,
  compileFaustWasm,
  compileFaustWasmRun,
  compileFaustWebapp
} from '../docker';

interface RegisterCompileDownloadRoutesOptions {
  router: Router;
  sessionManager: SessionManager;
  sessionsBaseDir: string;
  requireSession: (sha: string, res: Response) => Session | null;
  markUsed: (sha1: string | null | undefined, weight?: number) => void;
  getSessionBaseFilename: (filename: string) => string;
  tarGzDirectory: (
    sessionPath: string,
    dirName: string,
    outFile: string
  ) => Promise<{ success: boolean; errors: string; archivePath?: string }>;
  tarGzFromDirectory: (
    sourceDir: string,
    outArchivePath: string
  ) => Promise<{ success: boolean; errors: string }>;
}

function osTmpFallback(): string {
  return '/tmp';
}

/**
 * Purpose: Register compile and download endpoints on the API router.
 * How: Mounts C++/WASM/PWA compilation handlers and all artifact download handlers using shared helpers from api.ts.
 */
export function registerCompileDownloadRoutes({
  router,
  sessionManager,
  sessionsBaseDir,
  requireSession,
  markUsed,
  getSessionBaseFilename,
  tarGzDirectory,
  tarGzFromDirectory
}: RegisterCompileDownloadRoutesOptions): void {
  /**
   * POST /:sha/compile/cpp
   * Recompile le C++ avec des options Faust personnalisées.
   * Body: { flags?: string }
   */
  router.post('/:sha/compile/cpp', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = requireSession(sha, res);
    if (!session) return;
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
      markUsed(session.sha1, 3);
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
    const session = requireSession(sha, res);
    if (!session) return;

    const errors = sessionManager.getErrors(sha);
    if (errors.trim()) {
      res.status(400).json({ error: 'Cannot compile: analysis has errors' });
      return;
    }

    try {
      const result = await compileFaustWasm(session.path, session.filename);
      if (result.success) {
        markUsed(session.sha1, 3);
      }
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
    const session = requireSession(sha, res);
    if (!session) return;

    const errors = sessionManager.getErrors(sha);
    if (errors.trim()) {
      res.status(400).json({ error: 'Cannot compile: analysis has errors' });
      return;
    }

    try {
      const result = await compileFaustWasmRun(session.path, session.filename);
      if (result.success) {
        markUsed(session.sha1, 3);
      }
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
    const session = requireSession(sha, res);
    if (!session) return;

    const content = sessionManager.getFile(sha, 'user_code.dsp');
    if (!content) {
      res.status(404).json({ error: 'DSP file not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${session.filename}"`);
    markUsed(session.sha1, 3);
    res.send(content);
  });

  /**
   * GET /:sha/download/cpp
   * Télécharge le fichier C++ généré
   */
  router.get('/:sha/download/cpp', (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = requireSession(sha, res);
    if (!session) return;

    const content = sessionManager.getFile(sha, 'generated.cpp');
    if (!content) {
      res.status(404).json({ error: 'C++ file not found' });
      return;
    }

    const base = getSessionBaseFilename(session.filename);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.cpp"`);
    markUsed(session.sha1, 3);
    res.send(content);
  });

  /**
   * GET /:sha/download/svg
   * Télécharge les SVG sous forme de tar.gz
   */
  router.get('/:sha/download/svg', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = requireSession(sha, res);
    if (!session) return;

    const result = await tarGzDirectory(session.path, 'svg', 'svg.tar.gz');
    if (!result.success || !result.archivePath) {
      res.status(404).json({ error: result.errors || 'SVG not available' });
      return;
    }

    const base = getSessionBaseFilename(session.filename);
    markUsed(session.sha1, 3);
    res.download(result.archivePath, `${base}-svg.tar.gz`);
  });

  /**
   * GET /:sha/download/signals
   * Télécharge le graphe de signaux DOT
   */
  router.get('/:sha/download/signals', (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = requireSession(sha, res);
    if (!session) return;

    const content = sessionManager.getFile(sha, 'signals.dot');
    if (!content) {
      res.status(404).json({ error: 'Signals dot not found' });
      return;
    }

    const base = getSessionBaseFilename(session.filename);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${base}-sig.dot"`);
    markUsed(session.sha1, 3);
    res.send(content);
  });

  /**
   * GET /:sha/download/tasks
   * Télécharge le graphe de tâches DOT
   */
  router.get('/:sha/download/tasks', (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = requireSession(sha, res);
    if (!session) return;

    const content = sessionManager.getFile(sha, 'tasks.dot');
    if (!content) {
      res.status(404).json({ error: 'Tasks dot not found' });
      return;
    }

    const base = getSessionBaseFilename(session.filename);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.dsp.dot"`);
    markUsed(session.sha1, 3);
    res.send(content);
  });

  /**
   * GET /:sha/download/pwa
   * Télécharge l'application PWA (webapp) sous forme de tar.gz
   */
  router.get('/:sha/download/pwa', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = requireSession(sha, res);
    if (!session) return;

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

    const base = getSessionBaseFilename(session.filename);
    markUsed(session.sha1, 3);
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
}

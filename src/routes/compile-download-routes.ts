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

/**
 * Purpose: Provide a fallback temp directory path for archive staging.
 * How: Returns the POSIX `/tmp` directory used when sessions path is unavailable.
 */
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
   * Purpose: Recompile generated C++ for one session using custom Faust flags.
   * How: Validates optional `flags`, runs backend C++ compilation, and returns the normalized compile result.
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
   * Purpose: Compile one session to WebAssembly artifacts.
   * How: Rejects sessions with analysis errors, executes WASM compilation, and returns success/errors payload.
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
   * Purpose: Compile one session to runtime-oriented WebAssembly artifacts (`wasm-i`).
   * How: Rejects sessions with analysis errors, runs run-target WASM compilation, and returns compile status.
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
   * Purpose: Serve one generated file from the session `wasm/` directory.
   * How: Loads the requested file, applies response MIME by extension, and streams raw content.
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
   * Purpose: Download the original DSP source file for a session.
   * How: Reads `user_code.dsp`, sets attachment headers with original filename, and sends the file bytes.
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
   * Purpose: Download the generated C++ output for a session.
   * How: Reads `generated.cpp`, builds a stable download name from session filename, and sends text content.
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
   * Purpose: Download SVG outputs as a `tar.gz` archive.
   * How: Archives the session `svg/` folder, then sends the resulting archive as a named attachment.
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
   * Purpose: Download the generated signals DOT graph.
   * How: Reads `signals.dot`, sets attachment headers, and returns plain-text DOT content.
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
   * Purpose: Download the generated tasks DOT graph.
   * How: Reads `tasks.dot`, sets attachment headers, and returns plain-text DOT content.
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
   * Purpose: Download a generated PWA webapp as a `tar.gz` archive.
   * How: Ensures webapp generation exists, archives `webapp/`, and sends the archive as an attachment.
   */
  router.get('/:sha/download/pwa', async (req: Request, res: Response) => {
    const { sha } = req.params;
    const session = requireSession(sha, res);
    if (!session) return;

    const existingWebappIndex = path.join(session.path, 'webapp', 'index.html');
    const hasExistingWebapp = fs.existsSync(existingWebappIndex);
    const compile = await compileFaustWebapp(session.path, session.filename);
    if (!compile.success && !hasExistingWebapp) {
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
   * Purpose: Download a single archive containing DSP files from all sessions.
   * How: Stages each session DSP file under a temporary folder, creates a `tar.gz`, and streams it as a download.
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

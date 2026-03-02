import { Request, Response, Router } from 'express';
import { SessionManager, Session } from '../sessions';

interface RegisterSessionArtifactRoutesOptions {
  router: Router;
  sessionManager: SessionManager;
  requireSession: (sha: string, res: Response) => Session | null;
  clearSessionArtifacts: (sessionPath: string) => void;
  analyzeFaust: (sessionPath: string, filename: string) => Promise<{ success: boolean; errors: string }>;
  markUsed: (sha1: string | null | undefined, weight?: number) => void;
}

/**
 * Purpose: Register routes that refresh, read, and delete session artifacts.
 * How: Mounts session-scoped endpoints for regeneration, file retrieval, SVG listing/serving, DOT retrieval, and deletion.
 */
export function registerSessionArtifactRoutes({
  router,
  sessionManager,
  requireSession,
  clearSessionArtifacts,
  analyzeFaust,
  markUsed
}: RegisterSessionArtifactRoutesOptions): void {
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
}

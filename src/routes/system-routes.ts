import { Request, Response, Router } from 'express';

interface RegisterSystemRoutesOptions {
  router: Router;
  appVersion: string;
  getFaustVersion: () => Promise<string>;
  getFaustHelp: () => Promise<string>;
}

/**
 * Purpose: Register system-information routes.
 * How: Mounts endpoints for Faust compiler version/help and application version.
 */
export function registerSystemRoutes({
  router,
  appVersion,
  getFaustVersion,
  getFaustHelp
}: RegisterSystemRoutesOptions): void {
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
}

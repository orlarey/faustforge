import express, { Application } from 'express';
import * as path from 'path';
import { SessionManager } from './sessions';
import { createApiRouter } from './routes/api';
import { StateStore } from './state';
import { LiveWorkspaceSync, readLiveWorkspaceConfigFromEnv } from './live-workspace';

export interface ServerConfig {
  port: number;
  sessionsDir: string;
  publicDir: string;
  maxSessions?: number;
}

/**
 * Purpose: Build and configure the Express application used by faustforge.
 * How: Instantiates shared services, mounts API routes, starts live workspace sync, and serves static frontend assets.
 */
export function createServer(config: ServerConfig): Application {
  const app = express();

  // Parse JSON request payloads for API endpoints.
  app.use(express.json({ limit: '1mb' }));

  // Create the session manager responsible for persistent session storage.
  const sessionManager = new SessionManager(
    config.sessionsDir,
    config.maxSessions ?? 0
  );

  // Create shared state storage for current session/view data.
  const stateStore = new StateStore(config.sessionsDir);

  // Mount API routes.
  const apiRouter = createApiRouter(sessionManager, stateStore);
  app.use('/api', apiRouter);

  // Optionally auto-discover live sessions from a mounted workspace directory.
  const liveConfig = readLiveWorkspaceConfigFromEnv();
  const liveSync = new LiveWorkspaceSync(sessionManager, stateStore, liveConfig);
  liveSync.start();

  // Serve frontend static assets.
  app.use(express.static(config.publicDir));

  // Fallback root route for SPA bootstrap.
  app.get('/', (_req, res) => {
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  return app;
}

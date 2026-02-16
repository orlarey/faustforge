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

export function createServer(config: ServerConfig): Application {
  const app = express();

  // Middleware pour parser le JSON
  app.use(express.json({ limit: '1mb' }));

  // Créer le gestionnaire de sessions
  const sessionManager = new SessionManager(
    config.sessionsDir,
    config.maxSessions ?? 50
  );

  // Store d'état partagé (session/vue)
  const stateStore = new StateStore(config.sessionsDir);

  // Monter les routes API
  const apiRouter = createApiRouter(sessionManager, stateStore);
  app.use('/api', apiRouter);

  // Optionnel: découverte auto des sessions live dans un workspace monté.
  const liveConfig = readLiveWorkspaceConfigFromEnv();
  const liveSync = new LiveWorkspaceSync(sessionManager, stateStore, liveConfig);
  liveSync.start();

  // Servir les fichiers statiques (frontend)
  app.use(express.static(config.publicDir));

  // Route par défaut : servir index.html pour le SPA
  app.get('/', (_req, res) => {
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  return app;
}

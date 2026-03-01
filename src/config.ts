import * as path from 'path';

/**
 * Purpose: Centralize environment configuration with stable defaults.
 * How: Reads all process environment variables once and exports a frozen object consumed by runtime modules.
 */
export const CONFIG = Object.freeze({
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  sessionsDir: process.env.SESSIONS_DIR || path.join(__dirname, '..', 'sessions'),
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'),
  maxSessionsRaw: process.env.MAX_SESSIONS,
  liveAutoDiscover: process.env.LIVE_AUTO_DISCOVER === '1',
  liveWorkspaceRoot: process.env.LIVE_WORKSPACE_ROOT || '/workspace',
  liveScanIntervalMsRaw: process.env.LIVE_SCAN_INTERVAL_MS,
  liveIgnoreDirsRaw: process.env.LIVE_IGNORE_DIRS || '',
  hostLiveWorkspaceRoot: process.env.HOST_LIVE_WORKSPACE_ROOT || '',
  hostSessionsDir: process.env.HOST_SESSIONS_DIR || ''
});

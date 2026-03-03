import { Router, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from '../sessions';
import { StateStore } from '../state';
import { CONFIG } from '../config';
import {
  analyzeFaust,
  getFaustVersion,
  getFaustHelp
} from '../docker';
import { registerCompileDownloadRoutes } from './compile-download-routes';
import { registerRunStateRoutes } from './run-state-routes';
import { registerSessionArtifactRoutes } from './session-artifact-routes';
import { registerSessionLifecycleRoutes } from './session-lifecycle-routes';
import { registerSystemRoutes } from './system-routes';
import { registerAppStateRoutes } from './app-state-routes';
import {
  toFiniteNumber,
  normalizeRunParamMap,
  getRunParamMap,
  toRunParamValues,
  mergeRunParamMaps
} from './shared/run-param-utils';
import { createArchiveHelpers } from './shared/archive-utils';
import {
  isLiveSessionId,
  sanitizeEditableFilename,
  getSessionBaseFilename,
  chooseEditableFilename,
  buildEditorUrl
} from './shared/session-file-utils';

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
  const { tarGzDirectory, tarGzFromDirectory } = createArchiveHelpers();

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


  registerSessionLifecycleRoutes({
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
  });
  registerSystemRoutes({
    router,
    appVersion,
    getFaustVersion,
    getFaustHelp
  });
  registerAppStateRoutes({
    router,
    stateStore,
    sessionManager,
    markUsed,
    getRunParamMap,
    normalizeRunParamMap,
    mergeRunParamMaps
  });

  registerRunStateRoutes({
    router,
    stateStore,
    markUsed,
    toFiniteNumber,
    getRunParamMap,
    toRunParamValues,
    mergeRunParamMaps
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
  registerSessionArtifactRoutes({
    router,
    sessionManager,
    requireSession,
    clearSessionArtifacts,
    analyzeFaust,
    markUsed
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

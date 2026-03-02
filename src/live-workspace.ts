import * as fs from 'fs';
import * as path from 'path';
import { analyzeFaust } from './docker';
import { SessionManager } from './sessions';
import { StateStore } from './state';
import { CONFIG } from './config';

export interface LiveWorkspaceConfig {
  enabled: boolean;
  rootDir: string;
  scanIntervalMs: number;
  ignoreDirs: string[];
}

const DEFAULT_IGNORES = ['.git', 'node_modules', '.next', 'dist', 'build', '.cache'];

/**
 * Purpose: Parse the ignore directory list used by live workspace scanning.
 * How: Splits the raw comma-separated value, trims entries, and falls back to defaults when empty.
 */
function parseIgnoreDirs(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return DEFAULT_IGNORES;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Purpose: Build live workspace synchronization configuration from environment settings.
 * How: Reads centralized config values, normalizes interval bounds, and resolves ignore directory rules.
 */
export function readLiveWorkspaceConfigFromEnv(): LiveWorkspaceConfig {
  const enabled = CONFIG.liveAutoDiscover;
  const rootDir = CONFIG.liveWorkspaceRoot || '/workspace';
  const scanIntervalMsRaw = CONFIG.liveScanIntervalMsRaw;
  const scanIntervalMs = Number.isFinite(Number(scanIntervalMsRaw))
    ? Math.max(500, Math.round(Number(scanIntervalMsRaw)))
    : 1500;
  const ignoreDirs = parseIgnoreDirs(CONFIG.liveIgnoreDirsRaw);
  return {
    enabled,
    rootDir,
    scanIntervalMs,
    ignoreDirs
  };
}

/**
 * Purpose: Enumerate all DSP source files under the configured live workspace root.
 * How: Recursively walks the directory tree, skips ignored folder names, and collects sorted `.dsp` file paths.
 */
async function walkDspFiles(rootDir: string, ignoreDirs: Set<string>): Promise<string[]> {
  const out: string[] = [];

  /**
   * Purpose: Visit one directory branch during recursive DSP discovery.
   * How: Reads entries, recurses into non-ignored subdirectories, and records `.dsp` files.
   */
  async function visit(dir: string): Promise<void> {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.dsp')) {
        out.push(fullPath);
      }
    }
  }

  await visit(rootDir);
  out.sort();
  return out;
}

/**
 * Purpose: Detect whether a live source file is currently an empty draft.
 * How: Reads file content and checks whether trimmed text length is zero.
 */
function isBlankSourceFile(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * Purpose: Keep live sessions synchronized with files discovered in a workspace folder.
 * How: Periodically scans DSP files, creates or refreshes live sessions, runs analysis when needed, and updates active state.
 */
export class LiveWorkspaceSync {
  private readonly sessionManager: SessionManager;
  private readonly stateStore: StateStore;
  private readonly config: LiveWorkspaceConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(sessionManager: SessionManager, stateStore: StateStore, config: LiveWorkspaceConfig) {
    this.sessionManager = sessionManager;
    this.stateStore = stateStore;
    this.config = config;
  }

  /**
   * Purpose: Start periodic live workspace synchronization.
   * How: Validates runtime preconditions, triggers an immediate scan, then schedules repeated scans with `setInterval`.
   */
  start(): void {
    if (!this.config.enabled) return;
    if (!fs.existsSync(this.config.rootDir)) {
      console.warn(`[live] workspace root not found: ${this.config.rootDir}`);
      return;
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.scanIntervalMs);
    console.log(`[live] auto-discover enabled on ${this.config.rootDir} (every ${this.config.scanIntervalMs}ms)`);
  }

  /**
   * Purpose: Stop periodic live workspace synchronization.
   * How: Clears the active interval timer and resets its handle.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Purpose: Execute one scan-and-sync cycle for live workspace sessions.
   * How: Discovers DSP files, updates changed sessions, runs analysis for non-empty files, and activates the newest changed session.
   */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const ignore = new Set(this.config.ignoreDirs);
      const dspFiles = await walkDspFiles(this.config.rootDir, ignore);
      let newestChanged: { sha1: string; filename: string; mtimeMs: number } | null = null;
      for (const filePath of dspFiles) {
        try {
          const ensured = this.sessionManager.ensureLiveSessionFromFile(filePath);
          if (!ensured.changed) continue;
          if (isBlankSourceFile(filePath)) {
            // Draft live session: keep the session visible/active but avoid immediate
            // compiler errors while the user has just created an empty file.
            this.sessionManager.setErrors(ensured.session.sha1, '');
          } else {
            const result = await analyzeFaust(ensured.session.path, ensured.session.filename);
            this.sessionManager.setErrors(ensured.session.sha1, result.errors || '');
          }
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(filePath).mtimeMs;
          } catch {
            mtimeMs = Date.now();
          }
          if (!newestChanged || mtimeMs >= newestChanged.mtimeMs) {
            newestChanged = {
              sha1: ensured.session.sha1,
              filename: ensured.session.filename,
              mtimeMs
            };
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[live] failed for ${filePath}: ${message}`);
        }
      }
      if (newestChanged) {
        // Mimic a user drop/open: make the most recently changed DSP the active session.
        this.stateStore.update({
          sha1: newestChanged.sha1,
          filename: newestChanged.filename
        });
      }
    } finally {
      this.running = false;
    }
  }
}

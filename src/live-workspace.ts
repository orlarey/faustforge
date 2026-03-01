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

function parseIgnoreDirs(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return DEFAULT_IGNORES;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

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

async function walkDspFiles(rootDir: string, ignoreDirs: Set<string>): Promise<string[]> {
  const out: string[] = [];

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

function isBlankSourceFile(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim().length === 0;
  } catch {
    return false;
  }
}

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

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

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

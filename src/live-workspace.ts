import * as fs from 'fs';
import * as path from 'path';
import { analyzeFaust } from './docker';
import { SessionManager } from './sessions';
import { StateStore } from './state';

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
  const enabled = process.env.LIVE_AUTO_DISCOVER === '1';
  const rootDir = process.env.LIVE_WORKSPACE_ROOT || '/workspace';
  const scanIntervalMsRaw = process.env.LIVE_SCAN_INTERVAL_MS;
  const scanIntervalMs = Number.isFinite(Number(scanIntervalMsRaw))
    ? Math.max(500, Math.round(Number(scanIntervalMsRaw)))
    : 1500;
  const ignoreDirs = parseIgnoreDirs(process.env.LIVE_IGNORE_DIRS);
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
      let newestDiscovered: { sha1: string; filename: string; mtimeMs: number } | null = null;
      for (const filePath of dspFiles) {
        try {
          const ensured = this.sessionManager.ensureLiveSessionFromFile(filePath);
          if (!ensured.changed) continue;
          const result = await analyzeFaust(ensured.session.path, ensured.session.filename);
          this.sessionManager.setErrors(ensured.session.sha1, result.errors || '');
          if (ensured.isNew) {
            let mtimeMs = 0;
            try {
              mtimeMs = fs.statSync(filePath).mtimeMs;
            } catch {
              mtimeMs = Date.now();
            }
            if (!newestDiscovered || mtimeMs >= newestDiscovered.mtimeMs) {
              newestDiscovered = {
                sha1: ensured.session.sha1,
                filename: ensured.session.filename,
                mtimeMs
              };
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[live] failed for ${filePath}: ${message}`);
        }
      }
      if (newestDiscovered) {
        // Mimic a user drop/open: make the newest discovered DSP the active session.
        this.stateStore.update({
          sha1: newestDiscovered.sha1,
          filename: newestDiscovered.filename
        });
      }
    } finally {
      this.running = false;
    }
  }
}

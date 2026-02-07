import * as fs from 'fs';
import * as path from 'path';

export type View = 'dsp' | 'cpp' | 'svg' | 'run';

export interface AppState {
  sha1: string | null;
  filename: string | null;
  view: View;
  ui?: unknown;
  runParams?: Record<string, number>;
  runTransport?: {
    action: 'start' | 'stop' | 'toggle';
    nonce: number;
  };
  runTrigger?: {
    path: string;
    holdMs: number;
    nonce: number;
  };
  spectrum?: {
    capturedAt?: number;
    scale: 'log' | 'linear';
    fftSize: number;
    sampleRate: number;
    fmin: number;
    fmax: number;
    floorDb: number;
    data: number[];
  };
  updatedAt: number;
}

export class StateStore {
  private statePath: string;

  constructor(sessionsDir: string) {
    this.statePath = path.join(sessionsDir, '.state.json');
  }

  read(): AppState {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as AppState;
      if (!parsed.view) {
        parsed.view = 'dsp';
      }
      if (!parsed.updatedAt) {
        parsed.updatedAt = Date.now();
      }
      return parsed;
    } catch {
      return {
        sha1: null,
        filename: null,
        view: 'dsp',
        updatedAt: Date.now()
      };
    }
  }

  write(state: AppState): void {
    const next: AppState = {
      sha1: state.sha1 ?? null,
      filename: state.filename ?? null,
      view: state.view ?? 'dsp',
      ui: state.ui,
      runParams: state.runParams,
      runTransport: state.runTransport,
      runTrigger: state.runTrigger,
      spectrum: state.spectrum,
      updatedAt: Date.now()
    };
    fs.writeFileSync(this.statePath, JSON.stringify(next, null, 2), 'utf8');
  }

  update(partial: Partial<AppState>): AppState {
    const current = this.read();
    const next: AppState = {
      ...current,
      ...partial,
      updatedAt: Date.now()
    };
    this.write(next);
    return next;
  }
}

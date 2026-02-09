import * as fs from 'fs';
import * as path from 'path';

export type View = 'dsp' | 'cpp' | 'svg' | 'run' | 'signals' | 'tasks';

export interface SpectrumSummaryPeak {
  hz: number;
  dbQ: number;
  q: number;
}

export interface SpectrumSummaryFeatures {
  rmsDbQ: number;
  centroidHz: number;
  rolloff95Hz: number;
  flatnessQ: number;
  crestDbQ: number;
}

export interface SpectrumSummaryDelta {
  rmsDbQ: number;
  centroidHz: number;
  rolloff95Hz: number;
  flatnessQ: number;
  crestDbQ: number;
}

export interface SpectrumAudioQuality {
  peakDbFSQ: number;
  clipSampleCount: number;
  clipRatioQ: number;
  dcOffsetQ: number;
  clickCount: number;
  clickScoreQ: number;
}

export interface SpectrumSummary {
  type: 'spectrum_summary_v1';
  capturedAt: number;
  frame: {
    sampleRate: number;
    fftSize: number;
    fmin: number;
    fmax: number;
    floorDb: number;
    bandsCount: number;
  };
  bandsDbQ: number[];
  peaks: SpectrumSummaryPeak[];
  features: SpectrumSummaryFeatures;
  audioQuality?: SpectrumAudioQuality;
  delta?: SpectrumSummaryDelta;
}

export interface AppState {
  sha1: string | null;
  filename: string | null;
  view: View;
  audioUnlocked?: boolean;
  ui?: unknown;
  runParams?: Record<string, number>;
  runParamsUpdatedAt?: number;
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
  spectrumSummary?: SpectrumSummary;
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
      if (parsed.audioUnlocked !== true) {
        parsed.audioUnlocked = false;
      }
      return parsed;
    } catch {
      return {
        sha1: null,
        filename: null,
        view: 'dsp',
        audioUnlocked: false,
        updatedAt: Date.now()
      };
    }
  }

  write(state: AppState): void {
    const next: AppState = {
      sha1: state.sha1 ?? null,
      filename: state.filename ?? null,
      view: state.view ?? 'dsp',
      audioUnlocked: state.audioUnlocked === true,
      ui: state.ui,
      runParams: state.runParams,
      runParamsUpdatedAt: state.runParamsUpdatedAt,
      runTransport: state.runTransport,
      runTrigger: state.runTrigger,
      spectrum: state.spectrum,
      spectrumSummary: state.spectrumSummary,
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

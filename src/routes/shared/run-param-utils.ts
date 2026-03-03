import { AppState, RunParamCell } from '../../state';

export type RunParamMap = Record<string, RunParamCell>;

/**
 * Purpose: Normalize numeric inputs used by run-state arbitration helpers.
 * How: Accepts finite numbers only and returns `null` for invalid values.
 */
export function toFiniteNumber(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input)) return null;
  return input;
}

/**
 * Purpose: Normalize one incoming run-parameter cell payload.
 * How: Supports legacy numeric values, validates structured cell fields, and applies timestamp defaults.
 */
export function normalizeRunParamCell(input: unknown, fallbackTs: number): RunParamCell | null {
  // Backward compatibility: accept legacy numeric payloads and upgrade to cells.
  if (typeof input === 'number' && Number.isFinite(input)) {
    return { v: input, d: fallbackTs, owner: null };
  }
  if (!input || typeof input !== 'object') return null;
  const obj = input as { v?: unknown; d?: unknown };
  const value = toFiniteNumber(obj.v);
  if (value === null) return null;
  const d = toFiniteNumber(obj.d);
  return {
    v: value,
    d: d === null ? fallbackTs : d,
    // Ownerless backend model: ownership metadata is intentionally ignored.
    owner: null
  };
}

/**
 * Purpose: Normalize a run-parameter map payload into safe canonical cells.
 * How: Iterates object entries, normalizes each cell, and drops malformed paths or values.
 */
export function normalizeRunParamMap(input: unknown, fallbackTs: number): RunParamMap {
  // Defensive normalization: malformed entries are dropped, never partially trusted.
  const map: RunParamMap = {};
  if (!input || typeof input !== 'object') return map;
  for (const [path, rawCell] of Object.entries(input as Record<string, unknown>)) {
    if (!path) continue;
    const cell = normalizeRunParamCell(rawCell, fallbackTs);
    if (!cell) continue;
    map[path] = cell;
  }
  return map;
}

/**
 * Purpose: Read canonical run-parameter cells from persisted app state.
 * How: Re-normalizes stored `runParams` through the safe map normalizer.
 */
export function getRunParamMap(state: AppState): RunParamMap {
  return normalizeRunParamMap(state.runParams || {}, 0);
}

/**
 * Purpose: Extract scalar parameter values from canonical run cells.
 * How: Builds a flat `{ path: value }` object from each cell's `v` field.
 */
export function toRunParamValues(params: RunParamMap): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [path, cell] of Object.entries(params)) {
    values[path] = cell.v;
  }
  return values;
}

/**
 * Purpose: Merge two run-parameter maps with freshness arbitration.
 * How: Applies per-path timestamp ordering and keeps the most recent cell (last-write on equal timestamp).
 */
export function mergeRunParamMaps(current: RunParamMap, incoming: RunParamMap): RunParamMap {
  const merged: RunParamMap = { ...current };
  for (const [path, incomingCell] of Object.entries(incoming)) {
    const existing = merged[path];
    if (!existing) {
      merged[path] = {
        v: incomingCell.v,
        d: incomingCell.d,
        owner: null
      };
      continue;
    }
    // Reject strictly older cells, accept equal timestamps (last POST received wins per-path).
    if (incomingCell.d < existing.d) {
      continue;
    }
    merged[path] = {
      v: incomingCell.v,
      d: incomingCell.d,
      owner: null
    };
  }
  return merged;
}

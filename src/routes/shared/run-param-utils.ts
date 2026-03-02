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
 * Purpose: Normalize lock-owner identifiers for run parameters.
 * How: Converts `undefined`/`null` consistently and trims non-empty owner strings.
 */
export function normalizeOwner(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

/**
 * Purpose: Normalize one incoming run-parameter cell payload.
 * How: Supports legacy numeric values, validates structured cell fields, and applies timestamp/owner defaults.
 */
export function normalizeRunParamCell(input: unknown, fallbackTs: number): RunParamCell | null {
  // Backward compatibility: accept legacy numeric payloads and upgrade to cells.
  if (typeof input === 'number' && Number.isFinite(input)) {
    return { v: input, d: fallbackTs, owner: null };
  }
  if (!input || typeof input !== 'object') return null;
  const obj = input as { v?: unknown; d?: unknown; owner?: unknown };
  const value = toFiniteNumber(obj.v);
  if (value === null) return null;
  const d = toFiniteNumber(obj.d);
  const owner = normalizeOwner(obj.owner);
  return {
    v: value,
    d: d === null ? fallbackTs : d,
    owner: owner === undefined ? null : owner
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
 * Purpose: Merge two run-parameter maps with ownership and freshness arbitration.
 * How: Applies lock checks, timestamp ordering, and explicit owner transition rules per parameter path.
 */
export function mergeRunParamMaps(current: RunParamMap, incoming: RunParamMap, writer: string | null): RunParamMap {
  // Per-param arbitration rules:
  // 1) lock ownership: writer must own lock (or lock must be free),
  // 2) freshness: incoming timestamp must be >= current timestamp,
  // 3) lock transitions are explicit via incoming `owner`.
  const merged: RunParamMap = { ...current };
  for (const [path, incomingCell] of Object.entries(incoming)) {
    const existing = merged[path];
    if (!existing) {
      merged[path] = {
        v: incomingCell.v,
        d: incomingCell.d,
        owner: incomingCell.owner ?? null
      };
      continue;
    }
    const existingOwner = normalizeOwner(existing.owner) ?? null;
    const writerOwnsLock = !!writer && existingOwner === writer;
    if (existingOwner && !writerOwnsLock) {
      continue;
    }
    if (incomingCell.d < existing.d) {
      continue;
    }

    let nextOwner = existingOwner;
    const requestedOwner = normalizeOwner(incomingCell.owner);
    if (requestedOwner !== undefined) {
      if (requestedOwner === null) {
        nextOwner = writerOwnsLock || !existingOwner ? null : existingOwner;
      } else if (!existingOwner || writerOwnsLock || existingOwner === requestedOwner) {
        nextOwner = requestedOwner;
      }
    }

    merged[path] = {
      v: incomingCell.v,
      d: incomingCell.d,
      owner: nextOwner
    };
  }
  return merged;
}

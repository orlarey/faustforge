/**
 * Purpose: Normalize one run-parameter owner value into the shared ParamCell shape.
 * How: Converts null/empty/invalid owner payloads to `null` and keeps trimmed non-empty strings.
 */
function normalizeParamOwner(ownerRaw) {
  if (ownerRaw === null) return null;
  if (typeof ownerRaw === 'string' && ownerRaw.trim()) return ownerRaw.trim();
  return null;
}

/**
 * Purpose: Normalize one run parameter cell payload before local/remote merge.
 * How: Accepts legacy numeric values, validates `{ v, d, owner }` objects, and applies timestamp fallback for missing `d`.
 */
export function normalizeRunParamCell(path, input, fallbackTs = Date.now()) {
  if (!path) return null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return { v: input, d: fallbackTs, owner: null };
  }
  if (!input || typeof input !== 'object') return null;
  const v = Number(input.v);
  if (!Number.isFinite(v)) return null;
  const dRaw = Number(input.d);
  const d = Number.isFinite(dRaw) ? dRaw : fallbackTs;
  const owner = normalizeParamOwner(input.owner);
  return { v, d, owner };
}

/**
 * Purpose: Normalize a full run-parameter map into valid ParamCell entries.
 * How: Iterates object entries, normalizes each cell independently, and drops invalid paths/cells.
 */
export function normalizeRunParamCells(input, fallbackTs = Date.now()) {
  const cells = {};
  if (!input || typeof input !== 'object') return cells;
  for (const [path, value] of Object.entries(input)) {
    const cell = normalizeRunParamCell(path, value, fallbackTs);
    if (!cell) continue;
    cells[path] = cell;
  }
  return cells;
}

/**
 * Purpose: Clone a run-parameter cell map without preserving source object references.
 * How: Rebuilds every cell with primitive copies of `{ v, d, owner }`.
 */
export function cloneParamCells(input) {
  const output = {};
  for (const [path, cell] of Object.entries(input || {})) {
    output[path] = { v: cell.v, d: cell.d, owner: cell.owner ?? null };
  }
  return output;
}

/**
 * Purpose: Produce a deterministic fingerprint for semantic run-parameter comparisons.
 * How: Normalizes cells, sorts by path, and concatenates value/timestamp/owner tuples into one stable string.
 */
export function fingerprintRunParams(input) {
  const cells = normalizeRunParamCells(input, 0);
  const entries = Object.entries(cells)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, cell]) => `${path}:${Number(cell.v)}:${Number(cell.d)}:${cell.owner || ''}`);
  return entries.join('|');
}

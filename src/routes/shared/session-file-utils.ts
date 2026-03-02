import * as fs from 'fs';
import * as path from 'path';

/**
 * Purpose: Identify whether a session ID refers to a live session.
 * How: Matches IDs against the `live-<sha1>` format.
 */
export function isLiveSessionId(id: string): boolean {
  return /^live-[0-9a-f]{40}$/.test(id);
}

/**
 * Purpose: Produce a safe editable filename for workspace export.
 * How: Keeps basename only, replaces unsafe characters, and enforces `.dsp` extension.
 */
export function sanitizeEditableFilename(input: string): string {
  const base = path.basename(String(input || 'session.dsp'));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (cleaned.toLowerCase().endsWith('.dsp')) {
    return cleaned;
  }
  return `${cleaned}.dsp`;
}

/**
 * Purpose: Split a filename into sanitized base name and extension.
 * How: Uses `path.extname/basename` with `.dsp` and `session` fallbacks.
 */
export function splitBaseAndExt(filename: string): { base: string; ext: string } {
  const ext = path.extname(filename) || '.dsp';
  const base = path.basename(filename, ext) || 'session';
  return { base, ext };
}

/**
 * Purpose: Resolve the stable base name used for derived artifact filenames.
 * How: Returns the base component from the filename split helper with a safety fallback.
 */
export function getSessionBaseFilename(filename: string): string {
  return splitBaseAndExt(filename).base || 'session';
}

/**
 * Purpose: Choose a deterministic editable filename in workspace root without collisions.
 * How: Reuses matching-content files when possible or appends incrementing numeric suffixes.
 */
export function chooseEditableFilename(targetDir: string, preferredFilename: string, sourceContent: Buffer): string {
  const safePreferred = sanitizeEditableFilename(preferredFilename);
  const { base, ext } = splitBaseAndExt(safePreferred);
  const directPath = path.join(targetDir, safePreferred);
  if (!fs.existsSync(directPath)) {
    return safePreferred;
  }
  try {
    const existing = fs.readFileSync(directPath);
    if (Buffer.compare(existing, sourceContent) === 0) {
      return safePreferred;
    }
  } catch {
    // Ignore read errors and fallback to unique suffix strategy.
  }

  let n = 1;
  while (true) {
    const candidate = `${base}-${n}${ext}`;
    const candidatePath = path.join(targetDir, candidate);
    if (!fs.existsSync(candidatePath)) {
      return candidate;
    }
    try {
      const existing = fs.readFileSync(candidatePath);
      if (Buffer.compare(existing, sourceContent) === 0) {
        return candidate;
      }
    } catch {
      // ignore and continue
    }
    n += 1;
  }
}

/**
 * Purpose: Build editor deep-link URLs for host-side file opening.
 * How: Currently supports VS Code via `vscode://file/...` URLs from normalized host paths.
 */
export function buildEditorUrl(editor: string, hostPath: string): string | null {
  if (editor !== 'vscode') return null;
  const normalized = hostPath.replace(/\\/g, '/');
  return `vscode://file/${encodeURI(normalized)}`;
}

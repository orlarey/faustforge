import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface SessionMeta {
  sha1: string;
  kind?: 'static' | 'live';
  live_draft?: boolean;
  source_path?: string;
  source_mtime_ms?: number;
  content_sha1?: string;
  filename: string;
  compilation_time: number;
  last_used_time?: number;
  usage_score?: number;
  cpp_flags?: string;
}

export interface Session {
  sha1: string;
  filename: string;
  path: string;
}

export interface SessionSummary {
  sha1: string;
  kind: 'static' | 'live';
  live_draft?: boolean;
  filename: string;
  compilation_time: number;
  last_used_time?: number;
  usage_score?: number;
  source_path?: string;
  source_mtime_ms?: number;
  content_sha1?: string;
}

/**
 * Purpose: Manage persistent Faust sessions and their metadata lifecycle.
 * How: Creates/updates session directories, tracks ordering metadata, and exposes helpers for reads, writes, and live-session sync.
 */
export class SessionManager {
  private sessionsDir: string;
  private maxSessions: number;
  private lruOrder: string[] = []; // Access order, most recent at the end.
  private creationOrder: string[] = []; // Creation order, oldest at the beginning.

  constructor(sessionsDir: string, maxSessions: number = 0) {
    this.sessionsDir = sessionsDir;
    this.maxSessions = Number.isFinite(maxSessions) && maxSessions > 0 ? maxSessions : 0;

    // Ensure sessions directory exists.
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    // Migration: align legacy live sessions with current draft semantics.
    this.migrateLiveDraftMetadata();

    // Load previously persisted sessions.
    this.loadExistingSessions();
  }

  /**
   * Purpose: Detect whether a source text should be treated as a draft.
   * How: Returns true when trimmed content is empty.
   */
  private isBlankText(content: string): boolean {
    return content.trim().length === 0;
  }

  /**
   * Read and parse one session metadata file.
   * Returns null when file is missing or malformed.
   */
  private readMetadata(metadataPath: string): SessionMeta | null {
    try {
      return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as SessionMeta;
    } catch {
      return null;
    }
  }

  /**
   * Recompute `live_draft` for all existing live sessions.
   * This keeps old metadata consistent with the current "empty file => draft" rule.
   */
  private migrateLiveDraftMetadata(): void {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !this.isValidSessionId(entry.name)) continue;
      const metadataPath = path.join(this.sessionsDir, entry.name, 'metadata.json');
      if (!fs.existsSync(metadataPath)) continue;

      try {
        const metadata = this.readMetadata(metadataPath);
        if (!metadata) continue;
        if (metadata.kind !== 'live') continue;

        let sourceContent = '';
        if (metadata.source_path && fs.existsSync(metadata.source_path)) {
          sourceContent = fs.readFileSync(metadata.source_path, 'utf8');
        } else {
          const fallbackSource = path.join(this.sessionsDir, entry.name, 'user_code.dsp');
          if (fs.existsSync(fallbackSource)) {
            sourceContent = fs.readFileSync(fallbackSource, 'utf8');
          }
        }

        const shouldBeDraft = this.isBlankText(sourceContent);
        const hasChanged = metadata.live_draft !== shouldBeDraft;
        if (!hasChanged) continue;

        metadata.live_draft = shouldBeDraft;
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

        if (shouldBeDraft) {
          const errorsPath = path.join(this.sessionsDir, entry.name, 'errors.log');
          try {
            fs.writeFileSync(errorsPath, '', 'utf8');
          } catch {
            // ignore cleanup failures
          }
        }
      } catch {
        // Ignore malformed metadata entries.
      }
    }
  }

  /**
   * Purpose: Normalize one metadata object into a stable session summary shape.
   * How: Applies fallback values for optional time/score fields and copies shared metadata fields.
   */
  private toSessionSummary(sessionId: string, metadata: SessionMeta): SessionSummary {
    return {
      sha1:
        typeof metadata.sha1 === 'string' && metadata.sha1
          ? metadata.sha1
          : sessionId,
      kind: metadata.kind === 'live' ? 'live' : 'static',
      live_draft: metadata.live_draft === true,
      filename: metadata.filename,
      compilation_time: metadata.compilation_time,
      last_used_time:
        typeof metadata.last_used_time === 'number' && Number.isFinite(metadata.last_used_time)
          ? metadata.last_used_time
          : metadata.compilation_time,
      usage_score:
        typeof metadata.usage_score === 'number' && Number.isFinite(metadata.usage_score)
          ? metadata.usage_score
          : 0,
      source_path: metadata.source_path,
      source_mtime_ms: metadata.source_mtime_ms,
      content_sha1: metadata.content_sha1
    };
  }

  /**
   * Purpose: Apply an optional result limit consistently across sorted summary lists.
   * How: Chooses head or tail slice semantics based on list intent and returns full list when limit is absent.
   */
  private applySummaryLimit(
    summaries: SessionSummary[],
    limit: number | undefined,
    mode: 'head' | 'tail'
  ): SessionSummary[] {
    if (!limit || limit <= 0) return summaries;
    return mode === 'head' ? summaries.slice(0, limit) : summaries.slice(-limit);
  }

  /**
   * Purpose: Reload current session IDs and ordering information from disk.
   * How: Scans session folders, parses metadata summaries, then rebuilds creation and fallback LRU order arrays.
   */
  private loadExistingSessions(): void {
    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
      const summaries: SessionSummary[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && this.isValidSessionId(entry.name)) {
          const metadataPath = path.join(this.sessionsDir, entry.name, 'metadata.json');
          try {
            const metadata = this.readMetadata(metadataPath);
            if (!metadata) continue;
            const kind: 'static' | 'live' = metadata.kind === 'live' ? 'live' : 'static';
            const id = typeof metadata.sha1 === 'string' && metadata.sha1 ? metadata.sha1 : entry.name;
            if (!this.isValidSessionId(id)) {
              continue;
            }
            const summary = this.toSessionSummary(id, metadata);
            summaries.push({ ...summary, kind });
          } catch {
            // Ignore malformed sessions.
          }
        }
      }
      summaries.sort((a, b) => a.compilation_time - b.compilation_time);
      this.creationOrder = summaries.map(s => s.sha1);
      // LRU fallback follows scan/creation order.
      this.lruOrder = this.creationOrder.slice();
    } catch {
      // Ignore empty directory or read errors.
    }
  }

  /**
   * Purpose: Refresh in-memory session indexes from persisted storage.
   * How: Re-runs full on-disk session discovery.
   */
  refreshSessions(): void {
    this.loadExistingSessions();
  }

  /**
   * Purpose: Validate canonical static session IDs.
   * How: Checks whether the string matches a 40-character lowercase hex SHA-1 pattern.
   */
  private isValidSha1(str: string): boolean {
    return /^[0-9a-f]{40}$/.test(str);
  }

  /**
   * Purpose: Validate canonical live session IDs.
   * How: Checks whether the string matches the `live-<sha1>` identifier format.
   */
  private isValidLiveId(str: string): boolean {
    return /^live-[0-9a-f]{40}$/.test(str);
  }

  /**
   * Purpose: Validate any supported session identifier.
   * How: Accepts both static SHA-1 IDs and `live-<sha1>` IDs.
   */
  private isValidSessionId(str: string): boolean {
    return this.isValidSha1(str) || this.isValidLiveId(str);
  }

  /**
   * Purpose: Create deterministic content hashes for session identity and change detection.
   * How: Computes SHA-1 over UTF-8 encoded source text.
   */
  computeSha1(code: string): string {
    return crypto.createHash('sha1').update(code, 'utf8').digest('hex');
  }

  /**
   * Purpose: Check whether a session directory exists.
   * How: Tests presence of `<sessionsDir>/<sha1>` on disk.
   */
  exists(sha1: string): boolean {
    return fs.existsSync(path.join(this.sessionsDir, sha1));
  }

  /**
   * Purpose: Resolve absolute path for one session directory.
   * How: Joins base sessions directory with session ID.
   */
  getSessionPath(sha1: string): string {
    return path.join(this.sessionsDir, sha1);
  }

  /**
   * Purpose: Mark one session as recently accessed in LRU order.
   * How: Removes any existing entry and appends session ID to the end of the LRU list.
   */
  touch(sha1: string): void {
    const index = this.lruOrder.indexOf(sha1);
    if (index !== -1) {
      this.lruOrder.splice(index, 1);
    }
    this.lruOrder.push(sha1);
  }

  /**
   * Purpose: Enforce optional maximum session count.
   * How: Removes least-recently-used sessions until size is within configured limit.
   */
  private evict(): void {
    if (!this.maxSessions || this.maxSessions <= 0) {
      return;
    }
    while (this.lruOrder.length > this.maxSessions) {
      const oldest = this.lruOrder.shift();
      if (oldest) {
        const sessionPath = path.join(this.sessionsDir, oldest);
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch {
          // Ignore deletion failures.
        }
        const creationIndex = this.creationOrder.indexOf(oldest);
        if (creationIndex !== -1) {
          this.creationOrder.splice(creationIndex, 1);
        }
      }
    }
  }

  /**
   * Purpose: Create a new static session from submitted DSP code.
   * How: Builds session folder structure, writes source/metadata files, updates order indexes, and applies optional eviction.
   */
  createSession(code: string, filename: string): Session {
    const sha1 = this.computeSha1(code);
    const sessionPath = path.join(this.sessionsDir, sha1);

    // If session already exists, only refresh access order.
    if (this.exists(sha1)) {
      this.touch(sha1);
      return { sha1, filename, path: sessionPath };
    }

    // Create session folder structure.
    const sourcecodePath = path.join(sessionPath, 'sourcecode');
    fs.mkdirSync(sourcecodePath, { recursive: true });

    // Write source file in sourcecode/.
    fs.writeFileSync(path.join(sourcecodePath, filename), code, 'utf8');

    // Write standardized `user_code.dsp` copy.
    fs.writeFileSync(path.join(sessionPath, 'user_code.dsp'), code, 'utf8');

    // Initialize empty errors.log.
    fs.writeFileSync(path.join(sessionPath, 'errors.log'), '', 'utf8');

    // Write metadata.json.
    const metadata: SessionMeta = {
      sha1,
      kind: 'static',
      filename,
      compilation_time: Date.now(),
      last_used_time: Date.now(),
      usage_score: 0
    };
    fs.writeFileSync(
      path.join(sessionPath, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
      'utf8'
    );

    // Append to LRU cache.
    this.lruOrder.push(sha1);
    // Append to creation order.
    this.creationOrder.push(sha1);
    this.evict();

    return { sha1, filename, path: sessionPath };
  }

  /**
   * Purpose: Create or refresh a live session from a local DSP file path.
   * How: Derives stable live ID from canonical path, syncs source artifacts/metadata, and preserves historical usage fields.
   */
  createOrUpdateLiveSessionFromFile(filePath: string): Session {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path');
    }
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.endsWith('.dsp')) {
      throw new Error('File must end with .dsp');
    }
    if (!fs.existsSync(resolvedPath)) {
      throw new Error('File not found');
    }
    const sourceStats = fs.statSync(resolvedPath);
    const code = fs.readFileSync(resolvedPath, 'utf8');
    const isDraft = code.trim().length === 0;
    const filename = path.basename(resolvedPath);
    const sourceSha = this.computeSha1(code);
    const liveId = `live-${this.computeSha1(resolvedPath)}`;
    const sessionPath = path.join(this.sessionsDir, liveId);
    const sourcecodePath = path.join(sessionPath, 'sourcecode');
    const metadataPath = path.join(sessionPath, 'metadata.json');

    let existingCompilationTime: number | null = null;
    let existingLastUsedTime: number | null = null;
    let existingUsageScore: number | null = null;
    if (fs.existsSync(metadataPath)) {
      try {
        const prev = this.readMetadata(metadataPath);
        if (!prev) {
          throw new Error('Invalid metadata');
        }
        if (typeof prev.compilation_time === 'number' && Number.isFinite(prev.compilation_time)) {
          existingCompilationTime = prev.compilation_time;
        }
        if (typeof prev.last_used_time === 'number' && Number.isFinite(prev.last_used_time)) {
          existingLastUsedTime = prev.last_used_time;
        }
        if (typeof prev.usage_score === 'number' && Number.isFinite(prev.usage_score)) {
          existingUsageScore = prev.usage_score;
        }
      } catch {
        // Ignore malformed previous metadata.
      }
    }

    fs.mkdirSync(sourcecodePath, { recursive: true });
    fs.writeFileSync(path.join(sourcecodePath, filename), code, 'utf8');
    fs.writeFileSync(path.join(sessionPath, 'user_code.dsp'), code, 'utf8');
    if (!fs.existsSync(path.join(sessionPath, 'errors.log'))) {
      fs.writeFileSync(path.join(sessionPath, 'errors.log'), '', 'utf8');
    }

    const metadata: SessionMeta = {
      sha1: liveId,
      kind: 'live',
      live_draft: isDraft,
      source_path: resolvedPath,
      source_mtime_ms: sourceStats.mtimeMs,
      content_sha1: sourceSha,
      filename,
      compilation_time: existingCompilationTime ?? Date.now(),
      last_used_time: existingLastUsedTime ?? Date.now(),
      usage_score: existingUsageScore ?? 0
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    if (!this.creationOrder.includes(liveId)) {
      this.creationOrder.push(liveId);
    }
    this.touch(liveId);
    this.evict();

    return { sha1: liveId, filename, path: sessionPath };
  }

  /**
   * Purpose: Ensure a live session exists for a file and report whether it changed.
   * How: Compares current source mtime with metadata and only rebuilds the live session when required.
   */
  ensureLiveSessionFromFile(filePath: string): { changed: boolean; isNew: boolean; session: Session } {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path');
    }
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.endsWith('.dsp')) {
      throw new Error('File must end with .dsp');
    }
    if (!fs.existsSync(resolvedPath)) {
      throw new Error('File not found');
    }

    const liveId = `live-${this.computeSha1(resolvedPath)}`;
    const metadataPath = path.join(this.sessionsDir, liveId, 'metadata.json');
    const existed = fs.existsSync(metadataPath);
    const currentMtimeMs = fs.statSync(resolvedPath).mtimeMs;

    if (existed) {
      try {
        const prev = this.readMetadata(metadataPath);
        if (!prev) {
          throw new Error('Invalid metadata');
        }
        if (
          prev.kind === 'live' &&
          typeof prev.source_mtime_ms === 'number' &&
          Number.isFinite(prev.source_mtime_ms) &&
          prev.source_mtime_ms === currentMtimeMs
        ) {
          const existing = this.getSession(liveId);
          if (existing) {
            return {
              changed: false,
              isNew: false,
              session: existing
            };
          }
        }
      } catch {
        // Ignore malformed metadata.
      }
    }

    const session = this.createOrUpdateLiveSessionFromFile(resolvedPath);
    return {
      changed: true,
      isNew: !existed,
      session
    };
  }

  /**
   * Purpose: List known live sessions from current persisted state.
   * How: Rebuilds session indexes then filters creation-ordered summaries to entries marked as `kind: live`.
   */
  listLiveSessions(limit?: number): SessionSummary[] {
    this.refreshSessions();
    const out: SessionSummary[] = [];
    for (const id of this.creationOrder) {
      const metadataPath = path.join(this.sessionsDir, id, 'metadata.json');
      try {
        const metadata = this.readMetadata(metadataPath);
        if (!metadata) continue;
        if (metadata.kind !== 'live') continue;
        out.push(this.toSessionSummary(id, metadata));
      } catch {
        // ignore invalid entries
      }
    }
    return this.applySummaryLimit(out, limit, 'tail');
  }

  /**
   * Purpose: Refresh one live session from its source file when content changed.
   * How: Compares metadata mtime/content hash with source file state and either no-ops or rebuilds session artifacts.
   */
  refreshLiveSession(liveId: string): { changed: boolean; session: Session | null; contentSha1?: string } {
    if (!this.isValidLiveId(liveId) || !this.exists(liveId)) {
      return { changed: false, session: null };
    }
    const metadataPath = path.join(this.sessionsDir, liveId, 'metadata.json');
    try {
      const metadata = this.readMetadata(metadataPath);
      if (!metadata) {
        return { changed: false, session: null };
      }
      if (metadata.kind !== 'live' || !metadata.source_path) {
        return { changed: false, session: null };
      }
      if (!fs.existsSync(metadata.source_path)) {
        return { changed: false, session: null };
      }
      const sourceMtimeMs = fs.statSync(metadata.source_path).mtimeMs;
      if (
        typeof metadata.source_mtime_ms === 'number' &&
        Number.isFinite(metadata.source_mtime_ms) &&
        metadata.source_mtime_ms === sourceMtimeMs
      ) {
        const session = this.getSession(liveId);
        return { changed: false, session, contentSha1: metadata.content_sha1 };
      }
      const code = fs.readFileSync(metadata.source_path, 'utf8');
      const contentSha1 = this.computeSha1(code);
      if (metadata.content_sha1 === contentSha1) {
        metadata.source_mtime_ms = sourceMtimeMs;
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
        const session = this.getSession(liveId);
        return { changed: false, session, contentSha1 };
      }
      const session = this.createOrUpdateLiveSessionFromFile(metadata.source_path);
      return { changed: true, session, contentSha1 };
    } catch {
      return { changed: false, session: null };
    }
  }

  /**
   * Purpose: Fetch one session descriptor by ID.
   * How: Validates existence, updates LRU access order, and reads filename from metadata.
   */
  getSession(sha1: string): Session | null {
    if (!this.exists(sha1)) {
      return null;
    }

    this.touch(sha1);

    // Read metadata to get filename.
    const metadataPath = path.join(this.sessionsDir, sha1, 'metadata.json');
    try {
      const metadata = this.readMetadata(metadataPath);
      if (!metadata) {
        return null;
      }
      return {
        sha1,
        filename: metadata.filename,
        path: path.join(this.sessionsDir, sha1)
      };
    } catch {
      return null;
    }
  }

  /**
   * Purpose: Read persisted compiler diagnostics for one session.
   * How: Loads `errors.log` text from the session directory and returns empty string on failures.
   */
  getErrors(sha1: string): string {
    const errorsPath = path.join(this.sessionsDir, sha1, 'errors.log');
    try {
      return fs.readFileSync(errorsPath, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Purpose: Persist compiler diagnostics for one session.
   * How: Overwrites session `errors.log` with provided text content.
   */
  setErrors(sha1: string, errors: string): void {
    const errorsPath = path.join(this.sessionsDir, sha1, 'errors.log');
    fs.writeFileSync(errorsPath, errors, 'utf8');
  }

  /**
   * Purpose: Read a file from a session directory with path-safety checks.
   * How: Rejects traversal patterns, resolves session-relative path, and returns file buffer when present.
   */
  getFile(sha1: string, relativePath: string): Buffer | null {
    // Security: prevent path traversal.
    if (relativePath.includes('..') || relativePath.startsWith('/')) {
      return null;
    }

    const filePath = path.join(this.sessionsDir, sha1, relativePath);
    try {
      return fs.readFileSync(filePath);
    } catch {
      return null;
    }
  }

  /**
   * Purpose: List SVG artifact filenames for a session.
   * How: Reads `svg/` directory and keeps only `.svg` entries.
   */
  listSvgFiles(sha1: string): string[] | null {
    const svgDir = path.join(this.sessionsDir, sha1, 'svg');
    try {
      const files = fs.readdirSync(svgDir);
      return files.filter(f => f.endsWith('.svg'));
    } catch {
      return null;
    }
  }

  /**
   * Build normalized session summaries from metadata files using creation order.
   */
  private buildSessionSummariesByCreationOrder(): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    for (const sha1 of this.creationOrder) {
      const metadataPath = path.join(this.sessionsDir, sha1, 'metadata.json');
      const metadata = this.readMetadata(metadataPath);
      if (!metadata) continue;
      summaries.push(this.toSessionSummary(sha1, metadata));
    }
    return summaries;
  }

  /**
   * Purpose: Build a session listing from creation-order summaries with optional sorting and limiting.
   * How: Refreshes persisted state, derives normalized summaries, applies comparator when provided, then applies head/tail limit mode.
   */
  private listSessions(options?: {
    limit?: number;
    limitMode?: 'head' | 'tail';
    comparator?: (a: SessionSummary, b: SessionSummary) => number;
  }): SessionSummary[] {
    this.refreshSessions();
    const summaries = this.buildSessionSummariesByCreationOrder();
    if (options?.comparator) {
      summaries.sort(options.comparator);
    }
    return this.applySummaryLimit(
      summaries,
      options?.limit,
      options?.limitMode ?? 'tail'
    );
  }

  /**
   * Purpose: List sessions in chronological creation order.
   * How: Refreshes summaries and returns oldest-to-newest ordering with optional tail limit.
   */
  listSessionsByCreation(limit?: number): SessionSummary[] {
    return this.listSessions({ limit, limitMode: 'tail' });
  }

  /**
   * Purpose: List sessions sorted by most-recent-use order.
   * How: Sorts by `last_used_time` descending with compilation time fallback tie-breakers.
   */
  listSessionsByLastUsed(limit?: number): SessionSummary[] {
    return this.listSessions({
      limit,
      limitMode: 'head',
      comparator: (a, b) => {
        const aLast = typeof a.last_used_time === 'number' ? a.last_used_time : a.compilation_time;
        const bLast = typeof b.last_used_time === 'number' ? b.last_used_time : b.compilation_time;
        if (aLast !== bLast) return bLast - aLast;
        return b.compilation_time - a.compilation_time;
      }
    });
  }

  /**
   * Purpose: List sessions sorted by cumulative usage score.
   * How: Sorts by score descending, then by last-used timestamp, then by compilation time.
   */
  listSessionsByUsage(limit?: number): SessionSummary[] {
    return this.listSessions({
      limit,
      limitMode: 'head',
      comparator: (a, b) => {
        const aScore = typeof a.usage_score === 'number' ? a.usage_score : 0;
        const bScore = typeof b.usage_score === 'number' ? b.usage_score : 0;
        if (aScore !== bScore) return bScore - aScore;
        const aLast = typeof a.last_used_time === 'number' ? a.last_used_time : a.compilation_time;
        const bLast = typeof b.last_used_time === 'number' ? b.last_used_time : b.compilation_time;
        if (aLast !== bLast) return bLast - aLast;
        return b.compilation_time - a.compilation_time;
      }
    });
  }

  /**
   * Purpose: Record one effective session usage event.
   * How: Updates `last_used_time` and increments `usage_score` in metadata, then refreshes LRU ordering.
   */
  markSessionUsed(sha1: string, when: number = Date.now(), weight: number = 1): boolean {
    if (!this.exists(sha1)) return false;
    const metadataPath = path.join(this.sessionsDir, sha1, 'metadata.json');
    try {
      const metadata = this.readMetadata(metadataPath);
      if (!metadata) return false;
      metadata.last_used_time = when;
      const currentScore =
        typeof metadata.usage_score === 'number' && Number.isFinite(metadata.usage_score)
          ? metadata.usage_score
          : 0;
      const inc = Number.isFinite(weight) ? Math.max(0, weight) : 0;
      metadata.usage_score = currentScore + inc;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
      this.touch(sha1);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Purpose: Delete one session and remove it from in-memory order indexes.
   * How: Deletes session directory recursively and prunes corresponding LRU/creation entries.
   */
  deleteSession(sha1: string): boolean {
    if (!this.exists(sha1)) {
      return false;
    }
    const sessionPath = path.join(this.sessionsDir, sha1);
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch {
      return false;
    }

    const lruIndex = this.lruOrder.indexOf(sha1);
    if (lruIndex !== -1) {
      this.lruOrder.splice(lruIndex, 1);
    }
    const creationIndex = this.creationOrder.indexOf(sha1);
    if (creationIndex !== -1) {
      this.creationOrder.splice(creationIndex, 1);
    }
    return true;
  }

  /**
   * Purpose: Persist the last successful C++ compile flags for one session.
   * How: Reads session metadata, updates `cpp_flags`, and writes metadata back to disk.
   */
  setCppFlags(sha1: string, flags: string): boolean {
    if (!this.exists(sha1)) return false;
    const metadataPath = path.join(this.sessionsDir, sha1, 'metadata.json');
    try {
      const metadata = this.readMetadata(metadataPath);
      if (!metadata) return false;
      metadata.cpp_flags = String(flags || '');
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

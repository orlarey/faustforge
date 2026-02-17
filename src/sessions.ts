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
  source_path?: string;
  source_mtime_ms?: number;
  content_sha1?: string;
}

/**
 * Gestionnaire de sessions avec cache LRU
 */
export class SessionManager {
  private sessionsDir: string;
  private maxSessions: number;
  private lruOrder: string[] = []; // ordre d'accès, plus récent à la fin
  private creationOrder: string[] = []; // ordre de création, plus ancien au début

  constructor(sessionsDir: string, maxSessions: number = 50) {
    this.sessionsDir = sessionsDir;
    this.maxSessions = maxSessions;

    // Créer le répertoire sessions s'il n'existe pas
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    // Migration: align legacy live sessions with current draft semantics.
    this.migrateLiveDraftMetadata();

    // Charger les sessions existantes
    this.loadExistingSessions();
  }

  private isBlankText(content: string): boolean {
    return content.trim().length === 0;
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
        const metadata: SessionMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
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
   * Charge les sessions existantes du filesystem
   */
  private loadExistingSessions(): void {
    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
      const summaries: SessionSummary[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && this.isValidSessionId(entry.name)) {
          const metadataPath = path.join(this.sessionsDir, entry.name, 'metadata.json');
          try {
            const metadata: SessionMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            const kind: 'static' | 'live' = metadata.kind === 'live' ? 'live' : 'static';
            const id = typeof metadata.sha1 === 'string' && metadata.sha1 ? metadata.sha1 : entry.name;
            if (!this.isValidSessionId(id)) {
              continue;
            }
            summaries.push({
              sha1: id,
              kind,
              live_draft: metadata.live_draft === true,
              filename: metadata.filename,
              compilation_time: metadata.compilation_time
            });
          } catch {
            // Ignorer les sessions mal formées
          }
        }
      }
      summaries.sort((a, b) => a.compilation_time - b.compilation_time);
      this.creationOrder = summaries.map(s => s.sha1);
      // LRU: ordre de scan comme fallback
      this.lruOrder = this.creationOrder.slice();
    } catch {
      // Répertoire vide ou erreur, ignorer
    }
  }

  /**
   * Recharge la liste des sessions depuis le disque
   */
  refreshSessions(): void {
    this.loadExistingSessions();
  }

  /**
   * Vérifie si une chaîne est un SHA-1 valide
   */
  private isValidSha1(str: string): boolean {
    return /^[0-9a-f]{40}$/.test(str);
  }

  private isValidLiveId(str: string): boolean {
    return /^live-[0-9a-f]{40}$/.test(str);
  }

  private isValidSessionId(str: string): boolean {
    return this.isValidSha1(str) || this.isValidLiveId(str);
  }

  /**
   * Calcule le SHA-1 d'un code
   */
  computeSha1(code: string): string {
    return crypto.createHash('sha1').update(code, 'utf8').digest('hex');
  }

  /**
   * Vérifie si une session existe
   */
  exists(sha1: string): boolean {
    return fs.existsSync(path.join(this.sessionsDir, sha1));
  }

  /**
   * Récupère le chemin d'une session
   */
  getSessionPath(sha1: string): string {
    return path.join(this.sessionsDir, sha1);
  }

  /**
   * Met à jour l'ordre LRU (marque comme récemment accédé)
   */
  touch(sha1: string): void {
    const index = this.lruOrder.indexOf(sha1);
    if (index !== -1) {
      this.lruOrder.splice(index, 1);
    }
    this.lruOrder.push(sha1);
  }

  /**
   * Évicte les sessions les plus anciennes si nécessaire
   */
  private evict(): void {
    while (this.lruOrder.length > this.maxSessions) {
      const oldest = this.lruOrder.shift();
      if (oldest) {
        const sessionPath = path.join(this.sessionsDir, oldest);
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch {
          // Ignorer les erreurs de suppression
        }
        const creationIndex = this.creationOrder.indexOf(oldest);
        if (creationIndex !== -1) {
          this.creationOrder.splice(creationIndex, 1);
        }
      }
    }
  }

  /**
   * Crée une nouvelle session
   */
  createSession(code: string, filename: string): Session {
    const sha1 = this.computeSha1(code);
    const sessionPath = path.join(this.sessionsDir, sha1);

    // Si la session existe déjà, juste touch et retourner
    if (this.exists(sha1)) {
      this.touch(sha1);
      return { sha1, filename, path: sessionPath };
    }

    // Créer la structure de la session
    const sourcecodePath = path.join(sessionPath, 'sourcecode');
    fs.mkdirSync(sourcecodePath, { recursive: true });

    // Écrire le fichier source dans sourcecode/
    fs.writeFileSync(path.join(sourcecodePath, filename), code, 'utf8');

    // Écrire la copie standardisée user_code.dsp
    fs.writeFileSync(path.join(sessionPath, 'user_code.dsp'), code, 'utf8');

    // Créer errors.log vide
    fs.writeFileSync(path.join(sessionPath, 'errors.log'), '', 'utf8');

    // Créer metadata.json
    const metadata: SessionMeta = {
      sha1,
      kind: 'static',
      filename,
      compilation_time: Date.now()
    };
    fs.writeFileSync(
      path.join(sessionPath, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
      'utf8'
    );

    // Ajouter au cache LRU
    this.lruOrder.push(sha1);
    // Ajouter à l'ordre de création
    this.creationOrder.push(sha1);
    this.evict();

    return { sha1, filename, path: sessionPath };
  }

  /**
   * Crée (ou met à jour) une session live à partir d'un fichier local.
   * L'ID live est stable et dérivé du chemin canonique du fichier.
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
    if (fs.existsSync(metadataPath)) {
      try {
        const prev: SessionMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        if (typeof prev.compilation_time === 'number' && Number.isFinite(prev.compilation_time)) {
          existingCompilationTime = prev.compilation_time;
        }
      } catch {
        // ignore malformed previous metadata
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
      compilation_time: existingCompilationTime ?? Date.now()
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
   * Assure l'existence d'une session live pour un fichier donné et indique
   * si le contenu a changé depuis la dernière version connue.
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
        const prev: SessionMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
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
        // ignore malformed metadata
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
   * Liste les sessions live connues depuis le scan disque courant.
   */
  listLiveSessions(limit?: number): SessionSummary[] {
    this.refreshSessions();
    const out: SessionSummary[] = [];
    for (const id of this.creationOrder) {
      const metadataPath = path.join(this.sessionsDir, id, 'metadata.json');
      try {
        const metadata: SessionMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        if (metadata.kind !== 'live') continue;
        out.push({
          sha1: id,
          kind: 'live',
          live_draft: metadata.live_draft === true,
          filename: metadata.filename,
          compilation_time: metadata.compilation_time,
          source_path: metadata.source_path,
          source_mtime_ms: metadata.source_mtime_ms,
          content_sha1: metadata.content_sha1
        });
      } catch {
        // ignore invalid entries
      }
    }
    if (limit && limit > 0) return out.slice(-limit);
    return out;
  }

  /**
   * Rafraîchit une session live depuis son fichier source si le contenu a changé.
   */
  refreshLiveSession(liveId: string): { changed: boolean; session: Session | null; contentSha1?: string } {
    if (!this.isValidLiveId(liveId) || !this.exists(liveId)) {
      return { changed: false, session: null };
    }
    const metadataPath = path.join(this.sessionsDir, liveId, 'metadata.json');
    try {
      const metadata: SessionMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
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
   * Récupère une session existante
   */
  getSession(sha1: string): Session | null {
    if (!this.exists(sha1)) {
      return null;
    }

    this.touch(sha1);

    // Lire le metadata pour récupérer le filename
    const metadataPath = path.join(this.sessionsDir, sha1, 'metadata.json');
    try {
      const metadata: SessionMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
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
   * Lit le contenu du fichier errors.log
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
   * Écrit le contenu du fichier errors.log
   */
  setErrors(sha1: string, errors: string): void {
    const errorsPath = path.join(this.sessionsDir, sha1, 'errors.log');
    fs.writeFileSync(errorsPath, errors, 'utf8');
  }

  /**
   * Récupère un fichier de la session
   */
  getFile(sha1: string, relativePath: string): Buffer | null {
    // Sécurité : empêcher path traversal
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
   * Liste les fichiers SVG dans une session
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
   * Liste des sessions par ordre de création (du plus ancien au plus récent)
   */
  listSessionsByCreation(limit?: number): SessionSummary[] {
    this.refreshSessions();
    const summaries: SessionSummary[] = [];
    for (const sha1 of this.creationOrder) {
      const metadataPath = path.join(this.sessionsDir, sha1, 'metadata.json');
      try {
        const metadata: SessionMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        summaries.push({
          sha1: metadata.sha1,
          kind: metadata.kind === 'live' ? 'live' : 'static',
          live_draft: metadata.live_draft === true,
          filename: metadata.filename,
          compilation_time: metadata.compilation_time,
          source_path: metadata.source_path,
          source_mtime_ms: metadata.source_mtime_ms,
          content_sha1: metadata.content_sha1
        });
      } catch {
        // Ignorer
      }
    }
    if (limit && limit > 0) {
      return summaries.slice(-limit);
    }
    return summaries;
  }

  /**
   * Supprime une session
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
}

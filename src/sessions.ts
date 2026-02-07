import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface SessionMeta {
  sha1: string;
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
  filename: string;
  compilation_time: number;
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

    // Charger les sessions existantes
    this.loadExistingSessions();
  }

  /**
   * Charge les sessions existantes du filesystem
   */
  private loadExistingSessions(): void {
    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
      const summaries: SessionSummary[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && this.isValidSha1(entry.name)) {
          const metadataPath = path.join(this.sessionsDir, entry.name, 'metadata.json');
          try {
            const metadata: SessionMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            summaries.push({
              sha1: metadata.sha1,
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
          filename: metadata.filename,
          compilation_time: metadata.compilation_time
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

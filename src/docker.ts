import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG } from './config';

const DOCKER_IMAGE = 'ghcr.io/orlarey/faustdocker:main';
const TIMEOUT_MS = 30000; // 30 secondes
const VERSION_TIMEOUT_MS = 10000; // 10 secondes

let cachedFaustVersion: string | null = null;
let cachedFaustHelp: string | null = null;
const CONTAINER_SESSIONS_DIR = CONFIG.sessionsDir || '/app/sessions';
const HOST_SESSIONS_DIR = CONFIG.hostSessionsDir || '';
const WINDOWS_ABS_PATH_RE = /^([a-zA-Z]):[\\/](.*)$/;

export interface DockerResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Exécute le compilateur Faust dans un conteneur Docker
 *
 * @param sessionPath - Chemin absolu vers le répertoire de session
 * @param filename - Nom du fichier .dsp à compiler
 * @param args - Arguments additionnels pour faust
 * @returns Résultat de l'exécution
 */
export function runFaustDocker(
  sessionPath: string,
  filename: string,
  args: string[]
): Promise<DockerResult> {
  return new Promise((resolve) => {
    const mountPath = resolveDockerMountPath(sessionPath);
    // Construire la commande Docker
    // Monte tout le répertoire session dans /tmp du conteneur
    // Le fichier source est dans /tmp/sourcecode/<filename>
    const dockerArgs = [
      'run',
      '--rm',
      '--mount', `type=bind,src=${mountPath},target=/tmp`,
      '-w', '/tmp',
      DOCKER_IMAGE,
      `sourcecode/${filename}`,
      ...args
    ];

    let stdout = '';
    let stderr = '';
    let killed = false;
    let finished = false;

    const proc = spawn('docker', dockerArgs);

    // Timeout
    const timer = setTimeout(() => {
      killed = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore kill failures
      }
      // Hard fallback: resolve even if the child process never emits close/exit.
      finalize(null);
    }, TIMEOUT_MS);

    const finalize = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killed) {
        resolve({
          success: false,
          stdout,
          stderr: stderr + '\nCompilation timeout exceeded',
          exitCode: null
        });
        return;
      }
      resolve({
        success: code === 0,
        stdout,
        stderr,
        exitCode: code
      });
    };

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Use both events so we do not hang if one of them is missed.
    proc.on('exit', (code) => {
      finalize(code);
    });
    proc.on('close', (code) => {
      finalize(code);
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        success: false,
        stdout,
        stderr: `Docker error: ${err.message}`,
        exitCode: null
      });
    });
  });
}

function resolveDockerMountPath(sessionPath: string): string {
  if (!HOST_SESSIONS_DIR) {
    return toDockerDesktopHostPath(sessionPath);
  }
  const normalizedSession = normalizePosix(sessionPath);
  const normalizedContainerBase = normalizePosix(CONTAINER_SESSIONS_DIR);
  if (!isInTree(normalizedSession, normalizedContainerBase)) {
    return toDockerDesktopHostPath(sessionPath);
  }
  const relative =
    normalizedSession === normalizedContainerBase
      ? ''
      : normalizedSession.slice(normalizedContainerBase.length + 1);
  const hostPath = joinHostPath(HOST_SESSIONS_DIR, relative);
  return toDockerDesktopHostPath(hostPath);
}

function normalizePosix(input: string): string {
  const slashed = input.replace(/\\/g, '/');
  return path.posix.normalize(slashed);
}

function isInTree(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  return candidate.startsWith(`${base}/`);
}

function joinHostPath(base: string, relative: string): string {
  if (!relative) return base;
  const winMatch = WINDOWS_ABS_PATH_RE.exec(base);
  if (winMatch) {
    const baseClean = base.replace(/[\\/]+$/, '');
    const relWin = relative.split('/').join('\\');
    return `${baseClean}\\${relWin}`;
  }
  return path.posix.join(base, relative);
}

function toDockerDesktopHostPath(input: string): string {
  const winMatch = WINDOWS_ABS_PATH_RE.exec(input);
  if (!winMatch) {
    return input;
  }
  const drive = winMatch[1].toLowerCase();
  const rest = winMatch[2].replace(/\\/g, '/');
  return `/run/desktop/mnt/host/${drive}/${rest}`;
}

function runDockerSimple(args: string[], timeoutMs: number): Promise<{ output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;

    const proc = spawn('docker', args);

    const finalize = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        output: (stdout || stderr).trim(),
        timedOut
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      finalize();
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('exit', () => finalize());
    proc.on('close', () => finalize());
    proc.on('error', () => finalize());
  });
}

/**
 * Récupère la version du compilateur Faust via Docker
 */
export async function getFaustVersion(): Promise<string> {
  if (cachedFaustVersion) {
    return cachedFaustVersion;
  }

  const dockerArgs = ['run', '--rm', DOCKER_IMAGE, '-v'];
  const { output, timedOut } = await runDockerSimple(dockerArgs, VERSION_TIMEOUT_MS);
  if (timedOut) return 'Faust version unknown (timeout)';
  if (!output) return 'Faust version unknown';
  const firstLine = output.split(/\r?\n/)[0].trim();
  const versionOnly = firstLine.slice(0, 20);
  cachedFaustVersion = versionOnly;
  return versionOnly;
}

/**
 * Récupère l'aide du compilateur Faust (`faust -h`) via Docker.
 */
export async function getFaustHelp(): Promise<string> {
  if (cachedFaustHelp) {
    return cachedFaustHelp;
  }

  const dockerArgs = ['run', '--rm', DOCKER_IMAGE, '-h'];
  const { output, timedOut } = await runDockerSimple(dockerArgs, VERSION_TIMEOUT_MS);
  if (timedOut) return 'Faust help unavailable (timeout)';
  if (!output) return 'Faust help unavailable';
  cachedFaustHelp = output;
  return output;
}

/**
 * Analyse un fichier Faust (génère C++, SVG, et graphes DOT)
 */
export async function analyzeFaust(
  sessionPath: string,
  filename: string
): Promise<{ success: boolean; errors: string }> {
  // Passe principale (bloquante): C++, SVG et signaux.
  // Les fichiers sont écrits à la racine de /tmp (= session).
  const analyzeArgs = [
    '-o', 'generated.cpp',
    '-svg',
    '-sg'
  ];

  const result = await runFaustDocker(sessionPath, filename, analyzeArgs);

  // Écrire les erreurs dans errors.log
  const errorsPath = path.join(sessionPath, 'errors.log');
  fs.writeFileSync(errorsPath, result.stderr, 'utf8');

  // Déplacer les artefacts de la passe principale.
  if (result.success) {
    moveSvgFiles(sessionPath, filename);
    moveDotFile(sessionPath, filename, '-sig.dot', 'signals.dot');

    // Passe tasks (non bloquante): nécessite -vec avec -tg.
    // Si cette passe échoue, on conserve la session utilisable sans tasks.dot.
    const tasksResult = await runFaustDocker(sessionPath, filename, ['-vec', '-tg']);
    if (tasksResult.success) {
      moveDotFile(sessionPath, filename, '.dot', 'tasks.dot');
    }
  }

  return {
    success: result.success,
    errors: result.stderr
  };
}

function parseFaustFlags(flags: string): string[] {
  const text = String(flags || '').trim();
  if (!text) return [];
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Compile uniquement le C++ généré avec un jeu d'options Faust.
 */
export async function compileFaustCpp(
  sessionPath: string,
  filename: string,
  flags: string
): Promise<{ success: boolean; errors: string }> {
  const customArgs = parseFaustFlags(flags);
  const args = [...customArgs, '-o', 'generated.cpp'];
  const result = await runFaustDocker(sessionPath, filename, args);
  return {
    success: result.success,
    errors: result.stderr
  };
}

/**
 * Déplace les fichiers SVG générés vers le répertoire svg/
 */
function moveSvgFiles(sessionPath: string, filename: string): void {
  const sourcecodePath = path.join(sessionPath, 'sourcecode');
  const svgDestDir = path.join(sessionPath, 'svg');

  // Le compilateur Faust crée un répertoire <filename>-svg/ dans sourcecode/
  const baseName = filename.replace('.dsp', '');
  const svgSourceDir = path.join(sourcecodePath, `${baseName}-svg`);

  try {
    if (fs.existsSync(svgSourceDir)) {
      // Créer le répertoire destination
      fs.mkdirSync(svgDestDir, { recursive: true });

      // Copier tous les fichiers SVG
      const files = fs.readdirSync(svgSourceDir);
      for (const file of files) {
        if (file.endsWith('.svg')) {
          const srcFile = path.join(svgSourceDir, file);
          const destFile = path.join(svgDestDir, file);
          fs.copyFileSync(srcFile, destFile);
        }
      }

      // Supprimer le répertoire source
      fs.rmSync(svgSourceDir, { recursive: true, force: true });
    }
  } catch {
    // Ignorer les erreurs de déplacement
  }
}

/**
 * Déplace un graphe DOT généré vers un emplacement de session stable.
 */
function moveDotFile(
  sessionPath: string,
  filename: string,
  generatedSuffix: string,
  destinationName: string
): void {
  const sourcecodePath = path.join(sessionPath, 'sourcecode');
  const candidates = [
    path.join(sourcecodePath, `${filename}${generatedSuffix}`),
    path.join(sessionPath, `${filename}${generatedSuffix}`)
  ];
  const dotDest = path.join(sessionPath, destinationName);

  try {
    const dotSource = candidates.find((p) => fs.existsSync(p));
    if (!dotSource) return;
    fs.copyFileSync(dotSource, dotDest);
  } catch {
    // Ignorer les erreurs de déplacement
  }
}

/**
 * Compile un fichier Faust vers WebAssembly
 */
export async function compileFaustWasm(
  sessionPath: string,
  filename: string
): Promise<{ success: boolean; errors: string }> {
  // Créer le répertoire wasm/
  const wasmDir = path.join(sessionPath, 'wasm');
  fs.mkdirSync(wasmDir, { recursive: true });

  // Arguments pour la compilation WASM
  const args = [
    '-lang', 'wasm',
    '-o', 'wasm/main.wasm'
  ];

  const result = await runFaustDocker(sessionPath, filename, args);

  return {
    success: result.success,
    errors: result.stderr
  };
}

/**
 * Compile un fichier Faust vers WebAssembly (mode wasm-i pour exécution web)
 */
export async function compileFaustWasmRun(
  sessionPath: string,
  filename: string
): Promise<{ success: boolean; errors: string }> {
  const wasmDir = path.join(sessionPath, 'wasm');
  fs.mkdirSync(wasmDir, { recursive: true });

  const args = [
    '-lang', 'wasm-i',
    '-o', 'wasm/run.wasm'
  ];

  const result = await runFaustDocker(sessionPath, filename, args);

  return {
    success: result.success,
    errors: result.stderr
  };
}

/**
 * Génère une webapp PWA avec faust2wasm-ts
 */
export function compileFaustWebapp(
  sessionPath: string,
  filename: string
): Promise<{ success: boolean; errors: string }> {
  return new Promise((resolve) => {
    const webappDir = path.join(sessionPath, 'webapp');
    const indexHtml = path.join(webappDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      resolve({ success: true, errors: '' });
      return;
    }

    const sourceDir = path.join(sessionPath, 'sourcecode');
    const args = ['--no-install', 'faust2wasm-ts', filename, '../webapp', '-pwa'];

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Resolve through npx to avoid relying on a globally installed faust2wasm-ts binary.
    const proc = spawn('npx', args, { cwd: sourceDir });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ success: false, errors: 'Webapp generation timeout exceeded' });
        return;
      }
      if (code !== 0 || !fs.existsSync(indexHtml)) {
        resolve({ success: false, errors: stderr || stdout || 'Webapp generation failed' });
        return;
      }
      resolve({ success: true, errors: '' });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, errors: `npx faust2wasm-ts error: ${err.message}` });
    });
  });
}

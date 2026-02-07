import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const DOCKER_IMAGE = 'ghcr.io/orlarey/faustdocker:main';
const TIMEOUT_MS = 30000; // 30 secondes
const VERSION_TIMEOUT_MS = 10000; // 10 secondes

let cachedFaustVersion: string | null = null;
const CONTAINER_SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
const HOST_SESSIONS_DIR = process.env.HOST_SESSIONS_DIR || '';

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
      '-v', `${mountPath}:/tmp`,
      '-w', '/tmp',
      DOCKER_IMAGE,
      `sourcecode/${filename}`,
      ...args
    ];

    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn('docker', dockerArgs);

    // Timeout
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
        resolve({
          success: false,
          stdout,
          stderr: stderr + '\nCompilation timeout exceeded',
          exitCode: null
        });
      } else {
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code
        });
      }
    });

    proc.on('error', (err) => {
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
    return sessionPath;
  }
  const normalizedSession = path.resolve(sessionPath);
  const normalizedContainerBase = path.resolve(CONTAINER_SESSIONS_DIR);
  const normalizedHostBase = path.resolve(HOST_SESSIONS_DIR);
  if (!normalizedSession.startsWith(`${normalizedContainerBase}${path.sep}`)) {
    return sessionPath;
  }
  const relative = path.relative(normalizedContainerBase, normalizedSession);
  return path.join(normalizedHostBase, relative);
}

/**
 * Récupère la version du compilateur Faust via Docker
 */
export function getFaustVersion(): Promise<string> {
  if (cachedFaustVersion) {
    return Promise.resolve(cachedFaustVersion);
  }

  return new Promise((resolve) => {
    const dockerArgs = [
      'run',
      '--rm',
      DOCKER_IMAGE,
      '-v'
    ];

    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn('docker', dockerArgs);

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, VERSION_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      clearTimeout(timer);
      if (killed) {
        resolve('Faust version unknown (timeout)');
        return;
      }
      const output = (stdout || stderr).trim();
      if (!output) {
        resolve('Faust version unknown');
        return;
      }
      const firstLine = output.split(/\r?\n/)[0].trim();
      const versionOnly = firstLine.slice(0, 20);
      cachedFaustVersion = versionOnly;
      resolve(versionOnly);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve('Faust version unknown');
    });
  });
}

/**
 * Analyse un fichier Faust (génère C++ et SVG)
 */
export async function analyzeFaust(
  sessionPath: string,
  filename: string
): Promise<{ success: boolean; errors: string }> {
  // Arguments pour l'analyse : générer C++ et SVG
  // Les fichiers sont écrits à la racine de /tmp (= session)
  const args = [
    '-o', 'generated.cpp',
    '-svg'
  ];

  const result = await runFaustDocker(sessionPath, filename, args);

  // Écrire les erreurs dans errors.log
  const errorsPath = path.join(sessionPath, 'errors.log');
  fs.writeFileSync(errorsPath, result.stderr, 'utf8');

  // Déplacer les SVG générés dans svg/
  if (result.success) {
    moveSvgFiles(sessionPath, filename);
  }

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
    const args = [filename, '../webapp', '-pwa'];

    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn('faust2wasm-ts', args, { cwd: sourceDir });

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
      resolve({ success: false, errors: `faust2wasm-ts error: ${err.message}` });
    });
  });
}

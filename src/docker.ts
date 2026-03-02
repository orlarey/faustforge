import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG } from './config';

const DOCKER_IMAGE = 'ghcr.io/orlarey/faustdocker:main';
const TIMEOUT_MS = 30000; // 30 seconds
const VERSION_TIMEOUT_MS = 10000; // 10 seconds

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
 * Purpose: Run Faust compilation commands in the Docker toolchain container.
 * How: Binds one session directory into `/tmp`, executes `faust` with requested arguments, and returns captured process output.
 */
export function runFaustDocker(
  sessionPath: string,
  filename: string,
  args: string[]
): Promise<DockerResult> {
  return new Promise((resolve) => {
    const mountPath = resolveDockerMountPath(sessionPath);
    // Build docker command with session mount under /tmp.
    // Source file is located at /tmp/sourcecode/<filename> inside the container.
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

    // Enforce compilation timeout.
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

    /**
     * Purpose: Finalize one docker run resolution exactly once.
     * How: Clears timeout, chooses timeout or process-exit result shape, and resolves the outer promise.
     */
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

    // Use both events so resolution does not hang if one signal is missed.
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

/**
 * Purpose: Resolve the host path to mount for dockerized compilation.
 * How: Maps the in-container session path back to configured host sessions directory when available, then normalizes for Docker Desktop.
 */
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

/**
 * Purpose: Normalize a filesystem path to POSIX format for stable prefix checks.
 * How: Converts backslashes to slashes and applies `path.posix.normalize`.
 */
function normalizePosix(input: string): string {
  const slashed = input.replace(/\\/g, '/');
  return path.posix.normalize(slashed);
}

/**
 * Purpose: Determine whether one normalized path is inside another.
 * How: Checks exact equality or a slash-prefixed subtree relationship.
 */
function isInTree(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  return candidate.startsWith(`${base}/`);
}

/**
 * Purpose: Join a host base path and relative path while preserving platform conventions.
 * How: Uses explicit Windows-drive handling and POSIX joining for other paths.
 */
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

/**
 * Purpose: Convert Windows absolute paths to Docker Desktop mount-compatible paths.
 * How: Rewrites `C:\\...` style paths to `/run/desktop/mnt/host/c/...` and leaves non-Windows paths unchanged.
 */
function toDockerDesktopHostPath(input: string): string {
  const winMatch = WINDOWS_ABS_PATH_RE.exec(input);
  if (!winMatch) {
    return input;
  }
  const drive = winMatch[1].toLowerCase();
  const rest = winMatch[2].replace(/\\/g, '/');
  return `/run/desktop/mnt/host/${drive}/${rest}`;
}

/**
 * Purpose: Run a lightweight docker command with timeout and merged output capture.
 * How: Spawns `docker`, collects stdout/stderr, enforces timeout kill, and returns trimmed output plus timeout flag.
 */
function runDockerSimple(args: string[], timeoutMs: number): Promise<{ output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;

    const proc = spawn('docker', args);

    /**
     * Purpose: Complete one simple docker command execution.
     * How: Clears timer, guards against double completion, and resolves with captured output metadata.
     */
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
 * Purpose: Retrieve and cache Faust compiler version text.
 * How: Executes `docker run ... -v`, extracts first output line, truncates display length, and memoizes result.
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
 * Purpose: Retrieve and cache Faust compiler help text.
 * How: Executes `docker run ... -h`, captures combined output, and memoizes full help payload.
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
 * Purpose: Analyze a Faust source and generate all primary session artifacts.
 * How: Runs a main compilation pass for C++/SVG/signals, persists errors, then runs an optional tasks graph pass.
 */
export async function analyzeFaust(
  sessionPath: string,
  filename: string
): Promise<{ success: boolean; errors: string }> {
  // Main blocking pass: C++, SVG, and signals graph.
  // Artifacts are written in /tmp (the mounted session root).
  const analyzeArgs = [
    '-o', 'generated.cpp',
    '-svg',
    '-sg'
  ];

  const result = await runFaustDocker(sessionPath, filename, analyzeArgs);

  // Persist compiler diagnostics in errors.log.
  const errorsPath = path.join(sessionPath, 'errors.log');
  fs.writeFileSync(errorsPath, result.stderr, 'utf8');

  // Move artifacts generated by the main pass.
  if (result.success) {
    moveSvgFiles(sessionPath, filename);
    moveDotFile(sessionPath, filename, '-sig.dot', 'signals.dot');

    // Non-blocking tasks pass: requires -vec with -tg.
    // Keep session usable even if tasks graph generation fails.
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

/**
 * Purpose: Parse free-form Faust compiler flags into argument tokens.
 * How: Trims the incoming text and splits on whitespace.
 */
function parseFaustFlags(flags: string): string[] {
  const text = String(flags || '').trim();
  if (!text) return [];
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Purpose: Compile only the generated C++ output with custom Faust flags.
 * How: Parses user-provided flags, appends C++ output target, and runs dockerized Faust compilation.
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
 * Purpose: Relocate generated SVG artifacts to the canonical session `svg/` folder.
 * How: Copies every `.svg` from Faust output directory and removes the temporary source folder.
 */
function moveSvgFiles(sessionPath: string, filename: string): void {
  const sourcecodePath = path.join(sessionPath, 'sourcecode');
  const svgDestDir = path.join(sessionPath, 'svg');

  // Faust writes SVG files into `<filename>-svg/` under sourcecode/.
  const baseName = filename.replace('.dsp', '');
  const svgSourceDir = path.join(sourcecodePath, `${baseName}-svg`);

  try {
    if (fs.existsSync(svgSourceDir)) {
      // Ensure destination directory exists.
      fs.mkdirSync(svgDestDir, { recursive: true });

      // Copy every SVG artifact.
      const files = fs.readdirSync(svgSourceDir);
      for (const file of files) {
        if (file.endsWith('.svg')) {
          const srcFile = path.join(svgSourceDir, file);
          const destFile = path.join(svgDestDir, file);
          fs.copyFileSync(srcFile, destFile);
        }
      }

      // Remove temporary source directory.
      fs.rmSync(svgSourceDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore artifact move failures.
  }
}

/**
 * Purpose: Move one generated DOT graph to a stable session-level destination file.
 * How: Tries known source locations, copies first existing candidate, and leaves silently on failures.
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
    // Ignore artifact move failures.
  }
}

/**
 * Purpose: Compile one Faust source file into WebAssembly assets.
 * How: Ensures `wasm/` exists, runs Faust with `-lang wasm`, and returns compile status and diagnostics.
 */
export async function compileFaustWasm(
  sessionPath: string,
  filename: string
): Promise<{ success: boolean; errors: string }> {
  // Ensure wasm output directory exists.
  const wasmDir = path.join(sessionPath, 'wasm');
  fs.mkdirSync(wasmDir, { recursive: true });

  // WASM compilation arguments.
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
 * Purpose: Compile one Faust source file into runtime WebAssembly assets (`wasm-i`).
 * How: Ensures `wasm/` exists, runs Faust with `-lang wasm-i`, and returns compile status and diagnostics.
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
 * Purpose: Generate a PWA webapp bundle from one Faust source.
 * How: Reuses existing webapp when present, otherwise executes `npx faust2wasm-ts` in source directory and validates output.
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

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface ArchiveHelperOptions {
  osTmpFallback?: () => string;
}

export interface ArchiveResult {
  success: boolean;
  errors: string;
  archivePath?: string;
}

/**
 * Purpose: Build reusable tar.gz archive helpers for route modules.
 * How: Returns directory archiving functions backed by `tar` with Python fallback.
 */
export function createArchiveHelpers(_options: ArchiveHelperOptions = {}) {
  /**
   * Purpose: Archive a session subdirectory to `tar.gz`.
   * How: Validates source directory existence and delegates archive creation to shared tar helpers.
   */
  async function tarGzDirectory(
    sessionPath: string,
    dirName: string,
    outFile: string
  ): Promise<ArchiveResult> {
    const dirPath = path.join(sessionPath, dirName);
    if (!fs.existsSync(dirPath)) {
      return { success: false, errors: 'Directory not found' };
    }

    const archivePath = path.join(sessionPath, outFile);
    const archived = await createTarGzArchive(sessionPath, archivePath, dirName);
    if (!archived.success || !fs.existsSync(archivePath)) {
      return { success: false, errors: archived.errors || 'Archive failed' };
    }
    return { success: true, errors: '', archivePath };
  }

  /**
   * Purpose: Archive a full directory tree into one `tar.gz` file.
   * How: Invokes the generic archive creator with `.` target path.
   */
  async function tarGzFromDirectory(
    sourceDir: string,
    outArchivePath: string
  ): Promise<{ success: boolean; errors: string }> {
    return createTarGzArchive(sourceDir, outArchivePath, '.');
  }

  return {
    tarGzDirectory,
    tarGzFromDirectory
  };
}

/**
 * Purpose: Create a `tar.gz` archive with robust fallback behavior.
 * How: Tries native `tar` first and falls back to Python `tarfile` when `tar` is unavailable.
 */
async function createTarGzArchive(
  cwd: string,
  outArchivePath: string,
  targetPath: string
): Promise<{ success: boolean; errors: string }> {
  const tarCmd = await runTarCommand(cwd, outArchivePath, targetPath);
  if (tarCmd.success) {
    return tarCmd;
  }
  if (!tarCmd.notFound) {
    return tarCmd;
  }

  // Fallback when `tar` is not installed.
  return runPythonTar(cwd, outArchivePath, targetPath);
}

/**
 * Purpose: Run native `tar` archiving command.
 * How: Spawns `tar -czf`, captures stderr, checks output file existence, and reports command-not-found explicitly.
 */
async function runTarCommand(
  cwd: string,
  outArchivePath: string,
  targetPath: string
): Promise<{ success: boolean; errors: string; notFound?: boolean }> {
  return new Promise((resolve) => {
    const args = ['-czf', outArchivePath, targetPath];
    const proc = spawn('tar', args, { cwd });
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outArchivePath)) {
        resolve({ success: false, errors: stderr || 'tar failed' });
        return;
      }
      resolve({ success: true, errors: '' });
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err && err.code === 'ENOENT') {
        resolve({ success: false, errors: 'tar command not found', notFound: true });
        return;
      }
      resolve({ success: false, errors: `tar error: ${err.message}` });
    });
  });
}

/**
 * Purpose: Create a `tar.gz` archive using Python fallback runtime.
 * How: Executes an inline `python3` script relying on `tarfile` and validates archive output.
 */
async function runPythonTar(
  cwd: string,
  outArchivePath: string,
  targetPath: string
): Promise<{ success: boolean; errors: string }> {
  return new Promise((resolve) => {
    const pythonCode = [
      'import os, sys, tarfile',
      'base = sys.argv[1]',
      'out_path = sys.argv[2]',
      'target = sys.argv[3]',
      "target_path = os.path.normpath(os.path.join(base, target))",
      'if not os.path.exists(target_path):',
      "    print('Target not found', file=sys.stderr)",
      '    sys.exit(2)',
      "tf = tarfile.open(out_path, 'w:gz')",
      'if os.path.isfile(target_path):',
      '    rel = os.path.relpath(target_path, base)',
      '    tf.add(target_path, arcname=rel)',
      'else:',
      '    rel = os.path.relpath(target_path, base)',
      '    tf.add(target_path, arcname=rel)',
      'tf.close()'
    ].join('; ');
    const proc = spawn('python3', ['-c', pythonCode, cwd, outArchivePath, targetPath], { cwd });
    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outArchivePath)) {
        resolve({ success: false, errors: stderr || 'tar.gz failed (python fallback)' });
        return;
      }
      resolve({ success: true, errors: '' });
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err && err.code === 'ENOENT') {
        resolve({ success: false, errors: 'Neither tar nor python3 is available to create archives' });
        return;
      }
      resolve({ success: false, errors: `Python tar error: ${err.message}` });
    });
  });
}

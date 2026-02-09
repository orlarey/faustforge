import * as fs from 'fs/promises';
import * as path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const DEFAULT_FAUSTWASM_LIBFAUST_JS = (() => {
  try {
    return require.resolve('@grame/faustwasm/libfaust-wasm/libfaust-wasm.js');
  } catch {
    return null;
  }
})();

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function fsExistsInFaustWasm(faustFs, vfsPath) {
  try {
    const info = faustFs.analyzePath(vfsPath);
    if (info && info.exists) return true;
  } catch {
    // noop
  }
  try {
    faustFs.stat(vfsPath);
    return true;
  } catch {
    return false;
  }
}

function readTextFromFaustWasm(faustFs, vfsPath) {
  const content = faustFs.readFile(vfsPath, { encoding: 'utf8' });
  return typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
}

function findStdfaustPathInFaustWasm(faustFs, candidates) {
  for (const candidate of candidates) {
    if (fsExistsInFaustWasm(faustFs, candidate)) return candidate;
  }
  return null;
}

function parseLibraryDirectives(source) {
  const directives = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*library\("([^"]+)"\)\s*;/g;
  let m = null;
  while ((m = re.exec(source)) !== null) {
    directives.push({ alias: m[1], file: m[2] });
  }
  return directives;
}

function parseSymbolHeader(line) {
  const m = line.match(/^\/\/-+\s*`([^`]+)`\s*-+/);
  if (!m) return null;
  const header = m[1].trim();
  const p = header.match(/^\(([^)]+)\)\s*(.+)$/);
  if (p) {
    const alias = p[1].replace(/\.$/, '').trim();
    const name = p[2].trim();
    return { header, alias, name };
  }
  return { header, alias: null, name: header.trim() };
}

function extractDocBlock(lines, startIndex) {
  const headerInfo = parseSymbolHeader(lines[startIndex] || '');
  if (!headerInfo) return null;
  let i = startIndex + 1;
  const body = [];
  while (i < lines.length) {
    const line = lines[i];
    if (parseSymbolHeader(line)) break;
    if (!line.trim().startsWith('//')) {
      if (line.trim() === '') {
        i += 1;
        continue;
      }
      break;
    }
    body.push(line.replace(/^\/\/\s?/, ''));
    i += 1;
  }
  return { headerInfo, body, endIndex: i - 1 };
}

function parseDocBody(bodyLines) {
  const summaryLines = [];
  let usage = null;
  const params = [];
  let testCode = null;
  let section = 'summary';
  let inFence = false;
  const fenceBuffer = [];
  const usageBuffer = [];

  const flushFence = () => {
    if (section === 'test') {
      const text = fenceBuffer.join('\n').trim();
      if (text) testCode = text;
    } else if (section === 'usage') {
      for (const l of fenceBuffer) {
        const t = l.trim();
        if (!t) continue;
        usageBuffer.push(t);
      }
    }
    fenceBuffer.length = 0;
  };

  for (const raw of bodyLines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith('#### ')) {
      if (inFence) {
        flushFence();
        inFence = false;
      }
      const title = trimmed.slice(5).toLowerCase();
      if (title.startsWith('usage')) section = 'usage';
      else if (title.startsWith('test')) section = 'test';
      else section = 'other';
      continue;
    }
    if (/^where\s*:?\s*$/i.test(trimmed)) {
      section = 'where';
      continue;
    }
    if (trimmed.startsWith('```')) {
      if (!inFence) {
        inFence = true;
      } else {
        flushFence();
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      fenceBuffer.push(line);
      continue;
    }
    if (section === 'summary') {
      if (trimmed) summaryLines.push(trimmed);
      continue;
    }
    if (section === 'usage') {
      if (trimmed) usageBuffer.push(trimmed);
      continue;
    }
    if (section === 'where') {
      const p = trimmed.match(/^\*\s*`([^`]+)`\s*:\s*(.+)$/);
      if (p) {
        params.push({ name: p[1].trim(), description: p[2].trim() });
      }
    }
  }
  if (usageBuffer.length > 0) {
    usage = usageBuffer.find((l) => l.includes(':')) || usageBuffer[0];
  }
  return {
    summary: summaryLines.join(' ').trim(),
    usage: usage || null,
    params,
    testCode
  };
}

function parseUsageIo(usage) {
  if (!usage || typeof usage !== 'string') return { inSignals: null, outSignals: null, raw: usage || null };
  const [lhs, rhs] = usage.split(':').map((s) => s.trim());
  const countSignals = (expr) => {
    if (!expr) return null;
    if (expr === '_') return 1;
    if (expr === '!') return 0;
    if (expr.includes(',')) return expr.split(',').length;
    return 1;
  };
  return {
    inSignals: countSignals(lhs),
    outSignals: countSignals(rhs),
    raw: usage
  };
}

export async function buildFaustDocIndexFromFaustWasm(options = {}) {
  const libFaustJsPath = options.libFaustJsPath || process.env.FAUSTWASM_LIBFAUST_JS || DEFAULT_FAUSTWASM_LIBFAUST_JS;
  if (!libFaustJsPath) {
    throw new Error('Cannot resolve @grame/faustwasm libfaust-wasm.js path');
  }

  const stdlibCandidates = (
    options.stdlibCandidates || [
      process.env.FAUST_STDLIB_PATH,
      '/usr/share/faust/stdfaust.lib',
      '/usr/local/share/faust/stdfaust.lib'
    ]
  ).filter(Boolean);

  const faustwasm = await import('@grame/faustwasm/dist/esm/index.js');
  const module = await faustwasm.instantiateFaustModuleFromFile(libFaustJsPath);
  const compiler = new faustwasm.FaustCompiler(new faustwasm.LibFaust(module));
  const faustFs = compiler.fs();

  const stdlibPath = findStdfaustPathInFaustWasm(faustFs, stdlibCandidates);
  if (!stdlibPath) {
    throw new Error('Faust stdlib not found in faustwasm virtual FS (expected /usr/share/faust/stdfaust.lib).');
  }

  const rootDir = path.posix.dirname(stdlibPath);
  const visited = new Set();
  const queue = [stdlibPath];
  const aliasHints = new Map();
  const libraries = [];
  const symbols = [];

  while (queue.length > 0) {
    const filePath = queue.shift();
    const normalized = normalizePath(filePath);
    if (visited.has(normalized)) continue;
    visited.add(normalized);
    if (!fsExistsInFaustWasm(faustFs, filePath)) continue;

    const source = readTextFromFaustWasm(faustFs, filePath);
    const lines = source.split(/\r?\n/);
    const fileName = path.posix.basename(filePath);
    const directives = parseLibraryDirectives(source);
    for (const d of directives) {
      const target = path.posix.resolve(rootDir, d.file);
      const rel = normalizePath(path.posix.basename(d.file));
      if (!aliasHints.has(rel)) aliasHints.set(rel, new Set());
      aliasHints.get(rel).add(d.alias);
      if (fsExistsInFaustWasm(faustFs, target)) {
        queue.push(target);
      }
    }

    const libSymbols = [];
    for (let i = 0; i < lines.length; i++) {
      const block = extractDocBlock(lines, i);
      if (!block) continue;
      i = block.endIndex;
      const body = parseDocBody(block.body);
      if (!block.headerInfo.name) continue;
      const moduleName = fileName.replace(/\.lib$/i, '');
      const aliasFromHeader = block.headerInfo.alias;
      const hintedAliases = Array.from(aliasHints.get(fileName) || []);
      const alias = aliasFromHeader || hintedAliases[0] || moduleName;
      const io = parseUsageIo(body.usage);
      const symbol = {
        id: `${moduleName}.${block.headerInfo.name}`,
        name: block.headerInfo.name,
        qualifiedName: `${alias}.${block.headerInfo.name}`,
        header: block.headerInfo.header,
        summary: body.summary,
        usage: body.usage,
        params: body.params,
        io,
        testCode: body.testCode,
        tags: [moduleName],
        source: {
          file: fileName,
          lineStart: i - block.body.length,
          lineEnd: block.endIndex + 1
        }
      };
      libSymbols.push(symbol);
      symbols.push(symbol);
    }
    libraries.push({
      file: fileName,
      aliasHints: Array.from(aliasHints.get(fileName) || []),
      symbols: libSymbols
    });
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rootLib: path.posix.basename(stdlibPath),
    rootLibPath: stdlibPath,
    libraries,
    symbols
  };
}

export async function loadFaustDocIndexFromFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.symbols) || !Array.isArray(parsed.libraries)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeFaustDocIndexToFile(index, filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(index), 'utf8');
}

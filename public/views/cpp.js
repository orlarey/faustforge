/**
 * Vue Code C++
 * Affiche le code C++ généré avec numéros de ligne et coloration syntaxique
 * Inspiré de faustservice
 */

export function getName() {
  return 'C++ Code';
}

// Mots-clés C++
const CPP_KEYWORDS = [
  'class', 'struct', 'public', 'private', 'protected',
  'virtual', 'static', 'const', 'constexpr', 'inline',
  'int', 'float', 'double', 'void', 'char', 'bool',
  'long', 'short', 'unsigned', 'signed', 'auto',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'return', 'default', 'goto',
  'namespace', 'using', 'template', 'typename', 'typedef',
  'new', 'delete', 'this', 'nullptr', 'true', 'false',
  'try', 'catch', 'throw', 'noexcept',
  'sizeof', 'alignof', 'decltype', 'explicit',
  'override', 'final', 'enum', 'union'
];

/**
 * Applique la coloration syntaxique C++ en utilisant des tokens
 */
function highlightCpp(code) {
  const tokens = [];
  let tokenId = 0;

  // Fonction pour créer un placeholder unique
  function placeholder(html) {
    const id = `__TOKEN_${tokenId++}__`;
    tokens.push({ id, html });
    return id;
  }

  // Échapper HTML d'abord
  let result = escapeHtml(code);

  // 1. Commentaires // (les protéger en premier)
  result = result.replace(/(\/\/[^\n]*)/g, (match) => {
    return placeholder(`<span class="cpp-comment">${match}</span>`);
  });

  // 2. Commentaires /* */
  result = result.replace(/(\/\*[\s\S]*?\*\/)/g, (match) => {
    return placeholder(`<span class="cpp-comment">${match}</span>`);
  });

  // 3. Directives préprocesseur #include, #define, etc.
  result = result.replace(/(#\s*\w+[^\n]*)/g, (match) => {
    return placeholder(`<span class="cpp-preprocessor">${match}</span>`);
  });

  // 4. Chaînes de caractères
  result = result.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
    return placeholder(`<span class="cpp-string">${match}</span>`);
  });

  // 5. Caractères
  result = result.replace(/('(?:[^'\\]|\\.)')/g, (match) => {
    return placeholder(`<span class="cpp-string">${match}</span>`);
  });

  // 6. Nombres (entiers, flottants, hex)
  result = result.replace(/\b(0x[0-9a-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?[fFlL]?)\b/g, (match) => {
    return placeholder(`<span class="cpp-number">${match}</span>`);
  });

  // 7. Mots-clés
  const keywordPattern = new RegExp(`\\b(${CPP_KEYWORDS.join('|')})\\b`, 'g');
  result = result.replace(keywordPattern, (match) => {
    return placeholder(`<span class="cpp-keyword">${match}</span>`);
  });

  // 8. Types personnalisés (commencent par majuscule)
  result = result.replace(/\b([A-Z][a-zA-Z0-9_]*)\b/g, (match) => {
    return placeholder(`<span class="cpp-type">${match}</span>`);
  });

  // Restaurer tous les tokens
  for (const token of tokens) {
    result = result.replace(token.id, token.html);
  }

  return result;
}

/**
 * Échappe les caractères HTML
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Génère les numéros de ligne
 */
function generateLineNumbers(lineCount) {
  const lines = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(i);
  }
  return lines.join('\n');
}

const CPP_PRESETS_STORAGE_KEY = 'faustforge.cpp.presets.v1';
const cppFlagsBySha = Object.create(null);

function normalizeFlags(input) {
  return String(input || '').trim().replace(/\s+/g, ' ');
}

function loadCppPresets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CPP_PRESETS_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => ({
        flags: normalizeFlags(x?.flags || ''),
        status: x?.status === 'invalid' ? 'invalid' : 'valid',
        lastUsedAt: Number.isFinite(Number(x?.lastUsedAt)) ? Number(x.lastUsedAt) : 0
      }))
      .filter((x) => x.flags.length > 0);
  } catch {
    return [];
  }
}

function saveCppPresets(presets) {
  try {
    localStorage.setItem(CPP_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // ignore storage issues
  }
}

function upsertCppPreset(presets, flags, status, lastUsedAt = Date.now()) {
  const norm = normalizeFlags(flags);
  if (!norm) return presets;
  const idx = presets.findIndex((p) => p.flags === norm);
  if (idx >= 0) {
    presets[idx] = {
      ...presets[idx],
      status,
      lastUsedAt
    };
    return presets;
  }
  presets.push({ flags: norm, status, lastUsedAt });
  return presets;
}

function getValidPresetsSorted(presets) {
  return presets
    .filter((p) => p.status === 'valid' && p.flags)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

async function fetchCppCode(sha) {
  const response = await fetch(`/api/${sha}/generated.cpp`);
  if (!response.ok) {
    if (response.status === 404) {
      return { ok: false, empty: true, code: '' };
    }
    throw new Error('Failed to load C++ code');
  }
  return { ok: true, empty: false, code: await response.text() };
}

async function compileCppWithFlags(sha, flags) {
  const response = await fetch(`/api/${sha}/compile/cpp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flags })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'C++ compilation failed');
  }
}

async function fetchFaustHelp() {
  const response = await fetch('/api/faust/help');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Failed to load Faust help');
  }
  return String(data.help || 'Faust help unavailable');
}

export async function render(container, { sha, scrollState, onScrollChange }) {
  try {
    let presets = loadCppPresets();
    const appliedFlags = normalizeFlags(cppFlagsBySha[sha] || '');
    cppFlagsBySha[sha] = appliedFlags;
    const cpp = await fetchCppCode(sha);
    if (!cpp.ok) {
      container.innerHTML = `<div class="info">C++ code not available (compilation error?)</div>`;
      return;
    }
    const code = cpp.code;
    const lines = code.split('\n');
    const lineCount = lines.length;
    const validPresets = getValidPresetsSorted(presets);
    const otherPresets = validPresets.filter((p) => p.flags && p.flags !== appliedFlags);
    const presetParts = [
      '<button class="code-preset-item code-preset-item-default" type="button" data-flags="">No options (default)</button>'
    ];
    if (appliedFlags) {
      presetParts.push(
        `<button class="code-preset-item code-preset-item-current" type="button" data-flags="${escapeHtml(appliedFlags)}">${escapeHtml(appliedFlags)} (current)</button>`
      );
    }
    presetParts.push(
      ...otherPresets.map(
        (p) =>
          `<button class="code-preset-item" type="button" data-flags="${escapeHtml(p.flags)}">${escapeHtml(p.flags)}</button>`
      )
    );
    if (otherPresets.length === 0 && !appliedFlags) {
      presetParts.push('<div class="code-preset-empty">No custom presets yet</div>');
    }
    const presetOptions = presetParts.join('');

    container.innerHTML = `
      <div class="code-view">
        <div class="code-toolbar">
          <span class="code-toolbar-title">C++ CODE</span>
          <div class="code-toolbar-controls">
            <div class="code-zoom-group code-flags-group">
              <span class="code-zoom-label">Flags</span>
              <div class="code-flags-combo">
                <input class="code-flags-input" value="${escapeHtml(appliedFlags)}" placeholder="-vec -lv 1" />
                <button class="code-preset-toggle" type="button" aria-label="Show presets">▾</button>
                <div class="code-preset-menu hidden">${presetOptions}</div>
              </div>
            </div>
            <button class="primary-btn code-flags-help" type="button">Help</button>
            <div class="code-zoom-group">
              <span class="code-zoom-label">Zoom</span>
              <select class="code-zoom-select" aria-label="C++ code zoom">
                <option value="50">50%</option>
                <option value="75">75%</option>
                <option value="100" selected>100%</option>
                <option value="125">125%</option>
                <option value="150">150%</option>
                <option value="200">200%</option>
              </select>
            </div>
          </div>
        </div>
        <div class="code-flags-status"></div>
        <div class="code-help-panel hidden">
          <div class="code-help-header">
            <span>Faust compiler options (faust -h)</span>
            <button class="code-help-close" type="button">Close</button>
          </div>
          <pre class="code-help-content"></pre>
        </div>
        <div class="code-editor">
          <div class="line-numbers">${generateLineNumbers(lineCount)}</div>
          <div class="code-content">${highlightCpp(code)}</div>
        </div>
      </div>
    `;

    // Synchroniser le scroll
    const lineNumbers = container.querySelector('.line-numbers');
    const codeContent = container.querySelector('.code-content');
    const flagsInput = container.querySelector('.code-flags-input');
    const presetToggle = container.querySelector('.code-preset-toggle');
    const presetMenu = container.querySelector('.code-preset-menu');
    const flagsHelp = container.querySelector('.code-flags-help');
    const flagsStatus = container.querySelector('.code-flags-status');
    const helpPanel = container.querySelector('.code-help-panel');
    const helpContent = container.querySelector('.code-help-content');
    const helpClose = container.querySelector('.code-help-close');

    const zoomSelect = container.querySelector('.code-zoom-select');
    const baseLineNumbersFontSize = parseFloat(getComputedStyle(lineNumbers).fontSize) || 14;
    const baseCodeFontSize = parseFloat(getComputedStyle(codeContent).fontSize) || 14;

    let lineHeight =
      (lineNumbers.scrollHeight && lineCount
        ? lineNumbers.scrollHeight / lineCount
        : parseFloat(getComputedStyle(codeContent).lineHeight)) || 16;
    const scroller = codeContent;
    let restoring = true;

    const syncScroll = () => {
      if (scroller === codeContent) {
        lineNumbers.scrollTop = codeContent.scrollTop;
      }
    };

    const getTopLine = () => Math.floor(codeContent.scrollTop / lineHeight) + 1;

    const capture = () => {
      if (restoring) return;
      if (typeof onScrollChange === 'function') {
        onScrollChange(getTopLine());
      }
    };

    scroller.addEventListener('scroll', () => {
      syncScroll();
      capture();
    });

    const applyTopLine = (line) => {
      if (typeof line !== 'number') return;
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      const target = Math.max(0, Math.min(maxScroll, (line - 1) * lineHeight));

      const applyWithCorrection = (attempt = 0) => {
        codeContent.scrollTop = target;
        syncScroll();
        requestAnimationFrame(() => {
          const currentTop = getTopLine();
          const diff = line - currentTop;
          if (diff !== 0 && attempt < 3) {
            const corrected = Math.max(
              0,
              Math.min(maxScroll, codeContent.scrollTop + diff * lineHeight)
            );
            codeContent.scrollTop = corrected;
            syncScroll();
            requestAnimationFrame(() => applyWithCorrection(attempt + 1));
            return;
          }
        });
      };

      applyWithCorrection();
    };

    const refreshLineHeight = () => {
      lineHeight =
        (lineNumbers.scrollHeight && lineCount
          ? lineNumbers.scrollHeight / lineCount
          : parseFloat(getComputedStyle(codeContent).lineHeight)) || lineHeight || 16;
    };

    const applyZoom = (zoom) => {
      const factor = Math.max(50, Math.min(200, Number(zoom) || 100)) / 100;
      const topLine = getTopLine();
      lineNumbers.style.fontSize = `${(baseLineNumbersFontSize * factor).toFixed(2)}px`;
      codeContent.style.fontSize = `${(baseCodeFontSize * factor).toFixed(2)}px`;
      refreshLineHeight();
      applyTopLine(topLine);
    };

    if (zoomSelect) {
      zoomSelect.addEventListener('change', () => applyZoom(parseInt(zoomSelect.value, 10)));
    }
    applyZoom(100);

    const setFlagsStatus = (text, isError = false) => {
      if (!flagsStatus) return;
      flagsStatus.textContent = text || '';
      flagsStatus.style.color = isError ? '#ff7a7a' : '';
    };

    const applyFlags = async (options = {}) => {
      const force = options && options.force === true;
      if (!flagsInput) return;
      const nextFlags = normalizeFlags(flagsInput.value);
      if (!force && nextFlags === cppFlagsBySha[sha]) {
        setFlagsStatus('Already applied.');
        return;
      }
      const existing = presets.find((p) => p.flags === nextFlags);
      if (existing && existing.status === 'invalid') {
        setFlagsStatus('This preset is marked invalid. Edit flags before applying.', true);
        return;
      }
      setFlagsStatus('Compiling...');
      try {
        await compileCppWithFlags(sha, nextFlags);
        cppFlagsBySha[sha] = nextFlags;
        presets = upsertCppPreset(presets, nextFlags, 'valid', Date.now());
        saveCppPresets(presets);
        await render(container, { sha, scrollState: { line: getTopLine() }, onScrollChange });
      } catch (err) {
        presets = upsertCppPreset(presets, nextFlags, 'invalid', Date.now());
        saveCppPresets(presets);
        const message = err && err.message ? err.message : String(err);
        setFlagsStatus(message, true);
      }
    };

    if (presetToggle && presetMenu) {
      presetToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        presetMenu.classList.toggle('hidden');
      });
      presetMenu.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const item = target.closest('.code-preset-item');
        if (!item || !flagsInput) return;
        const selected = normalizeFlags(item.getAttribute('data-flags') || '');
        const force = item.classList.contains('code-preset-item-default');
        flagsInput.value = selected;
        presetMenu.classList.add('hidden');
        void applyFlags({ force });
      });
      container.addEventListener('click', (event) => {
        if (!(event.target instanceof HTMLElement)) return;
        if (event.target.closest('.code-flags-combo')) return;
        presetMenu.classList.add('hidden');
      });
    }
    if (flagsInput) {
      flagsInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void applyFlags();
      });
    }

    if (flagsHelp && helpPanel && helpContent) {
      flagsHelp.addEventListener('click', async () => {
        if (!helpPanel.classList.contains('hidden')) {
          helpPanel.classList.add('hidden');
          return;
        }
        helpPanel.classList.remove('hidden');
        if (helpContent.textContent && helpContent.textContent.trim()) return;
        helpContent.textContent = 'Loading...';
        try {
          helpContent.textContent = await fetchFaustHelp();
        } catch (err) {
          helpContent.textContent = err && err.message ? err.message : String(err);
        }
      });
    }
    if (helpClose && helpPanel) {
      helpClose.addEventListener('click', () => {
        helpPanel.classList.add('hidden');
      });
    }

    if (scrollState && typeof scrollState.line === 'number') {
      let attempts = 0;
      const settle = () => {
        attempts += 1;
        if (codeContent.scrollHeight > codeContent.clientHeight || attempts >= 5) {
          applyTopLine(scrollState.line);
          requestAnimationFrame(() => {
            restoring = false;
          });
          return;
        }
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    } else {
      restoring = false;
    }

  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}

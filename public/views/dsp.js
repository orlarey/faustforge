/**
 * Vue Code DSP
 * Affiche le code source Faust avec numéros de ligne et coloration syntaxique
 * Inspiré de faustservice
 */

export function getName() {
  return 'DSP Code';
}

// Mots-clés Faust
const FAUST_KEYWORDS = [
  'import', 'declare', 'process', 'with', 'letrec', 'where',
  'library', 'component', 'environment', 'inputs', 'outputs',
  'ffunction', 'fvariable', 'fconstant', 'int', 'float',
  'case', 'seq', 'par', 'sum', 'prod'
];

// Fonctions Faust courantes
const FAUST_FUNCTIONS = [
  'button', 'checkbox', 'hslider', 'vslider', 'nentry',
  'hgroup', 'vgroup', 'tgroup', 'hbargraph', 'vbargraph',
  'attach', 'mem', 'prefix', 'rdtable', 'rwtable',
  'select2', 'select3', 'fmod', 'remainder',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'exp', 'log', 'log10', 'pow', 'sqrt', 'abs',
  'min', 'max', 'fmod', 'floor', 'ceil', 'rint'
];

/**
 * Applique la coloration syntaxique Faust en utilisant des tokens
 */
function highlightFaust(code) {
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
    return placeholder(`<span class="faust-comment">${match}</span>`);
  });

  // 2. Chaînes de caractères
  result = result.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
    return placeholder(`<span class="faust-string">${match}</span>`);
  });

  // 3. Nombres
  result = result.replace(/\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi, (match) => {
    return placeholder(`<span class="faust-number">${match}</span>`);
  });

  // 4. Mots-clés
  const keywordPattern = new RegExp(`\\b(${FAUST_KEYWORDS.join('|')})\\b`, 'g');
  result = result.replace(keywordPattern, (match) => {
    return placeholder(`<span class="faust-keyword">${match}</span>`);
  });

  // 5. Fonctions
  const functionPattern = new RegExp(`\\b(${FAUST_FUNCTIONS.join('|')})\\b`, 'g');
  result = result.replace(functionPattern, (match) => {
    return placeholder(`<span class="faust-function">${match}</span>`);
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

export async function render(container, { sha, scrollState, onScrollChange }) {
  try {
    const response = await fetch(`/api/${sha}/user_code.dsp`);

    if (!response.ok) {
      throw new Error('Failed to load DSP code');
    }

    const code = await response.text();
    const lines = code.split('\n');
    const lineCount = lines.length;

    container.innerHTML = `
      <div class="code-view">
        <div class="code-toolbar">
          <span class="code-toolbar-title">DSP CODE</span>
          <div class="code-toolbar-controls">
            <div class="code-zoom-group">
              <span class="code-zoom-label">Zoom</span>
              <select class="code-zoom-select" aria-label="DSP code zoom">
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
        <div class="code-editor">
          <div class="line-numbers">${generateLineNumbers(lineCount)}</div>
          <div class="code-content">${highlightFaust(code)}</div>
        </div>
      </div>
    `;

    // Synchroniser le scroll
    const lineNumbers = container.querySelector('.line-numbers');
    const codeContent = container.querySelector('.code-content');
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

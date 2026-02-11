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

export async function render(container, { sha, scrollState, onScrollChange }) {
  try {
    const response = await fetch(`/api/${sha}/generated.cpp`);

    if (!response.ok) {
      if (response.status === 404) {
        container.innerHTML = `<div class="info">C++ code not available (compilation error?)</div>`;
        return;
      }
      throw new Error('Failed to load C++ code');
    }

    const code = await response.text();
    const lines = code.split('\n');
    const lineCount = lines.length;

    container.innerHTML = `
      <div class="code-view">
        <div class="code-toolbar">
          <span class="code-toolbar-title">C++ CODE</span>
          <div class="code-toolbar-controls">
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
        <div class="code-editor">
          <div class="line-numbers">${generateLineNumbers(lineCount)}</div>
          <div class="code-content">${highlightCpp(code)}</div>
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

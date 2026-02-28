/**
 * Purpose: Define the DSP source view.
 * How: Fetches `user_code.dsp`, highlights Faust syntax, and renders synchronized line-number scrolling.
 */

/**
 * Purpose: Expose the label used by the global view selector.
 * How: Returns the static display name for this module.
 */
export function getName() {
  return 'DSP Code';
}

// Faust language keywords used by the syntax highlighter.
const FAUST_KEYWORDS = [
  'import', 'declare', 'process', 'with', 'letrec', 'where',
  'library', 'component', 'environment', 'inputs', 'outputs',
  'ffunction', 'fvariable', 'fconstant', 'int', 'float',
  'case', 'seq', 'par', 'sum', 'prod'
];

// Common Faust functions used by the syntax highlighter.
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
 * Purpose: Apply lightweight Faust syntax highlighting on source text.
 * How: Escapes HTML, replaces token categories with placeholders, then restores styled HTML spans.
 */
function highlightFaust(code) {
  const tokens = [];
  let tokenId = 0;

  /**
   * Purpose: Protect highlighted fragments from later regex passes.
   * How: Stores fragment HTML in a token table and returns a unique placeholder marker.
   */
  function placeholder(html) {
    const id = `__TOKEN_${tokenId++}__`;
    tokens.push({ id, html });
    return id;
  }

  // Escape HTML first.
  let result = escapeHtml(code);

  // 1. Line comments (protect first).
  result = result.replace(/(\/\/[^\n]*)/g, (match) => {
    return placeholder(`<span class="faust-comment">${match}</span>`);
  });

  // 2. String literals.
  result = result.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
    return placeholder(`<span class="faust-string">${match}</span>`);
  });

  // 3. Numeric literals.
  result = result.replace(/\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi, (match) => {
    return placeholder(`<span class="faust-number">${match}</span>`);
  });

  // 4. Keywords.
  const keywordPattern = new RegExp(`\\b(${FAUST_KEYWORDS.join('|')})\\b`, 'g');
  result = result.replace(keywordPattern, (match) => {
    return placeholder(`<span class="faust-keyword">${match}</span>`);
  });

  // 5. Built-in functions.
  const functionPattern = new RegExp(`\\b(${FAUST_FUNCTIONS.join('|')})\\b`, 'g');
  result = result.replace(functionPattern, (match) => {
    return placeholder(`<span class="faust-function">${match}</span>`);
  });

  // Restore all placeholder tokens.
  for (const token of tokens) {
    result = result.replace(token.id, token.html);
  }

  return result;
}

/**
 * Purpose: Sanitize plain text before HTML insertion.
 * How: Replaces reserved characters with HTML entities.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Purpose: Build the line-number gutter content.
 * How: Generates numbers from 1..N and joins them with newlines.
 */
function generateLineNumbers(lineCount) {
  const lines = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(i);
  }
  return lines.join('\n');
}

/**
 * Purpose: Render the DSP code pane for one session.
 * How: Loads source code, injects highlighted HTML, and maintains zoom/scroll synchronization state.
 */
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

    // Keep line numbers and code scroll in sync.
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

    /**
     * Purpose: Mirror code scrolling into the line-number gutter.
     * How: Copies the code panel `scrollTop` to the gutter.
     */
    const syncScroll = () => {
      if (scroller === codeContent) {
        lineNumbers.scrollTop = codeContent.scrollTop;
      }
    };

    /**
     * Purpose: Compute which source line is currently at the top of the viewport.
     * How: Converts `scrollTop` to a 1-based line index using measured line height.
     */
    const getTopLine = () => Math.floor(codeContent.scrollTop / lineHeight) + 1;

    /**
     * Purpose: Persist user scroll position to the parent app state.
     * How: Emits the current top line through `onScrollChange` when not restoring state.
     */
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

    /**
     * Purpose: Restore the code view so a given line appears at the top.
     * How: Computes target scroll offset and applies small corrective passes across animation frames.
     */
    const applyTopLine = (line) => {
      if (typeof line !== 'number') return;
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      const target = Math.max(0, Math.min(maxScroll, (line - 1) * lineHeight));

      /**
       * Purpose: Correct residual top-line drift after layout updates.
       * How: Re-reads visible line index and adjusts `scrollTop` for a few bounded attempts.
       */
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

    /**
     * Purpose: Refresh the measured line height used for scroll math.
     * How: Derives it from rendered gutter metrics and falls back to computed styles.
     */
    const refreshLineHeight = () => {
      lineHeight =
        (lineNumbers.scrollHeight && lineCount
          ? lineNumbers.scrollHeight / lineCount
          : parseFloat(getComputedStyle(codeContent).lineHeight)) || lineHeight || 16;
    };

    /**
     * Purpose: Apply editor zoom while preserving reading position.
     * How: Scales font sizes, recomputes line height, then restores the previous top line.
     */
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
      /**
       * Purpose: Wait until layout is stable before restoring saved scroll.
       * How: Retries on animation frames until content becomes scrollable or a max attempt threshold is reached.
       */
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

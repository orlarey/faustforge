/**
 * Purpose: Define the DSP source view.
 * How: Fetches `user_code.dsp`, highlights Faust syntax, and renders synchronized line-number scrolling.
 */
import { escapeHtml, generateLineNumbers } from './shared/text-utils.js';
import { setupCodeEditorInteractions } from './shared/code-editor-view.js';

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

    const lineNumbers = container.querySelector('.line-numbers');
    const codeContent = container.querySelector('.code-content');
    const zoomSelect = container.querySelector('.code-zoom-select');
    setupCodeEditorInteractions({
      lineNumbersEl: lineNumbers,
      codeContentEl: codeContent,
      zoomSelectEl: zoomSelect,
      lineCount,
      scrollState,
      onScrollChange,
      minZoom: 50,
      maxZoom: 200,
      defaultZoom: 100
    });

  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}

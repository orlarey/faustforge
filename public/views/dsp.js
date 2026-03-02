/**
 * Purpose: Define the DSP source view.
 * How: Fetches `user_code.dsp`, highlights Faust syntax, and renders synchronized line-number scrolling.
 */
import { generateLineNumbers, highlightWithRules } from './shared/text-utils.js';
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
 * How: Builds ordered Faust highlight rules and applies them through the shared placeholder-safe highlighter.
 */
function highlightFaust(code) {
  const rules = [];
  rules.push({ pattern: /(\/\/[^\n]*)/g, className: 'faust-comment' });
  rules.push({ pattern: /("(?:[^"\\]|\\.)*")/g, className: 'faust-string' });
  rules.push({ pattern: /\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi, className: 'faust-number' });
  const keywordPattern = new RegExp(`\\b(${FAUST_KEYWORDS.join('|')})\\b`, 'g');
  rules.push({ pattern: keywordPattern, className: 'faust-keyword' });
  const functionPattern = new RegExp(`\\b(${FAUST_FUNCTIONS.join('|')})\\b`, 'g');
  rules.push({ pattern: functionPattern, className: 'faust-function' });
  return highlightWithRules(code, rules, '__FAUST_TOKEN_');
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

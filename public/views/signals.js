/**
 * Purpose: Define the Signals view that displays a Faust signal graph from DOT data.
 * How: Fetches `signals.dot`, renders it through viz.js as SVG, and provides a DOT fallback/editor view.
 */

let vizScriptsPromise = null;
const VIZ_TOTAL_MEMORY = 512 * 1024 * 1024; // 512 MB

/**
 * Purpose: Expose the label used by the global view selector.
 * How: Returns the static display name for this module.
 */
export function getName() {
  return 'Signals';
}

/**
 * Purpose: Sanitize plain text before inserting it in HTML.
 * How: Replaces reserved characters with HTML entities to prevent markup injection.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Purpose: Render DOT source with lightweight syntax highlighting.
 * How: Escapes the source, wraps token classes with placeholders, then restores highlighted HTML spans.
 */
function highlightDot(dot) {
  const tokens = [];
  let tokenId = 0;

  /**
   * Purpose: Protect already-highlighted fragments from later regex passes.
   * How: Stores fragment HTML in a token table and returns a unique placeholder marker.
   */
  function placeholder(html) {
    const id = `__DOT_TOKEN_${tokenId++}__`;
    tokens.push({ id, html });
    return id;
  }

  let result = escapeHtml(dot);

  result = result.replace(/(\/\*[\s\S]*?\*\/)/g, (match) => {
    return placeholder(`<span class="dot-comment">${match}</span>`);
  });

  result = result.replace(/(^\s*#.*$)/gm, (match) => {
    return placeholder(`<span class="dot-comment">${match}</span>`);
  });

  result = result.replace(/(\/\/[^\n]*)/g, (match) => {
    return placeholder(`<span class="dot-comment">${match}</span>`);
  });

  result = result.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
    return placeholder(`<span class="dot-string">${match}</span>`);
  });

  result = result.replace(/\b(strict|graph|digraph|subgraph|node|edge)\b/g, (match) => {
    return placeholder(`<span class="dot-keyword">${match}</span>`);
  });

  result = result.replace(
    /\b(rankdir|rank|label|shape|style|color|fillcolor|fontcolor|fontsize|fontname|penwidth|weight|dir|arrowhead|arrowsize|labelloc|labeljust|splines|constraint|ordering|group|peripheries|margin|width|height|fixedsize)\b/g,
    (match) => {
      return placeholder(`<span class="dot-attr">${match}</span>`);
    }
  );

  result = result.replace(/\b(\d+\.?\d*)\b/g, (match) => {
    return placeholder(`<span class="dot-number">${match}</span>`);
  });

  result = result.replace(/(\-\>|--|=|\{|\}|\[|\]|,|:)/g, (match) => {
    return placeholder(`<span class="dot-operator">${match}</span>`);
  });

  for (const token of tokens) {
    result = result.replace(token.id, token.html);
  }

  return result;
}

/**
 * Purpose: Build the gutter content for DOT line numbers.
 * How: Generates numbers from 1..N and joins them with newlines for a single text block.
 */
function generateLineNumbers(lineCount) {
  const lines = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(i);
  }
  return lines.join('\n');
}

/**
 * Purpose: Render the DOT text panel in editor-like layout.
 * How: Injects line numbers + highlighted code and keeps the number gutter synced on scroll.
 */
function renderDotViewer(dotRoot, dot) {
  const lineCount = dot.split('\n').length;
  dotRoot.innerHTML = `
    <div class="code-editor dot-editor">
      <div class="line-numbers">${generateLineNumbers(lineCount)}</div>
      <div class="code-content">${highlightDot(dot)}</div>
    </div>
  `;
  const lineNumbers = dotRoot.querySelector('.line-numbers');
  const codeContent = dotRoot.querySelector('.code-content');
  codeContent.addEventListener('scroll', () => {
    lineNumbers.scrollTop = codeContent.scrollTop;
  });
}

/**
 * Purpose: Convert viz.js errors into a user-facing message.
 * How: Detects memory/complexity failures and falls back to a concise title/detail structure.
 */
function getRenderFailureMessage(err) {
  const raw =
    err && typeof err === 'object' && 'message' in err ? String(err.message || '') : String(err || '');
  const isTooComplex = /cannot enlarge memory arrays|out of memory|oom|memory/i.test(raw);
  if (isTooComplex) {
    return {
      title: 'Graph too complex to render as SVG.',
      detail: 'DOT source is shown with priority.'
    };
  }
  if (!raw || raw === 'undefined') {
    return {
      title: 'Graph render failed.',
      detail: 'DOT source is shown with priority.'
    };
  }
  return {
    title: 'Graph render failed.',
    detail: raw
  };
}

/**
 * Purpose: Load an external script exactly once.
 * How: Reuses an existing `<script data-src>` when present, otherwise creates one and resolves on load.
 */
async function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) {
      if (existing.getAttribute('data-loaded') === '1') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
        once: true
      });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.src = src;
    script.addEventListener('load', () => {
      script.setAttribute('data-loaded', '1');
      resolve();
    });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
    document.head.appendChild(script);
  });
}

/**
 * Purpose: Ensure viz.js renderer is available before graph rendering.
 * How: Initializes Emscripten memory hints, loads viz scripts once, and returns `window.Viz`.
 */
async function ensureViz() {
  if (window.Viz) return window.Viz;
  if (!vizScriptsPromise) {
    vizScriptsPromise = (async () => {
      // Hint Emscripten runtime to allocate more memory for large DOT graphs.
      if (!window.Module || typeof window.Module !== 'object') {
        window.Module = {};
      }
      if (!window.Module.TOTAL_MEMORY || window.Module.TOTAL_MEMORY < VIZ_TOTAL_MEMORY) {
        window.Module.TOTAL_MEMORY = VIZ_TOTAL_MEMORY;
      }
      await loadScriptOnce('/vendor/viz.js/viz.js');
      await loadScriptOnce('/vendor/viz.js/full.render.js');
      if (!window.Viz) {
        throw new Error('viz.js did not expose Viz');
      }
      return window.Viz;
    })();
  }
  return vizScriptsPromise;
}

/**
 * Purpose: Render the Signals view for the current session.
 * How: Fetches DOT, builds the split UI (graph + source), renders SVG via viz.js, and handles fallbacks.
 */
export async function render(container, { sha, onError, onClearError }) {
  let dot = '';
  try {
    const response = await fetch(`/api/${sha}/signals.dot`);
    if (!response.ok) {
      if (response.status === 404) {
        container.innerHTML = '<div class="info">Signals graph not available</div>';
        return;
      }
      throw new Error('Failed to load signals.dot');
    }
    dot = await response.text();
  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="signals-view">
      <div class="signals-toolbar">
        <span class="signals-toolbar-title">SIGNAL GRAPH</span>
        <div class="signals-toolbar-controls">
          <div class="signals-zoom-group">
            <span class="signals-zoom-label">Zoom</span>
            <select class="signals-zoom-select" aria-label="Signal graph zoom">
              <option value="auto">Auto</option>
              <option value="50">50%</option>
              <option value="75">75%</option>
              <option value="100" selected>100%</option>
              <option value="125">125%</option>
              <option value="150">150%</option>
            </select>
          </div>
          <button class="signals-toggle-split" title="Show/hide split graph and DOT source">Split view</button>
        </div>
      </div>
      <div class="signals-main">
        <div class="signals-container">
          <div class="signals-content"><div class="info">Rendering graph...</div></div>
        </div>
        <div class="signals-splitter hidden" title="Resize graph / DOT"></div>
        <div class="signals-dot hidden"></div>
      </div>
    </div>
  `;

  const content = container.querySelector('.signals-content');
  const dotPre = container.querySelector('.signals-dot');
  const splitter = container.querySelector('.signals-splitter');
  const zoomSelect = container.querySelector('.signals-zoom-select');
  const toggleDotBtn = container.querySelector('.signals-toggle-split');
  const containerEl = container.querySelector('.signals-container');
  const mainEl = container.querySelector('.signals-main');
  let zoom = 100;
  let zoomMode = 'auto';
  let splitPercent = 65;
  let baseWidth = 0;
  let baseHeight = 0;

  renderDotViewer(dotPre, dot);
  /**
   * Purpose: Apply the current split ratio between graph and DOT panels.
   * How: Clamps split percentage and updates panel flex-basis values.
   */
  function applySplit() {
    const safe = Math.max(15, Math.min(85, splitPercent));
    containerEl.style.flex = `0 0 ${safe}%`;
    dotPre.style.flex = '1 1 auto';
  }

  /**
   * Purpose: Toggle split mode visibility for the DOT panel.
   * How: Adds/removes classes and resets flex values depending on current visibility.
   */
  function setDotVisible(visible) {
    if (visible) {
      dotPre.classList.remove('hidden');
      splitter.classList.remove('hidden');
      mainEl.classList.add('split-enabled');
      applySplit();
    } else {
      dotPre.classList.add('hidden');
      splitter.classList.add('hidden');
      mainEl.classList.remove('split-enabled');
      containerEl.style.flex = '1 1 auto';
      dotPre.style.flex = '';
    }
  }

  toggleDotBtn.addEventListener('click', () => {
    setDotVisible(dotPre.classList.contains('hidden'));
  });

  splitter.addEventListener('mousedown', (event) => {
    event.preventDefault();
    /**
     * Purpose: Update split ratio while dragging the splitter.
     * How: Maps pointer Y position to a percentage of the main panel height.
     */
    const onMove = (moveEvent) => {
      const rect = mainEl.getBoundingClientRect();
      if (!rect.height) return;
      splitPercent = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      applySplit();
    };
    /**
     * Purpose: Stop splitter drag behavior after mouse release.
     * How: Removes temporary move/up listeners from the window.
     */
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  /**
   * Purpose: Compute automatic zoom that fits SVG inside available space.
   * How: Measures base SVG size and container size, then returns a bounded fit percentage.
   */
  function computeFitZoom() {
    const svg = content.querySelector('svg');
    if (!svg) return zoom;
    if (!baseWidth || !baseHeight) {
      svg.style.width = '';
      svg.style.height = '';
      const svgRect = svg.getBoundingClientRect();
      baseWidth = svgRect.width;
      baseHeight = svgRect.height;
    }
    const cRect = containerEl.getBoundingClientRect();
    if (!baseWidth || !baseHeight || !cRect.width || !cRect.height) return zoom;
    const widthRatio = (cRect.width - 24) / baseWidth;
    const heightRatio = (cRect.height - 24) / baseHeight;
    const fitRatio = Math.min(widthRatio, heightRatio, 1);
    return Math.max(10, Math.round(fitRatio * 100));
  }

  /**
   * Purpose: Apply current zoom mode to the rendered SVG.
   * How: Resolves auto/manual zoom, scales width/height, and toggles auto-centering styling.
   */
  function applyZoom() {
    const svg = content.querySelector('svg');
    if (!svg) return;
    if (!baseWidth || !baseHeight) {
      svg.style.width = '';
      svg.style.height = '';
      const svgRect = svg.getBoundingClientRect();
      baseWidth = svgRect.width;
      baseHeight = svgRect.height;
    }
    if (zoomMode === 'auto') {
      zoom = computeFitZoom();
    }
    const scale = zoom / 100;
    const nextWidth = Math.max(1, Math.round(baseWidth * scale));
    const nextHeight = Math.max(1, Math.round(baseHeight * scale));
    svg.style.width = `${nextWidth}px`;
    svg.style.height = `${nextHeight}px`;
    content.classList.toggle('signals-auto-centered', zoomMode === 'auto');
  }

  if (zoomSelect) {
    zoomSelect.addEventListener('change', () => {
      if (zoomSelect.value === 'auto') {
        zoomMode = 'auto';
        applyZoom();
        return;
      }
      zoomMode = 'manual';
      const parsed = parseInt(zoomSelect.value, 10);
      zoom = Number.isFinite(parsed) ? parsed : 100;
      applyZoom();
    });
  }

  try {
    const Viz = await ensureViz();
    const viz = new Viz();
    const svg = await viz.renderSVGElement(dot);
    content.innerHTML = '';
    content.appendChild(svg);
    baseWidth = 0;
    baseHeight = 0;
    if (zoomSelect) {
      zoomSelect.value = 'auto';
    }
    zoomMode = 'auto';
    applyZoom();
    if (typeof onClearError === 'function') {
      onClearError();
    }
  } catch (err) {
    const msg = getRenderFailureMessage(err);
    if (typeof onError === 'function') {
      onError(`${msg.title} ${msg.detail}`.trim());
    }
    content.innerHTML = '';
    const main = container.querySelector('.signals-main');
    if (main) {
      main.classList.add('signals-dot-only');
    }
    setDotVisible(true);
    splitter.classList.add('hidden');
  }
}

/**
 * Purpose: Release Signals view resources on teardown.
 * How: No-op because this view currently has no persistent resources to clean up.
 */
export function dispose() {}

/**
 * Vue Tasks (DOT)
 * Rend le graphe de tâches Faust via viz.js
 */

let vizScriptsPromise = null;
const VIZ_TOTAL_MEMORY = 512 * 1024 * 1024; // 512 MB

export function getName() {
  return 'Tasks';
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightDot(dot) {
  const tokens = [];
  let tokenId = 0;

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

function generateLineNumbers(lineCount) {
  const lines = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(i);
  }
  return lines.join('\n');
}

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

export async function render(container, { sha, onError, onClearError }) {
  let dot = '';
  try {
    const response = await fetch(`/api/${sha}/tasks.dot`);
    if (!response.ok) {
      if (response.status === 404) {
        container.innerHTML = '<div class="info">Tasks graph not available</div>';
        return;
      }
      throw new Error('Failed to load tasks.dot');
    }
    dot = await response.text();
  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="tasks-view">
      <div class="tasks-toolbar">
        <span class="tasks-toolbar-title">TASK GRAPH</span>
        <div class="tasks-toolbar-controls">
          <div class="tasks-zoom-group">
            <span class="tasks-zoom-label">Zoom</span>
            <select class="tasks-zoom-select" aria-label="Task graph zoom">
              <option value="auto">Auto</option>
              <option value="50">50%</option>
              <option value="75">75%</option>
              <option value="100" selected>100%</option>
              <option value="125">125%</option>
              <option value="150">150%</option>
            </select>
          </div>
          <button class="tasks-toggle-split" title="Show/hide split graph and DOT source">Split view</button>
        </div>
      </div>
      <div class="tasks-main">
        <div class="tasks-container">
          <div class="tasks-content"><div class="info">Rendering graph...</div></div>
        </div>
        <div class="tasks-splitter hidden" title="Resize graph / DOT"></div>
        <div class="tasks-dot hidden"></div>
      </div>
    </div>
  `;

  const content = container.querySelector('.tasks-content');
  const dotPre = container.querySelector('.tasks-dot');
  const splitter = container.querySelector('.tasks-splitter');
  const zoomSelect = container.querySelector('.tasks-zoom-select');
  const toggleDotBtn = container.querySelector('.tasks-toggle-split');
  const containerEl = container.querySelector('.tasks-container');
  const mainEl = container.querySelector('.tasks-main');
  let zoom = 100;
  let zoomMode = 'auto';
  let splitPercent = 65;
  let baseWidth = 0;
  let baseHeight = 0;

  renderDotViewer(dotPre, dot);
  function applySplit() {
    const safe = Math.max(15, Math.min(85, splitPercent));
    containerEl.style.flex = `0 0 ${safe}%`;
    dotPre.style.flex = '1 1 auto';
  }

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
    const onMove = (moveEvent) => {
      const rect = mainEl.getBoundingClientRect();
      if (!rect.height) return;
      splitPercent = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      applySplit();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

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
    content.classList.toggle('tasks-auto-centered', zoomMode === 'auto');
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
    const main = container.querySelector('.tasks-main');
    if (main) {
      main.classList.add('tasks-dot-only');
    }
    setDotVisible(true);
    splitter.classList.add('hidden');
  }
}

export function dispose() {}

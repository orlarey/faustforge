/**
 * Vue Signaux (DOT)
 * Rend le graphe des signaux Faust via viz.js
 */

let vizScriptsPromise = null;
const VIZ_TOTAL_MEMORY = 512 * 1024 * 1024; // 512 MB

export function getName() {
  return 'Signals';
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

export async function render(container, { sha }) {
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
        <button class="signals-zoom-btn icon-btn" data-zoom="out" title="Zoom -">-</button>
        <span class="signals-zoom-level">100%</span>
        <button class="signals-zoom-btn icon-btn" data-zoom="in" title="Zoom +">+</button>
        <button class="signals-zoom-btn icon-btn" data-zoom="fit" title="Fit to view">Fit</button>
        <div class="spacer"></div>
        <button class="signals-toggle-dot icon-btn" title="Show/hide DOT source">DOT</button>
      </div>
      <div class="signals-main">
        <div class="signals-container">
          <div class="signals-content"><div class="info">Rendering graph...</div></div>
        </div>
        <pre class="signals-dot hidden"></pre>
      </div>
    </div>
  `;

  const viewEl = container.querySelector('.signals-view');
  const content = container.querySelector('.signals-content');
  const dotPre = container.querySelector('.signals-dot');
  const zoomLevel = container.querySelector('.signals-zoom-level');
  const toggleDotBtn = container.querySelector('.signals-toggle-dot');
  const containerEl = container.querySelector('.signals-container');
  let zoom = 100;

  dotPre.textContent = dot;
  toggleDotBtn.addEventListener('click', () => {
    dotPre.classList.toggle('hidden');
  });

  function applyZoom() {
    const svg = content.querySelector('svg');
    if (!svg) return;
    svg.style.transform = `scale(${zoom / 100})`;
    svg.style.transformOrigin = 'top left';
    zoomLevel.textContent = `${zoom}%`;
  }

  function fitToContainer() {
    const svg = content.querySelector('svg');
    if (!svg) return;
    svg.style.transform = 'none';
    const svgRect = svg.getBoundingClientRect();
    const cRect = containerEl.getBoundingClientRect();
    if (!svgRect.width || !svgRect.height) return;
    const widthRatio = (cRect.width - 40) / svgRect.width;
    const heightRatio = (cRect.height - 40) / svgRect.height;
    const fitRatio = Math.min(widthRatio, heightRatio, 1);
    zoom = Math.max(10, Math.round(fitRatio * 100));
    applyZoom();
  }

  container.querySelectorAll('.signals-zoom-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.zoom;
      if (action === 'in') {
        zoom = Math.min(zoom + 25, 400);
        applyZoom();
      } else if (action === 'out') {
        zoom = Math.max(zoom - 25, 10);
        applyZoom();
      } else if (action === 'fit') {
        fitToContainer();
      }
    });
  });

  try {
    const Viz = await ensureViz();
    const viz = new Viz();
    const svg = await viz.renderSVGElement(dot);
    content.innerHTML = '';
    content.appendChild(svg);
    fitToContainer();
  } catch (err) {
    const msg = getRenderFailureMessage(err);
    content.innerHTML = `
      <div class="error">${msg.title}</div>
      <div class="info">${msg.detail}</div>
    `;
    viewEl.classList.add('signals-degraded');
    dotPre.classList.remove('hidden');
  }
}

export function dispose() {}

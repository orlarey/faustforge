/**
 * Vue Diagrammes SVG
 * Affiche les diagrammes de signal générés par Faust
 * Inspiré de faustservice
 */

export function getName() {
  return 'Diagrams';
}

export async function render(container, { sha }) {
  try {
    // Récupérer la liste des fichiers SVG
    const response = await fetch(`/api/${sha}/svg`);

    if (!response.ok) {
      if (response.status === 404) {
        container.innerHTML = `<div class="info">Diagrams not available (compilation error?)</div>`;
        return;
      }
      throw new Error('Failed to load SVG list');
    }

    const { files } = await response.json();

    if (!files || files.length === 0) {
      container.innerHTML = `<div class="info">No diagrams available</div>`;
      return;
    }

    // Trouver le fichier principal (process.svg)
    const mainFile = files.find(f => f === 'process.svg') || files[0];

    // Historique de navigation
    const history = [];
    let currentFile = null;

    // Créer l'interface
    container.innerHTML = `
      <div class="svg-view">
        <div class="svg-toolbar">
          <span class="svg-toolbar-title">Diagrams</span>
          <div class="svg-toolbar-controls">
            <div class="svg-toolbar-pill svg-file-pill">
              <span>File</span>
              <span class="svg-current-file"></span>
            </div>
            <div class="svg-toolbar-pill svg-nav-pill">
              <button class="svg-nav-btn svg-pill-action svg-nav-single" data-action="up" disabled title="Up to parent">Nav &#8593;</button>
            </div>
            <div class="svg-toolbar-pill svg-zoom-pill">
              <span>Zoom</span>
              <div class="svg-pill-value">
                <select class="svg-zoom-select" aria-label="Diagram zoom">
                  <option value="auto">Auto</option>
                  <option value="50">50%</option>
                  <option value="75">75%</option>
                  <option value="100" selected>100%</option>
                  <option value="125">125%</option>
                  <option value="150">150%</option>
                </select>
              </div>
            </div>
          </div>
        </div>
        <div class="svg-container">
          <div class="svg-progress hidden">
            <div class="svg-progress-text">Loading...</div>
          </div>
          <div class="svg-content"></div>
        </div>
      </div>
    `;

    const svgContent = container.querySelector('.svg-content');
    const svgContainer = container.querySelector('.svg-container');
    const zoomSelect = container.querySelector('.svg-zoom-select');
    const upBtn = container.querySelector('[data-action="up"]');
    const currentFileLabel = container.querySelector('.svg-current-file');
    const progressOverlay = container.querySelector('.svg-progress');
    let currentZoom = 100;
    let zoomMode = 'manual';

    // Gestionnaire de clics SVG (en phase capture comme faustservice)
    function svgClickHandler(e) {
      // Chercher un lien parent
      let target = e.target;
      while (target && target !== svgContent) {
        if (target.tagName.toLowerCase() === 'a') {
          const href = target.getAttribute('xlink:href') || target.getAttribute('href');
          if (href) {
            // Extraire le nom du fichier avec regex (comme faustservice)
            const match = href.match(/(?:.*\/)?([^\/]+\.svg)$/);
            if (match) {
              const filename = match[1];
              if (files.includes(filename)) {
                e.preventDefault();
                e.stopPropagation();
                loadSvg(filename);
                return;
              }
            }
          }
        }
        target = target.parentElement;
      }
    }

    // Afficher/masquer l'overlay de progression
    function showProgress(show) {
      progressOverlay.classList.toggle('hidden', !show);
    }

    // Charger un SVG
    async function loadSvg(filename, addToHistory = true) {
      showProgress(true);

      // Ajouter à l'historique si ce n'est pas un retour
      if (addToHistory && currentFile && currentFile !== filename) {
        history.push(currentFile);
      }
      currentFile = filename;

      // Mettre à jour l'UI
      upBtn.disabled = currentFile === mainFile;
      currentFileLabel.textContent = filename;

      try {
        const svgResponse = await fetch(`/api/${sha}/svg/${filename}`);
        if (!svgResponse.ok) {
          svgContent.innerHTML = `<div class="error">Failed to load ${filename}</div>`;
          return;
        }
        const svgText = await svgResponse.text();
        svgContent.innerHTML = svgText;

        // Appliquer le zoom
        applyZoom();

        // Ajouter l'interception des clics (phase capture)
        svgContent.removeEventListener('click', svgClickHandler, true);
        svgContent.addEventListener('click', svgClickHandler, true);

      } finally {
        showProgress(false);
      }
    }

    // Remonte d'un niveau; au sommet, rester sur process.svg.
    function goUp() {
      if (currentFile === mainFile) return;
      if (history.length > 0) {
        const prev = history.pop();
        loadSvg(prev, false);
        return;
      }
      loadSvg(mainFile, false);
    }

    function computeFitZoom() {
      const svg = svgContent.querySelector('svg');
      if (!svg) return currentZoom;
      svg.style.transform = 'none';
      const svgRect = svg.getBoundingClientRect();
      const containerRect = svgContainer.getBoundingClientRect();
      if (!svgRect.width || !svgRect.height) return currentZoom;
      const widthRatio = (containerRect.width - 40) / svgRect.width;
      const heightRatio = (containerRect.height - 40) / svgRect.height;
      const fitRatio = Math.min(widthRatio, heightRatio, 1);
      return Math.max(25, Math.min(400, Math.round(fitRatio * 100)));
    }

    // Appliquer le zoom
    function applyZoom() {
      const svg = svgContent.querySelector('svg');
      if (!svg) return;
      if (zoomMode === 'auto') {
        currentZoom = computeFitZoom();
      }
      svg.style.transform = `scale(${currentZoom / 100})`;
      svg.style.transformOrigin = 'top left';
    }

    // Événements navigation
    container.querySelectorAll('.svg-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'up') goUp();
      });
    });

    if (zoomSelect) {
      zoomSelect.addEventListener('change', () => {
        if (zoomSelect.value === 'auto') {
          zoomMode = 'auto';
          applyZoom();
          return;
        }
        zoomMode = 'manual';
        const parsed = parseInt(zoomSelect.value, 10);
        currentZoom = Number.isFinite(parsed) ? parsed : 100;
        applyZoom();
      });
    }

    // Charger le SVG initial
    if (zoomSelect) {
      zoomSelect.value = 'auto';
      zoomMode = 'auto';
    }
    await loadSvg(mainFile, false);

  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}

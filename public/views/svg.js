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
          <button class="svg-nav-btn icon-btn" data-action="back" disabled title="Back">&#9664;</button>
          <button class="svg-nav-btn icon-btn" data-action="home" title="Process">&#8962;</button>
          <span class="svg-current-file"></span>
          <div class="spacer"></div>
          <button class="svg-zoom-btn icon-btn" data-zoom="out" title="Zoom -">-</button>
          <span class="svg-zoom-level">100%</span>
          <button class="svg-zoom-btn icon-btn" data-zoom="in" title="Zoom +">+</button>
          <button class="svg-zoom-btn icon-btn" data-zoom="fit" title="Fit to view">Fit</button>
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
    const zoomLevel = container.querySelector('.svg-zoom-level');
    const backBtn = container.querySelector('[data-action="back"]');
    const currentFileLabel = container.querySelector('.svg-current-file');
    const progressOverlay = container.querySelector('.svg-progress');
    let currentZoom = 100;

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
      backBtn.disabled = history.length === 0;
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

    // Retour en arrière
    function goBack() {
      if (history.length > 0) {
        const prev = history.pop();
        loadSvg(prev, false);
      }
    }

    // Aller au diagramme principal
    function goHome() {
      if (currentFile !== mainFile) {
        loadSvg(mainFile);
      }
    }

    // Appliquer le zoom
    function applyZoom() {
      const svg = svgContent.querySelector('svg');
      if (svg) {
        svg.style.transform = `scale(${currentZoom / 100})`;
        svg.style.transformOrigin = 'top left';
      }
      zoomLevel.textContent = `${currentZoom}%`;
    }

    // Ajuster le zoom pour que le SVG rentre dans le conteneur
    function fitToContainer() {
      const svg = svgContent.querySelector('svg');
      if (!svg) return;

      // Reset zoom pour mesurer la taille réelle
      svg.style.transform = 'none';
      const svgRect = svg.getBoundingClientRect();
      const containerRect = svgContainer.getBoundingClientRect();

      // Calculer le ratio pour ajuster
      const widthRatio = (containerRect.width - 40) / svgRect.width;
      const heightRatio = (containerRect.height - 40) / svgRect.height;
      const fitRatio = Math.min(widthRatio, heightRatio, 1); // Ne pas dépasser 100%

      currentZoom = Math.round(fitRatio * 100);
      applyZoom();
    }

    // Événements navigation
    container.querySelectorAll('.svg-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'back') goBack();
        else if (action === 'home') goHome();
      });
    });

    // Événements zoom
    container.querySelectorAll('.svg-zoom-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.zoom;
        if (action === 'in') {
          currentZoom = Math.min(currentZoom + 25, 400);
          applyZoom();
        } else if (action === 'out') {
          currentZoom = Math.max(currentZoom - 25, 25);
          applyZoom();
        } else if (action === 'fit') {
          fitToContainer();
        }
      });
    });

    // Charger le SVG initial
    await loadSvg(mainFile, false);

  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}

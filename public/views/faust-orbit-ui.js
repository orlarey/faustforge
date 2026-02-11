import { FaustUICore } from './faust-core-ui.js';
import { TOOLTIP_TEXTS } from '../tooltip-texts.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cloneState(state) {
  return {
    zoom: state.zoom,
    center: { x: state.center.x, y: state.center.y },
    innerRadius: state.innerRadius,
    outerRadius: state.outerRadius,
    controls: Object.fromEntries(
      Object.entries(state.controls || {}).map(([path, c]) => [
        path,
        {
          path,
          label: c.label,
          min: c.min,
          max: c.max,
          step: c.step,
          color: c.color,
          x: c.x,
          y: c.y,
          enabled: !!c.enabled,
          type: c.type || 'hslider'
        }
      ])
    )
  };
}

function colorFromPath(path) {
  let hash = 0;
  for (let i = 0; i < path.length; i += 1) {
    hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 68% 62%)`;
}

export class FaustOrbitUI extends FaustUICore {
  constructor(root, paramChangeByUI, options = {}) {
    super(root, paramChangeByUI);
    this.onStateChange =
      typeof options.onOrbitStateChange === 'function'
        ? options.onOrbitStateChange
        : typeof options.onStateChange === 'function'
          ? options.onStateChange
          : null;
    this.onInteractionStart = typeof options.onInteractionStart === 'function' ? options.onInteractionStart : null;
    this.onInteractionEnd = typeof options.onInteractionEnd === 'function' ? options.onInteractionEnd : null;
    this.disabledPaths = new Set(Array.isArray(options.disabledPaths) ? options.disabledPaths : []);
    this.controlOrder = [];
    this.paramValues = {};
    this.pointer = null;
    this.resizeObserver = null;
    this.rafId = null;
    this._lastStateEmitAt = 0;
    this._stateEmitTimer = null;
    this.baseWidth = 1;
    this.baseHeight = 1;
    this.renderScale = 1;
    this.renderOffsetX = 0;
    this.renderOffsetY = 0;
    this.gridOrigin = { x: 0.5, y: 0.5 };
    this.initialOuterRadius = null;
    this.hoverHint = null;

    this.state = {
      zoom: 100,
      center: { x: 0.5, y: 0.5 },
      innerRadius: 20,
      outerRadius: 90,
      controls: {}
    };

    this.root.innerHTML = `
      <div class="orbit-wrap">
        <div class="orbit-header">
          <span class="orbit-title">Orbit UI</span>
          <div class="orbit-middle-actions">
            <button type="button" class="orbit-center-btn" title="${TOOLTIP_TEXTS.orbit.centerButton}">Center</button>
            <div class="orbit-random-group">
              <button type="button" class="orbit-random-btn" title="${TOOLTIP_TEXTS.orbit.randomButton}">Random</button>
              <select class="orbit-random-mix" aria-label="Random coefficient" title="${TOOLTIP_TEXTS.orbit.randomMix}">
                <option value="0.25">0.25</option>
                <option value="0.5" selected>0.5</option>
                <option value="0.75">0.75</option>
                <option value="1">1</option>
              </select>
            </div>
          </div>
          <div class="orbit-zoom-wrap">
            <div class="orbit-zoom-group" aria-label="Zoom selector">
              <span class="orbit-zoom-label">Zoom</span>
              <select class="orbit-zoom" title="${TOOLTIP_TEXTS.orbit.zoomSelect}">
                <option value="75">75%</option>
                <option value="100">100%</option>
                <option value="125">125%</option>
                <option value="150">150%</option>
                <option value="200">200%</option>
              </select>
            </div>
          </div>
        </div>
        <div class="orbit-body">
          <canvas class="orbit-canvas"></canvas>
        </div>
      </div>
    `;
    this.root.tabIndex = 0;

    this.body = this.root.querySelector('.orbit-body');
    this.canvas = this.root.querySelector('.orbit-canvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.zoomSelect = this.root.querySelector('.orbit-zoom');
    this.centerButton = this.root.querySelector('.orbit-center-btn');
    this.randomButton = this.root.querySelector('.orbit-random-btn');
    this.randomMixSelect = this.root.querySelector('.orbit-random-mix');

    if (!this.canvas || !this.ctx || !this.body) {
      throw new Error('FaustOrbitUI: invalid orbit DOM');
    }

    this._installZoomHandler();
    this._installCenterHandler();
    this._installRandomHandler();
    this._installKeyboardHandler();
    this._installPointerHandlers();
    this._installResizeObserver();

    this.center();
    this._requestRender();
  }

  getState() {
    return this.getOrbitState();
  }

  setState(state) {
    this.setOrbitState(state);
  }

  getOrbitState() {
    return cloneState(this.state);
  }

  setOrbitState(state) {
    const normalized = this._normalizeState(state);
    if (!normalized) {
      this._warn('invalid_orbit_state', state);
      return;
    }
    this.state = normalized;
    this.initialOuterRadius = normalized.outerRadius;
    this.controlOrder = Object.keys(this.state.controls);
    this._ensureRadii();
    this._constrainControlPositions();
    this._requestRender();
    this._requestStateEmit();
  }

  buildControls(ui) {
    const controls = this._extractControls(ui);
    const next = this.getOrbitState();
    next.controls = {};
    this.controlOrder = controls.map((c) => c.path);
    const count = Math.max(1, controls.length);
    controls.forEach((control, index) => {
      const previous = this.state.controls[control.path];
      const keepEnabled = previous ? !!previous.enabled : !this.disabledPaths.has(control.path);
      const keepColor = previous && previous.color ? previous.color : control.color;
      const keepLabel = previous && previous.label ? previous.label : control.label;
      const keepStep = Number.isFinite(previous && previous.step) ? previous.step : control.step;

      let x;
      let y;
      if (previous && Number.isFinite(previous.x) && Number.isFinite(previous.y)) {
        x = previous.x;
        y = previous.y;
      } else {
        const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
        const current = Number.isFinite(this.paramValues[control.path]) ? this.paramValues[control.path] : control.min;
        const distance = this._distanceFromValue(control, current, next);
        x = next.center.x + Math.cos(angle) * distance;
        y = next.center.y + Math.sin(angle) * distance;
      }

      next.controls[control.path] = {
        path: control.path,
        type: control.type,
        label: keepLabel,
        min: control.min,
        max: control.max,
        step: keepStep,
        color: keepColor,
        x,
        y,
        enabled: keepEnabled
      };
    });

    return next;
  }

  setParamValue(path, value) {
    if (!path || !Number.isFinite(value)) return;
    const control = this.state.controls[path];
    this.paramValues[path] = value;
    // During any local drag, point positions are user-authoritative.
    if (this.pointer) return;
    if (!control || !control.enabled) return;
    if (this._isValueCompatibleWithCurrentPosition(control, value)) return;
    const p = this._positionFromValue(path, value);
    if (!p) return;
    control.x = p.x;
    control.y = p.y;
    this._requestRender();
  }

  setParams(values) {
    if (!values || typeof values !== 'object') return;
    this.transaction(() => {
      for (const [path, value] of Object.entries(values)) {
        this.setParamValue(path, value);
      }
    });
  }

  setZoom(percent) {
    const parsed = Number(percent);
    const zoom = Number.isFinite(parsed) ? clamp(Math.round(parsed), 50, 300) : 100;
    if (zoom === this.state.zoom) return;
    this.state.zoom = zoom;
    if (this.zoomSelect && this.zoomSelect.value !== String(zoom)) {
      this.zoomSelect.value = String(zoom);
    }
    this._resizeCanvas({ keepViewportCenter: true });
    this._requestRender();
    this._requestStateEmit();
  }

  getZoom() {
    return this.state.zoom;
  }

  resize() {
    const resized = this._resizeCanvas();
    if (!resized) return;
    this._ensureRadii();
    this._constrainControlPositions();
    this._requestRender();
  }

  center() {
    const { width, height } = this._getBaseSize();
    this.baseWidth = width;
    this.baseHeight = height;
    this.state.center = { x: width / 2, y: height / 2 };
    this.gridOrigin = { x: this.state.center.x, y: this.state.center.y };
    const defaultOuter = Math.max(60, Math.min(width, height) * 0.36);
    this.state.outerRadius = defaultOuter;
    this.initialOuterRadius = defaultOuter;
    this.state.innerRadius = Math.max(14, defaultOuter * 0.18);
    const paths = Object.keys(this.state.controls);
    const count = Math.max(1, paths.length);
    paths.forEach((path, index) => {
      const control = this.state.controls[path];
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      const distance = this._distanceFromValue(control, this.paramValues[path], this.state);
      control.x = this.state.center.x + Math.cos(angle) * distance;
      control.y = this.state.center.y + Math.sin(angle) * distance;
    });
    this._ensureRadii();
    this._constrainControlPositions();
    this._resizeCanvas();
    this._requestRender();
    this._requestStateEmit();
  }

  random(c = 1) {
    if (this.pointer) return;
    const mix = Number.isFinite(Number(c)) ? clamp(Number(c), 0, 1) : 1;
    if (this.onInteractionStart) {
      try {
        this.onInteractionStart();
      } catch {
        // ignore
      }
    }
    try {
      this.transaction(() => {
        for (const control of Object.values(this.state.controls)) {
          if (!control.enabled) continue;
          const v0 = Number.isFinite(this.paramValues[control.path])
            ? this.paramValues[control.path]
            : this._valueFromPosition(control, control.x, control.y);
          const randomValue = control.min + Math.random() * (control.max - control.min);
          let v1 = mix * randomValue + (1 - mix) * v0;
          if (control.type !== 'button' && control.type !== 'checkbox' && control.step > 0) {
            const steps = Math.round((v1 - control.min) / control.step);
            v1 = control.min + steps * control.step;
          }
          v1 = clamp(v1, control.min, control.max);
          const p = this._positionFromValue(control.path, v1);
          if (!p) continue;
          control.x = p.x;
          control.y = p.y;
          this._emitValueForControl(control);
        }
        this._requestRender();
        this._requestStateEmit();
      });
    } finally {
      if (this.onInteractionEnd) {
        try {
          this.onInteractionEnd();
        } catch {
          // ignore
        }
      }
    }
  }

  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.canvas) {
      this.canvas.onpointerdown = null;
      this.canvas.onpointermove = null;
      this.canvas.onpointerup = null;
      this.canvas.onpointercancel = null;
      this.canvas.onpointerleave = null;
    }
    if (this.zoomSelect && this._zoomHandler) {
      this.zoomSelect.removeEventListener('change', this._zoomHandler);
    }
    if (this.centerButton && this._centerHandler) {
      this.centerButton.removeEventListener('click', this._centerHandler);
    }
    if (this.randomButton && this._randomHandler) {
      this.randomButton.removeEventListener('click', this._randomHandler);
    }
    if (this.root && this._keyHandler) {
      this.root.removeEventListener('keydown', this._keyHandler);
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this._stateEmitTimer) {
      clearTimeout(this._stateEmitTimer);
      this._stateEmitTimer = null;
    }
    super.destroy();
  }

  _flushRender() {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this._drawNow();
    });
  }

  _emitState() {
    if (!this.onStateChange) return;
    const now = Date.now();
    const elapsed = now - this._lastStateEmitAt;
    if (elapsed >= 120) {
      this._lastStateEmitAt = now;
      try {
        this.onStateChange(this.getOrbitState());
      } catch {
        // ignore
      }
      return;
    }
    if (this._stateEmitTimer) return;
    this._stateEmitTimer = setTimeout(() => {
      this._stateEmitTimer = null;
      this._lastStateEmitAt = Date.now();
      try {
        this.onStateChange(this.getOrbitState());
      } catch {
        // ignore
      }
    }, Math.max(0, 120 - elapsed));
  }

  _installZoomHandler() {
    if (!this.zoomSelect) return;
    this.zoomSelect.value = String(this.state.zoom);
    this._zoomHandler = () => {
      this.setZoom(this.zoomSelect.value);
    };
    this.zoomSelect.addEventListener('change', this._zoomHandler);
  }

  _installCenterHandler() {
    if (!this.centerButton) return;
    this._centerHandler = () => {
      this.center();
    };
    this.centerButton.addEventListener('click', this._centerHandler);
  }

  _installRandomHandler() {
    if (!this.randomButton) return;
    this._randomHandler = () => {
      const c = this.randomMixSelect ? Number(this.randomMixSelect.value) : 1;
      this.random(c);
    };
    this.randomButton.addEventListener('click', this._randomHandler);
  }

  _installKeyboardHandler() {
    this._keyHandler = (event) => {
      if (!event || typeof event.key !== 'string') return;
      if (event.key.toLowerCase() !== 'r') return;
      event.preventDefault();
      const c = this.randomMixSelect ? Number(this.randomMixSelect.value) : 1;
      this.random(c);
    };
    this.root.addEventListener('keydown', this._keyHandler);
  }

  _installResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this._resizeCanvas();
  }

  _installPointerHandlers() {
    this.canvas.onpointerdown = (event) => {
      const p = this._pointerPosition(event);
      const hit = this._hitTest(p.x, p.y);
      if (!hit) return;

      if (hit.mode === 'slider' && hit.path && event.shiftKey) {
        event.preventDefault();
        const control = this.state.controls[hit.path];
        if (!control) return;
        control.enabled = !control.enabled;
        this._requestRender();
        this._requestStateEmit();
        return;
      }

      event.preventDefault();
      this.root.focus();
      this.canvas.setPointerCapture(event.pointerId);
      this.pointer = { pointerId: event.pointerId, mode: hit.mode, path: hit.path || null };
      this.hoverHint = null;
      if (this.onInteractionStart) {
        try {
          this.onInteractionStart();
        } catch {
          // ignore
        }
      }
      this._updateCursor(this.pointer.mode);
    };

    this.canvas.onpointermove = (event) => {
      const p = this._pointerPosition(event);
      if (!this.pointer) {
        const hit = this._hitTest(p.x, p.y);
        this._updateHoverHint(hit, p.x, p.y);
        this._updateCursor(hit ? hit.mode : null);
        this._requestRender();
        return;
      }
      if (event.pointerId !== this.pointer.pointerId) return;

      if (this.pointer.mode === 'slider' && this.pointer.path) {
        const control = this.state.controls[this.pointer.path];
        if (!control) return;
        control.x = clamp(p.x, 0, this.baseWidth);
        control.y = clamp(p.y, 0, this.baseHeight);
        this._emitValueForControl(control);
        this._requestRender();
        this._requestStateEmit();
        return;
      }

      if (this.pointer.mode === 'center') {
        this.state.center.x = clamp(p.x, 0, this.baseWidth);
        this.state.center.y = clamp(p.y, 0, this.baseHeight);
        this._emitValuesForAllControls();
        this._requestRender();
        this._requestStateEmit();
        return;
      }

      if (this.pointer.mode === 'outer') {
        this.state.outerRadius = Math.hypot(p.x - this.state.center.x, p.y - this.state.center.y);
        this._ensureRadii();
        this._emitValuesForAllControls();
        this._requestRender();
        this._requestStateEmit();
      }
    };

    const release = (event) => {
      if (!this.pointer || event.pointerId !== this.pointer.pointerId) return;
      this.pointer = null;
      this._updateCursor(null);
      if (this.onInteractionEnd) {
        try {
          this.onInteractionEnd();
        } catch {
          // ignore
        }
      }
      this._requestStateEmit();
    };

    this.canvas.onpointerup = release;
    this.canvas.onpointercancel = release;
    this.canvas.onpointerleave = () => {
      this.hoverHint = null;
      if (!this.pointer) this._updateCursor(null);
      this._requestRender();
    };
  }

  _updateHoverHint(hit, x, y) {
    if (!hit) {
      this.hoverHint = null;
      return;
    }
    if (hit.mode === 'slider' && hit.path) {
      const control = this.state.controls[hit.path];
      if (!control) {
        this.hoverHint = null;
        return;
      }
      this.hoverHint = {
        x,
        y,
        text: `${control.label}: ${TOOLTIP_TEXTS.orbit.hintSlider}`,
        accent: control.enabled ? control.color : 'rgba(160,160,160,0.8)'
      };
      return;
    }
    if (hit.mode === 'center') {
      this.hoverHint = {
        x,
        y,
        text: TOOLTIP_TEXTS.orbit.hintCenter,
        accent: 'rgba(220,220,220,0.9)'
      };
      return;
    }
    if (hit.mode === 'outer') {
      this.hoverHint = {
        x,
        y,
        text: TOOLTIP_TEXTS.orbit.hintOuter,
        accent: 'rgba(220,220,220,0.9)'
      };
      return;
    }
    this.hoverHint = null;
  }

  _extractControls(ui) {
    if (!Array.isArray(ui)) {
      throw new Error('FaustOrbitUI: invalid ui');
    }
    const out = [];
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (Array.isArray(node.items)) node.items.forEach(walk);
      const type = node.type;
      const path = node.address || node.path;
      if (!path) return;
      const supported = ['hslider', 'vslider', 'nentry', 'button', 'checkbox'];
      if (!supported.includes(type)) return;

      let min = Number.isFinite(node.min) ? Number(node.min) : 0;
      let max = Number.isFinite(node.max) ? Number(node.max) : 1;
      let step = Number.isFinite(node.step) ? Number(node.step) : 0;

      if (type === 'button' || type === 'checkbox') {
        min = 0;
        max = 1;
        step = 1;
      }
      if (max <= min) {
        max = min + (type === 'button' || type === 'checkbox' ? 1 : 0.0001);
      }
      out.push({
        path,
        type,
        label: String(node.label || path.split('/').filter(Boolean).pop() || path),
        min,
        max,
        step,
        color: colorFromPath(path)
      });
    };
    walk(ui);
    return out;
  }

  _normalizeState(state) {
    if (!state || typeof state !== 'object' || !state.controls || typeof state.controls !== 'object') {
      return null;
    }
    const { width, height } = this._getBaseSize();
    this.baseWidth = width;
    this.baseHeight = height;
    const normalized = {
      zoom: Number.isFinite(state.zoom) ? clamp(Number(state.zoom), 50, 300) : this.state.zoom || 100,
      center: {
        x: clamp(Number(state.center && state.center.x) || this.state.center.x || width / 2, 0, width),
        y: clamp(Number(state.center && state.center.y) || this.state.center.y || height / 2, 0, height)
      },
      innerRadius: Number.isFinite(state.innerRadius) ? Number(state.innerRadius) : this.state.innerRadius,
      outerRadius: Number.isFinite(state.outerRadius) ? Number(state.outerRadius) : this.state.outerRadius,
      controls: {}
    };

    for (const [path, raw] of Object.entries(state.controls)) {
      if (!raw || typeof raw !== 'object') continue;
      const min = Number(raw.min);
      const max = Number(raw.max);
      const step = Number(raw.step);
      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) continue;
      if (max <= min) continue;
      const label = String(raw.label || path);
      const color = String(raw.color || colorFromPath(path));
      normalized.controls[path] = {
        path,
        type: raw.type || (step >= 1 && min === 0 && max === 1 ? 'checkbox' : 'hslider'),
        label,
        min,
        max,
        step,
        color,
        x: clamp(Number(raw.x) || normalized.center.x, 0, width),
        y: clamp(Number(raw.y) || normalized.center.y, 0, height),
        enabled: !!raw.enabled
      };
    }

    this.zoomSelect.value = String(normalized.zoom);
    if (!this.gridOrigin || !Number.isFinite(this.gridOrigin.x) || !Number.isFinite(this.gridOrigin.y)) {
      this.gridOrigin = { x: normalized.center.x, y: normalized.center.y };
    }
    this._resizeCanvas();
    return normalized;
  }

  _getBaseSize() {
    const width = Math.max(1, this.body.clientWidth || 1);
    const height = Math.max(1, this.body.clientHeight || 1);
    return { width, height };
  }

  _resizeCanvas(options = {}) {
    const keepViewportCenter = !!options.keepViewportCenter;
    const oldScale = this.renderScale || 1;
    const oldOffsetX = this.renderOffsetX || 0;
    const oldOffsetY = this.renderOffsetY || 0;
    const centerWorldX = ((this.body.scrollLeft + (this.body.clientWidth / 2)) - oldOffsetX) / oldScale;
    const centerWorldY = ((this.body.scrollTop + (this.body.clientHeight / 2)) - oldOffsetY) / oldScale;

    const rawWidth = this.body.clientWidth || 0;
    const rawHeight = this.body.clientHeight || 0;
    if (rawWidth < 2 || rawHeight < 2) return false;

    this.baseWidth = rawWidth;
    this.baseHeight = rawHeight;

    const dpr = window.devicePixelRatio || 1;
    const scale = clamp((this.state.zoom || 100) / 100, 0.5, 3);
    const cssWidth = scale < 1 ? rawWidth : Math.max(1, Math.round(rawWidth * scale));
    const cssHeight = scale < 1 ? rawHeight : Math.max(1, Math.round(rawHeight * scale));
    const offsetX = scale < 1 ? (rawWidth - (rawWidth * scale)) / 2 : 0;
    const offsetY = scale < 1 ? (rawHeight - (rawHeight * scale)) / 2 : 0;

    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round((scale < 1 ? rawWidth : cssWidth) * dpr);
    this.canvas.height = Math.round((scale < 1 ? rawHeight : cssHeight) * dpr);

    this.renderScale = scale;
    this.renderOffsetX = offsetX;
    this.renderOffsetY = offsetY;
    this.ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offsetX, dpr * offsetY);

    if (keepViewportCenter) {
      const targetCenterX = centerWorldX * scale + offsetX;
      const targetCenterY = centerWorldY * scale + offsetY;
      const maxScrollLeft = Math.max(0, cssWidth - this.body.clientWidth);
      const maxScrollTop = Math.max(0, cssHeight - this.body.clientHeight);
      this.body.scrollLeft = clamp(targetCenterX - (this.body.clientWidth / 2), 0, maxScrollLeft);
      this.body.scrollTop = clamp(targetCenterY - (this.body.clientHeight / 2), 0, maxScrollTop);
    }

    return true;
  }

  _pointerPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    const rawX = event.clientX - rect.left;
    const rawY = event.clientY - rect.top;
    return {
      x: (rawX - this.renderOffsetX) / this.renderScale,
      y: (rawY - this.renderOffsetY) / this.renderScale
    };
  }

  _hitTest(x, y) {
    const paths = Object.keys(this.state.controls);
    for (const path of paths) {
      const c = this.state.controls[path];
      const d = Math.hypot(c.x - x, c.y - y);
      if (d <= 12) return { mode: 'slider', path };
    }
    const centerDistance = Math.hypot(this.state.center.x - x, this.state.center.y - y);
    if (centerDistance <= this.state.innerRadius + 6) return { mode: 'center' };
    if (Math.abs(centerDistance - this.state.outerRadius) <= 8) return { mode: 'outer' };
    return null;
  }

  _updateCursor(mode) {
    if (mode === 'slider') {
      this.canvas.style.cursor = 'pointer';
      return;
    }
    if (mode === 'center') {
      this.canvas.style.cursor = 'move';
      return;
    }
    if (mode === 'outer') {
      this.canvas.style.cursor = this.pointer ? 'grabbing' : 'grab';
      return;
    }
    this.canvas.style.cursor = 'default';
  }

  _ensureRadii() {
    const maxOuter = Math.max(40, Math.min(this.baseWidth, this.baseHeight) * 0.47);
    this.state.outerRadius = clamp(this.state.outerRadius, 30, maxOuter);
    this.state.innerRadius = clamp(this.state.innerRadius, 8, this.state.outerRadius - 6);
    if (!Number.isFinite(this.initialOuterRadius)) {
      this.initialOuterRadius = this.state.outerRadius;
    }
  }

  _constrainControlPositions() {
    for (const control of Object.values(this.state.controls)) {
      control.x = clamp(control.x, 0, this.baseWidth);
      control.y = clamp(control.y, 0, this.baseHeight);
    }
  }

  _distanceFromValue(control, value, stateOverride = null) {
    const st = stateOverride || this.state;
    const v = Number.isFinite(value) ? value : control.min;
    const u = clamp((v - control.min) / (control.max - control.min), 0, 1);
    return st.outerRadius - u * (st.outerRadius - st.innerRadius);
  }

  _valueFromPosition(control, x, y) {
    const d = Math.hypot(x - this.state.center.x, y - this.state.center.y);
    const u = d <= this.state.innerRadius
      ? 1
      : d >= this.state.outerRadius
        ? 0
        : (this.state.outerRadius - d) / (this.state.outerRadius - this.state.innerRadius);

    if (control.type === 'button' || control.type === 'checkbox') {
      const threshold = (this.state.innerRadius + this.state.outerRadius) / 2;
      return d <= threshold ? 1 : 0;
    }

    let value = control.min + u * (control.max - control.min);
    if (control.step > 0) {
      const steps = Math.round((value - control.min) / control.step);
      value = control.min + steps * control.step;
    }
    return clamp(value, control.min, control.max);
  }

  _isValueCompatibleWithCurrentPosition(control, value) {
    const expected = this._valueFromPosition(control, control.x, control.y);
    if (control.type === 'button' || control.type === 'checkbox') {
      return Math.round(value) === Math.round(expected);
    }
    const range = Math.max(1e-9, control.max - control.min);
    const tolerance = control.step > 0 ? (control.step / 2) + 1e-9 : range * 1e-3;
    return Math.abs(value - expected) <= tolerance;
  }

  _positionFromValue(path, value) {
    const control = this.state.controls[path];
    if (!control) return null;
    const distance = this._distanceFromValue(control, value);
    let dx = control.x - this.state.center.x;
    let dy = control.y - this.state.center.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 1e-6) {
      const idx = Math.max(0, this.controlOrder.indexOf(path));
      const count = Math.max(1, this.controlOrder.length);
      const angle = (idx / count) * Math.PI * 2 - Math.PI / 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    } else {
      dx /= mag;
      dy /= mag;
    }
    return {
      x: clamp(this.state.center.x + dx * distance, 0, this.baseWidth),
      y: clamp(this.state.center.y + dy * distance, 0, this.baseHeight)
    };
  }

  _emitValueForControl(control) {
    if (!control || !control.enabled) return;
    const value = this._valueFromPosition(control, control.x, control.y);
    this.paramValues[control.path] = value;
    try {
      this.paramChangeByUI(control.path, value);
    } catch {
      // ignore
    }
  }

  _emitValuesForAllControls() {
    for (const control of Object.values(this.state.controls)) {
      this._emitValueForControl(control);
    }
  }

  _drawNow() {
    if (!this.ctx || !this.canvas) return;
    const scale = this.renderScale || 1;
    const offsetX = this.renderOffsetX || 0;
    const offsetY = this.renderOffsetY || 0;
    const canvasCssWidth = Math.max(1, this.canvas.clientWidth || this.baseWidth);
    const canvasCssHeight = Math.max(1, this.canvas.clientHeight || this.baseHeight);
    const minX = -offsetX / scale;
    const minY = -offsetY / scale;
    const drawWidth = canvasCssWidth / scale;
    const drawHeight = canvasCssHeight / scale;
    const maxX = minX + drawWidth;
    const maxY = minY + drawHeight;

    const ctx = this.ctx;
    ctx.clearRect(minX, minY, drawWidth, drawHeight);
    ctx.fillStyle = '#111';
    ctx.fillRect(minX, minY, drawWidth, drawHeight);

    const gridStep = Math.max(8, (this.initialOuterRadius || this.state.outerRadius) / 2);
    const gridOrigin = this.gridOrigin || this.state.center;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;

    for (let x = gridOrigin.x; x <= maxX; x += gridStep) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, minY);
      ctx.lineTo(Math.round(x) + 0.5, maxY);
      ctx.stroke();
    }
    for (let x = gridOrigin.x - gridStep; x >= minX; x -= gridStep) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, minY);
      ctx.lineTo(Math.round(x) + 0.5, maxY);
      ctx.stroke();
    }
    for (let y = gridOrigin.y; y <= maxY; y += gridStep) {
      ctx.beginPath();
      ctx.moveTo(minX, Math.round(y) + 0.5);
      ctx.lineTo(maxX, Math.round(y) + 0.5);
      ctx.stroke();
    }
    for (let y = gridOrigin.y - gridStep; y >= minY; y -= gridStep) {
      ctx.beginPath();
      ctx.moveTo(minX, Math.round(y) + 0.5);
      ctx.lineTo(maxX, Math.round(y) + 0.5);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.arc(this.state.center.x, this.state.center.y, this.state.outerRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(250,250,250,0.15)';
    ctx.beginPath();
    ctx.arc(this.state.center.x, this.state.center.y, this.state.innerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(250,250,250,0.35)';
    ctx.stroke();

    // Subtle crosshair at draggable center.
    const crossHalf = Math.max(4, Math.min(8, this.state.innerRadius * 0.28));
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.state.center.x - crossHalf, this.state.center.y + 0.5);
    ctx.lineTo(this.state.center.x + crossHalf, this.state.center.y + 0.5);
    ctx.moveTo(this.state.center.x + 0.5, this.state.center.y - crossHalf);
    ctx.lineTo(this.state.center.x + 0.5, this.state.center.y + crossHalf);
    ctx.stroke();

    ctx.font = '11px system-ui, sans-serif';
    for (const control of Object.values(this.state.controls)) {
      const iconColor = control.enabled ? control.color : 'rgba(85,85,85,0.5)';
      const labelColor = control.enabled ? 'rgba(255,255,255,0.85)' : 'rgba(105,105,105,0.68)';

      const value = this._valueFromPosition(control, control.x, control.y);
      const normalized = clamp((value - control.min) / (control.max - control.min), 0, 1);
      const ringRadius = 11;
      const ringStart = -Math.PI / 2;
      const ringEnd = ringStart + (Math.PI * 2 * normalized);

      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.strokeStyle = control.enabled ? 'rgba(255,255,255,0.2)' : 'rgba(180,180,180,0.12)';
      ctx.beginPath();
      ctx.arc(control.x, control.y, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      if (normalized > 0.001) {
        ctx.strokeStyle = control.enabled ? 'rgba(255,255,255,0.95)' : 'rgba(200,200,200,0.45)';
        ctx.beginPath();
        ctx.arc(control.x, control.y, ringRadius, ringStart, ringEnd);
        ctx.stroke();
      }

      ctx.fillStyle = iconColor;
      ctx.beginPath();
      ctx.arc(control.x, control.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = control.enabled ? 'rgba(0,0,0,0.6)' : 'rgba(60,60,60,0.82)';
      ctx.stroke();
      ctx.lineCap = 'butt';
      const label = control.label.length > 16 ? `${control.label.slice(0, 15)}...` : control.label;
      ctx.fillStyle = labelColor;
      ctx.fillText(label, control.x + 10, control.y - 10);
    }

    if (this.hoverHint && !this.pointer) {
      const text = this.hoverHint.text || '';
      if (text) {
        ctx.font = '11px system-ui, sans-serif';
        const padX = 8;
        const padY = 5;
        const textWidth = ctx.measureText(text).width;
        const boxW = Math.ceil(textWidth + padX * 2);
        const boxH = 22;
        const desiredX = this.hoverHint.x + 14;
        const desiredY = this.hoverHint.y - 30;
        const boxX = clamp(desiredX, minX + 4, maxX - boxW - 4);
        const boxY = clamp(desiredY, minY + 4, maxY - boxH - 4);
        ctx.fillStyle = 'rgba(8, 10, 14, 0.9)';
        ctx.strokeStyle = this.hoverHint.accent || 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(236, 242, 249, 0.95)';
        ctx.fillText(text, boxX + padX, boxY + boxH - padY - 2);
      }
    }
  }

  _warn(code, details) {
    try {
      console.warn(`[FaustOrbitUI] ${code}`, details);
    } catch {
      // ignore
    }
  }
}

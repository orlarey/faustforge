export class FaustUICore {
  constructor(root, paramChangeByUI) {
    if (!root || !(root instanceof HTMLElement)) {
      throw new Error('FaustUICore: missing root');
    }
    if (typeof paramChangeByUI !== 'function') {
      throw new Error('FaustUICore: missing paramChangeByUI');
    }
    this.root = root;
    this.paramChangeByUI = paramChangeByUI;
    this._updateDepth = 0;
    this._renderPending = false;
    this._statePending = false;
    this._destroyed = false;
  }

  beginUpdate() {
    if (this._destroyed) return;
    this._updateDepth += 1;
  }

  endUpdate() {
    if (this._destroyed) return;
    if (this._updateDepth > 0) {
      this._updateDepth -= 1;
    }
    if (this._updateDepth === 0) {
      this._flushPending();
    }
  }

  transaction(fn) {
    this.beginUpdate();
    try {
      fn();
    } finally {
      this.endUpdate();
    }
  }

  destroy() {
    this._destroyed = true;
    this._renderPending = false;
    this._statePending = false;
  }

  _requestRender() {
    if (this._destroyed) return;
    if (this._updateDepth > 0) {
      this._renderPending = true;
      return;
    }
    if (typeof this._flushRender === 'function') {
      this._flushRender();
    }
  }

  _requestStateEmit() {
    if (this._destroyed) return;
    if (this._updateDepth > 0) {
      this._statePending = true;
      return;
    }
    if (typeof this._emitState === 'function') {
      this._emitState();
    }
  }

  _flushPending() {
    if (this._destroyed) return;
    const doRender = this._renderPending;
    const doState = this._statePending;
    this._renderPending = false;
    this._statePending = false;
    if (doRender && typeof this._flushRender === 'function') {
      this._flushRender();
    }
    if (doState && typeof this._emitState === 'function') {
      this._emitState();
    }
  }
}

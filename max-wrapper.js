/**
 * Locks all scrollable elements from document down into the HA shadow tree.
 * Returns an array of restore objects.
 */
function _lockHAScroll() {
  const locks = [];

  const lock = (el) => {
    if (!el || locks.some(l => l.el === el)) return;
    try {
      const st  = el.scrollTop;
      const sl  = el.scrollLeft;
      const ov  = el.style.overflow;
      el.style.overflow = 'hidden';
      el.scrollTop  = st;
      el.scrollLeft = sl;
      locks.push({ el, overflow: ov, scrollTop: st, scrollLeft: sl });
    } catch (_) {}
  };

  lock(document.documentElement);
  lock(document.body);

  try {
    const ha      = document.querySelector('home-assistant');
    const main    = ha?.shadowRoot?.querySelector('home-assistant-main');
    const drawer  = main?.shadowRoot?.querySelector('ha-drawer');
    const panel   = (drawer ?? main?.shadowRoot)?.querySelector('ha-panel-lovelace');
    const huiRoot = panel?.shadowRoot?.querySelector('hui-root');

    const scanRoot = (sr) => {
      if (!sr) return;
      for (const el of sr.querySelectorAll('*')) {
        try {
          const ov = window.getComputedStyle(el).overflowY;
          if (ov === 'auto' || ov === 'scroll') lock(el);
        } catch (_) {}
      }
    };

    scanRoot(main?.shadowRoot);
    scanRoot(drawer?.shadowRoot);
    scanRoot(huiRoot?.shadowRoot);

    const sr      = huiRoot?.shadowRoot;
    const viewEl  = sr?.querySelector('hui-view, hui-masonry-view, hui-sections-view, hui-panel-view');
    if (viewEl) {
      lock(viewEl);
      scanRoot(viewEl.shadowRoot);
    }
  } catch (_) {}

  return locks;
}

function _unlockHAScroll(locks) {
  if (!locks) return;
  for (const { el, overflow } of locks) {
    try { el.style.overflow = overflow; } catch (_) {}
  }
  requestAnimationFrame(() => {
    for (const { el, scrollTop, scrollLeft } of locks) {
      try {
        el.scrollTop  = scrollTop;
        el.scrollLeft = scrollLeft;
      } catch (_) {}
    }
  });
}

/**
 * Finds the hui-view-footer element in the HA shadow tree, if present.
 * Recursively searches shadow roots — different HA versions and view types
 * (sections, masonry, grid) place the footer at different nesting levels.
 */
function _findHAFooter() {
  const searchShadow = (sr, depth) => {
    if (!sr || depth > 7) return null;
    const el = sr.querySelector('hui-view-footer');
    if (el) return el;
    for (const child of sr.querySelectorAll('*')) {
      if (child.shadowRoot) {
        const found = searchShadow(child.shadowRoot, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  try {
    const ha = document.querySelector('home-assistant');
    return searchShadow(ha?.shadowRoot, 0) ?? null;
  } catch (_) { return null; }
}

/**
 * Resolves current HA layout metrics for maximize positioning.
 * Newer HA builds no longer expose a stable drawer width CSS variable,
 * so we derive the content frame from actual element geometry.
 */
function _getHAMaximizeFrame() {
  const fallbackTop = parseInt(getComputedStyle(document.documentElement)
    .getPropertyValue('--header-height')) || 56;
  const fallback = {
    top: fallbackTop,
    left: 0,
    width: window.innerWidth,
  };

  try {
    const ha = document.querySelector('home-assistant');
    const main = ha?.shadowRoot?.querySelector('home-assistant-main');
    const mainSR = main?.shadowRoot;
    const drawer = mainSR?.querySelector('ha-drawer');
    const panel = (drawer ?? mainSR)?.querySelector('ha-panel-lovelace');

    if (panel) {
      const r = panel.getBoundingClientRect();
      if (r.width > 0) {
        const top = Math.max(0, Math.round(r.top));
        const left = Math.max(0, Math.round(r.left));
        const width = Math.max(0, Math.round(r.width));
        return { top, left, width };
      }
    }

    const sidebar = mainSR?.querySelector('ha-sidebar');
    if (sidebar) {
      const r = sidebar.getBoundingClientRect();
      const cs = getComputedStyle(sidebar);
      const visible = r.width > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      if (visible) {
        const left = Math.max(0, Math.round(r.right));
        const width = Math.max(0, window.innerWidth - left);
        return { top: fallbackTop, left, width };
      }
    }
  } catch (_) {}

  return fallback;
}

/**
 * Moves the maximized container into the browser's top layer (Popover API).
 * Since HA 2026.11 <home-assistant-main> has `isolation: isolate`, so a
 * position:fixed element inside the dashboard can no longer rise above HA's
 * own layers with z-index. The top layer is above every stacking context and
 * positioned relative to the viewport, regardless of transform, filter or
 * isolation on ancestors. HA's dialogs, toasts and tooltips also use the top
 * layer; they open later and therefore stay above the maximized card.
 * Returns false if the API is unavailable (z-index fallback stays active).
 */
function _enterTopLayer(el) {
  if (typeof el.showPopover !== 'function') return false;
  try {
    el.setAttribute('popover', 'manual');
    el.showPopover();
    return true;
  } catch (_) {
    el.removeAttribute('popover');
    return false;
  }
}

function _leaveTopLayer(el) {
  if (!el?.hasAttribute('popover')) return;
  try { if (el.matches(':popover-open')) el.hidePopover(); } catch (_) {}
  el.removeAttribute('popover');
}

// Tracks all mounted instances so when one card maximizes, others hide their toggle button.
const _fswRegistry = new Set();

class MaximizeWrapperCard extends HTMLElement {
  // HA grid row height in px (default 56px per row + 8px gap)
  static get HA_ROW_HEIGHT() { return 56; }
  static get HA_ROW_GAP() { return 8; }

  // Build config for the child card, injecting the effective grid_options
  // so cards like statistics-graph compute the correct internal chart height.
  _buildChildConfig(forMaximized = false) {
    const base = { ...this._config.card };
    const wrapperOpts = this._config.grid_options || {};
    const fullOpts    = this._config.grid_options_full || {};
    const srcOpts = forMaximized
      ? { ...wrapperOpts, ...fullOpts }   // maximized: merge both, full wins
      : wrapperOpts;                      // normal: wrapper grid_options only
    if (Object.keys(srcOpts).length) {
      // child's own grid_options override the injected ones
      base.grid_options = { ...srcOpts, ...(this._config.card.grid_options || {}) };
    }
    return base;
  }

  _rowsHeightPx(rows) {
    return rows * MaximizeWrapperCard.HA_ROW_HEIGHT + (rows - 1) * MaximizeWrapperCard.HA_ROW_GAP;
  }

  async setConfig(config) {
    this._config = config;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });

    if (config.card?.type) {
      const helpers = await window.loadCardHelpers();
      this.cardElement = await helpers.createCardElement(this._buildChildConfig(false));
    } else {
      this.cardElement = null;
    }

    this.render();
  }

  _applyRowSize(container, rows) {
    if (rows) {
      container.style.setProperty('--row-size', rows);
      container.style.setProperty('--fs-card-height', this._rowsHeightPx(rows) + 'px');
      container.classList.add('rows-override');
    } else {
      container.style.removeProperty('--row-size');
      container.style.removeProperty('--fs-card-height');
      container.classList.remove('rows-override');
    }
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        #fs-container { position: relative; width: 100%; height: 100%; }

        #fs-container.maximized {
          position: fixed;
          top: var(--fs-top, var(--header-height, 56px));
          left: var(--fs-left, 0px);
          width: var(--fs-width, 100vw);
          height: calc(100vh - var(--fs-top, var(--header-height, 56px)) - var(--fs-footer-h, 0px));
          z-index: 4;
          padding: var(--lovelace-card-padding, 8px);
          box-sizing: border-box;
          background: var(--lovelace-background, var(--primary-background-color));
          overflow: hidden;
        }
        /* While in the top layer: neutralise the browser's popover defaults
           (inset:0, margin:auto, border, color:CanvasText). Position, size,
           padding and background are set inline while maximized. */
        #fs-container[popover] {
          inset: auto;
          margin: 0;
          border: 0;
          color: inherit;
        }

        /* Button is inside #fs-container but outside #card-inner.
           In maximized state it sits exactly at the top-right corner of #card-inner.
           #card-inner has overflow:hidden so there is no scrollbar on #card-inner;
           the child card scrolls internally → no scrollbar ever overlaps the button. */
        #fs-btn {
          position: absolute;
          top: -1px;
          right: -1px;
          z-index: 3;
          cursor: pointer;
          background: transparent;
          border: none;
          padding: 0;
          color: var(--secondary-text-color);
          opacity: 0.5;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: opacity 0.15s;
        }
        /* Maximized: button right edge aligns with #card-inner right edge,
           button top edge aligns with #card-inner top edge. */
        :host(.maximized) #fs-btn {
          top: var(--lovelace-card-padding, 8px);
          right: var(--lovelace-card-padding, 8px);
        }
        #fs-btn:hover { opacity: 1; }
        :host(.edit-mode) #fs-btn { display: none; }
        #fs-btn .icon-fs,
        #fs-btn .icon-win { display: none; }
        :host(:not(.maximized)) #fs-btn .icon-fs { display: block; }
        :host(.maximized)       #fs-btn .icon-win { display: block; }

        #card-inner { 
          width: 100%; 
          height: 100%;
          max-height: 100%;
          overflow-y: auto;
          border-radius: var(--ha-card-border-radius, 12px);
        }
        /* In maximized state: overflow:hidden clips to the maximize frame.
           No flex needed — just force the child to exactly 100% height. */
        #fs-container.maximized #card-inner {
          overflow: hidden;
        }
        /* !important overrides any HA-injected inline style on the card element
           (e.g. height:auto or height:Xpx from automatic-height layout setting).
           CSS !important author rules beat normal inline styles in the cascade,
           so the child is bounded to #card-inner's height → its internal
           .card-content (overflow:auto) gets a definite height → scrollbars work. */
        #fs-container.maximized #card-inner > * {
          height: 100% !important;
          max-height: 100% !important;
          min-height: 0 !important;
          width: 100% !important;
          min-width: 0;
        }

        #card-inner.rows-override {
          height: var(--fs-card-height);
          max-height: 100%;
          overflow-y: auto;
        }
        #card-inner > * {
          display: block;
          width: 100%;
          height: 100%;
        }
      </style>
      <div id="fs-container">
        <button id="fs-btn" title="Maximieren">
          <svg class="icon-fs" viewBox="0 0 18 18" width="16" height="16" fill="currentColor">
            <path d="M1 1v5h2V3h3V1zm16 0H12v2h3v3h2zm-16 16h5v-2H3v-3H1zm16 0v-5h-2v3h-3v2z"/>
          </svg>
          <svg class="icon-win" viewBox="0 0 18 18" width="16" height="16" fill="currentColor">
            <path d="M6 6v-5H4v3H1v2zm6 0v-5h2v3h3v2zm-6 6v5H4v-3H1v-2zm6 0v5h2v-3h3v-2z"/>
          </svg>
        </button>
        <div id="card-inner"></div>
      </div>
    `;

    const container = this.shadowRoot.getElementById('card-inner');

    // Set --row-size BEFORE appending so the card reads the correct value on first render
    this._applyRowSize(container, this._config.grid_options?.rows);

    if (this.cardElement) {
      container.appendChild(this.cardElement);
      // Forward layout so child cards that check this.layout (e.g. energy-custom-graph-card)
      // detect they are in a section layout and use height:100% instead of a fixed fallback.
      this._forwardLayout();
    } else {
      container.style.display = 'flex';
      container.style.alignItems = 'center';
      container.style.justifyContent = 'center';
      container.innerHTML = '<div style="padding:16px;color:var(--secondary-text-color);font-size:14px">Keine Karte konfiguriert</div>';
    }

    this.shadowRoot.getElementById('fs-btn').onclick = (e) => {
      e.stopPropagation();
      const fsContainer = this.shadowRoot.getElementById('fs-container');
      const cardInner   = this.shadowRoot.getElementById('card-inner');
      const isMax       = !fsContainer.classList.contains('maximized');
        const nextTitle   = isMax ? 'Wiederherstellen' : 'Maximieren';

      const ANIM = 'top 0.35s cubic-bezier(0.4,0,0.2,1), left 0.35s cubic-bezier(0.4,0,0.2,1), width 0.35s cubic-bezier(0.4,0,0.2,1), height 0.35s cubic-bezier(0.4,0,0.2,1), border-radius 0.35s cubic-bezier(0.4,0,0.2,1), padding 0.35s cubic-bezier(0.4,0,0.2,1)';

      if (isMax) {
        // Read the host element's rect — it's always in normal flow, gives accurate screen position
        const rect = this.getBoundingClientRect();
        this._fsOriginalRect = rect;

        // Insert a placeholder that holds the card's layout space while it is fixed,
        // so the dashboard height and scrollbars remain unchanged.
        const placeholder = document.createElement('div');
        placeholder.style.cssText = `display:block;width:${rect.width}px;height:${rect.height}px;pointer-events:none;visibility:hidden;flex-shrink:0;`;
        this.insertAdjacentElement('afterend', placeholder);
        this._fsPlaceholder = placeholder;

        // 1) Pin at card position — no transition yet
        Object.assign(fsContainer.style, {
          position:     'fixed',
          top:          rect.top + 'px',
          left:         rect.left + 'px',
          width:        rect.width + 'px',
          height:       rect.height + 'px',
          zIndex:       '4',
          boxSizing:    'border-box',
          background:   'var(--lovelace-background, var(--primary-background-color))',
          overflow:     'hidden',
          borderRadius: 'var(--ha-card-border-radius, 12px)',
          padding:      '0',
          transition:   'none',
        });
        _enterTopLayer(fsContainer);

        // 2) Force synchronous reflow so the browser registers start state
        void fsContainer.offsetHeight;

        // Measure the lovelace footer (if present) and pin it to the bottom of the viewport.
        // The maximized card ends above the footer (height minus footerH), so the footer
        // stays visible. z-index:9999 keeps it above the backdrop (and above the card
        // in the z-index fallback without top layer).
        const footer = _findHAFooter();
        let footerH = 0;
        if (footer) {
          const fr = footer.getBoundingClientRect();
          footerH = fr.height > 0 ? Math.round(fr.height) : 0;
          if (footerH > 0) {
            this._fsFooter = {
              el:           footer,
              origPosition: footer.style.position,
              origBottom:   footer.style.bottom,
              origLeft:     footer.style.left,
              origWidth:    footer.style.width,
              origZIndex:   footer.style.zIndex,
            };
            // Force footer into the root stacking context at z-index:9999
            // so it paints above our z-index:4 maximize card.
            footer.style.position = 'fixed';
            footer.style.bottom   = '0';
            footer.style.left     = fr.left + 'px';
            footer.style.width    = fr.width + 'px';
            footer.style.zIndex   = '9999';
          }
        }
        if (footerH > 0) fsContainer.style.setProperty('--fs-footer-h', footerH + 'px');

        // Inject a full-viewport backdrop so other cards cannot be seen
        // through the footer gap (or during the open animation).
        // It lives in our shadow root, i.e. inside HA's stacking context:
        // z-index:3 is above the dashboard but below HA's header, sidebar and
        // the pinned footer. (Appended to document.body it would cover the
        // whole HA UI since HA 2026.11 isolates <home-assistant-main>.)
        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3;background:var(--lovelace-background, var(--primary-background-color));pointer-events:none;';
        this.shadowRoot.insertBefore(backdrop, fsContainer);
        this._fsBackdrop = backdrop;

        // 3) Enable transition and animate to maximize
        const frame = _getHAMaximizeFrame();
        fsContainer.style.setProperty('--fs-top', frame.top + 'px');
        fsContainer.style.setProperty('--fs-left', frame.left + 'px');
        fsContainer.style.setProperty('--fs-width', frame.width + 'px');
        Object.assign(fsContainer.style, {
          transition:   ANIM,
          top:          'var(--fs-top, var(--header-height, 56px))',
          left:         'var(--fs-left, 0px)',
          width:        'var(--fs-width, 100vw)',
          height:       `calc(100vh - var(--fs-top, var(--header-height, 56px)) - ${footerH}px)`,
          borderRadius: '0',
          padding:      'var(--lovelace-card-padding, 8px)',
        });

        fsContainer.classList.add('maximized');
        this._notifyOthers(true);
        this._startLayoutWatch();

        // 4) After the opening animation finishes: lock background scroll
        const OPEN_DURATION = 350;
        let openDone = false;
        const afterOpen = () => {
          if (openDone) return;
          openDone = true;
          this._fsLocks = _lockHAScroll();
        };
        fsContainer.addEventListener('transitionend', afterOpen, { once: true });
        setTimeout(afterOpen, OPEN_DURATION + 50);
      } else {
        this._stopLayoutWatch();
        // Closing: unlock background scroll BEFORE animation starts so the
        // background is already at the right position when the card returns.
        _unlockHAScroll(this._fsLocks);
        this._fsLocks = null;
        if (this._fsFooter) {
          this._fsFooter.el.style.position = this._fsFooter.origPosition;
          this._fsFooter.el.style.bottom   = this._fsFooter.origBottom;
          this._fsFooter.el.style.left     = this._fsFooter.origLeft;
          this._fsFooter.el.style.width    = this._fsFooter.origWidth;
          this._fsFooter.el.style.zIndex   = this._fsFooter.origZIndex;
          this._fsFooter = null;
        }
        this._notifyOthers(false);

        // Animate back to original card rect
        const orig = this._fsOriginalRect || this.getBoundingClientRect();

        void fsContainer.offsetHeight;

        Object.assign(fsContainer.style, {
          transition:   ANIM,
          top:          orig.top + 'px',
          left:         orig.left + 'px',
          width:        orig.width + 'px',
          height:       orig.height + 'px',
          borderRadius: 'var(--ha-card-border-radius, 12px)',
          padding:      '0',
        });

        fsContainer.classList.remove('maximized');

        const cleanup = (e) => {
          // transitionend bubbles up from the child card (e.g. hover effects)
          if (e && e.target !== fsContainer) return;
          fsContainer.removeEventListener('transitionend', cleanup);
          // Return element to normal flow
          _leaveTopLayer(fsContainer);
          ['position','top','left','width','height','zIndex','boxSizing',
           'background','overflow','borderRadius','padding','transition'].forEach(
            p => fsContainer.style.removeProperty(p.replace(/[A-Z]/g, c => '-' + c.toLowerCase()))
          );
          fsContainer.style.removeProperty('--fs-footer-h');
          fsContainer.style.removeProperty('--fs-top');
          fsContainer.style.removeProperty('--fs-left');
          fsContainer.style.removeProperty('--fs-width');
          // Remove placeholder after card is back in normal flow
          if (this._fsPlaceholder) {
            this._fsPlaceholder.remove();
            this._fsPlaceholder = null;
          }
          // Remove backdrop once the closing animation has finished
          if (this._fsBackdrop) {
            this._fsBackdrop.remove();
            this._fsBackdrop = null;
          }
        };
        fsContainer.addEventListener('transitionend', cleanup);
        setTimeout(cleanup, 500); // fallback
      }

      this.classList.toggle('maximized', isMax);
      this.cardElement?.classList.toggle('fs-maximized', isMax);
      this.shadowRoot.getElementById('fs-btn').title = nextTitle;

      const fsRows     = this._config.grid_options_full?.rows;
      const normalRows = this._config.grid_options?.rows;
      // When going maximized with no explicit rows configured, use a large sentinel.
      // rows-override CSS has max-height:100%, so the sentinel is always capped to
      // the container height — identical to height:100% but gives #card-inner a
      // concrete pixel height that properly bounds the child's overflow:auto scroll.
      const FS_AUTO_ROWS = 100;
      const activeRows = isMax ? (fsRows ?? FS_AUTO_ROWS) : normalRows;

      // 1) Set --row-size + CSS height so charts read the correct value
      this._applyRowSize(cardInner, activeRows);

      // 2) Config update so config-reading cards recompute from grid_options.rows.
      // Only call setConfig when grid_options_full is configured AND the rows value
      // actually differs between normal and maximized — avoids triggering a data
      // reload in cards like history-table-card that treat every setConfig as new config.
      const rowsChanged = fsRows != null && fsRows !== normalRows;
      if (rowsChanged && this.cardElement?.setConfig) {
        try {
          this.cardElement.setConfig(this._buildChildConfig(isMax));
          if (this._hass) this.cardElement.hass = this._hass;
        } catch (e) { /* some cards reject repeated setConfig — ignore */ }
      }

      // Fire a single resize once the CSS transition finishes.
      const onTransitionEnd = () => {
        fsContainer.removeEventListener('transitionend', onTransitionEnd);
        window.dispatchEvent(new Event('resize'));
      };
      fsContainer.addEventListener('transitionend', onTransitionEnd);
      setTimeout(() => {
        fsContainer.removeEventListener('transitionend', onTransitionEnd);
        window.dispatchEvent(new Event('resize'));
      }, 400);
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (this.cardElement) this.cardElement.hass = hass;
  }

  set editMode(val) {
    this._editMode = val;
    this.classList.toggle('edit-mode', !!val);
    // Exit maximize mode when edit mode is activated
    if (val) {
      const fsContainer = this.shadowRoot?.getElementById('fs-container');
      if (fsContainer?.classList.contains('maximized')) {
        this._stopLayoutWatch();
        _leaveTopLayer(fsContainer);
        fsContainer.classList.remove('maximized');
        this.classList.remove('maximized');
        ['position','top','left','width','height','z-index','box-sizing',
         'background','overflow','border-radius','padding','transition'].forEach(
          p => fsContainer.style.removeProperty(p)
        );
        _unlockHAScroll(this._fsLocks);
        this._fsLocks = null;
        if (this._fsFooter) {
          this._fsFooter.el.style.position = this._fsFooter.origPosition;
          this._fsFooter.el.style.bottom   = this._fsFooter.origBottom;
          this._fsFooter.el.style.left     = this._fsFooter.origLeft;
          this._fsFooter.el.style.width    = this._fsFooter.origWidth;
          this._fsFooter.el.style.zIndex   = this._fsFooter.origZIndex;
          this._fsFooter = null;
        }
        fsContainer.style.removeProperty('--fs-footer-h');
        fsContainer.style.removeProperty('--fs-top');
        fsContainer.style.removeProperty('--fs-left');
        fsContainer.style.removeProperty('--fs-width');
        if (this._fsBackdrop) {
          this._fsBackdrop.remove();
          this._fsBackdrop = null;
        }
        this._notifyOthers(false);
        this.cardElement?.classList.remove('fs-maximized');
        if (this._fsPlaceholder) {
          this._fsPlaceholder.remove();
          this._fsPlaceholder = null;
        }
      }
    }
    if (this.cardElement && 'editMode' in this.cardElement) {
      this.cardElement.editMode = val;
    }
  }

  // Immediately exit maximize mode without animation — used on navigation and edit mode.
  _exitMaximize() {
    const fsContainer = this.shadowRoot?.getElementById('fs-container');
    if (!fsContainer?.classList.contains('maximized')) return;

    this._stopLayoutWatch();

    _unlockHAScroll(this._fsLocks);
    this._fsLocks = null;

    if (this._fsFooter) {
      this._fsFooter.el.style.position = this._fsFooter.origPosition;
      this._fsFooter.el.style.bottom   = this._fsFooter.origBottom;
      this._fsFooter.el.style.left     = this._fsFooter.origLeft;
      this._fsFooter.el.style.width    = this._fsFooter.origWidth;
      this._fsFooter.el.style.zIndex   = this._fsFooter.origZIndex;
      this._fsFooter = null;
    }
    if (this._fsBackdrop) {
      this._fsBackdrop.remove();
      this._fsBackdrop = null;
    }
    if (this._fsPlaceholder) {
      this._fsPlaceholder.remove();
      this._fsPlaceholder = null;
    }

    _leaveTopLayer(fsContainer);
    fsContainer.classList.remove('maximized');
    ['position','top','left','width','height','z-index','box-sizing',
     'background','overflow','border-radius','padding','transition'].forEach(
      p => fsContainer.style.removeProperty(p)
    );
    fsContainer.style.removeProperty('--fs-footer-h');
    fsContainer.style.removeProperty('--fs-top');
    fsContainer.style.removeProperty('--fs-left');
    fsContainer.style.removeProperty('--fs-width');

    this.classList.remove('maximized');
    this.cardElement?.classList.remove('fs-maximized');

    const cardInner = this.shadowRoot?.getElementById('card-inner');
    if (cardInner) this._applyRowSize(cardInner, this._config?.grid_options?.rows);

    this._notifyOthers(false);
  }

  _getHALayoutWatchTargets() {
    const targets = [];
    try {
      const ha = document.querySelector('home-assistant');
      const main = ha?.shadowRoot?.querySelector('home-assistant-main');
      const mainSR = main?.shadowRoot;
      const drawer = mainSR?.querySelector('ha-drawer');
      const panel = (drawer ?? mainSR)?.querySelector('ha-panel-lovelace');
      const sidebar = mainSR?.querySelector('ha-sidebar');

      if (main) targets.push(main);
      if (drawer) targets.push(drawer);
      if (panel) targets.push(panel);
      if (sidebar) targets.push(sidebar);
    } catch (_) {}
    return targets;
  }

  _startLayoutWatch() {
    if (this._layoutResizeObserver || typeof ResizeObserver === 'undefined') return;

    const scheduleSync = () => {
      if (this._layoutWatchRaf) cancelAnimationFrame(this._layoutWatchRaf);
      this._layoutWatchRaf = requestAnimationFrame(() => {
        this._layoutWatchRaf = null;
        this._syncMaximizedFrame();
      });
    };

    this._layoutResizeObserver = new ResizeObserver(() => scheduleSync());
    this._layoutResizeTargets = this._getHALayoutWatchTargets();
    this._layoutResizeTargets.forEach(el => {
      try { this._layoutResizeObserver.observe(el); } catch (_) {}
    });

    scheduleSync();
  }

  _stopLayoutWatch() {
    if (this._layoutWatchRaf) {
      cancelAnimationFrame(this._layoutWatchRaf);
      this._layoutWatchRaf = null;
    }
    if (this._layoutResizeObserver) {
      try { this._layoutResizeObserver.disconnect(); } catch (_) {}
      this._layoutResizeObserver = null;
    }
    this._layoutResizeTargets = null;
  }

  // Keep maximized frame aligned when viewport or HA layout changes.
  _syncMaximizedFrame() {
    const fsContainer = this.shadowRoot?.getElementById('fs-container');
    if (!fsContainer?.classList.contains('maximized')) return;

    const frame = _getHAMaximizeFrame();
    fsContainer.style.setProperty('--fs-top', frame.top + 'px');
    fsContainer.style.setProperty('--fs-left', frame.left + 'px');
    fsContainer.style.setProperty('--fs-width', frame.width + 'px');

    const footer = this._fsFooter?.el || _findHAFooter();
    const footerRect = footer?.getBoundingClientRect();
    const footerH = footerRect && footerRect.height > 0 ? Math.round(footerRect.height) : 0;

    if (this._fsFooter?.el && footer) {
      // Footer is forced to fixed while maximized; keep it aligned to the content frame.
      footer.style.left  = frame.left + 'px';
      footer.style.width = frame.width + 'px';
    }

    if (footerH > 0) fsContainer.style.setProperty('--fs-footer-h', footerH + 'px');
    else fsContainer.style.removeProperty('--fs-footer-h');
  }

  connectedCallback() {
    _fswRegistry.add(this);
    // Close maximize automatically when the user navigates to a different
    // Lovelace view (tab). HA fires 'location-changed' on programmatic navigation;
    // 'hashchange' covers hash-based tab switching as a fallback.
    this._onNavChange = () => this._exitMaximize();
    window.addEventListener('location-changed', this._onNavChange);
    window.addEventListener('hashchange', this._onNavChange);
    this._onWindowResize = () => {
      if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = null;
        this._syncMaximizedFrame();
      });
    };
    window.addEventListener('resize', this._onWindowResize);
  }

  _notifyOthers(isMax) {
    for (const inst of _fswRegistry) {
      if (inst === this) continue;
      const btn = inst.shadowRoot?.getElementById('fs-btn');
      if (btn) btn.style.display = isMax ? 'none' : '';
    }
  }

  disconnectedCallback() {
    _fswRegistry.delete(this);
    this._stopLayoutWatch();
    window.removeEventListener('location-changed', this._onNavChange);
    window.removeEventListener('hashchange', this._onNavChange);
    window.removeEventListener('resize', this._onWindowResize);
    if (this._resizeRaf) {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = null;
    }
    if (this.classList.contains('maximized')) this._notifyOthers(false);
    // Clean up maximize state if the card is removed from the DOM
    const fsContainer = this.shadowRoot?.getElementById('fs-container');
    if (fsContainer) _leaveTopLayer(fsContainer);
    if (fsContainer?.classList.contains('maximized')) {
      fsContainer.classList.remove('maximized');
      ['position','top','left','width','height','z-index','box-sizing',
       'background','overflow','border-radius','padding','transition'].forEach(
        p => fsContainer.style.removeProperty(p)
      );
      fsContainer.style.removeProperty('--fs-footer-h');
      fsContainer.style.removeProperty('--fs-top');
      fsContainer.style.removeProperty('--fs-left');
      fsContainer.style.removeProperty('--fs-width');
    }
    this.classList.remove('maximized');
    this.cardElement?.classList.remove('fs-maximized');
    _unlockHAScroll(this._fsLocks);
    this._fsLocks = null;
    if (this._fsFooter) {
      this._fsFooter.el.style.position = this._fsFooter.origPosition;
      this._fsFooter.el.style.bottom   = this._fsFooter.origBottom;
      this._fsFooter.el.style.left     = this._fsFooter.origLeft;
      this._fsFooter.el.style.width    = this._fsFooter.origWidth;
      this._fsFooter.el.style.zIndex   = this._fsFooter.origZIndex;
      this._fsFooter = null;
    }
    if (this._fsPlaceholder) {
      this._fsPlaceholder.remove();
      this._fsPlaceholder = null;
    }
    if (this._fsBackdrop) {
      this._fsBackdrop.remove();
      this._fsBackdrop = null;
    }
  }

  // Forward HA's layout property to the child card.
  // Cards like energy-custom-graph-card check this.layout === "grid" to
  // decide whether to use height:100% or fall back to a fixed pixel height.
  set layout(val) {
    this._layout = val;
    this._forwardLayout();
  }

  get layout() {
    return this._layout;
  }

  _forwardLayout() {
    if (this.cardElement && this._layout !== undefined) {
      this.cardElement.layout = this._layout;
      this.cardElement.requestUpdate?.();
    }
  }

  getCardSize() { return 3; }

  static getConfigElement() {
    return document.createElement("maximize-wrapper-card-editor");
  }

  static getStubConfig() {
    return {};
  }
}

customElements.define("maximize-wrapper-card", MaximizeWrapperCard);

// Register in HA's card picker
window.customCards = window.customCards || [];
window.customCards.push({
  type: "maximize-wrapper-card",
  name: "Maximize Wrapper",
  description: "Wraps any card with a maximize toggle button.",
  preview: false,
});

// ── Editor ────────────────────────────────────────────────────────────────────

class MaximizeWrapperCardEditor extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    if (this._cardEditor) this._cardEditor.hass = hass;
  }

  setConfig(config) {
    this._config = config;
    if (!this.shadowRoot || !this.shadowRoot.getElementById('child-editor-slot')) {
      // First call — build the full scaffold
      this._editorMounted = false;
      this._render();
    } else {
      // Subsequent calls from HA after our own config-changed dispatches —
      // only update the rows input and the child editor, never wipe the DOM.
      const rowsInput = this.shadowRoot.getElementById('rows-input');
      if (rowsInput) rowsInput.value = config.grid_options_full?.rows ?? '';
      this._mountChildEditor();
    }
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .section-label {
          font-weight: 500;
          font-size: 13px;
          color: var(--secondary-text-color);
          margin: 16px 0 4px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .rows-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 8px;
        }
        .rows-row label {
          flex: 1;
          font-size: 14px;
        }
        .rows-row input[type=number] {
          width: 70px;
          padding: 6px 8px;
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-size: 14px;
        }
        .hint {
          font-size: 12px;
          color: var(--secondary-text-color);
          margin-top: 2px;
        }
        .card-type-label {
          font-size: 13px;
          color: var(--secondary-text-color);
          cursor: help;
          display: inline-block;
        }
        .section-divider {
          border: none;
          border-top: 1px solid var(--divider-color);
          margin: 16px 0 0;
        }
        .child-card-section {
          background: rgba(128, 128, 128, 0.08);
          border-radius: 8px;
          padding: 8px 12px 12px;
          margin-top: 8px;
        }
        .child-card-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 4px;
        }
        .child-card-header .section-label { margin: 0; }
        #child-editor-slot { margin-top: 4px; }
        .unwrap-row {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--divider-color);
        }
        .unwrap-btn {
          font-size: 12px;
          color: var(--error-color, #db4437);
          background: none;
          border: 1px solid currentColor;
          border-radius: 4px;
          padding: 4px 10px;
          cursor: pointer;
          white-space: nowrap;
        }
        .unwrap-btn.secondary {
          color: var(--secondary-text-color);
          border-color: var(--secondary-text-color);
        }
        .unwrap-confirm-row {
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--divider-color);
        }
        .unwrap-confirm-msg {
          font-size: 12px;
          color: var(--warning-color, #f4b400);
          margin-bottom: 8px;
          line-height: 1.4;
        }
        .unwrap-confirm-btns {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
      </style>
      <div class="section-label">Maximize options</div>
      <div class="rows-row">
        <label>Rows in maximize mode (grid_options_full)</label>
        <input id="rows-input" type="number" min="1" max="100"
          value="${this._config.grid_options_full?.rows ?? ''}"
          placeholder="—">
      </div>
      <div class="hint">Sets card height in maximize mode (rows × 56px + gaps).</div>
      <hr class="section-divider">
      <div class="child-card-section">
        <div class="child-card-header">
          <span class="section-label">Child Card</span>
          <span id="child-card-type" class="card-type-label"></span>
        </div>
        <div id="child-editor-slot"></div>
        <div id="unwrap-area"></div>
      </div>
    `;

    this.shadowRoot.getElementById('rows-input').addEventListener('change', (e) => {
      const val = parseInt(e.target.value);
      const updated = { ...this._config };
      if (!isNaN(val) && val > 0) {
        updated.grid_options_full = { ...(this._config.grid_options_full || {}), rows: val };
      } else {
        const { grid_options_full, ...rest } = updated;
        Object.assign(updated, rest);
        delete updated.grid_options_full;
      }
      this._config = updated;
      this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
    });

    this._mountChildEditor();
  }

  async _mountChildEditor() {
    const slot = this.shadowRoot.getElementById('child-editor-slot');
    if (!slot) return;

    const hasType = !!this._config.card?.type;

    // If already mounted and type-presence unchanged, just sync the value
    if (this._editorMounted && hasType === this._editorHadType) {
      if (this._cardEditor && hasType) {
        this._cardEditor.value = this._config.card;
      }
      return;
    }

    // Generation counter: if another call starts while we await, discard this one
    this._mountGen = (this._mountGen || 0) + 1;
    const myGen = this._mountGen;

    slot.innerHTML = '';
    this._cardEditor = null;
    this._editorMounted = true;
    this._editorHadType = hasType;

    const typeSpanClear = this.shadowRoot.getElementById('child-card-type');
    if (typeSpanClear) typeSpanClear.textContent = '';

    const unwrapArea = this.shadowRoot.getElementById('unwrap-area');
    if (unwrapArea) unwrapArea.innerHTML = '';

    if (!hasType) {
      // No type yet — show the card picker grid.
      // hui-card-picker needs lovelace.views to exist (for compute-unused-entities).
      // We provide the real config; if unavailable we fall back to YAML entry.
      const lovelaceConfig = this._getLovelace();
      if (customElements.get('hui-card-picker') && lovelaceConfig?.views) {
        const picker = document.createElement('hui-card-picker');
        picker.hass = this._hass;
        picker.lovelace = lovelaceConfig;
        picker.addEventListener('config-changed', (e) => {
          e.stopPropagation();
          this._config = { ...this._config, card: e.detail.config };
          this._editorMounted = false;
          this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
          this._mountChildEditor();
        });
        slot.appendChild(picker);
        return;
      }

      // Fallback: plain YAML entry with a Save button
      const hint = document.createElement('div');
      hint.style.cssText = 'padding:4px 0 8px;font-size:13px;color:var(--secondary-text-color)';
      hint.textContent = 'Enter the child card configuration in YAML, then click Save.';
      slot.appendChild(hint);

      await customElements.whenDefined('ha-yaml-editor');
      const yamlEl = document.createElement('ha-yaml-editor');
      yamlEl.hass = this._hass;
      yamlEl.defaultValue = this._config.card || {};
      yamlEl.autofocus = true;
      slot.appendChild(yamlEl);

      const saveRow = document.createElement('div');
      saveRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:8px';
      const saveBtn = document.createElement('mwc-button');
      saveBtn.setAttribute('raised', '');
      saveBtn.textContent = 'Save card';
      saveBtn.addEventListener('click', () => {
        const val = yamlEl.value;
        if (!val || typeof val !== 'object' || !val.type) {
          this._prevCard = null;
          this._config = { ...this._config, card: {} };
          this._editorMounted = false;
          this._mountChildEditor();
          return;
        }
        this._prevCard = null;
        this._config = { ...this._config, card: val };
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
        this._editorMounted = false;
        this._mountChildEditor();
      });
      saveRow.appendChild(saveBtn);
      slot.appendChild(saveRow);
      return;
    }

    // Type is set — update inline type label + show full GUI editor
    const typeSpan = this.shadowRoot.getElementById('child-card-type');
    if (typeSpan) {
      typeSpan.textContent = this._config.card.type;
      typeSpan.title = 'To change the child card type, delete this card and create a new one.';
    }

    // Unwrap button — only shown when a child type is configured
    if (unwrapArea) {
      const showUnwrapBtn = () => {
        unwrapArea.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'unwrap-row';
        const btn = document.createElement('button');
        btn.className = 'unwrap-btn';
        btn.textContent = 'Remove wrapper';
        btn.title = 'Replace this maximize-wrapper-card with the child card directly';
        btn.addEventListener('click', () => {
          unwrapArea.innerHTML = '';
          const confirmDiv = document.createElement('div');
          confirmDiv.className = 'unwrap-confirm-row';
          const msg = document.createElement('div');
          msg.className = 'unwrap-confirm-msg';
          msg.textContent = '\u26a0 The maximize-wrapper-card will be replaced by the child card directly. The maximize button and all wrapper settings (grid_options_full, etc.) will be permanently lost.';
          const btnsRow = document.createElement('div');
          btnsRow.className = 'unwrap-confirm-btns';
          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'unwrap-btn secondary';
          cancelBtn.textContent = 'Cancel';
          cancelBtn.addEventListener('click', showUnwrapBtn);
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'unwrap-btn';
          confirmBtn.textContent = 'Confirm — remove wrapper';
          confirmBtn.addEventListener('click', () => {
            this.dispatchEvent(new CustomEvent('config-changed', {
              detail: { config: this._config.card },
              bubbles: true,
              composed: true,
            }));
          });
          btnsRow.appendChild(cancelBtn);
          btnsRow.appendChild(confirmBtn);
          confirmDiv.appendChild(msg);
          confirmDiv.appendChild(btnsRow);
          unwrapArea.appendChild(confirmDiv);
        });
        row.appendChild(btn);
        unwrapArea.appendChild(row);
      };
      showUnwrapBtn();
    }

    await customElements.whenDefined('hui-card-element-editor');
    if (this._mountGen !== myGen) return; // superseded by a newer mount
    const editorEl = document.createElement('hui-card-element-editor');
    editorEl.addEventListener('config-changed', (e) => {
      e.stopPropagation();
      const newCard = e.detail.config;
      if (newCard === undefined || newCard === null) return;
      this._config = { ...this._config, card: newCard };
      this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
      this._editorHadType = !!newCard?.type;
    });
    editorEl.addEventListener('GUImode-changed', (e) => e.stopPropagation());
    slot.appendChild(editorEl);
    this._cardEditor = editorEl;
    editorEl.hass = this._hass;
    editorEl.lovelace = this._getLovelace();
    editorEl.value = this._config.card;
  }

  _getLovelace() {
    // Walk up the DOM to find the lovelace panel, then return its raw config
    // (LovelaceConfig with views[]) — what hui-card-picker and hui-card-element-editor expect.
    let root = document.querySelector('home-assistant');
    root = root?.shadowRoot?.querySelector('home-assistant-main');
    const panel = root?.shadowRoot?.querySelector('ha-drawer ha-panel-lovelace') ||
                  root?.shadowRoot?.querySelector('partial-panel-resolver ha-panel-lovelace');
    return panel?.lovelace?.config || null;
  }
}

customElements.define("maximize-wrapper-card-editor", MaximizeWrapperCardEditor);

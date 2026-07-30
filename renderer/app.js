// The dashboard.
//
// One card per provider, in registry order. Cards are fed by the
// `provider-updated` event — the renderer never polls, and it never computes
// item data of its own. The launcher and this grid read the same cache through
// the same commands, so a row here and a row there can't disagree.
(function () {
  'use strict';

  const api = window.hubApi;
  const { iconSvg, ACTION_ICONS } = window.DevHubIcons;

  /** provider id → ProviderResult, in the order the backend returned them. */
  const results = new Map();
  let settings = null;
  let collapsed = new Set();

  const gridEl = document.getElementById('grid');
  const bannerEl = document.getElementById('banner');
  const toastEl = document.getElementById('toast');

  // --- helpers -------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Mirrors util::relative_age in the backend, for last-refreshed stamps. */
  function relativeAge(unixSeconds) {
    if (!unixSeconds) return 'never';
    const secs = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  function statusClass(status) {
    return ['ok', 'warn', 'error', 'pending'].includes(status) ? status : '';
  }

  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.add('visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastEl.classList.remove('visible'), 3200);
  }

  function showBanner(message, actionLabel, action) {
    bannerEl.querySelector('.banner-text').textContent = message;
    const button = document.getElementById('banner-action');
    button.textContent = actionLabel || 'Open config';
    if (action) bannerAction = action;
    bannerEl.classList.add('visible');
  }

  function hideBanner() {
    bannerEl.classList.remove('visible');
  }

  // --- rendering -----------------------------------------------------------

  function rowHtml(item) {
    const key = `${item.provider}::${item.id}`;
    const badges = (item.badges || []).map(b => {
      const warn = /^(dirty|overdue|unreachable|expected )/i.test(b);
      return `<span class="badge ${warn ? 'warn' : ''}">${esc(b)}</span>`;
    }).join('');
    // Action 0 is the row click; the rest live in the hover strip, so every
    // action an item carries is reachable without a context menu. Each carries
    // its label — a strip of unlabelled glyphs means hovering every one of them
    // to find out which is which.
    const extra = (item.actions || []).slice(1).map((a, i) => `
      <button class="row-btn" data-key="${esc(key)}" data-action="${i + 1}" title="${esc(a.label)}">
        ${iconSvg(ACTION_ICONS[a.kind] || 'chevron')}<span>${esc(a.label)}</span>
      </button>`).join('');

    return `
      <div class="card-row" tabindex="0" data-key="${esc(key)}" data-action="0" title="${esc(item.title)}">
        <span class="row-dot ${statusClass(item.status)}"></span>
        <span class="row-main">
          <span class="row-title">${esc(item.title)}</span>
          ${item.subtitle ? `<span class="row-sub">${esc(item.subtitle)}</span>` : ''}
          ${badges ? `<span class="row-badges">${badges}</span>` : ''}
        </span>
        <span class="row-actions">${extra}</span>
      </div>`;
  }

  function bodyHtml(result) {
    let html = '';
    // The error goes above the items, not instead of them: a partly-failing
    // scan should show what it did find and say what it couldn't reach.
    if (result.error) html += `<div class="card-error">${esc(result.error)}</div>`;
    if (result.items && result.items.length) {
      html += result.items.map(rowHtml).join('');
    } else if (!result.error) {
      html += `<div class="card-empty">${result.refreshedAt ? 'Nothing here yet.' : 'Loading…'}</div>`;
    }
    return html;
  }

  /** The stored size for a card, clamped to a grid that may have shrunk. */
  function layoutFor(providerId) {
    const columns = (settings && settings.dashboardColumns) || 2;
    const stored = (settings && settings.cardLayout && settings.cardLayout[providerId]) || {};
    return {
      span: Math.min(Math.max(Number(stored.span) || 1, 1), columns),
      height: Number(stored.height) || 0,
    };
  }

  function cardHtml(result) {
    const isCollapsed = collapsed.has(result.provider);
    const layout = layoutFor(result.provider);
    const columns = (settings && settings.dashboardColumns) || 2;
    return `
      <section class="card ${isCollapsed ? 'collapsed' : ''}" data-provider="${esc(result.provider)}"
               style="grid-column: span ${layout.span}">
        <header class="card-header">
          <span class="card-chevron">${iconSvg('chevron')}</span>
          <span class="card-title">${esc(result.displayName || result.provider)}</span>
          <span class="card-count">${(result.items || []).length}</span>
          <span class="card-meta">${esc(relativeAge(result.refreshedAt))}</span>
          ${columns > 1 ? `
            <button class="card-btn" data-widen="${esc(result.provider)}"
                    title="${layout.span > 1 ? 'Make this card narrower' : 'Make this card wider'}">
              ${iconSvg('grid')}
            </button>` : ''}
          <button class="card-btn" data-refresh="${esc(result.provider)}" title="Refresh this card">
            ${iconSvg('refresh')}
          </button>
        </header>
        <div class="card-body" ${layout.height ? `style="max-height:${layout.height}px"` : ''}>${bodyHtml(result)}</div>
        <div class="card-resize" data-resize="${esc(result.provider)}" title="Drag to resize · double-click to fit"></div>
      </section>`;
  }

  /** Persist a card's size. Merged, so widening doesn't forget a set height. */
  function saveLayout(providerId, patch) {
    const layout = Object.assign({}, layoutFor(providerId), patch);
    settings.cardLayout = Object.assign({}, settings.cardLayout, { [providerId]: layout });
    api.saveSettings({ cardLayout: settings.cardLayout }).catch(() => {});
  }

  function toggleWidth(providerId) {
    const columns = (settings && settings.dashboardColumns) || 2;
    const next = layoutFor(providerId).span > 1 ? 1 : Math.min(2, columns);
    saveLayout(providerId, { span: next });
    renderCard(providerId);
  }

  /** Drag the handle at a card's foot to set its height. */
  function startResize(providerId, event) {
    const card = gridEl.querySelector(`.card[data-provider="${CSS.escape(providerId)}"]`);
    const body = card && card.querySelector('.card-body');
    if (!body) return;
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = body.getBoundingClientRect().height;
    document.body.classList.add('resizing');

    const onMove = (move) => {
      const height = Math.max(80, Math.round(startHeight + (move.clientY - startY)));
      body.style.maxHeight = `${height}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing');
      saveLayout(providerId, { height: Math.round(body.getBoundingClientRect().height) });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function renderGrid() {
    gridEl.innerHTML = [...results.values()].map(cardHtml).join('');
  }

  /** Replace a single card in place, so a refresh doesn't reflow the grid. */
  function renderCard(providerId) {
    const result = results.get(providerId);
    if (!result) return;
    const existing = gridEl.querySelector(`.card[data-provider="${CSS.escape(providerId)}"]`);
    if (!existing) { renderGrid(); return; }
    const wrapper = document.createElement('div');
    wrapper.innerHTML = cardHtml(result);
    existing.replaceWith(wrapper.firstElementChild);
  }

  function applyColumns() {
    gridEl.style.setProperty('--columns', String((settings && settings.dashboardColumns) || 2));
  }

  function applyTheme(theme) {
    const resolved = theme === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme;
    document.body.dataset.theme = resolved === 'light' ? 'light' : 'dark';
  }

  // --- actions -------------------------------------------------------------

  async function runAction(key, actionIndex) {
    let result;
    try { result = await api.runAction(key, actionIndex); }
    catch (err) { result = { success: false, message: String(err) }; }
    if (result && result.success) {
      if (result.message) toast(result.message);
    } else {
      toast((result && result.message) || 'That action did not run.', true);
    }
  }

  async function refreshProvider(providerId, button) {
    if (button) button.classList.add('spinning');
    try {
      const result = await api.refreshProvider(providerId);
      if (result) { results.set(result.provider, result); renderCard(result.provider); }
    } catch (err) {
      toast(String(err), true);
    } finally {
      if (button) button.classList.remove('spinning');
    }
  }

  async function refreshAll() {
    const button = document.getElementById('refresh-all');
    button.classList.add('spinning');
    try {
      const all = await api.refreshAll();
      (all || []).forEach(r => results.set(r.provider, r));
      renderGrid();
    } catch (err) {
      toast(String(err), true);
    } finally {
      button.classList.remove('spinning');
    }
  }

  function toggleCard(providerId) {
    if (collapsed.has(providerId)) collapsed.delete(providerId);
    else collapsed.add(providerId);
    const card = gridEl.querySelector(`.card[data-provider="${CSS.escape(providerId)}"]`);
    if (card) card.classList.toggle('collapsed', collapsed.has(providerId));
    // Collapse state is app state, so it belongs in settings.json rather than
    // being rediscovered on every launch.
    api.saveSettings({ collapsed: [...collapsed] }).catch(() => {});
  }

  // --- wiring --------------------------------------------------------------

  function wireGrid() {
    gridEl.addEventListener('mousedown', (event) => {
      const handle = event.target.closest('.card-resize');
      if (handle) startResize(handle.dataset.resize, event);
    });

    gridEl.addEventListener('dblclick', (event) => {
      const handle = event.target.closest('.card-resize');
      if (!handle) return;
      saveLayout(handle.dataset.resize, { height: 0 });
      renderCard(handle.dataset.resize);
    });

    gridEl.addEventListener('click', (event) => {
      const widen = event.target.closest('[data-widen]');
      if (widen) {
        event.stopPropagation();
        toggleWidth(widen.dataset.widen);
        return;
      }
      const refresh = event.target.closest('[data-refresh]');
      if (refresh) {
        event.stopPropagation();
        refreshProvider(refresh.dataset.refresh, refresh);
        return;
      }
      const header = event.target.closest('.card-header');
      if (header) {
        toggleCard(header.closest('.card').dataset.provider);
        return;
      }
      const button = event.target.closest('.row-btn');
      if (button) {
        event.stopPropagation();
        runAction(button.dataset.key, parseInt(button.dataset.action, 10));
        return;
      }
      const row = event.target.closest('.card-row');
      if (row) runAction(row.dataset.key, 0);
    });

    gridEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('.card-row');
      if (!row) return;
      event.preventDefault();
      runAction(row.dataset.key, 0);
    });
  }

  /// What the banner's action button does, set alongside the message.
  let bannerAction = () => api.revealConfigFile();

  function wireTopbar() {
    document.getElementById('search-icon').innerHTML = iconSvg('search');
    document.querySelectorAll('[data-icon]').forEach(el => {
      el.innerHTML = iconSvg(el.dataset.icon);
    });

    document.getElementById('search-wrap').addEventListener('click', () => api.showLauncher());
    document.getElementById('refresh-all').addEventListener('click', refreshAll);
    document.getElementById('open-settings').addEventListener('click', () => window.DevHubSettings.open());
    document.getElementById('banner-action').addEventListener('click', () => bannerAction());
    document.getElementById('toggle-theme').addEventListener('click', async () => {
      const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
      applyTheme(next);
      settings = await api.saveSettings({ theme: next });
    });
  }

  /// The hotkey is the app's front door, so a dead one is worth interrupting
  /// for — and it can only be reported by asking, since registration happens
  /// before this window exists to receive an event.
  function reportShortcut(status) {
    if (!status || status.registered || !status.error) return false;
    showBanner(status.error, 'Choose another', () => window.DevHubSettings.open('general'));
    return true;
  }

  function wireEvents() {
    api.onProviderUpdated((result) => {
      if (!result) return;
      const isNew = !results.has(result.provider);
      results.set(result.provider, result);
      if (isNew) renderGrid(); else renderCard(result.provider);
    });

    api.onConfigChanged((payload) => {
      if (payload && payload.ok === false) {
        showBanner(payload.error || 'hub.config.json could not be read.');
      } else {
        hideBanner();
        toast('Config reloaded');
        load();
      }
    });

    api.onShortcutStatus((status) => reportShortcut(status));

    // Last-refreshed stamps are relative, so they go stale just sitting there.
    setInterval(() => {
      gridEl.querySelectorAll('.card').forEach(card => {
        const result = results.get(card.dataset.provider);
        const meta = card.querySelector('.card-meta');
        if (result && meta) meta.textContent = relativeAge(result.refreshedAt);
      });
    }, 30_000);
  }

  async function load() {
    try {
      const [loadedSettings, loadedResults, config, shortcut] = await Promise.all([
        api.getSettings(),
        api.getResults(),
        api.getConfig(),
        api.shortcutStatus(),
      ]);
      settings = loadedSettings;
      collapsed = new Set(settings.collapsed || []);
      applyTheme(settings.theme);
      applyColumns();

      // Only advertise the hotkey on the search box if it actually registered —
      // a label promising a key that does nothing is worse than no label.
      document.getElementById('search-kbd').textContent = shortcut && shortcut.registered
        ? (settings.launcherShortcut || '').replace(/CommandOrControl/i, 'Ctrl')
        : '';

      results.clear();
      (loadedResults || []).forEach(r => results.set(r.provider, r));
      renderGrid();

      // A broken config wins the banner — it's the one that empties the cards.
      if (config && config.error) {
        showBanner(config.error, 'Open config', () => api.revealConfigFile());
      } else if (!reportShortcut(shortcut)) {
        hideBanner();
      }
    } catch (err) {
      showBanner(`Dev Hub could not start cleanly: ${err}`);
    }
  }

  /// Show first-run setup, but only while it is genuinely unanswered.
  ///
  /// Skipping counts as answering: a wizard that reappears every launch until
  /// you complete it is worse than no wizard.
  function maybeOpenSetup() {
    if (!settings || settings.setupComplete) return false;
    window.DevHubSetup.open();
    return true;
  }

  // Exposed for the renderer specs, which drive these directly against stubs
  // rather than reaching into the closure. `toast` is also how settings.js
  // reports back without owning a second notification surface.
  window.DevHubDashboard = {
    load, renderGrid, renderCard, results, relativeAge, rowHtml, cardHtml,
    toggleCard, refreshAll, toast, reportShortcut, maybeOpenSetup,
    collapsedSet: () => collapsed,
  };

  wireTopbar();
  wireGrid();
  if (api) {
    window.DevHubSettings.init(api, {
      onSaved: () => { toast('Settings saved'); load(); },
    });
    window.DevHubSetup.init(api, {
      onDone: () => { toast('Ready to go'); load(); },
    });
    wireEvents();
    load().then(maybeOpenSetup);
  }
})();

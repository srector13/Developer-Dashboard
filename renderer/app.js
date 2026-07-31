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
  /** Provider ids in display order, rewritten by dragging. */
  let order = [];

  const gridEl = document.getElementById('grid');
  const bannerEl = document.getElementById('banner');
  const toastEl = document.getElementById('toast');

  // Colour per card. Cards of one colour are a wall of grey text — a hue per
  // provider is what lets you find the one you want without reading anything.
  const PROVIDER_ACCENTS = {
    launch: '#58a6ff',
    projects: '#bc8cff',
    todos: '#f2c94c',
    health: '#3fb950',
  };
  /** For `command` providers, whose ids aren't known until the config is read. */
  const FALLBACK_ACCENTS = ['#39c5cf', '#ff7b72', '#7ee787', '#ffa657', '#d2a8ff'];

  const PROVIDER_ICONS = {
    launch: 'app', projects: 'git', todos: 'check', health: 'health',
  };

  function accentFor(providerId) {
    if (PROVIDER_ACCENTS[providerId]) return PROVIDER_ACCENTS[providerId];
    let hash = 0;
    for (let i = 0; i < providerId.length; i++) hash = (hash * 31 + providerId.charCodeAt(i)) >>> 0;
    return FALLBACK_ACCENTS[hash % FALLBACK_ACCENTS.length];
  }

  function iconForProvider(providerId) {
    return PROVIDER_ICONS[providerId] || 'command';
  }

  const SIZES = ['small', 'medium', 'large'];

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
    const actions = item.actions || [];
    const groups = item.actionGroups || [];
    // An index that belongs to a group is rendered inside that group's menu,
    // never also as a loose button.
    const grouped = new Set(groups.flatMap(g => g.actions || []));

    const groupButtons = groups.map((group, gi) => {
      const entries = (group.actions || []).map(index => `
        <button class="menu-item" data-key="${esc(key)}" data-action="${index}">
          ${iconSvg(ACTION_ICONS[(actions[index] || {}).kind] || 'chevron')}
          <span>${esc((actions[index] || {}).label || '')}</span>
        </button>`).join('');
      return `
        <span class="row-menu" data-menu="${gi}">
          <button class="row-btn" data-open-menu="${gi}" title="${esc(group.label)}">
            ${iconSvg('chevron')}<span>${esc(group.label)}</span>
          </button>
          <span class="row-menu-list">${entries}</span>
        </span>`;
    }).join('');

    // Anything ungrouped keeps its own labelled button. Index 0 is the row
    // click, so it isn't repeated — unless a group claims it, in which case the
    // menu lists it and the row still runs it.
    const loose = actions.map((a, i) => ({ a, i }))
      .filter(({ i }) => i !== 0 && !grouped.has(i))
      .map(({ a, i }) => `
        <button class="row-btn" data-key="${esc(key)}" data-action="${i}" title="${esc(a.label)}">
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
        <span class="row-actions">${groupButtons}${loose}</span>
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

  /** A card's size preset. Anything unrecognised reads as medium. */
  function sizeFor(providerId) {
    const stored = (settings && settings.cardLayout && settings.cardLayout[providerId]) || {};
    return SIZES.includes(stored.size) ? stored.size : 'medium';
  }

  function setSize(providerId, size) {
    if (!SIZES.includes(size)) return;
    settings.cardLayout = Object.assign({}, settings.cardLayout, { [providerId]: { size } });
    api.saveSettings({ cardLayout: settings.cardLayout }).catch(() => {});
    renderCard(providerId);
  }

  /**
   * Display order: what the user dragged into, then anything new.
   *
   * A provider missing from the saved order goes to the end rather than
   * vanishing — otherwise adding a `command` provider would produce a card that
   * exists but is never drawn.
   */
  function orderedProviders() {
    const live = [...results.keys()];
    const known = order.filter(id => live.includes(id));
    return known.concat(live.filter(id => !known.includes(id)));
  }

  function cardHtml(result) {
    const isCollapsed = collapsed.has(result.provider);
    const size = sizeFor(result.provider);
    const accent = accentFor(result.provider);
    // A double-width card in a one-column grid would overflow the row. The
    // preset is kept — it just can't be honoured until there's a column to
    // spend on it.
    const columns = (settings && settings.dashboardColumns) || 2;
    const narrow = columns < 2 ? ' one-column' : '';
    const sizeButtons = SIZES.map(s => `
      <button class="size-btn ${s === size ? 'active' : ''}" data-size="${s}"
              data-provider="${esc(result.provider)}" title="${s[0].toUpperCase()}${s.slice(1)}">
        ${s[0].toUpperCase()}
      </button>`).join('');

    return `
      <section class="card size-${size}${narrow} ${isCollapsed ? 'collapsed' : ''}"
               data-provider="${esc(result.provider)}" style="--card-accent: ${accent}">
        <header class="card-header" draggable="true" title="Drag to rearrange">
          <span class="card-glyph">${iconSvg(iconForProvider(result.provider))}</span>
          <span class="card-chevron">${iconSvg('chevron')}</span>
          <span class="card-title">${esc(result.displayName || result.provider)}</span>
          <span class="card-count">${(result.items || []).length}</span>
          <span class="card-meta">${esc(relativeAge(result.refreshedAt))}</span>
          <span class="size-group">${sizeButtons}</span>
          <button class="card-btn" data-refresh="${esc(result.provider)}" title="Refresh this card">
            ${iconSvg('refresh')}
          </button>
        </header>
        <div class="card-body">${bodyHtml(result)}</div>
      </section>`;
  }

  function renderGrid() {
    gridEl.innerHTML = orderedProviders()
      .map(id => cardHtml(results.get(id)))
      .join('');
  }

  /** The order as the DOM currently has it — the source of truth while dragging. */
  function domOrder() {
    return [...gridEl.querySelectorAll('.card')].map(card => card.dataset.provider);
  }

  function persistOrder() {
    order = domOrder();
    settings.cardOrder = order;
    api.saveSettings({ cardOrder: order }).catch(() => {});
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

  function closeMenus() {
    gridEl.querySelectorAll('.row-menu.open').forEach(m => m.classList.remove('open'));
  }

  /**
   * Drag a card by its header to rearrange the grid.
   *
   * The DOM is reordered live during the drag, so the other cards move out of
   * the way as you go — the layout you see mid-drag is the layout you get. Only
   * the header starts a drag, so selecting text in a row still works.
   */
  function wireDragAndDrop() {
    let dragging = null;

    gridEl.addEventListener('dragstart', (event) => {
      const header = event.target.closest('.card-header');
      if (!header) { event.preventDefault(); return; }
      dragging = header.closest('.card');
      dragging.classList.add('dragging');
      document.body.classList.add('rearranging');
      event.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag without payload; the id is also handy
      // for debugging a dropped drag.
      event.dataTransfer.setData('text/plain', dragging.dataset.provider);
    });

    gridEl.addEventListener('dragover', (event) => {
      if (!dragging) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const over = event.target.closest('.card');
      if (!over || over === dragging) return;

      // Insert before or after depending on which half of the card the pointer
      // is in — measured on both axes, since the grid wraps.
      const box = over.getBoundingClientRect();
      const after = (event.clientY - box.top) > box.height / 2
        || (event.clientX - box.left) > box.width / 2;
      gridEl.insertBefore(dragging, after ? over.nextSibling : over);
    });

    const finish = () => {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      document.body.classList.remove('rearranging');
      dragging = null;
      persistOrder();
    };

    gridEl.addEventListener('drop', (event) => { event.preventDefault(); finish(); });
    gridEl.addEventListener('dragend', finish);
  }

  function wireGrid() {
    wireDragAndDrop();

    gridEl.addEventListener('click', (event) => {
      const size = event.target.closest('[data-size]');
      if (size) {
        event.stopPropagation();
        setSize(size.dataset.provider, size.dataset.size);
        return;
      }
      const openMenu = event.target.closest('[data-open-menu]');
      if (openMenu) {
        event.stopPropagation();
        const menu = openMenu.closest('.row-menu');
        const wasOpen = menu.classList.contains('open');
        closeMenus();
        if (!wasOpen) menu.classList.add('open');
        return;
      }
      const menuItem = event.target.closest('.menu-item');
      if (menuItem) {
        event.stopPropagation();
        closeMenus();
        runAction(menuItem.dataset.key, parseInt(menuItem.dataset.action, 10));
        return;
      }
      closeMenus();
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
      order = Array.isArray(settings.cardOrder) ? settings.cardOrder.slice() : [];
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
    setSize, sizeFor, orderedProviders, persistOrder, accentFor,
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

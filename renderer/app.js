// The dashboard.
//
// One card per provider, in registry order. Cards are fed by the
// `provider-updated` event — the renderer never polls, and it never computes
// item data of its own. The launcher and this grid read the same cache through
// the same commands, so a row here and a row there can't disagree.
(function () {
  'use strict';

  const api = window.hubApi;
  const { iconSvg, itemIcon, ACTION_ICONS } = window.DevHubIcons;
  const { renderInline } = window.DevHubMarkdown;

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

    // The menu itself is built on demand into a fixed-position popup on
    // <body>, not inline here: a card clips its own overflow and has a fixed
    // grid height, so an inline dropdown was cut off at the card's edge.
    const groupButtons = groups.map((group, gi) => `
        <button class="row-btn" data-open-menu="${gi}" data-key="${esc(key)}" title="${esc(group.label)}">
          ${iconSvg('chevron')}<span>${esc(group.label)}</span>
        </button>`).join('');

    // Anything ungrouped keeps its own labelled button. Index 0 is the row
    // click, so it isn't repeated — unless a group claims it, in which case the
    // menu lists it and the row still runs it.
    const loose = actions.map((a, i) => ({ a, i }))
      .filter(({ i }) => i !== 0 && !grouped.has(i))
      .map(({ a, i }) => `
        <button class="row-btn" data-key="${esc(key)}" data-action="${i}" title="${esc(a.label)}">
          ${iconSvg(ACTION_ICONS[a.kind] || 'chevron')}<span>${esc(a.label)}</span>
        </button>`).join('');

    // The ⋯ button is the discoverable way into per-item customisation;
    // right-clicking the row is the fast one.
    const customise = `
      <button class="row-btn row-btn-icon" data-customise="${esc(key)}" title="Customise this item">
        ${iconSvg('more')}
      </button>`;
    const accent = item.accent ? ` style="--row-accent: ${esc(item.accent)}"` : '';
    // Dot *and* glyph: the dot is the status, the glyph is what kind of thing
    // it is. Replacing one with the other would trade a signal for a decoration.
    const glyph = (item.icon || item.iconData)
      ? `<span class="row-glyph">${itemIcon(item)}</span>` : '';
    const priority = item.priority
      ? `<span class="row-priority ${esc(item.priority)}" title="Priority: ${esc(item.priority)}">${iconSvg('flag')}</span>`
      : '';

    return `
      <div class="card-row" tabindex="0" data-key="${esc(key)}" data-action="0"${accent}
           title="${esc(item.title)}">
        <span class="row-dot ${statusClass(item.status)}"></span>${priority}${glyph}
        <span class="row-main">
          <span class="row-title">${renderInline(item.title, item.richTitle)}</span>
          ${item.subtitle ? `<span class="row-sub">${esc(item.subtitle)}</span>` : ''}
          ${badges ? `<span class="row-badges">${badges}</span>` : ''}
        </span>
        <span class="row-actions">${groupButtons}${loose}${customise}</span>
      </div>`;
  }

  /** A tile, for cards in grid view — fewer words, more of them on screen. */
  function tileHtml(item) {
    const key = `${item.provider}::${item.id}`;
    const accent = item.accent ? ` style="--row-accent: ${esc(item.accent)}"` : '';
    return `
      <div class="card-tile" tabindex="0" data-key="${esc(key)}" data-action="0"${accent}
           title="${esc(item.title)}${item.subtitle ? ` — ${esc(item.subtitle)}` : ''}">
        <span class="tile-glyph">${itemIcon(item)}</span>
        ${item.priority ? `<span class="tile-priority ${esc(item.priority)}" title="Priority: ${esc(item.priority)}">${iconSvg('flag')}</span>` : ''}
        <span class="tile-title">${renderInline(item.title, item.richTitle)}</span>
        <span class="tile-dot ${statusClass(item.status)}"></span>
        <button class="tile-more" data-customise="${esc(key)}" title="Customise this item">
          ${iconSvg('more')}
        </button>
      </div>`;
  }

  function bodyHtml(result) {
    let html = '';
    // The error goes above the items, not instead of them: a partly-failing
    // scan should show what it did find and say what it couldn't reach.
    if (result.error) html += `<div class="card-error">${esc(result.error)}</div>`;
    if (result.items && result.items.length) {
      const grid = viewFor(result.provider) === 'grid';
      const rendered = result.items.map(grid ? tileHtml : rowHtml).join('');
      html += grid ? `<div class="tile-grid">${rendered}</div>` : rendered;
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

  /** A card's view mode. Anything unrecognised reads as a list. */
  function viewFor(providerId) {
    const stored = (settings && settings.cardLayout && settings.cardLayout[providerId]) || {};
    return stored.view === 'grid' ? 'grid' : 'list';
  }

  /** Merge one field of a card's layout, keeping the rest. */
  function setLayout(providerId, patch) {
    const current = { size: sizeFor(providerId), view: viewFor(providerId) };
    settings.cardLayout = Object.assign({}, settings.cardLayout, {
      [providerId]: Object.assign(current, patch),
    });
    api.saveSettings({ cardLayout: settings.cardLayout }).catch(() => {});
    renderCard(providerId);
  }

  function setSize(providerId, size) {
    if (!SIZES.includes(size)) return;
    setLayout(providerId, { size });
  }

  function setView(providerId, view) {
    setLayout(providerId, { view: view === 'grid' ? 'grid' : 'list' });
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
          <span class="size-group">
            <button class="size-btn ${viewFor(result.provider) === 'list' ? 'active' : ''}"
                    data-view="list" data-provider="${esc(result.provider)}" title="List view">☰</button>
            <button class="size-btn ${viewFor(result.provider) === 'grid' ? 'active' : ''}"
                    data-view="grid" data-provider="${esc(result.provider)}" title="Grid view">⊞</button>
          </span>
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
    const dark = resolved !== 'light';
    document.body.dataset.theme = dark ? 'dark' : 'light';

    // The glyph shows what the button will *do*, not what is currently on: a
    // sun while it's dark, because pressing it brings the light one.
    const button = document.getElementById('toggle-theme');
    const icon = document.getElementById('theme-icon');
    if (icon) icon.innerHTML = iconSvg(dark ? 'sun' : 'moon');
    if (button) button.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
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

  /** The one popup menu, reused. Lives on <body> so no card can clip it. */
  let popupEl = null;

  function openItemMenu(key, rect) {
    const item = findItem(key);
    if (!item) return;
    closeMenus();
    window.DevHubItemMenu.open(item, rect, (settings && settings.itemOverrides) || {});
  }

  function closeMenus() {
    if (popupEl) { popupEl.remove(); popupEl = null; }
  }

  function findItem(key) {
    for (const result of results.values()) {
      const found = (result.items || []).find(item => `${item.provider}::${item.id}` === key);
      if (found) return found;
    }
    return null;
  }

  /**
   * Open a group's actions as a floating menu anchored to its button.
   *
   * Fixed positioning against the button's viewport rect, flipped upwards when
   * there isn't room below — the card it belongs to is often near the bottom of
   * the grid, and a menu that opens off-screen is no better than a clipped one.
   */
  function openGroupMenu(button) {
    const key = button.dataset.key;
    const item = findItem(key);
    const group = item && (item.actionGroups || [])[Number(button.dataset.openMenu)];
    if (!group) return;

    closeMenus();
    popupEl = document.createElement('div');
    popupEl.className = 'row-menu-popup';
    popupEl.innerHTML = (group.actions || []).map(index => {
      const action = (item.actions || [])[index];
      if (!action) return '';
      return `
        <button class="menu-item" data-key="${esc(key)}" data-action="${index}">
          ${iconSvg(ACTION_ICONS[action.kind] || 'chevron')}
          <span>${esc(action.label || '')}</span>
        </button>`;
    }).join('');
    document.body.appendChild(popupEl);

    const anchor = button.getBoundingClientRect();
    const menu = popupEl.getBoundingClientRect();
    const gap = 4;
    const top = anchor.bottom + gap + menu.height > window.innerHeight
      ? Math.max(gap, anchor.top - menu.height - gap)
      : anchor.bottom + gap;
    const left = Math.min(
      Math.max(gap, anchor.right - menu.width),
      window.innerWidth - menu.width - gap,
    );
    popupEl.style.top = `${Math.round(top)}px`;
    popupEl.style.left = `${Math.round(left)}px`;

    popupEl.addEventListener('click', (event) => {
      const entry = event.target.closest('.menu-item');
      if (!entry) return;
      event.stopPropagation();
      const action = parseInt(entry.dataset.action, 10);
      const entryKey = entry.dataset.key;
      closeMenus();
      runAction(entryKey, action);
    });
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
      const view = event.target.closest('[data-view]');
      if (view) {
        event.stopPropagation();
        setView(view.dataset.provider, view.dataset.view);
        return;
      }
      const customise = event.target.closest('[data-customise]');
      if (customise) {
        event.stopPropagation();
        openItemMenu(customise.dataset.customise, customise.getBoundingClientRect());
        return;
      }
      const openMenu = event.target.closest('[data-open-menu]');
      if (openMenu) {
        event.stopPropagation();
        const alreadyOpen = !!popupEl;
        closeMenus();
        if (!alreadyOpen) openGroupMenu(openMenu);
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
      const clickable = event.target.closest('.card-row, .card-tile');
      if (clickable) runAction(clickable.dataset.key, 0);
    });

    // Right-click anywhere on an item is the fast route to the same menu.
    gridEl.addEventListener('contextmenu', (event) => {
      const target = event.target.closest('.card-row, .card-tile');
      if (!target) return;
      event.preventDefault();
      openItemMenu(target.dataset.key, target.getBoundingClientRect());
    });

    // The menu is anchored to a viewport position, so anything that moves the
    // button out from under it has to dismiss it.
    document.addEventListener('click', (event) => {
      if (popupEl && !event.target.closest('.row-menu-popup') && !event.target.closest('[data-open-menu]')) {
        closeMenus();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenus();
    });
    gridEl.addEventListener('scroll', closeMenus, true);
    window.addEventListener('resize', closeMenus);

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
    window.DevHubItemMenu.init(api, {
      onChanged: () => { toast('Saved'); load(); },
    });
    wireEvents();
    load().then(maybeOpenSetup);
  }
})();

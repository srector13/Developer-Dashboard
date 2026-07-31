// The per-item customisation menu.
//
// Providers decide what an item *is*; this is where you decide what it's called
// and how it looks — a nickname, an icon, a colour, or hidden entirely. It
// opens from the ⋯ button on a row and from a right-click anywhere on it, so
// there's a discoverable way in and a fast one.
//
// Left-click is deliberately left alone: it runs the item, which is the whole
// point of the app, and a click that sometimes launches and sometimes opens a
// menu would make the primary action feel unreliable.
(function () {
  'use strict';

  const { iconSvg, ICONS, itemIcon } = window.DevHubIcons;

  /** Offered colours. A named set beats a colour picker for staying coherent. */
  const ACCENTS = [
    { value: '', label: 'Default' },
    { value: '#58a6ff', label: 'Blue' },
    { value: '#bc8cff', label: 'Purple' },
    { value: '#39c5cf', label: 'Teal' },
    { value: '#3fb950', label: 'Green' },
    { value: '#f2c94c', label: 'Amber' },
    { value: '#ff7b72', label: 'Red' },
    { value: '#ffa657', label: 'Orange' },
  ];

  /** Priorities, most urgent first, plus a way back to none. */
  const PRIORITIES = [
    { value: '', label: 'None' },
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
  ];

  /** Icon tokens worth offering, from the fixed set in icons.js. */
  const ICON_CHOICES = [
    '', 'app', 'web', 'git', 'check', 'health', 'folder', 'file',
    'terminal', 'command', 'play', 'star', 'dot',
  ].filter(token => token === '' || ICONS[token]);

  let api = null;
  let menuEl = null;
  let onChanged = () => {};

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function close() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }

  function isOpen() {
    return !!menuEl;
  }

  /**
   * Open the customisation menu for `item`, anchored near `rect`.
   *
   * `current` is the item as displayed — already carrying any override — so the
   * fields show what you'd see rather than what the provider produced.
   */
  function open(item, rect, overrides) {
    close();
    const key = `${item.provider}::${item.id}`;
    const current = (overrides && overrides[key]) || {};

    menuEl = document.createElement('div');
    menuEl.className = 'item-menu';
    menuEl.innerHTML = `
      <div class="item-menu-head">
        <span class="item-menu-title">${esc(item.title)}</span>
      </div>
      <label class="item-menu-field">
        <span>Nickname</span>
        <input type="text" id="item-nickname" value="${esc(current.nickname || '')}"
               placeholder="Leave empty to keep the original" spellcheck="false">
      </label>
      <div class="item-menu-field">
        <span>Icon</span>
        <div class="icon-grid">
          ${ICON_CHOICES.map(token => `
            <button class="icon-choice ${(current.icon || '') === token ? 'active' : ''}"
                    data-icon="${token}" title="${token || 'Default'}">
              ${token ? iconSvg(token) : '<span class="icon-none">–</span>'}
            </button>`).join('')}
        </div>
      </div>
      <div class="item-menu-field">
        <span>Colour</span>
        <div class="accent-grid">
          ${ACCENTS.map(accent => `
            <button class="accent-choice ${(current.accent || '') === accent.value ? 'active' : ''}"
                    data-accent="${accent.value}" title="${esc(accent.label)}"
                    style="${accent.value ? `--swatch: ${accent.value}` : ''}">
              ${accent.value ? '' : '–'}
            </button>`).join('')}
        </div>
      </div>
      <div class="item-menu-field">
        <span>Your own image</span>
        <div class="custom-icon-row">
          <span class="custom-icon-preview" id="item-icon-preview">
            ${current.iconData ? itemIcon({ iconData: current.iconData }) : '<span class="icon-none">–</span>'}
          </span>
          <button class="btn-ghost" id="item-pick-icon">Choose…</button>
          <button class="btn-ghost" id="item-clear-icon">Clear</button>
        </div>
      </div>
      <div class="item-menu-field">
        <span>Priority</span>
        <div class="priority-row">
          ${PRIORITIES.map(p => `
            <button class="priority-choice ${p.value} ${(current.priority || '') === p.value ? 'active' : ''}"
                    data-priority="${p.value}">${esc(p.label)}</button>`).join('')}
        </div>
      </div>
      <div class="item-menu-actions">
        <button class="btn-ghost" id="item-hide">Hide this item</button>
        <button class="btn-ghost" id="item-reset">Reset</button>
        <button class="btn-primary" id="item-save">Save</button>
      </div>`;
    document.body.appendChild(menuEl);
    position(rect);

    let draft = {
      nickname: current.nickname || '',
      icon: current.icon || '',
      accent: current.accent || '',
      iconData: current.iconData || '',
      priority: current.priority || '',
      hidden: false,
    };

    menuEl.addEventListener('click', (event) => {
      const icon = event.target.closest('[data-icon]');
      if (icon) {
        draft.icon = icon.dataset.icon;
        menuEl.querySelectorAll('[data-icon]').forEach(b =>
          b.classList.toggle('active', b.dataset.icon === draft.icon));
        return;
      }
      const priority = event.target.closest('[data-priority]');
      if (priority) {
        draft.priority = priority.dataset.priority;
        menuEl.querySelectorAll('[data-priority]').forEach(b =>
          b.classList.toggle('active', b.dataset.priority === draft.priority));
        return;
      }
      const accent = event.target.closest('[data-accent]');
      if (accent) {
        draft.accent = accent.dataset.accent;
        menuEl.querySelectorAll('[data-accent]').forEach(b =>
          b.classList.toggle('active', b.dataset.accent === draft.accent));
        return;
      }
      if (event.target.closest('#item-clear-icon')) {
        draft.iconData = '';
        menuEl.querySelector('#item-icon-preview').innerHTML = '<span class="icon-none">–</span>';
        return;
      }
      if (event.target.closest('#item-pick-icon')) { pickIcon(draft); return; }
      if (event.target.closest('#item-hide')) { commit(key, { hidden: true }); return; }
      if (event.target.closest('#item-reset')) { commit(key, {}); return; }
      if (event.target.closest('#item-save')) {
        const nickname = menuEl.querySelector('#item-nickname').value;
        commit(key, {
          nickname: nickname.trim() || null,
          icon: draft.icon || null,
          accent: draft.accent || null,
          iconData: draft.iconData || null,
          priority: draft.priority || null,
          hidden: false,
        });
      }
    });

    // Enter saves, so renaming is type-and-go.
    menuEl.querySelector('#item-nickname').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      menuEl.querySelector('#item-save').click();
    });

    const field = menuEl.querySelector('#item-nickname');
    field.focus();
    field.select();
  }

  async function commit(key, patch) {
    close();
    try {
      await api.setItemOverride(key, {
        nickname: patch.nickname != null ? patch.nickname : null,
        icon: patch.icon != null ? patch.icon : null,
        accent: patch.accent != null ? patch.accent : null,
        iconData: patch.iconData != null ? patch.iconData : null,
        priority: patch.priority != null ? patch.priority : null,
        hidden: !!patch.hidden,
      });
      onChanged();
    } catch (err) {
      window.DevHubDashboard.toast(String(err), true);
    }
  }

  /** Ask the backend for an image file, inlined as a data URI. */
  async function pickIcon(draft) {
    try {
      const data = await api.pickIcon();
      if (!data) return;
      draft.iconData = data;
      const preview = menuEl && menuEl.querySelector('#item-icon-preview');
      if (preview) preview.innerHTML = itemIcon({ iconData: data });
    } catch (err) {
      window.DevHubDashboard.toast(String(err), true);
    }
  }

  /** Keep the panel on screen, flipping above the row when there's no room. */
  function position(rect) {
    const box = menuEl.getBoundingClientRect();
    const gap = 6;
    const top = rect.bottom + gap + box.height > window.innerHeight
      ? Math.max(gap, rect.top - box.height - gap)
      : rect.bottom + gap;
    const left = Math.min(
      Math.max(gap, rect.left),
      window.innerWidth - box.width - gap,
    );
    menuEl.style.top = `${Math.round(top)}px`;
    menuEl.style.left = `${Math.round(left)}px`;
  }

  function init(hubApi, options = {}) {
    api = hubApi;
    onChanged = options.onChanged || (() => {});

    document.addEventListener('click', (event) => {
      if (menuEl && !event.target.closest('.item-menu') && !event.target.closest('[data-customise]')) {
        close();
      }
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
  }

  window.DevHubItemMenu = { init, open, close, isOpen, ACCENTS, ICON_CHOICES, PRIORITIES };
})();

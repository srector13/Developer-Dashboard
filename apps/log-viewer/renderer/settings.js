// The Log Viewer's settings screen.
//
// It exists so that nothing about this app needs a text editor. Sources —
// including their nicknames and which application and environment they belong
// to — highlight rules, saved filters and every display preference are editable
// here; `logs.config.json` becomes a storage format rather than the interface.
// The Advanced section still shows the raw file, for anyone who prefers it and
// for keeping the comments the structured save normalises away.
//
// Two rules carry the design, both borrowed from Dev Hub's settings screen:
//
//   * **Saving is explicit.** The form edits a working copy; nothing reaches
//     disk until Save. A half-typed path never restarts a tail.
//   * **The form is data, not DOM.** Every input carries a path into that
//     working copy, so one delegated change handler serves the whole screen and
//     adding a field is one line rather than a listener.
(function () {
  'use strict';

  const SECTIONS = [
    { id: 'sources', label: 'Sources', icon: 'file' },
    { id: 'highlights', label: 'Highlights', icon: 'search' },
    { id: 'filters', label: 'Saved filters', icon: 'eyeOff' },
    { id: 'display', label: 'Display', icon: 'settings' },
    { id: 'advanced', label: 'Advanced', icon: 'terminal' },
  ];

  /** The palette a config file may name. Must match style.css's [data-colour]. */
  const COLOURS = ['blue', 'teal', 'green', 'red', 'amber', 'violet', 'pink'];

  const LEVELS = [
    { value: 'unknown', label: 'All levels' },
    { value: 'debug', label: 'Debug and above' },
    { value: 'info', label: 'Info and above' },
    { value: 'warn', label: 'Warn and above' },
    { value: 'error', label: 'Error and above' },
  ];

  const INTERVALS = [
    { value: 0, label: 'Full log' },
    { value: 5, label: 'Last 5 minutes' },
    { value: 15, label: 'Last 15 minutes' },
    { value: 60, label: 'Last hour' },
    { value: 360, label: 'Last 6 hours' },
    { value: 1440, label: 'Last 24 hours' },
  ];

  let api = null;
  let active = 'sources';
  let settings = null;   // working copy of settings.json
  let config = null;     // working copy of logs.config.json
  let rawText = '';      // the Advanced tab's textarea
  let rawDirty = false;
  let dirty = false;
  let onSaved = () => {};
  /** Rule id → the reason its pattern will not compile, or absent when it does. */
  const patternErrors = new Map();

  const el = {};

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function markDirty() {
    dirty = true;
    if (el.save) el.save.disabled = false;
  }

  function status(message, bad) {
    el.status.textContent = message;
    el.status.classList.toggle('bad', !!bad);
  }

  // -------------------------------------------------------------------------
  // Field helpers
  // -------------------------------------------------------------------------

  function scopeOf(scope) {
    return scope === 'settings' ? settings : config;
  }

  function get(root, path) {
    return path.split('.').reduce((value, key) => (value == null ? value : value[key]), root);
  }

  function set(root, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((value, key) => {
      if (value[key] == null) value[key] = {};
      return value[key];
    }, root);
    target[last] = value;
  }

  function toggleField(scope, path, label, hint) {
    const value = !!get(scopeOf(scope), path);
    return `
      <label class="set-toggle">
        <input type="checkbox" data-scope="${scope}" data-path="${esc(path)}" ${value ? 'checked' : ''}>
        <span class="set-toggle-body">
          <span class="set-label">${esc(label)}</span>
          ${hint ? `<span class="set-hint">${esc(hint)}</span>` : ''}
        </span>
      </label>`;
  }

  function numberField(scope, path, label, opts = {}) {
    const value = get(scopeOf(scope), path);
    return `
      <label class="set-field">
        <span class="set-label">${esc(label)}</span>
        <input type="number" class="narrow" data-scope="${scope}" data-path="${esc(path)}"
               value="${esc(value)}" min="${opts.min ?? 0}" max="${opts.max ?? 9999999}">
        ${opts.hint ? `<span class="set-hint">${esc(opts.hint)}</span>` : ''}
      </label>`;
  }

  function selectField(scope, path, label, choices, hint) {
    const value = get(scopeOf(scope), path);
    return `
      <label class="set-field">
        <span class="set-label">${esc(label)}</span>
        <select data-scope="${scope}" data-path="${esc(path)}">
          ${choices.map(c => `<option value="${esc(c.value)}" ${String(c.value) === String(value) ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>
        ${hint ? `<span class="set-hint">${esc(hint)}</span>` : ''}
      </label>`;
  }

  /**
   * The colour picker, as swatches rather than a dropdown.
   *
   * A config file names a colour from a fixed palette; it never carries one.
   * That is what keeps a value from a file out of a style attribute, and it is
   * why this is a list of seven buttons and not a colour input.
   */
  function colourPicker(list, index, current) {
    return `
      <span class="swatch-row">
        ${COLOURS.map(colour => `
          <button type="button" class="swatch-pick ${colour === current ? 'on' : ''}"
                  data-colour="${colour}" data-pick-colour="${esc(list)}" data-index="${index}"
                  title="${esc(colour)}" aria-label="${esc(colour)}"></button>`).join('')}
      </span>`;
  }

  /** Move an entry within one of the config's lists. */
  function move(list, index, delta) {
    const items = config[list];
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    const [item] = items.splice(index, 1);
    items.splice(to, 0, item);
    markDirty();
    render();
  }

  function orderButtons(list, index, length) {
    return `
      <span class="set-order">
        <button type="button" class="btn-ghost" data-move="${esc(list)}" data-index="${index}"
                data-delta="-1" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button type="button" class="btn-ghost" data-move="${esc(list)}" data-index="${index}"
                data-delta="1" ${index === length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button type="button" class="btn-ghost danger" data-remove="${esc(list)}" data-index="${index}"
                title="Remove">✕</button>
      </span>`;
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  function sourcesSection() {
    const sources = config.sources || [];
    return `
      <div class="set-group">
        <h3>Files to tail</h3>
        <p class="set-hint">
          One row per file. The nickname is what the log shows in its source
          column; application and environment are free text, and the sidebar
          groups by them. Leave both blank and the file is listed under "Other".
        </p>
        ${sources.length ? '' : '<p class="set-empty">No files yet. Add one below, or drop a log on the window and pin it.</p>'}
        ${sources.map((source, i) => `
          <div class="set-card" data-card="sources" data-index="${i}">
            <div class="set-row">
              <input type="text" class="grow" data-listpath="sources" data-index="${i}" data-key="path"
                     value="${esc(source.path)}" placeholder="C:\\services\\payments\\logs\\application.log"
                     spellcheck="false">
              <button type="button" class="btn-ghost" data-browse="${i}">Browse…</button>
              ${orderButtons('sources', i, sources.length)}
            </div>
            <div class="set-row">
              <input type="text" data-listpath="sources" data-index="${i}" data-key="name"
                     value="${esc(source.name)}" placeholder="Nickname — “api”">
              <input type="text" data-listpath="sources" data-index="${i}" data-key="app"
                     value="${esc(source.app || '')}" placeholder="Application — “Payments”">
              <input type="text" data-listpath="sources" data-index="${i}" data-key="env"
                     value="${esc(source.env || '')}" placeholder="Environment — “prod”">
            </div>
            <div class="set-row">
              ${colourPicker('sources', i, source.colour)}
              <label class="set-inline-toggle">
                <input type="checkbox" data-listpath="sources" data-index="${i}" data-key="enabled"
                       ${source.enabled ? 'checked' : ''}>
                <span>Read this file</span>
              </label>
            </div>
          </div>`).join('')}
        <button type="button" class="btn-ghost add" data-add="sources">Add a file</button>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Highlights
  // -------------------------------------------------------------------------

  function highlightsSection() {
    const rules = config.highlights || [];
    return `
      <div class="set-group">
        <h3>Colouring rules</h3>
        <p class="set-hint">
          A highlight never hides anything — it marks lines worth spotting while
          you scroll. Rules are tried in order and the first match wins, so put
          the specific ones above the general ones.
        </p>
        ${rules.length ? '' : '<p class="set-empty">No rules. Without any, every line is the same colour.</p>'}
        ${rules.map((rule, i) => {
          const error = patternErrors.get(rule.id);
          return `
          <div class="set-card ${error ? 'invalid' : ''}" data-card="highlights" data-index="${i}">
            <div class="set-row">
              <input type="text" data-listpath="highlights" data-index="${i}" data-key="name"
                     value="${esc(rule.name)}" placeholder="What it means — “Timeouts”">
              ${orderButtons('highlights', i, rules.length)}
            </div>
            <div class="set-row">
              <input type="text" class="grow mono" data-listpath="highlights" data-index="${i}"
                     data-key="pattern" data-check="${i}" value="${esc(rule.pattern)}"
                     spellcheck="false" autocomplete="off"
                     placeholder="${rule.regex ? 'Regular expression — \\b(timed? ?out|deadline exceeded)\\b' : 'Words to look for — timeout'}">
              <button type="button" class="toggle ${rule.regex ? 'on' : ''}" data-flag="regex"
                      data-index="${i}" title="Regular expression">.*</button>
              <button type="button" class="toggle ${rule.caseSensitive ? 'on' : ''}" data-flag="caseSensitive"
                      data-index="${i}" title="Match case">Aa</button>
            </div>
            ${error ? `<p class="set-error">${esc(error)}</p>` : ''}
            <div class="set-row">
              ${colourPicker('highlights', i, rule.colour)}
              <label class="set-inline-toggle">
                <input type="checkbox" data-listpath="highlights" data-index="${i}" data-key="enabled"
                       ${rule.enabled ? 'checked' : ''}>
                <span>Apply this rule</span>
              </label>
            </div>
          </div>`;
        }).join('')}
        <button type="button" class="btn-ghost add" data-add="highlights">Add a rule</button>
        <p class="set-hint">
          Regular expressions are Rust's <code>regex</code> syntax: character
          classes, alternation, anchors and repetition all work; backreferences
          and lookaround do not. A pattern that will not compile is flagged as
          you type, because a broken rule otherwise just colours nothing — which
          looks exactly like a rule that matched nothing.
        </p>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Saved filters
  // -------------------------------------------------------------------------

  function filtersSection() {
    const filters = config.filters || [];
    return `
      <div class="set-group">
        <h3>Saved filters</h3>
        <p class="set-hint">
          A saved filter is the whole filter bar under a name — the search, the
          exclusion, the level floor and how much of the log to show. Clicking
          one in the sidebar applies all of it.
        </p>
        ${filters.length ? '' : '<p class="set-empty">Nothing saved yet.</p>'}
        ${filters.map((saved, i) => `
          <div class="set-card" data-card="filters" data-index="${i}">
            <div class="set-row">
              <input type="text" data-listpath="filters" data-index="${i}" data-key="name"
                     value="${esc(saved.name)}" placeholder="Name — “Errors only”">
              ${orderButtons('filters', i, filters.length)}
            </div>
            <div class="set-row">
              <input type="text" class="grow mono" data-listpath="filters" data-index="${i}" data-key="query"
                     value="${esc(saved.query || '')}" placeholder="Show lines matching…" spellcheck="false">
              <input type="text" class="grow mono" data-listpath="filters" data-index="${i}" data-key="exclude"
                     value="${esc(saved.exclude || '')}" placeholder="…but not these" spellcheck="false">
            </div>
            <div class="set-row">
              <button type="button" class="toggle ${saved.regex ? 'on' : ''}" data-fflag="regex"
                      data-index="${i}" title="Regular expression">.*</button>
              <button type="button" class="toggle ${saved.caseSensitive ? 'on' : ''}" data-fflag="caseSensitive"
                      data-index="${i}" title="Match case">Aa</button>
              <select data-listpath="filters" data-index="${i}" data-key="minLevel">
                ${LEVELS.map(l => `<option value="${l.value}" ${l.value === (saved.minLevel || 'unknown') ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
              </select>
              <select data-listpath="filters" data-index="${i}" data-key="sinceMins" data-number="true">
                ${INTERVALS.map(o => `<option value="${o.value}" ${o.value === (saved.sinceMins || 0) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
              </select>
            </div>
          </div>`).join('')}
        <div class="set-actions-row">
          <button type="button" class="btn-ghost add" data-add="filters">Add a filter</button>
          <button type="button" class="btn-ghost" id="set-capture">Save what the filter bar says now</button>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Display
  // -------------------------------------------------------------------------

  function displaySection() {
    return `
      <div class="set-group">
        <h3>The log pane</h3>
        ${selectField('settings', 'theme', 'Theme', [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'system', label: 'Follow the system' },
        ])}
        ${numberField('settings', 'fontSize', 'Text size', { min: 9, max: 24, hint: '9 to 24 points.' })}
        ${toggleField('settings', 'wrap', 'Wrap long lines',
          'Off by default: wrapping makes the row count stop matching the line count, and it is what turns virtualised scrolling off.')}
        ${toggleField('settings', 'showTimestamps', 'Show the timestamp column')}
        ${toggleField('settings', 'showSource', 'Show which file each line came from')}
        ${toggleField('settings', 'showLevel', 'Show the level column')}
      </div>
      <div class="set-group">
        <h3>Reading</h3>
        ${toggleField('settings', 'follow', 'Follow new lines on open',
          'Following always yields to you: scrolling up turns it off, scrolling back to the bottom turns it on again.')}
        ${numberField('settings', 'pollIntervalMs', 'Check the files every', { min: 50, max: 5000, hint: 'Milliseconds, 50 to 5000.' })}
        ${numberField('settings', 'capacity', 'Lines to keep in memory', { min: 1000, max: 5000000, hint: '1,000 to 5,000,000. Older lines fall off the front; the file on disk still has them.' })}
        ${numberField('settings', 'window', 'Lines to hand the window at once', { min: 100, max: 20000, hint: '100 to 20,000.' })}
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Advanced
  // -------------------------------------------------------------------------

  function advancedSection() {
    return `
      <div class="set-group">
        <h3>logs.config.json</h3>
        <p class="set-hint">
          The same content as the sections above, as it is stored. Editing here
          and saving replaces the file — including any comments in it, which the
          structured save normalises away. Invalid JSON is refused rather than
          written.
        </p>
        <textarea id="set-raw" spellcheck="false" rows="18">${esc(rawText)}</textarea>
        <div class="set-actions-row">
          <button type="button" class="btn-ghost" id="set-reveal">Show the file in Explorer</button>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const BODIES = {
    sources: sourcesSection,
    highlights: highlightsSection,
    filters: filtersSection,
    display: displaySection,
    advanced: advancedSection,
  };

  function render() {
    el.nav.innerHTML = SECTIONS.map(section => `
      <button type="button" class="set-nav-item ${section.id === active ? 'on' : ''}"
              data-section="${section.id}">
        <span class="set-nav-icon">${window.SuiteIcons.iconSvg(section.icon)}</span>
        <span>${esc(section.label)}</span>
      </button>`).join('');

    if (active === 'advanced' && !rawDirty) rawText = JSON.stringify(normalisedConfig(), null, 2);
    el.body.innerHTML = (BODIES[active] || sourcesSection)();
    el.body.scrollTop = 0;
  }

  /**
   * The config as it will be sent.
   *
   * Ids are filled in here rather than by the backend so that a rule created in
   * this session has a stable identity straight away — the sidebar and the row
   * colouring both key off it, and an id that changes on save would repaint
   * every marked line a different colour.
   */
  function normalisedConfig() {
    const copy = clone(config);
    copy.sources = (copy.sources || []).filter(s => (s.path || '').trim());
    copy.highlights = (copy.highlights || []).filter(r => (r.pattern || '').trim());
    copy.filters = (copy.filters || []).filter(f => (f.name || '').trim());
    return copy;
  }

  /** A url-safe id from a name, unique within `taken`. */
  function idFrom(name, prefix, taken) {
    const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const base = slug || prefix;
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) candidate = `${base}-${n++}`;
    taken.add(candidate);
    return candidate;
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  async function save() {
    let outgoing;
    if (active === 'advanced' && rawDirty) {
      try {
        outgoing = JSON.parse(rawText);
      } catch (error) {
        status(`That isn't valid JSON: ${error.message}`, true);
        return;
      }
    } else {
      outgoing = normalisedConfig();
    }

    el.save.disabled = true;
    status('Saving…');
    try {
      const [savedSettings, savedConfig] = await Promise.all([
        api.saveSettings(settings),
        api.saveConfig(outgoing),
      ]);
      settings = clone(savedSettings);
      config = clone(savedConfig);
      rawDirty = false;
      dirty = false;
      status('Saved.');
      render();
      await onSaved({ settings: savedSettings, config: savedConfig });
    } catch (error) {
      el.save.disabled = false;
      status(`Could not save: ${error}`, true);
    }
  }

  // -------------------------------------------------------------------------
  // Pattern checking
  // -------------------------------------------------------------------------

  let checkTimer = null;

  /**
   * Ask the backend whether a rule's pattern compiles, and mark the card.
   *
   * The backend rather than the browser's own `RegExp`: the rules are run by
   * Rust's `regex` crate, which is a different dialect. Validating with
   * JavaScript would accept lookahead — and then the rule would silently colour
   * nothing.
   */
  function scheduleCheck(index) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(async () => {
      const rule = (config.highlights || [])[index];
      if (!rule) return;
      const card = el.body.querySelector(`.set-card[data-card="highlights"][data-index="${index}"]`);
      try {
        await api.checkPattern(rule.pattern, !!rule.regex, !!rule.caseSensitive);
        patternErrors.delete(rule.id);
      } catch (error) {
        patternErrors.set(rule.id, String(error));
      }
      const message = patternErrors.get(rule.id);
      if (!card) return;
      card.classList.toggle('invalid', !!message);
      let note = card.querySelector('.set-error');
      if (message && !note) {
        note = document.createElement('p');
        note.className = 'set-error';
        card.insertBefore(note, card.lastElementChild);
      }
      if (note) {
        note.textContent = message || '';
        note.hidden = !message;
      }
    }, 200);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function listEntry(target) {
    const list = target.dataset.listpath;
    const index = Number(target.dataset.index);
    return { list, index, entry: config[list] && config[list][index] };
  }

  function wire() {
    el.nav.addEventListener('click', (event) => {
      const button = event.target.closest('[data-section]');
      if (!button) return;
      active = button.dataset.section;
      render();
    });

    el.body.addEventListener('input', (event) => {
      const target = event.target;

      if (target.id === 'set-raw') {
        rawText = target.value;
        rawDirty = true;
        markDirty();
        return;
      }

      if (target.dataset.scope) {
        const root = scopeOf(target.dataset.scope);
        const value = target.type === 'number' ? Number(target.value) : target.value;
        set(root, target.dataset.path, value);
        markDirty();
        return;
      }

      if (target.dataset.listpath) {
        const { entry } = listEntry(target);
        if (!entry) return;
        entry[target.dataset.key] = target.value;
        markDirty();
        if (target.dataset.check != null) scheduleCheck(Number(target.dataset.check));
      }
    });

    el.body.addEventListener('change', (event) => {
      const target = event.target;
      if (target.type === 'checkbox') {
        if (target.dataset.scope) {
          set(scopeOf(target.dataset.scope), target.dataset.path, target.checked);
        } else if (target.dataset.listpath) {
          const { entry } = listEntry(target);
          if (entry) entry[target.dataset.key] = target.checked;
        }
        markDirty();
        return;
      }
      if (target.tagName === 'SELECT') {
        if (target.dataset.scope) {
          set(scopeOf(target.dataset.scope), target.dataset.path, target.value);
        } else if (target.dataset.listpath) {
          const { entry } = listEntry(target);
          if (entry) {
            entry[target.dataset.key] = target.dataset.number
              ? Number(target.value)
              : target.value;
          }
        }
        markDirty();
      }
    });

    el.body.addEventListener('click', async (event) => {
      const target = event.target.closest('button');
      if (!target) return;

      if (target.dataset.pickColour) {
        const list = target.dataset.pickColour;
        const entry = config[list][Number(target.dataset.index)];
        entry.colour = target.dataset.colour;
        markDirty();
        render();
        return;
      }

      if (target.dataset.move) {
        move(target.dataset.move, Number(target.dataset.index), Number(target.dataset.delta));
        return;
      }

      if (target.dataset.remove) {
        config[target.dataset.remove].splice(Number(target.dataset.index), 1);
        markDirty();
        render();
        return;
      }

      if (target.dataset.flag) {
        const rule = config.highlights[Number(target.dataset.index)];
        rule[target.dataset.flag] = !rule[target.dataset.flag];
        markDirty();
        render();
        scheduleCheck(Number(target.dataset.index));
        return;
      }

      if (target.dataset.fflag) {
        const saved = config.filters[Number(target.dataset.index)];
        saved[target.dataset.fflag] = !saved[target.dataset.fflag];
        markDirty();
        render();
        return;
      }

      if (target.dataset.browse != null) {
        const chosen = await api.browseFile();
        if (!chosen) return;
        const source = config.sources[Number(target.dataset.browse)];
        source.path = chosen;
        if (!source.name.trim()) source.name = chosen.split(/[\\/]/).filter(Boolean).pop() || '';
        markDirty();
        render();
        return;
      }

      if (target.dataset.add) addTo(target.dataset.add);

      if (target.id === 'set-capture') captureFilterBar();
      if (target.id === 'set-reveal') api.revealConfigFile().catch(() => {});
    });

    el.save.addEventListener('click', save);
    el.close.addEventListener('click', close);
    el.overlay.addEventListener('mousedown', (event) => {
      if (event.target === el.overlay) close();
    });
    document.addEventListener('keydown', (event) => {
      if (!el.overlay.classList.contains('visible')) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
      if (event.ctrlKey && event.key === 's') {
        event.preventDefault();
        if (dirty) save();
      }
    }, true);
  }

  function addTo(list) {
    if (list === 'sources') {
      const taken = new Set((config.sources || []).map(s => s.id));
      config.sources = config.sources || [];
      config.sources.push({
        id: idFrom('', `source-${config.sources.length}`, taken),
        name: '',
        path: '',
        enabled: true,
        colour: COLOURS[config.sources.length % COLOURS.length],
        app: '',
        env: '',
      });
    } else if (list === 'highlights') {
      const taken = new Set((config.highlights || []).map(r => r.id));
      config.highlights = config.highlights || [];
      config.highlights.push({
        id: idFrom('', `rule-${config.highlights.length}`, taken),
        name: '',
        pattern: '',
        regex: false,
        caseSensitive: false,
        colour: COLOURS[config.highlights.length % COLOURS.length],
        enabled: true,
      });
    } else if (list === 'filters') {
      const taken = new Set((config.filters || []).map(f => f.id));
      config.filters = config.filters || [];
      config.filters.push({
        id: idFrom('', `filter-${config.filters.length}`, taken),
        name: '',
        query: '',
        exclude: '',
        regex: false,
        caseSensitive: false,
        minLevel: 'unknown',
        sources: [],
        sinceMins: 0,
      });
    }
    markDirty();
    render();
  }

  /**
   * Keep whatever the filter bar currently says as a new saved filter.
   *
   * This is the path that actually gets used: you narrow things down during an
   * incident and then want to keep what worked, rather than retyping it into a
   * form afterwards.
   */
  async function captureFilterBar() {
    const context = await api.context();
    const taken = new Set((config.filters || []).map(f => f.id));
    const spec = context.filter || {};
    const name = spec.query || spec.exclude || 'Filter';
    config.filters = config.filters || [];
    config.filters.push({
      id: idFrom(name, `filter-${config.filters.length}`, taken),
      name,
      query: spec.query || '',
      exclude: spec.exclude || '',
      regex: !!spec.regex,
      caseSensitive: !!spec.caseSensitive,
      minLevel: spec.minLevel || 'unknown',
      sources: [],
      sinceMins: spec.sinceMins || 0,
    });
    markDirty();
    active = 'filters';
    render();
  }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  async function open(section) {
    active = section && BODIES[section] ? section : 'sources';
    dirty = false;
    rawDirty = false;
    patternErrors.clear();
    try {
      const context = await api.context();
      settings = clone(context.settings);
      config = clone(context.config);
    } catch (error) {
      status(`Could not load settings: ${error}`, true);
      return;
    }
    el.save.disabled = true;
    status('Changes apply when you save.');
    el.overlay.classList.add('visible');
    render();
  }

  function close() {
    el.overlay.classList.remove('visible');
  }

  function init(logsApi, options = {}) {
    api = logsApi;
    onSaved = options.onSaved || (() => {});
    el.overlay = document.getElementById('settings-overlay');
    el.nav = document.getElementById('settings-nav');
    el.body = document.getElementById('settings-body');
    el.save = document.getElementById('settings-save');
    el.close = document.getElementById('settings-close');
    el.status = document.getElementById('settings-status');
    wire();
  }

  window.LogViewerSettings = { init, open, close };
})();

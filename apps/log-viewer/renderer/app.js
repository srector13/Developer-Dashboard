// The Log Viewer window.
//
// Three things carry the design:
//
//   * **Rows are virtualised.** A window of 2,000 lines is 2,000 DOM nodes if
//     you render it naively, and scrolling that in a webview is visibly janky.
//     Only what fits on screen (plus a little overscan) exists as elements;
//     a spacer gives the scrollbar the right size. See `paint`.
//   * **Text goes in as text.** Every line is `textContent`, never innerHTML.
//     A log line is arbitrary bytes written by something else, and it is the
//     one place in the suite where hostile content is a plausible accident.
//   * **Follow yields to the reader.** Scrolling up turns following off and
//     offers a way back; scrolling to the bottom turns it on again. Nothing
//     yanks the viewport while someone is reading.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const api = window.logsApi;
  if (!api) {
    // Opened outside Tauri with no stub installed. Saying so is the whole
    // point: an inert window that quietly reads "No lines yet" is
    // indistinguishable from a working one watching a quiet log, and that is
    // exactly how "I added a log and can't see anything" starts.
    $('no-bridge').hidden = false;
    document.body.dataset.ready = 'no-bridge';
    return;
  }

  const els = {
    query: $('query'),
    exclude: $('exclude'),
    regex: $('regex'),
    case: $('case'),
    level: $('level'),
    interval: $('interval'),
    filterError: $('filter-error'),
    sourceList: $('source-list'),
    sourcesEmpty: $('sources-empty'),
    filtersPanel: $('filters-panel'),
    filterList: $('filter-list'),
    filtersEmpty: $('filters-empty'),
    highlightList: $('highlight-list'),
    highlightsEmpty: $('highlights-empty'),
    scroller: $('scroller'),
    sizer: $('sizer'),
    rows: $('rows'),
    logEmpty: $('log-empty'),
    jump: $('jump'),
    counts: $('counts'),
    truncated: $('truncated'),
    follow: $('follow'),
    copy: $('copy'),
    clear: $('clear'),
    openFile: $('open-file'),
    openSettings: $('open-settings'),
    dropHint: $('drop-hint'),
  };

  const state = {
    settings: null,
    config: { sources: [], filters: [], highlights: [] },
    lines: [],
    matched: 0,
    total: 0,
    truncated: false,
    follow: true,
    rowHeight: 20,
    // How many rows to render beyond the viewport, so a fast scroll does not
    // show blank space before the next frame lands.
    overscan: 12,
  };

  // ==========================================================================
  // Rendering the log
  // ==========================================================================

  /** Local wall clock, to the millisecond. Logs are read in local time. */
  function formatTime(millis) {
    const d = new Date(millis);
    const pad = (n, width) => String(n).padStart(width, '0');
    return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
  }

  const sourceById = new Map();
  /** Rule id → palette token, so a custom rule's colour reaches the row. */
  const highlightColours = new Map();

  function buildRow(view) {
    const line = view.line;
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.level = line.level;
    if (view.highlight) {
      row.dataset.highlight = view.highlight;
      // The colour is looked up rather than derived from the rule id: the ids
      // of user-created rules are arbitrary, so CSS cannot know them.
      row.dataset.highlightColour = highlightColours.get(view.highlight) || 'blue';
    }
    if (line.continuation) row.dataset.continuation = 'true';

    if (state.settings.showTimestamps) {
      const ts = document.createElement('span');
      ts.className = 'cell ts';
      // A continuation line has no clock of its own; showing the inherited one
      // as if it did would be a small, repeated lie.
      ts.textContent = line.timestamp == null ? '' : formatTime(line.timestamp);
      row.appendChild(ts);
    }

    if (state.settings.showSource) {
      const source = sourceById.get(line.source);
      const src = document.createElement('span');
      src.className = 'cell src';
      src.dataset.colour = (source && source.colour) || 'blue';
      src.textContent = (source && source.name) || line.source;
      row.appendChild(src);
    }

    if (state.settings.showLevel) {
      const lvl = document.createElement('span');
      lvl.className = 'cell lvl';
      lvl.textContent = line.level === 'unknown' ? '' : line.level.toUpperCase();
      row.appendChild(lvl);
    }

    const text = document.createElement('span');
    text.className = 'cell txt';
    // textContent, always. See the note at the top of this file.
    text.textContent = line.text;
    row.appendChild(text);

    return row;
  }

  /**
   * Draw the rows that are currently on screen.
   *
   * With wrapping on, a row's height is no longer knowable in advance, so
   * virtualisation is switched off and the whole window is rendered. That
   * window is capped by `settings.window` (2,000 by default), which keeps the
   * worst case bounded — and wrapping is off by default precisely because this
   * is the expensive mode.
   */
  function paint() {
    // Every path into paint can fire before boot has resolved the context —
    // a scroll event, a batch of lines from a source that was already being
    // tailed when the window opened. Reading settings that are not there yet
    // throws inside a listener, where nothing reports it, and the window stops
    // drawing with no clue why.
    if (!state.settings) return;

    const wrapping = state.settings.wrap;
    const count = state.lines.length;

    els.logEmpty.hidden = count > 0;

    if (wrapping) {
      els.sizer.style.height = '';
      els.rows.style.transform = '';
      render(0, count);
      return;
    }

    els.sizer.style.height = `${count * state.rowHeight}px`;

    const viewport = els.scroller.clientHeight || 1;
    const first = Math.max(0, Math.floor(els.scroller.scrollTop / state.rowHeight) - state.overscan);
    const visible = Math.ceil(viewport / state.rowHeight) + state.overscan * 2;

    els.rows.style.transform = `translateY(${first * state.rowHeight}px)`;
    render(first, Math.min(count, first + visible));
  }

  function render(from, to) {
    const fragment = document.createDocumentFragment();
    for (let i = from; i < to; i++) {
      fragment.appendChild(buildRow(state.lines[i]));
    }
    els.rows.replaceChildren(fragment);
  }

  /** Measure a real row once, so the virtualiser's arithmetic matches reality. */
  function measureRowHeight() {
    const probe = document.createElement('div');
    probe.className = 'row';
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    const cell = document.createElement('span');
    cell.className = 'cell txt';
    cell.textContent = 'measuring';
    probe.appendChild(cell);
    els.rows.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    if (height > 0) state.rowHeight = height;
  }

  // ==========================================================================
  // Following
  // ==========================================================================

  /** Within a row or two of the bottom counts as "at the bottom". */
  function atBottom() {
    const { scrollTop, scrollHeight, clientHeight } = els.scroller;
    return scrollHeight - scrollTop - clientHeight <= state.rowHeight * 2;
  }

  function scrollToBottom() {
    els.scroller.scrollTop = els.scroller.scrollHeight;
  }

  function setFollow(follow, { persist = true } = {}) {
    state.follow = follow;
    els.follow.classList.toggle('on', follow);
    els.follow.setAttribute('aria-pressed', String(follow));
    els.jump.hidden = follow;
    if (follow) scrollToBottom();
    if (persist && state.settings && state.settings.follow !== follow) {
      state.settings.follow = follow;
      api.saveSettings(state.settings).catch(() => {});
    }
  }

  els.scroller.addEventListener('scroll', () => {
    paint();
    // Scrolling away from the bottom is the reader saying "hold still".
    // Scrolling back is them saying "carry on".
    if (state.follow && !atBottom()) setFollow(false);
    else if (!state.follow && atBottom()) setFollow(true);
  }, { passive: true });

  els.follow.addEventListener('click', () => setFollow(!state.follow));
  els.jump.addEventListener('click', () => setFollow(true));

  // ==========================================================================
  // The filter bar
  // ==========================================================================

  function currentFilter() {
    return {
      query: els.query.value,
      exclude: els.exclude.value,
      regex: els.regex.classList.contains('on'),
      caseSensitive: els.case.classList.contains('on'),
      minLevel: els.level.value,
      sources: [],
      sinceMins: Number(els.interval.value) || 0,
    };
  }

  function showFilterError(message) {
    els.filterError.textContent = message || '';
    els.filterError.hidden = !message;
    // The inputs are marked too, so it is obvious which of the two is wrong
    // when the message names one.
    els.query.classList.toggle('invalid', !!message && message.startsWith('Filter:'));
    els.exclude.classList.toggle('invalid', !!message && message.startsWith('Exclude:'));
  }

  function applyView(view) {
    state.lines = view.lines;
    state.matched = view.matched;
    state.total = view.total;
    state.truncated = view.truncated;
    updateCounts();
    paint();
    if (state.follow) scrollToBottom();
  }

  async function applyFilter() {
    try {
      applyView(await api.setFilter(currentFilter()));
      showFilterError(null);
    } catch (error) {
      // A half-typed regex is the common case here. The previous view stays on
      // screen — blanking the window on every keystroke of `(\d` would make
      // the feature unusable.
      showFilterError(String(error));
    }
  }

  let filterTimer = null;
  function scheduleFilter() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilter, 120);
  }

  els.query.addEventListener('input', scheduleFilter);
  els.exclude.addEventListener('input', scheduleFilter);
  els.level.addEventListener('change', applyFilter);
  els.interval.addEventListener('change', applyFilter);

  for (const toggle of [els.regex, els.case]) {
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('on');
      toggle.setAttribute('aria-pressed', String(toggle.classList.contains('on')));
      applyFilter();
    });
  }

  function updateCounts() {
    const shown = state.lines.length;
    const parts = [];
    if (state.matched === state.total) {
      parts.push(`${state.total.toLocaleString()} lines`);
    } else {
      parts.push(`${state.matched.toLocaleString()} of ${state.total.toLocaleString()} lines`);
    }
    if (shown < state.matched) parts.push(`showing newest ${shown.toLocaleString()}`);
    els.counts.textContent = parts.join(' · ');
    els.truncated.hidden = !state.truncated;
  }

  // ==========================================================================
  // Sources
  // ==========================================================================

  function iconButton(icon, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-action';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = window.SuiteIcons.iconSvg(icon);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  /** What to call a group nobody named. */
  const UNGROUPED = 'Other';

  /**
   * Group the sources by application, then by environment.
   *
   * Returns a Map of app → Map of env → sources, both in the order the sources
   * arrived. Insertion order rather than alphabetical: the config file's order
   * is a choice someone made, and re-sorting it means the list stops matching
   * the file they edited.
   */
  function groupSources(sources) {
    const byApp = new Map();
    for (const source of sources) {
      const app = (source.app || '').trim() || UNGROUPED;
      const env = (source.env || '').trim();
      if (!byApp.has(app)) byApp.set(app, new Map());
      const byEnv = byApp.get(app);
      if (!byEnv.has(env)) byEnv.set(env, []);
      byEnv.get(env).push(source);
    }
    return byApp;
  }

  /** A one-word note about a file that isn't there, or null when it is. */
  function troubleWith(source) {
    if (!source.missing) return null;
    return source.seen
      ? { label: 'gone', title: `${source.path}\n\nThis file was being read and has now disappeared.` }
      : { label: 'not found', title: `${source.path}\n\nNothing at this path. Check it in Settings ▸ Sources — a typo, or a share that isn't mounted, looks exactly like a log with nothing in it.` };
  }

  function buildSourceRow(source) {
    const item = document.createElement('li');
    item.className = 'source';
    item.dataset.colour = source.colour;
    if (!source.enabled) item.dataset.off = 'true';

    const dot = document.createElement('span');
    dot.className = 'dot';
    item.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = source.name;
    name.title = source.path;
    item.appendChild(name);

    // A file that cannot be read says so, right where its line count would be.
    // This is the whole answer to "I added a log and nothing happened".
    const trouble = troubleWith(source);
    if (trouble) {
      item.dataset.trouble = 'true';
      const warn = document.createElement('span');
      warn.className = 'trouble';
      warn.textContent = trouble.label;
      warn.title = trouble.title;
      item.appendChild(warn);
    } else {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = source.lines.toLocaleString();
      item.appendChild(count);
    }

    const actions = document.createElement('span');
    actions.className = 'actions';
    actions.appendChild(iconButton(
      source.enabled ? 'eye' : 'eyeOff',
      source.enabled ? 'Stop reading this file' : 'Read this file again',
      async () => {
        await api.setSourceEnabled(source.id, !source.enabled);
        await refreshSources();
      },
    ));
    if (!source.pinned) {
      actions.appendChild(iconButton('pin', 'Keep this file in the config', async () => {
        await api.pinSource(source.id);
        await refreshSources();
      }));
    }
    actions.appendChild(iconButton('refresh', 'Re-read from the top of the file', async () => {
      await api.reloadSource(source.id);
    }));
    actions.appendChild(iconButton('file', 'Show in Explorer', () => {
      api.revealSource(source.id).catch(() => {});
    }));
    actions.appendChild(iconButton('trash', 'Close this file', async () => {
      await api.removeSource(source.id);
      await refreshSources();
      await applyFilter();
    }));
    item.appendChild(actions);
    return item;
  }

  function plainList(sources) {
    const list = document.createElement('ul');
    for (const source of sources) list.appendChild(buildSourceRow(source));
    return list;
  }

  async function refreshSources() {
    const sources = await api.listSources();
    sourceById.clear();
    for (const source of sources) sourceById.set(source.id, source);

    els.sourcesEmpty.hidden = sources.length > 0;

    // Headings only earn their space once something has been grouped. Watching
    // three files from one service should not put every one of them under a
    // heading called "Other".
    const grouped = sources.some(s => (s.app || '').trim() || (s.env || '').trim());
    if (!grouped) {
      els.sourceList.replaceChildren(plainList(sources));
      paint();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const [app, byEnv] of groupSources(sources)) {
      const group = document.createElement('section');
      group.className = 'source-group';

      const heading = document.createElement('h3');
      heading.textContent = app;
      group.appendChild(heading);

      for (const [env, members] of byEnv) {
        // An environment nobody named needs no sub-heading; its files just sit
        // under the application.
        if (env) {
          const envHeading = document.createElement('h4');
          envHeading.textContent = env;
          group.appendChild(envHeading);
        }
        group.appendChild(plainList(members));
      }
      fragment.appendChild(group);
    }

    els.sourceList.replaceChildren(fragment);
    // A source's colour and name are shown on every row, so a change to the
    // list means the log needs redrawing too.
    paint();
  }

  // ==========================================================================
  // Saved filters and highlight rules
  // ==========================================================================

  function renderSavedFilters() {
    const filters = state.config.filters || [];
    // The panel stays put even when empty, because its heading carries the
    // "Edit" link that is how you create the first one.
    els.filtersPanel.hidden = false;
    els.filtersEmpty.hidden = filters.length > 0;

    const list = document.createDocumentFragment();
    for (const saved of filters) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'saved-filter';
      button.textContent = saved.name || saved.id;
      button.addEventListener('click', () => {
        els.query.value = saved.query || '';
        els.exclude.value = saved.exclude || '';
        els.regex.classList.toggle('on', !!saved.regex);
        els.case.classList.toggle('on', !!saved.caseSensitive);
        els.level.value = saved.minLevel || 'unknown';
        els.interval.value = String(saved.sinceMins || 0);
        applyFilter();
      });
      item.appendChild(button);
      list.appendChild(item);
    }
    els.filterList.replaceChildren(list);
  }

  function renderHighlights() {
    const rules = state.config.highlights || [];
    els.highlightsEmpty.hidden = rules.length > 0;

    highlightColours.clear();
    for (const rule of rules) highlightColours.set(rule.id, rule.colour || 'blue');

    const list = document.createDocumentFragment();
    for (const rule of rules) {
      const item = document.createElement('li');
      item.className = 'highlight';
      item.dataset.rule = rule.id;
      if (!rule.enabled) item.dataset.off = 'true';

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.dataset.colour = rule.colour || 'blue';
      item.appendChild(swatch);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = rule.name || rule.id;
      name.title = rule.regex ? `/${rule.pattern}/` : rule.pattern;
      item.appendChild(name);

      item.appendChild(iconButton(
        rule.enabled ? 'eye' : 'eyeOff',
        rule.enabled ? 'Stop colouring these' : 'Colour these again',
        async () => {
          rule.enabled = !rule.enabled;
          state.config = await api.saveConfig(state.config);
          renderHighlights();
          await applyFilter();
        },
      ));

      list.appendChild(item);
    }
    els.highlightList.replaceChildren(list);
  }

  // ==========================================================================
  // Toolbar and keyboard
  // ==========================================================================

  els.openFile.addEventListener('click', async () => {
    await api.pickFiles();
    await refreshSources();
    await applyFilter();
  });

  els.openSettings.addEventListener('click', () => window.LogViewerSettings.open());

  // The "Edit" link on each sidebar panel opens settings at that section, so
  // the thing you were looking at is the thing you land on.
  for (const button of document.querySelectorAll('[data-settings]')) {
    button.addEventListener('click', () => window.LogViewerSettings.open(button.dataset.settings));
  }

  els.clear.addEventListener('click', async () => {
    applyView(await api.clear());
    await refreshSources();
  });

  els.copy.addEventListener('click', async () => {
    const text = await api.copyView();
    await api.writeClipboard(text);
    els.copy.textContent = 'Copied';
    setTimeout(() => { els.copy.textContent = 'Copy view'; }, 1200);
  });

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    if (event.key === 'Escape' && typing) {
      document.activeElement.blur();
      return;
    }
    if (event.ctrlKey && event.key === 'f') {
      event.preventDefault();
      els.query.focus();
      els.query.select();
      return;
    }
    if (event.ctrlKey && event.key === 'l') {
      event.preventDefault();
      els.clear.click();
      return;
    }
    if (event.ctrlKey && event.key === 'o') {
      event.preventDefault();
      els.openFile.click();
      return;
    }
    if (event.ctrlKey && event.key === ',') {
      event.preventDefault();
      window.LogViewerSettings.open();
      return;
    }
    if (typing) return;

    if (event.key === 'f') {
      setFollow(!state.follow);
    } else if (event.key === 'End') {
      setFollow(true);
    } else if (event.key === '/') {
      event.preventDefault();
      els.query.focus();
    }
  });

  // ==========================================================================
  // Dropping files
  // ==========================================================================

  if (api.onFileDropHover) api.onFileDropHover(() => { els.dropHint.hidden = false; });
  if (api.onFileDropCancel) api.onFileDropCancel(() => { els.dropHint.hidden = true; });
  if (api.onFileDrop) {
    api.onFileDrop(async (paths) => {
      els.dropHint.hidden = true;
      for (const path of paths) await api.addSource(path);
      await refreshSources();
      await applyFilter();
    });
  }

  // ==========================================================================
  // Live updates
  // ==========================================================================

  api.onLinesAppended((payload) => {
    if (!payload || !payload.lines) return;
    // The tail loop starts polling in `setup`, before this window has finished
    // asking for its context, so the first batch can land while `settings` is
    // still null. Dropping it is right: `boot` runs a full query afterwards and
    // picks up everything, whereas throwing here kills the listener silently
    // and the view never updates again.
    if (!state.settings) return;

    state.matched = payload.matched;
    state.total = payload.total;
    if (payload.lines.length) {
      state.lines = state.lines.concat(payload.lines);
      // The buffer the renderer holds is bounded the same way the backend's
      // is: drop from the front rather than growing without limit.
      const cap = state.settings.window;
      if (state.lines.length > cap) state.lines = state.lines.slice(-cap);
    }

    updateCounts();
    paint();
    if (state.follow) scrollToBottom();
  });

  if (api.onSourcesChanged) {
    api.onSourcesChanged(async () => {
      await refreshSources();
      await applyFilter();
    });
  }

  // logs.config.json changed on disk. Adopt it without a restart — an edited
  // config that does nothing until the next launch is exactly what made adding
  // a source look like it had failed.
  if (api.onConfigChanged) {
    api.onConfigChanged(async () => {
      const context = await api.context();
      state.config = context.config;
      showFilterError(context.configError || null);
      renderSavedFilters();
      renderHighlights();
      await refreshSources();
      await applyFilter();
    });
  }

  // ==========================================================================
  // Boot
  // ==========================================================================

  function applySettings(settings) {
    state.settings = settings;
    document.body.dataset.theme = settings.theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('wrap', !!settings.wrap);
    document.documentElement.style.setProperty('--log-font-size', `${settings.fontSize}px`);
  }

  (async function boot() {
    const context = await api.context();
    applySettings(context.settings);
    state.config = context.config;

    // Icons declared in the markup, resolved once the icon set is loaded.
    for (const holder of document.querySelectorAll('[data-icon]')) {
      holder.innerHTML = window.SuiteIcons.iconSvg(holder.dataset.icon);
    }

    els.query.value = context.filter.query || '';
    els.exclude.value = context.filter.exclude || '';
    els.regex.classList.toggle('on', !!context.filter.regex);
    els.case.classList.toggle('on', !!context.filter.caseSensitive);
    els.level.value = context.filter.minLevel || 'unknown';
    els.interval.value = String(context.filter.sinceMins || 0);

    if (context.configError) showFilterError(context.configError);

    // The settings pane edits both files and hands back what it saved, so the
    // window can adopt it without a round trip.
    window.LogViewerSettings.init(api, {
      onSaved: async ({ settings, config }) => {
        applySettings(settings);
        state.config = config;
        renderSavedFilters();
        renderHighlights();
        measureRowHeight();
        await refreshSources();
        await applyFilter();
      },
    });

    measureRowHeight();
    renderSavedFilters();
    renderHighlights();
    await refreshSources();
    await applyFilter();
    setFollow(context.settings.follow, { persist: false });

    // A resized window changes how many rows fit, which changes what to draw.
    window.addEventListener('resize', () => {
      measureRowHeight();
      paint();
      if (state.follow) scrollToBottom();
    });

    document.body.dataset.ready = 'true';
  })();
})();

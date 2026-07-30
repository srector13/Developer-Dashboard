// The settings screen.
//
// Everything in hub.config.json is editable here — apps, URLs, repo roots,
// health endpoints, command providers — so the file is a storage format rather
// than something you have to hand-write. The Advanced tab still exposes the raw
// text for anyone who prefers it (and for keeping comments, which the
// structured save normalises away).
//
// Saving is explicit. The form edits a working copy and nothing touches disk
// until Save, so a half-typed path never restarts the providers.
(function () {
  'use strict';

  const { iconSvg } = window.DevHubIcons;

  const SECTIONS = [
    { id: 'general', label: 'General', icon: 'settings' },
    { id: 'launcher', label: 'Quick Launch', icon: 'search' },
    { id: 'launch', label: 'Apps & links', icon: 'app' },
    { id: 'projects', label: 'Repos', icon: 'git' },
    { id: 'todos', label: 'Todos', icon: 'check' },
    { id: 'health', label: 'Services', icon: 'health' },
    { id: 'command', label: 'Custom', icon: 'command' },
    { id: 'advanced', label: 'Advanced', icon: 'file' },
  ];

  /** Tokens offered for an entry's icon, matching renderer/icons.js. */
  const ICON_CHOICES = ['app', 'web', 'git', 'check', 'health', 'folder', 'file', 'terminal', 'command', 'dot'];

  let api = null;
  let active = 'general';
  let settings = null;   // working copy of settings.json
  let config = null;     // working copy of hub.config.json
  let status = null;     // ShortcutStatus
  let suggestions = [];
  /// Read from the registry rather than settings.json, which only mirrors it.
  let runAtLogin = false;
  let dirty = false;
  let recording = false;
  let onSaved = () => {};

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

  // -------------------------------------------------------------------------
  // Field helpers — every input carries a dotted path into the working copy, so
  // one change handler serves the whole form.
  // -------------------------------------------------------------------------

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

  function textField(scope, path, label, opts = {}) {
    const value = get(scope === 'settings' ? settings : config, path);
    return `
      <label class="set-field">
        <span class="set-label">${esc(label)}</span>
        <span class="set-input-row">
          <input type="${opts.type || 'text'}" data-scope="${scope}" data-path="${esc(path)}"
                 value="${esc(value == null ? '' : value)}"
                 placeholder="${esc(opts.placeholder || '')}"
                 ${opts.type === 'number' ? `min="${opts.min ?? 0}"` : ''}>
          ${opts.browse ? `<button class="btn-ghost" data-browse="${opts.browse}" data-target="${esc(path)}" data-scope="${scope}">Browse…</button>` : ''}
        </span>
        ${opts.hint ? `<span class="set-hint">${esc(opts.hint)}</span>` : ''}
      </label>`;
  }

  function toggleField(scope, path, label, hint) {
    const value = !!get(scope === 'settings' ? settings : config, path);
    return `
      <label class="set-toggle">
        <input type="checkbox" data-scope="${scope}" data-path="${esc(path)}" ${value ? 'checked' : ''}>
        <span class="set-toggle-body">
          <span class="set-label">${esc(label)}</span>
          ${hint ? `<span class="set-hint">${esc(hint)}</span>` : ''}
        </span>
      </label>`;
  }

  function selectField(scope, path, label, choices) {
    const value = get(scope === 'settings' ? settings : config, path);
    return `
      <label class="set-field">
        <span class="set-label">${esc(label)}</span>
        <select data-scope="${scope}" data-path="${esc(path)}">
          ${choices.map(c => `<option value="${esc(c.value)}" ${String(c.value) === String(value) ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>
      </label>`;
  }

  /** A list of bare strings — project roots, todo roots, tags. */
  function stringList(path, opts = {}) {
    const values = get(config, path) || [];
    return `
      <div class="set-list" data-list="${esc(path)}">
        ${values.length ? '' : `<p class="set-empty">${esc(opts.empty || 'Nothing yet.')}</p>`}
        ${values.map((value, i) => `
          <div class="set-row">
            <input type="text" data-listpath="${esc(path)}" data-index="${i}" value="${esc(value)}"
                   placeholder="${esc(opts.placeholder || '')}">
            ${opts.browse ? `<button class="btn-ghost" data-browse="${opts.browse}" data-listpath="${esc(path)}" data-index="${i}">Browse…</button>` : ''}
            <button class="btn-ghost danger" data-remove="${esc(path)}" data-index="${i}" title="Remove">✕</button>
          </div>`).join('')}
        <button class="btn-ghost add" data-add-string="${esc(path)}">${opts.add || 'Add'}</button>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------

  function shortcutBox() {
    const accelerator = (settings.launcherShortcut || '').trim();
    const shown = accelerator ? accelerator.replace(/CommandOrControl/i, 'Ctrl') : 'Off';
    let state = 'ok', message = 'Registered — press it anywhere to open the launcher.';
    if (!accelerator) {
      state = 'muted';
      message = 'No hotkey. Open the launcher from the tray or the search box.';
    } else if (status && !status.registered) {
      state = 'error';
      message = (status && status.error) || 'This combination is not active.';
    }

    return `
      <div class="set-group">
        <h3>Launcher hotkey</h3>
        <div class="shortcut-box ${state}">
          <button class="shortcut-key" id="set-record">${recording ? 'Press keys…' : esc(shown)}</button>
          <span class="shortcut-msg">${esc(message)}</span>
        </div>
        <div class="set-actions-row">
          <button class="btn-ghost" id="set-test">Open the launcher now</button>
          <button class="btn-ghost" id="set-clear-shortcut">Turn the hotkey off</button>
        </div>
        <p class="set-hint">
          If pressing the hotkey does nothing, another application already owns
          it — Windows gives no warning and simply doesn't deliver the key.
          "Open the launcher now" bypasses the hotkey, so it tells you whether
          the problem is the shortcut or the launcher itself.
        </p>
        ${suggestions.length ? `
          <div class="shortcut-suggestions">
            <span class="set-hint">Try instead:</span>
            ${suggestions.map(s => `<button class="chip-btn" data-shortcut="${esc(s)}">${esc(s.replace(/CommandOrControl/i, 'Ctrl'))}</button>`).join('')}
          </div>` : ''}
      </div>`;
  }

  /** The modes the launcher can show, matching ALL_TOOLS in launcher.html. */
  const LAUNCHER_MODES = [
    { id: 'all', label: 'All', hint: 'Search every provider at once' },
    { id: 'projects', label: 'Projects', hint: 'Git repositories' },
    { id: 'launch', label: 'Launch', hint: 'Apps and links' },
    { id: 'todos', label: 'Todos', hint: 'Unchecked todos from your notes' },
    { id: 'health', label: 'Health', hint: 'Re-check services on demand' },
  ];

  /** The launcher modes currently on, defaulting to all of them. */
  function currentModes() {
    const stored = settings.launcher && settings.launcher.modes;
    return Array.isArray(stored) && stored.length ? stored : LAUNCHER_MODES.map(m => m.id);
  }

  function launcherSection() {
    const launcher = settings.launcher || {};
    const modes = currentModes();
    const percent = Math.round((launcher.opacity != null ? launcher.opacity : 0.88) * 100);

    return `
      ${shortcutBox()}
      <div class="set-group">
        <h3>Appearance</h3>
        <label class="set-field">
          <span class="set-label">Background opacity — <strong id="opacity-value">${percent}%</strong></span>
          <input type="range" id="launcher-opacity" min="50" max="100" step="1" value="${percent}">
          <span class="set-hint">
            The launcher floats over whatever you summoned it from. Lower is
            prettier over a desktop; higher is readable over a busy window.
          </span>
        </label>
        ${toggleField('settings', 'launcher.showHints', 'Show the keyboard hints',
          'The row along the bottom explaining Enter, Tab and Esc. Useful while the keys are new; easy to reclaim once they are not.')}
      </div>
      <div class="set-group">
        <h3>Modes</h3>
        <p class="set-hint">
          Which orbs appear, and what <kbd>Tab</kbd> cycles through. Switching one
          off also removes its slash command.
        </p>
        ${LAUNCHER_MODES.map(mode => `
          <label class="set-toggle">
            <input type="checkbox" data-mode="${mode.id}" ${modes.includes(mode.id) ? 'checked' : ''}>
            <span class="set-toggle-body">
              <span class="set-label">${esc(mode.label)}</span>
              <span class="set-hint">${esc(mode.hint)}</span>
            </span>
          </label>`).join('')}
      </div>
      <div class="set-group">
        <h3>Results</h3>
        ${textField('settings', 'launcher.maxResults', 'Most matches to show', {
          type: 'number', min: 5,
          hint: 'The list scrolls, so this is about how far a search reaches rather than how much fits.',
        })}
        ${toggleField('settings', 'launcher.showRecentWhenEmpty', 'Show recent items before you type',
          'With an empty box, list what you open most instead of nothing.')}
      </div>`;
  }

  /// Items the user hid from the ⋯ menu, so there is a way back.
  function hiddenSection() {
    const overrides = settings.itemOverrides || {};
    const hidden = Object.keys(overrides).filter(key => overrides[key] && overrides[key].hidden);
    if (!hidden.length) {
      return `
        <div class="set-group">
          <h3>Hidden items</h3>
          <p class="set-hint">
            Nothing hidden. Right-click any item — or use its ⋯ button — to
            rename it, give it an icon or a colour, or hide it.
          </p>
        </div>`;
    }
    return `
      <div class="set-group">
        <h3>Hidden items</h3>
        <p class="set-hint">Hidden from the dashboard and the launcher. Bring one back:</p>
        ${hidden.map(key => `
          <div class="set-row">
            <span class="hidden-key">${esc(key)}</span>
            <button class="btn-ghost" data-unhide="${esc(key)}">Show again</button>
          </div>`).join('')}
      </div>`;
  }

  function generalSection() {
    return `
      <div class="set-group">
        <h3>Appearance</h3>
        ${selectField('settings', 'theme', 'Theme', [
          { value: 'system', label: 'Match Windows' },
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ])}
        ${selectField('settings', 'dashboardColumns', 'Dashboard columns', [
          { value: 1, label: '1' }, { value: 2, label: '2' },
          { value: 3, label: '3' }, { value: 4, label: '4' },
        ])}
      </div>
      <div class="set-group">
        <h3>Window</h3>
        ${toggleField('settings', 'keepInTray', 'Keep running in the tray',
          'Closing the window leaves Dev Hub running so the hotkey keeps working.')}
        ${toggleField('settings', 'startMinimized', 'Start in the tray',
          'Launch straight to the tray instead of opening the dashboard.')}
        <label class="set-toggle">
          <input type="checkbox" id="set-run-at-login" ${runAtLogin ? 'checked' : ''}>
          <span class="set-toggle-body">
            <span class="set-label">Start with Windows</span>
            <span class="set-hint">
              A launcher you have to launch is one you forget. Starts in the tray,
              so it never opens over what you're doing.
            </span>
          </span>
        </label>
        ${toggleField('settings', 'notifyOnFailure', 'Tell me when a service breaks',
          'A desktop notification the moment a watched service stops answering — only on the change, never repeatedly.')}
      </div>
      <div class="set-group">
        <h3>Cards</h3>
        ${toggleField('settings', 'providers.launch', 'Apps & links', null)}
        ${toggleField('settings', 'providers.projects', 'Repos', null)}
        ${toggleField('settings', 'providers.todos', 'Todos', null)}
        ${toggleField('settings', 'providers.health', 'Services', null)}
      </div>
      ${hiddenSection()}`;
  }

  /**
   * Which of url / path / run an entry uses.
   *
   * Keyed on the field being *present*, not on it having a value: a program
   * entry you have only just created has an empty path, and testing
   * truthiness made it fall back to rendering as a web link — so clicking
   * "Program" appeared to do nothing at all.
   */
  function entryKind(entry) {
    if (entry.run) return 'run';
    if (entry.path != null) return 'path';
    return 'url';
  }

  function launchSection() {
    const entries = config.launch || [];
    return `
      <div class="set-group">
        <h3>Apps &amp; links</h3>
        <p class="set-hint">Anything you want one keystroke away: an IDE, a Confluence space, a Jenkins job, a folder.</p>
        ${entries.length ? '' : '<p class="set-empty">No entries yet.</p>'}
        ${entries.map((entry, i) => {
          const kind = entryKind(entry);
          return `
          <div class="set-card" data-entry="${i}">
            <div class="set-card-head">
              <input class="set-title-input" type="text" data-entry-field="title" data-index="${i}"
                     value="${esc(entry.title || '')}" placeholder="Name">
              <select data-entry-field="icon" data-index="${i}" class="icon-select">
                ${ICON_CHOICES.map(c => `<option value="${c}" ${entry.icon === c ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
              <button class="btn-ghost danger" data-remove-entry="launch" data-index="${i}" title="Remove">✕</button>
            </div>
            <div class="set-card-body">
              <div class="kind-tabs">
                ${['url', 'path', 'run'].map(k => `
                  <button class="kind-tab ${kind === k ? 'active' : ''}" data-kind="${k}" data-index="${i}">
                    ${k === 'url' ? 'Web link' : k === 'path' ? 'File or folder' : 'Program'}
                  </button>`).join('')}
              </div>
              ${kind === 'url' ? `
                <div class="set-row">
                  <input type="text" data-entry-field="url" data-index="${i}"
                         value="${esc(entry.url || '')}" placeholder="https://…">
                </div>` : ''}
              ${kind === 'path' ? `
                <div class="set-row">
                  <input type="text" data-entry-field="path" data-index="${i}"
                         value="${esc(entry.path || '')}" placeholder="C:\\dev">
                  <button class="btn-ghost" data-browse="folder" data-entry-field="path" data-index="${i}">Browse…</button>
                </div>` : ''}
              ${kind === 'run' ? `
                <div class="set-row">
                  <input type="text" data-entry-field="run.program" data-index="${i}"
                         value="${esc((entry.run && entry.run.program) || '')}" placeholder="C:\\…\\idea64.exe">
                  <button class="btn-ghost" data-browse="program" data-entry-field="run.program" data-index="${i}">Browse…</button>
                </div>
                <div class="set-row">
                  <span class="set-mini-label">Arguments</span>
                  <input type="text" data-entry-field="run.args" data-index="${i}"
                         value="${esc(((entry.run && entry.run.args) || []).join(' '))}"
                         placeholder="optional, space separated">
                </div>` : ''}
              <div class="set-row">
                <span class="set-mini-label">Keywords</span>
                <input type="text" data-entry-field="keywords" data-index="${i}"
                       value="${esc((entry.keywords || []).join(', '))}"
                       placeholder="extra words to search on, comma separated">
              </div>
            </div>
          </div>`;
        }).join('')}
        <button class="btn-ghost add" data-add-entry="launch">Add an app or link</button>
      </div>`;
  }

  function openWithList() {
    const openers = (config.projects && config.projects.openWith) || [];
    return `
      <div class="set-group">
        <h3>Open a repo with…</h3>
        <p class="set-hint">Each becomes a button on the repo's row. Use <code>{path}</code> where the repo folder should go.</p>
        ${openers.length ? '' : '<p class="set-empty">No openers yet.</p>'}
        ${openers.map((opener, i) => `
          <div class="set-row">
            <input type="text" data-opener-field="label" data-index="${i}" value="${esc(opener.label || '')}" placeholder="IntelliJ">
            <input type="text" data-opener-field="program" data-index="${i}" value="${esc(opener.program || '')}" placeholder="idea64.exe">
            <button class="btn-ghost" data-browse="program" data-opener-field="program" data-index="${i}">Browse…</button>
            <input type="text" data-opener-field="args" data-index="${i}" value="${esc((opener.args || []).join(' '))}" placeholder="{path}">
            <button class="btn-ghost danger" data-remove-opener="${i}" title="Remove">✕</button>
          </div>`).join('')}
        <button class="btn-ghost add" data-add-opener="1">Add an opener</button>
      </div>`;
  }

  function projectsSection() {
    return `
      <div class="set-group">
        <h3>Where your repos live</h3>
        <p class="set-hint">Dev Hub looks for git checkouts under each folder.</p>
        ${stringList('projects.roots', {
          browse: 'folder', placeholder: 'C:\\dev',
          empty: 'No folders yet — add one and your repos appear on the dashboard.',
          add: 'Add a folder',
        })}
        ${textField('config', 'projects.maxDepth', 'How deep to look', {
          type: 'number', min: 1,
          hint: 'Levels of subfolders to search. 3 suits a folder of checkouts.',
        })}
      </div>
      ${openWithList()}`;
  }

  function todosSection() {
    return `
      <div class="set-group">
        <h3>Where your notes live</h3>
        <p class="set-hint">
          Leave this empty and Dev Hub follows whatever notebook Markdown Notebook
          last opened — the two apps find each other on their own.
        </p>
        ${stringList('todos.roots', {
          browse: 'folder', placeholder: 'C:\\notes',
          empty: 'Empty — following the Markdown Notebook notebook.',
          add: 'Add a notes folder',
        })}
      </div>
      <div class="set-group">
        <h3>Filter</h3>
        ${stringList('todos.includeTags', {
          placeholder: 'ops', empty: 'No filter — every unchecked todo shows.',
          add: 'Only show todos with this tag',
        })}
      </div>
      <div class="set-group">
        <h3>Duplicates</h3>
        ${toggleField('config', 'todos.deduplicate', 'Collapse repeated todos',
          'A generated folder index lists every todo underneath it, so without this each one shows twice. The copy kept is the one in the note you would actually edit.')}
        <p class="set-hint">Files skipped entirely, by name:</p>
        ${stringList('todos.excludeFiles', {
          placeholder: 'index', empty: 'Nothing skipped.',
          add: 'Skip another file name',
        })}
      </div>
      <div class="set-group">
        <h3>Open a todo with…</h3>
        <p class="set-hint">Use <code>{path}</code> and <code>{line}</code> to jump to the right line.</p>
        ${textField('config', 'todos.openWith.program', 'Program', { browse: 'program', placeholder: 'code' })}
        ${textField('config', 'todos.openWith.argsText', 'Arguments', { placeholder: '-g {path}:{line}' })}
      </div>`;
  }

  function healthSection() {
    const endpoints = (config.health && config.health.endpoints) || [];
    return `
      <div class="set-group">
        <h3>Services to watch</h3>
        <p class="set-hint">Dev Hub requests each of these on a timer and shows the status code and latency. It never contacts anything you haven't listed here.</p>
        ${endpoints.length ? '' : '<p class="set-empty">No services yet.</p>'}
        ${endpoints.map((endpoint, i) => `
          <div class="set-row">
            <input type="text" data-endpoint-field="name" data-index="${i}" value="${esc(endpoint.name || '')}" placeholder="API — local">
            <input type="text" data-endpoint-field="url" data-index="${i}" value="${esc(endpoint.url || '')}" placeholder="http://localhost:8080/health" class="grow">
            <input type="number" data-endpoint-field="expect" data-index="${i}" value="${esc(endpoint.expect ?? 200)}" title="Expected status code" class="narrow">
            <button class="btn-ghost danger" data-remove-endpoint="${i}" title="Remove">✕</button>
          </div>`).join('')}
        <button class="btn-ghost add" data-add-endpoint="1">Add a service</button>
      </div>
      <div class="set-group">
        <h3>Timing</h3>
        ${textField('config', 'health.intervalSeconds', 'Check every (seconds)', { type: 'number', min: 5 })}
        ${textField('config', 'health.timeoutMs', 'Give up after (ms)', { type: 'number', min: 250 })}
        ${textField('config', 'health.slowMs', 'Warn when slower than (ms)', {
          type: 'number', min: 0,
          hint: 'A service answering in four seconds instead of forty milliseconds is broken in the way that costs you an afternoon, and "200 OK" hides it. 0 switches the warning off.',
        })}
      </div>`;
  }

  function commandSection() {
    const commands = config.command || [];
    return `
      <div class="set-group">
        <h3>Custom cards</h3>
        <p class="set-hint">
          Run any command on a timer and turn its output into a card. The command
          must print a JSON array of items — see the README for the shape. This is
          how anything with a CLI becomes part of the dashboard.
        </p>
        ${commands.length ? '' : '<p class="set-empty">No custom cards.</p>'}
        ${commands.map((entry, i) => `
          <div class="set-card">
            <div class="set-card-head">
              <input class="set-title-input" type="text" data-command-field="name" data-index="${i}"
                     value="${esc(entry.name || '')}" placeholder="Card title">
              <button class="btn-ghost danger" data-remove-command="${i}" title="Remove">✕</button>
            </div>
            <div class="set-card-body">
              <div class="set-row">
                <input type="text" data-command-field="id" data-index="${i}" value="${esc(entry.id || '')}" placeholder="unique-id" class="narrow-id">
                <input type="text" data-command-field="program" data-index="${i}" value="${esc(entry.program || '')}" placeholder="gh">
                <button class="btn-ghost" data-browse="program" data-command-field="program" data-index="${i}">Browse…</button>
              </div>
              <div class="set-row">
                <input type="text" data-command-field="args" data-index="${i}" value="${esc((entry.args || []).join(' '))}" placeholder="Arguments">
              </div>
              <div class="set-row">
                <input type="number" data-command-field="intervalSeconds" data-index="${i}" value="${esc(entry.intervalSeconds ?? 300)}" title="Interval (seconds)" class="narrow">
                <span class="set-hint">seconds between runs</span>
              </div>
            </div>
          </div>`).join('')}
        <button class="btn-ghost add" data-add-command="1">Add a custom card</button>
      </div>`;
  }

  function advancedSection() {
    return `
      <div class="set-group">
        <h3>Config file</h3>
        <p class="set-hint">
          Everything above is stored in this file. Editing it here keeps comments
          and any keys the forms don't cover; saving from the other tabs rewrites
          it and drops them.
        </p>
        <textarea id="set-raw" spellcheck="false" rows="18"></textarea>
        <div class="set-actions-row">
          <button class="btn-ghost" id="set-raw-save">Save the file as written</button>
          <button class="btn-ghost" id="set-open-file">Open it in an editor</button>
        </div>
        <p class="set-hint" id="set-raw-path"></p>
      </div>`;
  }

  function sectionHtml() {
    switch (active) {
      case 'general': return generalSection();
      case 'launcher': return launcherSection();
      case 'launch': return launchSection();
      case 'projects': return projectsSection();
      case 'todos': return todosSection();
      case 'health': return healthSection();
      case 'command': return commandSection();
      case 'advanced': return advancedSection();
      default: return '';
    }
  }

  function render() {
    el.nav.innerHTML = SECTIONS.map(s => `
      <button class="set-nav-item ${s.id === active ? 'active' : ''}" data-section="${s.id}">
        ${iconSvg(s.icon)}<span>${esc(s.label)}</span>
      </button>`).join('');
    el.body.innerHTML = sectionHtml();
    if (active === 'advanced') loadRaw();
    if (el.save) el.save.disabled = !dirty;
  }

  async function loadRaw() {
    try {
      const payload = await api.getConfig();
      const area = document.getElementById('set-raw');
      if (area) area.value = payload.text || '';
      const path = document.getElementById('set-raw-path');
      if (path) path.textContent = payload.path || '';
    } catch { /* the tab still works for opening the file */ }
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  function splitArgs(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean);
  }

  function splitList(text) {
    return String(text || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  function applyEntryField(index, field, value) {
    const entry = config.launch[index];
    if (!entry) return;
    if (field === 'keywords') entry.keywords = splitList(value);
    else if (field === 'run.program') entry.run = Object.assign({}, entry.run, { program: value });
    else if (field === 'run.args') entry.run = Object.assign({}, entry.run, { args: splitArgs(value) });
    else entry[field] = value;
    markDirty();
  }

  function setEntryKind(index, kind) {
    const entry = config.launch[index];
    if (!entry) return;
    // One entry does one thing — switching clears the others so a stale URL
    // can't outrank the program you just chose.
    delete entry.url; delete entry.path; delete entry.run;
    if (kind === 'url') entry.url = '';
    else if (kind === 'path') entry.path = '';
    else entry.run = { program: '', args: [] };
    markDirty();
    render();
  }

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  /** The form keeps args as a single string for editing; split them on save. */
  function normalisedConfig() {
    const out = clone(config);
    if (out.todos && out.todos.openWith) {
      const opener = out.todos.openWith;
      opener.args = splitArgs(opener.argsText != null ? opener.argsText : (opener.args || []).join(' '));
      delete opener.argsText;
      if (!opener.program) delete out.todos.openWith;
    }
    (out.launch || []).forEach(entry => {
      if (entry.run && !entry.run.program) delete entry.run;
    });
    return out;
  }

  async function save() {
    const button = el.save;
    button.disabled = true;
    try {
      await api.saveConfigJson(normalisedConfig());
      settings = await api.saveSettings(settings);
      dirty = false;
      onSaved({ settings });
      close();
    } catch (err) {
      button.disabled = false;
      window.DevHubDashboard.toast(String(err), true);
    }
  }

  // -------------------------------------------------------------------------
  // Shortcut recorder
  // -------------------------------------------------------------------------

  function acceleratorFrom(event) {
    const parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    const key = event.key;
    if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return null;
    let name;
    if (key === ' ' || key === 'Spacebar') name = 'Space';
    else if (key.length === 1) name = key.toUpperCase();
    else name = key.charAt(0).toUpperCase() + key.slice(1);
    // A bare key with no modifier would swallow that key system-wide.
    if (!parts.length) return null;
    parts.push(name);
    return parts.join('+');
  }

  async function applyShortcut(accelerator) {
    status = await api.setLauncherShortcut(accelerator);
    settings.launcherShortcut = accelerator;
    recording = false;
    render();
    if (status && status.registered) {
      window.DevHubDashboard.toast('Hotkey set');
    } else if (status && status.error) {
      window.DevHubDashboard.toast(status.error, true);
    }
  }

  function onRecordKey(event) {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { recording = false; render(); return; }
    const accelerator = acceleratorFrom(event);
    if (!accelerator) return; // still waiting for a non-modifier key
    applyShortcut(accelerator);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function wire() {
    el.nav.addEventListener('click', (event) => {
      const item = event.target.closest('.set-nav-item');
      if (!item) return;
      active = item.dataset.section;
      render();
    });

    el.body.addEventListener('input', (event) => {
      const target = event.target;
      const index = parseInt(target.dataset.index, 10);

      // Live-previewed: the number next to the slider is the point of it.
      if (target.id === 'launcher-opacity') {
        const percent = Number(target.value);
        set(settings, 'launcher.opacity', percent / 100);
        const readout = document.getElementById('opacity-value');
        if (readout) readout.textContent = `${percent}%`;
        markDirty();
        return;
      }
      if (target.dataset.path) {
        const root = target.dataset.scope === 'settings' ? settings : config;
        let value = target.type === 'checkbox' ? target.checked : target.value;
        if (target.type === 'number') value = Number(value);
        set(root, target.dataset.path, value);
        markDirty();
        return;
      }
      if (target.dataset.listpath) {
        const list = get(config, target.dataset.listpath) || [];
        list[index] = target.value;
        set(config, target.dataset.listpath, list);
        markDirty();
        return;
      }
      if (target.dataset.entryField) { applyEntryField(index, target.dataset.entryField, target.value); return; }
      if (target.dataset.openerField) {
        const opener = config.projects.openWith[index];
        const field = target.dataset.openerField;
        opener[field] = field === 'args' ? splitArgs(target.value) : target.value;
        markDirty();
        return;
      }
      if (target.dataset.endpointField) {
        const endpoint = config.health.endpoints[index];
        const field = target.dataset.endpointField;
        endpoint[field] = field === 'expect' ? Number(target.value) : target.value;
        markDirty();
        return;
      }
      if (target.dataset.commandField) {
        const entry = config.command[index];
        const field = target.dataset.commandField;
        if (field === 'args') entry.args = splitArgs(target.value);
        else if (field === 'intervalSeconds') entry.intervalSeconds = Number(target.value);
        else entry[field] = target.value;
        markDirty();
      }
    });

    el.body.addEventListener('change', async (event) => {
      const target = event.target;
      // The registry is the truth here, so this applies immediately and then
      // re-reads it — a checkbox that disagreed with Task Manager would be
      // worse than not having one.
      if (target.id === 'set-run-at-login') {
        try {
          runAtLogin = await api.setRunAtLogin(target.checked);
          target.checked = runAtLogin;
          window.DevHubDashboard.toast(runAtLogin ? 'Dev Hub will start with Windows' : 'Dev Hub will not start with Windows');
        } catch (err) {
          target.checked = runAtLogin;
          window.DevHubDashboard.toast(String(err), true);
        }
        return;
      }
      // Mode list order follows LAUNCHER_MODES rather than click order, so the
      // orbs stay in the arrangement the keyboard shortcuts assume.
      if (target.dataset.mode) {
        // Same fallback the render uses. Reading a missing list as "none
        // selected" while the checkboxes show "all selected" made the first
        // click look like it was switching off the last mode.
        const wanted = new Set(currentModes());
        if (target.checked) wanted.add(target.dataset.mode);
        else wanted.delete(target.dataset.mode);
        const ordered = LAUNCHER_MODES.map(m => m.id).filter(id => wanted.has(id));
        set(settings, 'launcher.modes', ordered.length ? ordered : LAUNCHER_MODES.map(m => m.id));
        if (!ordered.length) {
          target.checked = true;
          window.DevHubDashboard.toast('The launcher needs at least one mode.', true);
        }
        markDirty();
        return;
      }
      if (target.type === 'checkbox' && target.dataset.path) {
        set(target.dataset.scope === 'settings' ? settings : config, target.dataset.path, target.checked);
        markDirty();
      }
      if (target.tagName === 'SELECT' && target.dataset.path) {
        let value = target.value;
        if (target.dataset.path === 'dashboardColumns') value = Number(value);
        set(target.dataset.scope === 'settings' ? settings : config, target.dataset.path, value);
        markDirty();
      }
      if (target.dataset.entryField === 'icon') {
        applyEntryField(parseInt(target.dataset.index, 10), 'icon', target.value);
      }
    });

    el.body.addEventListener('click', async (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      const index = parseInt(target.dataset.index, 10);

      // Unhiding is immediate rather than staged behind Save: it is one
      // reversible click, and a hidden item you can't see is a poor thing to
      // leave pending.
      if (target.dataset.unhide) {
        const key = target.dataset.unhide;
        const existing = (settings.itemOverrides || {})[key] || {};
        try {
          settings = await api.setItemOverride(key, {
            nickname: existing.nickname || null,
            icon: existing.icon || null,
            accent: existing.accent || null,
            hidden: false,
          });
          render();
          window.DevHubDashboard.toast('Item restored');
        } catch (err) {
          window.DevHubDashboard.toast(String(err), true);
        }
        return;
      }
      if (target.id === 'set-record') { recording = !recording; render(); return; }
      if (target.id === 'set-run-at-login') return; // handled on change
      if (target.id === 'set-test') { api.showLauncher(); return; }
      if (target.id === 'set-clear-shortcut') { applyShortcut(''); return; }
      if (target.dataset.shortcut) { applyShortcut(target.dataset.shortcut); return; }
      if (target.id === 'set-open-file') { api.revealConfigFile(); return; }
      if (target.id === 'set-raw-save') {
        const area = document.getElementById('set-raw');
        try {
          await api.saveConfig(area.value);
          config = await api.getConfigJson();
          window.DevHubDashboard.toast('Config saved');
        } catch (err) {
          window.DevHubDashboard.toast(String(err), true);
        }
        return;
      }

      if (target.dataset.browse) {
        const picked = target.dataset.browse === 'folder'
          ? await api.pickFolder()
          : await api.pickProgram();
        if (!picked) return;
        if (target.dataset.listpath) {
          const list = get(config, target.dataset.listpath) || [];
          list[index] = picked;
          set(config, target.dataset.listpath, list);
        } else if (target.dataset.entryField) {
          applyEntryField(index, target.dataset.entryField, picked);
        } else if (target.dataset.openerField) {
          config.projects.openWith[index].program = picked;
        } else if (target.dataset.commandField) {
          config.command[index].program = picked;
        } else if (target.dataset.target) {
          set(target.dataset.scope === 'settings' ? settings : config, target.dataset.target, picked);
        }
        markDirty();
        render();
        return;
      }

      if (target.dataset.addString) {
        const list = get(config, target.dataset.addString) || [];
        list.push('');
        set(config, target.dataset.addString, list);
        markDirty(); render(); return;
      }
      if (target.dataset.remove) {
        const list = get(config, target.dataset.remove) || [];
        list.splice(index, 1);
        set(config, target.dataset.remove, list);
        markDirty(); render(); return;
      }
      if (target.dataset.addEntry) {
        config.launch = config.launch || [];
        config.launch.push({ title: '', icon: 'web', url: '', keywords: [] });
        markDirty(); render(); return;
      }
      if (target.dataset.removeEntry) {
        config.launch.splice(index, 1);
        markDirty(); render(); return;
      }
      if (target.dataset.kind) { setEntryKind(index, target.dataset.kind); return; }
      if (target.dataset.addOpener) {
        config.projects = config.projects || {};
        config.projects.openWith = config.projects.openWith || [];
        config.projects.openWith.push({ label: '', program: '', args: ['{path}'] });
        markDirty(); render(); return;
      }
      if (target.dataset.removeOpener) {
        config.projects.openWith.splice(Number(target.dataset.removeOpener), 1);
        markDirty(); render(); return;
      }
      if (target.dataset.addEndpoint) {
        config.health = config.health || {};
        config.health.endpoints = config.health.endpoints || [];
        config.health.endpoints.push({ name: '', url: '', expect: 200 });
        markDirty(); render(); return;
      }
      if (target.dataset.removeEndpoint) {
        config.health.endpoints.splice(Number(target.dataset.removeEndpoint), 1);
        markDirty(); render(); return;
      }
      if (target.dataset.addCommand) {
        config.command = config.command || [];
        config.command.push({ id: '', name: '', program: '', args: [], intervalSeconds: 300 });
        markDirty(); render(); return;
      }
      if (target.dataset.removeCommand) {
        config.command.splice(Number(target.dataset.removeCommand), 1);
        markDirty(); render();
      }
    });

    el.save.addEventListener('click', save);
    el.close.addEventListener('click', close);
    el.overlay.addEventListener('mousedown', (event) => {
      if (event.target === el.overlay) close();
    });
    document.addEventListener('keydown', (event) => {
      if (!el.overlay.classList.contains('visible')) return;
      if (recording) { onRecordKey(event); return; }
      if (event.key === 'Escape') close();
    }, true);
  }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  async function open(section) {
    active = section || 'general';
    recording = false;
    dirty = false;
    try {
      const [loadedSettings, loadedConfig, loadedStatus, loadedSuggestions, loadedRunAtLogin] =
        await Promise.all([
          api.getSettings(), api.getConfigJson(), api.shortcutStatus(),
          api.shortcutSuggestions(), api.runAtLogin(),
        ]);
      settings = clone(loadedSettings);
      config = clone(loadedConfig);
      status = loadedStatus;
      suggestions = loadedSuggestions || [];
      runAtLogin = !!loadedRunAtLogin;
      // The opener's args edit as one string; keep the split copy out of the way.
      if (config.todos && config.todos.openWith) {
        config.todos.openWith.argsText = (config.todos.openWith.args || []).join(' ');
      } else {
        config.todos = config.todos || {};
        config.todos.openWith = { program: '', argsText: '' };
      }
    } catch (err) {
      window.DevHubDashboard.toast(`Could not load settings: ${err}`, true);
      return;
    }
    el.overlay.classList.add('visible');
    render();
  }

  function close() {
    recording = false;
    el.overlay.classList.remove('visible');
  }

  function init(hubApi, options = {}) {
    api = hubApi;
    onSaved = options.onSaved || (() => {});
    el.overlay = document.getElementById('settings-overlay');
    el.nav = document.getElementById('settings-nav');
    el.body = document.getElementById('settings-body');
    el.save = document.getElementById('settings-save');
    el.close = document.getElementById('settings-close');
    wire();
  }

  window.DevHubSettings = { init, open, close, acceleratorFrom, normalisedConfig: () => normalisedConfig() };
})();

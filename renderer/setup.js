// First-run setup.
//
// A fresh exe used to open on four cards, three of them empty, with the config
// that would fill them sitting in a file you had to go and find. This asks two
// questions instead — where your repos are, and which editor to open them with —
// and fills everything else in from what it can already see on disk.
//
// It is skippable and never returns uninvited: `setupComplete` is set whether
// you finish or dismiss it.
(function () {
  'use strict';

  const { iconSvg } = window.DevHubIcons;

  let api = null;
  let suggestions = { tools: [], repoRoots: [], notebookRoot: '' };
  let chosenRoots = new Set();
  let chosenTools = new Set();
  let extraRoots = [];
  let onDone = () => {};

  const el = {};

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function render() {
    const roots = [...suggestions.repoRoots, ...extraRoots];
    el.body.innerHTML = `
      <div class="setup-step">
        <h3>Where do your repos live?</h3>
        ${roots.length ? '' : `
          <p class="set-hint">
            Nothing obvious found. Point Dev Hub at a folder that holds your
            checkouts and every repo underneath it becomes a row.
          </p>`}
        ${roots.map((root, i) => `
          <label class="setup-check">
            <input type="checkbox" data-root="${esc(root)}" ${chosenRoots.has(root) ? 'checked' : ''}>
            <span class="setup-check-body">
              <span class="set-label">${esc(root)}</span>
              ${i < suggestions.repoRoots.length ? '<span class="set-hint">Found on this machine</span>' : ''}
            </span>
          </label>`).join('')}
        <button class="btn-ghost add" id="setup-add-root">Choose a folder…</button>
      </div>

      <div class="setup-step">
        <h3>Open a repo with…</h3>
        ${suggestions.tools.length ? `
          <p class="set-hint">Found on this machine. Each ticked one becomes a button on every repo row.</p>
          ${suggestions.tools.map(tool => `
            <label class="setup-check">
              <input type="checkbox" data-tool="${esc(tool.id)}" ${chosenTools.has(tool.id) ? 'checked' : ''}>
              <span class="setup-check-body">
                <span class="set-label">${esc(tool.label)}</span>
                <span class="set-hint">${esc(tool.program)}</span>
              </span>
            </label>`).join('')}
        ` : `
          <p class="set-hint">
            No editors found in the usual places. You can add one later in
            Settings → Repos, browsing for the program rather than typing a path.
          </p>`}
      </div>

      ${suggestions.notebookRoot || suggestions.notebookApp ? `
        <div class="setup-step">
          <h3>Your notes</h3>
          ${suggestions.notebookRoot ? `
            <p class="set-hint">
              Markdown Notebook last opened <code>${esc(suggestions.notebookRoot)}</code>.
              Dev Hub will follow it for todos — no configuration needed, and it
              keeps following if you switch notebooks.
            </p>` : ''}
          ${suggestions.notebookApp ? `
            <p class="set-hint">
              Found Markdown Notebook at <code>${esc(suggestions.notebookApp)}</code>,
              so clicking a todo will open its note on the right line.
            </p>` : ''}
        </div>` : ''}

      <div class="setup-step">
        <h3>One more thing</h3>
        <label class="setup-check">
          <input type="checkbox" id="setup-startup" checked>
          <span class="setup-check-body">
            <span class="set-label">Start with Windows</span>
            <span class="set-hint">Starts in the tray, so the hotkey is always there. Nothing opens over your desktop.</span>
          </span>
        </label>
      </div>`;
  }

  /// Turn the choices into a config the providers can use.
  function buildConfig(base) {
    const config = JSON.parse(JSON.stringify(base || {}));
    config.projects = config.projects || { roots: [], maxDepth: 3, openWith: [] };
    config.projects.roots = [...chosenRoots];
    config.projects.openWith = suggestions.tools
      .filter(tool => chosenTools.has(tool.id))
      .map(tool => ({ label: tool.label, program: tool.program, args: tool.args }));

    // Todos open in Markdown Notebook when it's there — leaving openWith unset
    // is what lets the backend keep finding it if it moves. Only when it isn't
    // installed does the chosen editor stand in, so clicking a todo still lands
    // on its line.
    if (!suggestions.notebookApp) {
      const editor = suggestions.tools.find(t => chosenTools.has(t.id) && t.id !== 'terminal' && t.id !== 'explorer');
      if (editor) {
        config.todos = config.todos || {};
        config.todos.openWith = editor.id === 'vscode'
          ? { program: editor.program, args: ['-g', '{path}:{line}'] }
          : { program: editor.program, args: ['{path}'] };
      }
    }
    return config;
  }

  async function finish(skipped) {
    el.finish.disabled = true;
    try {
      if (!skipped) {
        const base = await api.getConfigJson();
        await api.saveConfigJson(buildConfig(base));
        const startup = document.getElementById('setup-startup');
        if (startup && startup.checked) {
          await api.setRunAtLogin(true).catch(() => {});
        }
      }
      await api.saveSettings({ setupComplete: true });
    } catch (err) {
      el.finish.disabled = false;
      window.DevHubDashboard.toast(String(err), true);
      return;
    }
    close();
    onDone();
  }

  function wire() {
    el.body.addEventListener('change', (event) => {
      const target = event.target;
      if (target.dataset.root) {
        if (target.checked) chosenRoots.add(target.dataset.root);
        else chosenRoots.delete(target.dataset.root);
      }
      if (target.dataset.tool) {
        if (target.checked) chosenTools.add(target.dataset.tool);
        else chosenTools.delete(target.dataset.tool);
      }
    });

    el.body.addEventListener('click', async (event) => {
      if (!event.target.closest('#setup-add-root')) return;
      const picked = await api.pickFolder();
      if (!picked) return;
      if (!extraRoots.includes(picked) && !suggestions.repoRoots.includes(picked)) {
        extraRoots.push(picked);
      }
      chosenRoots.add(picked);
      render();
    });

    el.finish.addEventListener('click', () => finish(false));
    el.skip.addEventListener('click', () => finish(true));
  }

  async function open() {
    try {
      suggestions = await api.setupSuggestions();
    } catch {
      suggestions = { tools: [], repoRoots: [], notebookRoot: '' };
    }
    // Everything found is ticked by default — the common case is "yes, those".
    chosenRoots = new Set(suggestions.repoRoots);
    chosenTools = new Set(suggestions.tools.map(t => t.id));
    extraRoots = [];
    el.overlay.classList.add('visible');
    el.finish.disabled = false;
    render();
  }

  function close() {
    el.overlay.classList.remove('visible');
  }

  function init(hubApi, options = {}) {
    api = hubApi;
    onDone = options.onDone || (() => {});
    el.overlay = document.getElementById('setup-overlay');
    el.body = document.getElementById('setup-body');
    el.finish = document.getElementById('setup-finish');
    el.skip = document.getElementById('setup-skip');
    wire();
  }

  window.DevHubSetup = { init, open, close, buildConfig };
})();

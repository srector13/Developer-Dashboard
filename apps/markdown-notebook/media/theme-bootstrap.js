// Applies the GitHub theme class to the preview body so media/github-markdown.css
// (scoped to body.notebook-github-theme) takes effect. Light/dark is handled by
// the CSS itself via VS Code's vscode-dark / vscode-light body classes.
// Also injects and manages the Page Width and Theme Controller toolbar.
(function () {
  'use strict';

  // Prevent default browser navigation for programmatic command clicks to stop the preview from blanking out.
  // We use a capture-phase listener on window because VS Code's click interceptors or page lifecycle transitions
  // can bypass local target/bubble-phase listeners during layout updates and config reloads.
  window.addEventListener('click', function (e) {
    if (e.isTrusted === false) {
      var target = e.target;
      while (target && target !== document.body) {
        if (target.tagName === 'A' && target.href && target.href.indexOf('command:') !== -1) {
          e.preventDefault();
          break;
        }
        target = target.parentNode;
      }
    }
  }, true);

  // Settings are injected into the rendered HTML by the extension's
  // markdown-it plugin (a hidden #notebook-preview-data element).
  function readSettings() {
    var el = document.getElementById('notebook-preview-data');
    if (el) {
      try {
        return JSON.parse(el.getAttribute('data-settings') || '{}');
      } catch (e) {
        /* fall through */
      }
    }
    return {};
  }

  function apply() {
    if (!document.body) {
      setTimeout(apply, 10);
      return;
    }
    var settings = readSettings();

    // Honor the markdownNotebook.previewTheme setting: 'off' leaves the stock
    // VS Code preview untouched; 'github-dark' forces the dark variant unless
    // the user picked something else from the in-preview toolbar.
    var settingTheme = settings.previewTheme || 'github';
    if (settingTheme === 'off') {
      document.body.classList.remove('notebook-github-theme');
      return;
    }
    document.body.classList.add('notebook-github-theme');

    // Apply layout width constraints from local storage preference or default settings
    var defaultWidth = settings.defaultPageWidth || 'standard';
    var currentWidthMode = localStorage.getItem('notebook-width-mode') || defaultWidth;
    document.body.classList.remove('notebook-width-standard', 'notebook-width-wide', 'notebook-width-full');
    document.body.classList.add('notebook-width-' + currentWidthMode);

    // Apply theme overrides
    var defaultThemeMode = settingTheme === 'github-dark' ? 'dark' : 'auto';
    var currentThemeMode = localStorage.getItem('notebook-theme-mode') || defaultThemeMode;
    applyThemeMode(currentThemeMode);

    // Inject Toolbar if not already present
    if (!document.getElementById('notebook-width-toolbar')) {
      var toolbar = document.createElement('div');
      toolbar.id = 'notebook-width-toolbar';
      toolbar.className = 'notebook-width-controller';

      // Width Control Buttons
      var btnStandard = document.createElement('button');
      btnStandard.className = 'notebook-width-btn' + (currentWidthMode === 'standard' ? ' active' : '');
      btnStandard.textContent = 'Standard';
      btnStandard.onclick = function () { setWidthMode('standard'); };

      var btnWide = document.createElement('button');
      btnWide.className = 'notebook-width-btn' + (currentWidthMode === 'wide' ? ' active' : '');
      btnWide.textContent = 'Wide';
      btnWide.onclick = function () { setWidthMode('wide'); };

      var btnFull = document.createElement('button');
      btnFull.className = 'notebook-width-btn' + (currentWidthMode === 'full' ? ' active' : '');
      btnFull.textContent = 'Full';
      btnFull.onclick = function () { setWidthMode('full'); };

      toolbar.appendChild(btnStandard);
      toolbar.appendChild(btnWide);
      toolbar.appendChild(btnFull);

      // Separator
      var separator = document.createElement('span');
      separator.className = 'notebook-toolbar-separator';
      toolbar.appendChild(separator);

      // Theme Control Buttons
      var btnAuto = document.createElement('button');
      btnAuto.className = 'notebook-width-btn' + (currentThemeMode === 'auto' ? ' active' : '');
      btnAuto.textContent = 'Auto';
      btnAuto.onclick = function () { setThemeMode('auto'); };

      var btnLight = document.createElement('button');
      btnLight.className = 'notebook-width-btn' + (currentThemeMode === 'light' ? ' active' : '');
      btnLight.textContent = 'Light';
      btnLight.onclick = function () { setThemeMode('light'); };

      var btnDark = document.createElement('button');
      btnDark.className = 'notebook-width-btn' + (currentThemeMode === 'dark' ? ' active' : '');
      btnDark.textContent = 'Dark';
      btnDark.onclick = function () { setThemeMode('dark'); };

      toolbar.appendChild(btnAuto);
      toolbar.appendChild(btnLight);
      toolbar.appendChild(btnDark);

      document.body.appendChild(toolbar);
    } else {
      // Keep buttons in sync in case the document re-rendered
      var buttons = document.querySelectorAll('#notebook-width-toolbar .notebook-width-btn');
      if (buttons.length >= 6) {
        buttons[0].className = 'notebook-width-btn' + (currentWidthMode === 'standard' ? ' active' : '');
        buttons[1].className = 'notebook-width-btn' + (currentWidthMode === 'wide' ? ' active' : '');
        buttons[2].className = 'notebook-width-btn' + (currentWidthMode === 'full' ? ' active' : '');

        buttons[3].className = 'notebook-width-btn' + (currentThemeMode === 'auto' ? ' active' : '');
        buttons[4].className = 'notebook-width-btn' + (currentThemeMode === 'light' ? ' active' : '');
        buttons[5].className = 'notebook-width-btn' + (currentThemeMode === 'dark' ? ' active' : '');
      }
    }
  }

  function setWidthMode(mode) {
    localStorage.setItem('notebook-width-mode', mode);
    document.body.classList.remove('notebook-width-standard', 'notebook-width-wide', 'notebook-width-full');
    document.body.classList.add('notebook-width-' + mode);

    var buttons = document.querySelectorAll('#notebook-width-toolbar .notebook-width-btn');
    if (buttons.length >= 6) {
      buttons[0].className = 'notebook-width-btn' + (mode === 'standard' ? ' active' : '');
      buttons[1].className = 'notebook-width-btn' + (mode === 'wide' ? ' active' : '');
      buttons[2].className = 'notebook-width-btn' + (mode === 'full' ? ' active' : '');
    }
  }

  function applyThemeMode(theme) {
    document.body.classList.remove('notebook-preview-light', 'notebook-preview-dark');
    if (theme === 'light') {
      document.body.classList.add('notebook-preview-light');
    } else if (theme === 'dark') {
      document.body.classList.add('notebook-preview-dark');
    }
  }

  function setThemeMode(theme) {
    localStorage.setItem('notebook-theme-mode', theme);
    applyThemeMode(theme);

    var buttons = document.querySelectorAll('#notebook-width-toolbar .notebook-width-btn');
    if (buttons.length >= 6) {
      buttons[3].className = 'notebook-width-btn' + (theme === 'auto' ? ' active' : '');
      buttons[4].className = 'notebook-width-btn' + (theme === 'light' ? ' active' : '');
      buttons[5].className = 'notebook-width-btn' + (theme === 'dark' ? ' active' : '');
    }
  }



  // Debounced scroll listener to sync scroll position back to Outline panel
  var scrollTimeout;
  window.addEventListener('scroll', function () {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(function () {
      var elements = document.querySelectorAll('[data-line]');
      var activeLine = -1;

      // Find the element closest to the top of the viewport (rect.top <= 100)
      for (var i = 0; i < elements.length; i++) {
        var rect = elements[i].getBoundingClientRect();
        if (rect.top >= 0 && rect.top <= 100) {
          activeLine = parseInt(elements[i].getAttribute('data-line'), 10);
          break;
        } else if (rect.top < 0) {
          activeLine = parseInt(elements[i].getAttribute('data-line'), 10);
        }
      }

      if (activeLine >= 0) {
        var commandUri = 'command:markdownNotebook.outline.previewScrolled?' + encodeURIComponent(JSON.stringify([activeLine]));
        
        // Ensure a hidden iframe exists to catch any browser default navigation
        // in case event propagation is stopped by VS Code's capture-phase listeners
        var dispatchFrame = document.getElementById('notebook-command-dispatch-frame');
        if (!dispatchFrame) {
          dispatchFrame = document.createElement('iframe');
          dispatchFrame.id = 'notebook-command-dispatch-frame';
          dispatchFrame.name = 'notebook-command-dispatch-frame';
          dispatchFrame.style.display = 'none';
          document.body.appendChild(dispatchFrame);
        }

        var triggerLink = document.createElement('a');
        triggerLink.href = commandUri;
        triggerLink.target = 'notebook-command-dispatch-frame';
        triggerLink.style.display = 'none';
        document.body.appendChild(triggerLink);
        
        triggerLink.click();
        document.body.removeChild(triggerLink);
      }
    }, 150);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
  window.addEventListener('vscode.markdown.updateContent', apply);
})();


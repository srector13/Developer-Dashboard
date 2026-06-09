// Runs inside the VS Code Markdown preview. Renders any <pre class="notebook-mermaid">
// blocks produced by our markdown-it fence override. Mermaid is loaded from the
// vendored mermaid.min.js (contributed via markdown.previewScripts before this).
(function () {
  'use strict';

  function isDark() {
    if (document.body.classList.contains('notebook-preview-light')) {
      return false;
    }
    if (document.body.classList.contains('notebook-preview-dark')) {
      return true;
    }
    // VS Code adds vscode-dark / vscode-high-contrast to <body>.
    var cls = document.body.className || '';
    return /vscode-dark|vscode-high-contrast(?!-light)/.test(cls);
  }

  var retries = 0;
  function renderAll() {
    if (typeof window.mermaid === 'undefined') {
      if (retries < 100) {
        retries++;
        setTimeout(renderAll, 50);
      }
      return;
    }
    retries = 0;
    var blocks = document.querySelectorAll('pre.notebook-mermaid[data-notebook-mermaid]');
    if (!blocks.length) {
      return;
    }

    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: isDark() ? 'dark' : 'default',
        securityLevel: 'strict',
        fontFamily: 'var(--markdown-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
      });
    } catch (e) {
      /* initialize is idempotent enough; ignore re-init errors */
    }

    blocks.forEach(function (el) {
      // Mark unprocessed blocks so mermaid.run picks them up; keep the source
      // in a data attribute so we can re-render on theme changes.
      var src = el.getAttribute('data-src');
      if (!src) {
        src = el.textContent || '';
        el.setAttribute('data-src', src);
      } else {
        el.textContent = src;
      }
      el.removeAttribute('data-processed');
      el.classList.remove('mermaid-rendered');
    });

    try {
      window.mermaid.run({ querySelector: 'pre.notebook-mermaid[data-notebook-mermaid]' }).then(
        function () {
          blocks.forEach(function (el) {
            el.classList.add('mermaid-rendered');
            setupMermaidActions(el);
          });
        },
        function (err) {
          showErrors(blocks, err);
        },
      );
    } catch (err) {
      showErrors(blocks, err);
    }
  }

  function setupMermaidActions(el) {
    if (el.querySelector('.mermaid-actions')) {
      return; // Already initialized
    }

    // Create floating actions toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'mermaid-actions';

    var defaultZoom = (window.notebookSettings && window.notebookSettings.defaultMermaidZoom) || 100;
    var zoomLevel = defaultZoom / 100;
    var svg = el.querySelector('svg');
    var baseWidth = 0;
    if (svg) {
      // Allow overflow scrolling inside the pre block when zoomed
      el.style.overflow = 'auto';

      // Determine the natural render width of the SVG in pixels
      var inlineMax = svg.style.maxWidth;
      if (inlineMax && inlineMax.indexOf('px') !== -1) {
        baseWidth = parseFloat(inlineMax);
      }
      if (!baseWidth) {
        baseWidth = svg.getBoundingClientRect().width;
      }
      if (!baseWidth && svg.viewBox && svg.viewBox.baseVal) {
        baseWidth = svg.viewBox.baseVal.width;
      }
      if (!baseWidth) {
        baseWidth = 500; // Safe fallback
      }
    }

    var btnZoomOut = document.createElement('button');
    btnZoomOut.className = 'mermaid-action-btn';
    btnZoomOut.textContent = '−';
    btnZoomOut.title = 'Zoom Out';
    btnZoomOut.onclick = function (e) {
      e.stopPropagation();
      if (zoomLevel > 0.4) {
        zoomLevel -= 0.15;
        updateZoom();
      }
    };

    var btnReset = document.createElement('button');
    btnReset.className = 'mermaid-action-btn';
    btnReset.textContent = '100%';
    btnReset.title = 'Reset Zoom';
    btnReset.onclick = function (e) {
      e.stopPropagation();
      zoomLevel = 1.0;
      updateZoom();
    };

    var btnZoomIn = document.createElement('button');
    btnZoomIn.className = 'mermaid-action-btn';
    btnZoomIn.textContent = '+';
    btnZoomIn.title = 'Zoom In';
    btnZoomIn.onclick = function (e) {
      e.stopPropagation();
      if (zoomLevel < 3.0) {
        zoomLevel += 0.15;
        updateZoom();
      }
    };

    var btnExpand = document.createElement('button');
    btnExpand.className = 'mermaid-action-btn';
    btnExpand.textContent = '🔍 Expand';
    btnExpand.title = 'View Fullscreen';
    btnExpand.onclick = function (e) {
      e.stopPropagation();
      var currentSvg = el.querySelector('svg');
      showFullscreenModal(currentSvg);
    };

    toolbar.appendChild(btnZoomOut);
    toolbar.appendChild(btnReset);
    toolbar.appendChild(btnZoomIn);

    var container = el.closest('.mermaid-block-container');
    if (container) {
      var hiddenCmd = container.querySelector('.mermaid-toggle-cmd');
      if (hiddenCmd) {
        hiddenCmd.style.display = 'inline-block';
        hiddenCmd.className = 'mermaid-action-btn';
        hiddenCmd.textContent = '⇅';
        hiddenCmd.style.textDecoration = 'none';
        hiddenCmd.style.color = 'inherit';
        toolbar.appendChild(hiddenCmd);
      }
    }

    toolbar.appendChild(btnExpand);
    el.appendChild(toolbar);

    function updateZoom() {
      if (svg && baseWidth > 0) {
        svg.style.width = (baseWidth * zoomLevel) + 'px';
        svg.style.maxWidth = 'none';
        btnReset.textContent = Math.round(zoomLevel * 100) + '%';
      }
    }

    // Call updateZoom to apply initial zoom level (defaultZoom)
    if (svg && baseWidth > 0) {
      updateZoom();
    }
  }

  function showFullscreenModal(originalSvg) {
    if (!originalSvg) { return; }

    var modal = document.getElementById('mermaid-zoom-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'mermaid-zoom-modal';
      modal.className = 'mermaid-modal';

      var closeBtn = document.createElement('button');
      closeBtn.className = 'mermaid-modal-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.onclick = function () {
        modal.classList.remove('active');
      };

      var content = document.createElement('div');
      content.id = 'mermaid-zoom-modal-content';
      content.className = 'mermaid-modal-content';

      modal.appendChild(closeBtn);
      modal.appendChild(content);
      document.body.appendChild(modal);

      // Close modal on escape key
      window.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && modal.classList.contains('active')) {
          modal.classList.remove('active');
        }
      });
      // Close on clicking the backdrop outside the modal content card
      modal.onclick = function (e) {
        if (e.target === modal) {
          modal.classList.remove('active');
        }
      };
    }

    var content = document.getElementById('mermaid-zoom-modal-content');
    content.innerHTML = ''; // Clear previous content

    // Clone the SVG and inject it into the modal
    var clonedSvg = originalSvg.cloneNode(true);
    clonedSvg.removeAttribute('style'); // Strip original layout constraints
    clonedSvg.style.maxWidth = '100%';
    clonedSvg.style.maxHeight = '100%';
    clonedSvg.style.width = '100%';
    clonedSvg.style.height = '100%';

    content.appendChild(clonedSvg);

    // Fade in the modal
    setTimeout(function () {
      modal.classList.add('active');
    }, 10);
  }

  function showErrors(blocks, err) {
    // Leave the source visible if rendering fails, with a small note.
    blocks.forEach(function (el) {
      if (el.classList.contains('mermaid-rendered')) {
        return;
      }
      if (!el.querySelector('.mermaid-error-note')) {
        var note = document.createElement('div');
        note.className = 'mermaid-error-note';
        note.textContent = 'Mermaid: could not render this diagram.';
        el.appendChild(note);
      }
    });
    if (window.console) {
      console.warn('Notebook mermaid render error:', err);
    }
  }

  // The preview reloads content on every edit; run on load and observe body
  // class changes (theme switches) to re-render.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAll);
  } else {
    renderAll();
  }

  var lastDark = null;
  var observer = new MutationObserver(function () {
    var dark = isDark();
    if (dark !== lastDark) {
      lastDark = dark;
      renderAll();
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // VS Code dispatches this after it updates preview content.
  window.addEventListener('vscode.markdown.updateContent', renderAll);

  // Dynamic Scroll to Line Polling for Outline Navigation without tab-switching
  var mediaBaseUri = '';
  var scripts = document.getElementsByTagName('script');
  for (var idx = 0; idx < scripts.length; idx++) {
    var src = scripts[idx].src || '';
    if (src.indexOf('mermaid-preview.js') !== -1) {
      mediaBaseUri = src.replace('mermaid-preview.js', '');
      break;
    }
  }

  var lastTimestamp = 0;
  if (mediaBaseUri) {
    setInterval(function () {
      var old = document.getElementById('notebook-scroll-script');
      if (old) {
        old.parentNode.removeChild(old);
      }
      var script = document.createElement('script');
      script.id = 'notebook-scroll-script';
      script.src = mediaBaseUri + 'scroll-target.js?t=' + Date.now();
      script.onload = function () {
        if (window.notebookScrollTarget && window.notebookScrollTarget.timestamp > lastTimestamp) {
          lastTimestamp = window.notebookScrollTarget.timestamp;
          var line = window.notebookScrollTarget.line;
          if (line >= 0) {
            // VS Code injects data-line attributes into Markdown preview elements
            var el = document.querySelector('[data-line="' + line + '"]');
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }
        }
      };
      document.body.appendChild(script);
    }, 200);
  }
})();

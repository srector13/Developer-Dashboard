(function() {
  function logDiag(msg) {
    console.log(msg);
  }

  // Register error handler first
  window.addEventListener('error', event => {
    logDiag('Runtime Error: ' + event.message + ' at ' + event.filename + ':' + event.lineno + ':' + event.colno);
    if (typeof vscode !== 'undefined' && vscode) {
      try {
        vscode.postMessage({
          type: 'error',
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error ? event.error.stack : ''
        });
      } catch (e) {}
    }
  });

  logDiag('Script loading...');

  let vscode;
  try {
    vscode = acquireVsCodeApi();
    logDiag('VS Code API acquired successfully.');
  } catch (e) {
    logDiag('API acquisition error: ' + e.message);
    vscode = {
      postMessage: function(data) {
        logDiag('Mock postMessage: ' + JSON.stringify(data));
      }
    };
  }

  const textarea = document.getElementById('scratchpad');
  const editorCard = document.getElementById('editor-card');
  const btnClear = document.getElementById('btn-clear');
  const btnConvert = document.getElementById('btn-convert');
  const btnAppendTo = document.getElementById('btn-append-to');
  const btnAppendActive = document.getElementById('btn-append-active');
  const btnHistory = document.getElementById('btn-history');
  const btnDaily = document.getElementById('btn-daily');
  const undoToast = document.getElementById('undo-toast');
  const undoLink = document.getElementById('undo-link');

  const pickerOverlay = document.getElementById('picker-overlay');
  const pickerInput = document.getElementById('picker-input');
  const pickerResults = document.getElementById('picker-results');
  const btnPickerClose = document.getElementById('btn-picker-close');

  const historyOverlay = document.getElementById('history-overlay');
  const historyResults = document.getElementById('history-results');
  const btnHistoryClose = document.getElementById('btn-history-close');
  const btnClearHistory = document.getElementById('btn-clear-history');

  const btnTogglePreview = document.getElementById('btn-toggle-preview');
  const formattingTools = document.getElementById('formatting-tools');
  const formattingBar = document.getElementById('formatting-bar');
  const previewContainer = document.getElementById('preview-container');

  const fmtBold = document.getElementById('fmt-bold');
  const fmtItalic = document.getElementById('fmt-italic');
  const fmtHeading = document.getElementById('fmt-heading');
  const fmtCodeBlock = document.getElementById('fmt-code-block');
  const fmtList = document.getElementById('fmt-list');
  const fmtTask = document.getElementById('fmt-task');
  const fmtQuote = document.getElementById('fmt-quote');
  const fmtTime = document.getElementById('fmt-time');
  const fmtTable = document.getElementById('fmt-table');
  const fmtSeparator = document.getElementById('fmt-separator');
  const fmtChart = document.getElementById('fmt-chart');

  let saveTimeout = null;
  let preClearText = '';
  let toastTimeout = null;
  let hasWorkspaceActive = true;

  let notes = [];
  let filteredNotes = [];
  let selectedIndex = -1;

  logDiag('DOM elements resolved.');

  let historyList = [];
  let activeTab = 'edit'; // 'edit' or 'preview'

  // Signal we are ready to receive initial contents
  logDiag('Sending webviewReady...');
  vscode.postMessage({ type: 'webviewReady' });

  // Handle updates from extension
  window.addEventListener('message', event => {
    const message = event.data;
    logDiag('Received message: ' + message.type);
    switch (message.type) {
      case 'workspaceStatus':
        logDiag('workspaceStatus is ' + message.hasWorkspace);
        setWorkspaceState(message.hasWorkspace);
        break;
      case 'updateContent':
        logDiag('updateContent text len = ' + (message.text ? message.text.length : 0));
        setWorkspaceState(message.hasWorkspace);
        // Only update if value is different (prevents losing focus/cursor position)
        if (textarea.value !== message.text) {
          textarea.value = message.text;
          updateStatusBar();
          if (activeTab === 'preview') {
            updatePreview();
          }
        }
        break;
      case 'focusTextarea':
        if (!textarea.disabled && activeTab === 'edit') {
          textarea.focus();
        }
        break;
      case 'notesList':
        notes = message.notes;
        filteredNotes = [...notes];
        selectedIndex = filteredNotes.length > 0 ? 0 : -1;
        renderResults();
        break;
      case 'historyList':
        historyList = message.history;
        renderHistory();
        break;
      case 'clearConfirmed':
        textarea.value = '';
        updateStatusBar();
        if (activeTab === 'preview') {
          updatePreview();
        }
        break;
      case 'insertCodeBlock':
        logDiag('Scratchpad webview: received insertCodeBlock for language: ' + message.language);
        if (message.language === 'inline') {
          insertFormatting('`', '`');
        } else {
          insertFormatting('```' + message.language + '\n', '\n```');
        }
        break;
      case 'insertTable':
        logDiag('Scratchpad webview: received insertTable');
        insertTableMarkdown(message.text);
        break;
      case 'insertTimestamp':
        logDiag('Scratchpad webview: received insertTimestamp');
        insertFormatting(message.text, '');
        break;
      case 'insertHeading':
        logDiag('Scratchpad webview: received insertHeading');
        insertFormatting(message.prefix, '');
        break;
      case 'insertList':
        logDiag('Scratchpad webview: received insertList');
        insertFormatting(message.prefix, '');
        break;
      case 'insertChart':
        logDiag('Scratchpad webview: received insertChart');
        insertChartMarkdown(message.text);
        break;
    }
  });

  textarea.addEventListener('input', () => {
    updateStatusBar();
    
    // Debounce saving to extension backend
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      vscode.postMessage({
        type: 'saveScratchpad',
        text: textarea.value
      });
    }, 300);
  });

  textarea.addEventListener('focus', () => {
    if (editorCard) {
      editorCard.classList.add('focused');
    }
  });

  textarea.addEventListener('blur', () => {
    if (editorCard) {
      editorCard.classList.remove('focused');
    }
  });

  btnClear.addEventListener('click', () => {
    if (textarea.disabled) return;
    const val = textarea.value;
    if (!val.trim()) return;

    preClearText = val;
    textarea.value = '';
    updateStatusBar();

    // Add to history first
    vscode.postMessage({
      type: 'addToHistory',
      text: val
    });

    // Save empty text immediately
    vscode.postMessage({
      type: 'saveScratchpad',
      text: ''
    });

    // Show Undo Toast
    showToast();
  });

  btnDaily.addEventListener('click', () => {
    if (textarea.disabled) return;
    const val = textarea.value;
    if (!val.trim()) return;
    vscode.postMessage({
      type: 'appendToDaily',
      text: val
    });
  });

  btnConvert.addEventListener('click', () => {
    if (textarea.disabled) return;
    const val = textarea.value;
    if (!val.trim()) return;
    vscode.postMessage({
      type: 'convertToNote',
      text: val
    });
  });

  btnAppendTo.addEventListener('click', () => {
    if (textarea.disabled) return;
    const val = textarea.value;
    if (!val.trim()) return;
    openPicker();
  });

  btnPickerClose.addEventListener('click', closePicker);

  pickerInput.addEventListener('input', () => {
    const q = pickerInput.value.toLowerCase().trim();
    if (!q) {
      filteredNotes = [...notes];
    } else {
      filteredNotes = notes.filter(n => 
        n.title.toLowerCase().includes(q) || 
        n.relativePath.toLowerCase().includes(q)
      );
    }
    selectedIndex = filteredNotes.length > 0 ? 0 : -1;
    renderResults();
  });

  pickerInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredNotes.length > 0) {
        selectedIndex = (selectedIndex + 1) % filteredNotes.length;
        renderResults();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filteredNotes.length > 0) {
        selectedIndex = (selectedIndex - 1 + filteredNotes.length) % filteredNotes.length;
        renderResults();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < filteredNotes.length) {
        selectNote(filteredNotes[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
    }
  });

  function openPicker() {
    pickerOverlay.classList.add('show');
    pickerInput.value = '';
    pickerResults.innerHTML = '<div class="picker-status">Loading notes...</div>';
    vscode.postMessage({ type: 'getNotesList' });
    setTimeout(() => {
      pickerInput.focus();
    }, 50);
  }

  function closePicker() {
    pickerOverlay.classList.remove('show');
    if (activeTab === 'edit') {
      textarea.focus();
    }
  }

  function renderResults() {
    pickerResults.innerHTML = '';
    if (filteredNotes.length === 0) {
      const status = document.createElement('div');
      status.className = 'picker-status';
      status.textContent = 'No matching notes found';
      pickerResults.appendChild(status);
      return;
    }

    filteredNotes.forEach((note, idx) => {
      const item = document.createElement('div');
      item.className = 'picker-item' + (idx === selectedIndex ? ' selected' : '');
      item.dataset.index = idx;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'picker-item-title';
      titleSpan.textContent = note.title;

      const pathSpan = document.createElement('span');
      pathSpan.className = 'picker-item-path';
      pathSpan.textContent = note.relativePath;

      item.appendChild(titleSpan);
      item.appendChild(pathSpan);

      item.addEventListener('click', () => {
        selectNote(note);
      });

      pickerResults.appendChild(item);
    });

    const selectedEl = pickerResults.querySelector('.picker-item.selected');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function selectNote(note) {
    if (textarea.disabled) return;
    const val = textarea.value;
    if (!val.trim()) return;

    vscode.postMessage({
      type: 'appendToNote',
      text: val,
      targetPath: note.fullPath
    });

    closePicker();
  }

  btnAppendActive.addEventListener('click', () => {
    if (textarea.disabled) return;
    const val = textarea.value;
    if (!val.trim()) return;
    vscode.postMessage({
      type: 'appendToActive',
      text: val
    });
  });

  btnHistory.addEventListener('click', openHistory);
  btnHistoryClose.addEventListener('click', closeHistory);
  btnClearHistory.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearHistory' });
  });

  if (btnTogglePreview) {
    btnTogglePreview.addEventListener('click', () => {
      if (activeTab === 'edit') {
        switchTab('preview');
      } else {
        switchTab('edit');
      }
    });
    btnTogglePreview.addEventListener('mousedown', e => e.preventDefault());
  }

  // Prevent formatting buttons from stealing focus from textarea
  [fmtBold, fmtItalic, fmtHeading, fmtCodeBlock, fmtTable, fmtSeparator, fmtList, fmtTask, fmtQuote, fmtTime, fmtChart].forEach(btn => {
    if (btn) {
      btn.addEventListener('mousedown', e => e.preventDefault());
    }
  });

  fmtBold.addEventListener('click', () => insertFormatting('**', '**'));
  fmtItalic.addEventListener('click', () => insertFormatting('*', '*'));
  fmtHeading.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectHeading' });
  });
  if (fmtCodeBlock) {
    fmtCodeBlock.addEventListener('click', () => {
      console.log('Code Block button clicked, posting selectLanguage message');
      vscode.postMessage({ type: 'selectLanguage' });
    });
  }
  if (fmtTable) {
    fmtTable.addEventListener('click', () => {
      vscode.postMessage({ type: 'createTable' });
    });
  }
  if (fmtSeparator) {
    fmtSeparator.addEventListener('click', () => {
      insertSeparator();
    });
  }
  fmtList.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectList' });
  });
  fmtTask.addEventListener('click', () => {
    smartTaskToggle();
  });
  fmtQuote.addEventListener('click', () => insertFormatting('> ', ''));
  if (fmtChart) {
    fmtChart.addEventListener('click', () => {
      const range = isCursorInMermaid();
      if (range) {
        toggleMermaidOrientationInWebview(range);
      } else {
        vscode.postMessage({ type: 'selectChart' });
      }
    });
  }
  fmtTime.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectTimestamp' });
  });

  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      insertFormatting('**', '**');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
      e.preventDefault();
      insertFormatting('*', '*');
    }
  });

  function switchTab(tab) {
    if (tab === activeTab) return;
    activeTab = tab;
    if (tab === 'edit') {
      if (formattingTools) formattingTools.style.display = 'flex';
      textarea.style.display = 'block';
      previewContainer.classList.remove('show');
      if (btnTogglePreview) {
        btnTogglePreview.setAttribute('data-tooltip', 'Open Preview');
        btnTogglePreview.innerHTML = `
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 3.5a5.5 5.5 0 0 0-4.95 3c.53.94 1.28 1.7 2.18 2.2l.6-.8A4.47 4.47 0 0 1 4.5 6.5c0-.85.34-1.63.9-2.2l.6.8a3.5 3.5 0 1 0 3.84-2.12c.54-.08 1.09-.08 1.63 0a4.5 4.5 0 1 1-5.97 3.32l-.6-.8A5.5 5.5 0 0 0 8 3.5zm0 2A1.5 1.5 0 1 0 8 8a1.5 1.5 0 0 0 0-3z"/>
          </svg>
        `;
      }
      textarea.focus();
    } else {
      if (formattingTools) formattingTools.style.display = 'none';
      textarea.style.display = 'none';
      previewContainer.classList.add('show');
      if (btnTogglePreview) {
        btnTogglePreview.setAttribute('data-tooltip', 'Open Editor');
        btnTogglePreview.innerHTML = `
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5L13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V12h2.293l6.5-6.5zm-9.171 7.17l-1.332.533.533-1.332L3.622 12.67z"/>
          </svg>
        `;
      }
      updatePreview();
    }
  }

  function updatePreview() {
    const md = textarea.value;
    previewContainer.innerHTML = renderMarkdown(md);
    
    const checkboxes = previewContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb, idx) => {
      cb.disabled = false;
      cb.addEventListener('change', () => {
        togglePreviewCheckbox(idx, cb.checked);
      });
    });
  }

  function togglePreviewCheckbox(checkboxIndex, isChecked) {
    let md = textarea.value;
    const lines = md.split('\n');
    let currentCheckboxIdx = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const taskMatch = line.match(/^(\s*[-*]\s+\[)([ xX])(\]\s+.+)$/);
      if (taskMatch) {
        if (currentCheckboxIdx === checkboxIndex) {
          const checkedChar = isChecked ? 'x' : ' ';
          lines[i] = taskMatch[1] + checkedChar + taskMatch[3];
          break;
        }
        currentCheckboxIdx++;
      }
    }
    
    textarea.value = lines.join('\n');
    updateStatusBar();
    
    vscode.postMessage({
      type: 'saveScratchpad',
      text: textarea.value
    });
    
    updatePreview();
  }

  function applyInlineFormatting(text) {
    let formatted = text;
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
    formatted = formatted.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\*([\s\S]+?)\*/g, '<em>$1</em>');
    formatted = formatted.replace(/_([\s\S]+?)_/g, '<em>$1</em>');
    formatted = formatted.replace(/==([^=]+)==/g, '<mark>$1</mark>');
    formatted = formatted.replace(/!\[([^\]]*)]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%; border-radius:6px; margin: 8px 0;">');
    formatted = formatted.replace(/\[([^\]]+)]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return formatted;
  }

  function renderMarkdown(md) {
    if (!md.trim()) return '<div class="preview-empty">Empty scratchpad</div>';
    
    // Escape HTML first
    let escaped = md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
      
    const lines = escaped.split('\n');
    const parsedLines = [];
    
    let inCodeBlock = false;
    let codeBlockLang = '';
    let codeBlockLines = [];
    
    let inList = false; // 'ul', 'ol', or false
    let inBlockquote = false;
    let inTable = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Handle Code Block start/end
      if (trimmed.startsWith('```')) {
        // Close other block elements first
        if (inList) { parsedLines.push('</' + inList + '>'); inList = false; }
        if (inBlockquote) { parsedLines.push('</blockquote>'); inBlockquote = false; }
        if (inTable) { parsedLines.push('</tbody></table>'); inTable = false; }
        
        if (inCodeBlock) {
          // End of code block
          inCodeBlock = false;
          parsedLines.push('<pre><code class="language-' + codeBlockLang + '">' + codeBlockLines.join('\n') + '</code></pre>');
        } else {
          // Start of code block
          inCodeBlock = true;
          codeBlockLang = trimmed.slice(3).trim() || 'text';
          codeBlockLines = [];
        }
        continue;
      }
      
      // If we are inside a code block, just collect the code line
      if (inCodeBlock) {
        codeBlockLines.push(line);
        continue;
      }
      
      // Table Row check (starts and ends with |)
      const isTableRow = trimmed.startsWith('|') && trimmed.endsWith('|');
      if (isTableRow) {
        if (inList) { parsedLines.push('</' + inList + '>'); inList = false; }
        if (inBlockquote) { parsedLines.push('</blockquote>'); inBlockquote = false; }
        
        const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
        
        if (!inTable) {
          // Check if the next line is a divider row (e.g. |---|)
          let isHeader = false;
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            if (nextLine.startsWith('|') && nextLine.endsWith('|')) {
              const dividerCells = nextLine.slice(1, -1).split('|').map(c => c.trim());
              if (dividerCells.length > 0 && dividerCells.every(c => /^:-{1,}:?|:-{1,}|-{1,}:?$/.test(c))) {
                isHeader = true;
              }
            }
          }
          
          if (isHeader) {
            inTable = true;
            parsedLines.push('<table><thead><tr>');
            cells.forEach(c => parsedLines.push('<th>' + applyInlineFormatting(c) + '</th>'));
            parsedLines.push('</tr></thead><tbody>');
            // Skip the divider row
            i++;
            continue;
          }
        } else {
          // In table body
          parsedLines.push('<tr>');
          cells.forEach(c => parsedLines.push('<td>' + applyInlineFormatting(c) + '</td>'));
          parsedLines.push('</tr>');
          continue;
        }
      }
      
      // Close table if not a table row
      if (inTable && !isTableRow) {
        parsedLines.push('</tbody></table>');
        inTable = false;
      }
      
      // Apply inline formatting to lines outside code blocks
      let formattedLine = applyInlineFormatting(line);
      
      // 0. Horizontal Rule Match
      if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
        if (inList) { parsedLines.push('</' + inList + '>'); inList = false; }
        if (inBlockquote) { parsedLines.push('</blockquote>'); inBlockquote = false; }
        parsedLines.push('<hr>');
        continue;
      }
      
      // 1. Heading Match
      const headerMatch = formattedLine.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        if (inList) { parsedLines.push('</' + inList + '>'); inList = false; }
        if (inBlockquote) { parsedLines.push('</blockquote>'); inBlockquote = false; }
        const level = headerMatch[1].length;
        parsedLines.push('<h' + level + '>' + headerMatch[2] + '</h' + level + '>');
        continue;
      }
      
      // 2. Task List Checkbox Match
      const taskMatch = formattedLine.match(/^(\s*[-*]\s+\[([ xX])\])\s+(.+)$/);
      if (taskMatch) {
        if (inList) { parsedLines.push('</' + inList + '>'); inList = false; }
        if (inBlockquote) { parsedLines.push('</blockquote>'); inBlockquote = false; }
        const checked = taskMatch[2].toLowerCase() === 'x';
        parsedLines.push('<div class="preview-task-item' + (checked ? ' checked' : '') + '">' +
          '<input type="checkbox" ' + (checked ? 'checked' : '') + '>' +
          '<span>' + taskMatch[3] + '</span>' +
        '</div>');
        continue;
      }
      
      // 3. Blockquote Match (line starts with &gt;)
      const bqMatch = formattedLine.match(/^(&gt;)\s*(.*)$/);
      if (bqMatch) {
        if (inList) { parsedLines.push('</' + inList + '>'); inList = false; }
        if (!inBlockquote) {
          parsedLines.push('<blockquote>');
          inBlockquote = true;
        }
        parsedLines.push('<p>' + (bqMatch[2] || '&nbsp;') + '</p>');
        continue;
      } else {
        if (inBlockquote) {
          parsedLines.push('</blockquote>');
          inBlockquote = false;
        }
      }
      
      // 4. Bullet List Match
      const bulletMatch = formattedLine.match(/^(\s*[-*+])\s+(.+)$/);
      if (bulletMatch) {
        if (inList !== 'ul') {
          if (inList) { parsedLines.push('</' + inList + '>'); }
          parsedLines.push('<ul>');
          inList = 'ul';
        }
        parsedLines.push('<li>' + bulletMatch[2] + '</li>');
        continue;
      }
      
      // 5. Numbered List Match
      const numberedMatch = formattedLine.match(/^(\s*\d+\.)\s+(.+)$/);
      if (numberedMatch) {
        if (inList !== 'ol') {
          if (inList) { parsedLines.push('</' + inList + '>'); }
          parsedLines.push('<ol>');
          inList = 'ol';
        }
        parsedLines.push('<li>' + numberedMatch[2] + '</li>');
        continue;
      }
      
      // Close list if line doesn't match bullet or numbered list
      if (inList) {
        parsedLines.push('</' + inList + '>');
        inList = false;
      }
      
      // 6. Regular Paragraph or line break
      if (trimmed === '') {
        parsedLines.push('<br>');
      } else {
        parsedLines.push('<p>' + formattedLine + '</p>');
      }
    }
    
    // Close any dangling blocks
    if (inCodeBlock) {
      parsedLines.push('<pre><code class="language-' + codeBlockLang + '">' + codeBlockLines.join('\n') + '</code></pre>');
    }
    if (inList) { parsedLines.push('</' + inList + '>'); }
    if (inBlockquote) { parsedLines.push('</blockquote>'); }
    if (inTable) { parsedLines.push('</tbody></table>'); }
    
    return parsedLines.join('\n');
  }

  function insertFormatting(prefix, suffix) {
    if (activeTab !== 'edit') return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    const selected = val.substring(start, end);
    
    const before = val.substring(0, start);
    const after = val.substring(end);
    
    let replacement = '';
    const lineStartPrefixes = ['- [ ] ', '# ', '## ', '### ', '> ', '- ', '1. '];
    
    if (lineStartPrefixes.includes(prefix)) {
      if (selected.length > 0) {
        const lines = selected.split('\n');
        let newText = '';
        if (prefix === '1. ') {
          newText = lines.map((line, idx) => `${idx + 1}. ${line}`).join('\n');
        } else {
          newText = lines.map(line => `${prefix}${line}${suffix}`).join('\n');
        }
        textarea.value = before + newText + after;
        textarea.selectionStart = start;
        textarea.selectionEnd = start + newText.length;
      } else {
        const lineStart = start === 0 ? 0 : before.lastIndexOf('\n') + 1;
        const lineBefore = val.substring(0, lineStart);
        const lineText = val.substring(lineStart, start);
        
        replacement = prefix + lineText;
        textarea.value = lineBefore + replacement + after;
        textarea.selectionStart = lineStart + prefix.length + lineText.length;
        textarea.selectionEnd = lineStart + prefix.length + lineText.length;
      }
    } else {
      replacement = prefix + selected + suffix;
      textarea.value = before + replacement + after;
      textarea.selectionStart = start + prefix.length;
      textarea.selectionEnd = start + prefix.length + selected.length;
    }
    
    textarea.focus();
    updateStatusBar();
    
    vscode.postMessage({
      type: 'saveScratchpad',
      text: textarea.value
    });
  }

  function smartTaskToggle() {
    if (activeTab !== 'edit') return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    
    if (start === end) {
      const lineStart = start === 0 ? 0 : val.substring(0, start).lastIndexOf('\n') + 1;
      let lineEnd = val.indexOf('\n', start);
      if (lineEnd === -1) lineEnd = val.length;
      
      const lineText = val.substring(lineStart, lineEnd);
      const checkboxRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ xX])\]/;
      const checkboxMatch = lineText.match(checkboxRegex);
      
      let newLineText = '';
      let newCursorOffset = 0;
      
      if (checkboxMatch) {
        const prefix = checkboxMatch[1] || '';
        const checkedChar = checkboxMatch[3];
        const newChecked = (checkedChar === ' ' ? 'x' : ' ');
        const replacement = `${prefix}[${newChecked}]`;
        newLineText = replacement + lineText.substring(checkboxMatch[0].length);
        newCursorOffset = replacement.length - checkboxMatch[0].length;
      } else {
        const listRegex = /^([ \t]*([-*+]\s+|\d+\.\s+))/;
        const listMatch = lineText.match(listRegex);
        if (listMatch) {
          const prefix = listMatch[1];
          newLineText = prefix + '[ ] ' + lineText.substring(prefix.length);
          newCursorOffset = 4;
        } else {
          const indentRegex = /^([ \t]*)/;
          const indentMatch = lineText.match(indentRegex);
          const indent = indentMatch ? indentMatch[1] : '';
          newLineText = indent + '- [ ] ' + lineText.substring(indent.length);
          newCursorOffset = 6;
        }
      }
      
      textarea.value = val.substring(0, lineStart) + newLineText + val.substring(lineEnd);
      const newPos = start + newCursorOffset;
      textarea.selectionStart = newPos;
      textarea.selectionEnd = newPos;
    } else {
      const lineStart = start === 0 ? 0 : val.substring(0, start).lastIndexOf('\n') + 1;
      let lineEnd = val.indexOf('\n', end);
      if (lineEnd === -1) lineEnd = val.length;
      
      const selectionText = val.substring(lineStart, lineEnd);
      const lines = selectionText.split('\n');
      
      let hasUnchecked = false;
      const checkboxRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ ])\]/;
      for (const line of lines) {
        if (checkboxRegex.test(line)) {
          hasUnchecked = true;
          break;
        }
      }
      
      const targetState = hasUnchecked ? 'x' : ' ';
      const newLines = lines.map(line => {
        const checkboxMatch = line.match(/^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ xX])\]/);
        if (checkboxMatch) {
          const prefix = checkboxMatch[1] || '';
          return `${prefix}[${targetState}]` + line.substring(checkboxMatch[0].length);
        }
        
        const listMatch = line.match(/^([ \t]*([-*+]\s+|\d+\.\s+))/);
        if (listMatch) {
          const prefix = listMatch[1];
          return `${prefix}[${targetState}] ` + line.substring(prefix.length);
        }
        
        return line;
      });
      
      const newSelectionText = newLines.join('\n');
      textarea.value = val.substring(0, lineStart) + newSelectionText + val.substring(lineEnd);
      textarea.selectionStart = lineStart;
      textarea.selectionEnd = lineStart + newSelectionText.length;
    }
    
    textarea.focus();
    updateStatusBar();
    
    vscode.postMessage({
      type: 'saveScratchpad',
      text: textarea.value
    });
  }

  function isCursorInMermaid() {
    const val = textarea.value;
    const start = textarea.selectionStart;
    
    const linesUpToCursor = val.substring(0, start).split('\n');
    const cursorLine = linesUpToCursor.length - 1;
    const lines = val.split('\n');
    
    let startLine = -1;
    let endLine = -1;
    
    for (let i = cursorLine; i >= 0; i--) {
      const text = lines[i].trim();
      if (text.startsWith('```mermaid')) {
        startLine = i;
        break;
      } else if (text.startsWith('```') && i !== cursorLine) {
        break;
      }
    }
    
    if (startLine !== -1) {
      for (let i = cursorLine; i < lines.length; i++) {
        if (lines[i].trim() === '```') {
          endLine = i;
          break;
        }
      }
    }
    
    if (startLine !== -1 && endLine !== -1) {
      return { startLine, endLine };
    }
    return null;
  }

  function toggleMermaidOrientationInWebview(range) {
    const val = textarea.value;
    const lines = val.split('\n');
    
    const blockLines = lines.slice(range.startLine, range.endLine + 1);
    const blockText = blockLines.join('\n');
    
    const regex = /^([ \t]*(?:graph|flowchart|direction)\s+)(TD|TB|LR|RL|BT)\b/im;
    const match = blockText.match(regex);
    
    if (match) {
      const map = {
        'TD': 'LR',
        'TB': 'LR',
        'LR': 'TD',
        'RL': 'BT',
        'BT': 'RL'
      };
      const newDir = map[match[2].toUpperCase()] || 'LR';
      const newBlockText = blockText.replace(regex, `$1${newDir}`);
      
      const prefixLength = lines.slice(0, range.startLine).join('\n').length + (range.startLine > 0 ? 1 : 0);
      const suffixStartLength = prefixLength + blockText.length;
      
      textarea.value = val.substring(0, prefixLength) + newBlockText + val.substring(suffixStartLength);
      textarea.selectionStart = prefixLength;
      textarea.selectionEnd = prefixLength + newBlockText.length;
      
      textarea.focus();
      updateStatusBar();
      
      vscode.postMessage({
        type: 'saveScratchpad',
        text: textarea.value
      });
      if (activeTab === 'preview') {
        updatePreview();
      }
    }
  }

  function insertChartMarkdown(chartMd) {
    if (activeTab !== 'edit') return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    
    const before = val.substring(0, start);
    const after = val.substring(end);
    
    let insertText = chartMd;
    
    if (start > 0 && !before.endsWith('\n')) {
      insertText = '\n' + insertText;
    }
    if (after.length > 0 && !after.startsWith('\n')) {
      insertText = insertText + '\n';
    }
    
    textarea.value = before + insertText + after;
    
    const newCursorPos = start + insertText.length;
    textarea.selectionStart = newCursorPos;
    textarea.selectionEnd = newCursorPos;
    
    textarea.focus();
    updateStatusBar();
    
    vscode.postMessage({
      type: 'saveScratchpad',
      text: textarea.value
    });
  }

  function insertTableMarkdown(tableMd) {
    if (activeTab !== 'edit') return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    
    const before = val.substring(0, start);
    const after = val.substring(end);
    
    let insertText = tableMd;
    
    // Check if we need a leading newline to start on a new block line
    if (start > 0 && !before.endsWith('\n')) {
      insertText = '\n' + insertText;
    }
    
    // Check if we need a trailing newline so subsequent text is on a new block line
    if (after.length > 0 && !after.startsWith('\n')) {
      insertText = insertText + '\n';
    }
    
    textarea.value = before + insertText + after;
    
    // Put cursor at the end of the inserted table
    const newCursorPos = start + insertText.length;
    textarea.selectionStart = newCursorPos;
    textarea.selectionEnd = newCursorPos;
    
    textarea.focus();
    updateStatusBar();
    
    vscode.postMessage({
      type: 'saveScratchpad',
      text: textarea.value
    });
  }

  function insertSeparator() {
    if (activeTab !== 'edit') return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    
    const before = val.substring(0, start);
    const after = val.substring(end);
    
    let insertText = '---';
    
    // Check if we need a leading newline to start on a new block line
    if (start > 0 && !before.endsWith('\n')) {
      insertText = '\n' + insertText;
    }
    
    // Check if we need a trailing newline so subsequent text is on a new block line
    if (after.length > 0 && !after.startsWith('\n')) {
      insertText = insertText + '\n';
    } else {
      insertText = insertText + '\n';
    }
    
    textarea.value = before + insertText + after;
    
    const newCursorPos = start + insertText.length;
    textarea.selectionStart = newCursorPos;
    textarea.selectionEnd = newCursorPos;
    
    textarea.focus();
    updateStatusBar();
    
    vscode.postMessage({
      type: 'saveScratchpad',
      text: textarea.value
    });
  }

  function openHistory() {
    historyOverlay.classList.add('show');
    historyResults.innerHTML = '<div class="picker-status">Loading history...</div>';
    vscode.postMessage({ type: 'getHistory' });
  }

  function closeHistory() {
    historyOverlay.classList.remove('show');
    if (activeTab === 'edit') {
      textarea.focus();
    }
  }

  function renderHistory() {
    historyResults.innerHTML = '';
    if (historyList.length === 0) {
      const status = document.createElement('div');
      status.className = 'picker-status';
      status.textContent = 'No history available';
      historyResults.appendChild(status);
      return;
    }

    historyList.forEach((text) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      
      const header = document.createElement('div');
      header.className = 'history-item-header';
      
      const timestamp = document.createElement('span');
      const tagMatches = text.match(/#(\w+)/g);
      timestamp.textContent = tagMatches ? tagMatches.slice(0, 3).join(' ') : 'Note Draft';
      
      const actionSpan = document.createElement('span');
      actionSpan.className = 'undo-link';
      actionSpan.textContent = 'Restore';
      
      header.appendChild(timestamp);
      header.appendChild(actionSpan);
      item.appendChild(header);
      
      const textSpan = document.createElement('span');
      textSpan.textContent = text;
      item.appendChild(textSpan);
      
      item.addEventListener('click', () => {
        restoreHistoryItem(text);
      });
      
      historyResults.appendChild(item);
    });
  }

  function restoreHistoryItem(text) {
    textarea.value = text;
    updateStatusBar();
    
    vscode.postMessage({
      type: 'saveScratchpad',
      text: text
    });
    
    if (activeTab === 'preview') {
      updatePreview();
    }
    
    closeHistory();
  }

  undoLink.addEventListener('click', () => {
    if (textarea.disabled) return;
    if (preClearText) {
      textarea.value = preClearText;
      updateStatusBar();
      vscode.postMessage({
        type: 'saveScratchpad',
        text: preClearText
      });
      preClearText = '';
      hideToast();
    }
  });

  function setWorkspaceState(hasWorkspace) {
    hasWorkspaceActive = hasWorkspace;
    if (hasWorkspace) {
      textarea.disabled = false;
      textarea.placeholder = "Type quick notes here... Use buttons below to save or clear them.";
      updateButtonStates();
    } else {
      textarea.value = '';
      textarea.disabled = true;
      textarea.placeholder = "Please open a folder to start taking quick notes.";
      btnClear.disabled = true;
      btnConvert.disabled = true;
      btnAppendTo.disabled = true;
      btnAppendActive.disabled = true;
      btnDaily.disabled = true;
      closePicker();
      closeHistory();
    }
  }

  function updateStatusBar() {
    updateButtonStates();
  }

  function updateButtonStates() {
    if (!hasWorkspaceActive) return;
    const isEmpty = !textarea.value.trim();
    btnClear.disabled = isEmpty;
    btnConvert.disabled = isEmpty;
    btnAppendTo.disabled = isEmpty;
    btnAppendActive.disabled = isEmpty;
    btnDaily.disabled = isEmpty;
  }

  function showToast() {
    if (toastTimeout) clearTimeout(toastTimeout);
    undoToast.classList.add('show');
    toastTimeout = setTimeout(() => {
      hideToast();
    }, 5000);
  }

  function hideToast() {
    undoToast.classList.remove('show');
    preClearText = '';
  }
})();

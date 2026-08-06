import * as vscode from 'vscode';

async function insertFormat(
  prefix: string,
  suffix: string,
  placeholder: string,
  blockMode: boolean = false,
  numberedList: boolean = false
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const document = editor.document;
  const selection = editor.selection;
  const selectedText = document.getText(selection);

  if (selectedText.length > 0) {
    if (blockMode) {
      const lines = selectedText.split(/\r?\n/);
      let newText = '';
      if (numberedList) {
        newText = lines.map((line, idx) => `${idx + 1}. ${line}`).join('\n');
      } else {
        newText = lines.map((line) => `${prefix}${line}${suffix}`).join('\n');
      }
      await editor.edit((editBuilder) => {
        editBuilder.replace(selection, newText);
      });
    } else {
      const newText = `${prefix}${selectedText}${suffix}`;
      await editor.edit((editBuilder) => {
        editBuilder.replace(selection, newText);
      });
    }
  } else {
    // Insert template and select the placeholder
    const textToInsert = `${prefix}${placeholder}${suffix}`;
    
    // We store the active position before editing
    const activePos = selection.active;
    
    const editSuccess = await editor.edit((editBuilder) => {
      editBuilder.insert(activePos, textToInsert);
    });

    if (editSuccess) {
      // Calculate selection range for the placeholder
      const prefixLines = prefix.split('\n');
      const placeholderLines = placeholder.split('\n');
      
      const startLine = activePos.line + prefixLines.length - 1;
      const startChar = prefixLines.length > 1
        ? prefixLines[prefixLines.length - 1].length
        : activePos.character + prefix.length;
        
      const endLine = startLine + placeholderLines.length - 1;
      const endChar = placeholderLines.length > 1
        ? placeholderLines[placeholderLines.length - 1].length
        : startChar + placeholder.length;

      const newSelection = new vscode.Selection(
        new vscode.Position(startLine, startChar),
        new vscode.Position(endLine, endChar)
      );
      editor.selection = newSelection;
    }
  }
}
async function toggleMermaidOrientation(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const document = editor.document;
  let selection = editor.selection;

  if (selection.isEmpty) {
    const cursorLine = selection.active.line;
    let startLine = -1;
    let endLine = -1;

    for (let i = cursorLine; i >= 0; i--) {
      const text = document.lineAt(i).text.trim();
      if (text.startsWith('```mermaid')) {
        startLine = i;
        break;
      } else if (text.startsWith('```') && i !== cursorLine) {
        break;
      }
    }

    if (startLine !== -1) {
      for (let i = cursorLine; i < document.lineCount; i++) {
        if (document.lineAt(i).text.trim() === '```') {
          endLine = i;
          break;
        }
      }
    }

    if (startLine !== -1 && endLine !== -1) {
      selection = new vscode.Selection(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, document.lineAt(endLine).text.length)
      );
    } else {
      selection = new vscode.Selection(
        new vscode.Position(cursorLine, 0),
        new vscode.Position(cursorLine, document.lineAt(cursorLine).text.length)
      );
    }
  }

  const text = document.getText(selection);
  const regex = /^([ \t]*(?:graph|flowchart|direction)\s+)(TD|TB|LR|RL|BT)\b/im;
  
  const match = text.match(regex);
  if (match) {
    const map: Record<string, string> = {
      'TD': 'LR',
      'TB': 'LR',
      'LR': 'TD',
      'RL': 'BT',
      'BT': 'RL'
    };
    const newDir = map[match[2].toUpperCase()] || 'LR';
    const newText = text.replace(regex, `$1${newDir}`);
    await editor.edit(builder => {
      builder.replace(selection, newText);
    });
  } else {
    vscode.window.showWarningMessage("No mermaid orientation (e.g. 'graph TD', 'direction LR') found in selection.");
  }
}

async function toggleTask(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const document = editor.document;
  const selection = editor.selection;

  if (selection.isEmpty) {
    // Single line toggle behavior
    const lineIdx = selection.active.line;
    const line = document.lineAt(lineIdx);
    const text = line.text;

    const checkboxRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ xX])\]/;
    const checkboxMatch = text.match(checkboxRegex);

    if (checkboxMatch) {
      const prefix = checkboxMatch[1] || '';
      const checkedChar = checkboxMatch[3];
      const newChecked = (checkedChar === ' ' ? 'x' : ' ');
      const replacement = `${prefix}[${newChecked}]`;
      await editor.edit((editBuilder) => {
        editBuilder.replace(new vscode.Range(new vscode.Position(lineIdx, 0), new vscode.Position(lineIdx, checkboxMatch[0].length)), replacement);
      });
    } else {
      const listRegex = /^([ \t]*([-*+]\s+|\d+\.\s+))/;
      const listMatch = text.match(listRegex);

      if (listMatch) {
        const prefix = listMatch[1];
        await editor.edit((editBuilder) => {
          editBuilder.replace(new vscode.Range(new vscode.Position(lineIdx, 0), new vscode.Position(lineIdx, prefix.length)), `${prefix}[ ] `);
        });
      } else {
        const indentRegex = /^([ \t]*)/;
        const indentMatch = text.match(indentRegex);
        const indent = indentMatch ? indentMatch[1] : '';
        await editor.edit((editBuilder) => {
          editBuilder.replace(new vscode.Range(new vscode.Position(lineIdx, 0), new vscode.Position(lineIdx, indent.length)), `${indent}- [ ] `);
        });
      }
    }
  } else {
    // Multi-line selection collective toggle
    const startLine = selection.start.line;
    const endLine = selection.end.line;
    const edits: { range: vscode.Range; newText: string }[] = [];

    let hasUnchecked = false;
    for (let i = startLine; i <= endLine; i++) {
      const text = document.lineAt(i).text;
      const checkboxRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ ])\]/;
      if (checkboxRegex.test(text)) {
        hasUnchecked = true;
        break;
      }
    }

    const targetState = hasUnchecked ? 'x' : ' ';

    for (let i = startLine; i <= endLine; i++) {
      const line = document.lineAt(i);
      const text = line.text;

      const checkboxRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ xX])\]/;
      const checkboxMatch = text.match(checkboxRegex);

      if (checkboxMatch) {
        const prefix = checkboxMatch[1] || '';
        const replacement = `${prefix}[${targetState}]`;
        edits.push({
          range: new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i, checkboxMatch[0].length)),
          newText: replacement
        });
      } else {
        const listRegex = /^([ \t]*([-*+]\s+|\d+\.\s+))/;
        const listMatch = text.match(listRegex);
        if (listMatch) {
          const prefix = listMatch[1];
          const replacement = `${prefix}[${targetState}] `;
          edits.push({
            range: new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i, prefix.length)),
            newText: replacement
          });
        }
      }
    }

    if (edits.length > 0) {
      await editor.edit((editBuilder) => {
        for (const edit of edits) {
          editBuilder.replace(edit.range, edit.newText);
        }
      });
    }
  }
}

export function getTimestampChoices(): { label: string; description: string; format: string }[] {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = now.getHours(); // no leading 0
  const minutes = pad(now.getMinutes());

  const standard = `${year}-${month}-${day} ${hours}:${minutes}`;
  const longDate = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const longDateTime = `${longDate} ${hours}:${minutes}`;
  const dateOnly = `${year}-${month}-${day}`;
  const timeOnly = `${hours}:${minutes}`;

  return [
    { label: standard, description: 'Standard Date & Time', format: standard },
    { label: longDate, description: 'Long Readable Date', format: longDate },
    { label: longDateTime, description: 'Long Readable Date & Time', format: longDateTime },
    { label: dateOnly, description: 'Standard Date Only', format: dateOnly },
    { label: timeOnly, description: 'Standard Time Only', format: timeOnly }
  ];
}

export function registerInsertCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.insert.bold', () =>
      insertFormat('**', '**', 'bold text')
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.italic', () =>
      insertFormat('*', '*', 'italic text')
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.heading', async () => {
      const choices = [
        { label: '$(list-ordered) Header (Heading 1)', format: '# ' },
        { label: '$(list-ordered) Subheader (Heading 2)', format: '## ' },
        { label: '$(list-ordered) Section Header (Heading 3)', format: '### ' }
      ];
      const choice = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select Heading Level'
      });
      if (choice !== undefined) {
        await insertFormat(choice.format, '', 'Heading', true);
      }
    }),
    vscode.commands.registerCommand('markdownNotebook.insert.list', async () => {
      const choices = [
        { label: '$(list-unordered) Bulleted List', prefix: '- ' },
        { label: '$(list-ordered) Numbered List', prefix: '1. ' }
      ];
      const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select List Type'
      });
      if (picked) {
        if (picked.prefix === '1. ') {
          await insertFormat('1. ', '', 'List Item', true, true);
        } else {
          await insertFormat('- ', '', 'List Item', true);
        }
      }
    }),
    vscode.commands.registerCommand('markdownNotebook.insert.taskList', () =>
      toggleTask()
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.toggleTask', () =>
      toggleTask()
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.chart', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const document = editor.document;
      const selection = editor.selection;

      let isInsideMermaid = false;
      const cursorLine = selection.active.line;
      let startLine = -1;
      let endLine = -1;

      for (let i = cursorLine; i >= 0; i--) {
        const text = document.lineAt(i).text.trim();
        if (text.startsWith('```mermaid')) {
          startLine = i;
          break;
        } else if (text.startsWith('```') && i !== cursorLine) {
          break;
        }
      }
      if (startLine !== -1) {
        for (let i = cursorLine; i < document.lineCount; i++) {
          if (document.lineAt(i).text.trim() === '```') {
            endLine = i;
            break;
          }
        }
        if (endLine !== -1) {
          isInsideMermaid = true;
        }
      }

      if (!isInsideMermaid && !selection.isEmpty) {
        const selectedText = document.getText(selection);
        if (selectedText.includes('```mermaid')) {
          isInsideMermaid = true;
        }
      }

      if (isInsideMermaid) {
        await toggleMermaidOrientation();
      } else {
        const choices = [
          { label: '$(organization) Flowchart', detail: 'A flowchart diagram (TD/LR orientation)', template: '```mermaid\nflowchart TD\n    A[Start] --> B(Process)\n    B --> C{Decision}\n    C -- Yes --> D[Result 1]\n    C -- No --> E[Result 2]\n```\n' },
          { label: '$(play) Sequence Diagram', detail: 'Interaction sequence diagram between actors', template: '```mermaid\nsequenceDiagram\n    Alice->>Bob: Hello Bob, how are you?\n    Bob-->>Alice: Jolly good!\n```\n' },
          { label: '$(calendar) Gantt Chart', detail: 'A gantt chart timeline', template: '```mermaid\ngantt\n    title A Gantt Chart\n    dateFormat YYYY-MM-DD\n    section Section\n    A task :a1, 2026-06-24, 30d\n    Another task :after a1, 20d\n```\n' },
          { label: '$(pie-chart) Pie Chart', detail: 'A percentage-based pie chart', template: '```mermaid\npie title Pets adopted by volunteers\n    "Dogs" : 386\n    "Cats" : 85\n    "Rats" : 15\n```\n' },
          { label: '$(symbol-class) Class Diagram', detail: 'Object-oriented class structure diagram', template: '```mermaid\nclassDiagram\n    Class01 <|-- Class02\n    Class03 *-- Class04\n    Class01 : size\n    Class01 : method()\n```\n' }
        ];

        const picked = await vscode.window.showQuickPick(choices, {
          placeHolder: 'Select Diagram Type to Insert'
        });

        if (picked) {
          const start = selection.start;
          let prefix = '';
          const activeLineText = document.lineAt(start.line).text;
          const isStartOfLine = start.character === 0;
          const isEmptyLine = activeLineText.trim() === '';

          if (!isStartOfLine && !isEmptyLine) {
            prefix = '\n';
          }
          await insertFormat(prefix, '', picked.template, false);
        }
      }
    }),
    vscode.commands.registerCommand('markdownNotebook.insert.toggleMermaidOrientation', () =>
      toggleMermaidOrientation()
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.codeBlock', async () => {
      const choices = [
        { label: '$(terminal) Inline Code (Default)', id: 'inline' },
        { label: '$(circle-outline) Plain Text Code Block', id: '' },
        { label: '$(symbol-method) Apex', id: 'apex' },
        { label: '$(file-binary) Assembly / ASM', id: 'asm' },
        { label: '$(globe) Astro', id: 'astro' },
        { label: '$(terminal) AWK', id: 'awk' },
        { label: '$(terminal) Bash / Shell', id: 'bash' },
        { label: '$(terminal) Batch / CMD', id: 'bat' },
        { label: '$(symbol-keyword) C', id: 'c' },
        { label: '$(symbol-keyword) C++', id: 'cpp' },
        { label: '$(symbol-keyword) C#', id: 'csharp' },
        { label: '$(symbol-keyword) Clojure', id: 'clojure' },
        { label: '$(tools) CMake', id: 'cmake' },
        { label: '$(symbol-keyword) COBOL', id: 'cobol' },
        { label: '$(symbol-keyword) CSS', id: 'css' },
        { label: '$(symbol-keyword) Dart', id: 'dart' },
        { label: '$(diff) Diff', id: 'diff' },
        { label: '$(file-binary) Dockerfile', id: 'dockerfile' },
        { label: '$(symbol-keyword) Elixir', id: 'elixir' },
        { label: '$(symbol-keyword) Erlang', id: 'erlang' },
        { label: '$(symbol-keyword) F#', id: 'fsharp' },
        { label: '$(symbol-keyword) Fortran', id: 'fortran' },
        { label: '$(symbol-keyword) Go', id: 'go' },
        { label: '$(tools) Gradle', id: 'gradle' },
        { label: '$(symbol-interface) GraphQL', id: 'graphql' },
        { label: '$(symbol-keyword) Groovy', id: 'groovy' },
        { label: '$(symbol-keyword) HTML', id: 'html' },
        { label: '$(symbol-keyword) Haskell', id: 'haskell' },
        { label: '$(symbol-object) INI Configuration', id: 'ini' },
        { label: '$(symbol-keyword) Java', id: 'java' },
        { label: '$(symbol-keyword) JavaScript', id: 'javascript' },
        { label: '$(symbol-object) JSON', id: 'json' },
        { label: '$(symbol-object) JSON5', id: 'json5' },
        { label: '$(symbol-keyword) Julia', id: 'julia' },
        { label: '$(symbol-keyword) Kotlin', id: 'kotlin' },
        { label: '$(file-text) LaTeX', id: 'latex' },
        { label: '$(symbol-keyword) Less CSS', id: 'less' },
        { label: '$(symbol-keyword) Lisp', id: 'lisp' },
        { label: '$(symbol-keyword) Lua', id: 'lua' },
        { label: '$(tools) Makefile', id: 'makefile' },
        { label: '$(file-text) Markdown', id: 'markdown' },
        { label: '$(symbol-keyword) MATLAB', id: 'matlab' },
        { label: '$(graph) Mermaid', id: 'mermaid' },
        { label: '$(server) Nginx Config', id: 'nginx' },
        { label: '$(symbol-keyword) Objective-C', id: 'objc' },
        { label: '$(symbol-keyword) OCaml', id: 'ocaml' },
        { label: '$(symbol-keyword) Perl', id: 'perl' },
        { label: '$(symbol-keyword) PHP', id: 'php' },
        { label: '$(database) PL/SQL', id: 'plsql' },
        { label: '$(terminal) PowerShell', id: 'powershell' },
        { label: '$(database) Prisma Schema', id: 'prisma' },
        { label: '$(symbol-object) Properties File', id: 'properties' },
        { label: '$(symbol-object) Protocol Buffers', id: 'proto' },
        { label: '$(symbol-keyword) Python', id: 'python' },
        { label: '$(symbol-keyword) R', id: 'r' },
        { label: '$(symbol-keyword) Ruby', id: 'ruby' },
        { label: '$(symbol-keyword) Rust', id: 'rust' },
        { label: '$(symbol-keyword) SAS', id: 'sas' },
        { label: '$(symbol-keyword) Scala', id: 'scala' },
        { label: '$(symbol-keyword) Scheme', id: 'scheme' },
        { label: '$(symbol-keyword) SCSS', id: 'scss' },
        { label: '$(symbol-keyword) Shader / GLSL', id: 'glsl' },
        { label: '$(symbol-keyword) Solidity', id: 'solidity' },
        { label: '$(database) SQL', id: 'sql' },
        { label: '$(globe) Svelte', id: 'svelte' },
        { label: '$(symbol-keyword) Swift', id: 'swift' },
        { label: '$(symbol-keyword) SystemVerilog', id: 'systemverilog' },
        { label: '$(symbol-object) TOML', id: 'toml' },
        { label: '$(symbol-keyword) TypeScript', id: 'typescript' },
        { label: '$(symbol-keyword) Visual Basic', id: 'vb' },
        { label: '$(globe) Vue', id: 'vue' },
        { label: '$(file-binary) WebAssembly', id: 'wasm' },
        { label: '$(code) XML', id: 'xml' },
        { label: '$(symbol-object) YAML', id: 'yaml' },
        { label: '$(symbol-keyword) Zig', id: 'zig' }
      ];


      const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select programming language for syntax highlighting'
      });

      if (picked === undefined) {
        return; // cancelled
      }

      if (picked.id === 'inline') {
        await insertFormat('`', '`', 'code');
      } else {
        await insertFormat(`\n\`\`\`${picked.id}\n`, '\n\`\`\`\n', 'code');
      }
    }),
    vscode.commands.registerCommand('markdownNotebook.insert.blockquote', () =>
      insertFormat('> ', '', 'quote', true)
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.time', async () => {
      const choices = getTimestampChoices();
      const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select date/time format'
      });
      if (picked) {
        await insertFormat(picked.format, '', '');
      }
    }),
    vscode.commands.registerCommand('markdownNotebook.insert.table', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const colsInput = await vscode.window.showInputBox({
        prompt: 'Enter number of columns for the table',
        value: '3',
        validateInput: (val) => {
          const num = Number(val);
          if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
            return 'Please enter a positive integer.';
          }
          if (num > 20) {
            return 'Maximum columns is 20.';
          }
          return null;
        }
      });

      if (colsInput === undefined) { return; }
      const cols = parseInt(colsInput, 10) || 3;

      const rowsInput = await vscode.window.showInputBox({
        prompt: 'Enter number of data rows for the table',
        value: '2',
        validateInput: (val) => {
          const num = Number(val);
          if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
            return 'Please enter a positive integer.';
          }
          if (num > 100) {
            return 'Maximum rows is 100.';
          }
          return null;
        }
      });
      if (rowsInput === undefined) { return; }
      const rows = parseInt(rowsInput, 10) || 2;

      let tableMd = '|';
      for (let c = 1; c <= cols; c++) {
        tableMd += ' H |';
      }
      tableMd += '\n|';
      for (let c = 1; c <= cols; c++) {
        tableMd += ' --- |';
      }
      for (let r = 1; r <= rows; r++) {
        tableMd += '\n|';
        for (let c = 1; c <= cols; c++) {
          tableMd += ' C |';
        }
      }
      tableMd += '\n';

      const selection = editor.selection;
      const start = selection.start;
      const document = editor.document;
      
      let prefix = '';
      const activeLineText = document.lineAt(start.line).text;
      const isStartOfLine = start.character === 0;
      const isEmptyLine = activeLineText.trim() === '';
      
      if (!isStartOfLine && !isEmptyLine) {
        prefix = '\n';
      }

      await insertFormat(prefix, '', tableMd, false);
    }),
    vscode.commands.registerCommand('markdownNotebook.insert.separator', () =>
      insertFormat('\n---\n', '', '')
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.formatMenu', async () => {
      const formatChoices = [
        { label: '$(bold) Bold', detail: 'Wrap text in asterisks (e.g. **bold**)', command: 'markdownNotebook.insert.bold' },
        { label: '$(italic) Italic', detail: 'Wrap text in single asterisks (e.g. *italic*)', command: 'markdownNotebook.insert.italic' },
        { label: '$(list-ordered) Heading...', detail: 'Insert Heading Level 1, 2, or 3', command: 'markdownNotebook.insert.heading' },
        { label: '$(list-unordered) Lists (Bulleted / Numbered)...', detail: 'Insert a Bulleted or Numbered List', command: 'markdownNotebook.insert.list' },
        { label: '$(checklist) Task (Add / Toggle)', detail: 'Add task checkbox or check/uncheck selected tasks (cmd+alt+x)', command: 'markdownNotebook.insert.toggleTask' },
        { label: '$(code) Code (Inline / Block)...', detail: 'Insert Inline Code or fenced Code Block with language picker', command: 'markdownNotebook.insert.codeBlock' },
        { label: '$(table) Table...', detail: 'Insert a custom markdown table (columns & rows prompt)', command: 'markdownNotebook.insert.table' },
        { label: '$(organization) Diagram / Chart...', detail: 'Insert or toggle Mermaid diagrams (flowchart, sequence, etc.)', command: 'markdownNotebook.insert.chart' },
        { label: '$(arrow-swap) Toggle Mermaid Orientation', detail: 'Toggle Mermaid block orientation (e.g. TD to LR)', command: 'markdownNotebook.insert.toggleMermaidOrientation' },
        { label: '$(horizontal-rule) Insert Separator', detail: 'Insert a horizontal rule separator (---)', command: 'markdownNotebook.insert.separator' },
        { label: '$(quote) Blockquote', detail: 'Prefix lines with blockquote (> )', command: 'markdownNotebook.insert.blockquote' },
        { label: '$(watch) Insert Timestamp...', detail: 'Insert parsed timestamp in date/time format picker', command: 'markdownNotebook.insert.time' }
      ];

      const picked = await vscode.window.showQuickPick(formatChoices, {
        placeHolder: 'Select a Markdown formatting option to insert'
      });

      if (picked) {
        vscode.commands.executeCommand(picked.command);
      }
    })
  );
}

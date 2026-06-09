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

  const startLine = selection.start.line;
  const endLine = selection.end.line;

  const edits: { range: vscode.Range; newText: string }[] = [];

  for (let lineIdx = startLine; lineIdx <= endLine; lineIdx++) {
    const line = document.lineAt(lineIdx);
    const text = line.text;

    // Pattern 1: Checkbox exists (e.g. "- [ ] item" or "- [x] item" or "1. [ ] item" or even just "[ ] item")
    const checkboxRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ xX])\]/;
    const checkboxMatch = text.match(checkboxRegex);

    if (checkboxMatch) {
      const prefix = checkboxMatch[1] || ''; // prefix including list marker and spaces
      const checkedChar = checkboxMatch[3]; // ' ', 'x', 'X'
      const startChar = 0;
      const endChar = checkboxMatch[0].length; // length of entire prefix + checkbox
      
      const newChecked = (checkedChar === ' ' ? 'x' : ' ');
      const replacement = `${prefix}[${newChecked}]`;
      
      edits.push({
        range: new vscode.Range(new vscode.Position(lineIdx, startChar), new vscode.Position(lineIdx, endChar)),
        newText: replacement
      });
    } else {
      // Pattern 2: List item exists but has no checkbox (e.g. "- item" or "1. item")
      const listRegex = /^([ \t]*([-*+]\s+|\d+\.\s+))/;
      const listMatch = text.match(listRegex);

      if (listMatch) {
        // Insert [ ] right after the list marker
        const prefix = listMatch[1];
        const startChar = 0;
        const endChar = prefix.length;
        const replacement = `${prefix}[ ] `;
        edits.push({
          range: new vscode.Range(new vscode.Position(lineIdx, startChar), new vscode.Position(lineIdx, endChar)),
          newText: replacement
        });
      } else {
        // Pattern 3: No list marker and no checkbox. Prepend "- [ ] "
        const indentRegex = /^([ \t]*)/;
        const indentMatch = text.match(indentRegex);
        const indent = indentMatch ? indentMatch[1] : '';
        
        const startChar = 0;
        const endChar = indent.length;
        const replacement = `${indent}- [ ] `;
        edits.push({
          range: new vscode.Range(new vscode.Position(lineIdx, startChar), new vscode.Position(lineIdx, endChar)),
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
    await document.save();
  }
}

export function registerInsertCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.insert.bold', () =>
      insertFormat('**', '**', 'bold text')
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.italic', () =>
      insertFormat('*', '*', 'italic text')
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.h1', () =>
      insertFormat('# ', '', 'Heading 1', true)
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.h2', () =>
      insertFormat('## ', '', 'Heading 2', true)
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.h3', () =>
      insertFormat('### ', '', 'Heading 3', true)
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.bulletList', () =>
      insertFormat('- ', '', 'List Item', true)
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.numberedList', () =>
      insertFormat('1. ', '', 'List Item', true, true)
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.taskList', () =>
      insertFormat('- [ ] ', '', 'Task Item', true)
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.toggleTask', () =>
      toggleTask()
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.toggleMermaidOrientation', () =>
      toggleMermaidOrientation()
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.codeBlock', async () => {
      const choices = [
        { label: '$(circle-outline) Plain Text', id: '' },
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

      const lang = picked.id;
      await insertFormat(`\n\`\`\`${lang}\n`, '\n\`\`\`\n', 'code');
    }),
    vscode.commands.registerCommand('markdownNotebook.insert.table', () =>
      insertFormat(
        '',
        '',
        '| Header 1 | Header 2 |\n| -------- | -------- |\n| Cell 1   | Cell 2   |'
      )
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.separator', () =>
      insertFormat('\n---\n', '', '')
    ),
    vscode.commands.registerCommand('markdownNotebook.insert.formatMenu', async () => {
      const formatChoices = [
        { label: '$(bold) Bold', detail: 'Wrap text in asterisks (e.g. **bold**)', command: 'markdownNotebook.insert.bold' },
        { label: '$(italic) Italic', detail: 'Wrap text in single asterisks (e.g. *italic*)', command: 'markdownNotebook.insert.italic' },
        { label: '$(list-ordered) Heading 1', detail: 'Insert Heading Level 1', command: 'markdownNotebook.insert.h1' },
        { label: '$(list-ordered) Heading 2', detail: 'Insert Heading Level 2', command: 'markdownNotebook.insert.h2' },
        { label: '$(list-ordered) Heading 3', detail: 'Insert Heading Level 3', command: 'markdownNotebook.insert.h3' },
        { label: '$(list-unordered) Bulleted List', detail: 'Prefix lines with bullet (- )', command: 'markdownNotebook.insert.bulletList' },
        { label: '$(list-ordered) Numbered List', detail: 'Prefix lines with sequential numbers (1. )', command: 'markdownNotebook.insert.numberedList' },
        { label: '$(checklist) Task List Item', detail: 'Prefix lines with a checkbox (- [ ])', command: 'markdownNotebook.insert.taskList' },
        { label: '$(check) Check/Uncheck Task', detail: 'Toggle checklist checkbox state (cmd+alt+c)', command: 'markdownNotebook.insert.toggleTask' },
        { label: '$(code) Code Block...', detail: 'Wrap in code fences with language highlight picker', command: 'markdownNotebook.insert.codeBlock' },
        { label: '$(table) Table', detail: 'Insert a standard 2x2 markdown table', command: 'markdownNotebook.insert.table' },
        { label: '$(arrow-swap) Toggle Mermaid Orientation', detail: 'Toggle Mermaid block orientation (e.g. TD to LR)', command: 'markdownNotebook.insert.toggleMermaidOrientation' },
        { label: '$(horizontal-rule) Insert Separator', detail: 'Insert a horizontal rule separator (---)', command: 'markdownNotebook.insert.separator' }
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

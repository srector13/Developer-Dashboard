import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class OutlineNode extends vscode.TreeItem {
  public children: OutlineNode[] = [];
  public parent: OutlineNode | undefined = undefined;

  constructor(
    public readonly label: string,
    public readonly depth: number,
    public readonly line: number,
    collapsibleState: vscode.TreeItemCollapsibleState,
    collapseVersion: number = 0
  ) {
    super(label, collapsibleState);
    this.command = {
      command: 'markdownNotebook.outline.goToLine',
      title: 'Go to Heading',
      arguments: [line]
    };
    this.iconPath = new vscode.ThemeIcon(
      depth === 1 ? 'bookmark' : depth === 2 ? 'circle-outline' : 'circle-filled'
    );
    this.contextValue = 'outlineItem';
    this.id = `${line}-${depth}-${collapseVersion}`;
  }
}

export class OutlineTreeDataProvider implements vscode.TreeDataProvider<OutlineNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<OutlineNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNodes: OutlineNode[] = [];
  public currentUri: vscode.Uri | undefined = undefined;
  public collapseVersion = 0;
  public activeHeadingLine: number | undefined = undefined;
  private defaultCollapsibleState = vscode.TreeItemCollapsibleState.Expanded;

  constructor() {}

  refresh(): void {
    this.buildOutline();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: OutlineNode): vscode.TreeItem {
    if (element.line === this.activeHeadingLine) {
      element.description = '• active';
      element.iconPath = new vscode.ThemeIcon('circle-filled');
    } else {
      element.description = undefined;
      element.iconPath = new vscode.ThemeIcon(
        element.depth === 1 ? 'bookmark' : element.depth === 2 ? 'circle-outline' : 'circle-filled'
      );
    }
    return element;
  }

  async getChildren(element?: OutlineNode): Promise<OutlineNode[]> {
    if (element) {
      return element.children;
    }
    if (this.rootNodes.length === 0) {
      this.buildOutline();
    }
    return this.rootNodes;
  }

  private buildOutline(): OutlineNode[] {
    const editor = vscode.window.activeTextEditor;
    let text = '';
    let uri: vscode.Uri | undefined = undefined;

    if (editor && editor.document.languageId === 'markdown') {
      uri = editor.document.uri;
      text = editor.document.getText();
    } else if (this.currentUri) {
      uri = this.currentUri;
      try {
        text = fs.readFileSync(uri.fsPath, 'utf8');
      } catch {
        return [];
      }
    } else {
      return [];
    }

    // Reset collapsible state to Expanded when switching to a different document
    if (uri && this.currentUri?.toString() !== uri.toString()) {
      this.defaultCollapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }

    this.currentUri = uri;
    const lines = text.split(/\r?\n/);
    const roots: OutlineNode[] = [];
    const stack: OutlineNode[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^([#]{1,6})\s+(.+)$/);
      if (!match) {
        continue;
      }

      const depth = match[1].length;
      const label = match[2].trim();

      const node = new OutlineNode(
        label,
        depth,
        i,
        vscode.TreeItemCollapsibleState.None,
        this.collapseVersion
      );

      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }

      if (stack.length === 0) {
        roots.push(node);
      } else {
        const parent = stack[stack.length - 1];
        parent.children.push(node);
        node.parent = parent;
        parent.collapsibleState = this.defaultCollapsibleState;
      }
      stack.push(node);
    }

    this.rootNodes = roots;
    return roots;
  }

  getRootNodes(): OutlineNode[] {
    return this.rootNodes;
  }

  getParent(element: OutlineNode): vscode.ProviderResult<OutlineNode> {
    return element.parent;
  }

  collapseAll(): void {
    this.defaultCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    this.collapseVersion++;
    this.refresh();
  }

  expandAll(): void {
    this.defaultCollapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    this.collapseVersion++;
    this.refresh();
  }
}

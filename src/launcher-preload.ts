import { contextBridge, ipcRenderer } from 'electron';

// Bridge for the Golden-Gate launcher window. Every action either files into
// the notebook (reusing the capture plumbing) or hands off to the main window.
contextBridge.exposeInMainWorld('launcherApi', {
  context: () => ipcRenderer.invoke('launcher-context'),
  search: (query: string) => ipcRenderer.invoke('launcher-search', query),
  openNote: (fsPath: string) => ipcRenderer.send('launcher-open-note', fsPath),
  openDaily: () => ipcRenderer.invoke('launcher-open-daily'),
  capture: (text: string) => ipcRenderer.invoke('append-quick-capture', text),
  captureTask: (text: string) => ipcRenderer.invoke('launcher-append-task', text),
  screenshot: () => ipcRenderer.invoke('launcher-screenshot'),
  openScratchpad: () => ipcRenderer.invoke('launcher-open-scratchpad'),
  resize: (height: number) => ipcRenderer.send('launcher-resize', height),
  hide: () => ipcRenderer.send('launcher-hide'),
  onReset: (cb: () => void) => ipcRenderer.on('launcher-reset', () => cb()),
});

import { contextBridge, ipcRenderer } from 'electron';

// Region selector overlay for screenshot-to-note.
contextBridge.exposeInMainWorld('regionApi', {
  getShot: () => ipcRenderer.invoke('region-get-shot'),
  commit: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('region-commit', rect),
  cancel: () => ipcRenderer.send('region-cancel'),
});

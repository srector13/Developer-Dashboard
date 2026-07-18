import { contextBridge, ipcRenderer } from 'electron';

// Floating scratchpad: reads/writes the whole scratchpad file and can toggle
// its always-on-top pin.
contextBridge.exposeInMainWorld('scratchApi', {
  read: () => ipcRenderer.invoke('read-scratchpad'),
  write: (text: string) => ipcRenderer.invoke('write-scratchpad', text),
  context: () => ipcRenderer.invoke('launcher-context'),
  setPin: (pinned: boolean) => ipcRenderer.send('scratchpad-pin', pinned),
  hide: () => ipcRenderer.send('scratchpad-hide'),
});

import { contextBridge, ipcRenderer } from 'electron';

// Deliberately tiny surface: the capture window can append one entry to
// today's daily note and hide itself — nothing else.
contextBridge.exposeInMainWorld('captureApi', {
  appendQuickCapture: (text: string) => ipcRenderer.invoke('append-quick-capture', text),
  hideCaptureWindow: () => ipcRenderer.send('hide-capture-window'),
});

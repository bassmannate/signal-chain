const { contextBridge, ipcRenderer } = require("electron");

// nodeIntegration is off and the renderer is sandboxed, so this is the only
// bridge between the UI (which speaks WebMIDI directly - no Node needed for
// that part) and the filesystem (which does need the main process).
contextBridge.exposeInMainWorld("fileAPI", {
  saveFile: (opts) => ipcRenderer.invoke("save-file", opts),
  openFile: (opts) => ipcRenderer.invoke("open-file", opts),
  openDirectory: () => ipcRenderer.invoke("open-directory"),
  writeFileInDir: (opts) => ipcRenderer.invoke("write-file-in-dir", opts),
  listDir: (opts) => ipcRenderer.invoke("list-dir", opts),
  readFileInDir: (opts) => ipcRenderer.invoke("read-file-in-dir", opts),
});

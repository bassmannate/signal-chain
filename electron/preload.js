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

// Closing the window with an unsaved patch library is asked about with a
// native dialog in the main process (main.js handles will-prevent-unload) -
// window.confirm() is ignored while a page is unloading, so the renderer
// cannot ask by itself. This bridge is the other half of that exchange: the
// main process asks for a save, and the answer closes the window or leaves it
// open. Browsers have no equivalent, so web/file-api.js defines nothing here
// and shared/app.js falls back to the browser's own unload prompt.
contextBridge.exposeInMainWorld("closeGuardAPI", {
  isDesktop: true,
  onSaveAndQuit: (callback) => ipcRenderer.on("save-library-and-quit", () => callback()),
  finishSaveAndQuit: (saved) => ipcRenderer.invoke("quit-after-library-save", saved),
});

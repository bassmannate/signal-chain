const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs/promises");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#17181A",
    title: "Signal Chain",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // WebMIDI (including sysex, which this app needs) is permission-gated in
  // Chromium. Electron has no UI for that prompt by default, so we grant it
  // explicitly here rather than have requestMIDIAccess() hang forever.
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "midi" || permission === "midiSysex") {
      callback(true);
    } else {
      callback(false);
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "shared", "index.html"));

  // A totally empty menu (the previous version of this file just called
  // Menu.setApplicationMenu(null)) also silently removes the keyboard
  // shortcut for DevTools, since that shortcut normally comes attached to
  // a menu item - it's not a global Electron default. That left no way
  // to open DevTools at all (no menu, no right-click context menu either,
  // since we never registered one of those). This minimal menu keeps the
  // clean look but keeps Ctrl+Shift+I / Cmd+Option+I working.
  const menu = Menu.buildFromTemplate([
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- File I/O, invoked from the renderer via preload's contextBridge ---
// (Renderer runs with nodeIntegration off, so it can't touch fs directly -
// this is the sanctioned path for save/open dialogs.)

ipcMain.handle("save-file", async (_event, { defaultPath, data, filters, binary }) => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath, filters });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, binary ? Buffer.from(data) : data);
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("open-file", async (_event, { filters, binary }) => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const data = await fs.readFile(result.filePaths[0], binary ? undefined : "utf-8");
  return { canceled: false, filePath: result.filePaths[0], data: binary ? new Uint8Array(data) : data };
});

ipcMain.handle("open-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, dirPath: result.filePaths[0] };
});

ipcMain.handle("write-file-in-dir", async (_event, { dirPath, fileName, data, binary }) => {
  const target = path.join(dirPath, fileName);
  await fs.writeFile(target, binary ? Buffer.from(data) : data);
  return { filePath: target };
});

ipcMain.handle("list-dir", async (_event, { dirPath }) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
});

ipcMain.handle("read-file-in-dir", async (_event, { dirPath, fileName }) => {
  const data = await fs.readFile(path.join(dirPath, fileName), "utf-8");
  return { data };
});

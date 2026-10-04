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

  // --- Unsaved patch library: guard the window close ---------------------
  //
  // shared/app.js cancels its own unload (beforeunload) when a patch library
  // has unsaved changes or a non-empty stash. Without a listener for this
  // event Electron cancels the close *silently* - the window button appears to
  // do nothing - and the renderer cannot ask for itself either, because dialogs
  // (window.confirm and friends) are ignored while a page is unloading. So the
  // question is a native dialog here, and the renderer is only asked to do the
  // part it alone can do: write the file.
  //
  // Registered here rather than at module scope: mainWindow only exists once
  // this function has run, and each window needs its own listener.
  mainWindow.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      title: "Unsaved patch library",
      message: "An unsaved patch library is open.",
      detail: "Library changes and any patches displaced from device slots are held in memory only, so they are lost when the app closes.",
      buttons: ["Save Library…", "Discard and Quit", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });

    // "Discard and Quit": ignore the page's beforeunload handler and unload.
    if (choice === 1) {
      event.preventDefault();
      return;
    }
    if (choice === 0) {
      // Leave the unload cancelled and let the renderer save first: it replies
      // through "quit-after-library-save", and only a completed write closes
      // the window. A cancelled save dialog leaves the app open, which is the
      // safe outcome - nothing has been thrown away at that point.
      mainWindow.webContents.send("save-library-and-quit");
    }
    // "Cancel" (choice 2): do nothing, so the close stays cancelled.
  });

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

// The renderer-side half of that exchange lives in shared/app.js; this handler
// is module scope because ipcMain.handle() may only be called once per channel,
// whereas createWindow() can run again on macOS. It quits only when the
// renderer confirms the library was actually written.
ipcMain.handle("quit-after-library-save", (_event, saved) => {
  if (!saved) return { quit: false };
  // destroy(), not close(): the guard was just satisfied, and close() would
  // run the renderer's beforeunload again.
  mainWindow.destroy();
  return { quit: true };
});

// --- File I/O, invoked from the renderer via preload's contextBridge ---
// (Renderer runs with nodeIntegration off, so it can't touch fs directly -
// this is the sanctioned path for save/open dialogs.)

ipcMain.handle("read-file-at-path", async (_event, { filePath }) => {
  // Silent re-read of a library path the user picked earlier via openFile or
  // saveFile - the only prompt-free read the sandbox allows, because the path
  // itself is proof of consent. Anything else (missing path, unreadable or
  // deleted file) reports ok:false and the renderer falls back to its stored
  // snapshot instead of showing an error dialog.
  try {
    if (typeof filePath !== "string" || !filePath) return { ok: false };
    const data = await fs.readFile(filePath, "utf-8");
    return { ok: true, filePath, data };
  } catch (e) {
    return { ok: false };
  }
});

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

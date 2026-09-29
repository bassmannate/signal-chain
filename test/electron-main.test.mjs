// Boots electron/main.js against a stubbed "electron" module.
//
// Why this exists: main.js once read mainWindow at module scope, before any
// window had been created. It threw during load, and because the throw
// aborted the rest of the module every ipcMain.handle() after it - including
// open-file - was silently never registered, so the app opened looking fine
// with a broken library Open button. `node --check` cannot see that (it is
// syntax-only), so this requires the module for real and then drives the
// close-guard dialog paths, all without needing a display.
//
//   node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const state = {
  handlers: new Map(), // channel -> handler, as registered by ipcMain.handle
  windowHandlers: new Map(), // event -> handler, as registered on webContents
  sends: [], // channels the main process sent to the renderer
  files: [], // paths passed to loadFile()
  destroyed: 0,
  choice: 2, // what the fake dialog returns; 2 = Cancel
  loadError: undefined,
};

class FakeBrowserWindow {
  constructor(options) {
    state.options = options;
    this.webContents = {
      session: { setPermissionRequestHandler: () => {} },
      on: (event, handler) => state.windowHandlers.set(event, handler),
      send: (channel) => state.sends.push(channel),
    };
    this.loadFile = (file) => state.files.push(file);
    this.destroy = () => { state.destroyed++; };
  }
}

const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle: (channel, handler) => state.handlers.set(channel, handler),
    on: () => {},
  },
  dialog: { showMessageBoxSync: () => state.choice },
  Menu: {
    buildFromTemplate: (template) => template,
    setApplicationMenu: () => {},
  },
};

const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, ...rest);
};
try {
  require("../electron/main.js");
} catch (error) {
  state.loadError = error;
} finally {
  Module._load = originalLoad;
}

// createWindow() runs on a microtask (app.whenReady().then(...)).
await new Promise((resolve) => setImmediate(resolve));

test("main.js loads cleanly and registers its IPC handlers", () => {
  assert.equal(
    state.loadError,
    undefined,
    `main.js threw while loading: ${state.loadError && state.loadError.stack}`
  );
  for (const channel of [
    "save-file",
    "open-file",
    "open-directory",
    "write-file-in-dir",
    "list-dir",
    "read-file-in-dir",
    "quit-after-library-save",
  ]) {
    assert.ok(state.handlers.has(channel), `no handler registered for ${channel}`);
  }
  assert.ok(
    state.files.some((file) => file.endsWith("shared/index.html")),
    "the window loads shared/index.html"
  );
  assert.ok(
    state.windowHandlers.has("will-prevent-unload"),
    "the close guard is attached to the window, not to a window that does not exist yet"
  );
});

/** Fires the close guard and reports how many times the unload was allowed. */
function fireCloseGuard(choice) {
  state.choice = choice;
  state.sends.length = 0;
  let allowed = 0;
  state.windowHandlers.get("will-prevent-unload")({
    preventDefault: () => { allowed++; },
  });
  return allowed;
}

test("\"Cancel\" leaves the window open", () => {
  assert.equal(fireCloseGuard(2), 0, "the close stays cancelled");
  assert.deepEqual(state.sends, [], "and nothing is asked of the renderer");
});

test("\"Discard and Quit\" allows the unload", () => {
  assert.equal(fireCloseGuard(1), 1, "preventDefault here means 'let the page go'");
  assert.deepEqual(state.sends, []);
});

test("\"Save Library…\" keeps the unload cancelled and asks the renderer to save", () => {
  assert.equal(fireCloseGuard(0), 0, "the window must not close before the save finishes");
  assert.deepEqual(state.sends, ["save-library-and-quit"]);
});

test("the window closes only once the library was written", async () => {
  const quit = state.handlers.get("quit-after-library-save");

  state.destroyed = 0;
  assert.deepEqual(await quit(null, false), { quit: false });
  assert.equal(state.destroyed, 0, "a cancelled save dialog leaves the app open");

  assert.deepEqual(await quit(null, true), { quit: true });
  assert.equal(state.destroyed, 1, "a completed save closes the window");
});

// Browser implementation of the window.fileAPI contract (see
// electron/preload.js for the Electron side). Same core methods, same shapes:
// saveFile/openFile return { canceled, ... }, openDirectory returns
// { canceled, dirPath }, writeFileInDir returns { filePath }.
//
// - saveFile: Blob + <a download> (lands in the browser's download folder).
// - openFile: hidden <input type="file"> (binary:true reads as Uint8Array).
// - openDirectory / writeFileInDir: File System Access API
//   (showDirectoryPicker + FileSystemWritableFileStream), which Chromium
//   supports. This is what Backup All needs (36 files, one folder pick).
//   Firefox/Safari have no directory API: openDirectory reports { canceled }
//   there, and app.js falls back to downloading the files one by one - so
//   backup still works everywhere, just less conveniently.
//
// No imports, no build step: this is a classic script that sets window.fileAPI
// before shared/app.js (a module, always deferred) runs.
//
// Deliberately NOT defined here: window.closeGuardAPI (see
// electron/preload.js). That bridge exists so the desktop shell can ask the
// renderer to save when the window is being closed, and the question itself is
// a native dialog in the main process - a browser has no such dialog and no
// API to customise the one it uses. shared/app.js checks for the bridge and
// falls back to the browser's own beforeunload prompt when it is absent.
(function () {
  "use strict";

  function toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data ?? []);
  }

  function extensionsOf(filters) {
    const exts = [];
    for (const f of filters ?? []) {
      for (const e of f.extensions ?? []) exts.push("." + String(e).toLowerCase());
    }
    return exts;
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    // Revoke on the next tick so slow browsers finish grabbing the blob first.
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  function baseName(fileName) {
    return String(fileName ?? "patch").split(/[\\/]/).pop() || "patch";
  }

  const api = {
    async saveFile({ defaultPath, data, binary } = {}) {
      const name = baseName(defaultPath) || "patch";
      const bytes = binary ? toUint8Array(data) : null;
      const blob = binary
        ? new Blob([bytes], { type: "application/octet-stream" })
        : new Blob([String(data ?? "")], { type: "text/plain;charset=utf-8" });
      downloadBlob(blob, name);
      return { canceled: false, filePath: name };
    },

    openFile({ binary, filters } = {}) {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        const exts = extensionsOf(filters);
        if (exts.length > 0) input.accept = exts.join(",");
        input.addEventListener("change", () => {
          const file = input.files?.[0];
          if (!file) {
            resolve({ canceled: true });
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const buf = reader.result;
            resolve({
              canceled: false,
              filePath: file.name,
              data: binary ? new Uint8Array(buf) : buf,
            });
          };
          reader.onerror = () => resolve({ canceled: true });
          if (binary) reader.readAsArrayBuffer(file);
          else reader.readAsText(file);
        });
        // If the picker is dismissed, change never fires - but some browsers
        // fire cancel, and a focus fallback covers the rest.
        input.addEventListener("cancel", () => resolve({ canceled: true }));
        input.click();
      });
    },

    async readFileAtPath() {
      // No prompt-free disk reads in a browser: the path is just a file name
      // here, with no handle behind it. Auto-reopen restores its stored
      // snapshot instead (see patchLibrary getLastLibraryForDevice).
      return { ok: false };
    },

    async openDirectory() {
      if (!window.showDirectoryPicker) return { canceled: true };
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        return { canceled: false, dirPath: dirHandle };
      } catch (e) {
        // AbortError = the user dismissed the picker; treat like cancel.
        return { canceled: true };
      }
    },

    async writeFileInDir({ dirPath, fileName, data, binary }) {
      // dirPath is a FileSystemDirectoryHandle here (see openDirectory).
      // Outside Chromium there is no directory handle, so download instead -
      // app.js only calls this when openDirectory succeeded, but staying
      // total keeps the contract honest if that ever changes.
      if (!dirPath?.getFileHandle) {
        await this.saveFile({ defaultPath: fileName, data, binary });
        return { filePath: String(fileName) };
      }
      const handle = await dirPath.getFileHandle(String(fileName), { create: true });
      const writable = await handle.createWritable();
      await writable.write(binary ? toUint8Array(data) : String(data ?? ""));
      await writable.close();
      return { filePath: String(fileName) };
    },

    async listDir() {
      // No persistent directory listing on the web side: Restore reads one
      // file via the picker instead, so this stays unimplemented.
      throw new Error("listDir is not supported in the browser - pick a file to restore instead.");
    },

    async readFileInDir() {
      throw new Error("readFileInDir is not supported in the browser - pick a file to restore instead.");
    },
  };

  window.fileAPI = api;
})();

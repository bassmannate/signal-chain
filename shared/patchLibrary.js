// Patch librarian bundle format (.patchlib.json).
//
// One library file holds patches for ONE device family only ("zoom-plus" or
// "bass-pod-pro") - Zoom and POD bytes are mutually unintelligible, so mixing
// them in one file would only create drops that must be rejected later.
// The guard lives here at file-open time instead.
//
// A library is a free-length list: it can hold far more patches than the
// device has slots, and order implies nothing about slots. slotHint records
// where an entry came from (or last lived) for display only.
//
// Payloads are the devices' exact bytes, base64-encoded: Zoom patch blobs
// (what patchToBytes() produces / ZoomPatch.fromPatchData() consumes) and
// raw 80-byte POD programs (envelope rebuilt with buildProgramDump() on
// write). No reinterpretation, no loss.
//
// This module is pure logic - no DOM, no MIDI, no fileAPI - so it runs
// unchanged in Electron, the browser, and node --test.

export const LIBRARY_APP_TAG = "signal-chain";
export const LIBRARY_VERSION = 1;
export const LIBRARY_EXTENSION = "patchlib.json";

export const DEVICE_KIND_ZOOM = "zoom-plus";
export const DEVICE_KIND_POD = "bass-pod-pro";

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  // Buffer exists in node/Electron; browsers use btoa. Chunked so large
  // blobs never blow the argument-length limit of apply().
  if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64");
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const s = String(text ?? "").trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0 || s.length === 0) {
    throw new Error("not valid base64");
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Empty library for one device family. */
export function createLibrary(deviceKind) {
  return {
    app: LIBRARY_APP_TAG,
    libraryVersion: LIBRARY_VERSION,
    deviceKind,
    patches: [],
  };
}

export function isSupportedDeviceKind(kind) {
  return kind === DEVICE_KIND_ZOOM || kind === DEVICE_KIND_POD;
}

export function labelForDeviceKind(kind) {
  return kind === DEVICE_KIND_POD ? "Bass POD Pro" : kind === DEVICE_KIND_ZOOM ? "Zoom MS Plus" : String(kind);
}

/** Suggested file name for Save As / first Save. */
export function suggestedLibraryFileName(deviceKind) {
  const base = deviceKind === DEVICE_KIND_POD ? "pod-library" : "zoom-library";
  return `${base}.${LIBRARY_EXTENSION}`;
}

/**
 * Build a library/stash entry from raw device bytes.
 */
export function entryFromBytes({ name, model, slotHint, bytes }) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  return {
    id: makeId(),
    name: String(name ?? "Untitled"),
    model: model === undefined || model === null ? "" : String(model),
    slotHint: slotHint === undefined || slotHint === null ? null : Number(slotHint),
    dataBase64: bytesToBase64(u8),
  };
}

/** Raw device bytes for an entry; throws on corrupt payload. */
export function entryToBytes(entry) {
  return base64ToBytes(entry?.dataBase64);
}

/** True when there are bytes worth stashing (a successful slot read). */
export function hasStashableBytes(bytes) {
  return bytes instanceof Uint8Array && bytes.length > 0;
}

// --- Stash bookkeeping --------------------------------------------------
//
// The stash holds patches displaced from device slots by a library drop. It
// lives in memory only and is wiped when the library closes, so these two
// helpers are what decide whether the user needs warning first. Kept here
// (pure, no DOM) so the rule is stated once and can be tested directly -
// app.js only renders the result.

/** Pushes an entry onto a stash array; returns the entry. */
export function addToStash(stash, entry) {
  stash.push(entry);
  return entry;
}

/** True when closing the library now would lose something. */
export function hasPendingWork(dirty, stash) {
  return Boolean(dirty) || (stash?.length ?? 0) > 0;
}

/** Human summary of what closing would lose, for the confirm dialog. */
export function pendingWorkSummary(dirty, stash) {
  const parts = [];
  if (dirty) parts.push("unsaved changes");
  const count = stash?.length ?? 0;
  if (count > 0) parts.push(`${count} stashed ${count === 1 ? "patch" : "patches"}`);
  return parts.join(" and ");
}

/** Validate + normalize a parsed library object; corrupt rows are skipped. */
export function validateLibraryObject(obj, { expectedDeviceKind } = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "not a library file (expected a JSON object)" };
  }
  if (obj.app !== LIBRARY_APP_TAG) {
    return { ok: false, error: "not a signal-chain library" };
  }
  if (obj.libraryVersion !== LIBRARY_VERSION) {
    return { ok: false, error: `unsupported library version ${JSON.stringify(obj.libraryVersion)}` };
  }
  if (!isSupportedDeviceKind(obj.deviceKind)) {
    return { ok: false, error: `unknown device family ${JSON.stringify(obj.deviceKind)}` };
  }
  if (expectedDeviceKind && obj.deviceKind !== expectedDeviceKind) {
    return {
      ok: false,
      error: `this library holds ${labelForDeviceKind(obj.deviceKind)} patches, but a ${labelForDeviceKind(expectedDeviceKind)} is connected`,
    };
  }
  if (!Array.isArray(obj.patches)) {
    return { ok: false, error: "library has no patch list" };
  }
  const patches = [];
  let skipped = 0;
  for (const row of obj.patches) {
    if (!row || typeof row !== "object") { skipped++; continue; }
    try {
      const bytes = base64ToBytes(row.dataBase64);
      if (bytes.length === 0) throw new Error("empty payload");
      patches.push({
        id: typeof row.id === "string" && row.id ? row.id : makeId(),
        name: typeof row.name === "string" && row.name ? row.name : "Untitled",
        model: typeof row.model === "string" ? row.model : "",
        slotHint: Number.isFinite(Number(row.slotHint)) ? Number(row.slotHint) : null,
        dataBase64: row.dataBase64,
      });
    } catch (e) {
      skipped++;
    }
  }
  return { ok: true, library: { ...obj, patches }, skipped };
}

/** Parse library file text. */
export function parseLibrary(text, opts = {}) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: "could not parse library file (invalid JSON)" };
  }
  return validateLibraryObject(obj, opts);
}

// --- Backup collision check -------------------------------------------------
//
// Backup All writes one file per slot into a user-picked folder, and without
// a check it silently overwrites same-named files (a re-run into last week's
// folder, or two pedals sharing a folder). These pure helpers decide what
// collides and what gets skipped, so the only question left for the UI is
// the three-way choice: overwrite / skip existing / cancel. No DOM, no
// fileAPI - the directory listing is handed in, which keeps this testable
// and keeps the web shell (whose listing API differs) on the same logic.

export const BACKUP_OVERWRITE = "overwrite";
export const BACKUP_SKIP = "skip";
export const BACKUP_CANCEL = "cancel";

/**
 * Which of the about-to-be-written file names already exist in the folder.
 * Comparison is exact (case-sensitive): the names are machine-generated
 * (`00_Name.zpatch`, `1A_Name.syx`), so a case-only difference is a genuinely
 * different file on Linux and gets no special treatment here.
 */
export function findBackupCollisions(plannedFileNames, existingFileNames) {
  const existing = new Set(existingFileNames ?? []);
  return (plannedFileNames ?? []).filter((name) => existing.has(name));
}

/**
 * The write plan once the user has chosen: overwrite writes everything,
 * skip drops the colliding names, cancel writes nothing.
 */
export function planBackupWrites(plannedFileNames, collisions, choice) {
  if (choice === BACKUP_CANCEL) return [];
  if (choice === BACKUP_SKIP) {
    const skip = new Set(collisions ?? []);
    return (plannedFileNames ?? []).filter((name) => !skip.has(name));
  }
  return [...(plannedFileNames ?? [])];
}

/** One-line summary for the status bar after a skip-choice backup. */
export function backupSkipSummary(wroteCount, skippedCount) {
  if (skippedCount > 0 && wroteCount > 0) {
    return `Backup complete: wrote ${wroteCount}, skipped ${skippedCount} already in the folder.`;
  }
  if (skippedCount > 0) {
    return `Backup complete: all ${skippedCount} files were already in the folder, nothing written.`;
  }
  return `Backup complete: wrote ${wroteCount} files.`;
}

export function serializeLibrary(library) {
  return JSON.stringify(library, null, 2);
}

// --- Auto-reopen preferences -----------------------------------------------
//
// Remembers, per physical pedal, which library file was last open - so
// connecting the MS-60B+ can silently reopen "library A" while the MS-50G+
// reopens "library B". This module stays pure: the caller hands it a
// Storage-like object (window.localStorage in both shells), which keeps this
// testable in node and means no new config-file plumbing anywhere.
//
// Stored shapes:
//   signal-chain.libAutoReopen   -> "1" or "0" (one global toggle)
//   signal-chain.libLastByDevice -> JSON object keyed by device key:
//     { "<key>": { filePath, fileName, snapshot } }
// snapshot is the last-saved serializeLibrary() text. It is the whole
// mechanism on the web (browsers cannot re-read an arbitrary disk path
// without a picker prompt) and the fallback on Electron when the file has
// moved or been deleted.

export const LIB_AUTO_REOPEN_KEY = "signal-chain.libAutoReopen";
export const LIB_LAST_BY_DEVICE_KEY = "signal-chain.libLastByDevice";

/**
 * Key identifying one physical pedal for auto-reopen. Zoom pedals share a
 * profile id, so the model byte is what tells an MS-50G+ (0x23) apart from
 * an MS-60B+ (0x27). Returns null when there is no usable identity.
 */
export function deviceKeyForAutoReopen(profileId, modelByte) {
  if (profileId === DEVICE_KIND_POD) return DEVICE_KIND_POD;
  if (profileId === DEVICE_KIND_ZOOM) {
    const model = Number(modelByte);
    if (Number.isFinite(model)) return `${DEVICE_KIND_ZOOM}:${model}`;
    return DEVICE_KIND_ZOOM;
  }
  return null;
}

/** Global auto-reopen toggle; absent or unreadable storage means off. */
export function loadAutoReopenSetting(storage) {
  try {
    const raw = storage?.getItem?.(LIB_AUTO_REOPEN_KEY);
    return raw === "1" || raw === "true";
  } catch (e) {
    return false;
  }
}

export function saveAutoReopenSetting(storage, enabled) {
  try {
    storage?.setItem?.(LIB_AUTO_REOPEN_KEY, enabled ? "1" : "0");
  } catch (e) {
    // Private-mode / quota failure: the toggle just does not persist.
  }
}

function readLastMap(storage) {
  try {
    const raw = storage?.getItem?.(LIB_LAST_BY_DEVICE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    return obj;
  } catch (e) {
    return {};
  }
}

function writeLastMap(storage, map) {
  storage?.setItem?.(LIB_LAST_BY_DEVICE_KEY, JSON.stringify(map));
}

function isValidLastEntry(entry) {
  return Boolean(entry) && typeof entry === "object" &&
    (typeof entry.filePath === "string" || typeof entry.fileName === "string" || typeof entry.snapshot === "string");
}

/** The remembered library for one pedal, or null. */
export function getLastLibraryForDevice(storage, deviceKey) {
  if (!deviceKey) return null;
  const entry = readLastMap(storage)[deviceKey];
  return isValidLastEntry(entry) ? entry : null;
}

/**
 * Remember a library for one pedal. On quota failure the snapshot (the
 * largest part) is dropped and the path/name are kept, so Electron - which
 * can re-read the path - still reopens.
 */
export function setLastLibraryForDevice(storage, deviceKey, { filePath, fileName, snapshot }) {
  if (!deviceKey || !storage?.getItem) return;
  const map = readLastMap(storage);
  const entry = {};
  if (typeof filePath === "string" && filePath) entry.filePath = filePath;
  if (typeof fileName === "string" && fileName) entry.fileName = fileName;
  if (typeof snapshot === "string" && snapshot) entry.snapshot = snapshot;
  map[deviceKey] = entry;
  try {
    writeLastMap(storage, map);
  } catch (e) {
    try {
      delete entry.snapshot;
      writeLastMap(storage, map);
    } catch (e2) {
      // Storage unusable: auto-reopen just stays off for this pedal.
    }
  }
}

/** Forget a pedal's library (used for "New": an empty library is not worth reopening). */
export function clearLastLibraryForDevice(storage, deviceKey) {
  if (!deviceKey) return;
  try {
    const map = readLastMap(storage);
    if (!(deviceKey in map)) return;
    delete map[deviceKey];
    writeLastMap(storage, map);
  } catch (e) {
    // Storage unusable: nothing to forget.
  }
}





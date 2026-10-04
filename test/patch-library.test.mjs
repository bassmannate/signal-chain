import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_KIND_POD,
  DEVICE_KIND_ZOOM,
  LIBRARY_EXTENSION,
  addToStash,
  clearLastLibraryForDevice,
  createLibrary,
  deviceKeyForAutoReopen,
  entryFromBytes,
  entryToBytes,
  getLastLibraryForDevice,
  hasPendingWork,
  hasStashableBytes,
  labelForDeviceKind,
  loadAutoReopenSetting,
  parseLibrary,
  pendingWorkSummary,
  saveAutoReopenSetting,
  serializeLibrary,
  setLastLibraryForDevice,
  suggestedLibraryFileName,
  validateLibraryObject,
} from "../shared/patchLibrary.js";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _raw: (k) => store.get(k),
  };
}

describe("patchLibrary bundle format", () => {
  it("round-trips Zoom bytes through base64 entries", () => {
    const bytes = new Uint8Array([0x50, 0x54, 0x43, 0x46, 1, 2, 3, 255, 0]);
    const entry = entryFromBytes({ name: "Lead", model: "MS-50G+", slotHint: 4, bytes });
    assert.equal(entry.name, "Lead");
    assert.equal(entry.slotHint, 4);
    assert.deepEqual([...entryToBytes(entry)], [...bytes]);
    const lib = { ...createLibrary(DEVICE_KIND_ZOOM), patches: [entry] };
    const parsed = parseLibrary(serializeLibrary(lib), { expectedDeviceKind: DEVICE_KIND_ZOOM });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.library.patches.length, 1);
    assert.deepEqual([...entryToBytes(parsed.library.patches[0])], [...bytes]);
  });

  it("round-trips an 80-byte POD program exactly", () => {
    const bytes = new Uint8Array(80);
    for (let i = 0; i < 80; i++) bytes[i] = i;
    const entry = entryFromBytes({ name: "Deep", model: "Bass POD Pro", slotHint: 0, bytes });
    assert.deepEqual([...entryToBytes(entry)], [...bytes]);
    const lib = { ...createLibrary(DEVICE_KIND_POD), patches: [entry] };
    const parsed = parseLibrary(serializeLibrary(lib), { expectedDeviceKind: DEVICE_KIND_POD });
    assert.equal(parsed.ok, true);
    assert.deepEqual([...entryToBytes(parsed.library.patches[0])], [...bytes]);
  });

  it("rejects a library for the wrong device family", () => {
    const lib = createLibrary(DEVICE_KIND_POD);
    const res = parseLibrary(JSON.stringify(lib), { expectedDeviceKind: DEVICE_KIND_ZOOM });
    assert.equal(res.ok, false);
    assert.match(res.error, /Bass POD Pro/i);
  });

  it("rejects non-library files and bad versions", () => {
    assert.equal(parseLibrary("not json").ok, false);
    assert.equal(parseLibrary(JSON.stringify({ app: "other" })).ok, false);
    const lib = { ...createLibrary(DEVICE_KIND_ZOOM), libraryVersion: 999 };
    assert.equal(parseLibrary(JSON.stringify(lib)).ok, false);
  });

  it("skips corrupt rows but keeps good ones", () => {
    const good = entryFromBytes({ name: "Ok", bytes: new Uint8Array([1, 2, 3]) });
    const lib = { ...createLibrary(DEVICE_KIND_ZOOM), patches: [good, { name: "Bad", dataBase64: "!!!nope!!!" }, null] };
    const res = parseLibrary(JSON.stringify(lib));
    assert.equal(res.ok, true);
    assert.equal(res.library.patches.length, 1);
    assert.equal(res.skipped, 2);
  });

  it("stash helper only accepts real reads", () => {
    assert.equal(hasStashableBytes(new Uint8Array([1])), true);
    assert.equal(hasStashableBytes(undefined), false);
    assert.equal(hasStashableBytes(new Uint8Array(0)), false);
  });

  it("validates objects directly and names files per family", () => {
    assert.equal(validateLibraryObject(null).ok, false);
    assert.equal(validateLibraryObject({}).ok, false);
    assert.equal(labelForDeviceKind(DEVICE_KIND_POD), "Bass POD Pro");
    assert.equal(suggestedLibraryFileName(DEVICE_KIND_POD), `pod-library.${LIBRARY_EXTENSION}`);
    assert.equal(suggestedLibraryFileName(DEVICE_KIND_ZOOM), `zoom-library.${LIBRARY_EXTENSION}`);
  });

  it("stacks displaced patches on the stash in order", () => {
    const stash = [];
    const first = entryFromBytes({ name: "Was in 1A", bytes: new Uint8Array([1]) });
    const second = entryFromBytes({ name: "Was in 2A", bytes: new Uint8Array([2]) });
    addToStash(stash, first);
    addToStash(stash, second);
    assert.deepEqual(stash.map((e) => e.name), ["Was in 1A", "Was in 2A"],
      "the patch displaced by a drop is kept, not discarded");
  });

  it("warns on close for either unsaved changes or a non-empty stash", () => {
    assert.equal(hasPendingWork(false, []), false, "nothing to lose");
    assert.equal(hasPendingWork(true, []), true, "unsaved edits alone are enough");
    assert.equal(hasPendingWork(false, [{}]), true, "a stashed patch alone is enough");
    assert.equal(hasPendingWork(false, undefined), false, "no stash at all is fine");
  });

  it("keys auto-reopen per physical pedal, not per family", () => {
    assert.equal(deviceKeyForAutoReopen("zoom-plus", 0x23), "zoom-plus:35");
    assert.equal(deviceKeyForAutoReopen("zoom-plus", 0x27), "zoom-plus:39");
    assert.notEqual(
      deviceKeyForAutoReopen("zoom-plus", 0x23),
      deviceKeyForAutoReopen("zoom-plus", 0x27),
      "an MS-50G+ and an MS-60B+ must not share a memory"
    );
    assert.equal(deviceKeyForAutoReopen("bass-pod-pro"), "bass-pod-pro");
    assert.equal(deviceKeyForAutoReopen("zoom-plus", undefined), "zoom-plus");
    assert.equal(deviceKeyForAutoReopen("unknown", 1), null);
  });

  it("persists the auto-reopen toggle, defaulting to off", () => {
    const storage = memoryStorage();
    assert.equal(loadAutoReopenSetting(storage), false, "absent storage means off");
    saveAutoReopenSetting(storage, true);
    assert.equal(storage._raw("signal-chain.libAutoReopen"), "1");
    assert.equal(loadAutoReopenSetting(storage), true);
    saveAutoReopenSetting(storage, false);
    assert.equal(loadAutoReopenSetting(storage), false);
    assert.equal(loadAutoReopenSetting(null), false, "no storage is off, not a crash");
    assert.equal(loadAutoReopenSetting({ getItem: () => { throw new Error("denied"); } }), false);
  });

  it("remembers one library per pedal and forgets on New", () => {
    const storage = memoryStorage();
    const libA = { ...createLibrary(DEVICE_KIND_ZOOM), patches: [entryFromBytes({ name: "A", bytes: new Uint8Array([1]) })] };
    const libB = { ...createLibrary(DEVICE_KIND_ZOOM), patches: [entryFromBytes({ name: "B", bytes: new Uint8Array([2]) })] };
    const key60 = deviceKeyForAutoReopen("zoom-plus", 0x27);
    const key50 = deviceKeyForAutoReopen("zoom-plus", 0x23);
    setLastLibraryForDevice(storage, key60, { filePath: "/lib/A.patchlib.json", fileName: "A.patchlib.json", snapshot: serializeLibrary(libA) });
    setLastLibraryForDevice(storage, key50, { filePath: "/lib/B.patchlib.json", fileName: "B.patchlib.json", snapshot: serializeLibrary(libB) });
    const gotA = getLastLibraryForDevice(storage, key60);
    assert.equal(gotA.fileName, "A.patchlib.json");
    assert.equal(parseLibrary(gotA.snapshot).library.patches[0].name, "A");
    // The two pedals do not overwrite each other.
    assert.equal(getLastLibraryForDevice(storage, key50).fileName, "B.patchlib.json");
    // Plan A: New clears this pedal's memory only.
    clearLastLibraryForDevice(storage, key60);
    assert.equal(getLastLibraryForDevice(storage, key60), null);
    assert.notEqual(getLastLibraryForDevice(storage, key50), null, "the other pedal keeps its memory");
  });

  it("rejects junk memories instead of reopening them", () => {
    const storage = memoryStorage();
    assert.equal(getLastLibraryForDevice(storage, null), null);
    assert.equal(getLastLibraryForDevice(storage, "zoom-plus:39"), null, "nothing stored yet");
    storage.setItem("signal-chain.libLastByDevice", "not json");
    assert.equal(getLastLibraryForDevice(storage, "zoom-plus:39"), null, "corrupt map reads as empty");
    storage.setItem("signal-chain.libLastByDevice", JSON.stringify({ "zoom-plus:39": { nope: 1 } }));
    assert.equal(getLastLibraryForDevice(storage, "zoom-plus:39"), null, "entry with no path/name/snapshot is ignored");
  });

  it("describes what closing would lose", () => {
    assert.equal(pendingWorkSummary(false, []), "");
    assert.equal(pendingWorkSummary(true, []), "unsaved changes");
    assert.equal(pendingWorkSummary(false, [{}]), "1 stashed patch");
    assert.equal(pendingWorkSummary(true, [{}, {}]), "unsaved changes and 2 stashed patches");
  });
});


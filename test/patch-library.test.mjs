import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_KIND_POD,
  DEVICE_KIND_ZOOM,
  LIBRARY_EXTENSION,
  addToStash,
  createLibrary,
  entryFromBytes,
  entryToBytes,
  hasPendingWork,
  hasStashableBytes,
  labelForDeviceKind,
  parseLibrary,
  pendingWorkSummary,
  serializeLibrary,
  suggestedLibraryFileName,
  validateLibraryObject,
} from "../shared/patchLibrary.js";

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

  it("describes what closing would lose", () => {
    assert.equal(pendingWorkSummary(false, []), "");
    assert.equal(pendingWorkSummary(true, []), "unsaved changes");
    assert.equal(pendingWorkSummary(false, [{}]), "1 stashed patch");
    assert.equal(pendingWorkSummary(true, [{}, {}]), "unsaved changes and 2 stashed patches");
  });
});


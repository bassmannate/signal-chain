// Mapping coverage for the Zoom BPM blocks.
//
//   node --test test/
//
// These ids were invisible to the suite until now: 09000ff0 (the effects-
// group BPM / tap-tempo block, MS-60B+) was in no data file at all, so it
// rendered as "Effect 9000ff0" with a generic icon and an unlabeled knob.
// 07000ff0 is its utility-section twin, mapped by hand from the start.
// This file pins both, plus the knob floor the pedal's range requires.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { EFFECT_ICON_OVERRIDES, iconSvgFor } from "../shared/effect-icons.js";
import { ZoomPatch } from "../shared/lib/ZoomPatch.js";
import { ZoomDevice } from "../shared/lib/ZoomDevice.js";
import { effectIdMapFromJson } from "../shared/lib/ZoomEffectMaps.js";
import ms50gpIds from "../shared/lib/zoom-effect-ids-ms50gp.js";
import ms60bpIds from "../shared/lib/zoom-effect-ids-ms60bp.js";
import ms70cdrpIds from "../shared/lib/zoom-effect-ids-ms70cdrp.js";

const MAPPINGS = [
  "shared/data/zoom-effect-mappings-ms50gp.json",
  "shared/data/zoom-effect-mappings-ms60bp.json",
  "shared/data/zoom-effect-mappings-ms70cdrp.json",
];
const BPM_ID = "09000ff0";
const UTILITY_BPM_ID = "07000ff0";

const load = (path) => JSON.parse(fs.readFileSync(path, "utf8"));

test("every model maps the effects-group BPM block (09000ff0)", () => {
  for (const path of MAPPINGS) {
    const entry = load(path)[BPM_ID];
    assert.ok(entry, path + " is missing " + BPM_ID);
    assert.equal(entry.name, "BPM");
    assert.equal(entry.screenName, "BPM");
    assert.equal(entry.parameters.length, 1, "exactly one parameter");
    const [param] = entry.parameters;
    assert.equal(param.name, "BPM");
    assert.equal(param.min, 40, "the pedal's floor");
    assert.equal(param.max, 250, "the pedal's ceiling");
    assert.equal(param.default, 0,
      "default matches what the pedal itself stores in EDTB (tempo lives in PRM2)");
  }
});

test("the utility BPM block (07000ff0) keeps its zero-parameter mapping", () => {
  for (const path of MAPPINGS) {
    const entry = load(path)[UTILITY_BPM_ID];
    assert.ok(entry, path + " lost " + UTILITY_BPM_ID);
    assert.equal(entry.name, "BPM");
    assert.equal(entry.parameters.length, 0,
      "the utility block controls tempo patch-wide, not through a knob");
  }
});


test("the BPM block gets the hand-drawn metronome, not a generated icon", () => {
  const markup = EFFECT_ICON_OVERRIDES[BPM_ID];
  assert.ok(markup, "an override is registered for 09000ff0");
  // The generator never draws this path - it is unmistakably the override.
  assert.ok(markup.includes("M8 21 L9.8 7"), "the metronome case");
  const svg = iconSvgFor(0x27, 0x09000ff0, { name: "BPM" });
  assert.ok(svg.startsWith('<svg viewBox="0 0 24 24"'));
  assert.ok(svg.includes("M8 21 L9.8 7"), "the override wins over the generator");
  // Overrides hold INNER markup; iconSvgFor owns the svg wrapper.
  for (const [key, inner] of Object.entries(EFFECT_ICON_OVERRIDES)) {
    assert.equal(inner.includes('<svg'), false, key + " must not wrap itself" );
  }
});


test("the name tables know the BPM block, so ZoomEffectMaps stays quiet", () => {
  // ZoomEffectMaps warns for ids missing from its nameMap (already silenced
  // for 07000ff0) - 09000ff0 must be listed on every model.
  const tables = [["ms50gp", ms50gpIds], ["ms60bp", ms60bpIds], ["ms70cdrp", ms70cdrpIds]];
  for (const [label, table] of tables) {
    assert.equal(table.get(0x09000ff0), "BPM", label + " name table");
    assert.equal(table.get(0x07000ff0), "BPM", label + " keeps the utility block");
  }
});

test("the chain knob honors a parameter's declared minimum", () => {
  // The BPM block floors at 40: without reading paramInfo.min the knob
  // would happily send 0-39 to a pedal whose own range starts at 40.
  const app = fs.readFileSync("shared/app.js", "utf8");
  assert.ok(app.includes("paramInfo?.min ?? 0"), "renderKnobs reads min");
  assert.ok(app.includes("data-min="), "the min travels with the knob element");
  assert.ok(app.includes("setKnobVisual(knobEl, value, max, min)"), "initial visual honors min");
  assert.ok(app.includes("Number(knobEl.dataset.min ?? 0)"), "pedal-driven updates honor min too");
});


test("the BPM slot bit covers both block variants", () => {
  // Verified against a pedal-written MS-60B+ patch: the 09000ff0 block in
  // slot 5 set PRM2's BPM-slot field to 32 (1 << 5), while a 07-only
  // derivation returned 0 and would wipe the bit on the next write - leaving
  // the pedal with no BPM screen.
  const slots = (bpmIndex, bpmId) => Array.from({ length: 6 }, (_, i) => ({
    id: i === bpmIndex ? bpmId : 0x01000010,
  }));
  assert.equal(ZoomPatch.createBPMSlotBits(slots(5, 0x09000ff0)), 32,
    "effects-section BPM block (09000ff0) claims its slot bit");
  assert.equal(ZoomPatch.createBPMSlotBits(slots(0, 0x07000ff0)), 1,
    "utility-section BPM block (07000ff0) still works");
  assert.equal(ZoomPatch.createBPMSlotBits(slots(-1, 0)), 0,
    "no BPM block means no bits");

  const patch = new ZoomPatch();
  patch.prm2BPMSlot = 32;
  patch.edtbEffectSettings = slots(5, 0x09000ff0);
  assert.equal(patch.verifyPrm2BPMSlotBits(), true,
    "a pedal-written patch now round-trips without a verify warning");
});

test("the BPM knob routes through the tempo channel, not effect params", () => {
  const app = fs.readFileSync("shared/app.js", "utf8");
  assert.ok(app.includes("function isTempoBlockId"), "tempo blocks are identified");
  assert.ok(app.includes("device.setTempoOnDevice(newValue)"),
    "app -> pedal: the knob writes tempo via slot 100 / param 2");
  assert.ok(app.includes("isTempoBlockId(selEff.id)"),
    "pedal -> app: tempoV2 updates the selected BPM knob");
  const device = fs.readFileSync("shared/lib/ZoomDevice.js", "utf8");
  assert.ok(device.includes("setTempoOnDevice(tempo)"), "the write path exists");
  assert.ok(device.includes("parameterBuffer[0] = 100"),
    "tempo is addressed to effectSlot 100 (0x64), matching tempoV2");
});

test("effectIdMapFromJson converts the fetched JSON to the write-path Map", () => {
  const json = load("shared/data/zoom-effect-mappings-ms60bp.json");
  const map = effectIdMapFromJson(json);
  assert.equal(map.size, Object.keys(json).length, "no entries dropped");
  const entry = map.get(0x01000010);
  assert.ok(entry, "integer keys: 0x01000010 resolves");
  assert.equal(entry.name, "DYN Comp");
  assert.ok(!map.has("01000010"), "string keys are not used");
  assert.equal(effectIdMapFromJson(null).size, 0, "null is an empty map, not a crash");
  assert.equal(effectIdMapFromJson({ "not-hex!!": { name: "x" } }).size, 0, "malformed keys skipped");
});

test("createPreampSlotBits counts MS-60B+ amp blocks (group 0x05)", () => {
  // Regression: USER-003 / Dual Overd patches warned
  // "verifyPrm2PreampSlotBits() failed" on every patch-list click, because
  // only group 0x04 counted while the MS-60B+ puts amps in 0x05.
  const slots = (ids) => ids.map((id) => ({ id }));
  assert.equal(ZoomPatch.createPreampSlotBits(slots([0x04000080])), 0b1, "0x04 still counts");
  assert.equal(ZoomPatch.createPreampSlotBits(slots([0x05000010])), 0b1, "0x05 FlipTop counts");
  assert.equal(
    ZoomPatch.createPreampSlotBits(slots([0x01000010, 0x05000020, 0x06000110])),
    0b010, "only the amp slot sets its bit");
  assert.equal(ZoomPatch.createPreampSlotBits(slots([0x01000010])), 0, "non-amp stays clear");
});

test("the fetched map registers under the device name the getter uses", () => {
  // Regression: setEffectIDMap had zero call sites, so every save logged
  // "No effect ID map found for device MS-60B+" and wrote zeros.
  const json = load("shared/data/zoom-effect-mappings-ms60bp.json");
  const map = effectIdMapFromJson(json);
  ZoomDevice.setEffectIDMap(["MS-60B+", "MS-60B+ #2"], map);
  try {
    const got = ZoomDevice.getEffectIDMapForDevice("MS-60B+");
    assert.ok(got, "base name resolves");
    assert.equal(got.get(0x01000010).name, "DYN Comp");
    assert.ok(ZoomDevice.getEffectIDMapForDevice("MS-60B+ #2"), "dedup-suffixed name resolves too");
    const app = fs.readFileSync("shared/app.js", "utf8");
    assert.ok(app.includes("registerDeviceEffectMap"), "app.js bridges fetch -> ZoomDevice");
  } finally {
    ZoomDevice._effectIDMaps.delete("MS-60B+");
    ZoomDevice._effectIDMaps.delete("MS-60B+ #2");
  }
});

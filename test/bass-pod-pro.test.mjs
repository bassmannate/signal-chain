// Tests for the Line 6 Bass POD Pro support: identity discovery, the control
// map in shared/data/bass-pod-pro.json, and the CC protocol adapter.
//
//   node --test test/
//
// No MIDI hardware, no Electron and no display needed: the vendored protocol
// modules in shared/lib/ are plain ES modules, so a fake MIDI proxy is
// enough to cover everything the app does to the wire.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getMIDIDeviceList } from "../shared/lib/miditools.js";
import { BassPodProDevice, buildControlLookup } from "../shared/devices/BassPodProDevice.js";
import { findProfileFor, isBassPodProIdentity } from "../shared/devices/profiles.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileData = JSON.parse(readFileSync(path.join(repoRoot, "shared/data/bass-pod-pro.json"), "utf8"));
const lookup = buildControlLookup(profileData);

// The universal identity request the app sends, and the reply a Bass POD Pro
// gives: manufacturer 00 01 0C, family 0002 (sent LSB first), member 0000,
// four version bytes. 17 bytes - the long form miditools.js already handles.
const IDENTITY_REQUEST = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
const IDENTITY_REPLY = [
  0xf0, 0x7e, 0x00, 0x06, 0x02, // F0 7E <channel> 06 02
  0x00, 0x01, 0x0c, //            3-byte manufacturer ID (Line 6)
  0x02, 0x00, //                  family code, LSB first
  0x00, 0x00, //                  member code
  0x01, 0x00, 0x00, 0x00, //      version
  0xf7,
];

class FakeMIDIProxy {
  constructor({ answerIdentity = true } = {}) {
    this.answerIdentity = answerIdentity;
    this.sent = [];
    this.listeners = new Map();
    this.inputs = new Map([["in-1", { id: "in-1", name: "Fake MIDI In", connection: "closed" }]]);
    this.outputs = new Map([["out-1", { id: "out-1", name: "Fake MIDI Out", connection: "closed" }]]);
  }
  async enable() {}
  async openInput() { return { id: "in-1" }; }
  async openOutput() { return { id: "out-1" }; }
  async closeInput() {}
  async closeOutput() {}
  addListener(id, listener) { this.listeners.set(id, listener); }
  removeListener(id, listener) { if (this.listeners.get(id) === listener) this.listeners.delete(id); }
  send(_id, data) {
    this.sent.push([...data]);
    const isIdentityRequest = IDENTITY_REQUEST.every((byte, i) => data[i] === byte);
    if (isIdentityRequest && this.answerIdentity) this.emitInbound(IDENTITY_REPLY);
  }
  sendCC(_id, channel, ccNumber, value) { this.sent.push([0xb0 + channel, ccNumber, value]); }
  sendPC(_id, channel, program) { this.sent.push([0xc0 + channel, program]); }
  /** Pretend the pedal sent us something. */
  emitInbound(bytes) {
    for (const listener of this.listeners.values()) listener("in-1", Uint8Array.from(bytes));
  }
  get lastMessage() { return this.sent[this.sent.length - 1]; }
}

function openFakeDevice(options = {}) {
  const midi = new FakeMIDIProxy(options);
  const device = new BassPodProDevice(midi, { inputID: "in-1", outputID: "out-1" }, profileData, options.deviceOptions);
  return { midi, device };
}

test("identity reply: the POD is discovered and matched to the fixed-panel profile", async () => {
  const midi = new FakeMIDIProxy();
  const descriptions = await getMIDIDeviceList(midi, midi.inputs, midi.outputs, 20, false);

  assert.equal(descriptions.length, 1, "one identity reply, one device");
  const description = descriptions[0];
  assert.deepEqual(description.manufacturerID, [0x00, 0x01, 0x0c]);
  assert.equal(description.manufacturerName, "Line 6 (Fast Forward) (Yamaha)");
  assert.deepEqual(description.familyCode, [0x02, 0x00]);
  assert.deepEqual(description.modelNumber, [0x00, 0x00]);
  assert.ok(isBassPodProIdentity(description), "recognised as a Bass POD Pro");

  const found = findProfileFor(descriptions);
  assert.equal(found.profile.id, "bass-pod-pro");
  assert.equal(found.profile.layout, "fixed-panel", "the POD needs the fixed-panel view, not the chain");
  assert.ok(found.profile.dataFile.endsWith("/shared/data/bass-pod-pro.json"),
    `module-anchored data URL, got ${found.profile.dataFile}`);
  assert.equal(found.profile.deviceLabel(description), "Line 6 Bass POD Pro");
});

test("identity reply: a different Line 6 family is not claimed as a Bass POD Pro", () => {
  const otherLine6 = {
    manufacturerID: [0x00, 0x01, 0x0c],
    familyCode: [0x07, 0x00],
    modelNumber: [0x00, 0x00],
  };
  assert.equal(isBassPodProIdentity(otherLine6), false);
  assert.equal(findProfileFor([otherLine6]), undefined, "an unknown device matches no profile");

  const zoomPedal = { manufacturerID: [0x52], familyCode: [0x6e, 0x00], modelNumber: [0x27, 0x00] };
  assert.equal(isBassPodProIdentity(zoomPedal), false);
  assert.equal(findProfileFor([zoomPedal]).profile.id, "zoom-plus", "Zoom devices still match the Zoom profile");
});


test("control map: every control-change number is unique, in range and documented", () => {
  assert.equal(profileData.channel, 1, "the POD ships on MIDI channel 1");
  assert.equal(profileData.programs.count, 36, "36 internal programs (1A-9D)");

  // The three named-value selectors, in the order their CC values index them.
  assert.equal(profileData.valueTables.ampModels.length, 16);
  assert.equal(profileData.valueTables.cabinets.length, 16);
  assert.equal(profileData.valueTables.effects.length, 16);

  const ccs = [...lookup.keys()];
  assert.equal(new Set(ccs).size, ccs.length, "no control-change number is used twice");
  for (const cc of ccs) {
    assert.ok(cc >= 1 && cc <= 119, `CC ${cc} is outside the range the POD documents`);
  }

  // Selection-style controls are 0-15: their value indexes the name table.
  for (const id of ["ampModel", "cabinet", "effect"]) {
    const control = [...lookup.values()].find((c) => c.id === id);
    assert.ok(control, `${id} exists`);
    assert.equal(control.min, 0);
    assert.equal(control.max, 15);
    assert.equal(profileData.valueTables[control.table].length, 16, `${id}'s table has one name per value`);
  }

  // Two kinds of continuous control, and the difference is real. Most of the
  // POD's parameters are stored in 6 bits, so their control-change range stops
  // at 126 (0x7E) - the ODS documents "00-7e" for those - while the noise gate
  // (a switch, not a level) and the individual compressor parameters are 7-bit
  // and use the full 0-127 (0x7F) that the sys-ex PDF lists for them.
  const sixBit = ["drive", "bass", "middle", "treble", "channelVolume", "compress",
    "effectTweak", "fxLoCut", "paramFreq", "paramQ", "paramGain", "middleSweep",
    "digOutLevel", "airLevel"];
  for (const id of sixBit) {
    const control = [...lookup.values()].find((c) => c.id === id);
    assert.ok(control, `${id} is in the map`);
    assert.equal(control.max, 126, `${id} is stored in 6 bits, so it tops out at 126`);
  }

  const sevenBit = ["noiseGate", "compRatio", "compAttack", "compRelease"];
  for (const id of sevenBit) {
    const control = [...lookup.values()].find((c) => c.id === id);
    assert.ok(control, `${id} is in the map`);
    assert.equal(control.max, 127, `${id} is 7-bit and uses the full 0-127`);
  }

  // The handful of control numbers worth pinning down by name.
  const expected = { ampModel: 12, drive: 13, bass: 14, middle: 15, treble: 16,
    channelVolume: 17, compress: 18, effect: 19, effectTweak: 1, fxLoCut: 21,
    noiseGate: 22, paramFreq: 25, paramQ: 26, paramGain: 27, middleSweep: 28,
    digOutLevel: 9, applyFxToDi: 64, cabinet: 71, airLevel: 72,
    compRatio: 42, compAttack: 51, compRelease: 63 };
  for (const [id, cc] of Object.entries(expected)) {
    const control = [...lookup.values()].find((c) => c.id === id);
    assert.ok(control, `${id} is in the map`);
    assert.equal(control.cc, cc, `${id} uses CC ${cc}`);
  }
});

test("outbound: moving a control sends the matching control change", async () => {
  const { midi, device } = openFakeDevice();
  await device.open();
  assert.equal(device.isOpen, true);
  assert.equal(device.channel, 1, "channel 1 is MIDI status 0xB0");

  device.setParameter(12, 7); // Amp Model
  assert.deepEqual(midi.lastMessage, [0xb0, 12, 7]);

  device.setParameter(13, 999); // Drive, way past the top of the range
  assert.deepEqual(midi.lastMessage, [0xb0, 13, 126], "clamped to the documented maximum");

  device.setParameter(22, 127); // Noise gate really does go to 127
  assert.deepEqual(midi.lastMessage, [0xb0, 22, 127]);

  device.setParameter(64, 127); // Apply FX to D.I.
  assert.deepEqual(midi.lastMessage, [0xb0, 64, 127]);

  device.sendProgramChange(9);
  assert.deepEqual(midi.lastMessage, [0xc0, 9], "program change goes out on the same channel");

  await device.close();
  assert.equal(device.isOpen, false);
});

test("outbound: every control in the map can actually be sent", async () => {
  const { midi, device } = openFakeDevice();
  await device.open();
  for (const [cc, control] of lookup) {
    const value = Math.min(control.max, Math.max(control.min, 100));
    device.setParameter(cc, value);
    assert.deepEqual(midi.lastMessage, [0xb0, cc, value], `${control.id} (CC ${cc})`);
  }
  await device.close();
});

test("inbound: turning a knob on the pedal moves the matching control", async () => {
  const { midi, device } = openFakeDevice();
  await device.open();
  const received = [];
  device.addParameterChangedListener((d, ccNumber, value, control) =>
    received.push({ ccNumber, value, id: control?.id, group: control?.groupName }));

  midi.emitInbound([0xb0, 12, 5]); // Amp Model -> California
  midi.emitInbound([0xb0, 22, 100]); // Noise Gate
  assert.deepEqual(received, [
    { ccNumber: 12, value: 5, id: "ampModel", group: "Preamp" },
    { ccNumber: 22, value: 100, id: "noiseGate", group: "Noise Gate" },
  ]);

  // Anything the map doesn't know about is reported without blowing up -
  // app.js ignores control changes it has no widget for.
  midi.emitInbound([0xb0, 60, 1]);
  assert.equal(received[2].id, undefined);
  assert.equal(received[2].ccNumber, 60);
  await device.close();
});

test("inbound: program changes are labelled 1A-9D, Manual and Tuner", async () => {
  const { midi, device } = openFakeDevice();
  await device.open();
  const labels = [];
  device.addProgramChangedListener((d, pc, label) => labels.push(`${pc}=${label}`));

  midi.emitInbound([0xc0, 0]); // Manual
  midi.emitInbound([0xc0, 1]); // 1A
  midi.emitInbound([0xc0, 5]); // 2A
  midi.emitInbound([0xc0, 36]); // 9D, the last internal program
  midi.emitInbound([0xc0, 37]); // Tuner
  assert.deepEqual(labels, ["0=Manual", "1=1A", "5=2A", "36=9D", "37=Tuner"]);
  await device.close();
});

test("echo suppression: a control change we just sent is not reported back as the pedal's", async () => {
  let now = 1000;
  const { midi, device } = openFakeDevice({ deviceOptions: { now: () => now } });
  await device.open();
  const received = [];
  device.addParameterChangedListener((d, ccNumber, value) => received.push([ccNumber, value]));

  device.setParameter(13, 40);
  midi.emitInbound([0xb0, 13, 40]); // a loopback of our own message
  assert.deepEqual(received, [], "our own echo is swallowed");

  now += 500; // well past the suppression window
  midi.emitInbound([0xb0, 13, 41]);
  assert.deepEqual(received, [[13, 41]], "a genuine move still gets through");
  await device.close();
});

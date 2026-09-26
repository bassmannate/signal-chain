// Tests for the Bass POD Pro sys-ex program dump path: the byte-level codec in
// renderer/devices/bassPodProSysex.js, and the adapter flow behind the patch
// list (read the names, recall a program, read it back).
//
//   npm test
//
// The dump assertions run against two real captures: a Bass POD Pro (firmware
// 1.40) answering an edit-buffer request (test/fixtures/bass-pod-pro-edit-buffer.txt)
// and answering an all-programs request split across 23 messages
// (test/fixtures/bass-pod-pro-all-programs.txt). README.md says how they were
// taken. Everything else in here is synthesised.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DUMP_TYPE_ALL_PROGRAMS,
  DUMP_TYPE_EDIT_BUFFER,
  DUMP_TYPE_PROGRAM,
  OPCODE_DUMP,
  OPCODE_REQUEST,
  PROGRAM_BYTE_COUNT,
  buildAllProgramsDump,
  buildAllProgramsDumpRequest,
  buildEditBufferDump,
  buildEditBufferDumpRequest,
  buildProgramDump,
  buildProgramDumpRequest,
  decodeNibbles,
  encodeNibbles,
  fieldToStoredValue,
  isDecodableDump,
  parseDumpMessage,
  readBitField,
  readPatchName,
  readProgram,
  readProgramValues,
  splitPrograms,
  storedValueFromCc,
  updateProgramBytesFromCc,
  valueFromField,
  writeBitField,
  writePatchName,
} from "../renderer/devices/bassPodProSysex.js";
import { BassPodProDevice } from "../renderer/devices/BassPodProDevice.js";
import { formatByBands } from "../renderer/ui/controls.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileData = JSON.parse(readFileSync(path.join(repoRoot, "renderer/data/bass-pod-pro.json"), "utf8"));
const layout = profileData.sysexLayout;

/** Every sysex message in a capture file, as arrays of byte values. */
function messagesIn(file) {
  return readFileSync(path.join(repoRoot, "test/fixtures", file), "utf8")
    .split("\n")
    .filter((line) => line.includes("F0"))
    .map((line) => line.slice(line.indexOf("F0")).trim().split(/\s+/).map((hex) => parseInt(hex, 16)));
}

const captured = messagesIn("bass-pod-pro-edit-buffer.txt");
const capturedIdentity = captured.find((m) => m[1] === 0x7e);
const capturedDump = captured.find((m) => m[1] === 0x00);
const capturedProgram = decodeNibbles(capturedDump.slice(8, capturedDump.length - 1));

/**
 * The real all-programs capture, as the pieces it arrived in: a Bass POD Pro
 * sends 5769 bytes as a run of ~256-byte messages, not one big one.
 */
function capturedAllProgramChunks() {
  return readFileSync(path.join(repoRoot, "test/fixtures/bass-pod-pro-all-programs.txt"), "utf8")
    .split("\n")
    .filter((line) => line.includes("exclusive"))
    .map((line) => line.split("exclusive")[1].trim().split(/\s+/).map((hex) => parseInt(hex, 16)));
}

/** The 36 programs from that capture, reassembled the way the app does it. */
function capturedAllPrograms() {
  return splitPrograms(parseDumpMessage(capturedAllProgramChunks().flat()).bytes, layout.programByteCount);
}

/** A dump reply carrying the given program bytes, as the POD sends it. */
function dumpReply({ type, programNumber, programBytes, version = 1 }) {
  const reply = [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x01, type];
  if (type === DUMP_TYPE_PROGRAM) reply.push(programNumber);
  reply.push(version, ...encodeNibbles(programBytes), 0xf7);
  return reply;
}

/** An 80-byte program with a name and a few byte values set. */
function makeProgram(name, fields = {}) {
  const bytes = new Uint8Array(PROGRAM_BYTE_COUNT).fill(0x20, 64, 80); // space-padded name
  for (let i = 0; i < name.length && i < 16; i++) bytes[64 + i] = name.charCodeAt(i);
  for (const [index, value] of Object.entries(fields)) bytes[Number(index)] = value;
  return bytes;
}

/**
 * Answers dump requests with canned replies, the way the POD does - including
 * staying silent when a test asks for something the map has no reply for.
 */
class FakeMIDIProxy {
  constructor(replies = new Map()) {
    this.replies = replies; // dump type -> reply message bytes
    this.sent = [];
    this.listeners = new Map();
    this.inputs = new Map([["in-1", { id: "in-1", name: "Fake MIDI In" }]]);
    this.outputs = new Map([["out-1", { id: "out-1", name: "Fake MIDI Out" }]]);
  }
  async openInput() { return { id: "in-1" }; }
  async openOutput() { return { id: "out-1" }; }
  async closeInput() {}
  async closeOutput() {}
  addListener(id, listener) { this.listeners.set(id, listener); }
  removeListener(id, listener) { if (this.listeners.get(id) === listener) this.listeners.delete(id); }
  sendCC(_id, channel, ccNumber, value) { this.sent.push([0xb0 + channel, ccNumber, value]); }
  sendPC(_id, channel, program) { this.sent.push([0xc0 + channel, program]); }
  send(_id, data) {
    this.sent.push([...data]);
    const parsed = parseDumpMessage(data);
    if (!parsed || parsed.opcode !== OPCODE_REQUEST) return;
    const reply = this.replies.get(parsed.type);
    if (reply) this.emitInbound(reply);
  }
  emitInbound(bytes) {
    for (const listener of this.listeners.values()) listener("in-1", Uint8Array.from(bytes));
  }
  get lastMessage() { return this.sent[this.sent.length - 1]; }
}

async function openFakeDevice(replies, options = {}) {
  const midi = new FakeMIDIProxy(replies);
  const device = new BassPodProDevice(
    midi,
    { inputID: "in-1", outputID: "out-1" },
    profileData,
    { dumpTimeoutMs: 50, ...options },
  );
  await device.open();
  return { midi, device };
}

// --- The capture these tests lean on ---------------------------------------

test("fixture: a real POD answered the identity request and a dump request", () => {
  assert.equal(captured.length, 2, "an identity reply plus one program dump");

  assert.equal(capturedIdentity.length, 17, "a 3-byte manufacturer ID gives the 17-byte form");
  assert.deepEqual(capturedIdentity.slice(0, 5), [0xf0, 0x7e, 0x7f, 0x06, 0x02]);
  assert.deepEqual(capturedIdentity.slice(5, 8), [0x00, 0x01, 0x0c], "manufacturer: Line 6");
  assert.equal(String.fromCharCode(...capturedIdentity.slice(12, 16)), "0140", "firmware 1.40");

  const parsed = parseDumpMessage(Uint8Array.from(capturedDump));
  assert.equal(parsed.opcode, 0x01, "a reply, not a request");
  assert.equal(parsed.type, DUMP_TYPE_EDIT_BUFFER);
  assert.equal(parsed.version, 1, "the data format version, not the firmware revision");
  assert.equal(parsed.nibbles.length, 160);
  assert.equal(parsed.byteCount, PROGRAM_BYTE_COUNT);
});

test("requests: the exact envelope the PDF documents", () => {
  assert.deepEqual([...buildEditBufferDumpRequest()], [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x00, 0x01, 0xf7]);
  assert.deepEqual([...buildAllProgramsDumpRequest()], [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x00, 0x02, 0xf7]);
  assert.deepEqual([...buildProgramDumpRequest(0)], [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x00, 0x00, 0x00, 0xf7], "1A");
  assert.deepEqual([...buildProgramDumpRequest(35)], [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x00, 0x00, 0x23, 0xf7], "9D is 0x23");
});

test("nibbles: high nibble first, and the capture round-trips", () => {
  assert.deepEqual([...encodeNibbles([0x8f, 0x01])], [0x08, 0x0f, 0x00, 0x01]);
  assert.deepEqual([...decodeNibbles([0x08, 0x0f, 0x00, 0x01])], [0x8f, 0x01]);
  assert.deepEqual([...decodeNibbles(encodeNibbles(capturedProgram))], [...capturedProgram]);
  assert.deepEqual([...decodeNibbles([0x01, 0x02, 0x03])], [0x12], "a stray nibble is dropped, not shifted");
});

test("parseDumpMessage only claims messages that really are POD dumps", () => {
  assert.equal(parseDumpMessage(Uint8Array.from(capturedIdentity)), undefined, "identity replies are miditools.js's job");
  assert.equal(parseDumpMessage(Uint8Array.from([0xf0, 0x52, 0x00, 0x00, 0x00, 0xf7])), undefined, "a Zoom pedal");
  assert.equal(parseDumpMessage(Uint8Array.from([0xf0, 0x00, 0x01, 0x0c, 0x02, 0x01, 0x01])), undefined, "no EOX");
  assert.equal(parseDumpMessage(Uint8Array.from([0xb0, 12, 5])), undefined, "not sys-ex at all");

  const echoedRequest = parseDumpMessage(buildEditBufferDumpRequest());
  assert.equal(echoedRequest.opcode, OPCODE_REQUEST);
  assert.equal(isDecodableDump(echoedRequest), false, "our own request coming back is not a dump");
  assert.equal(isDecodableDump(parseDumpMessage(Uint8Array.from(capturedDump))), true);
});

// --- What a program dump says ----------------------------------------------

test("a real program decodes into the panel's control values", () => {
  const { name, values } = readProgram(capturedProgram, layout);
  assert.equal(name, "Eighties", "the patch the POD was playing, straight out of the dump");

  // Every number comes from that capture; the comment names the program byte
  // behind it, so a decode bug points at the byte that moved.
  const expected = [
    [12, 5],   // amp model, byte 3 (4 bits) -> 5 is the "Eighties" model
    [13, 26],  // drive, byte 4 = 13 stored, x2
    [14, 70],  // bass, byte 6 = 35 stored, x2
    [15, 66],  // middle, byte 7 = 33 stored, x2
    [16, 112], // treble, byte 8 = 56 stored, x2
    [17, 126], // channel volume, byte 10 = 63 -> the top of the control's range
    [18, 0],   // compress, byte 11
    [28, 64],  // mid sweep, byte 12 = 32 -> centre
    [25, 64],  // parametric frequency, byte 13 = 32 -> centre
    [26, 64],  // parametric Q, byte 14
    [27, 64],  // parametric gain, byte 15
    [71, 0],   // cabinet, byte 31 (4 bits) -> the first cabinet in the table
    [9, 0],    // digital output level, byte 33
    [19, 10],  // effect select, byte 49 (4 bits)
    [1, 0],    // effect tweak, byte 50
    [21, 0],   // fx lo-cut, byte 51
    [22, 64],  // noise gate: byte 0 bit 0 is set, and a dump only says on/off
    [64, 0],   // apply FX to D.I.: byte 2 bit 0 clear
    [60, 127], // effect on/off: byte 52 bit 0 set
    [23, 13],  // gate threshold, byte 16 - a parameter the CC map has no knob for
    [42, 30],  // compressor ratio, byte 25: 25-49 is 3.3:1
    [7, 127],  // volume pedal, byte 22
    [45, 127], // wah top frequency, byte 20
    [74, 124], // D.I. time alignment: byte 34 is 0xFE, only bits 5-0 are ours
  ];
  for (const [cc, value] of expected) {
    const field = layout.fields.find((f) => f.cc === cc);
    assert.equal(values.get(cc), value, `CC ${cc} (${field?.id})`);
  }
});

test("the field map covers every control the panel shows, inside the 80 bytes", () => {
  const controls = profileData.groups
    .flatMap((group) => group.controls)
    .filter((control) => control.cc !== undefined);

  assert.ok(controls.length > 0);
  for (const control of controls) {
    assert.ok(layout.fields.some((field) => field.cc === control.cc), `${control.id} (CC ${control.cc}) has no dump field`);
  }
  for (const field of layout.fields) {
    assert.equal(typeof field.cc, "number", `${field.id} needs a control-change number`);
    assert.ok(field.byte >= 0 && field.byte < layout.programByteCount, `${field.id}: byte ${field.byte}`);
    if (field.bits) {
      assert.ok(field.bits[0] <= 7 && field.bits[1] >= 0 && field.bits[0] >= field.bits[1], `${field.id}: bits ${field.bits}`);
    }
  }
});

test("stored values convert the way the panel sends control changes", () => {
  assert.equal(storedValueFromCc(126, 2), 63, "the top of a 0-126 range is the top of a 6-bit field");
  assert.equal(storedValueFromCc(1, 2), 1, "1 rounds up rather than collapsing to 0");
  assert.equal(storedValueFromCc(64, 1), 64, "7-bit parameters are stored as they are sent");

  const channelVolume = { mode: "scale", scale: 2, byte: 10, bits: [5, 0] };
  assert.equal(valueFromField(channelVolume, capturedProgram, { max: 126 }), 126, "byte 10 holds 63 -> the panel shows 126");
  assert.equal(valueFromField(channelVolume, makeProgram("x", { 10: 0 }), { max: 126 }), 0);
});

test("bit fields read the way the PDF's MSb/LSb columns are written", () => {
  assert.equal(readBitField(0x0a, [3, 0]), 10);
  assert.equal(readBitField(0xfe, [5, 0]), 62, "unused high bits are ignored");
  assert.equal(readBitField(0x20, [5, 0]), 32);
  assert.equal(readBitField(0x0f, undefined), 0x0f, "no field means the whole byte");

  const diSwitch = { mode: "bit", byte: 2, bits: [0, 0] };
  assert.equal(valueFromField(diSwitch, makeProgram("x", { 2: 1 }), { onValue: 127, offValue: 0 }), 127);
  assert.equal(valueFromField(diSwitch, makeProgram("x", { 2: 0 }), { onValue: 127, offValue: 0 }), 0);
});

test("an all-programs dump is 36 programs in program-change order", () => {
  const bytes = new Uint8Array(36 * PROGRAM_BYTE_COUNT);
  for (let i = 0; i < 36; i++) bytes.set(makeProgram(`Patch ${i + 1}`, { 3: i & 0x0f }), i * PROGRAM_BYTE_COUNT);

  const reply = dumpReply({ type: DUMP_TYPE_ALL_PROGRAMS, programBytes: bytes });
  assert.equal(reply.length, 7 + 1 + 36 * PROGRAM_BYTE_COUNT * 2 + 1, "header, version, 5760 nibbles, EOX");

  const parsed = parseDumpMessage(Uint8Array.from(reply));
  assert.equal(parsed.byteCount, 2880, "2880 bytes = 36 x 80");
  assert.equal(parsed.programNumber, undefined, "an all-programs dump names no program");

  const programs = splitPrograms(parsed.bytes, layout.programByteCount);
  assert.equal(programs.length, 36);
  assert.equal(readProgram(programs[0], layout).name, "Patch 1");
  assert.equal(readProgram(programs[35], layout).name, "Patch 36");
  assert.equal(readProgramValues(programs[35], layout).get(12), 35 & 0x0f, "9D's amp model");
});

// --- The adapter flow behind the patch list --------------------------------

/** An all-programs reply whose programs are named "Patch 1" .. "Patch 36". */
function allProgramsReply() {
  const bytes = new Uint8Array(36 * PROGRAM_BYTE_COUNT);
  for (let i = 0; i < 36; i++) bytes.set(makeProgram(`Patch ${i + 1}`), i * PROGRAM_BYTE_COUNT);
  return dumpReply({ type: DUMP_TYPE_ALL_PROGRAMS, programBytes: bytes });
}

test("reading the patch list asks for all programs and labels them 1A-9D", async () => {
  const replies = new Map([[DUMP_TYPE_ALL_PROGRAMS, allProgramsReply()]]);
  const { midi, device } = await openFakeDevice(replies);

  const listed = await device.requestProgramNames();
  assert.deepEqual(midi.sent[0], [...buildAllProgramsDumpRequest()], "one message, not 36 requests");
  assert.equal(listed.length, 36);
  assert.deepEqual(listed[0], { programNumber: 0, programChangeNumber: 1, label: "1A", name: "Patch 1" });
  assert.deepEqual(listed[35], { programNumber: 35, programChangeNumber: 36, label: "9D", name: "Patch 36" });
  assert.deepEqual(device.programs, listed, "the list is cached for the UI");
  await device.close();
});

test("the patch list listener fires with the names, and again when one changes", async () => {
  const replies = new Map([
    [DUMP_TYPE_ALL_PROGRAMS, allProgramsReply()],
    [DUMP_TYPE_PROGRAM, dumpReply({ type: DUMP_TYPE_PROGRAM, programNumber: 2, programBytes: makeProgram("Renamed") })],
  ]);
  const { device } = await openFakeDevice(replies);

  const seen = [];
  device.addProgramListChangedListener((d, programs) => seen.push(programs.map((p) => p.name).slice(0, 3)));
  await device.requestProgramNames();
  assert.deepEqual(seen, [["Patch 1", "Patch 2", "Patch 3"]]);

  // Reading one program keeps the list's name for it in step. requestProgramDump()
  // takes a program number, so 2 is 1C - the third row.
  await device.requestProgramDump(2);
  assert.deepEqual(seen[1], ["Patch 1", "Patch 2", "Renamed"]);
  assert.equal(device.programs[2].name, "Renamed");
  assert.equal(device.programs[1].name, "Patch 2", "its neighbours are untouched");
  await device.close();
});

test("clicking a patch recalls it on the POD and reads it back", async () => {
  const program = makeProgram("Heavy", { 3: 5, 4: 20 }); // Eighties amp, drive 20
  const replies = new Map([
    [DUMP_TYPE_PROGRAM, dumpReply({ type: DUMP_TYPE_PROGRAM, programNumber: 4, programBytes: program })],
  ]);
  const { midi, device } = await openFakeDevice(replies);

  const loadedEvents = [];
  device.addProgramLoadedListener((d, payload) => loadedEvents.push(payload));

  const loaded = await device.loadProgram(4); // program 4 == 2A
  assert.deepEqual(midi.sent[0], [0xc0, 5], "program change 5 is 2A");
  assert.deepEqual(midi.sent[1], [...buildProgramDumpRequest(4)]);

  assert.equal(loaded.programNumber, 4);
  assert.equal(loaded.label, "2A");
  assert.equal(loaded.name, "Heavy");
  assert.equal(loaded.values.get(12), 5);
  assert.equal(loaded.values.get(13), 40, "drive is stored as 20 and reported doubled");

  assert.equal(loadedEvents.length, 1, "the payload reaches the UI through the listener");
  assert.equal(loadedEvents[0].label, "2A");
  await device.close();
});

test("the edit buffer comes back labelled with the program the POD reported", async () => {
  const replies = new Map([
    [DUMP_TYPE_EDIT_BUFFER, dumpReply({ type: DUMP_TYPE_EDIT_BUFFER, programBytes: capturedProgram })],
  ]);
  const { midi, device } = await openFakeDevice(replies);

  const loaded = await device.requestEditBufferDump();
  assert.equal(loaded.name, "Eighties");
  assert.equal(loaded.values.get(17), 126);
  assert.equal(loaded.programNumber, undefined, "the edit buffer carries no program number");
  assert.equal(loaded.label, undefined, "and nothing has told the app which program is playing yet");

  // Once a program change has been sent, the label is known - and the app can
  // tell its own moves from the pedal's.
  device.sendProgramChange(1);
  assert.equal(device.currentProgramChangeNumber, 1);
  assert.equal(device.lastSentProgramChangeNumber, 1);
  const second = await device.requestEditBufferDump();
  assert.equal(second.label, "1A");

  // A program change the pedal sends from its own front panel moves the
  // current program, but must not look like one the app sent - that is what
  // stops app.js from skipping the read it needs to do.
  midi.emitInbound([0xc0, 9]);
  assert.equal(device.currentProgramChangeNumber, 9, "the pedal moved to 3A");
  assert.equal(device.lastSentProgramChangeNumber, 1, "and we still know what we last sent");
  await device.close();
});

test("a program change the app sent is not reported straight back as the pedal's", async () => {
  let now = 1000;
  const { midi, device } = await openFakeDevice(new Map(), { now: () => now });
  const reported = [];
  device.addProgramChangedListener((d, pc, label) => reported.push(`${pc}=${label}`));

  device.sendProgramChange(5); // asking for 2A
  midi.emitInbound([0xc0, 5]); // ...and it comes straight back
  assert.deepEqual(reported, [], "our own program change is swallowed");
  assert.equal(device.currentProgramChangeNumber, 5, "but the app still knows where the POD is");

  now += 500; // well past the suppression window
  midi.emitInbound([0xc0, 5]);
  assert.deepEqual(reported, ["5=2A"], "a change that arrives later is the pedal's own");

  midi.emitInbound([0xc0, 1]);
  assert.deepEqual(reported, ["5=2A", "1=1A"]);
  assert.equal(device.currentProgramChangeNumber, 1);
  await device.close();
});

test("a POD that never answers times out instead of hanging the app", async () => {
  const { device } = await openFakeDevice(new Map());
  assert.equal(await device.requestProgramNames(), undefined);
  assert.equal(await device.requestProgramDump(0), undefined);
  assert.equal(await device.requestEditBufferDump(), undefined);
  assert.deepEqual(device.programs, [], "no list rather than a made-up one");
  await device.close();
});

test("a truncated dump is ignored rather than read as a program of zeros", async () => {
  const half = makeProgram("cut short").slice(0, PROGRAM_BYTE_COUNT / 2);
  const replies = new Map([[DUMP_TYPE_EDIT_BUFFER, dumpReply({ type: DUMP_TYPE_EDIT_BUFFER, programBytes: half })]]);
  const { device } = await openFakeDevice(replies);

  const loaded = await device.requestEditBufferDump();
  assert.equal(loaded, undefined, "the app would rather have nothing than invented values");
  await device.close();
});

// --- Chunked dumps ---------------------------------------------------------

test("fixture: real hardware sends the all-programs reply in chunks, not one message", () => {
  const chunks = capturedAllProgramChunks();

  assert.ok(chunks.length > 5, `expected a run of messages, got ${chunks.length}`);
  assert.ok(chunks.every((chunk) => chunk.length <= 256), "no chunk is longer than ALSA's 256-byte sys-ex limit");

  const bytes = chunks.flat();
  assert.equal(bytes.length, 7 + 1 + 36 * PROGRAM_BYTE_COUNT * 2 + 1, "header, version, 5760 nibbles, EOX");
  assert.equal(bytes[0], 0xf0, "only the first chunk carries the F0 status byte");
  assert.equal(bytes[bytes.length - 1], 0xf7, "only the last chunk carries the end-of-exclusive");
  assert.equal(bytes.filter((byte) => byte === 0xf0).length, 1);
  assert.equal(bytes.filter((byte) => byte === 0xf7).length, 1);

  const parsed = parseDumpMessage(bytes);
  assert.equal(parsed.opcode, 0x01);
  assert.equal(parsed.type, DUMP_TYPE_ALL_PROGRAMS);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.byteCount, 2880);
  assert.equal(splitPrograms(parsed.bytes, layout.programByteCount).length, 36);
});

test("a dump that arrives in pieces is stitched back together by the adapter", async () => {
  const reply = allProgramsReply();
  const chunks = [];
  for (let i = 0; i < reply.length; i += 256) chunks.push(reply.slice(i, i + 256));
  assert.ok(chunks.length > 5, "the fake reply is split the way the POD splits it");

  const { midi, device } = await openFakeDevice(new Map());
  const knobMoves = [];
  device.addParameterChangedListener((d, ccNumber, value) => knobMoves.push([ccNumber, value]));

  const pending = device.requestProgramNames();
  for (const [index, chunk] of chunks.entries()) {
    if (index === 3) midi.emitInbound([0xb0, 13, 40]); // a knob moves mid-dump
    midi.emitInbound(chunk);
  }

  const listed = await pending;
  assert.equal(listed.length, 36);
  assert.equal(listed[0].name, "Patch 1");
  assert.equal(listed[35].name, "Patch 36");
  assert.deepEqual(knobMoves, [[13, 40]], "control changes still get through while a dump is arriving");
  await device.close();
});

test("a dump that never finished doesn't corrupt the next one", async () => {
  const { midi, device } = await openFakeDevice(new Map());

  midi.emitInbound(allProgramsReply().slice(0, 100)); // cut off mid-message
  const pending = device.requestEditBufferDump();
  midi.emitInbound(dumpReply({ type: DUMP_TYPE_EDIT_BUFFER, programBytes: capturedProgram }));

  const loaded = await pending;
  assert.equal(loaded.name, "Eighties", "the half-message was dropped, not glued to the front");
  await device.close();
});

// --- The real all-programs capture, checked against the profile's tables ----

test("fixture: the patch names, amp codes, cabinet codes and effect codes agree", () => {
  const programs = capturedAllPrograms();
  const programAt = (index) => readProgram(programs[index], layout);
  const tables = profileData.valueTables;

  // Each of these programs is named after the model it was built from, which is
  // how these tables were checked against hardware. CC 12 is the amp model, CC
  // 71 the cabinet, CC 19 the effect, CC 60 effect on/off.
  const checks = [
    [0, "Star Spangled Ja", 7, 15],
    [12, "Eighties", 5, 0],
    [20, "Rock Classic", 8, 11],
    [31, "Jazz Tone", 3, 6],
    [35, "Amp 360", 7, 15],
  ];
  for (const [index, name, ampCode, cabinetCode] of checks) {
    const program = programAt(index);
    assert.equal(program.name, name, `program ${index}'s name`);
    assert.equal(program.values.get(12), ampCode, `${name}: amp model code`);
    assert.equal(program.values.get(71), cabinetCode, `${name}: cabinet code`);
    assert.ok(tables.ampModels[ampCode]?.name, `the amp table has no entry ${ampCode}`);
    assert.ok(tables.cabinets[cabinetCode]?.name, `the cabinet table has no entry ${cabinetCode}`);
  }

  assert.equal(tables.ampModels[3].name, "Jazz Tone");
  assert.equal(tables.cabinets[6].name, "1x15 Polytone Mini-Brute", "the cabinet that goes with the Jazz Tone amp");
  assert.equal(tables.cabinets[11].name, "8x10 Ampeg SVT", "and the one that goes with Rock Classic");

  // The effect codes are why valueTables.effects is ordered the way it is: the
  // program called "Jaco clean chorus" stores 9, which the POD's own effect
  // table calls Analog Chorus, and "Jaco Tone" stores the same 9 with the
  // effect switched off.
  assert.equal(tables.effects[9].name, "Analog Chorus");
  assert.equal(programAt(1).values.get(19), 9, "Jaco clean chorus");
  assert.equal(programAt(1).values.get(60), 127, "with the effect on");
  assert.equal(programAt(2).values.get(19), 9, "Jaco Tone uses the same effect");
  assert.equal(programAt(2).values.get(60), 0, "switched off");

  const bypassed = programs.filter((program) => readProgramValues(program, layout).get(19) === 10);
  assert.equal(bypassed.length, 26, "26 of the 36 programs are Bypass");
  assert.equal(tables.effects[10].name, "Bypass");
});

test("fixture: every program decodes inside the documented ranges", () => {
  for (const [index, program] of capturedAllPrograms().entries()) {
    const values = readProgramValues(program, layout);
    for (const field of layout.fields) {
      const value = values.get(field.cc);
      assert.ok(value >= 0 && value <= 127, `program ${index}, ${field.id} = ${value}`);
      if (field.mode === "scale") {
        assert.ok(value <= 126, `program ${index}, ${field.id} = ${value}: a 6-bit field doubled stays inside 0-126`);
      }
      if (field.mode === "value" && field.bits) {
        const width = field.bits[0] - field.bits[1] + 1;
        assert.ok(value < 2 ** width, `program ${index}, ${field.id} = ${value} exceeds its ${width}-bit field`);
      }
    }
  }
});

test("fixture: the compressor and AIR parameters decode from real programs", () => {
  const programs = capturedAllPrograms();
  const valuesAt = (index) => readProgramValues(programs[index], layout);

  // CC 18 Compress (the front-panel knob), 42 Ratio, 51 Attack, 63 Release and
  // 72 AIR level. The POD never transmits any of these - its sys-ex document
  // marks the compressor parameters NO TRANSMIT and AIR has no front-panel knob
  // at all - so a dump is the only way the panel can ever learn them.
  const expected = [
    [0, "Star Spangled Ja", 46, 50, 94, 57, 68],
    [1, "Jaco clean choru", 102, 78, 51, 57, 68],
    [2, "Jaco Tone", 126, 0, 94, 57, 68],
    [12, "Eighties", 110, 30, 83, 57, 64],
    [35, "Amp 360", 0, 30, 83, 57, 64],
  ];
  for (const [index, name, compress, ratio, attack, release, air] of expected) {
    const values = valuesAt(index);
    assert.equal(readProgram(programs[index], layout).name, name);
    assert.equal(values.get(18), compress, `${name}: compress`);
    assert.equal(values.get(42), ratio, `${name}: ratio`);
    assert.equal(values.get(51), attack, `${name}: attack`);
    assert.equal(values.get(63), release, `${name}: release`);
    assert.equal(values.get(72), air, `${name}: AIR level`);
  }

  // Ratio and attack reach past 63 in this capture, which only works because
  // those two are stored in 7 bits and read back as-is - no doubling.
  const attacks = programs.map((program) => readProgramValues(program, layout).get(51));
  const ratios = programs.map((program) => readProgramValues(program, layout).get(42));
  assert.ok(Math.max(...attacks) > 63, `attack tops out at ${Math.max(...attacks)}`);
  assert.ok(Math.max(...ratios) > 63, `ratio tops out at ${Math.max(...ratios)}`);

  // AIR is 6-bit stored and doubled on the way out, so it can never pass 126.
  const airLevels = programs.map((program) => readProgramValues(program, layout).get(72));
  assert.equal(Math.max(...airLevels), 68, "the highest AIR level in this capture");
});

test("fixture: the ratio readout names the band the POD would show", () => {
  const control = profileData.groups
    .flatMap((group) => group.controls)
    .find((c) => c.id === "compRatio");
  assert.ok(control?.valueBands, "the ratio control declares its bands in the profile");

  const named = capturedAllPrograms()
    .map((program) => readProgramValues(program, layout).get(42))
    .map((value) => formatByBands(value, control.valueBands));

  // Real stored values, including ones that fall between the band edges - which
  // is the whole reason the knob sends what it holds instead of snapping.
  assert.equal(named[0], "8:1", "1A stores 50, exactly the 8:1 edge");
  assert.equal(named[1], "12:1 (78)", "1B stores 78, inside the 12:1 band");
  assert.equal(named[12], "3.3:1 (30)", "the 'Eighties' program stores 30, inside 3.3:1");

  assert.deepEqual([...new Set(named)].sort(), [
    "12:1 (78)", "2:1", "2:1 (1)", "3.3:1 (30)", "3.3:1 (32)", "8:1", "Inf:1 (104)",
  ].sort(), "every ratio in the capture lands in a band the POD names");
});

// --- Writing programs back ---------------------------------------------------
//
// The read side has always worked; these cover the write side, which is what
// Save/Load/Backup/Restore and renaming need.

test("writePatchName writes 16 space-padded ASCII characters the reader takes back", () => {
  const bytes = makeProgram("Eighties");

  writePatchName(bytes, "Renamed", layout);
  assert.equal(readPatchName(bytes, layout), "Renamed");
  // The PDF lists the name as 16 ASCII characters; real hardware pads them
  // with spaces rather than leaving zeros or the tail of the old name.
  assert.equal(bytes[64 + 7], 0x20, "the byte after the name is a space");
  assert.equal(bytes[64 + 15], 0x20, "the last name byte is a space");

  // Shortening must blank the tail of the old name instead of leaving it.
  writePatchName(bytes, "Ab", layout);
  assert.equal(readPatchName(bytes, layout), "Ab");
  assert.equal(bytes[66], 0x20, "the rest of the old name is cleared");

  // Longer than 16 characters is cut at the field's width, not beyond it.
  writePatchName(bytes, "0123456789ABCDEFEXTRA", layout);
  assert.equal(readPatchName(bytes, layout), "0123456789ABCDEF");
  assert.equal(bytes[80], undefined, "the name stops at byte 79");

  // Anything the POD's display cannot show becomes a space, never a zero -
  // readPatchName stops at a zero byte and would truncate the name there.
  writePatchName(bytes, "A\u0000B\u00ffC", layout);
  assert.equal(readPatchName(bytes, layout), "A B C");
});

test("writeBitField and fieldToStoredValue undo readBitField and valueFromField", () => {
  assert.equal(writeBitField(0b11110000, [3, 0], 0b1010), 0b11111010, "bits outside the field survive");
  assert.equal(writeBitField(0b11110000, [7, 4], 0b0011), 0b00110000);
  assert.equal(writeBitField(0xff, undefined, 0x05), 0x05, "no field means the whole byte");
  assert.equal(readBitField(writeBitField(0, [5, 0], 63), [5, 0]), 63);

  // A 6-bit scale-2 field: the panel's 0-126 range is stored as 0-63.
  const channelVolume = { mode: "scale", scale: 2, byte: 10, bits: [5, 0] };
  assert.equal(fieldToStoredValue(channelVolume, 126), 63, "the top of the range");
  assert.equal(fieldToStoredValue(channelVolume, 0), 0);
  assert.equal(fieldToStoredValue(channelVolume, 63), 32, "odd control values round up");

  const program = new Uint8Array(PROGRAM_BYTE_COUNT);
  program[10] = writeBitField(program[10], channelVolume.bits, fieldToStoredValue(channelVolume, 126));
  assert.equal(valueFromField(channelVolume, program, { max: 126 }), 126);

  // A switch stores one bit and reads back as the control's on/off values.
  const noiseGate = { mode: "bit", byte: 0, bits: [0, 0], offValue: 0, onValue: 64 };
  assert.equal(fieldToStoredValue(noiseGate, 64), 1, "the PDF: 64-127 is on");
  assert.equal(fieldToStoredValue(noiseGate, 63), 0, "0-63 is off");
  assert.equal(fieldToStoredValue(noiseGate, 127), 1);
  program[0] = writeBitField(program[0], noiseGate.bits, fieldToStoredValue(noiseGate, 100));
  assert.equal(valueFromField(noiseGate, program, noiseGate), 64);

  // The other switch pairs 0 with 127 but still switches at 64, the same
  // boundary the gate uses - not at the midpoint of the two values.
  const applyFxToDi = { mode: "bit", byte: 2, bits: [0, 0], offValue: 0, onValue: 127 };
  assert.equal(fieldToStoredValue(applyFxToDi, 63), 0);
  assert.equal(fieldToStoredValue(applyFxToDi, 64), 1);
  assert.equal(fieldToStoredValue(applyFxToDi, 127), 1);
});

test("updateProgramBytesFromCc writes a control change into the byte its field names", () => {
  const bytes = makeProgram("x");

  assert.equal(updateProgramBytesFromCc(bytes, layout, 17, 126), true, "channel volume, CC 17");
  assert.equal(bytes[10], 63, "byte 10 is 6 bits - stored * 2 is the control change");
  assert.equal(readProgramValues(bytes, layout).get(17), 126, "and reads back at the top of its range");

  assert.equal(updateProgramBytesFromCc(bytes, layout, 12, 9), true, "amp model, CC 12");
  assert.equal(bytes[3], 9, "byte 3 holds the amp model directly");

  assert.equal(updateProgramBytesFromCc(bytes, layout, 999, 5), false, "a CC with no field changes nothing");
});

test("the upload dump messages match the envelopes in the Line 6 document", () => {
  const program = makeProgram("Eighties");

  const programDump = buildProgramDump(2, program, 1);
  assert.equal(programDump.length, 8 + 1 + 160 + 1, "header, program #, version, 160 nibbles, EOX");
  assert.deepEqual([...programDump.slice(0, 9)],
    [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x01, 0x00, 0x02, 0x01],
    "F0 00 01 0C 02 01 00 <program #> <version>");

  const parsedProgram = parseDumpMessage(programDump);
  assert.equal(parsedProgram.opcode, OPCODE_DUMP, "opcode 01 is a dump, not a request");
  assert.equal(parsedProgram.type, DUMP_TYPE_PROGRAM);
  assert.equal(parsedProgram.programNumber, 2);
  assert.equal(parsedProgram.version, 1, "version 1 is what the POD expects");
  assert.equal(parsedProgram.byteCount, PROGRAM_BYTE_COUNT);
  assert.deepEqual([...parsedProgram.bytes], [...program], "the program survives the round trip");

  const editDump = buildEditBufferDump(program, 1);
  assert.equal(editDump.length, 7 + 1 + 160 + 1, "header, version, 160 nibbles, EOX");
  assert.deepEqual([...editDump.slice(0, 8)],
    [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x01, 0x01, 0x01],
    "F0 00 01 0C 02 01 01 <version>");
  const parsedEdit = parseDumpMessage(editDump);
  assert.equal(parsedEdit.type, DUMP_TYPE_EDIT_BUFFER);
  assert.equal(parsedEdit.programNumber, undefined, "the edit buffer names no program");
  assert.deepEqual([...parsedEdit.bytes], [...program]);

  const all = buildAllProgramsDump(new Uint8Array(36 * PROGRAM_BYTE_COUNT), 1);
  assert.equal(all.length, 7 + 1 + 5760 + 1, "header, version, 5760 nibbles, EOX");
  const parsedAll = parseDumpMessage(all);
  assert.equal(parsedAll.type, DUMP_TYPE_ALL_PROGRAMS);
  assert.equal(parsedAll.byteCount, 36 * PROGRAM_BYTE_COUNT, "2880 bytes = 36 x 80");

  // Requests and dumps share the manufacturer and family; only the opcode differs.
  assert.deepEqual([...buildProgramDumpRequest(2).slice(0, 5)], [...programDump.slice(0, 5)]);
  assert.equal(parseDumpMessage(buildProgramDumpRequest(2)).opcode, OPCODE_REQUEST);
});

test("the all-programs dump keeps the bytes as well as the names, for Backup All", async () => {
  const { device } = await openFakeDevice(new Map([[DUMP_TYPE_ALL_PROGRAMS, allProgramsReply()]]));

  const programs = await device.requestProgramNames();
  assert.equal(programs.length, 36);
  assert.equal(device.storedProgramBytes.length, 36, "every slot has its bytes to write to disk");
  for (let i = 0; i < 36; i++) {
    assert.equal(device.storedProgramBytes[i].length, PROGRAM_BYTE_COUNT);
    assert.equal(readPatchName(device.storedProgramBytes[i], layout), `Patch ${i + 1}`);
  }
  await device.close();
});

test("renaming a program writes the name into the bytes and the patch list", async () => {
  const replies = new Map([
    [DUMP_TYPE_ALL_PROGRAMS, allProgramsReply()],
    [DUMP_TYPE_PROGRAM, dumpReply({ type: DUMP_TYPE_PROGRAM, programNumber: 2, programBytes: makeProgram("Old Name") })],
  ]);
  const { device } = await openFakeDevice(replies);

  await device.requestProgramNames();
  const loaded = await device.loadProgram(2);
  assert.equal(loaded.name, "Old Name");
  assert.equal(device.activeProgramNumber, 2);
  assert.equal(device.currentProgramName, "Old Name");

  device.renameCurrentProgram("New Name");

  assert.equal(readPatchName(device.currentProgramBytes, layout), "New Name",
    "bytes 64-79 carry the name, the only place the POD stores it");
  assert.equal(device.currentProgramName, "New Name");
  assert.equal(device.programs[2].name, "New Name", "the sidebar follows");
  assert.equal(device.programs[1].name, "Patch 2", "the neighbours are untouched");

  // Panel edits live in the current bytes but must not rewrite what the POD
  // has stored, or Backup All would save unsaved knobs as if they were stored.
  device.setParameter(17, 126);
  assert.equal(readProgramValues(device.currentProgramBytes, layout).get(17), 126, "the buffer took the knob");
  assert.equal(readProgramValues(device.storedProgramBytes[2], layout).get(17),
    readProgramValues(makeProgram("Old Name"), layout).get(17),
    "the stored copy did not");
  await device.close();
});

test("uploading a program sends the dump message the POD expects and updates the list", async () => {
  const replies = new Map([[DUMP_TYPE_ALL_PROGRAMS, allProgramsReply()]]);
  const { midi, device } = await openFakeDevice(replies);
  await device.requestProgramNames();
  midi.sent.length = 0;

  const program = makeProgram("Restored");
  const ok = await device.uploadProgramToSlot(3, program);

  assert.equal(ok, true);
  assert.deepEqual(midi.lastMessage, [...buildProgramDump(3, program, layout.version ?? 1)],
    "the exact bytes that go on the wire");
  assert.equal(device.programs[3].name, "Restored", "the sidebar shows the new name");
  assert.deepEqual([...device.storedProgramBytes[3]], [...program], "the backup cache follows the write");
  assert.notEqual(device.storedProgramBytes[3], program,
    "by copy, not by reference - later edits must not alias the cache");

  assert.equal(await device.uploadProgramToSlot(36, program), false, "there is no slot 37");
  await device.close();
});

test("uploading the edit buffer repaints the panel and lets go of the stored slot", async () => {
  const replies = new Map([
    [DUMP_TYPE_ALL_PROGRAMS, allProgramsReply()],
    [DUMP_TYPE_PROGRAM, dumpReply({ type: DUMP_TYPE_PROGRAM, programNumber: 2, programBytes: makeProgram("Playing") })],
    [DUMP_TYPE_EDIT_BUFFER, dumpReply({ type: DUMP_TYPE_EDIT_BUFFER, programBytes: makeProgram("Playing") })],
  ]);
  const { midi, device } = await openFakeDevice(replies);
  const seen = [];
  device.addProgramLoadedListener((d, payload) => seen.push(payload));

  await device.requestProgramNames();
  await device.loadProgram(2);
  assert.equal(device.activeProgramNumber, 2, "clicking a program selects it");
  assert.equal(seen.length, 1, "the real dump fired the listener once");
  midi.sent.length = 0;

  // Loading a file: the bytes belong to no stored slot, so the selection goes.
  const program = makeProgram("From File");
  assert.equal(await device.uploadEditBuffer(program), true);
  assert.deepEqual(midi.lastMessage, [...buildEditBufferDump(program, layout.version ?? 1)]);
  assert.equal(device.activeProgramNumber, null, "the edit buffer belongs to no slot");
  assert.equal(seen.length, 2, "the upload repaints the panel like a real dump would");
  assert.equal(seen[1].name, "From File");
  assert.deepEqual([...seen[1].values.entries()], [...readProgramValues(program, layout).entries()],
    "every control the dump describes is repainted");

  // A slot's own contents pushed back by Restore to Slot keep the selection.
  device.activeProgramNumber = 2;
  assert.equal(await device.uploadEditBuffer(program, { keepActiveProgram: true }), true);
  assert.equal(device.activeProgramNumber, 2, "a slot's contents written back are still that slot");
  await device.close();
});

import { MessageType } from "../lib/midiproxy.js";
import { getChannelMessage } from "../lib/miditools.js";
import { shouldLog, LogLevel, log } from "../lib/Logger.js";
import {
    DUMP_TYPE_ALL_PROGRAMS,
    DUMP_TYPE_EDIT_BUFFER,
    DUMP_TYPE_PROGRAM,
    PROGRAM_BYTE_COUNT,
    SYSEX_END,
    SYSEX_START,
    buildAllProgramsDumpRequest,
    buildEditBufferDump,
    buildEditBufferDumpRequest,
    buildProgramDump,
    buildProgramDumpRequest,
    isDecodableDump,
    parseDumpMessage,
    readPatchName,
    readProgram,
    splitPrograms,
    updateProgramBytesFromCc,
    writePatchName,
} from "./bassPodProSysex.js";

// ---------------------------------------------------------------------------
// Line 6 Bass POD Pro - live MIDI control-change adapter.
//
// The Bass POD Pro is not a patch-editor device in the way the Zoom MS Plus
// pedals are: every front-panel control is mirrored by a plain control-change
// message on the POD's global MIDI channel, so the whole panel can be driven
// (and observed) with CCs alone.
//
// Verified message envelope, from "Bass POD Pro Sysex - English.pdf" (page 1):
//
//   program dump request    F0 00 01 0C 02 00 00 <program #> F7
//   edit buffer request     F0 00 01 0C 02 00 01 F7
//   all programs request    F0 00 01 0C 02 00 02 F7
//   program dump reply      F0 00 01 0C 02 01 00 <program #> <version> <data> F7
//   edit buffer reply       F0 00 01 0C 02 01 01 <version> <data> F7
//   all programs reply      F0 00 01 0C 02 01 02 <version> <data> F7
//
// <data> is nibble-encoded: 160 bytes for one 80-byte program, 5760 bytes for
// all 36 programs (2880 bytes = 36 x 80). That path is implemented here,
// because a dump is the only way to *read* this device: the POD does NOT
// report its parameters as control changes when a program is recalled (checked
// against real hardware - see README.md), so the app has to ask for a dump
// instead of listening for one.
//
// The byte-level codec lives in bassPodProSysex.js; this class owns the
// transport, the request bookkeeping and the events the UI listens for.
//
// Control numbers, ranges and value names come from
// mapping/bass_pod_pro_mapping.ods, the 80-byte program layout from
// mapping/Bass POD Pro Sysex - English .pdf, and both are carried in the
// device's profile JSON (shared/data/bass-pod-pro.json) rather than being
// hard-coded here.
// ---------------------------------------------------------------------------

// A control we just told the POD about should not bounce straight back and
// yank the on-screen knob around. Real hardware doesn't echo, but a MIDI
// interface in "thru" mode (or a loopback port) can, so anything arriving
// within this window for a control we just sent is treated as our own echo.
const ECHO_SUPPRESSION_MS = 200;

// How long to wait for a dump reply before giving up. A single-program reply is
// 169 bytes, which is a blink; the all-programs reply is 5769 bytes, most of two
// seconds at MIDI's 31.25kbps, so it gets a budget of its own. A request that
// never gets an answer (POD on another MIDI channel, or sitting in a menu) must
// not leave the UI hanging on a promise.
const DEFAULT_DUMP_TIMEOUT_MS = 1500;
const ALL_PROGRAMS_DUMP_TIMEOUT_MS = 6000;

// A long sys-ex arrives in pieces rather than as one message: a Bass POD Pro on
// firmware 1.40 delivers the 36-program dump as 23 chunks of 256 bytes, where
// only the first starts with F0 and only the last ends with F7 (captured in
// test/fixtures/bass-pod-pro-all-programs.txt). Web MIDI hands the app the
// same pieces, so they are stitched back together before anything is parsed.
// The limit just stops a dump that never finishes from being buffered forever.
const SYSEX_BUFFER_LIMIT = 64 * 1024;

export class BassPodProDevice {
    static PROGRAM_CHANGE_MANUAL = 0;
    static PROGRAM_CHANGE_TUNER = 37;

    /**
     * @param midi A MIDIProxy implementation (MIDIProxyForWebMIDIAPI)
     * @param midiDevice The MIDIDeviceDescription this device was identified as
     * @param profileData Parsed contents of shared/data/bass-pod-pro.json
     * @param options { channel, now, dumpTimeoutMs }
     */
    constructor(midi, midiDevice, profileData, options = {}) {
        this._midi = midi;
        this._midiDevice = midiDevice;
        this._profile = profileData;
        // MIDI channel index, not channel number: 0 is what the POD's front
        // panel calls channel 1. Global on the POD, so if the app and the POD
        // disagree the POD will simply ignore everything we send.
        this._channel = options.channel ?? Math.max(0, (profileData?.channel ?? 1) - 1);
        this._now = options.now ?? (() => performance.now());
        this._isOpen = false;
        this._inputHandle = undefined;
        this._outputHandle = undefined;
        this._openCloseListeners = [];
        this._parameterChangedListeners = [];
        this._programChangedListeners = [];
        this._recentlySent = new Map(); // ccNumber -> timestamp
        this._ccToControl = buildControlLookup(profileData);
        this._midiMessageHandler = (_deviceHandle, data) => this._handleMessage(data);
        // Sys-ex program dumps. "programs" is filled from the all-programs
        // dump and is what the patch list shows.
        this._sysexLayout = profileData?.sysexLayout ?? null;
        this._programs = [];
        // Raw 80 bytes per stored program, filled from the all-programs dump.
        // This is what "Backup All" writes to disk, so the bytes are kept
        // rather than thrown away after the names are read out of them.
        this._programBlobs = [];
        this._programListListeners = [];
        this._programLoadedListeners = [];
        this._pendingDumps = [];
        // Explicit override, used by the tests; otherwise each dump type gets
        // its own budget (see _timeoutFor).
        this._dumpTimeoutMs = options.dumpTimeoutMs;
        this._sysexBuffer = [];
        this._currentProgramBytes = null;
        this._currentProgramName = "";
        this._activeProgramNumber = null;
        // Which program the POD is on as far as the app knows, so an edit-buffer
        // dump (which carries no program number) can still be labelled, plus the
        // last one the app sent, for telling the pedal's own moves apart from
        // echoes of ours.
        this._currentProgramChange = undefined;
        this._lastSentProgramChange = undefined;
        this._lastSentProgramChangeAt = undefined;
    }

    get isOpen() {
        return this._isOpen;
    }

    get deviceName() {
        return this._profile?.label || this._midiDevice?.deviceName || "Bass POD Pro";
    }

    /** MIDI channel number as printed on the POD (1-16). */
    get channel() {
        return this._channel + 1;
    }

    get profile() {
        return this._profile;
    }

    /** Control descriptor for a control-change number, or undefined. */
    controlForCc(ccNumber) {
        return this._ccToControl.get(ccNumber);
    }

    // --- Lifecycle ---------------------------------------------------------

    async open() {
        if (this._isOpen) return;
        this._inputHandle = await this._midi.openInput(this._midiDevice.inputID);
        this._outputHandle = await this._midi.openOutput(this._midiDevice.outputID);
        this._midi.addListener(this._midiDevice.inputID, this._midiMessageHandler);
        this._setIsOpen(true);
    }

    async close() {
        if (!this._isOpen) return;
        this._midi.removeListener(this._midiDevice.inputID, this._midiMessageHandler);
        try {
            await this._midi.closeInput(this._midiDevice.inputID);
        } catch (e) {
            log(LogLevel.Info, "BassPodProDevice", `BassPodProDevice.close() input: ${e.message}`);
        }
        try {
            await this._midi.closeOutput(this._midiDevice.outputID);
        } catch (e) {
            log(LogLevel.Info, "BassPodProDevice", `BassPodProDevice.close() output: ${e.message}`);
        }
        this._setIsOpen(false);
    }

    _setIsOpen(open) {
        this._isOpen = open;
        for (const listener of this._openCloseListeners) listener(this, open);
    }

    // --- Outbound ----------------------------------------------------------

    /**
     * Sends one parameter to the POD.
     * @param ccNumber Control-change number (from the profile)
     * @param value 0-127; clamped to that control's documented range
     */
    setParameter(ccNumber, value) {
        if (!this._isOpen) return;
        const control = this._ccToControl.get(ccNumber);
        const min = control ? control.min : 0;
        const max = control ? control.max : 127;
        const clamped = Math.max(min, Math.min(max, Math.round(value)));
        this._recentlySent.set(ccNumber, this._now());
        if (this._currentProgramBytes) {
            updateProgramBytesFromCc(this._currentProgramBytes, this._sysexLayout, ccNumber, clamped);
        }
        this._midi.sendCC(this._midiDevice.outputID, this._channel, ccNumber, clamped);
    }

    sendProgramChange(programChangeNumber) {
        if (!this._isOpen) return;
        const value = programChangeNumber & 0x7f;
        this._midi.sendPC(this._midiDevice.outputID, this._channel, value);
        this._currentProgramChange = value;
        this._lastSentProgramChange = value;
        this._lastSentProgramChangeAt = this._now();
    }

    /** The program the POD is on, as far as the app knows (sent or received). */
    get currentProgramChangeNumber() {
        return this._currentProgramChange;
    }

    /**
     * The last program change the app itself sent. Used to recognise an echo:
     * if a program change we sent comes back (a MIDI "thru" port will certainly
     * do it, and the POD may), the UI must not read that program a second time.
     */
    get lastSentProgramChangeNumber() {
        return this._lastSentProgramChange;
    }

    // --- Programs (sys-ex) -------------------------------------------------
    //
    // Reading is sys-ex only. The POD doesn't broadcast its settings when a
    // program is recalled, so "what is in this patch?" has to be asked for.

    /** How many internal programs this device has. */
    get programCount() {
        return this._profile?.programs?.count ?? 0;
    }

    /** Cached program list; empty until an all-programs dump has been read. */
    get programs() {
        return this._programs;
    }

    /**
     * Raw 80 bytes for each stored program, filled whenever an all-programs
     * dump has been read (and kept in step by uploadProgramToSlot). Sparse
     * until then: an entry can be undefined if that program was never read.
     */
    get storedProgramBytes() {
        return this._programBlobs;
    }

    /** Program number (0 = 1A) -> program change number (1 = 1A). */
    programChangeFor(programNumber) {
        return programNumber + (this._profile?.programs?.pcBase ?? 1);
    }

    /**
     * Reads every program's name in one message, by asking for the
     * all-programs dump. Safe to call at any time: it is a read, and the POD
     * answers with whatever is stored in it.
     * @returns the program list, or undefined if no reply arrived in time
     */
    async requestProgramNames() {
        if (!this._isOpen) return undefined;
        const pending = this._awaitDump(DUMP_TYPE_ALL_PROGRAMS);
        this._midi.send(this._midiDevice.outputID, buildAllProgramsDumpRequest());
        return await pending;
    }

    /**
     * Reads one stored program.
     * @returns { programNumber, name, values } - values is a Map of
     *          control-change number -> value - or undefined on timeout
     */
    async requestProgramDump(programNumber) {
        if (!this._isOpen) return undefined;
        const pending = this._awaitDump(DUMP_TYPE_PROGRAM);
        this._midi.send(this._midiDevice.outputID, buildProgramDumpRequest(programNumber));
        return await pending;
    }

    /**
     * Reads the edit buffer: the program the POD is playing right now, edits
     * and all. Same 80-byte shape as a stored program, but with no program
     * number in the reply.
     */
    async requestEditBufferDump() {
        if (!this._isOpen) return undefined;
        const pending = this._awaitDump(DUMP_TYPE_EDIT_BUFFER);
        this._midi.send(this._midiDevice.outputID, buildEditBufferDumpRequest());
        return await pending;
    }

    /**
     * What clicking a patch in the list does: recall that program on the POD,
     * then read it back so the panel shows what the program really contains.
     * @returns the loaded program, or undefined if the dump didn't arrive
     */
    async loadProgram(programNumber) {
        if (!this._isOpen) return undefined;
        this.sendProgramChange(this.programChangeFor(programNumber));
        return await this.requestProgramDump(programNumber);
    }

    /** The 80-byte program bytes currently in memory/panel, or null. */
    get currentProgramBytes() {
        return this._currentProgramBytes;
    }

    /** The name of the current program in memory/panel. */
    get currentProgramName() {
        return this._currentProgramName;
    }

    /** Active program number (0..35), or null if in manual/edit buffer. */
    get activeProgramNumber() {
        return this._activeProgramNumber;
    }

    set activeProgramNumber(num) {
        this._activeProgramNumber = num;
    }

    /**
     * Updates the name of the current program.
     * Updates internal program bytes and the program list if this is a stored slot.
     */
    renameCurrentProgram(newName) {
        this._currentProgramName = (newName || "").slice(0, 16);
        if (this._currentProgramBytes) {
            writePatchName(this._currentProgramBytes, this._currentProgramName, this._sysexLayout);
        }
        if (this._activeProgramNumber !== null && this._activeProgramNumber !== undefined) {
            this._rememberProgramName(this._activeProgramNumber, this._currentProgramName);
        }
    }

    /**
     * Uploads an 80-byte program to the POD's edit buffer (what the POD is playing
     * right now). The panel repaints from the programLoaded listeners, exactly as
     * it would if the POD had sent the dump itself.
     *
     * @param {Uint8Array} [programBytes] - if omitted, uses currentProgramBytes
     * @param {object} [options]
     * @param {boolean} [options.keepActiveProgram] - by default the edit buffer no
     *        longer belongs to any stored slot, so the active program is cleared;
     *        callers that are pushing a slot's contents back set this to keep it.
     */
    async uploadEditBuffer(programBytes = this._currentProgramBytes, options = {}) {
        if (!this._isOpen || !programBytes) return false;
        const msg = buildEditBufferDump(programBytes, this._sysexLayout?.version ?? 1);
        this._midi.send(this._midiDevice.outputID, msg);
        this._currentProgramBytes = new Uint8Array(programBytes);
        this._currentProgramName = readPatchName(programBytes, this._sysexLayout);
        if (!options.keepActiveProgram) this._activeProgramNumber = null;

        const program = readProgram(this._currentProgramBytes, this._sysexLayout);
        const programChangeNumber = this._currentProgramChange;
        const payload = {
            type: DUMP_TYPE_EDIT_BUFFER,
            programNumber: undefined,
            programChangeNumber,
            label: programChangeNumber === undefined ? undefined : this.programLabelFor(programChangeNumber),
            name: program.name,
            values: program.values,
        };
        for (const listener of this._programLoadedListeners) listener(this, payload);
        return true;
    }

    /**
     * Uploads an 80-byte program into a stored memory slot on the POD (1A-9D).
     * Also updates the cached program list entry and emits a change event.
     * @param {number} programNumber - 0 to 35
     * @param {Uint8Array} programBytes - 80 bytes
     */
    async uploadProgramToSlot(programNumber, programBytes) {
        if (!this._isOpen || !programBytes || programNumber < 0 || programNumber >= (this.programCount || 36)) {
            return false;
        }
        const msg = buildProgramDump(programNumber, programBytes, this._sysexLayout?.version ?? 1);
        this._midi.send(this._midiDevice.outputID, msg);
        // Two copies, not one shared buffer: panel edits must not rewrite the
        // cached copy of what the POD now has stored.
        this._programBlobs[programNumber] = new Uint8Array(programBytes);
        if (this._activeProgramNumber === programNumber) {
            this._currentProgramBytes = new Uint8Array(programBytes);
            this._currentProgramName = readPatchName(programBytes, this._sysexLayout);
        }
        const name = readPatchName(programBytes, this._sysexLayout);
        this._rememberProgramName(programNumber, name);
        return true;
    }

    // --- Unified Zoom-compatible patch slot methods -------------------------

    async downloadPatchFromMemorySlot(slotIndex) {
        const loaded = await this.requestProgramDump(slotIndex);
        return loaded ? this._currentProgramBytes : undefined;
    }

    async uploadPatchToMemorySlot(programBytes, slotIndex) {
        return await this.uploadProgramToSlot(slotIndex, programBytes);
    }

    async updatePatchListFromPedal() {
        return await this.requestProgramNames();
    }

    // --- Dump bookkeeping --------------------------------------------------

    /** How long to wait for a given kind of dump. */
    _timeoutFor(type) {
        if (this._dumpTimeoutMs !== undefined) return this._dumpTimeoutMs;
        return type === DUMP_TYPE_ALL_PROGRAMS ? ALL_PROGRAMS_DUMP_TIMEOUT_MS : DEFAULT_DUMP_TIMEOUT_MS;
    }

    /** Registers interest in the next reply of a given dump type. */
    _awaitDump(type) {
        return new Promise((resolve) => {
            const entry = { type, resolve, timer: undefined };
            entry.timer = setTimeout(() => {
                this._pendingDumps = this._pendingDumps.filter((p) => p !== entry);
                log(LogLevel.Midi, "BassPodProDevice", 
                    `BassPodProDevice: no reply to sys-ex dump request type ${type} - is the POD listening on MIDI channel ${this.channel}?`);
                resolve(undefined);
            }, this._timeoutFor(type));
            this._pendingDumps.push(entry);
        });
    }

    /**
     * Collects sys-ex chunks until a whole message has arrived, then parses it.
     *
     * The POD sends a long dump as a run of messages, not one: the first begins
     * with F0, the ones after it are the continuation, and only the last carries
     * the F7 end-of-exclusive. Anything that starts with F0 therefore starts a
     * new message, and whatever was in the buffer was an unfinished one.
     */
    _handleSysex(data) {
        if (data[0] === SYSEX_START) this._sysexBuffer = [];
        for (const byte of data) this._sysexBuffer.push(byte);

        if (this._sysexBuffer.length > SYSEX_BUFFER_LIMIT) {
            log(LogLevel.Warning, "BassPodProDevice", "BassPodProDevice: dropping a sys-ex dump that never ended");
            this._sysexBuffer = [];
            return;
        }
        if (this._sysexBuffer[this._sysexBuffer.length - 1] !== SYSEX_END) return; // more to come

        const message = this._sysexBuffer;
        this._sysexBuffer = [];
        const parsed = parseDumpMessage(message);
        if (isDecodableDump(parsed)) this._handleDump(parsed);
    }

    /** Hands a reply to everyone waiting on that type. */
    _resolveDump(type, result) {
        const waiting = this._pendingDumps.filter((p) => p.type === type);
        this._pendingDumps = this._pendingDumps.filter((p) => p.type !== type);
        for (const entry of waiting) {
            clearTimeout(entry.timer);
            entry.resolve(result);
        }
    }

    /** Turns the 36 program blobs of an all-programs dump into the patch list. */
    _setProgramList(programBlobs) {
        const count = Math.min(this.programCount || programBlobs.length, programBlobs.length);
        this._programBlobs = Array.from(programBlobs.slice(0, count), (blob) => new Uint8Array(blob));
        const list = [];
        for (let i = 0; i < count; i++) {
            const programChangeNumber = this.programChangeFor(i);
            list.push({
                programNumber: i,
                programChangeNumber,
                label: this.programLabelFor(programChangeNumber),
                name: readPatchName(programBlobs[i], this._sysexLayout),
            });
        }
        this._programs = list;
        for (const listener of this._programListListeners) listener(this, list);
    }

    /**
     * A dump arrived. This is where the app learns everything control changes
     * cannot tell it: the patch names, and every parameter's stored value.
     */
    _handleDump(parsed) {
        const size = this._sysexLayout?.programByteCount ?? PROGRAM_BYTE_COUNT;
        const version = this._sysexLayout?.version ?? 1;
        if (parsed.version !== undefined && parsed.version !== version) {
            log(LogLevel.Warning, "BassPodProDevice", 
                `BassPodProDevice: dump says version ${parsed.version}, the field map in the profile is for ${version}`);
        }

        if (parsed.type === DUMP_TYPE_ALL_PROGRAMS) {
            this._setProgramList(splitPrograms(parsed.bytes, size));
            this._resolveDump(DUMP_TYPE_ALL_PROGRAMS, this._programs);
            return;
        }

        // A truncated dump is worse than no dump: it would read as a program
        // full of zeros, so drop it rather than report invented values.
        if (parsed.byteCount < size) {
            log(LogLevel.Midi, "BassPodProDevice", 
                `BassPodProDevice: ignoring a ${parsed.byteCount}-byte dump (expected ${size})`);
            return;
        }

        const program = readProgram(parsed.bytes, this._sysexLayout);
        const programNumber = parsed.type === DUMP_TYPE_PROGRAM ? parsed.programNumber : undefined;
        const programChangeNumber = programNumber === undefined
            ? this._currentProgramChange
            : this.programChangeFor(programNumber);

        this._currentProgramBytes = new Uint8Array(parsed.bytes.slice(0, size));
        this._currentProgramName = program.name;
        if (programNumber !== undefined) {
            this._activeProgramNumber = programNumber;
            // A copy: the stored bytes must not follow panel edits, which land
            // in _currentProgramBytes until something is written back.
            this._programBlobs[programNumber] = new Uint8Array(this._currentProgramBytes);
            this._rememberProgramName(programNumber, program.name);
        }

        const payload = {
            type: parsed.type,
            programNumber,
            programChangeNumber,
            label: programChangeNumber === undefined ? undefined : this.programLabelFor(programChangeNumber),
            name: program.name,
            values: program.values,
        };
        for (const listener of this._programLoadedListeners) listener(this, payload);
        this._resolveDump(parsed.type, payload);
    }

    /** Keeps the patch list's name in step with a program that was just read. */
    _rememberProgramName(programNumber, name) {
        const entry = this._programs[programNumber];
        if (!entry || entry.name === name) return;
        entry.name = name;
        for (const listener of this._programListListeners) listener(this, this._programs);
    }

    // --- Inbound -----------------------------------------------------------

    _handleMessage(data) {
        // A dump that is still being collected owns every data byte that arrives
        // in the meantime: the continuation chunks of a long sys-ex do not begin
        // with a status byte (real hardware sends them as plain data), so on
        // their own they look like nothing at all and would otherwise be thrown
        // away - leaving the dump half-collected and never answering.
        if (this._sysexBuffer.length > 0 && data[0] < 0x80) {
            this._handleSysex(data);
            return;
        }

        const [messageType, , data1, data2] = getChannelMessage(data);

        // Program data only ever arrives by sys-ex, usually in several chunks -
        // see _handleSysex(). A dump request we sent bounces back as opcode 00
        // (request, not reply) and is ignored by isDecodableDump().
        if (messageType === MessageType.SysEx) {
            this._handleSysex(data);
            return;
        }

        if (messageType === MessageType.CC) {
            const sentAt = this._recentlySent.get(data1);
            if (sentAt !== undefined) {
                if (this._now() - sentAt < ECHO_SUPPRESSION_MS) {
                    log(LogLevel.Midi, "BassPodProDevice", `BassPodProDevice: swallowed echo of CC ${data1} (${data2})`);
                    return;
                }
                this._recentlySent.delete(data1);
            }
            if (this._currentProgramBytes) {
                updateProgramBytesFromCc(this._currentProgramBytes, this._sysexLayout, data1, data2);
            }
            const control = this._ccToControl.get(data1);
            for (const listener of this._parameterChangedListeners) listener(this, data1, data2, control);
        }
        else if (messageType === MessageType.PC) {
            // Our own program change coming back. Unlike a control change there
            // is nothing to correct on screen - the app asked for this - and
            // passing it on would make the UI read the same program twice.
            if (data1 === this._lastSentProgramChange && this._now() - this._lastSentProgramChangeAt < ECHO_SUPPRESSION_MS) {
                log(LogLevel.Midi, "BassPodProDevice", `BassPodProDevice: swallowed echo of program change ${data1}`);
                return;
            }
            // The POD's own program buttons and footswitches send this, so it is
            // the best answer to "which program is playing" - an edit-buffer read
            // is labelled with it, and app.js follows it by reading that program.
            this._currentProgramChange = data1;
            for (const listener of this._programChangedListeners) listener(this, data1, this.programLabelFor(data1));
        }
    }

    /** "1A".."9D" for a program-change number, or "Manual"/"Tuner"/undefined. */
    programLabelFor(programChangeNumber) {
        if (programChangeNumber === BassPodProDevice.PROGRAM_CHANGE_MANUAL) return "Manual";
        if (programChangeNumber === BassPodProDevice.PROGRAM_CHANGE_TUNER) return "Tuner";
        const programs = this._profile?.programs;
        if (!programs) return undefined;
        const index = programChangeNumber - (programs.pcBase ?? 1);
        if (index < 0 || index >= programs.count) return undefined;
        const banksOf = programs.banksOf ?? 4;
        const bank = Math.floor(index / banksOf) + 1;
        return `${bank}${"ABCD".charAt(index % banksOf)}`;
    }

    // --- Listeners ---------------------------------------------------------

    addOpenCloseListener(listener) {
        this._openCloseListeners.push(listener);
    }

    removeOpenCloseListener(listener) {
        this._openCloseListeners = this._openCloseListeners.filter((l) => l !== listener);
    }

    /** listener(device, ccNumber, value, control|undefined) */
    addParameterChangedListener(listener) {
        this._parameterChangedListeners.push(listener);
    }

    removeParameterChangedListener(listener) {
        this._parameterChangedListeners = this._parameterChangedListeners.filter((l) => l !== listener);
    }

    /** listener(device, programChangeNumber, label|undefined) */
    addProgramChangedListener(listener) {
        this._programChangedListeners.push(listener);
    }

    removeProgramChangedListener(listener) {
        this._programChangedListeners = this._programChangedListeners.filter((l) => l !== listener);
    }

    /** listener(device, programs[]) - the patch list, or one name in it, changed. */
    addProgramListChangedListener(listener) {
        this._programListListeners.push(listener);
    }

    removeProgramListChangedListener(listener) {
        this._programListListeners = this._programListListeners.filter((l) => l !== listener);
    }

    /** listener(device, { type, programNumber, label, name, values }) */
    addProgramLoadedListener(listener) {
        this._programLoadedListeners.push(listener);
    }

    removeProgramLoadedListener(listener) {
        this._programLoadedListeners = this._programLoadedListeners.filter((l) => l !== listener);
    }
}

/**
 * Builds ccNumber -> control descriptor from the profile's groups.
 * Every control with a "cc" gets an entry; min/max fall back to the full
 * control-change range when the profile doesn't state them.
 * @returns Map<number, object>
 */
export function buildControlLookup(profileData) {
    const lookup = new Map();
    for (const group of profileData?.groups ?? []) {
        for (const control of group.controls ?? []) {
            if (control.cc === undefined || control.cc === null) continue;
            lookup.set(control.cc, {
                ...control,
                groupId: group.id,
                groupName: group.name,
                min: control.min ?? 0,
                max: control.max ?? 127,
            });
        }
    }
    return lookup;
}

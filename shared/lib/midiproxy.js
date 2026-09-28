/**
 * Module MIDIProxy provides the MIDIProxy class
 * @module MIDIProxy
 */
import { shouldLog, LogLevel } from "./Logger.js";
export const ALL_MIDI_DEVICES = "ALL_MIDI_DEVICES";
/**
 * MIDI status bitmask for message types
 * @see https://midi.org/summary-of-midi-1-0-messages
 */
export var MessageType;
(function (MessageType) {
    MessageType[MessageType["Unknown"] = 0] = "Unknown";
    MessageType[MessageType["NoteOff"] = 128] = "NoteOff";
    MessageType[MessageType["NoteOn"] = 144] = "NoteOn";
    MessageType[MessageType["KeyPress"] = 160] = "KeyPress";
    MessageType[MessageType["CC"] = 176] = "CC";
    MessageType[MessageType["PC"] = 192] = "PC";
    MessageType[MessageType["ChanPress"] = 208] = "ChanPress";
    MessageType[MessageType["PitchBend"] = 224] = "PitchBend";
    MessageType[MessageType["SysEx"] = 240] = "SysEx";
    MessageType[MessageType["TimeCode"] = 241] = "TimeCode";
    MessageType[MessageType["SongPos"] = 242] = "SongPos";
    MessageType[MessageType["SongSelect"] = 243] = "SongSelect";
    MessageType[MessageType["Undefined1"] = 244] = "Undefined1";
    MessageType[MessageType["Undefined2"] = 245] = "Undefined2";
    MessageType[MessageType["TuneRequest"] = 246] = "TuneRequest";
    MessageType[MessageType["SysExEnd"] = 247] = "SysExEnd";
    MessageType[MessageType["Clock"] = 248] = "Clock";
    MessageType[MessageType["Undefined3"] = 249] = "Undefined3";
    MessageType[MessageType["Start"] = 250] = "Start";
    MessageType[MessageType["Continue"] = 251] = "Continue";
    MessageType[MessageType["Stop"] = 252] = "Stop";
    MessageType[MessageType["Undefined4"] = 253] = "Undefined4";
    MessageType[MessageType["ActiveSense"] = 254] = "ActiveSense";
    MessageType[MessageType["Reset"] = 255] = "Reset";
})(MessageType || (MessageType = {}));
/**
 * Implements some common convenience methods for classes that implement IMIDIProxy
 */
export class MIDIProxy {
    messageBuffer2;
    messageBuffer3;
    messageMutes;
    constructor() {
        this.messageBuffer2 = new Uint8Array([0, 0]);
        this.messageBuffer3 = new Uint8Array([0, 0, 0]);
        this.messageMutes = new Map();
    }
    _enabled = false;
    set enabled(enabled) {
        this._enabled = enabled;
    }
    get enabled() {
        return this._enabled;
    }
    isDeviceConnected(id, type) {
        return type === "input" ? this.isInputConnected(id) : this.isOutputConnected(id);
    }
    getDeviceInfo(id, type) {
        return type === "input" ? this.getInputInfo(id) : this.getOutputInfo(id);
    }
    sendPC(deviceHandle, channel, program) {
        this.messageBuffer2[0] = MessageType.PC + (channel & 0b00001111);
        this.messageBuffer2[1] = program & 0b01111111;
        this.send(deviceHandle, this.messageBuffer2);
    }
    sendCC(deviceHandle, channel, ccNumber, ccValue) {
        this.messageBuffer3[0] = MessageType.CC + (channel & 0b00001111);
        this.messageBuffer3[1] = ccNumber & 0b01111111;
        this.messageBuffer3[2] = ccValue & 0b01111111;
        this.send(deviceHandle, this.messageBuffer3);
    }
    sendAndGetReply(outputDevice, data, inputDevice, verifyReply, timeoutMilliseconds = 100) {
        return new Promise((resolve, reject) => {
            let timeoutId = setTimeout(() => {
                shouldLog(LogLevel.Midi) && console.log(`sendAndGetReply() Timed out (${timeoutId}) for output device "${outputDevice}", input device "${inputDevice}"`);
                this.removeListener(inputDevice, handleReply);
                resolve(undefined);
            }, timeoutMilliseconds);
            let handleReply = (deviceHandle, data) => {
                if (verifyReply(data)) {
                    clearTimeout(timeoutId);
                    this.removeListener(deviceHandle, handleReply);
                    resolve(data);
                }
                else {
                    shouldLog(LogLevel.Midi) && console.log(`sendAndGetReply received MIDI data of length ${data.length} that failed verifyReply`);
                }
            };
            this.addListener(inputDevice, handleReply);
            this.send(outputDevice, data);
        });
        // leftover code to compare two datasets:
        // replyStart.length === 0 || data.length >= replyStart.length && data.slice(0, replyStart.length).every((element, index) => element === replyStart[index])
    }
    setMuteState(deviceHandle, messageType, mute) {
        let deviceMutes = this.messageMutes.get(deviceHandle);
        if (deviceMutes === undefined) {
            deviceMutes = new Map();
            this.messageMutes.set(deviceHandle, deviceMutes);
        }
        deviceMutes.set(messageType, mute);
    }
    getMuteStates(deviceHandle) {
        return this.messageMutes.get(deviceHandle);
    }
}
//# sourceMappingURL=midiproxy.js.map
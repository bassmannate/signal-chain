import { ZoomPatch } from "./ZoomPatch.js";
import { ZoomScreenCollection } from "./ZoomScreenInfo.js";
import { MessageType } from "./midiproxy.js";
import { getChannelMessage } from "./miditools.js";
import { Throttler } from "./throttler.js";
import { crc32, eight2seven, getExceptionErrorString, getNumberOfEightBitBytes, partialArrayMatch, partialArrayStringMatch, seven2eight, bytesToHexString, hexStringToUint8Array, sleepForAWhile } from "./tools.js";
import { shouldLog, LogLevel, getLogLevel, setLogLevel } from "./Logger.js";
class StringAndBytes {
    str;
    bytes;
    constructor(str) {
        this.str = str;
        this.bytes = hexStringToUint8Array(str);
    }
}
class ZoomMessageTypes {
    success = new StringAndBytes("00 00");
    sayHi = new StringAndBytes("05"); // I don't know what this command means, but the reply is 00 00, so it's a sign of life
    bankAndPatchInfoV1 = new StringAndBytes("06"); // 06 <num patches LSB> <num patches MSB> <patch length LSB> <patch length MSB>
    requestBankAndPatchInfoV1 = new StringAndBytes("07");
    patchDumpForMemoryLocationV1 = new StringAndBytes("08 00 00"); // 08 00 00 <patch number> <length LSB> <length MSB>
    requestPatchDumpForMemoryLocationV1 = new StringAndBytes("09 00 00"); // 09 00 00 <patch number>
    patchDumpForCurrentPatchV1 = new StringAndBytes("28");
    requestCurrentPatchV1 = new StringAndBytes("29");
    parameterValueV1 = new StringAndBytes("31");
    storeCurrentPatchToMemorySlotV1 = new StringAndBytes("32");
    requestCurrentBankAndProgramV1 = new StringAndBytes("33");
    bankAndPatchInfoV2 = new StringAndBytes("43");
    requestBankAndPatchInfoV2 = new StringAndBytes("44");
    patchDumpForMemoryLocationV2 = new StringAndBytes("45 00 00");
    requestPatchDumpForMemoryLocationV2 = new StringAndBytes("46 00 00");
    parameterEditEnable = new StringAndBytes("50");
    parameterEditDisable = new StringAndBytes("51");
    pcModeEnable = new StringAndBytes("52");
    pcModeDisable = new StringAndBytes("53");
    screensForCurrentPatch = new StringAndBytes("64 01");
    requestScreensForCurrentPatch = new StringAndBytes("64 02");
    patchDumpForCurrentPatchV2 = new StringAndBytes("64 12"); // Seems like there's always a 01 byte after the 64 12, 64 12 01 <patch length LSB> <patch length MSB> <patch data> <5 byte CRC>
    requestCurrentPatchV2 = new StringAndBytes("64 13");
    nameCharacterV2 = new StringAndBytes("64 20 00 5F");
    currentEffectSlotV2 = new StringAndBytes("64 20 00 64 01");
    autoSaveV2 = new StringAndBytes("64 20 00 64 0F");
    parameterValueV2 = new StringAndBytes("64 20 00");
    parameterValueAcceptedV2 = new StringAndBytes("64 20 01");
    tempoV2 = new StringAndBytes("64 20 00 64 02");
    bankAndProgramNumberV2 = new StringAndBytes("64 26 00 00");
}
/**
 * The ZoomDevice class represents one Zoom effect pedal. It will strive to keep its state in sync with the pedal state at all times.
 *
 * In particular, that means that these state properties will always be kept up to date:
 * - patchList
 * - currentPatch
 * - currentTempo
 * - currentScreenCollection
 * - currentEffectSlot
 * - currentProgram
 * - previousBank
 * - currentEffectParameterNumber
 * - currentEffectParameterValue
 *
 * pattern for screens and current patch
 * - Manual usage:
 *   - requestScreens() will request current screen collection from pedal
 *   - object will emitScreenChangedEvent when current screen collection is received from pedal
 * - Automatic usage:
 *   - set autoRequestScreens to true
 *   - object will do its best to keep the currentScreenCollection up to date when parameters or patches changes
 *     - parameters changed
 *     - current patch received
 *
 *
 */
export class ZoomDevice {
    _midiDevice;
    _timeoutMilliseconds;
    _midi;
    _midiMessageHandler;
    _isOpen = false;
    _zoomDeviceID;
    _zoomDeviceIdString;
    _commandBuffers = new Map();
    static messageTypes = new ZoomMessageTypes();
    _supportedCommands = new Map();
    _throttler = new Throttler();
    _throttleTimeoutMilliseconds = 100;
    _patchListDownloadInProgress = false;
    _autoRequestPatchForMemorySlotInProgress = false;
    _autoRequestPatchMemorySlotNumber = -1;
    _disableMidiHandlers = false;
    _isMappingParameters = false;
    _cancelMapping = false;
    _msogPatchNumEffectsMismatchFixRequest = false;
    _msogPatchNumEffectsMismatchFixRequestThrottleTimeoutMilliseconds = 100;
    _listeners = new Array();
    _openCloseListeners = new Array();
    _memorySlotChangedListeners = new Array();
    _effectParameterChangedListeners = new Array();
    _effectSlotChangedListeners = new Array();
    _currentPatchChangedListeners = new Array();
    _patchChangedListeners = new Array();
    _screenChangedListeners = new Array();
    _tempoChangedListeners = new Array();
    _numPatches = -1;
    _patchLength = -1;
    _patchesPerBank = -1;
    _patchDumpForMemoryLocationV1CRCBytes = 0;
    _ptcfPatchFormatSupported = false;
    _ptcfNameLength = 0;
    _usesBankBeforeProgramChange = false;
    _bankAndProgramSentOnUpdate = false;
    _bankMessagesReceived = false; // true after having received bank messages, reset when program change message received
    _maxNumEffects = 0;
    _patchList = new Array();
    _rawPatchList = new Array();
    _autoUpdateScreens = false;
    _autoRequestCurrentPatch = false; // FIXME: Do we need this for anything other than name, and that could have its own event ?
    _autoRequestProgramChange = false; // MSOG pedals doesn't emit program change when user changes patch, so we need to poll
    _autoRequestProgramChangeTimerStarted = false;
    _autoRequestProgramChangeIntervalMilliseconds = 500;
    _autoRequestProgramChangeTimerID = 0;
    _autoRequestProgramChangeMuteLog = false;
    _currentBank = -1;
    _currentProgram = -1;
    _previousBank = -1; // Not entirely accurate, as bank messages come in with MSB and LSB separately, but can hopefully be used to check if program has changed
    _previousProgram = -1;
    _currentEffectSlot = -1;
    _currentEffectParameterNumber = -1;
    _currentEffectParameterValue = -1;
    _currentScreenCollectionData = undefined;
    _currentScreenCollection = undefined;
    _currentPatchData = undefined; // if set, needs parsing, then will be undefined
    _currentPatch = undefined; // if undefined, need to parse _currentPatchData, then set _currentPatchData=undefined 
    _currentTempo = undefined;
    // private static _effectIDMapForMSPlus: EffectIDMap | undefined = undefined;
    // private static _effectIDMapForMSOG: EffectIDMap | undefined = undefined; 
    static _effectIDMaps = new Map();
    _isMSOG = false; // Note: Try not to use this much, as we'd rather rely on probing
    _numParametersPerPage = 0;
    freezeCurrentPatch = false; // set to true for debugging, but might slow down execution, so it's not recommended for production
    constructor(midi, midiDevice, timeoutMilliseconds = 500) {
        this._midiDevice = midiDevice;
        this._timeoutMilliseconds = timeoutMilliseconds;
        this._midi = midi;
        this._midiMessageHandler = (deviceHandle, data, timeStamp) => {
            this.handleMIDIDataFromZoom(data, timeStamp);
        };
        this._zoomDeviceID = this._midiDevice.familyCode[0];
        this._zoomDeviceIdString = this._zoomDeviceID.toString(16).padStart(2, "0");
        // pre-allocate command buffers for messages of length 6 to 15
        for (let i = 6; i < 15; i++)
            this.getCommandBufferFromData(new Uint8Array(i - 5));
    }
    static isDeviceType(device) {
        return device.manufacturerID[0] === 0x52;
    }
    async open() {
        if (this._isOpen) {
            shouldLog(LogLevel.Warning) && console.warn(`Attempting to open ZoomDevice ${this._zoomDeviceIdString} which is already open`);
            return;
        }
        shouldLog(LogLevel.Info) && console.log(`Opening ZoomDevice ${this.deviceName}`);
        this._isOpen = true;
        await this._midi.openInput(this._midiDevice.inputID);
        await this._midi.openOutput(this._midiDevice.outputID);
        this.connectMessageHandler();
        await this.probeDevice();
        this.startAutoRequestProgramChangeIfNeeded();
        if (this.autoRequestCurrentPatch)
            await this.downloadCurrentPatch();
        this.emitOpenCloseEvent(true);
    }
    async close() {
        if (!this._isOpen) {
            shouldLog(LogLevel.Warning) && console.warn(`Attempting to close ZoomDevice ${this._zoomDeviceIdString} which is not open`);
            return;
        }
        shouldLog(LogLevel.Info) && console.log(`Closing ZoomDevice ${this.deviceName}`);
        this.removeAllListeners();
        this.removeAllCurrentPatchChangedListeners();
        this.removeAllEffectParameterChangedListeners();
        this.removeAllEffectSlotChangedListeners();
        this.removeAllMemorySlotChangedListeners();
        this.removeAllPatchChangedListeners();
        this.removeAllScreenChangedListeners;
        this.removeAllTempoChangedListeners();
        this.disconnectMessageHandler();
        if (this._autoRequestProgramChangeTimerStarted) {
            shouldLog(LogLevel.Info) && console.log(`Stopping auto-request program change timer for ZoomDevice ${this._zoomDeviceID}`);
            clearInterval(this._autoRequestProgramChangeTimerID);
            this._autoRequestProgramChangeTimerStarted = false;
            this._autoRequestProgramChangeMuteLog = false;
        }
        this._isOpen = false;
        await this._midi.closeInput(this._midiDevice.inputID);
        await this._midi.closeOutput(this._midiDevice.outputID);
        shouldLog(LogLevel.Info) && console.log(`Closed ZoomDevice ${this._zoomDeviceID}`);
        this.emitOpenCloseEvent(false);
    }
    setMuteState(messageType, mute) {
        this._midi.setMuteState(this._midiDevice.inputID, messageType, mute);
    }
    addOpenCloseListener(listener) {
        this._openCloseListeners.push(listener);
    }
    removeOpenCloseListener(listener) {
        this._openCloseListeners = this._openCloseListeners.filter((l) => l !== listener);
    }
    removeAllOpenCloseListeners() {
        this._openCloseListeners = [];
    }
    emitOpenCloseEvent(open) {
        this._openCloseListeners.forEach((listener) => listener(this, open));
    }
    addListener(listener) {
        this._listeners.push(listener);
    }
    removeListener(listener) {
        this._listeners = this._listeners.filter((l) => l !== listener);
    }
    removeAllListeners() {
        this._listeners = [];
    }
    addMemorySlotChangedListener(listener) {
        this._memorySlotChangedListeners.push(listener);
    }
    removeMemorySlotChangedListener(listener) {
        this._memorySlotChangedListeners = this._memorySlotChangedListeners.filter((l) => l !== listener);
    }
    removeAllMemorySlotChangedListeners() {
        this._memorySlotChangedListeners = [];
    }
    emitMemorySlotChangedEvent() {
        for (let listener of this._memorySlotChangedListeners)
            listener(this, this.currentMemorySlotNumber);
    }
    addEffectParameterChangedListener(listener) {
        this._effectParameterChangedListeners.push(listener);
    }
    removeEffectParameterChangedListener(listener) {
        this._effectParameterChangedListeners = this._effectParameterChangedListeners.filter((l) => l !== listener);
    }
    removeAllEffectParameterChangedListeners() {
        this._effectParameterChangedListeners = [];
    }
    emitEffectParameterChangedEvent() {
        for (let listener of this._effectParameterChangedListeners)
            listener(this, this._currentEffectSlot, this._currentEffectParameterNumber, this._currentEffectParameterValue);
    }
    addEffectSlotChangedListener(listener) {
        this._effectSlotChangedListeners.push(listener);
    }
    removeEffectSlotChangedListener(listener) {
        this._effectSlotChangedListeners = this._effectSlotChangedListeners.filter((l) => l !== listener);
    }
    removeAllEffectSlotChangedListeners() {
        this._effectSlotChangedListeners = [];
    }
    emitEffectSlotChangedEvent() {
        for (let listener of this._effectSlotChangedListeners)
            listener(this, this._currentEffectSlot);
    }
    addCurrentPatchChangedListener(listener) {
        this._currentPatchChangedListeners.push(listener);
    }
    removeCurrentPatchChangedListener(listener) {
        this._currentPatchChangedListeners = this._currentPatchChangedListeners.filter((l) => l !== listener);
    }
    removeAllCurrentPatchChangedListeners() {
        this._currentPatchChangedListeners = [];
    }
    emitCurrentPatchChangedEvent() {
        for (let listener of this._currentPatchChangedListeners)
            listener(this);
    }
    addPatchChangedListener(listener) {
        this._patchChangedListeners.push(listener);
    }
    removePatchChangedListener(listener) {
        this._patchChangedListeners = this._patchChangedListeners.filter((l) => l !== listener);
    }
    removeAllPatchChangedListeners() {
        this._patchChangedListeners = [];
    }
    emitPatchChangedEvent(memorySlot) {
        for (let listener of this._patchChangedListeners)
            listener(this, memorySlot);
    }
    addScreenChangedListener(listener) {
        this._screenChangedListeners.push(listener);
    }
    removeScreenChangedListener(listener) {
        this._screenChangedListeners = this._screenChangedListeners.filter((l) => l !== listener);
    }
    removeAllScreenChangedListeners() {
        this._screenChangedListeners = [];
    }
    emitScreenChangedEvent() {
        for (let listener of this._screenChangedListeners)
            listener(this);
    }
    addTempoChangedListener(listener) {
        this._tempoChangedListeners.push(listener);
    }
    removeTempoChangedListener(listener) {
        this._tempoChangedListeners = this._tempoChangedListeners.filter((l) => l !== listener);
    }
    removeAllTempoChangedListeners() {
        this._tempoChangedListeners = [];
    }
    emitTempoChangedEvent() {
        let tempo = this._currentTempo ?? 0;
        for (let listener of this._tempoChangedListeners)
            listener(this, tempo);
    }
    static setEffectIDMap(pedalnames, effectIDMap) {
        ZoomDevice.addUCNSValuesToMap(effectIDMap);
        for (let pedalname of pedalnames) {
            ZoomDevice._effectIDMaps.set(pedalname, effectIDMap);
        }
    }
    /**
     * Adds the valuesUCNSP to all parameter mappings for quick lookup in getRawParameterValueFromString
     * @param effectIDMap
     */
    static addUCNSValuesToMap(effectIDMap) {
        for (const [id, effectMapping] of effectIDMap) {
            for (let p = 0; p < effectMapping.parameters.length; p++) {
                let parameterMapping = effectMapping.parameters[p];
                if (parameterMapping.valuesUCNSP === undefined || parameterMapping.valuesUCNSP === null || parameterMapping.valuesUCNSP.size === 0) {
                    parameterMapping.valuesUCNSP = new Map();
                    for (let index = 0; index < parameterMapping.values.length; index++) {
                        let valueUCNSP = parameterMapping.values[index].replaceAll(" ", "").toUpperCase();
                        parameterMapping.valuesUCNSP.set(valueUCNSP, index);
                    }
                }
            }
        }
    }
    parameterEditEnable() {
        this.sendCommand(ZoomDevice.messageTypes.parameterEditEnable.bytes);
    }
    parameterEditDisable() {
        this.sendCommand(ZoomDevice.messageTypes.parameterEditDisable.bytes);
    }
    pcModeEnable() {
        this.sendCommand(ZoomDevice.messageTypes.pcModeEnable.bytes);
    }
    pcModeDisable() {
        this.sendCommand(ZoomDevice.messageTypes.pcModeEnable.bytes);
    }
    // public async getCurrentBankAndProgram() : Promise<[number, number]> 
    // {
    //   // perhaps request it ?
    //   return [this._currentBank, this._currentProgram];
    // }
    setCurrentBankAndProgram(bank, program, forceUpdate = false) {
        this._midi.sendCC(this._midiDevice.outputID, 0, 0x00, 0x00); // bank MSB = 0
        this._midi.sendCC(this._midiDevice.outputID, 0, 0x20, bank & 0x7F); // bank LSB
        this._midi.sendPC(this._midiDevice.outputID, 0, program & 0x7F); // program
        let changed = this.syncStateWithNewBankAndProgram(bank, program, forceUpdate);
        if (changed)
            this.emitMemorySlotChangedEvent();
    }
    setCurrentMemorySlot(memorySlot, forceUpdate = false) {
        if (this._patchesPerBank !== -1) {
            let bank = Math.floor(memorySlot / this._patchesPerBank);
            let program = memorySlot % this._patchesPerBank;
            if (forceUpdate || this._currentBank !== bank || this._currentProgram !== program)
                this.setCurrentBankAndProgram(bank, program, forceUpdate);
        }
        else {
            if (forceUpdate || this._currentProgram !== memorySlot) {
                this._midi.sendPC(this._midiDevice.outputID, 0, memorySlot & 0x7F); // program
                this._previousProgram = this._currentProgram;
                this._currentProgram = memorySlot;
                // if (this._autoRequestProgramChangeTimerStarted)
                // Note: Line below is untested (for MSOG pedals)
                this.syncStateWithNewBankAndProgram(-1, memorySlot, forceUpdate);
                this.emitMemorySlotChangedEvent();
            }
        }
        // Note: Screen is also attempted updated in the syncState... call above, but only with mapped data
        if (this._autoUpdateScreens)
            this.updateScreens();
    }
    setAutoSave(on) {
        let parameterBuffer = new Uint8Array(5);
        parameterBuffer[0] = on ? 1 : 0;
        let command = new Uint8Array(ZoomDevice.messageTypes.autoSaveV2.bytes.length + parameterBuffer.length);
        command.set(ZoomDevice.messageTypes.autoSaveV2.bytes);
        command.set(parameterBuffer, ZoomDevice.messageTypes.autoSaveV2.bytes.length);
        this.sendCommand(command);
    }
    logMutedTemporarilyForPollMessages(data) {
        let [messageType, channel, data1, data2] = getChannelMessage(data);
        const messageIsPCOrBankChange = messageType === MessageType.PC || (messageType === MessageType.CC && (data1 === 0x00 || data1 == 0x20));
        return this._autoRequestProgramChangeMuteLog && messageIsPCOrBankChange;
    }
    get autoUpdateScreens() {
        return this._autoUpdateScreens;
    }
    set autoUpdateScreens(value) {
        this._autoUpdateScreens = value;
    }
    get autoRequestCurrentPatch() {
        return this._autoRequestCurrentPatch;
    }
    set autoRequestCurrentPatch(value) {
        this._autoRequestCurrentPatch = value;
        if (this.autoRequestCurrentPatch && this.currentPatch === undefined)
            this.requestCurrentPatch();
    }
    get autoRequestProgramChange() {
        return this._autoRequestProgramChange;
    }
    set autoRequestProgramChange(value) {
        if (this._autoRequestProgramChangeTimerStarted && !value) { // switch timer off
            this._autoRequestProgramChangeTimerStarted = false;
            this._autoRequestProgramChange = value;
            clearInterval(this._autoRequestProgramChangeTimerID);
        }
        else if (!this._autoRequestProgramChangeTimerStarted && value) { // switch timer on
            this._autoRequestProgramChange = value;
            this.startAutoRequestProgramChangeIfNeeded();
        }
        else
            this._autoRequestProgramChange = value;
    }
    /**
     * Returns the current patch, as it is on the pedal. Properties of the current patch is not supposed to be changed by client code,
     * only by code inside this class.
     * We could enforce this by freezing the object, but that would have performance implications, resulting in a lot of unnecessary object cloning.
     * ZoomDevice will attempt to keep this property in sync with the pedal at all times.
     */
    get currentPatch() {
        if (this._currentPatchData !== undefined) {
            // parse the last current patch data received and update current patch
            let offset = this.isMessageType(this._currentPatchData, ZoomDevice.messageTypes.patchDumpForCurrentPatchV1) ? 5 : 9;
            let eightBitData = seven2eight(this._currentPatchData, offset, this._currentPatchData.length - 2); // skip the last byte (0x7F)in the sysex message
            if (eightBitData !== undefined) {
                let patch = ZoomPatch.fromPatchData(eightBitData);
                if (patch !== undefined) {
                    this._currentPatch = patch;
                    this._currentEffectSlot = this._currentPatch.currentEffectSlot;
                    if (this.freezeCurrentPatch)
                        Object.freeze(this._currentPatch);
                }
            }
            this._currentPatchData = undefined;
        }
        return this._currentPatch;
    }
    get currentScreenCollection() {
        if (this._currentScreenCollectionData !== undefined) {
            // parse the last screen data received and update current screen collection
            let offset = 6;
            let screenCollection = ZoomScreenCollection.fromScreenData(this._currentScreenCollectionData, offset);
            if (screenCollection !== undefined)
                this._currentScreenCollection = screenCollection;
            this._currentScreenCollectionData = undefined;
        }
        return this._currentScreenCollection;
    }
    get currentTempo() {
        return this._currentTempo;
    }
    get numParametersPerPage() {
        return this._numParametersPerPage;
    }
    get maxNumEffects() {
        return this._maxNumEffects;
    }
    get ptcfNameLength() {
        return this._ptcfNameLength;
    }
    setCurrentEffectSlot(effectSlot) {
        if (this.currentPatch === undefined) {
            shouldLog(LogLevel.Error) && console.error(`Unable to set effect slot ${effectSlot} because currentPatch is undefined`);
            return;
        }
        if (this.currentPatch.effectSettings === null || effectSlot >= this.currentPatch.effectSettings.length) {
            shouldLog(LogLevel.Error) && console.error(`Unable to set effect parameter for current patch because effectSlot ${effectSlot} is out of range`);
            return;
        }
        if (this._currentEffectSlot !== -1 && this.currentPatch.currentEffectSlot !== this._currentEffectSlot) {
            shouldLog(LogLevel.Warning) && console.warn(`currentPatch.currentEffectSlot (${this.currentPatch.currentEffectSlot}) !== _currentEffectSlot (${this._currentEffectSlot})`);
        }
        if (this._currentEffectSlot !== effectSlot) {
            let patch = this.freezeCurrentPatch ? this.currentPatch.clone() : this.currentPatch;
            patch.currentEffectSlot = effectSlot;
            if (this._supportedCommands.get(ZoomDevice.messageTypes.parameterValueV2.str) === SupportType.Supported) {
                // Change current effect slot using sysex command 64 20 00 64 01
                // FIXME: Optimize this. Use preallocated memory instead of allocating each time. Look at constructor.
                // This should be one buffer for the whole sysex message
                let parameterBuffer = new Uint8Array(7);
                parameterBuffer[0] = 0x64;
                parameterBuffer[1] = 0x01;
                parameterBuffer[2] = effectSlot;
                let command = new Uint8Array(ZoomDevice.messageTypes.parameterValueV2.bytes.length + parameterBuffer.length);
                command.set(ZoomDevice.messageTypes.parameterValueV2.bytes);
                command.set(parameterBuffer, ZoomDevice.messageTypes.parameterValueV2.bytes.length);
                this.sendCommand(command);
            }
            else {
                // Change current effect slot by updating current patch with the correct effect slot number
                patch.updatePatchPropertiesFromDerivedProperties();
                this.uploadPatchToCurrentPatch(patch);
            }
            if (this.freezeCurrentPatch) {
                this._currentPatch = patch;
                this._currentEffectSlot = this._currentPatch.currentEffectSlot;
                Object.freeze(this._currentPatch);
            }
            this._currentEffectSlot = effectSlot;
        }
    }
    setEffectParameterForCurrentPatch(effectSlot, parameterNumber, value, force = false) {
        if (this.currentPatch === undefined) {
            shouldLog(LogLevel.Error) && console.error(`Unable to set effect parameter for current patch because currentPatch is undefined`);
            return;
        }
        let intValue = Math.round(value); // value should always be an integer. Screen functionality will fail if it's not an integer.
        if (intValue !== value) {
            shouldLog(LogLevel.Warning) && console.warn(`setEffectParameterForCurrentPatch() - value ${value} is not an integer, rounding to ${intValue}`);
            value = intValue;
        }
        let parameterIndex = parameterNumber - 2;
        if (!force && this.currentPatch !== null && this.currentPatch.effectSettings !== null && effectSlot < this.currentPatch.effectSettings.length &&
            parameterIndex < this.currentPatch.effectSettings[effectSlot].parameters.length &&
            this.currentPatch.effectSettings[effectSlot].parameters[parameterIndex] === value) {
            return; // no need to send updated value, since it's the same as the current value 
        }
        let patch = this.freezeCurrentPatch ? this.currentPatch.clone() : this.currentPatch;
        if (patch.effectSettings === null || effectSlot >= patch.effectSettings.length || parameterIndex >= patch.effectSettings[effectSlot].parameters.length) {
            shouldLog(LogLevel.Error) && console.error(`Unable to set effect parameter for current patch because effectSlot ${effectSlot} or parameterIndex ${parameterIndex} is out of range`);
            return;
        }
        let effectSettings = patch.effectSettings[effectSlot];
        if (parameterNumber === 0) {
            effectSettings.enabled = value !== 0;
        }
        else if (parameterNumber === 1) {
            effectSettings.id = value;
            // The pedal will automatically update the parameters to default values, so we do it here as well
            if (this.effectIDMap !== undefined)
                ZoomDevice.setDefaultsForEffect(effectSettings, this.effectIDMap);
            else
                shouldLog(LogLevel.Warning) && console.warn(`Unable to set effect parameter for current patch because effectIDMap is undefined`);
            patch.changeEffectInSlot(effectSlot, effectSettings);
        }
        else {
            patch.effectSettings[effectSlot].parameters[parameterIndex] = value;
        }
        this._currentEffectSlot = effectSlot;
        this._currentEffectParameterNumber = parameterNumber;
        this._currentEffectParameterValue = value;
        if (this._supportedCommands.get(ZoomDevice.messageTypes.parameterValueV2.str) === SupportType.Supported) {
            // FIXME: Optimize this. Use preallocated memory instead of allocating each time. Look at constructor.
            // This should be one buffer for the whole sysex message
            let parameterBuffer = new Uint8Array(7);
            parameterBuffer[0] = effectSlot;
            parameterBuffer[1] = parameterNumber;
            parameterBuffer[2] = value & 0b01111111; // LSB
            parameterBuffer[3] = (value >> 7) & 0b01111111; // MSB
            parameterBuffer[4] = (value >> 14) & 0b01111111;
            parameterBuffer[5] = (value >> 21) & 0b01111111;
            parameterBuffer[6] = (value >> 28) & 0b01111111;
            let command = new Uint8Array(ZoomDevice.messageTypes.parameterValueV2.bytes.length + parameterBuffer.length);
            command.set(ZoomDevice.messageTypes.parameterValueV2.bytes);
            command.set(parameterBuffer, ZoomDevice.messageTypes.parameterValueV2.bytes.length);
            this.sendCommand(command);
        }
        else if (this._supportedCommands.get(ZoomDevice.messageTypes.parameterValueV1.str) === SupportType.Supported) {
            if (effectSlot < 3) {
                // FIXME: Store "3" in a constant somewhere
                // FIXME: Optimize this. Use preallocated memory instead of allocating each time. Look at constructor.
                // This should be one buffer for the whole sysex message
                let parameterBuffer = new Uint8Array(4);
                parameterBuffer[0] = effectSlot;
                parameterBuffer[1] = parameterNumber;
                parameterBuffer[2] = value & 0b01111111; // LSB
                parameterBuffer[3] = (value >> 7) & 0b01111111; // MSB
                let command = new Uint8Array(ZoomDevice.messageTypes.parameterValueV1.bytes.length + parameterBuffer.length);
                command.set(ZoomDevice.messageTypes.parameterValueV1.bytes);
                command.set(parameterBuffer, ZoomDevice.messageTypes.parameterValueV1.bytes.length);
                this.sendCommand(command);
            }
            else {
                this.uploadPatchToCurrentPatch(patch);
            }
        }
        if (this.freezeCurrentPatch) {
            this._currentPatch = patch;
            this._currentEffectSlot = this._currentPatch.currentEffectSlot;
            Object.freeze(this._currentPatch);
        }
        // FIXME: Consider not updating screens here, but rather on demand when the user requests it, in the currentScreenCollection getter
        if (this._autoUpdateScreens && this.currentScreenCollection !== undefined && this.effectIDMap !== undefined) {
            this.currentScreenCollection.setEffectParameterValue(this.currentPatch, this.effectIDMap, effectSlot, parameterNumber, value);
            this.emitScreenChangedEvent();
        }
        this.emitEffectParameterChangedEvent();
    }
    deleteScreenForEffectInSlot(effectSlot) {
        // Update screens
        if (this.currentScreenCollection !== undefined)
            this.currentScreenCollection.deleteScreen(effectSlot);
        this.emitScreenChangedEvent();
    }
    addScreenForEffectInSlot(effectSlot, screen) {
        // Update screens
        if (this.currentScreenCollection !== undefined)
            this.currentScreenCollection.insertScreen(effectSlot, screen);
        this.emitScreenChangedEvent();
    }
    swapScreensForEffectSlots(effectSlot1, effectSlot2) {
        // Update screens
        if (this.currentScreenCollection !== undefined)
            this.currentScreenCollection.swapScreens(effectSlot1, effectSlot2);
        this.emitScreenChangedEvent();
    }
    updateScreenForEffectInSlot(effectSlot, effectMap, effectSettings) {
        // Update screens
        if (this.currentScreenCollection !== undefined)
            this.currentScreenCollection.updateScreen(effectSlot, effectMap, effectSettings);
        this.emitScreenChangedEvent();
    }
    async downloadCurrentPatch() {
        let reply;
        let eightBitData = undefined;
        if (this._supportedCommands.get(ZoomDevice.messageTypes.requestCurrentPatchV2.str) === SupportType.Supported) {
            reply = await this.sendCommandAndGetReply(ZoomDevice.messageTypes.requestCurrentPatchV2.bytes, received => this.zoomCommandMatch(received, ZoomDevice.messageTypes.patchDumpForCurrentPatchV2.bytes));
            if (reply !== undefined) {
                let offset = 9;
                eightBitData = seven2eight(reply, offset, reply.length - 2); // skip the last byte (0x7F)in the sysex message
            }
        }
        else {
            reply = await this.sendCommandAndGetReply(ZoomDevice.messageTypes.requestCurrentPatchV1.bytes, received => this.zoomCommandMatch(received, ZoomDevice.messageTypes.patchDumpForCurrentPatchV1.bytes));
            // FIXME: Untested code below, used to return data buffer, not patch
            if (reply !== undefined) {
                let offset = 5;
                eightBitData = seven2eight(reply, offset, reply.length - 2);
            }
        }
        if (eightBitData != undefined) {
            this._currentPatchData = undefined;
            this._currentPatch = ZoomPatch.fromPatchData(eightBitData);
            this._currentEffectSlot = this._currentPatch.currentEffectSlot;
            if (this.freezeCurrentPatch)
                Object.freeze(this._currentPatch);
            return this._currentPatch;
        }
        else
            return undefined;
    }
    requestCurrentPatch() {
        if (this._supportedCommands.get(ZoomDevice.messageTypes.requestCurrentPatchV2.str) === SupportType.Supported)
            this.sendCommand(ZoomDevice.messageTypes.requestCurrentPatchV2.bytes);
        else
            this.sendCommand(ZoomDevice.messageTypes.requestCurrentPatchV1.bytes);
    }
    /**
     *
     * @param skipCommandCheck send the midi command even if we don't know if it's supported
     * @param timeoutMilliseconds
     * @returns [bank | undefined, program | undefined]
     */
    async getCurrentBankAndProgram(skipCommandCheck = false, timeoutMilliseconds = this._timeoutMilliseconds) {
        if (!skipCommandCheck && this._supportedCommands.get(ZoomDevice.messageTypes.requestCurrentBankAndProgramV1.str) !== SupportType.Supported)
            return [undefined, undefined];
        let bank = -1;
        let program = -1;
        let reply = await this.sendCommandAndGetReply(ZoomDevice.messageTypes.requestCurrentBankAndProgramV1.bytes, (received) => {
            // expected reply is 2 optional bank messages (B0 00 00, B0 20 NN) and then one program change message (C0 NN)
            let [messageType, channel, data1, data2] = getChannelMessage(received);
            if (messageType === MessageType.CC && data1 === 0x00) {
                if (bank === -1)
                    bank = 0;
                bank = bank | (data2 << 7);
                return false;
            }
            else if (messageType === MessageType.CC && data1 === 0x20) {
                if (bank === -1)
                    bank = 0;
                bank = bank | data2;
                return false;
            }
            else if (messageType === MessageType.PC) {
                program = data1;
                return true;
            }
            else
                return false;
        }, null, null, timeoutMilliseconds);
        if (program === -1)
            return [undefined, undefined];
        this._previousProgram = this._currentProgram;
        this._currentProgram = program;
        if (bank !== -1) {
            this._previousBank = this._currentBank;
            this._currentBank = bank;
        }
        return [bank !== -1 ? bank : undefined, program];
    }
    async getCurrentMemorySlotNumber() {
        let [bank, program] = await this.getCurrentBankAndProgram();
        if (program !== undefined && this._patchesPerBank !== -1 && bank !== undefined)
            program += bank * this._patchesPerBank;
        return program;
    }
    async downloadScreens(startScreen = 0, endScreen = 12) {
        if (!(this._supportedCommands.get(ZoomDevice.messageTypes.requestScreensForCurrentPatch.str) === SupportType.Supported)) {
            shouldLog(LogLevel.Warning) && console.warn(`Attempting to get screens when the command is not supported by the device (${this.deviceName})`);
            return undefined;
        }
        let reply;
        let screens = undefined;
        let screenRange = new Uint8Array(3);
        screenRange[0] = startScreen;
        screenRange[1] = endScreen; // anything >= 6 would get all screens on an MS+ pedal
        screenRange[2] = 0;
        let command = new Uint8Array(ZoomDevice.messageTypes.requestScreensForCurrentPatch.bytes.length + screenRange.length);
        command.set(ZoomDevice.messageTypes.requestScreensForCurrentPatch.bytes);
        command.set(screenRange, ZoomDevice.messageTypes.requestScreensForCurrentPatch.bytes.length);
        reply = await this.sendCommandAndGetReply(command, received => this.zoomCommandMatch(received, ZoomDevice.messageTypes.screensForCurrentPatch.bytes));
        if (reply === undefined) {
            shouldLog(LogLevel.Warning) && console.warn(`Didn't get a reply when asking for screens for current patch for the device (${this.deviceName})`);
            return undefined;
        }
        let offset = 6;
        let screenCollection = ZoomScreenCollection.fromScreenData(reply, offset);
        return screenCollection;
    }
    requestScreens() {
        if (!(this._supportedCommands.get(ZoomDevice.messageTypes.requestScreensForCurrentPatch.str) === SupportType.Supported)) {
            shouldLog(LogLevel.Warning) && console.warn(`Attempting to get screens when the command is not supported by the device (${this.deviceName})`);
            return undefined;
        }
        let screenRange = new Uint8Array(3);
        screenRange[0] = 0;
        screenRange[1] = 12; // anything >= 6 really
        screenRange[2] = 0;
        let command = new Uint8Array(ZoomDevice.messageTypes.requestScreensForCurrentPatch.bytes.length + screenRange.length);
        command.set(ZoomDevice.messageTypes.requestScreensForCurrentPatch.bytes);
        command.set(screenRange, ZoomDevice.messageTypes.requestScreensForCurrentPatch.bytes.length);
        this.sendCommand(command);
    }
    requestPatchFromMemorySlot(memorySlot) {
        if (this._supportedCommands.get(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV2.str) === SupportType.Supported) {
            let bank = Math.floor(memorySlot / this._patchesPerBank);
            let program = memorySlot % this._patchesPerBank;
            let bankProgram = new Uint8Array(4);
            bankProgram[0] = bank & 0x7F;
            bankProgram[1] = (bank >> 7) & 0x7F;
            bankProgram[2] = program & 0x7F;
            bankProgram[3] = (program >> 7) & 0x7F;
            let command = new Uint8Array(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV2.bytes.length + bankProgram.length);
            command.set(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV2.bytes);
            command.set(bankProgram, ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV2.bytes.length);
            this.sendCommand(command);
        }
        else {
            // Use v1 command to download patch
            let command = new Uint8Array(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV1.bytes.length + 1);
            command.set(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV1.bytes);
            command[ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV1.bytes.length] = memorySlot;
            this.sendCommand(command);
        }
    }
    async downloadPatchFromMemorySlot(memorySlot) {
        let reply;
        let eightBitData = undefined;
        if (this._supportedCommands.get(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV2.str) === SupportType.Supported) {
            let bank = Math.floor(memorySlot / this._patchesPerBank);
            let program = memorySlot % this._patchesPerBank;
            let bankProgram = new Uint8Array(4);
            bankProgram[0] = bank & 0x7F;
            bankProgram[1] = (bank >> 7) & 0x7F;
            bankProgram[2] = program & 0x7F;
            bankProgram[3] = (program >> 7) & 0x7F;
            let command = new Uint8Array(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV2.bytes.length + bankProgram.length);
            command.set(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV2.bytes);
            command.set(bankProgram, ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV2.bytes.length);
            reply = await this.sendCommandAndGetReply(command, received => this.zoomCommandMatch(received, ZoomDevice.messageTypes.patchDumpForMemoryLocationV2.bytes));
            if (reply !== undefined) {
                let offset = 13;
                eightBitData = seven2eight(reply, offset, reply.length - 2);
            }
        }
        else {
            // Use v1 command to download patch
            let command = new Uint8Array(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV1.bytes.length + 1);
            command.set(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV1.bytes);
            command[ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV1.bytes.length] = memorySlot;
            reply = await this.sendCommandAndGetReply(command, received => this.zoomCommandMatch(received, ZoomDevice.messageTypes.patchDumpForMemoryLocationV1.bytes));
            if (reply !== undefined) {
                let offset = 10;
                eightBitData = seven2eight(reply, offset, reply.length - 2 - this._patchDumpForMemoryLocationV1CRCBytes);
            }
        }
        if (eightBitData != undefined) {
            let patch = ZoomPatch.fromPatchData(eightBitData);
            return patch;
        }
        else
            return undefined;
    }
    uploadPatchToCurrentPatch(patch, cacheCurrentPatch = true) {
        let data;
        if (patch.PTCF !== null)
            data = patch.buildPTCFChunk(this._ptcfNameLength);
        else
            data = patch.buildMSDataBuffer();
        if (data === undefined || data.length < 11) {
            shouldLog(LogLevel.Error) && console.error(`ZoomDevice.uploadCurrentPatch() received invalid patch parameter - possibly because of a failed ZoomPatch.buildPTCFChunk() or ZoomPatch.buildMSDataBuffer()`);
            return;
        }
        let paddedData = data;
        if (this._patchLength != -1) {
            if (data.length > paddedData.length) {
                shouldLog(LogLevel.Error) && console.error(`The length of the supplied patch data (${data.length}) is greater than the patch length reported by the pedal (${this._patchLength}).`);
                return;
            }
            if (patch.MSOG !== null && this._patchLength !== data.length) {
                shouldLog(LogLevel.Error) && console.error(`The length of the supplied patch data (${data.length}) doesn't match the expected patch length reported by the pedal (${this._patchLength}).`);
                return;
            }
            paddedData = new Uint8Array(this._patchLength);
            paddedData.set(data);
        }
        let sevenBitData = eight2seven(paddedData);
        this.sendCommand(sevenBitData, ZoomDevice.messageTypes.patchDumpForCurrentPatchV1.bytes);
        if (cacheCurrentPatch) {
            this._currentPatchData = undefined;
            if (patch !== this._currentPatch) {
                this._currentPatch = patch.clone();
                this._currentEffectSlot = this._currentPatch.currentEffectSlot;
                if (this.freezeCurrentPatch)
                    Object.freeze(this._currentPatch);
                if (!this._isMappingParameters)
                    this.emitCurrentPatchChangedEvent(); // Note 2025-11-23: Not sure if this is safe. Added for manual loading of current patch, for currentPatch (index.ts) to be updated before updateScreens() is called.
            }
        }
        if (this._isMappingParameters)
            return;
        this.updateScreens();
    }
    /**
     * Uploads the given patch to the specified memory slot on the pedal. The internal patch list is updated with this new patch.
     * @param patch
     * @param memorySlot Zero-based memory location. Typically between 0-49 or 0-99 depending on pedal.
     * @param [waitForAcknowledge=true]
     * @returns true if the patch was uploaded successfully, false otherwise
     */
    async uploadPatchToMemorySlot(patch, memorySlot, waitForAcknowledge = true) {
        let sevenBitData;
        let crcBytes;
        let command;
        if (patch.PTCF !== null) {
            let data = patch.buildPTCFChunk(this._ptcfNameLength);
            //let data = patch.ptcfChunk;
            if (data === undefined || data.length < 11) {
                shouldLog(LogLevel.Error) && console.error(`ZoomDevice.uploadPatchToMemorySlot() received invalid patch parameter - possibly because of a failed ZoomPatch.buildPTCFChunk()`);
                return false;
            }
            let paddedData = data;
            if (this._patchLength != -1) {
                if (data.length > this._patchLength) {
                    shouldLog(LogLevel.Error) && console.error(`The length of the supplied patch data (${data.length}) is greater than the patch length reported by the pedal (${this._patchLength}).`);
                    return false;
                }
                paddedData = new Uint8Array(this._patchLength);
                paddedData.set(data);
            }
            sevenBitData = eight2seven(paddedData);
            crcBytes = this.getSevenBitCRC(paddedData);
            let bankProgramLengthArray = this.getBankProgramLengthArray(memorySlot, paddedData.length);
            command = new Uint8Array(ZoomDevice.messageTypes.patchDumpForMemoryLocationV2.bytes.length + bankProgramLengthArray.length);
            command.set(ZoomDevice.messageTypes.patchDumpForMemoryLocationV2.bytes);
            command.set(bankProgramLengthArray, ZoomDevice.messageTypes.patchDumpForMemoryLocationV2.bytes.length);
        }
        else if (patch.msogDataBuffer !== null) {
            let data = patch.buildMSDataBuffer();
            // let data = patch.msogDataBuffer;
            if (data === undefined || data.length < 11) {
                shouldLog(LogLevel.Error) && console.error(`ZoomDevice.uploadPatchToMemorySlot() received invalid patch parameter - possibly because of a failed ZoomPatch.buildMSDataBuffer()`);
                return false;
            }
            if (this._patchLength != -1 && data.length > this._patchLength) {
                shouldLog(LogLevel.Error) && console.error(`The length of the supplied patch data (${data.length}) is greater than the patch length reported by the pedal (${this._patchLength}).`);
                return false;
            }
            sevenBitData = eight2seven(data);
            crcBytes = this.getSevenBitCRC(data);
            let programLengthArray = this.getProgramLengthArray(memorySlot, data.length);
            command = new Uint8Array(ZoomDevice.messageTypes.patchDumpForMemoryLocationV1.bytes.length + programLengthArray.length);
            command.set(ZoomDevice.messageTypes.patchDumpForMemoryLocationV1.bytes);
            command.set(programLengthArray, ZoomDevice.messageTypes.patchDumpForMemoryLocationV1.bytes.length);
        }
        else {
            shouldLog(LogLevel.Error) && console.error(`ZoomDevice.uploadPatchToMemorySlot() received Invalid patch parameter (no ptcf chunk and no MSOG data)`);
            return false;
        }
        if (waitForAcknowledge) {
            let reply = await this.sendCommandAndGetReply(sevenBitData, received => this.zoomCommandMatch(received, ZoomDevice.messageTypes.success.bytes), command, crcBytes);
            if (reply === undefined) {
                shouldLog(LogLevel.Warning) && console.warn(`Didn't get reply after uploading patch ${patch.name} to memory slot ${memorySlot}`);
            }
        }
        else
            this.sendCommand(sevenBitData, command, crcBytes);
        if (memorySlot < this._patchList.length) {
            let clonedPatch = patch.clone();
            Object.freeze(clonedPatch);
            this._patchList[memorySlot] = clonedPatch;
            this._rawPatchList[memorySlot] = undefined;
        }
        return true;
    }
    async updatePatchListFromPedal() {
        this._patchListDownloadInProgress = true;
        if (this._numPatches === -1) {
            shouldLog(LogLevel.Warning) && console.warn("Attempting to download patches from pedal without knowing how many patches are stored on the pedal (this._numPatches = -1)");
        }
        let maxNumPatches = this._numPatches === -1 ? 500 : this._numPatches;
        if (this._patchList.length !== maxNumPatches)
            this._patchList = new Array(maxNumPatches);
        for (let i = 0; i < maxNumPatches; i++) {
            let patch = await this.downloadPatchFromMemorySlot(i);
            if (patch === undefined) {
                shouldLog(LogLevel.Info) && console.log(`Got no reply for patch number ${i} while attempting to download patches from device ${this.deviceName}`);
                this._patchList.splice(i);
                this._numPatches = i;
                break;
            }
            Object.freeze(patch);
            this._patchList[i] = patch;
            this._rawPatchList[i] = undefined;
        }
        this._patchListDownloadInProgress = false;
    }
    get deviceInfo() {
        return this._midiDevice;
    }
    get deviceName() {
        return this._midiDevice.deviceNameUnique;
    }
    set deviceName(value) {
        this._midiDevice.deviceNameUnique = value;
    }
    get isOpen() {
        return this._isOpen;
    }
    get currentMemorySlotNumber() {
        let memorySlot = this._currentProgram;
        if (this._patchesPerBank !== -1 && this._currentBank !== -1)
            memorySlot += this._currentBank * this._patchesPerBank;
        return memorySlot;
    }
    get patchList() {
        this.syncPatchList();
        return this._patchList;
    }
    /**
     * Makes sure the patchList is updated with the latest unparsed patches.
     * Received patches aren't parsed immediately, since that is a semi-expensive operation
     * and the MS Plus pedals will send patch messages a few seconds after parameter edit (if auto-save is enabled).
     * After this method is called, all patches in the patch list will be parsed.
     */
    syncPatchList() {
        for (let i = 0; i < this._rawPatchList.length; i++) {
            let data = this._rawPatchList[i];
            if (data !== undefined) {
                this._rawPatchList[i] = undefined;
                let [patch, memorySlot] = this.parsePatchFromMemorySlot(data);
                if (patch === undefined || memorySlot === undefined)
                    shouldLog(LogLevel.Warning) && console.warn(`Error when parsing patch from memory slot, data.length: ${data.length}, patch: ${patch}, memorySlot: ${memorySlot}`);
                else if (memorySlot !== i)
                    shouldLog(LogLevel.Warning) && console.warn(`Parsed patch is for memory slot ${memorySlot} but expected memory slot to be ${i}`);
                else {
                    Object.freeze(patch);
                    this._patchList[memorySlot] = patch;
                }
            }
        }
    }
    getSysexForCurrentPatch(patch) {
        let data;
        if (patch.PTCF !== null) {
            if (Object.isFrozen(patch) && patch.ptcfChunk !== null) {
                data = patch.ptcfChunk;
            }
            else {
                data = patch.buildPTCFChunk(this._ptcfNameLength);
            }
            // FIXME: Untested code
        }
        else {
            if (Object.isFrozen(patch) && patch.msogDataBuffer !== null) {
                data = patch.msogDataBuffer;
            }
            else {
                data = patch.buildMSDataBuffer();
            }
            // if (patch.msogDataBuffer !== null && this.isCommandSupported(ZoomDevice.messageTypes.requestCurrentPatchV1)) {
            //   let sevenBitData = eight2seven(patch.msogDataBuffer);
            //   return this.getCommandBufferFromData(sevenBitData, ZoomDevice.messageTypes.patchDumpForCurrentPatchV1.bytes, null, false);
            // }
        }
        if (data === undefined) {
            shouldLog(LogLevel.Error) && console.error(`No data to get sysex for patch ${patch.name}`);
            return undefined;
        }
        let sevenBitData;
        let prependCommand = null;
        let crcBytes = null;
        if (this.isCommandSupported(ZoomDevice.messageTypes.requestCurrentPatchV1)) {
            prependCommand = ZoomDevice.messageTypes.patchDumpForCurrentPatchV1.bytes;
            sevenBitData = eight2seven(data);
        }
        else if (this.isCommandSupported(ZoomDevice.messageTypes.requestCurrentPatchV2)) {
            if (data === undefined || data.length < 11) {
                shouldLog(LogLevel.Error) && console.error(`ZoomDevice.uploadPatchToMemorySlot() received invalid patch parameter - possibly because of a failed ZoomPatch.buildPTCFChunk()`);
                return undefined;
            }
            let paddedData = data;
            if (this._patchLength != -1) {
                if (data.length > this._patchLength) {
                    shouldLog(LogLevel.Error) && console.error(`The length of the supplied patch data (${data.length}) is greater than the patch length reported by the pedal (${this._patchLength}).`);
                    return undefined;
                }
                paddedData = new Uint8Array(this._patchLength);
                paddedData.set(data);
            }
            sevenBitData = eight2seven(paddedData);
            crcBytes = this.getSevenBitCRC(paddedData);
            let patchLengthLSB = this._patchLength & 0x7F;
            let patchLengthMSB = (this._patchLength >> 7) & 0x7F;
            prependCommand = new Uint8Array(ZoomDevice.messageTypes.patchDumpForCurrentPatchV2.bytes.length + 3);
            prependCommand.set(ZoomDevice.messageTypes.patchDumpForCurrentPatchV2.bytes);
            prependCommand[ZoomDevice.messageTypes.patchDumpForCurrentPatchV2.bytes.length] = 0x01;
            prependCommand[ZoomDevice.messageTypes.patchDumpForCurrentPatchV2.bytes.length + 1] = patchLengthLSB;
            prependCommand[ZoomDevice.messageTypes.patchDumpForCurrentPatchV2.bytes.length + 2] = patchLengthMSB;
            // F0 52 00 6E 64 12 01 50 06 00 50 54 43 46
            //             ^^^^^--------------------------- patchDumpForCurrentPatchV2
            //                   ^^------------------------ Always 01
            //                      ^^--------------------- Patch length LSB
            //                         ^^------------------ Patch length MSB
            //                            ^^--------------- Always 00, this is the high 8th bit of the next 7 data values, this is also the start of patch data
            //                               ^^------------ P
            //                                  ^^--------- T
            //                                     ^^------ C
            //                                        ^^--- F
        }
        else {
            shouldLog(LogLevel.Error) && console.error(`No available command to get sysex for patch ${patch.name}`);
            return undefined;
        }
        return this.getCommandBufferFromData(sevenBitData, prependCommand, crcBytes, false);
    }
    /**
     *
     * @returns [file ending, file ending with no dots, file description]
     */
    getSuggestedFileEndingForPatch() {
        let ending = "";
        let shortEnding = "";
        let description = `${this.deviceInfo.deviceName} patch file`;
        if (this.deviceInfo.deviceName.startsWith("MS-"))
            ending = this.deviceInfo.deviceName.slice(3, this.deviceInfo.deviceName.length).replace("+", "p").toLowerCase();
        if (this._ptcfPatchFormatSupported) {
            ending += ".zptc";
            shortEnding = "zptc";
        }
        else
            shortEnding = ending;
        if (ending === "")
            ending = "syx";
        return [ending, shortEnding, description];
    }
    get isPTCFPatchFormatSupported() {
        return this._ptcfPatchFormatSupported;
    }
    /**
     * Converts a sysex message with 7-bit data to 8-bit patch-data
     * @param sysexData sysex message
     * @returns [8-bit patch-data, program, bank]
     */
    static sysexToPatchData(sysexData) {
        let program = undefined;
        let bank = undefined;
        let patchData = undefined;
        let currentPatchV2 = partialArrayMatch(sysexData, ZoomDevice.messageTypes.patchDumpForCurrentPatchV2.bytes, 4);
        let memoryLocationV2 = partialArrayMatch(sysexData, ZoomDevice.messageTypes.patchDumpForMemoryLocationV2.bytes, 4);
        let currentPatchV1 = partialArrayMatch(sysexData, ZoomDevice.messageTypes.patchDumpForCurrentPatchV1.bytes, 4);
        let memoryLocationV1 = partialArrayMatch(sysexData, ZoomDevice.messageTypes.patchDumpForMemoryLocationV1.bytes, 4);
        if (!(sysexData.length > 10 && (currentPatchV2 || memoryLocationV2 || currentPatchV1 || memoryLocationV1))) {
            shouldLog(LogLevel.Warning) && console.warn(`Attempted to convert invalid sysex of length ${sysexData.length} to patch data`);
            return [patchData, program, bank];
        }
        let offset = 0;
        let patchLengthFromSysex = 0;
        let numberOfCRCBytes = 0;
        if (currentPatchV1) {
            patchLengthFromSysex = 0;
            offset = 5;
        }
        else if (memoryLocationV1) {
            // FIXME: This code is untested. In particular, I'm uncertain about the crc / length calculations.
            patchLengthFromSysex = sysexData[8] + (sysexData[9] << 7);
            offset = 10;
        }
        else if (currentPatchV2) {
            patchLengthFromSysex = sysexData[7] + (sysexData[8] << 7);
            offset = 9;
        }
        else { // memoryLocationV2
            patchLengthFromSysex = sysexData[11] + (sysexData[12] << 7);
            offset = 13;
        }
        let possibleNumberOfCRCBytes = 5;
        let zeroPaddingAtEndOfPatch = 1;
        let [numberOf8BitBytes, remainder] = getNumberOfEightBitBytes(sysexData.length - offset - zeroPaddingAtEndOfPatch - possibleNumberOfCRCBytes);
        if (numberOf8BitBytes == patchLengthFromSysex) // lengths match if we account for CRC bytes
            numberOfCRCBytes = possibleNumberOfCRCBytes;
        patchData = seven2eight(sysexData, offset, sysexData.length - 1 - zeroPaddingAtEndOfPatch - numberOfCRCBytes);
        if (patchLengthFromSysex !== 0 && patchData.length != patchLengthFromSysex) {
            shouldLog(LogLevel.Warning) && console.warn(`Patch data length (${patchData.length}) does not match the patch length specified in the sysex message (${patchLengthFromSysex}). numberOfCRCBytes: ${numberOfCRCBytes}.`);
        }
        return [patchData, program, bank];
    }
    static getZoomVersionNumber(versionBytes) {
        let versionString = String.fromCharCode(...versionBytes);
        let versionFloat = parseFloat(versionString);
        return versionFloat;
    }
    isCommandSupported(command) {
        return this._supportedCommands.get(command.str) === SupportType.Supported;
    }
    startAutoRequestProgramChangeIfNeeded() {
        if (!this._isOpen)
            return;
        if (!this._autoRequestProgramChange)
            return;
        if (!this.isCommandSupported(ZoomDevice.messageTypes.requestCurrentBankAndProgramV1))
            return;
        // if (this.isCommandSupported(ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV1) && !this._ptcfPatchFormatSupported) {
        if (!this._bankAndProgramSentOnUpdate) {
            // This is a weak test to determine if we have an older pedal (like the original MS Series)
            // We should really determine by probing if patch changed events are sent when patches change (?). 
            //   -> then I mist see if MS+ actually does this ...
            // We assume that older pedals don't send program change messages automatically, so we have to poll instead
            this._autoRequestProgramChangeMuteLog = false;
            let device = this;
            this._autoRequestProgramChangeTimerID = setInterval(() => {
                device.autoRequestProgramChangeTimer();
            }, this._autoRequestProgramChangeIntervalMilliseconds);
            shouldLog(LogLevel.Info) && console.log(`Starting auto-request program change timer for ZoomDevice ${this._zoomDeviceID}`);
            this._autoRequestProgramChangeTimerStarted = true;
            shouldLog(LogLevel.Info) && console.log(`Started regular polling of program change (timer ID ${this._autoRequestProgramChangeTimerID}). Muting logging of program and bank requests and the bank and program change message.`);
        }
    }
    autoRequestProgramChangeTimer() {
        if (this._patchListDownloadInProgress)
            return; // don't send program change requests while the patch list is being downloaded
        // Temporarily mute logging, so log isn't so chatty
        let logLevel = getLogLevel();
        if (logLevel & LogLevel.Midi)
            setLogLevel(logLevel & ~LogLevel.Midi);
        this._autoRequestProgramChangeMuteLog = true; // mute next bank change(s) and program change message, to make the log less chatty
        this.sendCommand(ZoomDevice.messageTypes.requestCurrentBankAndProgramV1.bytes);
        if (logLevel & LogLevel.Midi)
            setLogLevel(logLevel);
    }
    getSevenBitCRC(data) {
        let crc = crc32(data, 0, data.length - 1);
        crc = crc ^ 0xFFFFFFFF;
        let crcBytes = new Uint8Array([crc & 0x7F, (crc >> 7) & 0x7F, (crc >> 14) & 0x7F, (crc >> 21) & 0x7F, (crc >> 28) & 0x0F]);
        return crcBytes;
    }
    getBankProgramLengthArray(memorySlot, length) {
        let bank = Math.floor(memorySlot / this._patchesPerBank);
        let program = memorySlot % this._patchesPerBank;
        let bankProgramLength = new Uint8Array(6);
        bankProgramLength[0] = bank & 0x7F;
        bankProgramLength[1] = (bank >> 7) & 0x7F;
        bankProgramLength[2] = program & 0x7F;
        bankProgramLength[3] = (program >> 7) & 0x7F;
        bankProgramLength[4] = length & 0x7F;
        bankProgramLength[5] = (length >> 7) & 0x7F;
        return bankProgramLength;
    }
    getProgramLengthArray(memorySlot, length) {
        let program = memorySlot;
        let programLength = new Uint8Array(3);
        programLength[0] = program & 0x7F;
        programLength[1] = length & 0x7F;
        programLength[2] = (length >> 7) & 0x7F;
        return programLength;
    }
    parsePatchFromMemorySlot(data) {
        let offset = 0;
        let crcBytes = 0;
        let memorySlot = 0;
        if (this.isMessageType(data, ZoomDevice.messageTypes.patchDumpForMemoryLocationV1)) {
            offset = 10;
            crcBytes = this._patchDumpForMemoryLocationV1CRCBytes;
            memorySlot = data[7];
        }
        else {
            offset = 13;
            crcBytes = 0;
            let bank = data[7] + ((data[8] & 0b0111111) >> 7);
            let program = data[9] + ((data[10] & 0b0111111) >> 7);
            if (this._patchesPerBank !== -1)
                program += bank * this._patchesPerBank;
            memorySlot = program;
        }
        let eightBitData = seven2eight(data, offset, data.length - 2 - crcBytes); // skip the last byte (0x7F)in the sysex message, and crc bytes if v1 message
        if (eightBitData !== undefined) {
            let patch = ZoomPatch.fromPatchData(eightBitData);
            return [patch, memorySlot];
        }
        return [undefined, undefined];
    }
    /**
     * Parses data as if it was a parameter update message and returns effect slot, parameter number and parameter value for the edited parameter
     * @param data MIDI data buffer
     * @returns [effectSlot, paramNumber, paramValue], on error [-1, -1, -1] will be returned
     */
    getEffectEditParameters(data) {
        let effectSlot = -1;
        let paramNumber = -1;
        let paramValue = -1;
        let [messageType, channel, data1, data2] = getChannelMessage(data);
        if (messageType === MessageType.SysEx && data.length === 15 && data[4] === 0x64 && data[5] === 0x20) {
            // Parameter was edited on device (MS Plus series)
            effectSlot = data[7];
            paramNumber = data[8];
            paramValue = data[9] + ((data[10] & 0b01111111) << 7);
        }
        else if (messageType === MessageType.SysEx && data.length === 10 && data[4] === 0x31) {
            // Parameter was edited on device (MS series)
            effectSlot = data[5];
            paramNumber = data[6];
            paramValue = data[7] + ((data[8] & 0b01111111) << 7);
        }
        else {
            shouldLog(LogLevel.Warning) && console.warn(`Expected effect parameter edit message but got something else. data.length = ${data.length}, message type ${messageType}.`);
        }
        return [effectSlot, paramNumber, paramValue];
    }
    isMessageType(data, messageType) {
        if (data[0] !== MessageType.SysEx || data.length < 4 + messageType.bytes.length)
            return false;
        for (let i = 0; i < messageType.bytes.length; i++)
            if (data[4 + i] != messageType.bytes[i])
                return false;
        return true;
    }
    setDeviceType() {
    }
    sendZoomCommandNumbers(...data) {
        let commandLength = 5 + data.length;
        let output = this._midi.getOutputInfo(this._midiDevice.outputID);
        if (output === undefined) {
            shouldLog(LogLevel.Warning) && console.warn(`WARNING: Not sending MIDI message to device ${this._midiDevice.outputID} as the device is unknown"`);
            return;
        }
        if (output.connection != "open") {
            shouldLog(LogLevel.Warning) && console.warn(`WARNING: Not sending MIDI message to device ${output.name} as the port is in state "${output.connection}"`);
            return;
        }
        let commandBuffer = this._commandBuffers.get(commandLength);
        if (commandBuffer === undefined) {
            commandBuffer = new Uint8Array(commandLength);
            commandBuffer[0] = 0xF0;
            commandBuffer[1] = 0x52;
            commandBuffer[3] = this._zoomDeviceID;
            commandBuffer[commandBuffer.length - 1] = 0xF7;
            this._commandBuffers.set(commandLength, commandBuffer);
        }
        commandBuffer.set(data, 4);
        try {
            this._midi.send(this._midiDevice.outputID, commandBuffer);
        }
        catch (err) {
            let message = getExceptionErrorString(err, `for device ${output.name}`);
            shouldLog(LogLevel.Error) && console.error(message);
        }
    }
    /**
     * Builds a complete sysex message from several parts, with default caching of buffers. Caching should only be used if the result of this function is used immediately, e.g. being sent in a command and not used afterwards.
     * @param data
     * @param prependCommand
     * @param appendCRC
     * @param useCachedBuffer
     * @returns
     */
    getCommandBufferFromData(data, prependCommand = null, appendCRC = null, useCachedBuffer = true) {
        let prependCommandLength = (prependCommand !== null) ? prependCommand.length : 0;
        let appendCRCLength = (appendCRC !== null) ? appendCRC.length : 0;
        let commandLength = 5 + data.length + prependCommandLength + appendCRCLength;
        let commandBuffer;
        if (useCachedBuffer) {
            let cachedCommandBuffer = this._commandBuffers.get(commandLength);
            if (cachedCommandBuffer === undefined) {
                cachedCommandBuffer = createCommandBuffer(commandLength, this._zoomDeviceID);
                this._commandBuffers.set(commandLength, cachedCommandBuffer);
            }
            commandBuffer = cachedCommandBuffer;
        }
        else {
            commandBuffer = createCommandBuffer(commandLength, this._zoomDeviceID);
        }
        if (prependCommand !== null)
            commandBuffer.set(prependCommand, 4);
        commandBuffer.set(data, 4 + prependCommandLength);
        if (appendCRC !== null)
            commandBuffer.set(appendCRC, 4 + prependCommandLength + data.length);
        return commandBuffer;
        function createCommandBuffer(commandLength, deviceID) {
            let commandBuffer = new Uint8Array(commandLength);
            commandBuffer[0] = 0xF0;
            commandBuffer[1] = 0x52;
            commandBuffer[3] = deviceID;
            commandBuffer[commandBuffer.length - 1] = 0xF7;
            return commandBuffer;
        }
    }
    sendCommand(data, prependCommand = null, appendCRC = null) {
        if (!this._midi.isOutputConnected(this._midiDevice.outputID)) {
            shouldLog(LogLevel.Warning) && console.warn(`WARNING: Not sending MIDI message to device ${this._midiDevice.outputID} as the device is not connected"`);
            return;
        }
        let output = this._midi.getOutputInfo(this._midiDevice.outputID);
        if (output.connection != "open") {
            shouldLog(LogLevel.Warning) && console.warn(`WARNING: Not sending MIDI message to device ${output.name} as the port is in state "${output.connection}"`);
            return;
        }
        let commandBuffer = this.getCommandBufferFromData(data, prependCommand, appendCRC);
        try {
            this._midi.send(this._midiDevice.outputID, commandBuffer);
        }
        catch (err) {
            let message = getExceptionErrorString(err, `for device ${output.name}`);
            shouldLog(LogLevel.Error) && console.error(message);
        }
    }
    async sendCommandAndGetReply(data, verifyReply, prependCommand = null, appendCRC = null, timeoutMilliseconds = this._timeoutMilliseconds) {
        if (!this._midi.isOutputConnected(this._midiDevice.outputID)) {
            shouldLog(LogLevel.Warning) && console.warn(`WARNING: Not sending MIDI message to device ${this._midiDevice.outputID} as the device is not connected"`);
            return;
        }
        let output = this._midi.getOutputInfo(this._midiDevice.outputID);
        if (output.connection != "open") {
            shouldLog(LogLevel.Warning) && console.warn(`WARNING: Not sending MIDI message to device ${output.name} as the port is in state "${output.connection}"`);
            return;
        }
        let commandBuffer = this.getCommandBufferFromData(data, prependCommand, appendCRC);
        try {
            return await this._midi.sendAndGetReply(this._midiDevice.outputID, commandBuffer, this._midiDevice.inputID, verifyReply, timeoutMilliseconds);
        }
        catch (err) {
            let message = getExceptionErrorString(err, `for device ${output.name}`);
            shouldLog(LogLevel.Error) && console.error(message);
            return undefined;
        }
    }
    zoomCommandMatch(data, command) {
        return data.length >= 4 + command.length && data[0] == 0xF0 && data[data.length - 1] == 0xF7 && data[1] == 0x52 && data[2] == 0 && data[3] == this._zoomDeviceID &&
            data.slice(4, 4 + command.length).every((element, index) => element === command[index]);
    }
    /**
     * Updates internal state to match the new bank and program.
     * This method will not send any MIDI to the pedal, just use the internal patch list and screen mapping to update the state.
     * This method will not emit events for changed state properties.
     * @param bank
     * @param program
     * @param forceUpdate
     * @returns true if the bank or program was different from the previous bank or program
     */
    syncStateWithNewBankAndProgram(bank, program, forceUpdate = false) {
        if (this._patchList.length === 0)
            return false; // we don't have the patch list, so there's nothing to sync with
        let memorySlot = program;
        if (this._patchesPerBank !== -1 && bank != -1)
            memorySlot += bank * this._patchesPerBank;
        if (memorySlot >= this._patchList.length) {
            shouldLog(LogLevel.Error) && console.error(`Unable to sync state for bank ${bank} and program ${program} with memory slot number ${memorySlot} as it is out of bounds - this._patchList.length = ${this._patchList.length}`);
            return false;
        }
        let changed = forceUpdate || this._currentBank !== bank || this._currentProgram !== program;
        if (changed) {
            this._previousBank = this._currentBank;
            this._previousProgram = this._currentProgram;
            this._currentBank = bank;
            this._currentProgram = program;
            this._currentPatchData = undefined;
            this._currentPatch = this._patchList[memorySlot].clone();
            if (this.freezeCurrentPatch)
                Object.freeze(this._currentPatch);
            this._currentEffectSlot = this._currentPatch.currentEffectSlot;
            this._currentTempo = this._currentPatch.tempo;
            let screens = undefined;
            if (this.effectIDMap !== undefined)
                screens = this._currentScreenCollection = ZoomScreenCollection.fromPatchAndMappings(this._currentPatch, this.effectIDMap);
            if (screens !== undefined) {
                this._currentScreenCollection = screens;
                this._currentScreenCollectionData = undefined;
            }
        }
        return changed;
    }
    allEffectsAreMapped(patch) {
        if (this.effectIDMap === undefined || patch.effectSettings === null)
            return false;
        for (let i = 0; i < patch.effectSettings.length; i++) {
            if (!this.effectIDMap.has(patch.effectSettings[i].id)) {
                // There's at least one effect in the currentPatch that is not in the effectIDMap
                return false;
            }
        }
        return true;
    }
    connectMessageHandler() {
        this._midi.addListener(this._midiDevice.inputID, this._midiMessageHandler);
    }
    disconnectMessageHandler() {
        this._midi.removeListener(this._midiDevice.inputID, this._midiMessageHandler);
    }
    handleMIDIDataFromZoom(data, timeStamp) {
        if (this._disableMidiHandlers) {
            shouldLog(LogLevel.Midi) && console.log(`${performance.now().toFixed(1)} Rcvd: ${bytesToHexString(data, " ")}`);
            return;
        }
        this.internalMIDIDataHandler(data);
        for (let listener of this._listeners)
            listener(this, data, timeStamp);
        let [messageType, channel, data1, data2] = getChannelMessage(data);
        if (this._autoRequestProgramChangeMuteLog && messageType === MessageType.PC)
            this._autoRequestProgramChangeMuteLog = false; // Bank and program change message muted, don't skip logging anymore  
    }
    internalMIDIDataHandler(data) {
        let [messageType, channel, data1, data2] = getChannelMessage(data);
        // Skip log for auto requests of program change, to make the log less chatty
        const messageIsPCOrBankChange = messageType === MessageType.PC || (messageType === MessageType.CC && (data1 === 0x00 || data1 == 0x20));
        const tempSkipLog = this._autoRequestProgramChangeMuteLog && messageIsPCOrBankChange;
        let log = !this.logMutedTemporarilyForPollMessages(data);
        if (this._patchListDownloadInProgress) {
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received: ${bytesToHexString(data, " ")}`);
            return; // mute all message handling while the patch list is being downloaded
        }
        if (messageType === MessageType.CC && data1 === 0x00) {
            // Bank MSB
            if (this._currentBank === -1)
                this._currentBank = 0;
            this._previousBank = this._currentBank;
            this._currentBank = (this._currentBank & 0b0000000001111111) | (data2 << 7);
            this._bankMessagesReceived = true;
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received Bank MSB ${data2}, currentBank: ${this._currentBank}, raw: ${bytesToHexString(data, " ")}`);
        }
        else if (messageType === MessageType.CC && data1 === 0x20) {
            // Bank LSB
            if (this._currentBank === -1)
                this._currentBank = 0;
            this._previousBank = this._currentBank;
            this._currentBank = (this._currentBank & 0b0011111110000000) | data2;
            this._bankMessagesReceived = true;
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received Bank LSB ${data2}, currentBank: ${this._currentBank}, raw: ${bytesToHexString(data, " ")}`);
        }
        else if (messageType === MessageType.PC) {
            // Program change
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received Program Change ${data1}, raw: ${bytesToHexString(data, " ")}`);
            if (!this._usesBankBeforeProgramChange || (this._usesBankBeforeProgramChange && this._bankMessagesReceived)) {
                this._bankMessagesReceived = false;
                let program = data1;
                let changed = this.syncStateWithNewBankAndProgram(this._currentBank, program);
                // Note: On MS Plus series, we will probably have received a message with bank and program change earlier on, bankAndProgramNumberV2
                // Screen is not updated yet on the pedal then, but hopefully it'll be updated now.
                if (changed && this._autoUpdateScreens)
                    this.updateScreens();
                if (changed)
                    this.emitMemorySlotChangedEvent();
            }
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.parameterValueAcceptedV2)) {
            let effectSlot = data[7];
            let parameterNumber = data[8];
            let parameterValue = data[9] + (data[10] << 7);
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received parameter update accepted for effect slot ${effectSlot}, ` +
                    `parameter number ${parameterNumber} (0x${parameterNumber.toString(16).padStart(2, "0")}), ` +
                    `value ${parameterValue} (0x${parameterValue.toString(16).padStart(2, "0")}), raw: ${bytesToHexString(data, " ")}`);
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.nameCharacterV2)) {
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received name character index ${data[8]}, character: ${data[9]}, raw: ${bytesToHexString(data, " ")}`);
            // Name was edited on device (MS Plus series)
            // We need to get the current patch to get the name
            // We'll get a lot of these messages just for one changed character, so we'll throttle the request for current patch
            // FIXME: Consider just emitting a name changed event for this particular case, after receiving the throttled new current patch
            this._throttler.doItLater(() => {
                if (this._autoRequestCurrentPatch)
                    this.requestCurrentPatch();
            }, this._throttleTimeoutMilliseconds);
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.tempoV2)) {
            // Tempo changed on device (MS Plus series)
            let oldTempo = this._currentTempo;
            this._currentTempo = data[9] + ((data[10] & 0b01111111) << 7);
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received tempo ${this._currentTempo}, raw: ${bytesToHexString(data, " ")}`);
            if (oldTempo !== this._currentTempo)
                this.emitTempoChangedEvent();
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.currentEffectSlotV2)) {
            // Current (edit) effect slot was changed on pedal (MS Plus)
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received current effect slot change ${data[9]} raw: ${bytesToHexString(data, " ")}`);
            let newEffectSLot = data[9];
            if (this._currentEffectSlot !== newEffectSLot) {
                this._currentEffectSlot = newEffectSLot;
                if (this.currentPatch !== undefined) {
                    let patch = this.freezeCurrentPatch ? this.currentPatch.clone() : this.currentPatch;
                    patch.currentEffectSlot = this._currentEffectSlot;
                    if (this.freezeCurrentPatch) {
                        this._currentPatch = patch;
                        this._currentEffectSlot = this._currentPatch.currentEffectSlot;
                        Object.freeze(this._currentPatch);
                    }
                }
                this.emitEffectSlotChangedEvent();
                if (this._autoUpdateScreens)
                    this.updateScreens();
            }
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.parameterValueV2) || this.isMessageType(data, ZoomDevice.messageTypes.parameterValueV1)) {
            // Parameter was edited on device (MS Plus or MSOG series)
            [this._currentEffectSlot, this._currentEffectParameterNumber, this._currentEffectParameterValue] = this.getEffectEditParameters(data);
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received parameter edit slot ${this._currentEffectSlot}, ` +
                    `parameter ${this._currentEffectParameterNumber}, value ${this._currentEffectParameterValue}, raw: ${bytesToHexString(data, " ")}`);
            if (this._currentEffectParameterNumber === 0) {
                // effect slot on/off
                if (this.currentPatch !== undefined && this.currentPatch.effectSettings !== null &&
                    this._currentEffectSlot < this.currentPatch.effectSettings.length) {
                    this.currentPatch.effectSettings[this._currentEffectSlot].enabled = this._currentEffectParameterValue === 1;
                }
                else {
                    shouldLog(LogLevel.Warning) && console.warn(`Received invalid effect edit parameters. this._currentEffectSlot: ${this._currentEffectSlot}, this._currentEffectParameterNumber: ${this._currentEffectParameterNumber}`);
                    shouldLog(LogLevel.Warning) && console.warn(`curentPatch: ${this.currentPatch}, effectSettings: ${this.currentPatch?.effectSettings}, ` +
                        `this.currentPatch.effectSettings.length: ${this.currentPatch?.effectSettings?.length}`);
                }
            }
            else if (this._currentEffectParameterNumber === 1) {
                // This hasn't been observed before, so we should investigate why it happened
                shouldLog(LogLevel.Warning) && console.warn(`Received effect edit parameter number 1. this._currentEffectSlot: ${this._currentEffectSlot}. Investigate.`);
            }
            else {
                let parameterIndex = this._currentEffectParameterNumber - 2;
                if (this.currentPatch !== undefined && this.currentPatch.effectSettings !== null &&
                    this._currentEffectSlot < this.currentPatch.effectSettings.length && parameterIndex < this.currentPatch.effectSettings[this._currentEffectSlot].parameters.length) {
                    this.currentPatch.effectSettings[this._currentEffectSlot].parameters[parameterIndex] = this._currentEffectParameterValue;
                }
                else {
                    shouldLog(LogLevel.Warning) && console.warn(`Received invalid effect edit parameters. this._currentEffectSlot: ${this._currentEffectSlot}, this._currentEffectParameterNumber: ${this._currentEffectParameterNumber}`);
                    shouldLog(LogLevel.Warning) && console.warn(`curentPatch: ${this.currentPatch}, effectSettings: ${this.currentPatch?.effectSettings}, ` +
                        `this.currentPatch.effectSettings.length: ${this.currentPatch?.effectSettings?.length}, ` +
                        `this.currentPatch.effectSettings[${parameterIndex}].parameters.length: ${this.currentPatch?.effectSettings?.[parameterIndex]?.parameters?.length}`);
                }
            }
            if (this._autoUpdateScreens) {
                let updatedSingleParameterValue = false;
                if (this.currentScreenCollection !== undefined && this.effectIDMap !== undefined && this.currentPatch !== undefined) {
                    updatedSingleParameterValue = this.currentScreenCollection.setEffectParameterValue(this.currentPatch, this.effectIDMap, this._currentEffectSlot, this._currentEffectParameterNumber, this._currentEffectParameterValue);
                }
                if (updatedSingleParameterValue)
                    this.emitScreenChangedEvent();
                else
                    this.updateScreens(); // update everything as a last resort
            }
            this.emitEffectParameterChangedEvent();
            // Check if the effect slot is different from patch.currentEffectSlot. 
            // Only relevant for MSOG pedals, as the MS+ pedals will send an effect slot changed MIDI message.
            if (this.currentPatch !== undefined && this._currentEffectSlot !== this.currentPatch.currentEffectSlot) {
                let patch = this.freezeCurrentPatch ? this.currentPatch.clone() : this.currentPatch;
                patch.currentEffectSlot = this._currentEffectSlot;
                if (this.freezeCurrentPatch) {
                    this._currentPatch = patch;
                    this._currentEffectSlot = this._currentPatch.currentEffectSlot;
                    Object.freeze(this._currentPatch);
                }
                this.emitEffectSlotChangedEvent();
            }
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.patchDumpForCurrentPatchV1) || this.isMessageType(data, ZoomDevice.messageTypes.patchDumpForCurrentPatchV2)) {
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received patch dump for current patch, raw: ${bytesToHexString(data, " ")}`);
            this._currentPatch = undefined;
            this._currentPatchData = data;
            let numEffectsMismatch = false;
            let countNumEffects = 0;
            if (!this._msogPatchNumEffectsMismatchFixRequest && this.isMessageType(data, ZoomDevice.messageTypes.patchDumpForCurrentPatchV1) && this.currentPatch !== undefined)
                [numEffectsMismatch, countNumEffects] = this.currentPatch.msNumEffectsMismatch();
            if (numEffectsMismatch) {
                shouldLog(LogLevel.Warning) && console.warn(`Effect count mismatch in patch "${this.currentPatch?.name}": msogNumEffects (${this.currentPatch?.numEffects}) != number of IDs that are not zero (${countNumEffects}). Requesting patch again.`);
                this._msogPatchNumEffectsMismatchFixRequest = true;
                // This is probably a bug in the MSOG pedals.
                // It takes a short time for the pedal to update the patch with the correct
                // msogPatchNumEffects, so we'll wait a bit before sending the request for the patch.
                this._throttler.doItLater(() => {
                    this.requestCurrentPatch();
                }, this._msogPatchNumEffectsMismatchFixRequestThrottleTimeoutMilliseconds);
            }
            else {
                this._msogPatchNumEffectsMismatchFixRequest = false;
                if (this._autoUpdateScreens)
                    this.updateScreens();
                this.emitCurrentPatchChangedEvent();
            }
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.storeCurrentPatchToMemorySlotV1)) {
            // Current (edit) patch stored to memory slot on device (MS series)
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received confirmation that current edit patch was stored to patch number ${data[7]} was stored, raw: ${bytesToHexString(data, " ")}`);
            let memorySlot = data[8];
            if (this._autoRequestCurrentPatch) {
                if (this._autoRequestPatchForMemorySlotInProgress)
                    shouldLog(LogLevel.Warning) && console.warn(`Auto-requesting patch from memory slot ${memorySlot} while auto request already in progress for another memory slot ${this._autoRequestPatchMemorySlotNumber}`);
                if (memorySlot !== this.currentMemorySlotNumber)
                    shouldLog(LogLevel.Warning) && console.warn(`Got a message about current patch being stored to memory slot ${memorySlot}, but that is not the current memory slot number ${this.currentMemorySlotNumber}`);
                this._autoRequestPatchForMemorySlotInProgress = true;
                this._autoRequestPatchMemorySlotNumber = memorySlot;
                this.requestPatchFromMemorySlot(memorySlot);
            }
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.patchDumpForMemoryLocationV1)) {
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received patch dump for patch number ${data[7]}, raw: ${bytesToHexString(data, " ")}`);
            let autoRequestInProgress = this._autoRequestPatchForMemorySlotInProgress;
            this._autoRequestPatchForMemorySlotInProgress = false;
            let autoRequestPatchMemorySlotNumber = this._autoRequestPatchMemorySlotNumber;
            this._autoRequestPatchMemorySlotNumber = -1;
            let memorySlot = data[7];
            this._rawPatchList[memorySlot] = data;
            this.emitPatchChangedEvent(memorySlot);
            if (autoRequestInProgress) {
                if (memorySlot !== autoRequestPatchMemorySlotNumber)
                    shouldLog(LogLevel.Warning) && console.warn(`Auto-requested patch dump for memory slot ${autoRequestPatchMemorySlotNumber} but received patch dump for memory slot ${memorySlot} instead`);
                this.emitMemorySlotChangedEvent();
            }
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.patchDumpForMemoryLocationV2)) {
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received patch dump for bank number ${data[7] + (data[8] << 7)} ` +
                    `program number ${data[9] + (data[10] << 7)}, raw: ${bytesToHexString(data, " ")}`);
            let bank = data[7] + ((data[8] & 0b0111111) >> 7);
            let program = data[9] + ((data[10] & 0b0111111) >> 7);
            if (this._patchesPerBank !== -1)
                program += bank * this._patchesPerBank;
            let memorySlot = program;
            this._rawPatchList[memorySlot] = data;
            this.emitPatchChangedEvent(memorySlot);
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.screensForCurrentPatch)) {
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received screens for current patch, raw: ${bytesToHexString(data, " ")}`);
            let useIncomingScreens = this.currentPatch === undefined || !this.allEffectsAreMapped(this.currentPatch);
            shouldLog(LogLevel.Info) && console.log(`useIncomingScreens: ${useIncomingScreens}`);
            if (useIncomingScreens) {
                // we only use the incoming screen message if we don't have an effectIDMap
                this._currentScreenCollectionData = data;
                this._currentScreenCollection = undefined;
                // if (this.currentPatch !== undefined && this.effectIDMap !== undefined) {
                //   // Some debug logging
                //   let incomingScreens = this.currentScreenCollection;
                //   let generatedScreens = ZoomScreenCollection.fromPatchAndMappings(this.currentPatch, this.effectIDMap);
                //   if (incomingScreens !== undefined && generatedScreens !== undefined && incomingScreens.equals(generatedScreens, true))
                //     shouldLog(LogLevel.Info) && console.log(`Incoming (MIDI) screen and generated screen are equal`);
                //   else
                //     shouldLog(LogLevel.Warning) && console.warn(`Warning: Incoming (MIDI) screen and generated screen are different`);
                // }
                this.emitScreenChangedEvent();
            }
        }
        else if (this.isMessageType(data, ZoomDevice.messageTypes.bankAndProgramNumberV2)) {
            let bank = data[8] + (data[9] << 7);
            let program = data[10] + (data[11] << 7);
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received bank and program number, bank number ${bank} ` +
                    `program number ${program}, raw: ${bytesToHexString(data, " ")}`);
            let changed = this.syncStateWithNewBankAndProgram(bank, program);
            if (changed)
                this.emitMemorySlotChangedEvent();
        }
        else {
            if (log)
                shouldLog(LogLevel.Info) && console.log(`${performance.now().toFixed(1)} Received unknown message raw: ${bytesToHexString(data, " ")}`);
        }
    }
    async updateScreens(sync = false) {
        if (this.currentPatch === undefined) {
            shouldLog(LogLevel.Warning) && console.warn(`Can't update screens for device ${this.deviceName} because currentPatch is undefined`);
            return undefined;
        }
        let screens = undefined;
        if (this.effectIDMap !== undefined)
            screens = ZoomScreenCollection.fromPatchAndMappings(this.currentPatch, this.effectIDMap);
        if (screens !== undefined) {
            if (this._currentScreenCollection === undefined || !this._currentScreenCollection.equals(screens)) {
                this._currentScreenCollection = screens;
                this._currentScreenCollectionData = undefined;
                this.emitScreenChangedEvent();
            }
            return this._currentScreenCollection;
        }
        else if (this._supportedCommands.get(ZoomDevice.messageTypes.requestScreensForCurrentPatch.str) === SupportType.Supported) {
            if (sync)
                return await this.downloadScreens();
            else
                this.requestScreens();
        }
        return undefined;
    }
    async probeCommand(command, parameters, expectedReply, probeTimeoutMilliseconds, retryWithEditMode = false) {
        let reply;
        if (parameters.length > 0)
            parameters = " " + parameters;
        reply = await this.sendCommandAndGetReply(hexStringToUint8Array(command + parameters), (received) => partialArrayMatch(received, hexStringToUint8Array(`F0 52 00 ${this._zoomDeviceIdString} ${expectedReply}`)), null, null, probeTimeoutMilliseconds);
        if (reply === undefined && retryWithEditMode) {
            // FIXME: Untested code
            shouldLog(LogLevel.Info) && console.log(`Probing for command "${command}" didn't succeed. Retrying with parameter edit enabled.`);
            this.parameterEditEnable();
            reply = await this.sendCommandAndGetReply(hexStringToUint8Array(command + parameters), (received) => partialArrayMatch(received, hexStringToUint8Array(`F0 52 00 ${this._zoomDeviceIdString} ${expectedReply}`)), null, null, probeTimeoutMilliseconds);
            if (reply === undefined) {
                shouldLog(LogLevel.Info) && console.log(`Probing for command "${command}" failed again.`);
            }
            else {
                shouldLog(LogLevel.Info) && console.log(`Probing for command "${command}" succeeded with parameter edit enabled.`);
            }
            this.parameterEditDisable();
        }
        this._supportedCommands.set(command, reply !== undefined ? SupportType.Supported : SupportType.Unknown);
        return reply;
    }
    async probeDevice() {
        this._disableMidiHandlers = true;
        let probeTimeoutMilliseconds = 300;
        let command;
        let expectedReply;
        let reply;
        shouldLog(LogLevel.Info) && console.log(`Probing started for device ${this.deviceName}`);
        // Some of the probes will fail if parameter edit is not enabled
        this.parameterEditEnable();
        command = ZoomDevice.messageTypes.sayHi.str;
        expectedReply = ZoomDevice.messageTypes.success.str;
        reply = await this.probeCommand(command, "", expectedReply, probeTimeoutMilliseconds);
        // This one fails sometimes on MS-50G, so we will try again further down
        command = ZoomDevice.messageTypes.requestCurrentPatchV1.str;
        expectedReply = ZoomDevice.messageTypes.patchDumpForCurrentPatchV1.str;
        reply = await this.probeCommand(command, "", expectedReply, probeTimeoutMilliseconds);
        if (reply !== undefined) {
            this._currentPatch = undefined;
            this._currentPatchData = reply;
        }
        command = ZoomDevice.messageTypes.requestCurrentPatchV2.str;
        expectedReply = ZoomDevice.messageTypes.patchDumpForCurrentPatchV2.str;
        reply = await this.probeCommand(command, "", expectedReply, probeTimeoutMilliseconds);
        if (reply !== undefined) {
            this._currentPatch = undefined;
            this._currentPatchData = reply;
        }
        command = ZoomDevice.messageTypes.requestBankAndPatchInfoV1.str;
        expectedReply = ZoomDevice.messageTypes.bankAndPatchInfoV1.str;
        reply = await this.probeCommand(command, "", expectedReply, probeTimeoutMilliseconds);
        if (reply !== undefined && reply.length == 10) {
            this._numPatches = reply[5] + (reply[6] << 7);
            this._patchLength = reply[7] + (reply[8] << 7);
        }
        command = ZoomDevice.messageTypes.requestBankAndPatchInfoV2.str;
        expectedReply = ZoomDevice.messageTypes.bankAndPatchInfoV2.str;
        reply = await this.probeCommand(command, "", expectedReply, probeTimeoutMilliseconds);
        if (reply !== undefined && reply.length > 13) {
            this._numPatches = reply[5] + (reply[6] << 7);
            this._patchLength = reply[7] + (reply[8] << 7);
            let unknown = reply[9] + (reply[10] << 7);
            this._patchesPerBank = reply[11] + (reply[12] << 7);
        }
        command = ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV1.str;
        expectedReply = ZoomDevice.messageTypes.patchDumpForMemoryLocationV1.str + " 00"; // program 0
        reply = await this.probeCommand(command, "00", expectedReply, probeTimeoutMilliseconds);
        if (reply !== undefined) {
            let numberOfCRCBytes = 5;
            let offset = 10;
            let zeroPaddingAtEndOfPatch = 1;
            let [numberOf8BitBytes, remainder] = getNumberOfEightBitBytes(reply.length - offset - zeroPaddingAtEndOfPatch - numberOfCRCBytes);
            if (numberOf8BitBytes == this._patchLength) // lengths match if we account for CRC bytes
                this._patchDumpForMemoryLocationV1CRCBytes = 5;
            if (partialArrayStringMatch(reply, "PTCF", offset)) {
                this._ptcfPatchFormatSupported = true;
                let eightBitData = seven2eight(reply, offset, reply.length - 2 - this._patchDumpForMemoryLocationV1CRCBytes);
                if (eightBitData != undefined) {
                    let patch = ZoomPatch.fromPatchData(eightBitData);
                    if (patch.nameLength !== null)
                        this._ptcfNameLength = patch.nameLength;
                }
            }
        }
        command = ZoomDevice.messageTypes.requestPatchDumpForMemoryLocationV2.str;
        expectedReply = ZoomDevice.messageTypes.patchDumpForMemoryLocationV2.str + " 00 00 00 00"; // bank 0, program 0
        reply = await this.probeCommand(command, "00 00 00 00", expectedReply, probeTimeoutMilliseconds);
        if (reply !== undefined) {
            let offset = 13 + 1;
            // the 8-bit data starts at offset 13, but reply is 7-bit data and we haven't bothered to convert to 8 bit
            // so the byte at data[13] is the high-bit-byte in the 7-bit data, and the ascii identifier starts at data[13+1] = data[14]
            if (partialArrayStringMatch(reply, "PTCF", offset)) {
                this._ptcfPatchFormatSupported = true;
                let offset = 13;
                let eightBitData = seven2eight(reply, offset, reply.length - 2);
                if (eightBitData != undefined) {
                    let patch = ZoomPatch.fromPatchData(eightBitData);
                    if (patch.nameLength !== null)
                        this._ptcfNameLength = patch.nameLength;
                }
            }
        }
        command = ZoomDevice.messageTypes.requestCurrentBankAndProgramV1.str;
        let [bank, program] = await this.getCurrentBankAndProgram(true, probeTimeoutMilliseconds);
        this._supportedCommands.set(command, program !== undefined ? SupportType.Supported : SupportType.Unknown);
        this._usesBankBeforeProgramChange = bank !== undefined;
        // Send program change and see if we get a reply
        bank = bank ?? 0;
        if (program !== undefined) {
            let newBank = 0;
            let newProgram = 0;
            this._midi.sendCC(this._midiDevice.outputID, 0, 0x00, 0x00); // bank MSB = 0
            this._midi.sendCC(this._midiDevice.outputID, 0, 0x20, bank & 0x7F); // bank LSB = 0
            let pcMessage = new Uint8Array(2);
            pcMessage[0] = 0xC0;
            pcMessage[1] = program & 0b01111111;
            // Note: This will change what is displayed on the pedal to the specified bank, however the pedal's internal currentPatch won't change.
            // This is possibly a bug in the pedal (noticed this on MS-70CDR+, 2025-10-01).
            // To fix this, we write back the current patch at the end of the probing
            reply = await this._midi.sendAndGetReply(this._midiDevice.outputID, pcMessage, this._midiDevice.inputID, (data) => {
                // expected reply is 2 optional bank messages (B0 00 00, B0 20 NN) and then one program change message (C0 NN)
                let [messageType, channel, data1, data2] = getChannelMessage(data);
                if (messageType === MessageType.CC && data1 === 0x00) {
                    if (newBank === -1)
                        newBank = 0;
                    newBank = newBank | (data2 << 7);
                    return false;
                }
                else if (messageType === MessageType.CC && data1 === 0x20) {
                    if (newBank === -1)
                        newBank = 0;
                    newBank = newBank | data2;
                    return false;
                }
                else if (messageType === MessageType.PC) {
                    newProgram = data1;
                    return true;
                }
                else
                    return false;
            }, probeTimeoutMilliseconds);
            if (reply !== undefined) {
                if (bank === newBank && program === newProgram) {
                    this._bankAndProgramSentOnUpdate = true;
                }
                else {
                    shouldLog(LogLevel.Warning) && console.warn(`Set bank and program to (${bank}, ${program}) but got back (${newBank}, ${newProgram})`);
                    this._bankAndProgramSentOnUpdate = false;
                }
            }
            else {
                this._bankAndProgramSentOnUpdate = false;
            }
            // Restore currentPatch, since that was messed up when we sent the program change above.
            // See comment above, after the program change message.
            // The sleep is necessary (I think) to let the pedal catch up after the probing.
            // If the sleep is ommited, the pedal will sometims show a "Missing Effect Not Found" error message.
            await sleepForAWhile(300);
            if (this.currentPatch !== undefined)
                this.uploadPatchToCurrentPatch(this.currentPatch);
            else
                shouldLog(LogLevel.Warning) && console.warn(`Current patch is undefined after probing for bank and program`);
        }
        // reply = await this.sendCommandAndGetReply(hexStringToUint8Array(command), (received) => 
        //   partialArrayMatch(received, hexStringToUint8Array(`C0`)), null, null, probeTimeoutMilliseconds); 
        // // expected reply is 2 optional bank messages (B0 00 00, B0 20 NN) and then one program change message (C0 NN)
        // this._supportedCommands.set(command, reply !== undefined ? SupportType.Supported : SupportType.Unknown);
        command = ZoomDevice.messageTypes.requestScreensForCurrentPatch.str;
        expectedReply = ZoomDevice.messageTypes.screensForCurrentPatch.str;
        reply = await this.probeCommand(command, "", expectedReply, probeTimeoutMilliseconds);
        // Abandoned attempt at probing for setting parameter values
        // if (this._supportedCommands.get(ZoomDevice.messageTypes.requestCurrentPatchV2.str) == SupportType.Supported && currentPatchV2 !== undefined) {
        //   // get patch
        //   let patch = await this.downloadCurrentPatch();
        //   if (patch !== undefined) {
        //     let effectSlot = 0;
        //     patch.effectSettings[]
        //   }
        //   // try changing the first parameter and see if we get a confirmation message
        // }
        // We assume that if we can get current patch using v1 command, then we can also set parameters using v1 command
        let parameterValueV1Supported = this._supportedCommands.get(ZoomDevice.messageTypes.requestCurrentPatchV1.str) == SupportType.Supported ? SupportType.Supported : SupportType.Unknown;
        this._supportedCommands.set(ZoomDevice.messageTypes.parameterValueV1.str, parameterValueV1Supported);
        // We assume that if we can get current patch using v2 command, then we can also set parameters using v2 command
        let parameterValueV2Supported = this._supportedCommands.get(ZoomDevice.messageTypes.requestCurrentPatchV2.str) == SupportType.Supported ? SupportType.Supported : SupportType.Unknown;
        this._supportedCommands.set(ZoomDevice.messageTypes.parameterValueV2.str, parameterValueV2Supported);
        this._isMSOG = [0x58, 0x5F, 0x61].includes(this._zoomDeviceID);
        this._numParametersPerPage = this._isMSOG ? 3 : 4;
        this._maxNumEffects = 6; // FIXME: Support MS-60B and other pedals with different number of max effects
        if (shouldLog(LogLevel.Info)) {
            let sortedMap = new Map([...this._supportedCommands.entries()].sort((a, b) => a[0].replaceAll(" ", "").padEnd(2, "00") > b[0].replaceAll(" ", "").padEnd(2, "00") ? 1 : -1));
            console.log("Probing summery:");
            for (let [command, supportType] of sortedMap) {
                console.log(`  ${command.padEnd(8)} -> ${supportType == SupportType.Supported ? "  Supported" : "Unsupported"}`);
            }
            console.log(`  Number of patches:       ${this._numPatches}`);
            console.log(`  Patch length:            ${this._patchLength}`);
            console.log(`  Patches per bank:        ${this._patchesPerBank == -1 ? "Unknown" : this._patchesPerBank}`);
            console.log(`  CRC bytes v1 mem patch:  ${this._patchDumpForMemoryLocationV1CRCBytes}`);
            console.log(`  PTCF format support:     ${this._ptcfPatchFormatSupported}`);
            console.log(`  PTCF name length:        ${this._ptcfNameLength}`);
            console.log(`  Bank + prog change sent on update: ${this._bankAndProgramSentOnUpdate}`);
            console.log(`  Num parameters per page: ${this._numParametersPerPage}`);
            console.log(`  Is MSOG device:          ${this._isMSOG}`);
        }
        this.parameterEditDisable();
        shouldLog(LogLevel.Info) && console.log(`Probing ended for device ${this.deviceName}`);
        this._disableMidiHandlers = false;
    }
    get effectIDMap() {
        let map = ZoomDevice._effectIDMaps.get(this.deviceInfo.deviceName);
        if (map === undefined) {
            shouldLog(LogLevel.Error) && console.error(`No effect ID map found for device ${this.deviceInfo.deviceName}`);
            return undefined;
        }
        return map;
    }
    getRawParameterValueFromString(effectID, parameterNumber, valueString) {
        return ZoomDevice.getRawParameterValueFromStringAndMap(this.effectIDMap, effectID, parameterNumber, valueString);
    }
    /**
     * Returns the raw value (zero-based) and maximum value (zero-based) for a given effect ID, parameter number, and value string.
     *
     * @param {number} effectID - The ID of the effect.
     * @param {number} parameterNumber - The number of the parameter.
     * @param {string} valueString - The value string to search for.
     * @return {[number, number]} An array containing the raw value and maximum value. Returns [0, -1] if a mapping for valueString is not found.
     */
    static getRawParameterValueFromStringAndMap(effectIDMap, effectID, parameterNumber, valueString) {
        if (effectIDMap === undefined)
            return [0, -1];
        if (parameterNumber === 0) {
            // return [valueString === "OFF" ? 0 : 1, 1];
            return [valueString === "0" ? 0 : 1, 1];
        }
        let effectMapping = effectIDMap.get(effectID);
        let parameterIndex = parameterNumber - 2;
        if (effectMapping !== undefined) {
            if (parameterIndex < effectMapping.parameters.length) {
                let parameterMapping = effectMapping.parameters[parameterIndex];
                valueString = ZoomPatch.noteUTF16ToHtml(valueString);
                valueString = valueString.replaceAll(" ", "").toUpperCase();
                //let rawValue = parameterMapping.values.findIndex(str => str.replaceAll(" ", "").toUpperCase() === valueString);
                let rawValue = parameterMapping.valuesUCNSP?.get(valueString);
                if (rawValue !== undefined && rawValue >= 0)
                    return [rawValue, parameterMapping.max];
            }
        }
        shouldLog(LogLevel.Info) && console.log(`No mapping for effect ${effectID.toString(16).padStart(8, "0")}, parameter ${parameterNumber}, value ${valueString}`);
        return [0, -1];
    }
    getStringFromRawParameterValue(effectID, parameterNumber, rawValue) {
        return ZoomDevice.getStringFromRawParameterValueAndMap(this.effectIDMap, effectID, parameterNumber, rawValue);
    }
    static getStringFromRawParameterValueAndMap(effectIDMap, effectID, parameterNumber, rawValue) {
        if (effectIDMap === undefined)
            return "";
        if (parameterNumber === 0) {
            // return rawValue === 0 ? "OFF" : "ON";
            return rawValue === 0 ? "0" : "1";
        }
        let effectMapping = effectIDMap.get(effectID);
        let parameterIndex = parameterNumber - 2;
        if (effectMapping !== undefined) {
            if (parameterIndex < effectMapping.parameters.length) {
                let parameterMapping = effectMapping.parameters[parameterIndex];
                if (rawValue < parameterMapping.values.length)
                    return parameterMapping.values[rawValue];
            }
        }
        return "";
    }
    static getEffectIDMapForDevice(deviceName) {
        return ZoomDevice._effectIDMaps.get(deviceName);
    }
    static setEffectDefaultsForPatch(patch, effectIDMap, slotNumber, parameterIndex) {
        if (patch.effectSettings === null) {
            shouldLog(LogLevel.Error) && console.error(`patch.effectSettings == null for patch ${patch.name}`);
            return;
        }
        let slotStart = slotNumber ?? 0;
        let slotEnd = slotNumber === undefined ? patch.effectSettings.length : slotNumber + 1;
        for (let slot = slotStart; slot < slotEnd; slot++) {
            ZoomDevice.setDefaultsForEffect(patch.effectSettings[slot], effectIDMap, parameterIndex);
        }
    }
    static setDefaultsForEffect(effectSettings, effectIDMap, parameterIndex) {
        let effectMapping = effectIDMap.get(effectSettings.id);
        if (effectMapping === undefined) {
            shouldLog(LogLevel.Warning) && console.warn(`No mapping found for effect ID ${effectSettings.id.toString(16).padStart(8, "0")}`);
            return;
        }
        if (parameterIndex !== undefined && parameterIndex >= effectMapping.parameters.length) {
            shouldLog(LogLevel.Error) && console.error(`parameterIndex (${parameterIndex}) >= number of parameters in map for effect ID ${effectSettings.id.toString(16).padStart(8, "0")}`);
            return;
        }
        let parameterStart = parameterIndex ?? 0;
        let parameterEnd = parameterIndex === undefined ? effectMapping.parameters.length : parameterIndex + 1;
        effectSettings.parameters.fill(0);
        // parameters.length is typically max available for that pedal, e.g. 9 for MSOG and 12 for MS+, default to 0 for all parameters, including if we don't have defaults for that effect
        for (let parameter = parameterStart; parameter < parameterEnd; parameter++) {
            let parameterMapping = effectMapping.parameters[parameter];
            if (parameterMapping === undefined) {
                shouldLog(LogLevel.Warning) && console.warn(`No mapping found for effect ID ${effectSettings.id.toString(16).padStart(8, "0")} parameter ${parameter}`);
                continue;
            }
            if (parameterMapping.default === undefined) {
                shouldLog(LogLevel.Warning) && console.warn(`No default value found for effect ID ${effectSettings.id.toString(16).padStart(8, "0")} parameter ${parameter}`);
                continue;
            }
            let parameterValue = parameterMapping.default;
            effectSettings.parameters[parameter] = parameterValue;
        }
    }
    static getEffectNameAndNumParameters(effectIDMap, effectID) {
        if (effectIDMap === undefined)
            return [undefined, undefined];
        let effectMapping = effectIDMap.get(effectID);
        if (effectMapping !== undefined) {
            return [effectMapping.name, effectMapping.parameters.length];
        }
        return [undefined, undefined];
    }
    static getParameterNameAndMaxValue(effectIDMap, effectID, parameterNumber) {
        if (effectIDMap === undefined)
            return [undefined, undefined, undefined];
        if (parameterNumber === 0)
            return ["ON/OFF", 1, undefined];
        let effectMapping = effectIDMap.get(effectID);
        if (effectMapping === undefined)
            return [undefined, undefined, undefined];
        let parameterIndex = parameterNumber - 2;
        if (parameterIndex >= effectMapping.parameters.length)
            return [undefined, undefined, undefined];
        let parameterMapping = effectMapping.parameters[parameterIndex];
        return [parameterMapping.name, parameterMapping.max, parameterMapping.maxNumerical];
    }
    static getCategoryNameFromID(effectID, pedalName) {
        let category = (effectID & 0xFF000000) >> 24;
        if (pedalName === "MS-50G+" || pedalName === "MS-70CDR+" || pedalName === "MS-50G" || pedalName === "MS-60B" || pedalName === "MS-70CDR") {
            switch (category) {
                case 0x00: return "Thru";
                case 0x01: return "Dynamics";
                case 0x02: return "Filter";
                case 0x03: return "Drive";
                case 0x04: return "Preamp";
                case 0x05: return "Amp";
                case 0x06: return "Modulation";
                case 0x07: return "SFX";
                case 0x08: return "Delay";
                case 0x09: return "Reverb";
                case 0x0C: return "Drive"; // the category name for the corresponding MS-60B effect in the MS-60B+ effect list doc
                case 0x0D: return "Preamp"; // the category name for the corresponding MS-60B effect in the MS-60B+ effect list doc
            }
        }
        else if (pedalName === "MS-60B+" || pedalName === "B2 FOUR") {
            switch (category) {
                case 0x00: return "Thru";
                case 0x01: return "Dynamics";
                case 0x02: return "Filter";
                case 0x03: return "Drive";
                case 0x04: return "Preamp";
                case 0x05: return "Bass amp";
                case 0x06: return "Modulation";
                case 0x07: return "Pitch shift";
                case 0x08: return "Synth";
                case 0x09: return "SFX";
                case 0x0A: return "Delay";
                case 0x0B: return "Reverb";
                case 0x0C: return "Pedal"; // only B" FOUR
                case 0x1C: return "BPM"; // only B2 FOUR, BPM
            }
        }
        else if (pedalName === "G2/G2X FOUR") {
            switch (category) {
                case 0x00: return "Thru";
                case 0x01: return "Dynamics";
                case 0x02: return "Filter";
                case 0x03: return "Drive";
                case 0x04: return "Amp";
                case 0x06: return "Modulation";
                case 0x07: return "SFX";
                case 0x08: return "Delay";
                case 0x09: return "Reverb";
                case 0x0B: return "Pedal";
            }
        }
        else if (pedalName === "MS-200D+") {
            switch (category) {
                case 0x00: return "Thru";
                case 0x01: return "Booster";
                case 0x02: return "Overdrive";
                case 0x03: return "Distortion";
                case 0x04: return "Fuzz";
                case 0x05: return "Preamp";
                case 0x06: return "Tool";
                case 0x07: return "BPM";
            }
        }
        return category.toString(16);
    }
    static getColorFromEffectID(effectID, pedalName) {
        let effectGroup = (effectID >> 24) & 0xFF;
        if (pedalName === "MS-50G+" || pedalName === "MS-70CDR+" || pedalName === "MS-50G" || pedalName === "MS-60B" || pedalName === "MS-70CDR") {
            switch (effectGroup) {
                case 0x01: return "#C8B4D7"; // purple
                case 0x02: return "#FFE2BF"; // orange
                case 0x03: return "#F7BFB9"; // red
                case 0x04: return "#F7BFB9"; // red
                case 0x05: return "#F7BFB9"; // red
                case 0x06: return "#ADF2F4"; // turquoise
                case 0x07: return "#E8E69E"; // yellow
                case 0x08: return "#A5BBE1"; // blue
                case 0x09: return "#ABD3A3"; // green
                case 0x08: return "#E8E69E"; // yellow
                case 0x09: return "#E8E69E"; // yellow
                case 0x0C: return "#F7BFB9"; // red
                case 0x0D: return "#F7BFB9"; // red
            }
        }
        else if (pedalName === "MS-60B+" || pedalName === "B2 FOUR") {
            switch (effectGroup) {
                case 0x01: return "#C8B4D7"; // purple
                case 0x02: return "#FFE2BF"; // orange
                case 0x03: return "#F7BFB9"; // red
                case 0x04: return "#F7BFB9"; // red
                case 0x05: return "#F7BFB9"; // red
                case 0x06: return "#ADF2F4"; // turquoise
                case 0x07: return "#ADF2F4"; // turquoise
                case 0x08: return "#A5BBE1"; // blue
                case 0x09: return "#E8E69E"; // yellow
                case 0x0A: return "#A5BBE1"; // blue
                case 0x0B: return "#ABD3A3"; // green
                case 0x0C: return "#ADF2F4"; // turqoise - only B2 FOUR, Pedal
                case 0x1C: return "#E8E69E"; // yellow - only B2 FOUR, BPM
            }
        }
        else if (pedalName === "G2/G2X FOUR") {
            switch (effectGroup) {
                case 0x01: return "#C8B4D7"; // purple
                case 0x02: return "#FFE2BF"; // orange
                case 0x03: return "#F7BFB9"; // red
                case 0x04: return "#F7BFB9"; // red
                case 0x06: return "#ADF2F4"; // turquoise
                case 0x07: return "#E8E69E"; // yellow
                case 0x08: return "#A5BBE1"; // blue
                case 0x09: return "#ABD3A3"; // green
                case 0x0B: return "#ADF2F4"; // turqoise
            }
        }
        else if (pedalName === "MS-200D+") {
            switch (effectGroup) {
                case 0x01: return "#A5BBE1"; // blue
                case 0x02: return "#E8E69E"; // yellow
                case 0x03: return "#FFE2BF"; // orange
                case 0x04: return "#F7BFB9"; // red
                case 0x05: return "#ADF2F4"; // turquoise
                case 0x06: return "#C8B4D7"; // purple
                case 0x07: return "#ABD3A3"; // green
            }
        }
        return "#FFFFFF"; // white (for unknown and THRU/Empty/Blank);
    }
    static getColorFromPedalName(pedalName) {
        switch (pedalName) {
            case "MS-50G+": return "#EAEAEC";
            case "MS-60B+": return "#C91F3E";
            case "MS-70CDR+": return "#00ABE8";
            case "MS-200D+": return "#E7CA00";
            case "MS-50G": return "#BCC0C9";
            case "MS-60B": return "#752832";
            case "MS-70CDR": return "#8FA9C0";
            default: return "#FFFFFF";
        }
    }
    cancelMapping() {
        this._cancelMapping = true;
    }
    async mapParameters(effectList, effectListName, progressCallback) {
        this._disableMidiHandlers = true;
        this._isMappingParameters = true;
        // if (this.currentPatch === undefined || this.currentPatch.effectSettings === null) {
        //   shouldLog(LogLevel.Error) && console.error("Cannot map parameters when currentPatch == undefined or currentPatch.effectSettings == null");
        //   this._disableMidiHandlers = false;
        //   this._isMappingParameters = false
        //   return undefined;
        // }
        // let patch = this.currentPatch.clone();
        let patch = ZoomPatch.createEmptyPTCFPatch(this._ptcfNameLength);
        this.uploadPatchToCurrentPatch(patch, false);
        if (patch.effectSettings === null) {
            shouldLog(LogLevel.Error) && console.error("patch.effectSettings === null. This is a bug.");
            this._disableMidiHandlers = false;
            this._isMappingParameters = false;
            return undefined;
        }
        if (patch.effectSettings.length < 1) {
            shouldLog(LogLevel.Error) && console.error("patch.effectSettings.length < 1. Aborting mapping.");
            this._disableMidiHandlers = false;
            this._isMappingParameters = false;
            return undefined;
        }
        shouldLog(LogLevel.Info) && console.log(`*** Mapping started at ${performance.now().toFixed(1)}, using current patch ${patch.name} ***`);
        let startTime = performance.now();
        let logLevel = getLogLevel();
        // if (logLevel & LogLevel.Midi)
        //   setLogLevel(logLevel & ~LogLevel.Midi);
        let mappings = {};
        let paramBuffer = new Uint8Array(7);
        let command = new Uint8Array(ZoomDevice.messageTypes.parameterValueV2.bytes.length + paramBuffer.length);
        command.set(ZoomDevice.messageTypes.parameterValueV2.bytes);
        let maxParamValue = 1 << 13;
        let effectSlot = 0;
        let error = false;
        let counter = 1;
        let numEffects = effectList.size;
        for (let id of effectList.keys()) {
            // if (id !== 0x07000ff0) {
            //   counter++;
            //   continue;
            // }
            // if (counter < 104) {
            //    counter++;
            //    continue;
            // }
            //   if (counter > 22 && counter < 33) {
            //     counter++;
            //     continue;
            //  }
            // if (counter > 1)
            //   break;
            if (this._cancelMapping)
                break;
            patch.effectSettings[0].id = id;
            //this.uploadPatchToCurrentPatch(patch, false);
            // let effectSettings: EffectSettings = patch.effectSettings[0];
            shouldLog(LogLevel.Info) && console.log(`Starting mapping for effect ${counter.toString().padStart(3, "0")} / ${numEffects} "${effectList.get(id)}" (0x${id.toString(16).toUpperCase().padStart(8, "0")})`);
            let id7 = `${(id & 0x7f).toString(16).padStart(2, "0")}${((id >> 7) & 0x7f).toString(16).padStart(2, "0")}` +
                `${((id >> 14) & 0x7f).toString(16).padStart(2, "0")}${((id >> 21) & 0x7f).toString(16).padStart(2, "0")}${((id >> 28) & 0x0f).toString(16).padStart(2, "0")}`;
            let id7c = new Uint8Array(ZoomDevice.messageTypes.parameterValueV2.bytes.length + 7);
            id7c.set(ZoomDevice.messageTypes.parameterValueV2.bytes);
            id7c.set(hexStringToUint8Array("0001" + id7), ZoomDevice.messageTypes.parameterValueV2.bytes.length);
            let reply = await this.sendCommandAndGetReply(id7c, received => true);
            if (reply === undefined)
                shouldLog(LogLevel.Warning) && console.warn(`Unable to change effect for effect ${effectList.get(id)} (0x${id.toString(16).toUpperCase().padStart(8, "0")})`);
            let downloadedPatch = await this.downloadCurrentPatch();
            if (downloadedPatch === undefined || downloadedPatch.effectSettings === null || downloadedPatch.effectSettings.length < 1) {
                shouldLog(LogLevel.Warning) && console.warn(`Unable to get parameters for effect ${effectList.get(id)} (0x${id.toString(16).toUpperCase().padStart(8, "0")})`);
                counter++;
                continue;
            }
            let effectSettings = downloadedPatch.effectSettings[0];
            // let verifyPatch = await this.downloadCurrentPatch();
            // if (verifyPatch === undefined || verifyPatch.effectSettings === null || verifyPatch.effectSettings.length < 1) {
            //   shouldLog(LogLevel.Error) && console.error(`Failed to download and verify current patch for effect ${counter.toString().padStart(3, "0")}, ID ${id.toString(16).toUpperCase().padStart(8, "0")}`);
            //   shouldLog(LogLevel.Error) && console.error(`verifyPatch: ${verifyPatch}, effectSettings: ${verifyPatch?.effectSettings}, effectSettings.length: ${verifyPatch?.effectSettings?.length}`);
            //   return undefined;
            // }
            // let verifyID = verifyPatch.effectSettings[0].id;
            // if (verifyID !== id) {
            //   shouldLog(LogLevel.Warning) && console.warn(`Unable to set current patch to effect ${counter.toString().padStart(3, "0")}, ID ${id.toString(16).toUpperCase().padStart(8, "0")}`);
            //   shouldLog(LogLevel.Warning) && console.warn(`patch.effectSettings[0].id: ${verifyID}, expected id: ${id}`);
            //   counter++;
            //   continue;
            // }
            let screenCollection = await this.downloadScreens(effectSlot, effectSlot);
            if (screenCollection === undefined) {
                shouldLog(LogLevel.Error) && console.error("*** Failed to download screens while verifying patch, aborting mapping ***");
                setLogLevel(logLevel); // enable MIDI logging again
                this._disableMidiHandlers = false;
                this._isMappingParameters = false;
                return undefined;
            }
            if (screenCollection.screens.length < 1) {
                shouldLog(LogLevel.Warning) && console.warn(`*** screenCollection.screens.length ${screenCollection.screens.length} is out of range while verifying patch, skipping mapping for effect ***`);
                counter++;
                continue;
                // setLogLevel(logLevel); // enable MIDI logging again
                // this._disableMidiHandlers = false;
                // this._isMappingParameters = false;
                // return undefined;
            }
            let screen = screenCollection.screens[0].parameters;
            if (screen[1].name.toUpperCase() !== effectList.get(id)?.toUpperCase()) {
                shouldLog(LogLevel.Warning) && console.warn(`*** screen[1].name "${screen[1].name}" does not match ${effectListName}.get(id) "${effectList.get(id)}" while verifying patch, not skipping effect ***`);
                shouldLog(LogLevel.Warning) && console.warn(`Screen: ${JSON.stringify(screen)}`);
                // Note: In some cases this is just a slight mismatch between the effect name and the screen name, e.g. "Orange Limi" vs "Orange Lim"
                // But it could also mean that the effect was completely missing from the pedal, which should be investigated.
                // This means that the resulting mapping file should be exained to see if the differences between name and screenName are significant.
                //       counter++;
                //       continue;
            }
            if (progressCallback) {
                progressCallback(`${effectList.get(id)}`, counter, numEffects);
            }
            let mappingsForEffect = {
                name: effectList.get(id),
                screenName: screen[1].name,
                parameters: new Array()
            };
            for (let paramNumber = 2; paramNumber - 2 < effectSettings.parameters.length; paramNumber++) {
                shouldLog(LogLevel.Info) && console.log(`Mapping parameters for effect ${effectList.get(id)} (0x${id.toString(16).toUpperCase().padStart(8, "0")}), paramNumber ${(paramNumber).toString().padStart(2, " ")} of ${effectSettings.parameters.length + 2 - 1}`);
                // paramNumber = paramIndex + 2;
                let mappingsForParameterValue;
                [mappingsForParameterValue, error] = await mapParameter(this, effectSlot, paramNumber);
                if (error) {
                    shouldLog(LogLevel.Error) && console.error(`Error mapping parameter ${paramNumber} for effect ${effectList.get(id)} (0x${id.toString(16).toUpperCase().padStart(8, "0")})`);
                    break;
                }
                if (mappingsForParameterValue === undefined) {
                    shouldLog(LogLevel.Info) && console.log(`Got no reply for parameter ${paramNumber}. Number of parameters for effect ${effectList.get(id)} (0x${id.toString(16).toUpperCase().padStart(8, "0")}) is ${mappingsForEffect.parameters.length}`);
                    break;
                }
                let paramIndex = paramNumber - 2;
                mappingsForParameterValue.default = effectSettings.parameters[paramIndex];
                mappingsForEffect.parameters.push(mappingsForParameterValue);
                if (this._cancelMapping)
                    break;
            }
            if (error) {
                break;
            }
            shouldLog(LogLevel.Info) && console.log(`Mapping done for effect ${counter.toString().padStart(3, "0")} "${effectList.get(id)}" (0x${id.toString(16).toUpperCase().padStart(8, "0")}), mapped ${mappingsForEffect.parameters.length} of ${effectSettings.parameters.length - 1} parameters`);
            mappings[id.toString(16).padStart(8, "0")] = mappingsForEffect;
            counter++;
            await sleepForAWhile(200); // let the chrome console catch up ???
        }
        let timeSpent = performance.now() - startTime;
        let minutes = Math.floor(timeSpent / (1000 * 60));
        let seconds = Math.floor((timeSpent % (1000 * 60)) / 1000);
        if (error)
            shouldLog(LogLevel.Error) && console.error(`*** Mapping ended with errors after ${timeSpent / 1000} seconds ******`);
        else if (this._cancelMapping) {
            this._cancelMapping = false;
            shouldLog(LogLevel.Info) && console.log(`*** Mapping cancelled at ${performance.now().toFixed(1)} after ${minutes} minutes ${seconds} seconds ***`);
        }
        else {
            shouldLog(LogLevel.Info) && console.log(`*** Mapping successful at ${performance.now().toFixed(1)} after ${minutes} minutes ${seconds} seconds ***`);
        }
        //shouldLog(LogLevel.Info) && console.log(JSON.stringify(mappings, null, 2));
        //this.uploadCurrentPatch(originalCurrentPatch);
        this._disableMidiHandlers = false;
        this._isMappingParameters = false;
        setLogLevel(logLevel); // enable MIDI logging again
        return mappings;
        async function mapParameter(device, effectSlot, paramNumber) {
            let mappingsForParameterValue = undefined;
            let error = false;
            let log = false;
            // If the param value on the pedal is already 0, we won't get a reply when we start probing (at value 0).
            // So before we start probing, we set param value to 1, that way we should always get a reply for value 0,
            // if the paramNumber is valid.
            setParamBuffer(paramBuffer, effectSlot, paramNumber, 1);
            command.set(paramBuffer, ZoomDevice.messageTypes.parameterValueV2.bytes.length);
            let reply = await device.sendCommandAndGetReply(command, received => true);
            let hiddenParamCount = 1;
            let paramValue;
            for (paramValue = 0; paramValue < maxParamValue; paramValue++) {
                setParamBuffer(paramBuffer, effectSlot, paramNumber, paramValue);
                command.set(paramBuffer, ZoomDevice.messageTypes.parameterValueV2.bytes.length);
                if (log)
                    shouldLog(LogLevel.Info) && console.log(`Sending effect slot: ${effectSlot}, param number: ${paramNumber}, param value: ${paramValue}`);
                let reply = await device.sendCommandAndGetReply(command, received => {
                    let commandMatch = device.zoomCommandMatch(received, ZoomDevice.messageTypes.parameterValueAcceptedV2.bytes);
                    if (!commandMatch) {
                        shouldLog(LogLevel.Info) && console.log(`Sent     effect slot: ${effectSlot}, param number: ${paramNumber}, param value: ${paramValue}`);
                        shouldLog(LogLevel.Warning) && console.warn("Received an unexpeced reply. Investigate.");
                        return false;
                    }
                    let offset = 4 + ZoomDevice.messageTypes.parameterValueAcceptedV2.bytes.length;
                    let receivedEffectSlot = received[offset + 0] & 0b01111111;
                    let receivedParamNumber = received[offset + 1] & 0b01111111;
                    let receivedParamValue = (received[offset + 2] & 0b01111111) + ((received[offset + 3] & 0b01111111) << 7);
                    if (receivedEffectSlot !== effectSlot || receivedParamNumber !== paramNumber || receivedParamValue !== paramValue) {
                        if (log)
                            shouldLog(LogLevel.Info) && console.log(`Sent     effect slot: ${effectSlot}, param number: ${paramNumber}, param value: ${paramValue}`);
                        if (log)
                            shouldLog(LogLevel.Info) && console.log(`Received effect slot: ${receivedEffectSlot}, param number: ${receivedParamNumber}, param value: ${receivedParamValue}`);
                        if (log)
                            shouldLog(LogLevel.Info) && console.log(`Reply mismatch: ${receivedEffectSlot}, ${receivedParamNumber}, ${receivedParamValue} != ${effectSlot}, ${paramNumber}, ${paramValue}`);
                        if (log)
                            shouldLog(LogLevel.Info) && console.log("Reply mismatch usually means that the parameter number is out of range (no more parameters)");
                        return false;
                    }
                    return true;
                });
                if (reply === undefined) {
                    if (log)
                        shouldLog(LogLevel.Info) && console.log(`Sent     effect slot: ${effectSlot}, param number: ${paramNumber}, param value: ${paramValue}`);
                    if (log)
                        shouldLog(LogLevel.Info) && console.log("Timeout... Which usually means that the parameter value is out of range (no more values)");
                    if (log)
                        shouldLog(LogLevel.Info) && console.log(`Max param value for parameter ${paramNumber} is ${paramValue - 1}`);
                    if (paramValue === 0)
                        mappingsForParameterValue = undefined;
                    break;
                }
                else {
                    // request screens
                    let screenCollection = await device.downloadScreens(effectSlot, effectSlot);
                    if (screenCollection === undefined) {
                        shouldLog(LogLevel.Error) && console.error("*** Failed to download screens, aborting mapping ***");
                        error = true;
                        mappingsForParameterValue = undefined;
                        break;
                    }
                    if (screenCollection.screens.length != 1) {
                        shouldLog(LogLevel.Error) && console.error(`*** screenCollection.screens.length ${screenCollection.screens.length} is out of range, aborting mapping ***`);
                        error = true;
                        mappingsForParameterValue = undefined;
                        break;
                    }
                    let screen = screenCollection.screens[0];
                    if (paramNumber >= screen.parameters.length) {
                        shouldLog(LogLevel.Warning) && console.warn(`Warning: paramNumber (${paramNumber}) >= screen.parameters.length (${screen.parameters.length}), using (patch) paramValue as textValue. Investigate.`);
                        shouldLog(LogLevel.Warning) && console.warn(`           Unknown = ${paramValue} -> "${paramValue.toString()}"`);
                        if (mappingsForParameterValue === undefined)
                            mappingsForParameterValue = { name: `Hidden-${hiddenParamCount++}`, values: new Array(), max: 0, valuesUCNSP: null };
                        mappingsForParameterValue.values.push(paramValue.toString());
                        continue;
                    }
                    let parameter = screen.parameters[paramNumber];
                    // Map Zoom's byte codes to HTML/unicode characters. This is also done in htmltools.ts
                    // let valueString = parameter.valueString.replace(/\x16/g, "&#119138;").replace(/\x17/g, "&#119137;").replace(/\x18/g, "&#119136;").replace(/\x19/g, "&#119135;").replace(/\x1A/g, "&#119134;");
                    let valueString = ZoomPatch.noteByteCodeToHtml(parameter.valueString);
                    if (log)
                        shouldLog(LogLevel.Info) && console.log(`           ${parameter.name} = ${paramValue} -> "${valueString}"`);
                    if (mappingsForParameterValue === undefined)
                        mappingsForParameterValue = { name: parameter.name, values: new Array(), max: 0, valuesUCNSP: null };
                    mappingsForParameterValue.values.push(valueString);
                    if (log)
                        shouldLog(LogLevel.Info) && console.log(`  Control: ${mappingsForParameterValue.name} = ${paramValue} -> "${mappingsForParameterValue.values[paramValue]}"`);
                }
            }
            if (mappingsForParameterValue !== undefined)
                mappingsForParameterValue.max = paramValue - 1;
            return [mappingsForParameterValue, error];
        }
        function setParamBuffer(paramBuffer, effectSlot, paramNumber, paramValue) {
            paramBuffer[0] = effectSlot & 0b01111111;
            paramBuffer[1] = paramNumber & 0b01111111;
            paramBuffer[2] = paramValue & 0b01111111;
            paramBuffer[3] = (paramValue >> 7) & 0b01111111;
            paramBuffer[4] = 0;
            paramBuffer[5] = 0;
            paramBuffer[6] = 0;
        }
    }
}
var SupportType;
(function (SupportType) {
    SupportType[SupportType["Unsupported"] = 0] = "Unsupported";
    SupportType[SupportType["Supported"] = 1] = "Supported";
    SupportType[SupportType["Unknown"] = 2] = "Unknown";
})(SupportType || (SupportType = {}));
//# sourceMappingURL=ZoomDevice.js.map
import { shouldLog, LogLevel } from "./Logger.js";
import { MIDIProxy, ALL_MIDI_DEVICES } from "./midiproxy.js";
import { getChannelMessage } from "./miditools.js";
import { MIDI_RECEIVE, MIDI_RECEIVE_TO_SEND, MIDI_SEND, MIDI_TIMESTAMP_TO_RECEIVE, perfmon } from "./PerformanceMonitor.js";
import { bytesToHexString, getFunctionName } from "./tools.js";
export class MIDIProxyForWebMIDIAPI extends MIDIProxy {
    midi;
    navigator;
    midiMessageListenerMap = new Map();
    connectionStateChangeListeners = new Array();
    inputPortsConnectionState = new Map;
    outputPortsConnectionState = new Map;
    constructor() {
        super();
        this.navigator = navigator;
        this.midi = undefined;
        this.midiMessageListenerMap.set(ALL_MIDI_DEVICES, new Array());
    }
    async enable() {
        try {
            this.midi = await this.navigator.requestMIDIAccess({ sysex: true });
            this.enabled = true;
            this.midi.onstatechange = (ev) => {
                let event = ev;
                // shouldLog(LogLevel.Info) && console.log(`*** ${event.port?.type} ${event.port?.state} ${event.port?.name} ${event.port?.connection}`);
                if (event.port === null)
                    return;
                // Skip state change events from already connected ports - ignoring open and close port state change events
                let skipStateChange = false;
                skipStateChange = event.port.state === "connected" && (event.port.type === "input" && this.inputPortsConnectionState.has(event.port.id) ||
                    event.port.type === "output" && this.outputPortsConnectionState.has(event.port.id));
                if (!skipStateChange)
                    this.onStateChange(event);
                // else
                //   shouldLog(LogLevel.Info) && console.log(`*** Not emitting state change for ${event.port?.type} ${event.port?.state} ${event.port?.name} ${event.port?.connection}`);
                if (event.port.state === "disconnected")
                    if (event.port.type === "input")
                        this.inputPortsConnectionState.delete(event.port.id);
                    else
                        this.outputPortsConnectionState.delete(event.port.id);
                else if (event.port.type === "input")
                    this.inputPortsConnectionState.set(event.port.id, event.port.connection);
                else
                    this.outputPortsConnectionState.set(event.port.id, event.port.connection);
            };
            return true;
        }
        catch (err) {
            shouldLog(LogLevel.Error) && console.error("ERROR: Error while enabling Web MIDI API");
            throw err;
        }
    }
    get inputs() {
        let map = new Map();
        if (this.midi === undefined)
            return map;
        this.midi.inputs.forEach((info, id) => {
            map.set(info.id, {
                id: info.id,
                name: info.name ?? "unknown",
                state: info.state,
                connection: info.connection === "open" ? "open" : info.connection === "closed" ? "closed" : "pending"
            });
        });
        return map;
    }
    get outputs() {
        let map = new Map();
        if (this.midi === undefined)
            return map;
        this.midi.outputs.forEach((info, id) => {
            map.set(info.id, {
                id: info.id,
                name: info.name ?? "unknown",
                state: info.state,
                connection: info.connection === "open" ? "open" : info.connection === "closed" ? "closed" : "pending"
            });
        });
        return map;
    }
    async openInput(id) {
        if (this.midi === undefined) {
            console.trace();
            throw `Attempting to open MIDI input without first enabling Web MIDI`;
        }
        let input = this.midi.inputs.get(id);
        if (input === undefined) {
            console.trace();
            throw `No input found with ID "${id}" in ${getFunctionName()}`;
        }
        await input.open();
        if (!this.midiMessageListenerMap.has(id))
            this.midiMessageListenerMap.set(id, new Array());
        input.onmidimessage = (message) => {
            if (input !== undefined) {
                perfmon.exitWithExplicitLastTimeInside(MIDI_TIMESTAMP_TO_RECEIVE, message.timeStamp);
                perfmon.enter(MIDI_RECEIVE);
                perfmon.enter(MIDI_RECEIVE_TO_SEND);
                this.onMIDIMessage(id, input, message);
            }
        };
        return input.id;
    }
    async closeInput(deviceHandle) {
        if (this.midi === undefined)
            throw `Attempting to close MIDI input without first enabling Web MIDI`;
        let input = this.midi.inputs.get(deviceHandle);
        if (input === undefined) {
            shouldLog(LogLevel.Info) && console.log(`No input found with ID "${deviceHandle}", so there's nothing to close. Removing listeners anyway.`);
        }
        else {
            await input.close();
        }
        let listeners = this.midiMessageListenerMap.get(deviceHandle);
        if (listeners === undefined)
            throw `Attemped to remove all listeners for device "${deviceHandle}" with no listener list`;
        // Remove all listeners
        this.midiMessageListenerMap.set(deviceHandle, new Array());
        return deviceHandle;
    }
    async closeAllInputs() {
        if (this.midi === undefined)
            throw `Attempting to close MIDI input without first enabling Web MIDI`;
        for (let [id, input] of this.midi.inputs.entries()) {
            input.close();
        }
    }
    getInputInfo(id) {
        if (this.midi === undefined)
            throw `Attempting to get MIDI input info for device "${id}" without first enabling Web MIDI`;
        let info = this.midi.inputs.get(id);
        if (info === undefined) {
            console.trace();
            throw `No input found with ID "${id}" in ${getFunctionName()}`;
        }
        return {
            id: info.id,
            name: info.name ?? "unknown",
            state: info.state,
            connection: info.connection === "open" ? "open" : info.connection === "closed" ? "closed" : "pending"
        };
    }
    async openOutput(id) {
        if (this.midi === undefined)
            throw `Attempting to open MIDI output without first enabling Web MIDI`;
        let output = this.midi.outputs.get(id);
        if (output === undefined) {
            throw `No output found with ID "${id}"`;
        }
        await output.open();
        return output.id;
    }
    async closeOutput(deviceHandle) {
        if (this.midi === undefined)
            throw `Attempting to close MIDI output without first enabling Web MIDI`;
        let output = this.midi.outputs.get(deviceHandle);
        if (output === undefined) {
            shouldLog(LogLevel.Info) && console.log(`No output found with ID "${deviceHandle}", so there's nothing to close`);
        }
        else {
            await output.close();
        }
        return deviceHandle;
    }
    async closeAllOutputs() {
        if (this.midi === undefined)
            throw `Attempting to close MIDI output without first enabling Web MIDI`;
        for (let [id, output] of this.midi.outputs.entries()) {
            output.close();
        }
    }
    getOutputInfo(id) {
        if (this.midi === undefined)
            throw `Attempting to get MIDI output info for device "${id}" without first enabling Web MIDI`;
        let info = this.midi.outputs.get(id);
        if (info === undefined) {
            throw `No output found with ID "${id}"`;
        }
        return {
            id: info.id,
            name: info.name ?? "unknown",
            state: info.state,
            connection: info.connection === "open" ? "open" : info.connection === "closed" ? "closed" : "pending"
        };
    }
    isOutputConnected(id) {
        if (this.midi === undefined)
            return false;
        let info = this.midi.outputs.get(id);
        if (info === undefined)
            return false;
        if (info.state === "disconnected")
            return false;
        return true;
    }
    isInputConnected(id) {
        if (this.midi === undefined)
            return false;
        let info = this.midi.inputs.get(id);
        if (info === undefined)
            return false;
        if (info.state === "disconnected")
            return false;
        return true;
    }
    send(deviceHandle, data) {
        if (this.midi === undefined)
            throw `Attempting to send MIDI data to output for device "${deviceHandle}" without first enabling Web MIDI`;
        let output = this.midi.outputs.get(deviceHandle);
        if (output === undefined) {
            throw `No output found with ID "${deviceHandle}"`;
        }
        // Note: This conversion might be needed for node.js, but is not needed for the browser based Web MIDI API
        //let dataArray = Array.from(data);
        let dataArray = data;
        shouldLog(LogLevel.Midi) && console.log(`${performance.now().toFixed(1)} Sent: ${bytesToHexString(dataArray, " ")}`);
        perfmon.enter(MIDI_SEND);
        output.send(dataArray);
        perfmon.exit(MIDI_SEND);
        perfmon.exit(MIDI_RECEIVE_TO_SEND);
    }
    addListener(deviceHandle, listener) {
        if (deviceHandle !== ALL_MIDI_DEVICES) {
            if (this.midi === undefined)
                throw `Attempting to add midi event listener for device "${deviceHandle}" without first enabling Web MIDI`;
            let input = this.midi.inputs.get(deviceHandle);
            if (input === undefined) {
                console.trace();
                throw `No input found with ID "${deviceHandle}" in ${getFunctionName()}`;
            }
        }
        let listeners = this.midiMessageListenerMap.get(deviceHandle);
        if (listeners === undefined)
            throw `Attempted to add listener for device "${deviceHandle}" with no listener list`;
        listeners.push(listener);
    }
    removeListener(deviceHandle, listener) {
        if (deviceHandle !== ALL_MIDI_DEVICES) {
            if (this.midi === undefined)
                throw `Attempting to get midi event listener for device "${deviceHandle}" without first enabling Web MIDI`;
            let input = this.midi.inputs.get(deviceHandle);
            if (input === undefined) {
                shouldLog(LogLevel.Info) && console.log(`No input found with ID "${deviceHandle}". Removing listener anyway.`);
            }
        }
        let listeners = this.midiMessageListenerMap.get(deviceHandle);
        if (listeners === undefined)
            throw `Attemped to remove listener for device "${deviceHandle}" with no listener list`;
        this.midiMessageListenerMap.set(deviceHandle, listeners.filter((l) => l !== listener));
    }
    removeAllListeners(deviceHandle) {
        if (this.midi === undefined)
            throw `Attempting to get midi event listener for device "${deviceHandle}" without first enabling Web MIDI`;
        let input = this.midi.inputs.get(deviceHandle);
        if (input === undefined) {
            console.trace();
            throw `No input found with ID "${deviceHandle}" in ${getFunctionName()}`;
        }
        let listeners = this.midiMessageListenerMap.get(deviceHandle);
        if (listeners === undefined)
            throw `Attemped to remove all listeners for device "${deviceHandle}" with no listener list`;
        this.midiMessageListenerMap.set(deviceHandle, new Array());
    }
    /**
     *
     * @param listener function to get called every time a device is connected or disconnected.
     * Opening and closing a device does not result in the listener being called.
     */
    addConnectionListener(listener) {
        let existingListener = this.connectionStateChangeListeners.find((l) => l === listener);
        if (existingListener !== undefined) {
            shouldLog(LogLevel.Warning) && console.warn(`Attempting to add a connection listener twice`);
        }
        else {
            this.connectionStateChangeListeners.push(listener);
        }
    }
    removeConnectionListener(listener) {
        let existingListener = this.connectionStateChangeListeners.find((l) => l === listener);
        if (existingListener === undefined) {
            shouldLog(LogLevel.Warning) && console.warn(`Attempting to remove a connection listener that hasn't been added`);
        }
        else {
            this.connectionStateChangeListeners = this.connectionStateChangeListeners.filter((l) => l === listener);
        }
    }
    onMIDIMessage(deviceHandle, input, message) {
        if (message.data === null) {
            shouldLog(LogLevel.Warning) && console.warn("message.data == null");
            return;
        }
        let mute = false;
        let muteStates = this.getMuteStates(deviceHandle);
        if (muteStates !== undefined) {
            let [messageType, channel, data1, data2] = getChannelMessage(message.data);
            mute = muteStates.get(messageType) ?? false;
            // if (mute) {
            //   console.warn(`Muting message ${messageType} for device ${deviceHandle}`);
            // }
        }
        if (mute) {
            return;
        }
        // shouldLog(LogLevel.Midi) && console.log(`${performance.now().toFixed(4)} ${message.timeStamp.toFixed(4)} Rcvd: ${bytesToHexString(message.data, " ")}`)
        // first, call listeners that listen for all midi devices
        let listeners = this.midiMessageListenerMap.get(ALL_MIDI_DEVICES);
        if (listeners !== undefined) {
            for (let listener of listeners) {
                if (message.data !== null)
                    listener(deviceHandle, message.data, message.timeStamp);
                else
                    shouldLog(LogLevel.Warning) && console.warn("message.data == null");
            }
        }
        // then, call listeners that listen for this specific device
        listeners = this.midiMessageListenerMap.get(deviceHandle);
        if (listeners === undefined)
            throw `Received MIDI message from device "${deviceHandle}" with no listener list`;
        for (let listener of listeners) {
            if (message.data !== null)
                listener(deviceHandle, message.data, message.timeStamp);
            else
                shouldLog(LogLevel.Warning) && console.warn("message.data == null");
        }
    }
    /**
     * Handles MIDI connection state changes by notifying registered listeners.
     * Note that this method might get called rapidly multiple times on connection and disconnection.
     * The number of disconnect events seems to match the prevoius number of connect events (on starting the application).
     * I suspect this is due to a bug in the Web MIDI API implementation in Chrome.
     *
     * @param {MIDIConnectionEvent} event - The MIDI connection event that triggered this state change.
     */
    onStateChange(event) {
        for (let listener of this.connectionStateChangeListeners) {
            if (event.port !== null) {
                let deviceHandle = event.port.id;
                let portType = event.port.type === "input" ? "input" : "output";
                let state = event.port.state == "connected" ? "connected" : "disconnected";
                listener(deviceHandle, portType, state);
            }
            else
                shouldLog(LogLevel.Warning) && console.warn("event.port === null");
        }
    }
}
//# sourceMappingURL=MIDIProxyForWebMIDIAPI.js.map
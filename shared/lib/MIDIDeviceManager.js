import { shouldLog, LogLevel } from "./Logger.js";
import { getMIDIDeviceList } from "./miditools.js";
import { SequentialAsyncRunner } from "./SequentialAsyncRunner.js";
/**
 * Maintains a list of MIDI devices.
 * Factory for each manufacturer device
 * ZoomDevice
 * GenericMIDIDevice - think about how to handle uni-directonal devices...
 */
export class MIDIDeviceManager {
    _midi;
    // private _factories: Map<string, {matchDevice: MatchDeviceFunctionType, createObject: FactoryFuntionType}> = new Map<string, {matchDevice: MatchDeviceFunctionType, createObject: FactoryFuntionType}>();
    _factories = new Array();
    _deviceList = new Map();
    _midiDeviceDescriptorList = [];
    _disconnectListeners = new Array();
    _connectListeners = new Array();
    _openCloseListeners = new Array();
    _sequentialRunner = new SequentialAsyncRunner();
    _concurrentRunsCounter = 0;
    constructor(midi) {
        this._midi = midi;
        this._midi.addConnectionListener((deviceHandle, portType, state) => {
            this.midiConnectionHandler(deviceHandle, portType, state);
        });
    }
    /**
     * Adds a factory function for a specific device type. Factory functions are traversed in the order they are added, so if
     * you want one factory to have precedence over another you need to add it first.
     *
     * @param {FactoryKey} factoryKey - The unique identifier for the device type. For instance "ZoomDevice".
     * @param {MatchDeviceFunctionType} matchDevice - The function to match the device.
     * @param {FactoryFuntionType} createObject - The function to create the device object.
     * @return {void}
     */
    addFactoryFunction(factoryKey, matchDevice, createObject) {
        // this._factories.set(key, {matchDevice: matchDevice, createObject: createObject});
        this._factories.push({ factoryKey: factoryKey, matchDevice: matchDevice, createObject: createObject });
    }
    async updateMIDIDeviceList() {
        return await this._sequentialRunner.run(this.updateMIDIDeviceListSerial.bind(this));
    }
    async updateMIDIDeviceListSerial() {
        this._concurrentRunsCounter++;
        if (this._concurrentRunsCounter > 40) {
            shouldLog(LogLevel.Error) && console.error("Too many concurrent calls to updateMIDIDeviceList() - counter = " + this._concurrentRunsCounter);
            return undefined;
        }
        shouldLog(LogLevel.Info) && console.log(`Starting updateMIDIDeviceList - counter = ${this._concurrentRunsCounter}`);
        let inputs = new Map(this._midi.inputs);
        let outputs = new Map(this._midi.outputs);
        for (let device of this._midiDeviceDescriptorList) {
            inputs.delete(device.inputID);
            outputs.delete(device.outputID);
        }
        if (inputs.size === 0 || outputs.size === 0) {
            this._concurrentRunsCounter--;
            shouldLog(LogLevel.Info) && console.log(`Aborting updateMIDIDeviceList since number of inputs or outputs were 0 - counter = ${this._concurrentRunsCounter}`);
            return undefined;
        }
        // Pair up devices that have not already been paired up
        let newDeviceDescriptors = await getMIDIDeviceList(this._midi, inputs, outputs, 100, true);
        if (newDeviceDescriptors.length === 0) {
            this._concurrentRunsCounter--;
            shouldLog(LogLevel.Info) && console.log(`Aborting updateMIDIDeviceList since no new devices were matched up - counter = ${this._concurrentRunsCounter}`);
            return undefined;
        }
        for (let device of newDeviceDescriptors) {
            if (this._midiDeviceDescriptorList.includes(device)) {
                shouldLog(LogLevel.Error) && console.error(`Device ${device.deviceName} (${device.inputName}, ${device.outputName}) already in list`);
            }
            else {
                // Enforce unique device names by prepending " #<number>
                let devicesWithSameDeviceName = this._midiDeviceDescriptorList.filter((d) => d.deviceName === device.deviceName);
                let numDevicesWithSameDeviceName = devicesWithSameDeviceName.length;
                if (numDevicesWithSameDeviceName > 0) {
                    for (let i = 0; i <= numDevicesWithSameDeviceName; i++) {
                        let append = i === 0 ? "" : ` #${i + 1}`;
                        let suggestedNewName = device.deviceName + append;
                        if (!devicesWithSameDeviceName.find((d) => d.deviceNameUnique === suggestedNewName)) {
                            shouldLog(LogLevel.Info) && console.log(`${devicesWithSameDeviceName.length} devices with same device name ${device.deviceName}. New unique device name is "${suggestedNewName}"`);
                            device.deviceNameUnique = suggestedNewName;
                        }
                    }
                }
                this._midiDeviceDescriptorList.push(device);
            }
        }
        let newDevices = new Map();
        for (let device of newDeviceDescriptors) {
            for (let factory of this._factories) {
                let factoryKey = factory.factoryKey;
                let matchDevice = factory.matchDevice;
                let createObject = factory.createObject;
                if (matchDevice(device)) {
                    let newDevice = createObject(this._midi, device);
                    newDevice.addOpenCloseListener((device, open) => this.emitOpenCloseEvent(device, factoryKey, open));
                    // // Enforce unique device names by prepending " #<number>
                    // let deviceNameBase = device.deviceName.replace(/ #\d+$/, ""); // strip away trailing " #<number>"
                    // let numWithSameDeviceName = this._midiDeviceDescriptorList.filter((d: MIDIDeviceDescription) => {
                    //   return d.deviceName.replace(/ #\d+$/, "") === deviceNameBase}).length;
                    // if (numWithSameDeviceName > 1) {
                    //   let newDeviceNumber = numWithSameDeviceName;
                    //   shouldLog(LogLevel.Error) && console.error(`${numWithSameDeviceName} devices with same device name ${device.deviceName}. Prepending #${newDeviceNumber} to device name.`);
                    //   newDevice.deviceName += ` #${newDeviceNumber}`;
                    // }
                    let existingDevices = this._deviceList.get(factoryKey);
                    if (existingDevices === undefined)
                        this._deviceList.set(factoryKey, [newDevice]);
                    else
                        existingDevices.push(newDevice);
                    let existingNewDevices = newDevices.get(factoryKey);
                    if (existingNewDevices === undefined)
                        newDevices.set(factoryKey, [newDevice]);
                    else
                        existingNewDevices.push(newDevice);
                    break;
                }
            }
        }
        // FIXME: Test that this works in ZoomExplorer, then remove this comment. 2025-01-18.
        for (let [deviceKey, newDevicesForKey] of newDevices) {
            for (let newDevice of newDevicesForKey) {
                this.emitConnectEvent(newDevice, deviceKey);
            }
        }
        // loop through factories and match up devices. 
        // for (let factory of this._factories) {
        //   let factoryKey = factory.factoryKey;
        //   let matchDevice = factory.matchDevice;
        //   let createObject = factory.createObject;
        //   let matchingDeviceDescriptors = newDeviceDescriptors.filter((device) => matchDevice(device));
        //   let matchingDevices: IMIDIDevice[];
        //   if (matchingDeviceDescriptors.length > 0) {
        //     matchingDevices = matchingDeviceDescriptors.map((device) => createObject(this._midi, device));
        //   }
        //   else 
        //     matchingDevices = [];
        //   let existingDevices = this._deviceList.get(factoryKey);
        //   if (existingDevices === undefined)
        //     this._deviceList.set(factoryKey, matchingDevices);
        //   else 
        //     this._deviceList.set(factoryKey, existingDevices.concat(matchingDevices));
        //   newDevices.set(factoryKey, matchingDevices);
        // }
        this._concurrentRunsCounter--;
        shouldLog(LogLevel.Info) && console.log(`Completed updateMIDIDeviceList  - counter = ${this._concurrentRunsCounter}`);
        return newDevices;
    }
    get midiDeviceList() {
        return this._midiDeviceDescriptorList;
    }
    getDevices(factoryKey) {
        let device = this._deviceList.get(factoryKey);
        return device ?? [];
    }
    addDisconnectListener(listener) {
        this._disconnectListeners.push(listener);
    }
    removeDisconnectListener(listener) {
        this._disconnectListeners = this._disconnectListeners.filter((l) => l !== listener);
    }
    removeAllDisconnectListeners() {
        this._disconnectListeners = [];
    }
    emitDisconnectEvent(device, factoryKey) {
        for (let listener of this._disconnectListeners)
            listener(this, device, factoryKey);
    }
    addConnectListener(listener) {
        this._connectListeners.push(listener);
    }
    removeConnectListener(listener) {
        this._connectListeners = this._connectListeners.filter((l) => l !== listener);
    }
    removeAllConnectListeners() {
        this._connectListeners = [];
    }
    emitConnectEvent(device, factoryKey) {
        for (let listener of this._connectListeners)
            listener(this, device, factoryKey);
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
    emitOpenCloseEvent(device, factoryKey, open) {
        this._openCloseListeners.forEach((listener) => listener(this, device, factoryKey, open));
    }
    getDeviceFromHandle(deviceHandle) {
        for (let [factoryKey, deviceList] of this._deviceList) {
            let device = deviceList.find((device) => device.deviceInfo.inputID === deviceHandle || device.deviceInfo.outputID === deviceHandle);
            if (device !== undefined)
                return [device, factoryKey];
        }
        return [undefined, undefined];
    }
    getDeviceFromName(deviceName) {
        for (let [factoryKey, deviceList] of this._deviceList) {
            let device = deviceList.find((device) => device.deviceName === deviceName);
            if (device !== undefined)
                return [device, factoryKey];
        }
        return [undefined, undefined];
    }
    getPortName(deviceHandle, portType) {
        if (!this._midi.isDeviceConnected(deviceHandle, portType)) {
            shouldLog(LogLevel.Info) && console.log(`MIDIDeviceManager.getPortName() called for unconnected device ${deviceHandle}`);
            return "";
        }
        else
            return this._midi.getDeviceInfo(deviceHandle, portType).name;
    }
    getDeviceName(deviceHandle, portType) {
        for (let [factoryKey, deviceList] of this._deviceList) {
            let device = deviceList.find((device) => portType === "input" && device.deviceInfo.inputID === deviceHandle ||
                device.deviceInfo.outputID === deviceHandle);
            if (device !== undefined)
                return device.deviceName;
        }
        return "";
        // let deviceDescriptor = this._midiDeviceDescriptorList.find( (device) => portType === "input" && device.inputID === deviceHandle || 
        //   device.outputID === deviceHandle);
        // return deviceDescriptor === undefined ? "" : deviceDescriptor.deviceName;
    }
    getDeviceDescriptor(deviceHandle, portType) {
        for (let [factoryKey, deviceList] of this._deviceList) {
            let device = deviceList.find((device) => portType === "input" && device.deviceInfo.inputID === deviceHandle ||
                device.deviceInfo.outputID === deviceHandle);
            if (device !== undefined)
                return device.deviceInfo;
        }
        return undefined;
    }
    getDeviceHandleFromDeviceName(deviceName, portType) {
        // FIXME: Consider havind a uniqueDeviceName in the descriptor list
        // But how to assign that?? It should be assigned by the app perhaps, to do fingerprinting, 
        // or by the device factory perhaps. Yes that feels more correct...
        for (let [factoryKey, deviceList] of this._deviceList) {
            let device = deviceList.find((device) => device.deviceName === deviceName);
            if (device !== undefined)
                return portType === "input" ? device.deviceInfo.inputID : device.deviceInfo.outputID;
        }
        return "";
        // let deviceDescriptor = this._midiDeviceDescriptorList.find( (device) => device.deviceName === deviceName);    
        // return deviceDescriptor === undefined ? "" : portType === "input" ? deviceDescriptor.inputID : deviceDescriptor.outputID;
    }
    midiConnectionHandler(deviceHandle, portType, state) {
        let deviceName = this.getPortName(deviceHandle, portType);
        shouldLog(LogLevel.Info) && console.log(`MIDIDeviceManager: MIDI Connection event for device "${deviceName}" (${deviceHandle}), portType: ${portType}, state: ${state}`);
        if (state === "disconnected") {
            let [disconnectedDevice, factoryKey] = this.getDeviceFromHandle(deviceHandle);
            if (disconnectedDevice !== undefined && factoryKey !== undefined) {
                if (disconnectedDevice.isOpen) {
                    shouldLog(LogLevel.Info) && console.log(`Device ${disconnectedDevice.deviceName} disconnected because ${portType} "${deviceName}" (${deviceHandle}) was ${state}`);
                    shouldLog(LogLevel.Info) && console.log(`Closing device ${deviceHandle} and removing from midiDeviceList`);
                    disconnectedDevice.close();
                }
                else {
                    shouldLog(LogLevel.Info) && console.log(`Device ${disconnectedDevice.deviceName} disconnected. Skipping close() as it was already closed`);
                }
                this._midiDeviceDescriptorList = this._midiDeviceDescriptorList.filter((device) => device.inputID !== deviceHandle && device.outputID !== deviceHandle);
                let deviceList = this._deviceList.get(factoryKey);
                if (deviceList !== undefined) {
                    this._deviceList.set(factoryKey, deviceList.filter((device) => device.deviceInfo.inputID !== deviceHandle && device.deviceInfo.outputID !== deviceHandle));
                }
                this.emitDisconnectEvent(disconnectedDevice, factoryKey);
            }
        }
        else if (state === "connected") {
            shouldLog(LogLevel.Info) && console.log(`${portType} device "${deviceName}" (${deviceHandle}) connected`);
            let [existingDevice, deviceKey] = this.getDeviceFromHandle(deviceHandle);
            // let existingDevice: ZoomDevice | undefined = zoomDevices.find( (device) => device.deviceInfo.outputID === deviceHandle);
            if (existingDevice !== undefined) {
                shouldLog(LogLevel.Info) && console.log(`Device "${deviceName}" (${deviceHandle}) is already in the device list for ${deviceKey}. This should only happen on startup.`);
            }
            else {
                shouldLog(LogLevel.Info) && console.log(`Device "${deviceName}" (${deviceHandle}) is not in the device list. Updating MIDI device list`);
                // let newDevices = await this.updateMIDIDeviceList();
                this.updateMIDIDeviceList().then((newDevices) => {
                    // shouldLog(LogLevel.Info) && console.log(`Device "${deviceName}" (${deviceHandle}) done updating MIDI device list`);
                    if (newDevices !== undefined) {
                        if (newDevices.size > 1) {
                            shouldLog(LogLevel.Warning) && console.warn(`Multiple devices of multiple types created when device "${deviceName}" (${deviceHandle}) was connected. This is weird. Investigate.`);
                        }
                        if (newDevices.size > 0) {
                        }
                        // Notifications moved to updateMIDIDEviceList()
                        // for (let [deviceKey, newDevicesForKey] of newDevices) {
                        //   if (newDevicesForKey.length > 1) {
                        //     shouldLog(LogLevel.Warning) && console.warn(`Multiple devices created when device "${deviceName}" (${deviceHandle}) was connected. This is weird. Investigate.`);
                        //   }
                        //   for (let newDevice of newDevicesForKey) {
                        //     this.emitConnectEvent(newDevice, deviceKey!);                          
                        //   }
                        // }
                    }
                });
            }
        }
    }
}
//# sourceMappingURL=MIDIDeviceManager.js.map
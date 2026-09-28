export class MIDIDeviceDescription {
    inputID = "";
    inputName = "";
    outputID = "";
    outputName = "";
    isInput = false;
    isOutput = false;
    manufacturerID = [0];
    manufacturerName = "unknown";
    familyCode = [0, 0];
    modelNumber = [0, 0];
    deviceName = "unknown"; // deduced from manufacturerID, familyCode and modelNumber
    versionNumber = [0, 0, 0, 0];
    identityResponse = new Uint8Array();
    deviceNameUnique = "unknown"; // can be set by the application to any unique device name
    constructor(data) {
        Object.assign(this, data);
    }
}
//# sourceMappingURL=MIDIDeviceDescription.js.map
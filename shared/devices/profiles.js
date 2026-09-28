import { ZoomDevice } from "../lib/ZoomDevice.js";
import { BassPodProDevice } from "./BassPodProDevice.js";

// Model number (from the identity reply) -> effect mapping file. Only the
// two models actually confirmed against real hardware are listed - see
// THIRD_PARTY_NOTICES.md and the zoomplus/ project's README for how these
// were found.
//
// Anchored to this module (shared/devices/) via import.meta.url, NOT to the
// page: fetch() resolves page-relative URLs, and the two shells load from
// different pages (shared/index.html vs web/index.html), so a bare
// "data/..." path 404s in the browser build and every effect falls back to
// generic Effect # / Param # labels. Module-anchored URLs work in both.
//
// MS-70CDR+'s mapping file is already bundled (shared/data/) and its
// effect-icon category table is already built (effect-icons.js) - both
// verified against the real data (150/150 effects categorized cleanly).
// The only missing piece is its model number byte, which can only come
// from running `identify` against real hardware (it's a protocol detail,
// not something in Zoom's published manuals). Once known, add it both
// here and in effect-icons.js's PREFIX_CATEGORY - that's the entire fix.
export const MODEL_TO_MAPPING_FILE = {
    0x23: new URL("../data/zoom-effect-mappings-ms50gp.json", import.meta.url).href,
    0x27: new URL("../data/zoom-effect-mappings-ms60bp.json", import.meta.url).href,
    // 0x??: new URL("../data/zoom-effect-mappings-ms70cdrp.json", import.meta.url).href, // MS-70CDR+ - see above
};

export const ZOOM_MANUFACTURER_ID = 0x52;

// Line 6's three-byte SysEx manufacturer ID (0x00 0x01 0x0C - "Fast Forward",
// now Yamaha). miditools.js already knows this ID, and already parses the
// three-byte-manufacturer identity reply that the POD sends, so nothing in
// shared/lib/ needs changing to find this device.
export const LINE6_MANUFACTURER_ID = [0x00, 0x01, 0x0c];

// Family code -> what we call the device. The Bass POD Pro reports family
// 0x0002 (sent LSB first as 02 00) with member 0x0000.
//
// Only the family is used for matching. The member code is firmware-revision
// dependent and could not be checked against real hardware, and a wrong
// assumption there would mean "no device found" on a working POD - so the
// member is recorded (for logging) but deliberately not enforced. Any Line 6
// device whose family we don't recognise stays unmatched rather than being
// mislabelled as a Bass POD Pro.
const LINE6_FAMILY_TO_LABEL = {
    "2,0": "Line 6 Bass POD Pro",
};

/**
 * True when an identity reply looks like a Bass POD Pro.
 * @param description MIDIDeviceDescription from getMIDIDeviceList()
 */
export function isBassPodProIdentity(description) {
    const manufacturerID = description?.manufacturerID;
    if (!manufacturerID || manufacturerID.length !== 3) return false;
    if (!LINE6_MANUFACTURER_ID.every((byte, i) => manufacturerID[i] === byte)) return false;
    return labelForLine6Family(description.familyCode) !== undefined;
}

function labelForLine6Family(familyCode) {
    if (!familyCode || familyCode.length !== 2) return undefined;
    return LINE6_FAMILY_TO_LABEL[`${familyCode[0]},${familyCode[1]}`];
}

/**
 * Every device this app knows how to talk to.
 *
 * Two shapes of device are described here and they are NOT interchangeable:
 *
 *  - layout "chain" (Zoom MS Plus): a reorderable effect chain, serialised as
 *    a patch blob. Consumes ZoomDevice's patch/effect API (currentPatch,
 *    setEffectParameterForCurrentPatch, downloadCurrentPatch, ...).
 *  - layout "fixed-panel" (Bass POD Pro): a fixed signal path where every
 *    control is its own live MIDI CC. Consumes BassPodProDevice's CC API
 *    (setParameter, addParameterChangedListener, ...).
 *
 * They share only the lifecycle contract below (open/close/isOpen/deviceName/
 * addOpenCloseListener) plus `layout`, which tells app.js which view to build.
 * Forcing one interface over both would mean inventing patch semantics the POD
 * doesn't have (or hiding live CCs the Zoom pedals don't have), so the split
 * is deliberate - each adapter exposes what its hardware actually speaks.
 */
export const PROFILES = [
    {
        id: "zoom-plus",
        label: "Zoom MS Plus",
        layout: "chain",
        match: (description) => description?.manufacturerID?.[0] === ZOOM_MANUFACTURER_ID,
        deviceLabel: (description) => description?.deviceName,
        pickDataFile: (description) => MODEL_TO_MAPPING_FILE[description?.modelNumber?.[0]],
        createDevice: (midi, description) => new ZoomDevice(midi, description),
    },
    {
        id: "bass-pod-pro",
        label: "Line 6 Bass POD Pro",
        layout: "fixed-panel",
        match: isBassPodProIdentity,
        // The POD's own identity reply carries no product name, and
        // shared/lib/miditools.js is vendored code we don't edit, so the
        // friendly name comes from here instead.
        deviceLabel: (description) => labelForLine6Family(description?.familyCode) || "Line 6 Bass POD Pro",
        dataFile: new URL("../data/bass-pod-pro.json", import.meta.url).href,
        createDevice: (midi, description, profileData) => new BassPodProDevice(midi, description, profileData),
    },
];

/**
 * First profile that recognises one of the identified devices.
 * Profiles are ordered by preference, so with both a Zoom pedal and a POD
 * connected the Zoom pedal wins (as it did before the POD was supported).
 * @param descriptions MIDIDeviceDescription[] from getMIDIDeviceList()
 * @returns { profile, description } or undefined
 */
export function findProfileFor(descriptions) {
    const list = Array.isArray(descriptions) ? descriptions : [descriptions];
    for (const profile of PROFILES) {
        const description = list.find((d) => profile.match(d));
        if (description) return { profile, description };
    }
    return undefined;
}

/**
 * Fetches a profile's optional data file (the fixed-panel control map).
 * @returns parsed JSON, or null for profiles that don't use one
 */
export async function loadProfileData(profile) {
    if (!profile?.dataFile) return null;
    const response = await fetch(profile.dataFile);
    if (!response.ok) {
        throw new Error(`Could not load ${profile.dataFile} (HTTP ${response.status})`);
    }
    return await response.json();
}

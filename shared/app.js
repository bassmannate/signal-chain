import { iconSvgFor, categorize } from "./effect-icons.js";
import { getLogText, log, LogLevel, setLogLevel, getLogLevel, clearLogEntries } from "./lib/Logger.js";
import { effectIdMapFromJson } from "./lib/ZoomEffectMaps.js";
import { ZoomDevice as ZoomDeviceClass } from "./lib/ZoomDevice.js";

// Console helper for changing the log level (Option A): open DevTools and run
//   Logger.setLogLevel(Logger.LogLevel.All)
//   Logger.setLogLevel(Logger.LogLevel.Warning | Logger.LogLevel.Error)
// Levels are a bitmask (Off=0, Error=1, Warning=2, Info=4, Debug=8, Midi=16),
// so combined values select multiple severities at once.
if (typeof window !== "undefined") {
  window.Logger = { LogLevel, setLogLevel, getLogLevel, getLogText, clearLogEntries };
}
import { MIDIProxyForWebMIDIAPI } from "./lib/MIDIProxyForWebMIDIAPI.js";
import { getMIDIDeviceList } from "./lib/miditools.js";
import { findProfileFor, loadProfileData } from "./devices/profiles.js";
import {
  PROGRAM_BYTE_COUNT,
  buildEditBufferDump,
  buildProgramDump,
  isDecodableDump,
  parseDumpMessage,
} from "./devices/bassPodProSysex.js";
import {
  buildActionUnit,
  buildKnobUnit,
  buildSelectUnit,
  buildToggleUnit,
  formatByBands,
  setKnobReverseWheel,
  setKnobVisual,
  wireKnobDrag,
} from "./ui/controls.js";
import {
  BACKUP_CANCEL,
  BACKUP_OVERWRITE,
  BACKUP_SKIP,
  DEVICE_KIND_POD,
  DEVICE_KIND_ZOOM,
  LIBRARY_EXTENSION,
  addToStash,
  backupSkipSummary,
  clearLastLibraryForDevice,
  createLibrary,
  deviceKeyForAutoReopen,
  entryFromBytes,
  entryToBytes,
  findBackupCollisions,
  getLastLibraryForDevice,
  hasPendingWork,
  hasStashableBytes,
  labelForDeviceKind,
  loadAutoReopenSetting,
  parseLibrary,
  pendingWorkSummary,
  planBackupWrites,
  saveAutoReopenSetting,
  serializeLibrary,
  setLastLibraryForDevice,
  suggestedLibraryFileName,
} from "./patchLibrary.js";

// Which device we're talking to is decided entirely by devices/profiles.js:
// it knows the identity signatures, which view layout each device wants
// ("chain" for the Zoom pedals, "fixed-panel" for the Bass POD Pro) and how to
// build the right adapter for it. This file only orchestrates the UI.
let profile = null;
let profileData = null;

let midi = null;
let device = null;
let effectMap = {};
let currentModelByte = null;
let selectedSlot = null;
let selectedMemorySlot = null;
const panelControls = new Map(); // ccNumber -> control handle from ui/controls.js
let activeProgramNumber = null; // which POD program (0 = 1A) the panel is showing

// --- Patch librarian ------------------------------------------------------
// A free-length list of patches for ONE device family (never mixed), plus a
// memory-only stash for patches displaced from device slots by library drops.
// The stash is wiped when the library closes; dirty tracks anything needing
// a file Save (added/kept/removed/renamed rows).
const DRAG_DEVICE_PATCH = "application/x-device-patch";
const DRAG_LIBRARY_PATCH = "application/x-library-patch";
let patchLib = null; // { app, libraryVersion, deviceKind, patches: [] } | null
let patchLibFilePath = null; // last opened/saved path (Electron may reuse it)
let patchLibFileName = null; // display name (web has no path)
let patchLibDirty = false;
let patchStash = []; // entries displaced from the device, memory-only

// --- Auto-reopen: last library per pedal ------------------------------------
// One global toggle + one remembered file per physical pedal, persisted in
// window.localStorage (both shells - no config-file plumbing). Only ever
// fires when no library is open: unsaved work always wins over convenience.
function appStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch (e) {
    return null;
  }
}
let libAutoReopen = loadAutoReopenSetting(appStorage());
const KNOB_REVERSE_WHEEL_KEY = "signal-chain.knobReverseWheel";
function loadKnobReverseWheel(storage) {
  try {
    const raw = storage?.getItem?.(KNOB_REVERSE_WHEEL_KEY);
    return raw === "1" || raw === "true";
  } catch (e) {
    return false;
  }
}
function saveKnobReverseWheel(storage, enabled) {
  try {
    storage?.setItem?.(KNOB_REVERSE_WHEEL_KEY, enabled ? "1" : "0");
  } catch (e) {
    // Private-mode / quota failure: the toggle just does not persist.
  }
}
let knobReverseWheelOn = loadKnobReverseWheel(appStorage());
setKnobReverseWheel(knobReverseWheelOn);

// --- Diagnostic log level -------------------------------------------------
// The dropdown offers cumulative presets (each includes everything above it),
// papering over the raw bitmask semantics in Logger.js (Off=0, Error=1,
// Warning=2, Info=4, Debug=8, Midi=16, All=0xFFFFFFFF). Default stays bare
// Warning per the agreed plan. Persisted like the other toggles above.
const LOG_LEVEL_KEY = "signal-chain.logLevel";
const LOG_LEVEL_PRESETS = {
  off: LogLevel.Off,
  error: LogLevel.Error,
  warning: LogLevel.Warning,
  info: LogLevel.Info | LogLevel.Warning | LogLevel.Error,
  debug: LogLevel.Debug | LogLevel.Info | LogLevel.Warning | LogLevel.Error,
  midi: LogLevel.Midi | LogLevel.Debug | LogLevel.Info | LogLevel.Warning | LogLevel.Error,
  all: LogLevel.All,
};
const LOG_LEVEL_NAMES = {
  [LogLevel.Off]: "Off",
  [LogLevel.Error]: "Errors",
  [LogLevel.Warning]: "Warnings",
};
function loadLogLevel(storage) {
  try {
    const raw = storage?.getItem?.(LOG_LEVEL_KEY);
    if (raw && raw in LOG_LEVEL_PRESETS) return raw;
  } catch (e) {
    // Private-mode / quota failure: fall through to the default.
  }
  return "warning";
}
function saveLogLevel(storage, key) {
  try {
    storage?.setItem?.(LOG_LEVEL_KEY, key);
  } catch (e) {
    // Private-mode / quota failure: the selection just does not persist.
  }
}
function presetKeyForLevel(level) {
  for (const [key, mask] of Object.entries(LOG_LEVEL_PRESETS)) {
    if (mask === level) return key;
  }
  return null;
}
let logLevelKey = loadLogLevel(appStorage());
setLogLevel(LOG_LEVEL_PRESETS[logLevelKey]);

/**
 * Identity of the connected pedal for auto-reopen. Zoom pedals share a
 * profile id, so the model byte is what keeps the MS-50G+ and MS-60B+
 * memories apart. Null until a device is connected.
 */
function deviceKeyForAutoReopenNow() {
  return deviceKeyForAutoReopen(profile?.id, currentModelByte);
}

/** Persist the open library as this pedal's "last library". */
function rememberOpenLibrary() {
  if (!patchLib) return;
  setLastLibraryForDevice(appStorage(), deviceKeyForAutoReopenNow(), {
    filePath: patchLibFilePath,
    fileName: patchLibFileName,
    snapshot: serializeLibrary(patchLib),
  });
}

/**
 * Silent auto-reopen after connect. Never a modal: there is nothing here the
 * user asked for yet, so any failure (file moved, corrupt, wrong family) is
 * a one-line status note and the app carries on library-less. New-library
 * clears the memory (Plan A), so untitled work never reopens by itself.
 */
async function maybeAutoReopenLibrary() {
  if (!libAutoReopen || patchLib) return;
  const deviceKey = deviceKeyForAutoReopenNow();
  if (!deviceKey) return;
  const last = getLastLibraryForDevice(appStorage(), deviceKey);
  if (!last) return;
  const kind = deviceKindForLibrarian();

  const openText = (text, { filePath = null, fileName = null } = {}) => {
    const parsed = parseLibrary(text, { expectedDeviceKind: kind });
    if (!parsed.ok) {
      status(`Could not reopen last library: ${parsed.error}.`, true);
      return;
    }
    setOpenLibrary(parsed.library, { filePath, fileName });
    if (parsed.skipped > 0) {
      status(`Reopened ${fileName ?? "last library"} (${parsed.library.patches.length} patches, ${parsed.skipped} skipped).`);
    } else {
      status(`Reopened ${fileName ?? "last library"} (${parsed.library.patches.length} patches).`);
    }
    // Re-persist: the path may have changed, and the snapshot must be fresh.
    rememberOpenLibrary();
  };

  if (typeof last.filePath === "string" && window.fileAPI?.readFileAtPath) {
    try {
      const res = await window.fileAPI.readFileAtPath({ filePath: last.filePath });
      if (res?.ok && typeof res.data === "string") {
        openText(res.data, { filePath: res.filePath ?? last.filePath, fileName: last.fileName });
        return;
      }
    } catch (e) {
      // Fall through to the snapshot below.
    }
  }
  if (typeof last.snapshot === "string") {
    openText(last.snapshot, { fileName: last.fileName });
  } else {
    status(`Could not reopen last library (file is gone and no copy was kept).`, true);
  }
}

const el = (id) => document.getElementById(id);
const els = {
  connLed: el("conn-led"),
  connLabel: el("conn-label"),
  patchNumber: el("patch-number"),
  patchName: el("patch-name"),
  patchTempo: el("patch-tempo"),
  patchTempoWrap: el("patch-tempo-wrap"),
  btnConnect: el("btn-connect"),
  btnSync: el("btn-sync"),
  btnRestore: el("btn-restore"),
  btnBackup: el("btn-backup"),
  btnSave: el("btn-save"),
  btnLoad: el("btn-load"),
  btnExportLog: el("btn-export-log"),
  logLevel: el("log-level"),
  patchList: el("patch-list"),
  sidebarHeader: el("sidebar-header"),
  chainEmpty: el("chain-empty"),
  chainWrap: el("chain-wrap"),
  chain: el("chain"),
  detail: el("detail"),
  detailName: el("detail-name"),
  detailBypass: el("detail-bypass"),
  detailKnobs: el("detail-knobs"),
  statusText: el("status-text"),
  crcIndicator: el("crc-indicator"),
  library: el("library"),
  libraryContent: el("library-content"),
  patchLibrary: el("patch-library"),
  patchLibraryName: el("patch-library-name"),
  patchLibraryList: el("patch-library-list"),
  patchStash: el("patch-stash"),
  patchStashList: el("patch-stash-list"),
  btnLibOpen: el("btn-lib-open"),
  btnLibSave: el("btn-lib-save"),
  btnLibSaveAs: el("btn-lib-save-as"),
  btnLibClose: el("btn-lib-close"),
  btnLibNew: el("btn-lib-new"),
  backupCollision: el("backup-collision"),
  backupCollisionText: el("backup-collision-text"),
  btnCollisionOverwrite: el("btn-collision-overwrite"),
  btnCollisionSkip: el("btn-collision-skip"),
  btnCollisionCancel: el("btn-collision-cancel"),
  libAutoReopen: el("lib-auto-reopen"),
  knobReverseWheel: el("knob-reverse-wheel"),
  panelWrap: el("panel-wrap"),
  panelModel: el("panel-model"),
  panelProgram: el("panel-program"),
  panelNote: el("panel-note"),
  panelGroups: el("panel-groups"),
  panelHead: el("panel-head"),
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function status(msg, isError = false) {
  els.statusText.textContent = msg;
  els.statusText.style.color = isError ? "var(--accent-red)" : "";
  if (isError) console.error(msg);
}

function updateRestoreButtonState() {
  els.btnRestore.disabled = !device || !device.isOpen || selectedMemorySlot === null;
}

function setConnected(open, name) {
  const isChain = profile?.layout === "chain";
  const isPanel = profile?.layout === "fixed-panel";

  els.connLed.className = "led " + (open ? "led-on" : "led-off");
  els.connLabel.textContent = open ? name : "Not connected";
  els.btnConnect.textContent = open ? "Reconnect" : "Connect";

  // Sync works for both layouts: on the Zoom side it uploads the patch blob,
  // on the POD side it replays every panel parameter as a control change.
  els.btnSync.disabled = !open;
  els.btnSync.title = (isPanel ? els.btnSync.dataset.podTitle : undefined) ?? els.btnSync.dataset.chainTitle;

  // Save / Load / Backup / Restore work on both kinds of pedal now: the Zoom
  // side moves whole patch blobs, the POD side moves 80-byte programs as .syx
  // sys-ex files. Only the wording of the tooltips differs.
  for (const b of [els.btnBackup, els.btnSave, els.btnLoad, els.btnRestore]) {
    b.disabled = !open;
    b.title = (isPanel ? b.dataset.podTitle : undefined) ?? b.dataset.chainTitle;
  }

  els.chainEmpty.classList.toggle("hidden", open);
  els.chainWrap.classList.toggle("hidden", !(open && isChain));
  els.panelWrap.classList.toggle("hidden", !(open && isPanel));
  els.library.classList.toggle("hidden", !(open && isChain));

  // The patch name field is the rename box on both layouts: a Zoom patch
  // carries its name in the blob, a POD program in bytes 64-79 of its dump.
  // On the POD side it stays blank until a dump has actually been read, so
  // there is never a rename box with nothing behind it. Tempo belongs to the
  // Zoom patch model only, so that one stays hidden here.
  if (!open || isPanel) els.patchName.value = "";
  els.patchName.disabled = !open || (isPanel && !device?.currentProgramBytes);
  els.patchTempoWrap.classList.toggle("hidden", !isChain);

  // The sidebar holds patch files for a Zoom pedal and the POD's 36 programs
  // for a POD; same list, different word.
  els.sidebarHeader.textContent = isPanel ? "Programs" : "Patches";

  if (panelControls.size > 0 && !open) resetPanel();

  // The librarian panel only makes sense with a device attached.
  updateLibrarianVisibility();
  // Silent auto-reopen never blocks the connect flow: failures are status-only.
  maybeAutoReopenLibrary();

  if (!open) {
    els.patchNumber.textContent = "--";
    els.patchName.value = "";
    els.patchTempo.textContent = "--";
    selectedMemorySlot = null;
    activeProgramNumber = null;
    els.libraryContent.innerHTML = "";
    els.crcIndicator.textContent = "";
  }
  updateRestoreButtonState();
}

// Tooltips the transport buttons carry while a Bass POD Pro is connected. The
// markup's own titles are the Zoom wording, kept in dataset.chainTitle.
const POD_TRANSPORT_TITLES = {
  "btn-sync": "Send every parameter on this panel to the POD as a control change",
  "btn-restore": "Load a program file directly into the selected program slot",
  "btn-backup": "Back up every program on the POD to a folder of .syx files",
  "btn-save": "Save the current program to a file",
  "btn-load": "Load a program file into the POD's edit buffer",
};

function setTransportAvailability() {
  // Remember the titles the markup came with, so switching between devices
  // restores them instead of leaving the other device's wording behind.
  for (const b of [els.btnSync, els.btnBackup, els.btnSave, els.btnLoad, els.btnRestore]) {
    if (b.dataset.chainTitle === undefined) b.dataset.chainTitle = b.title;
    const podTitle = POD_TRANSPORT_TITLES[b.id];
    if (podTitle !== undefined) b.dataset.podTitle = podTitle;
  }
}

async function loadEffectMapFor(file, modelNumber) {
  effectMap = {};
  const key = modelNumber ? modelNumber[0] : undefined;
  currentModelByte = key ?? null;
  if (!file) {
    status(`No effect map for model ${key !== undefined ? "0x" + key.toString(16) : "?"} yet - modules will show raw IDs.`);
    return;
  }
  try {
    const res = await fetch(file);
    if (!res.ok) {
      throw new Error(`Could not load ${file} (HTTP ${res.status})`);
    }
    effectMap = await res.json();
  } catch (e) {
    status("Could not load effect map: " + e.message, true);
  }
}

function effectInfo(id) {
  const key = (id >>> 0).toString(16).padStart(8, "0");
  return effectMap[key] || null;
}

/**
 * Registers the fetched mapping with ZoomDevice's write path.
 *
 * loadEffectMapFor() fills the display-side `effectMap` object, but the
 * write path (Sync to Pedal, knob edits) reads ZoomDevice._effectIDMaps,
 * keyed by device name - and nothing ever populated it, so every save
 * logged "No effect ID map found" and wrote zeros. This bridges the two.
 * Registered under both deviceName and deviceNameUnique: MIDIDeviceManager
 * appends " #N" to deviceNameUnique when two pedals share a base name.
 */
function registerDeviceEffectMap() {
  if (!device || typeof device.effectIDMap !== "undefined") return;
  const idMap = effectIdMapFromJson(effectMap);
  if (idMap.size === 0) {
    const label = device.deviceName ?? device.deviceInfo?.deviceName ?? "device";
    status(`Effect map for ${label} is empty - saving may write wrong values.`, true);
    log(LogLevel.Error, "app", `Effect map for ${label} is empty, not registering write-path map`);
    return;
  }
  const names = new Set(
    [device.deviceName, device.deviceInfo?.deviceName].filter((n) => typeof n === "string" && n)
  );
  ZoomDeviceClass.setEffectIDMap([...names], idMap);
}

// The BPM block's knob edits patch tempo, not an effect parameter: the pedal
// stores tempo in PRM2 and broadcasts it as parameterValueV2 slot 100 /
// parameter 2 (see ZoomDevice.setTempoOnDevice / messageTypes.tempoV2).
// Both block variants - utility (07000ff0) and effects-section (09000ff0).
function isTempoBlockId(id) {
  return id === 0x07000ff0 || id === 0x09000ff0;
}

// --- Connect flow --------------------------------------------------------

async function connect() {
  status("Requesting MIDI access…");
  try {
    midi = new MIDIProxyForWebMIDIAPI();
    await midi.enable();
  } catch (e) {
    status("MIDI access was denied, or Web MIDI isn't available.", true);
    return;
  }

  status("Looking for a pedal…");
  let descriptions;
  try {
    descriptions = await getMIDIDeviceList(midi, midi.inputs, midi.outputs, 150, false);
  } catch (e) {
    status("Error scanning MIDI devices: " + e.message, true);
    return;
  }

  const found = findProfileFor(descriptions);
  if (!found) {
    status("No supported device found. Connect a Zoom MS Plus pedal, or a Line 6 Bass POD Pro, and try again.", true);
    return;
  }
  const { profile: matchedProfile, description: desc } = found;

  // Reconnecting must not keep the old library open: libraries hold
  // patches for one device family, and the stash may hold bytes from the
  // previous device. Skip the discard warning here - Reconnect is an
  // explicit "start over" action.
  resetLibrarianForDevice();

  if (device) {
    try { await device.close(); } catch (e) { /* already closed, ignore */ }
  }

  profile = matchedProfile;
  setTransportAvailability();

  status(`Connecting to ${profile.deviceLabel(desc)}…`);
  try {
    profileData = await loadProfileData(profile);
  } catch (e) {
    status(`Could not load the ${profile.label} control map: ${e.message}`, true);
    return;
  }

  device = profile.createDevice(midi, desc, profileData);
  wireDeviceEvents(device);

  try {
    await device.open();
  } catch (e) {
    status("Could not open the device: " + e.message, true);
    return;
  }

  if (profile.layout === "chain") {
    device.parameterEditEnable();
    await loadEffectMapFor(profile.pickDataFile(desc), desc.modelNumber);
    registerDeviceEffectMap();
    populateLibrary();
  } else {
    renderFixedPanel(profileData);
    els.panelModel.textContent = profile.deviceLabel(desc);
    els.panelProgram.textContent = "--";
  }

  setConnected(true, profile.deviceLabel(desc));
  status("Connected.");

  if (profile.layout === "chain") {
    try {
      await device.downloadCurrentPatch();
    } catch (e) {
      status("Connected, but couldn't read the current patch: " + e.message, true);
    }
    loadPatchList(); // don't block the UI on a full patch-list read
  } else {
    els.crcIndicator.textContent = `${panelControls.size} live controls`;
    // The POD cannot be read over control changes, so reading it means asking
    // for dumps: all 36 patch names in one message, then the program it is
    // actually playing.
    loadPodProgramList();
  }
}

function wireDeviceEvents(dev) {
  dev.addOpenCloseListener((d, open) => {
    setConnected(open, d.deviceName);
    status(open ? "Connected." : "Disconnected.");
  });

  if (profile.layout === "chain") {
    dev.addCurrentPatchChangedListener((d) => renderChain(d.currentPatch));
    dev.addEffectParameterChangedListener((d, slot, paramNum, value) => {
      if (slot === selectedSlot) updateKnobDisplay(paramNum, value);
    });
    dev.addTempoChangedListener((d, tempo) => {
      els.patchTempo.textContent = tempo;
      // If a BPM block is selected its knob IS tempo: keep it in step with
      // pedal knob turns and tap-tempo, both of which arrive as tempoV2.
      const selEff = selectedSlot !== null ? d.currentPatch?.effectSettings?.[selectedSlot] : null;
      if (!selEff || !isTempoBlockId(selEff.id)) return;
      const knobEl = els.detailKnobs.querySelector(`.knob[data-param="0"]`);
      if (!knobEl) return;
      setKnobVisual(knobEl, tempo, Number(knobEl.dataset.max), Number(knobEl.dataset.min ?? 0));
      knobEl.parentElement.querySelector(".knob-value").textContent = String(tempo);
    });
    return;
  }

  // Fixed-panel devices report every change as a control change, whether it
  // came from the pedal's own front panel, from a MIDI controller, or from a
  // program change that reset the whole panel.
  dev.addParameterChangedListener((d, ccNumber, value) => updatePanelControlFromDevice(ccNumber, value));
  dev.addProgramChangedListener((d, programChangeNumber, label) => {
    const text = label ?? `PC ${programChangeNumber}`;
    els.patchNumber.textContent = text;
    els.panelProgram.textContent = text;
    activeProgramNumber = programNumberFor(programChangeNumber);
    highlightActiveProgram();
    status(`Pedal switched to ${text}.`);
    followPedalProgramChange(programChangeNumber, text);
  });

  // Everything the control changes above cannot tell us: the patch list's
  // names, and the stored values of a program that was just read.
  dev.addProgramListChangedListener((d, programs) => renderProgramList(programs));
  dev.addProgramLoadedListener((d, loaded) => applyProgramValues(loaded));
}

/** Device-kind guard for the librarian: one family per library file. */
function deviceKindForLibrarian() {
  return profile?.id === "bass-pod-pro" ? DEVICE_KIND_POD : profile?.id === "zoom-plus" ? DEVICE_KIND_ZOOM : null;
}

async function loadPatchList() {
  status("Loading patch list…");
  try {
    await device.updatePatchListFromPedal();
    renderPatchList(device.patchList);
    status("Ready.");
  } catch (e) {
    status("Could not load the patch list: " + e.message, true);
  }
}

function renderPatchList(patches) {
  els.patchList.innerHTML = "";
  patches.forEach((patch, i) => {
    const li = document.createElement("li");
    if (selectedMemorySlot === i) {
      li.classList.add("active");
    }
    li.draggable = true;
    li.dataset.slot = String(i);
    li.innerHTML = `<span class="p-num">${String(i).padStart(2, "0")}</span>` +
      `<span class="p-name">${escapeHtml(patch?.name || "(empty)")}</span>`;
    li.addEventListener("click", () => selectPatchFromList(i, li));
    wireDeviceSlotDrag(li, i);
    wireSlotDropTarget(li, i);
    els.patchList.appendChild(li);
  });
}

async function selectPatchFromList(index, li) {
  selectedMemorySlot = index;
  updateRestoreButtonState();
  status(`Loading patch ${index}…`);
  try {
    const loaded = await device.downloadPatchFromMemorySlot(index);
    if (!loaded) { status(`Patch ${index} came back empty.`, true); return; }
    device.uploadPatchToCurrentPatch(loaded); // pushes to the pedal's edit buffer, fires currentPatchChanged
    [...els.patchList.children].forEach((c) => c.classList.remove("active"));
    li.classList.add("active");
    els.patchNumber.textContent = String(index).padStart(2, "0");
    status("Ready.");
  } catch (e) {
    status(`Could not load patch ${index}: ${e.message}`, true);
  }
}

// --- Patch list and program dumps, fixed-panel devices (Bass POD Pro) ------
//
// Same sidebar as the Zoom side, different meaning: a Zoom patch is a file in
// the pedal's memory that the app loads into its own editor, while a POD
// program only exists on the POD. Clicking one recalls it there and reads it
// back, so what the panel shows is what the hardware is playing.

/** Program number (0 = 1A) for a program change number, or null. */
function programNumberFor(programChangeNumber) {
  const index = programChangeNumber - (profileData?.programs?.pcBase ?? 1);
  const count = profileData?.programs?.count ?? 0;
  return index >= 0 && index < count ? index : null;
}

function renderProgramList(programs) {
  els.patchList.innerHTML = "";
  for (const program of programs) {
    const li = document.createElement("li");
    if (program.programNumber === activeProgramNumber) li.classList.add("active");
    li.draggable = true;
    li.dataset.slot = String(program.programNumber);
    li.innerHTML = `<span class="p-num">${escapeHtml(program.label ?? "??")}</span>` +
      `<span class="p-name">${escapeHtml(program.name || "(empty)")}</span>`;
    li.addEventListener("click", () => selectProgramFromList(program.programNumber));
    wireDeviceSlotDrag(li, program.programNumber);
    wireSlotDropTarget(li, program.programNumber);
    els.patchList.appendChild(li);
  }
}

/** Rows are always in program order, so the row index is the program number. */
function highlightActiveProgram() {
  [...els.patchList.children].forEach((li, index) => li.classList.toggle("active", index === activeProgramNumber));
}

/** Reads the POD's patch names, then the program it is actually playing. */
async function loadPodProgramList() {
  if (!device?.isOpen) return;
  status("Reading the POD's patch list…");
  try {
    const programs = await device.requestProgramNames();
    if (!programs || programs.length === 0) {
      status("The POD didn't send its patch list - check that its MIDI channel matches the app's.", true);
      return;
    }
    status(`Read ${programs.length} patch names from the POD.`);
    const current = await device.requestEditBufferDump();
    status(current ? "Panel loaded from the POD." : "Read the patch list, but not the current program.");
  } catch (e) {
    status("Could not read the POD's patch list: " + e.message, true);
  }
}

async function selectProgramFromList(programNumber) {
  if (!device?.isOpen) return;
  // Which program the sidebar points at - also the target for "Restore to
  // Slot", the same variable the Zoom side uses for its memory slots.
  selectedMemorySlot = programNumber;
  updateRestoreButtonState();
  const label = device.programLabelFor(device.programChangeFor(programNumber)) ?? `program ${programNumber + 1}`;
  status(`Recalling ${label} on the POD…`);
  const loaded = await device.loadProgram(programNumber);
  if (!loaded) {
    status(`${label} came back empty - check that the POD's MIDI channel matches the app's.`, true);
    return;
  }
  status(`Loaded ${label}${loaded.name ? " " + loaded.name : ""} from the POD.`);
}

/**
 * The POD was changed from its own front panel (or by some other MIDI device).
 *
 * It sends a program change when that happens, but not the program's contents,
 * so without this the panel would carry on showing the patch you were on before
 * you stepped on the POD. The program is read back and painted on; nothing is
 * sent, because the POD has already switched by itself.
 */
async function followPedalProgramChange(programChangeNumber, label) {
  if (!device?.isOpen) return;
  // An echo of a program change the app sent never reaches here: the adapter
  // swallows it, because whichever click sent it is reading that program already.

  const programNumber = programNumberFor(programChangeNumber);
  if (programNumber === null) {
    // Manual mode and the tuner aren't stored programs, so nothing on the panel
    // describes them - better to say so than to leave a stale patch on screen.
    forgetPanelValues(`POD switched to ${label} - no program is loaded, so there is nothing to read back.`);
    return;
  }

  status(`POD switched to ${label} - reading it…`);
  try {
    const loaded = await device.requestProgramDump(programNumber);
    status(loaded
      ? `Panel now showing ${label}${loaded.name ? " " + loaded.name : ""}.`
      : `The POD switched to ${label}, but it did not send that program back.`, !loaded);
  } catch (e) {
    status(`Could not read ${label} from the POD: ${e.message}`, true);
  }
}

/**
 * Puts every control back to "unknown" (dimmed) without rebuilding the panel.
 * Used when the POD leaves program territory: the values on screen belonged to
 * the program it was on, and leaving them there would misrepresent the pedal.
 */
function forgetPanelValues(message) {
  for (const handle of panelControls.values()) handle.setUnset?.();
  activeProgramNumber = null;
  highlightActiveProgram();
  // Manual and the tuner hold no program, so there is nothing to rename.
  els.patchName.value = "";
  els.patchName.disabled = true;
  els.crcIndicator.textContent = `${panelControls.size} live controls`;
  if (message) els.panelNote.textContent = message;
}

/**
 * Paints a program dump onto the panel.
 *
 * This is the only way these controls ever get a value without somebody
 * moving them - the POD does not report a program as control changes - which
 * is why the panel is dimmed until a dump has been read. Controls the dump
 * says nothing about stay dimmed, so "Sync to Pedal" can still refuse to
 * invent values for them.
 */
function applyProgramValues(loaded) {
  let fromDump = 0;
  for (const [ccNumber, value] of loaded.values) {
    const handle = panelControls.get(ccNumber);
    if (!handle) continue; // a dump field this panel has no control for
    handle.setValue(value);
    fromDump++;
  }
  if (loaded.programNumber !== undefined) activeProgramNumber = loaded.programNumber;
  highlightActiveProgram();

  const label = loaded.label ?? "Current patch";
  if (loaded.label) els.patchNumber.textContent = loaded.label;
  // Don't yank the box out from under somebody still typing in it: the rename
  // handler is async, and the name it writes back may lag their keystrokes.
  if (document.activeElement !== els.patchName) els.patchName.value = loaded.name ?? "";
  els.patchName.disabled = false;
  els.panelProgram.textContent = loaded.name ? `${label} ${loaded.name}` : label;
  els.crcIndicator.textContent = `${fromDump} of ${panelControls.size} controls from the dump`;
  els.panelNote.textContent = fromDump >= panelControls.size
    ? "Every value on this panel was read from the POD's sys-ex program dump."
    : `Values read from the POD's dump: ${fromDump} of ${panelControls.size} controls. The rest are ` +
      "not in the dump (or the dump cannot pin them down), so they stay dimmed.";
}

// --- Signal chain rendering ------------------------------------------------

function renderChain(patch) {
  els.chain.innerHTML = "";
  selectedSlot = null;
  els.detail.classList.add("hidden");
  if (!patch) return;

  els.patchName.value = patch.name || "";
  els.patchTempo.textContent = patch.tempo ?? "--";

  const settings = patch.effectSettings || [];
  els.crcIndicator.textContent = `${settings.length} effect${settings.length === 1 ? "" : "s"}`;

  settings.forEach((eff, i) => {
    if (i > 0) {
      const wire = document.createElement("div");
      wire.className = "wire";
      els.chain.appendChild(wire);
    }
    const info = effectInfo(eff.id);
    const label = info?.screenName || info?.name || "Effect " + eff.id.toString(16);
    const mod = document.createElement("div");
    mod.className = "module draggable" + (eff.enabled ? " enabled" : "");
    mod.dataset.slot = String(i);
    mod.draggable = true;
    mod.innerHTML =
      `<div class="module-body">${iconSvgFor(currentModelByte, eff.id, info)}<div class="module-led"></div></div>` +
      `<div class="module-label">${escapeHtml(label)}</div>` +
      `<button class="module-delete" title="Remove effect">×</button>`;
    mod.addEventListener("click", () => selectEffect(patch, i));

    // Delete button
    mod.querySelector(".module-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteEffect(patch, i);
    });

    // Drag and drop for reordering within the chain
    mod.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-chain-slot", String(i));
      e.dataTransfer.effectAllowed = "move";
      mod.classList.add("dragging");
    });

    mod.addEventListener("dragend", () => {
      mod.classList.remove("dragging");
      hideChainDropHighlights();
    });

    mod.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-chain-slot")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      mod.classList.add("drag-over");
    });

    mod.addEventListener("dragleave", () => {
      mod.classList.remove("drag-over");
    });

    mod.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromSlot = parseInt(e.dataTransfer.getData("application/x-chain-slot"), 10);
      const toSlot = parseInt(mod.dataset.slot, 10);
      if (!isNaN(fromSlot) && !isNaN(toSlot) && fromSlot !== toSlot) {
        reorderEffect(patch, fromSlot, toSlot);
      }
      mod.classList.remove("drag-over");
    });

    els.chain.appendChild(mod);
  });

  updateLibraryState();
}

function deleteEffect(patch, slot) {
  if (!patch?.effectSettings) return;
  const info = effectInfo(patch.effectSettings[slot].id);
  patch.deleteEffectInSlot(slot);
  renderChain(patch);
  status(`Removed ${info?.name || "effect"} from chain.`);
}

function reorderEffect(patch, fromSlot, toSlot) {
  if (!patch?.effectSettings) return;
  if (toSlot < 0 || toSlot >= patch.effectSettings.length) return;
  if (fromSlot === toSlot) return;

  // Move effect by slicing it out and inserting at the new position
  const effect = patch.effectSettings[fromSlot];
  patch.effectSettings.splice(fromSlot, 1);
  patch.effectSettings.splice(toSlot, 0, effect);

  // Update IDs array to match
  if (patch.ids !== null) {
    const id = patch.ids[fromSlot];
    // Shift IDs
    if (fromSlot < toSlot) {
      for (let i = fromSlot; i < toSlot; i++) {
        patch.ids[i] = patch.ids[i + 1];
      }
    } else {
      for (let i = fromSlot; i > toSlot; i--) {
        patch.ids[i] = patch.ids[i - 1];
      }
    }
    patch.ids[toSlot] = id;
  }

  renderChain(patch);
  // Update selection to follow the moved effect
  if (selectedSlot === fromSlot) {
    selectEffect(patch, toSlot);
  } else if (selectedSlot === toSlot) {
    selectEffect(patch, fromSlot);
  }
}

function hideChainDropHighlights() {
  els.chain.querySelectorAll(".module.drag-over").forEach(m => m.classList.remove("drag-over"));
  els.chain.querySelectorAll(".wire.drag-over").forEach(w => w.classList.remove("drag-over"));
}

// --- Effect Library -------------------------------------------------------

const CATEGORY_ORDER = [
  "dynamics", "filter", "drive", "amp", "modulation",
  "pitch", "synth", "sfx", "delay", "reverb", "fx",
];

const CATEGORY_LABELS = {
  dynamics: "Dynamics",
  filter: "Filter",
  drive: "Drive",
  amp: "Amp",
  modulation: "Modulation",
  pitch: "Pitch",
  synth: "Synth",
  sfx: "SFX",
  delay: "Delay",
  reverb: "Reverb",
  fx: "Other",
};

function populateLibrary() {
  els.libraryContent.innerHTML = "";
  if (!effectMap || Object.keys(effectMap).length === 0) return;

  // Group effects by category
  const byCategory = {};
  for (const [hexId, info] of Object.entries(effectMap)) {
    const id = parseInt(hexId, 16);
    const category = categorize(currentModelByte, id, info.name);
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push({ id, info });
  }

  // Sort effects within each category by name
  for (const category of Object.keys(byCategory)) {
    byCategory[category].sort((a, b) => a.info.name.localeCompare(b.info.name));
  }

  // Render categories in order
  for (const category of CATEGORY_ORDER) {
    const effects = byCategory[category];
    if (!effects || effects.length === 0) continue;

    const catEl = document.createElement("div");
    catEl.className = "lib-category";

    const nameEl = document.createElement("div");
    nameEl.className = "lib-category-name";
    nameEl.textContent = CATEGORY_LABELS[category] || category;
    catEl.appendChild(nameEl);

    const effectsEl = document.createElement("div");
    effectsEl.className = "lib-category-effects";

    for (const { id, info } of effects) {
      const effEl = document.createElement("div");
      effEl.className = "lib-effect";
      effEl.draggable = true;
      effEl.dataset.effectId = String(id);

      const iconSvg = iconSvgFor(currentModelByte, id, info);
      effEl.innerHTML =
        `<div class="lib-effect-icon">${iconSvg}</div>` +
        `<div class="lib-effect-name" title="${escapeHtml(info.name)}">${escapeHtml(info.screenName || info.name)}</div>`;

      // Drag events for library items
      effEl.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-effect-id", String(id));
        e.dataTransfer.effectAllowed = "copy";
        effEl.classList.add("dragging");
      });

      effEl.addEventListener("dragend", () => {
        effEl.classList.remove("dragging");
        hideDropIndicator();
        updateLibraryState();
      });

      effectsEl.appendChild(effEl);
    }

    catEl.appendChild(effectsEl);
    els.libraryContent.appendChild(catEl);
  }

  updateLibraryState();
}

function updateLibraryState() {
  const patch = device?.currentPatch;
  const maxEffects = patch?.maxNumEffects ?? device?.maxNumEffects ?? 6;
  const currentCount = patch?.effectSettings?.length ?? 0;
  els.library.classList.toggle("full", currentCount >= maxEffects);
}

function setupChainDropZone() {
  // Make the chain a drop zone for new effects from the library
  els.chain.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-effect-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    showDropIndicator(e);
  });

  els.chain.addEventListener("dragleave", (e) => {
    // Only hide if we're leaving the chain entirely (not entering a child)
    if (!els.chain.contains(e.relatedTarget)) {
      hideDropIndicator();
    }
  });

  els.chain.addEventListener("drop", (e) => {
    e.preventDefault();
    const effectId = parseInt(e.dataTransfer.getData("application/x-effect-id"), 10);
    if (isNaN(effectId)) return;

    const patch = device?.currentPatch;
    if (!patch) return;

    const maxEffects = patch.maxNumEffects;
    if (patch.effectSettings.length >= maxEffects) {
      status(`Maximum ${maxEffects} effects reached.`, true);
      hideDropIndicator();
      return;
    }

    const dropIndex = getDropIndex(e);
    addEffectToPatch(patch, effectId, dropIndex);
    hideDropIndicator();
  });
}

function showDropIndicator(e) {
  hideDropIndicator(); // clear any existing

  const indicator = document.createElement("div");
  indicator.className = "chain-drop-indicator active";
  indicator.id = "chain-drop-indicator";

  const dropIndex = getDropIndex(e);
  const modules = [...els.chain.querySelectorAll(".module")];

  if (dropIndex <= 0) {
    els.chain.prepend(indicator);
  } else if (dropIndex >= modules.length) {
    els.chain.appendChild(indicator);
  } else {
    // Insert before the module at dropIndex
    const targetModule = modules.find(m => Number(m.dataset.slot) === dropIndex);
    if (targetModule) {
      els.chain.insertBefore(indicator, targetModule);
    } else {
      els.chain.appendChild(indicator);
    }
  }
}

function hideDropIndicator() {
  const indicator = document.getElementById("chain-drop-indicator");
  if (indicator) indicator.remove();
}

function getDropIndex(e) {
  // Find the position in the chain where the effect should be inserted
  const modules = [...els.chain.querySelectorAll(".module")];
  if (modules.length === 0) return 0;

  // Get the mouse position relative to the chain
  const mouseX = e.clientX;

  // Find the module that the mouse is over
  for (let i = 0; i < modules.length; i++) {
    const rect = modules[i].getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (mouseX < midX) {
      return i;
    }
  }

  // Mouse is past all modules, insert at the end
  return modules.length;
}

async function addEffectToPatch(patch, effectId, slot) {
  const info = effectInfo(effectId);
  const numParams = info?.parameters?.length ?? 0;

  // Dynamically import EffectSettings from ZoomPatch
  const { EffectSettings } = await import("./lib/ZoomPatch.js");

  // Create EffectSettings with default parameter values
  const settings = new EffectSettings(numParams);
  settings.enabled = true;
  settings.id = effectId;

  // Set default parameter values from the effect mapping
  if (info?.parameters) {
    for (let i = 0; i < info.parameters.length; i++) {
      const param = info.parameters[i];
      // Without a default, fall back to the floor rather than 0 - a param
      // like BPM (40-250) would otherwise be added out of range.
      settings.parameters[i] = param.default ?? param.min ?? 0;
    }
  }

  patch.addEffectInSlot(slot, settings);
  renderChain(patch);
  updateLibraryState();
  status(`Added ${info?.name || "effect"} to chain.`);
}

function selectEffect(patch, slot) {
  selectedSlot = slot;
  [...els.chain.querySelectorAll(".module")].forEach((m) => {
    m.classList.toggle("selected", Number(m.dataset.slot) === slot);
  });

  const eff = patch.effectSettings[slot];
  const info = effectInfo(eff.id);
  els.detail.classList.remove("hidden");
  els.detailName.textContent = info?.name || `Effect 0x${eff.id.toString(16)}`;

  els.detailBypass.checked = eff.enabled;
  els.detailBypass.onchange = () => {
    device.setEffectParameterForCurrentPatch(slot, 0, els.detailBypass.checked ? 1 : 0);
    document.querySelector(`.module[data-slot="${slot}"]`)?.classList.toggle("enabled", els.detailBypass.checked);
  };

  renderKnobs(eff, info, slot);
}

function renderKnobs(eff, info, slot) {
  els.detailKnobs.innerHTML = "";
  // eff.parameters is a fixed-size array (padded to the pedal's max
  // parameter slots) - it's NOT the number of real parameters for this
  // specific effect. The effect map's own parameter list is the true
  // count. Effects we don't have a map for (fallback) still show
  // whatever the live patch reports, since that's all we know.
  const paramCount = info?.parameters?.length ?? eff.parameters.length;
  // A BPM block's "parameter" is patch tempo (lives in PRM2), never the
  // padded EDTB slot - the pedal itself stores 0 there (verified against a
  // pedal-written dump), so read and write tempo instead.
  const isTempoBlock = isTempoBlockId(eff.id);
  for (let paramIndex = 0; paramIndex < paramCount; paramIndex++) {
    const value = isTempoBlock
      ? (device.currentTempo ?? device.currentPatch?.tempo ?? 0)
      : eff.parameters[paramIndex];
    const paramInfo = info?.parameters?.[paramIndex];
    // Parameters can declare a floor (the BPM block runs 40-250); without it
    // the knob would happily send values below the pedal's own minimum.
    const min = paramInfo?.min ?? 0;
    const max = paramInfo?.max ?? 127;
    const name = paramInfo?.name ?? `Param ${paramIndex + 1}`;
    const isUndocumented = /^hidden/i.test(name);

    const unit = document.createElement("div");
    unit.className = "knob-unit" + (isUndocumented ? " undocumented" : "");
    unit.title = isUndocumented
      ? "This is a real, controllable parameter that thammer's reverse-engineering found in the sysex protocol, but its actual function was never identified - likely because it's not shown on the pedal's own display either. Safe to experiment with; just know that neither this app nor the pedal can currently tell you what it does."
      : "";
    unit.innerHTML =
      `<div class="knob" data-param="${paramIndex}" data-min="${min}" data-max="${max}"></div>` +
      `<div class="knob-name">${escapeHtml(name)}</div>` +
      `<div class="knob-value">${escapeHtml(displayValue(paramInfo, value))}</div>`;
    els.detailKnobs.appendChild(unit);

    const knobEl = unit.querySelector(".knob");
    setKnobVisual(knobEl, value, max, min);
    wireKnobDrag(knobEl, {
      min,
      max,
      getValue: () => isTempoBlock
        ? (device.currentTempo ?? device.currentPatch?.tempo ?? 0)
        : device.currentPatch.effectSettings[slot].parameters[paramIndex],
      onChange: (newValue) => {
        unit.querySelector(".knob-value").textContent = displayValue(paramInfo, newValue);
        if (isTempoBlock) {
          // Live send; the header (and this knob) refresh via the tempo echo.
          device.setTempoOnDevice(newValue);
          return;
        }
        device.setEffectParameterForCurrentPatch(slot, paramIndex + 2, newValue);
      },
    });
  }
}

function displayValue(paramInfo, value) {
  if (paramInfo?.values && paramInfo.values[value] !== undefined) return paramInfo.values[value];
  return String(value);
}

// setKnobVisual() and wireKnobDrag() now live in ui/controls.js, shared with
// the fixed-panel (Bass POD Pro) layout.

function updateKnobDisplay(paramNumber, value) {
  const paramIndex = paramNumber - 2;
  if (paramIndex < 0) return; // 0 = enable/bypass, 1 = effect id - not a knob
  const knobEl = els.detailKnobs.querySelector(`.knob[data-param="${paramIndex}"]`);
  if (!knobEl) return;
  const min = Number(knobEl.dataset.min ?? 0);
  const max = Number(knobEl.dataset.max);
  setKnobVisual(knobEl, value, max, min);
  const info = device?.currentPatch ? effectInfo(device.currentPatch.effectSettings[selectedSlot].id) : null;
  const paramInfo = info?.parameters?.[paramIndex];
  knobEl.parentElement.querySelector(".knob-value").textContent = displayValue(paramInfo, value);
}

// --- Fixed-panel rendering (Bass POD Pro) ----------------------------------
//
// Unlike the Zoom chain, this panel is data-driven: every control, range and
// value name comes from the device's profile JSON (shared/data/), so adding
// another fixed-panel device means writing a new JSON file plus a protocol
// adapter, not new UI code.

function renderFixedPanel(data) {
  els.panelGroups.innerHTML = "";
  panelControls.clear();
  if (!data) return;

  for (const group of data.groups || []) {
    const groupEl = document.createElement("section");
    groupEl.className = "panel-group";
    const nameEl = document.createElement("div");
    nameEl.className = "panel-group-name";
    nameEl.textContent = group.name;
    groupEl.appendChild(nameEl);

    const rowEl = document.createElement("div");
    rowEl.className = "panel-row";
    for (const control of group.controls || []) {
      const handle = buildPanelControl(control, data);
      rowEl.appendChild(handle.el);
      if (control.cc !== undefined && control.cc !== null) panelControls.set(control.cc, handle);
    }
    groupEl.appendChild(rowEl);
    els.panelGroups.appendChild(groupEl);
  }

  const count = panelControls.size;
  els.panelNote.textContent = count === 0
    ? "This device's control map is empty."
    : `All ${count} controls are live MIDI control changes on channel ${device?.channel ?? data.channel}. ` +
      "Connecting reads the program the POD is playing, so the panel shows what is really in it; click a patch " +
      "in the list to recall that program and read it back. Anything the dump cannot tell us stays dimmed with a " +
      "\"?\", and turning a knob here (or on the POD) updates the panel live.";
}

function buildPanelControl(control, data) {
  const base = {
    label: control.label,
    title: control.title || "",
    hint: control.hint || "",
    // Nothing has reported the pedal's current settings yet, so every control
    // starts "unset" (dimmed) rather than showing a value we made up.
    unset: true,
    value: control.default ?? control.min ?? 0,
  };
  const send = (value) => {
    if (!device?.isOpen) return;
    device.setParameter(control.cc, value);
  };

  switch (control.kind) {
    case "select": {
      const options = data.valueTables?.[control.table] || [];
      return buildSelectUnit({
        ...base,
        options,
        onChange: (value) => {
          send(value);
          const option = options[value];
          status(`${control.label}: ${option ? option.name : value}`);
        },
      });
    }
    case "toggle":
      return buildToggleUnit({
        ...base,
        offValue: control.offValue ?? 0,
        onValue: control.onValue ?? 127,
        onChange: (value) => {
          send(value);
          status(`${control.label}: ${value >= ((control.offValue ?? 0) + (control.onValue ?? 127)) / 2 ? "on" : "off"}`);
        },
      });
    case "action":
      return buildActionUnit({
        label: control.label,
        title: control.title || "",
        hint: control.hint || "",
        onClick: () => {
          if (!device?.isOpen) return;
          device.sendProgramChange(control.pc);
          // Manual and the tuner aren't stored programs, so whatever the panel
          // was showing stopped describing the POD the moment it switched.
          forgetPanelValues(`POD switched to ${control.label} - no program is loaded, so there is nothing to read back.`);
          status(`${control.label} sent to the pedal.`);
        },
      });
    case "knob":
    default:
      return buildKnobUnit({
        ...base,
        min: control.min ?? 0,
        max: control.max ?? 127,
        // A control whose hardware display is banded (the compressor ratio, say)
        // shows the band's name instead of a bare number.
        formatValue: control.valueBands ? (value) => formatByBands(value, control.valueBands) : undefined,
        onChange: (value) => send(value),
      });
  }
}

// --- Patch librarian ----------------------------------------------------------
//
// Free-length list of patches for one device family + memory-only stash for
// patches displaced from device slots. Payloads are the devices' exact
// bytes (Zoom blobs, raw 80-byte POD programs), so no conversion here can
// lose data - this layer only moves bytes between slot reads, entries,
// and the existing upload paths.

function librarianReady() {
  return Boolean(device?.isOpen && patchLib && deviceKindForLibrarian() === patchLib.deviceKind);
}

/** Display model for a slot: Zoom pedal name or POD label. */
function modelForSlotHint() {
  if (profile?.layout === "fixed-panel") return "Bass POD Pro";
  return device?.deviceName ?? currentModelByte ?? "";
}

function updateLibrarianVisibility() {
  // The toggle reflects the persisted setting even with no device attached,
  // so sync it here (not in renderLibraryHeader, which renderLibraryList
  // skips while the panel is hidden).
  if (els.libAutoReopen && els.libAutoReopen.checked !== libAutoReopen) {
    els.libAutoReopen.checked = libAutoReopen;
  }
  if (els.knobReverseWheel && els.knobReverseWheel.checked !== knobReverseWheelOn) {
    els.knobReverseWheel.checked = knobReverseWheelOn;
  }
  if (!els.patchLibrary) return;
  // Visible whenever a device is attached, even with no library open: the
  // panel is also the drop target that creates one (see sendSlotToLibrary).
  const show = Boolean(device?.isOpen);
  els.patchLibrary.classList.toggle("hidden", !show);
  if (show) renderPatchLibrary();
}

function slotHintMeta(entry) {
  if (entry.slotHint === null || entry.slotHint === undefined) return entry.model || "";
  const slot = profile?.layout === "fixed-panel" && device
    ? (device.programLabelFor(device.programChangeFor(entry.slotHint)) ?? `slot ${entry.slotHint}`)
    : `slot ${entry.slotHint}`;
  return entry.model ? `${entry.model} · ${slot}` : slot;
}

function renderPatchLibrary() {
  if (!els.patchStashList || !els.patchLibraryList) return;
  els.patchStashList.innerHTML = "";
  els.patchLibraryList.innerHTML = "";
  if (!patchLib) {
    // The panel stays visible with no library open so it can act as the drop
    // target that creates one; say so instead of showing an empty box.
    const hint = document.createElement("li");
    hint.className = "lib-empty";
    hint.textContent = "No library open. Use New or Open above, or drag a patch over from the device list.";
    els.patchLibraryList.appendChild(hint);
    renderLibraryHeader();
    return;
  }
  for (const entry of patchStash) els.patchStashList.appendChild(makeLibraryRow(entry, { stashed: true }));
  for (const entry of patchLib.patches) els.patchLibraryList.appendChild(makeLibraryRow(entry));
  renderLibraryHeader();
}

function markLibraryDirty(dirty = true) {
  patchLibDirty = dirty;
  renderLibraryHeader();
}

function makeLibraryRow(entry, { stashed = false } = {}) {
  const li = document.createElement("li");
  li.className = "lib-row" + (stashed ? " stashed" : "");
  li.draggable = true;
  li.dataset.entryId = entry.id;
  li.title = stashed ? "Displaced from the device - Keep saves it to the library" : "Drag to a device slot, or double-click to audition";
  const name = document.createElement("span");
  name.className = "p-name";
  name.textContent = entry.name || "(untitled)";
  const meta = document.createElement("span");
  meta.className = "p-meta";
  meta.textContent = slotHintMeta(entry);
  li.append(name, meta);
  if (stashed) {
    const keep = document.createElement("button");
    keep.className = "row-btn row-keep";
    keep.textContent = "Keep";
    keep.title = "Keep this patch in the library";
    keep.addEventListener("click", (e) => { e.stopPropagation(); keepStashedEntry(entry.id); });
    li.append(keep);
  }
  const del = document.createElement("button");
  del.className = "row-btn";
  del.textContent = "×";
  del.title = stashed ? "Discard" : "Remove from library";
  del.addEventListener("click", (e) => { e.stopPropagation(); stashed ? discardStashedEntry(entry.id) : removeLibraryEntry(entry.id); });
  li.append(del);
  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData(DRAG_LIBRARY_PATCH, JSON.stringify({ id: entry.id }));
    e.dataTransfer.effectAllowed = "copy";
  });
  li.addEventListener("dblclick", () => auditionLibraryEntry(entry.id));
  return li;
}

function removeLibraryEntry(id) {
  if (!patchLib) return;
  patchLib.patches = patchLib.patches.filter((e) => e.id !== id);
  markLibraryDirty(true);
  renderPatchLibrary();
}

function keepStashedEntry(id) {
  const index = patchStash.findIndex((e) => e.id === id);
  if (index < 0 || !patchLib) return;
  const [entry] = patchStash.splice(index, 1);
  patchLib.patches.push(entry);
  markLibraryDirty(true);
  renderPatchLibrary();
  status(`Kept "${entry.name}" in the library. Save the library to keep it permanently.`);
}

function discardStashedEntry(id) {
  patchStash = patchStash.filter((e) => e.id !== id);
  renderPatchLibrary();
  if (patchStash.length === 0 && !patchLibDirty) status("Stash cleared.");
}

function renderLibraryHeader() {
  if (!els.patchLibraryName || !els.patchStash) return;
  const name = patchLibFileName ?? "Untitled";
  const dirtyMark = patchLibDirty ? " *" : "";
  const kind = patchLib ? ` (${labelForDeviceKind(patchLib.deviceKind)})` : "";
  els.patchLibraryName.textContent = patchLib ? `${name}${dirtyMark}${kind}` : "No library open";
  els.btnLibSave.disabled = !patchLib;
  els.btnLibSaveAs.disabled = !patchLib;
  els.btnLibClose.disabled = !patchLib;
  els.patchStash.classList.toggle("hidden", patchStash.length === 0);
}

/** Read a slot's bytes without disturbing the panel. */
async function readSlotBytes(slot) {
  if (profile?.layout === "fixed-panel") {
    const cached = device.storedProgramBytes?.[slot];
    if (cached) return new Uint8Array(cached);
    const loaded = await device.downloadPatchFromMemorySlot(slot);
    return loaded ? new Uint8Array(loaded) : undefined;
  }
  const fromList = device.patchList?.[slot];
  if (fromList) return patchToBytes(fromList);
  const patch = await device.downloadPatchFromMemorySlot(slot);
  return patch ? patchToBytes(patch) : undefined;
}

function slotDisplayName(slot) {
  if (profile?.layout === "fixed-panel" && device) {
    return device.programLabelFor(device.programChangeFor(slot)) ?? `slot ${slot}`;
  }
  return `slot ${slot}`;
}

/** Name + model for stash/row labels, read from bytes (never the panel). */
async function describeSlotBytes(slot, bytes) {
  if (profile?.layout === "fixed-panel") {
    const { readPatchName } = await import("./devices/bassPodProSysex.js");
    return { name: readPatchName(bytes, profileData?.sysexLayout) || slotDisplayName(slot), model: "Bass POD Pro" };
  }
  const { ZoomPatch } = await import("./lib/ZoomPatch.js");
  const patch = ZoomPatch.fromPatchData(bytes);
  return { name: patch?.name || slotDisplayName(slot), model: modelForSlotHint() };
}

async function writeBytesToSlot(slot, bytes) {
  if (profile?.layout === "fixed-panel") {
    const stored = await device.uploadProgramToSlot(slot, bytes);
    if (!stored) return false;
    await device.uploadEditBuffer(bytes, { keepActiveProgram: true });
    device.activeProgramNumber = slot;
    activeProgramNumber = slot;
    highlightActiveProgram();
    return true;
  }
  const { ZoomPatch } = await import("./lib/ZoomPatch.js");
  const patch = ZoomPatch.fromPatchData(bytes);
  if (!patch) return false;
  const success = await device.uploadPatchToMemorySlot(patch, slot);
  if (!success) return false;
  device.uploadPatchToCurrentPatch(patch);
  selectedMemorySlot = slot;
  updateRestoreButtonState();
  const item = els.patchList.children[slot];
  if (item) {
    [...els.patchList.children].forEach((c) => c.classList.remove("active"));
    item.classList.add("active");
    item.querySelector(".p-name").textContent = patch.name || "(empty)";
  }
  return true;
}

async function auditionBytes(bytes) {
  if (profile?.layout === "fixed-panel") {
    return await device.uploadEditBuffer(bytes);
  }
  const { ZoomPatch } = await import("./lib/ZoomPatch.js");
  const patch = ZoomPatch.fromPatchData(bytes);
  if (!patch) return false;
  device.uploadPatchToCurrentPatch(patch);
  return true;
}

/** Library -> slot with overwrite protection: stash first, then write. */
async function dropLibraryEntryOnSlot(entryId, slot) {
  if (!librarianReady()) return;
  const entry = patchLib.patches.find((e) => e.id === entryId)
    ?? patchStash.find((e) => e.id === entryId);
  if (!entry) return;
  let bytes;
  try {
    bytes = entryToBytes(entry);
  } catch (e) {
    status(`"${entry.name}" is corrupt and cannot be sent to the device.`, true);
    return;
  }
  status(`Reading ${slotDisplayName(slot)}…`);
  const existing = await readSlotBytes(slot);
  let stashed = false;
  if (hasStashableBytes(existing)) {
    const info = await describeSlotBytes(slot, existing);
    addToStash(patchStash, entryFromBytes({ ...info, slotHint: slot, bytes: existing }));
    stashed = true;
  }
  status(`Writing "${entry.name}" to ${slotDisplayName(slot)}…`);
  const ok = await writeBytesToSlot(slot, bytes);
  renderPatchLibrary();
  const note = stashed ? " The previous patch was stashed." : "";
  status(ok ? `"${entry.name}" is now in ${slotDisplayName(slot)}.${note}` : `Could not write to ${slotDisplayName(slot)}.`, !ok);
}

/** Device slot -> library: read the slot, append a row, mark dirty. */
async function sendSlotToLibrary(slot) {
  const kind = deviceKindForLibrarian();
  if (!device?.isOpen || !kind) {
    status("Connect a device before copying patches into a library.", true);
    return;
  }
  // Dropping onto an empty panel is the natural way to start a library, so
  // create one for the connected device rather than refusing the drop.
  if (!patchLib) {
    setOpenLibrary(createLibrary(kind), { filePath: null, fileName: null });
    // A drop-created library is real work, so it becomes the memory - but
    // only once it holds a patch; setOpenLibrary remembered the empty shell,
    // so forget it here and let the first appended patch re-remember.
    clearLastLibraryForDevice(appStorage(), deviceKeyForAutoReopenNow());
    markLibraryDirty(true);
    status(`Started a new ${labelForDeviceKind(kind)} library from the dropped patch.`);
  }
  if (patchLib.deviceKind !== kind) {
    status(`This library holds ${labelForDeviceKind(patchLib.deviceKind)} patches, but a ${labelForDeviceKind(kind)} is connected.`, true);
    return;
  }
  status(`Reading ${slotDisplayName(slot)}…`);
  const bytes = await readSlotBytes(slot);
  if (!hasStashableBytes(bytes)) {
    status(`Could not read ${slotDisplayName(slot)}.`, true);
    return;
  }
  const info = await describeSlotBytes(slot, bytes);
  patchLib.patches.push(entryFromBytes({ ...info, slotHint: slot, bytes }));
  markLibraryDirty(true);
  renderPatchLibrary();
  // A patch added to a remembered library keeps the memory fresh; a patch
  // added to a drop-created shell first makes it worth remembering.
  rememberOpenLibrary();
  status(`Added "${info.name}" to the library. Save it to keep it permanently.`);
}

/** Device rows are drag sources (to the library) + drop targets (from it). */
function wireDeviceSlotDrag(li, slot) {
  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData(DRAG_DEVICE_PATCH, JSON.stringify({ slot }));
    e.dataTransfer.effectAllowed = "copy";
  });
  li.title = "Drag to the patch library to store it, or drop a library patch here";
}

function wireSlotDropTarget(li, slot) {
  li.addEventListener("dragover", (e) => {
    if (!librarianReady()) return;
    if (!e.dataTransfer.types.includes(DRAG_LIBRARY_PATCH)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    li.classList.add("drop-target");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
  li.addEventListener("drop", (e) => {
    li.classList.remove("drop-target");
    if (!e.dataTransfer.types.includes(DRAG_LIBRARY_PATCH)) return;
    e.preventDefault();
    try {
      const { id } = JSON.parse(e.dataTransfer.getData(DRAG_LIBRARY_PATCH));
      dropLibraryEntryOnSlot(id, slot);
    } catch (err) { /* malformed drag, ignore */ }
  });
  // Clickable fallback for touch/keyboard: shift-click sends the slot to the library.
  li.addEventListener("dblclick", (e) => {
    if (!patchLib || !librarianReady()) return;
    if (e.shiftKey) sendSlotToLibrary(slot);
  });
}

let librarianWired = false;

function wireLibrarianDropTargets() {
  if (librarianWired) return;
  librarianWired = true;
  if (!els.patchLibraryList || !els.patchLibrary || !els.panelHead) return;
  for (const target of [els.patchLibraryList, els.patchLibrary]) {
    target.addEventListener("dragover", (e) => {
      if (!device?.isOpen) return;
      if (!e.dataTransfer.types.includes(DRAG_DEVICE_PATCH)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    target.addEventListener("drop", (e) => {
      if (!e.dataTransfer.types.includes(DRAG_DEVICE_PATCH)) return;
      e.preventDefault();
      try {
        const { slot } = JSON.parse(e.dataTransfer.getData(DRAG_DEVICE_PATCH));
        if (Number.isInteger(slot)) sendSlotToLibrary(slot);
      } catch (err) { /* malformed drag, ignore */ }
    });
  }
  // POD edit buffer: dropping a library patch on the panel head auditions it.
  els.panelHead.addEventListener("dragover", (e) => {
    if (!librarianReady() || profile?.layout !== "fixed-panel") return;
    if (!e.dataTransfer.types.includes(DRAG_LIBRARY_PATCH)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    els.panelHead.classList.add("drop-target");
  });
  els.panelHead.addEventListener("dragleave", () => els.panelHead.classList.remove("drop-target"));
  els.panelHead.addEventListener("drop", (e) => {
    els.panelHead.classList.remove("drop-target");
    if (!e.dataTransfer.types.includes(DRAG_LIBRARY_PATCH)) return;
    e.preventDefault();
    try {
      const { id } = JSON.parse(e.dataTransfer.getData(DRAG_LIBRARY_PATCH));
      auditionLibraryEntry(id);
    } catch (err) { /* malformed drag, ignore */ }
  });
}

async function auditionLibraryEntry(entryId) {
  if (!librarianReady()) return;
  const entry = patchLib.patches.find((e) => e.id === entryId)
    ?? patchStash.find((e) => e.id === entryId);
  if (!entry) return;
  let bytes;
  try {
    bytes = entryToBytes(entry);
  } catch (e) {
    status(`"${entry.name}" is corrupt and cannot be auditioned.`, true);
    return;
  }
  const ok = await auditionBytes(bytes);
  status(ok ? `Auditioning "${entry.name}" in the edit buffer.` : `Could not audition "${entry.name}".`, !ok);
}

const LIBRARY_FILTERS = [{ name: "Patch Library", extensions: [LIBRARY_EXTENSION] }];

function resetLibrarianForDevice() {
  patchLib = null;
  patchLibFilePath = null;
  patchLibFileName = null;
  patchLibDirty = false;
  patchStash = [];
  if (els.patchLibraryList) els.patchLibraryList.innerHTML = "";
  if (els.patchStashList) els.patchStashList.innerHTML = "";
  renderLibraryHeader();
  updateLibrarianVisibility();
}

/**
 * Single funnel for "this library is now open": sets state, clears the
 * stash, repaints, and remembers it as this pedal's last library.
 * Every opener (picker, auto-reopen, drop-created) goes through here so the
 * memory can never drift from what is on screen.
 */
function setOpenLibrary(library, { filePath = null, fileName = null } = {}) {
  patchLib = library;
  patchLibFilePath = filePath;
  patchLibFileName = fileName;
  patchStash = [];
  markLibraryDirty(false);
  renderPatchLibrary();
  updateLibrarianVisibility();
  rememberOpenLibrary();
}

function newLibrary() {
  const kind = deviceKindForLibrarian();
  if (!kind) {
    status("Connect a device first - libraries hold patches for one device family.", true);
    return;
  }
  if (!confirmLibrarianDiscard()) return;
  patchLib = createLibrary(kind);
  patchLibFilePath = null;
  patchLibFileName = null;
  patchStash = [];
  markLibraryDirty(false);
  renderPatchLibrary();
  updateLibrarianVisibility();
  // Plan A: an untitled empty library is not worth reopening, so it clears
  // this pedal's memory instead of becoming it.
  clearLastLibraryForDevice(appStorage(), deviceKeyForAutoReopenNow());
  status(`New ${labelForDeviceKind(kind)} library. Drag patches here to store them.`);
}

async function openLibrary() {
  const kind = deviceKindForLibrarian();
  if (!kind) {
    status("Connect a device first - libraries hold patches for one device family.", true);
    return;
  }
  if (!confirmLibrarianDiscard()) return;
  const result = await window.fileAPI.openFile({ filters: LIBRARY_FILTERS });
  if (result.canceled) return;
  const text = typeof result.data === "string" ? result.data : new TextDecoder().decode(result.data);
  const parsed = parseLibrary(text, { expectedDeviceKind: kind });
  if (!parsed.ok) {
    status(`Could not open library: ${parsed.error}.`, true);
    return;
  }
  setOpenLibrary(parsed.library, {
    filePath: result.filePath ?? null,
    fileName: (result.filePath ?? "library").split(/[\\/]/).pop(),
  });
  const skipNote = parsed.skipped ? ` (${parsed.skipped} corrupt ${parsed.skipped === 1 ? "entry" : "entries"} skipped)` : "";
  status(`Opened ${patchLib.patches.length} patches${skipNote}.`);
}

/**
 * Writes the library to disk.
 * @returns true only when a save actually completed, so the desktop close
 *          prompt knows whether it may quit.
 */
async function saveLibrary(saveAs = false) {
  if (!patchLib) return false;
  // Both shells go through a picker, which is what makes "Save" a safe offer
  // from a close prompt. Electron pre-fills it with the last path (or a
  // suggested name on Save As); the browser has no paths and downloads under
  // the file name instead.
  const defaultPath = saveAs || !patchLibFilePath
    ? (patchLibFileName ?? suggestedLibraryFileName(patchLib.deviceKind))
    : patchLibFilePath;
  const result = await window.fileAPI.saveFile({ defaultPath, data: serializeLibrary(patchLib) });
  if (result.canceled) return false;
  patchLibFilePath = result.filePath ?? null;
  patchLibFileName = (result.filePath ?? defaultPath).split(/[\\/]/).pop();
  markLibraryDirty(false);
  // A completed save is the freshest possible memory of this library.
  rememberOpenLibrary();
  renderPatchLibrary();
  status(`Library saved (${patchLib.patches.length} patches).`);
  return true;
}

function closeLibrary() {
  if (!patchLib) return;
  if (!confirmLibrarianDiscard()) return;
  resetLibrarianForDevice();
  status("Library closed. The stash was wiped.");
}

function wireLibrarianButtons() {
  if (wireLibrarianButtons.done) return;
  wireLibrarianButtons.done = true;
  if (!els.btnLibNew) return;
  els.btnLibNew.addEventListener("click", newLibrary);
  els.btnLibOpen.addEventListener("click", openLibrary);
  els.btnLibSave.addEventListener("click", () => saveLibrary(false));
  els.btnLibSaveAs.addEventListener("click", () => saveLibrary(true));
  els.btnLibClose.addEventListener("click", closeLibrary);
  // Persistent auto-reopen toggle: its state IS the setting, shared by both
  // shells via localStorage. Placed here (not an options window) so the
  // control lives where it acts and accidental flips are immediately visible.
  if (els.libAutoReopen) {
    els.libAutoReopen.checked = libAutoReopen;
    els.libAutoReopen.addEventListener("change", () => {
      libAutoReopen = els.libAutoReopen.checked;
      saveAutoReopenSetting(appStorage(), libAutoReopen);
      status(libAutoReopen
        ? "Auto-reopen on: this pedal's last library will reopen on connect."
        : "Auto-reopen off: connecting will no longer reopen a library.");
    });
  }
  // Knob-only wheel polarity (see controls.js): natural-scroll touchpads flip
  // the sign the page sees, so this compensates without touching scrolling
  // anywhere else - no global wheel listener exists or is planned.
  if (els.knobReverseWheel) {
    els.knobReverseWheel.checked = knobReverseWheelOn;
    els.knobReverseWheel.addEventListener("change", () => {
      knobReverseWheelOn = els.knobReverseWheel.checked;
      setKnobReverseWheel(knobReverseWheelOn);
      saveKnobReverseWheel(appStorage(), knobReverseWheelOn);
      status(knobReverseWheelOn
        ? "Knob scroll reversed: touchpad-natural direction on knobs."
        : "Knob scroll normal: wheel-up turns knobs up.");
    });
  }
  // Closing the window with unsaved library work: the desktop shell intercepts
  // the unload in the main process and shows a native dialog offering to save
  // (see electron/main.js). It asks for the save through this bridge, and only
  // a completed write lets the window go.
  const closeGuard = window.closeGuardAPI;
  if (closeGuard) {
    closeGuard.onSaveAndQuit(async () => {
      // A throw here would leave the main process waiting for a reply that
      // never comes, and the window would stay open with no explanation -
      // which is safe but silent, so answer either way.
      let saved;
      try {
        saved = patchLib ? await saveLibrary(false) : true;
      } catch (e) {
        status(`Could not save the library: ${e.message}`, true);
        saved = false;
      }
      // A completed save is not by itself permission to quit: the stash is
      // memory-only by design and so is never in the file. If patches are
      // still displaced, stay open and say why rather than throw them away
      // after the user asked to save.
      if (saved && hasPendingWork(patchLibDirty, patchStash)) {
        status("Library saved, but the displaced patches above are still unsaved - Keep or discard them, then close again.", true);
      }
      await closeGuard.finishSaveAndQuit(saved && !hasPendingWork(patchLibDirty, patchStash));
    });
  }
  // Browsers have a prompt of their own for this and give no control over its
  // text or buttons, so it is the whole mechanism there - which is why this
  // cancellation must stay in place for the web build too.
  window.addEventListener("beforeunload", (e) => {
    if (patchLib && hasPendingWork(patchLibDirty, patchStash)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

function confirmLibrarianDiscard() {
  if (!patchLib) return true;
  if (!hasPendingWork(patchLibDirty, patchStash)) return true;
  const summary = pendingWorkSummary(patchLibDirty, patchStash);
  return window.confirm(`The library has ${summary} that will be lost. Close anyway?`);
}

/** A control change arrived from the pedal - move the matching control. */
function updatePanelControlFromDevice(ccNumber, value) {
  const handle = panelControls.get(ccNumber);
  if (!handle) return;
  handle.setValue(value);
}

/** Forget every panel value (used when the device is closed). */
function resetPanel() {
  for (const handle of panelControls.values()) handle.setUnset?.();
  panelControls.clear();
}

// --- Transport: sync / save / load / backup --------------------------------

async function syncToPedal() {
  if (profile?.layout === "fixed-panel") return syncPanelToPedal();
  if (!device?.currentPatch) return;
  status("Syncing to pedal…");
  try {
    device.uploadPatchToCurrentPatch(device.currentPatch);
    status("Synced.");
  } catch (e) {
    status("Sync failed: " + e.message, true);
  }
}

/**
 * "Sync to Pedal" for a fixed-panel device.
 *
 * There is no patch blob to upload over CC, so this replays the panel as
 * control changes instead. Only controls the app has actually learned a value
 * for are sent - sending made-up defaults would silently zero the pedal's
 * knobs, which is worse than doing nothing.
 */
function syncPanelToPedal() {
  if (!device?.isOpen) return;
  const known = [...panelControls.entries()].filter(([, handle]) => !handle.el.classList.contains("unset"));
  if (known.length === 0) {
    status("Nothing to send yet - move a control here, or turn one on the pedal so the panel learns its value.", true);
    return;
  }
  for (const [ccNumber, handle] of known) device.setParameter(ccNumber, handle.getValue());
  status(`Sent ${known.length} of ${panelControls.size} controls to the pedal.`);
}

function patchToBytes(patch) {
  // Clone the patch if it's frozen (e.g., from device.patchList) to avoid
  // "Cannot assign to read only property" errors in buildPTCFChunk/buildMSDataBuffer
  const p = Object.isFrozen(patch) ? patch.clone() : patch;
  return p.PTCF !== null ? p.buildPTCFChunk(device.ptcfNameLength) : p.buildMSDataBuffer();
}

// --- Bass POD Pro patch files ---------------------------------------------
//
// A POD program is saved as a .syx file holding one complete sys-ex dump
// message: the same bytes the pedal sends, so any tool that speaks the Line 6
// format can read them. Raw 80-byte programs are accepted on the way back in
// too, because that is what the PDF's PROGRAM DATA table describes.

const POD_PATCH_FILTERS = [{ name: "Bass POD Pro Program", extensions: ["syx"] }];

function podProgramVersion() {
  return profileData?.sysexLayout?.version ?? 1;
}

/** The dump message to write to disk for the program currently on screen. */
function currentPodDumpMessage() {
  const bytes = device?.currentProgramBytes;
  if (!bytes) return undefined;
  const slot = device.activeProgramNumber;
  return slot === null || slot === undefined
    ? buildEditBufferDump(bytes, podProgramVersion())
    : buildProgramDump(slot, bytes, podProgramVersion());
}

/**
 * Pulls the 80 program bytes out of a file the user picked: either a raw
 * 80-byte program, or a .syx file carrying one full dump message.
 * @returns Uint8Array|undefined
 */
function podProgramFromFileData(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? []);
  if (bytes.length === PROGRAM_BYTE_COUNT) return bytes;
  const parsed = parseDumpMessage(bytes);
  if (parsed && isDecodableDump(parsed) && parsed.byteCount >= PROGRAM_BYTE_COUNT) {
    return parsed.bytes.slice(0, PROGRAM_BYTE_COUNT);
  }
  return undefined;
}

/** Turns a patch/program name into something safe to use as a file name. */
function safeFileName(name, fallback) {
  return (name || fallback).trim().replace(/[^\w.-]+/g, "_") || fallback;
}

async function savePodProgram() {
  const dump = currentPodDumpMessage();
  if (!dump) {
    status("No program loaded yet - click one in the list, or wait for the POD to answer.", true);
    return;
  }
  const result = await window.fileAPI.saveFile({
    defaultPath: `${safeFileName(device.currentProgramName, "program")}.syx`,
    data: dump,
    binary: true,
    filters: POD_PATCH_FILTERS,
  });
  if (!result.canceled) status(`Saved to ${result.filePath}`);
}

async function loadPodProgram() {
  const result = await window.fileAPI.openFile({ binary: true, filters: POD_PATCH_FILTERS });
  if (result.canceled) return;
  const bytes = podProgramFromFileData(result.data);
  if (!bytes) {
    status("That file is not a Bass POD Pro program dump.", true);
    return;
  }
  // The adapter fires programLoaded, which repaints the panel and the name box.
  const ok = await device.uploadEditBuffer(bytes);
  status(ok ? `Loaded ${result.filePath} into the POD's edit buffer.` : "Could not send the program to the POD.", !ok);
}

async function backupPodPrograms(dirResult, { skipSet } = {}) {
  status("Backing up all programs…");
  // One all-programs dump carries every name and every byte; per-slot reads
  // would work too but take 36 round trips for the same data.
  const reply = await device.requestProgramNames();
  const programs = reply ?? (device.programs.length > 0 ? device.programs : undefined);
  if (!programs || programs.length === 0) {
    status("The POD didn't send its program list - check that its MIDI channel matches the app's.", true);
    return;
  }
  const blobs = device.storedProgramBytes;
  const version = podProgramVersion();
  let saved = 0;
  for (let i = 0; i < programs.length; i++) {
    const bytes = blobs[i];
    if (!bytes) continue;
    status(`Backing up [${i + 1}/${programs.length}]…`);
    const program = programs[i];
    const fileName = `${safeFileName(program.label, String(i))}_${safeFileName(program.name, `program_${i}`)}.syx`;
    if (skipSet?.has(fileName)) continue;
    const data = buildProgramDump(i, bytes, version);
    // dirResult is null where there is no folder picker (Firefox/Safari) -
    // download each program instead so backup still works there.
    if (dirResult) {
      await window.fileAPI.writeFileInDir({
        dirPath: dirResult.dirPath,
        fileName,
        data,
        binary: true,
      });
    } else {
      await window.fileAPI.saveFile({ defaultPath: fileName, data, binary: true });
    }
    saved++;
  }
  if (!dirResult) {
    status(`Downloaded ${saved} programs - check your downloads folder.`);
  }
  return saved;
}

async function restorePodProgramToSlot(slot) {
  const result = await window.fileAPI.openFile({ binary: true, filters: POD_PATCH_FILTERS });
  if (result.canceled) return;
  const bytes = podProgramFromFileData(result.data);
  if (!bytes) {
    status("That file is not a Bass POD Pro program dump.", true);
    return;
  }
  const label = device.programLabelFor(device.programChangeFor(slot)) ?? `program ${slot + 1}`;
  status(`Restoring to ${label}…`);
  const stored = await device.uploadProgramToSlot(slot, bytes);
  if (!stored) {
    status(`Failed to restore to ${label}.`, true);
    return;
  }
  // Show it as well as store it, the same way the Zoom side does.
  await device.uploadEditBuffer(bytes, { keepActiveProgram: true });
  device.activeProgramNumber = slot;
  status(`Restored to ${label}.`);
}

/**
 * Renaming on the POD: the name lives in bytes 64-79 of the program, so it can
 * only be sent as a program dump - control changes cannot carry it. The new
 * name is written into the copy of the program the adapter holds, then the whole
 * program is pushed back: to the slot it belongs to (so the rename survives
 * re-selecting it) and to the edit buffer (so the POD shows it now).
 */
async function renamePodProgram() {
  if (!device?.isOpen || !device.currentProgramBytes) return;
  device.renameCurrentProgram(els.patchName.value);
  const name = device.currentProgramName;
  const slot = device.activeProgramNumber;
  const keepSlot = slot !== null && slot !== undefined;
  if (keepSlot) await device.uploadProgramToSlot(slot, device.currentProgramBytes);
  await device.uploadEditBuffer(device.currentProgramBytes, { keepActiveProgram: keepSlot });
  if (keepSlot) {
    const label = device.programLabelFor(device.programChangeFor(slot)) ?? `program ${slot + 1}`;
    status(`Renamed ${label} to "${name}".`);
  } else {
    status(`Renamed the edit buffer to "${name}" - pick a program slot and use Restore to Slot to store it.`);
  }
}

async function savePatch() {
  if (profile?.layout === "fixed-panel") return savePodProgram();
  if (!device?.currentPatch) return;
  const data = patchToBytes(device.currentPatch);
  if (!data) { status("Could not serialize this patch.", true); return; }
  const name = safeFileName(device.currentPatch.name, "patch");
  const result = await window.fileAPI.saveFile({
    defaultPath: `${name}.zpatch`,
    data,
    binary: true,
    filters: [{ name: "Zoom Patch", extensions: ["zpatch"] }],
  });
  if (!result.canceled) status(`Saved to ${result.filePath}`);
}

async function loadPatch() {
  if (!device) return;
  if (profile?.layout === "fixed-panel") return loadPodProgram();
  const result = await window.fileAPI.openFile({
    binary: true,
    filters: [{ name: "Zoom Patch", extensions: ["zpatch"] }],
  });
  if (result.canceled) return;
  try {
    const { ZoomPatch } = await import("./lib/ZoomPatch.js");
    const patch = ZoomPatch.fromPatchData(result.data);
    device.uploadPatchToCurrentPatch(patch);
    status(`Loaded ${result.filePath}`);
  } catch (e) {
    status("Could not load that file: " + e.message, true);
  }
}

async function backupAll() {
  if (!device) return;
  // Browsers without the File System Access API (Firefox/Safari) have no
  // folder picker - web/file-api.js reports openDirectory as canceled there.
  // Fall back to downloading the files one by one instead of failing.
  const dirResult = await window.fileAPI.openDirectory();
  const useDir = !dirResult.canceled;

  // Filenames embed the patch/program name, so without a check a same-named
  // file already in the folder would be silently overwritten. Compute the
  // planned names first (names only, cheap reads), intersect with the folder,
  // and ask before any bytes are written. The no-picker fallback downloads
  // into Downloads, where the browser's own dedup applies, so it skips this
  // check entirely.
  let skipSet = null;
  let skippedCount = 0;
  if (useDir) {
    const planned = await plannedBackupFileNames();
    const existing = await listBackupDir(dirResult);
    const collisions = findBackupCollisions(planned, existing);
    if (collisions.length > 0) {
      const choice = await askBackupCollision(collisions);
      if (choice === BACKUP_CANCEL) {
        status("Backup canceled - nothing was written.");
        return;
      }
      if (choice === BACKUP_SKIP) {
        skippedCount = collisions.length;
        skipSet = new Set(collisions);
      }
    }
  }

  if (profile?.layout === "fixed-panel") {
    try {
      const wrote = await backupPodPrograms(useDir ? dirResult : null, { skipSet });
      if (useDir) status(backupSkipSummary(wrote, skippedCount));
    } catch (e) {
      status("Backup failed: " + e.message, true);
    }
    return;
  }

  status("Backing up all patches…");
  try {
    await device.updatePatchListFromPedal();
    const patches = device.patchList;
    if (!patches) {
      status("Backup is only available after the patch list loads.", true);
      return;
    }
    let saved = 0;
    for (let i = 0; i < patches.length; i++) {
      status(`Backing up [${i + 1}/${patches.length}]…`);
      const patch = patches[i] ?? (await device.downloadPatchFromMemorySlot(i));
      if (!patch) continue;
      const data = patchToBytes(patch);
      if (!data) continue;
      const name = safeFileName(patch.name, `patch_${i}`);
      const fileName = `${String(i).padStart(2, "0")}_${name}.zpatch`;
      if (skipSet?.has(fileName)) continue;
      if (useDir) {
        await window.fileAPI.writeFileInDir({
          dirPath: dirResult.dirPath,
          fileName,
          data,
          binary: true,
        });
      } else {
        await window.fileAPI.saveFile({ defaultPath: fileName, data, binary: true });
      }
      saved++;
    }
    status(useDir
      ? backupSkipSummary(saved, skippedCount)
      : `Downloaded ${patches.length} patches - check your downloads folder.`);
  } catch (e) {
    status("Backup failed: " + e.message, true);
  }
}

/**
 * File names this backup is about to write, with minimal pedal traffic: Zoom
 * names come from the already-loaded patch list (no reads at all), POD names
 * from one all-programs dump - the same dump the backup itself performs, so
 * the check costs no extra traffic beyond what backing up already does.
 */
async function plannedBackupFileNames() {
  if (profile?.layout === "fixed-panel") {
    const programs = await device.requestProgramNames();
    const list = programs ?? device.programs;
    return list.map((program, i) =>
      `${safeFileName(program.label, String(i))}_${safeFileName(program.name ?? `program_${i}`, `program_${i}`)}.syx`);
  }
  const patches = device.patchList ?? [];
  return patches.map((patch, i) => {
    const name = safeFileName(patch?.name, `patch_${i}`);
    return `${String(i).padStart(2, "0")}_${name}.zpatch`;
  });
}

/** Names already in the picked folder; [] when the shell cannot list it. */
async function listBackupDir(dirResult) {
  try {
    if (typeof dirResult.dirPath === "string" && typeof window.fileAPI.listDir === "function") {
      return await window.fileAPI.listDir({ dirPath: dirResult.dirPath });
    }
    if (typeof window.fileAPI.listPickedDir === "function") {
      return await window.fileAPI.listPickedDir({ dirPath: dirResult.dirPath });
    }
  } catch (e) {
    // Unlistable folder: proceed without the check rather than block backup.
  }
  return [];
}

/**
 * Three-way collision question. Resolves BACKUP_OVERWRITE / BACKUP_SKIP /
 * BACKUP_CANCEL; Cancel writes nothing. A modal HTML dialog rather than
 * window.confirm so all three choices fit in one question - confirm() only
 * offers two.
 */
function askBackupCollision(collisions) {
  const shown = collisions.slice(0, 5).join(", ");
  const more = collisions.length > 5 ? ` and ${collisions.length - 5} more` : "";
  if (els.backupCollisionText) {
    els.backupCollisionText.textContent =
      `${collisions.length} ${collisions.length === 1 ? "file" : "files"} from this backup ` +
      `(${shown}${more}) ${collisions.length === 1 ? "is" : "are"} already in the folder. ` +
      `Overwrite replaces them; Skip backs up only the new files.`;
  }
  if (!els.backupCollision || !els.btnCollisionOverwrite) {
    return Promise.resolve(BACKUP_OVERWRITE); // no dialog chrome: keep old behavior
  }
  return new Promise((resolve) => {
    const done = (choice) => {
      els.backupCollision.classList.add("hidden");
      els.btnCollisionOverwrite.removeEventListener("click", onOverwrite);
      els.btnCollisionSkip.removeEventListener("click", onSkip);
      els.btnCollisionCancel.removeEventListener("click", onCancel);
      resolve(choice);
    };
    const onOverwrite = () => done(BACKUP_OVERWRITE);
    const onSkip = () => done(BACKUP_SKIP);
    const onCancel = () => done(BACKUP_CANCEL);
    els.btnCollisionOverwrite.addEventListener("click", onOverwrite);
    els.btnCollisionSkip.addEventListener("click", onSkip);
    els.btnCollisionCancel.addEventListener("click", onCancel);
    els.backupCollision.classList.remove("hidden");
  });
}

async function restoreToSlot() {
  if (!device || selectedMemorySlot === null) return;
  if (profile?.layout === "fixed-panel") {
    try {
      await restorePodProgramToSlot(selectedMemorySlot);
    } catch (e) {
      status("Could not restore program: " + e.message, true);
    }
    return;
  }
  const result = await window.fileAPI.openFile({
    binary: true,
    filters: [{ name: "Zoom Patch", extensions: ["zpatch"] }],
  });
  if (result.canceled) return;

  status(`Restoring patch to slot ${String(selectedMemorySlot).padStart(2, "0")}…`);
  try {
    const { ZoomPatch } = await import("./lib/ZoomPatch.js");
    const patch = ZoomPatch.fromPatchData(result.data);
    if (!patch) {
      status("Could not parse patch file.", true);
      return;
    }
    const success = await device.uploadPatchToMemorySlot(patch, selectedMemorySlot);
    if (success) {
      device.uploadPatchToCurrentPatch(patch);
      const item = els.patchList.children[selectedMemorySlot];
      if (item) {
        const nameEl = item.querySelector(".p-name");
        if (nameEl) nameEl.textContent = patch.name || "(empty)";
      }
      status(`Restored patch to slot ${String(selectedMemorySlot).padStart(2, "0")}.`);
    } else {
      status(`Failed to restore patch to slot ${String(selectedMemorySlot).padStart(2, "0")}.`, true);
    }
  } catch (e) {
    status("Could not restore patch: " + e.message, true);
  }
}

async function exportLog() {
  try {
    log(LogLevel.Info, "app", "Exporting diagnostic log");
    const text = getLogText();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const result = await window.fileAPI.saveFile({
      defaultPath: `Signal-Chain-log-${stamp}.txt`,
      data: text || "(no log entries captured yet)",
    });
    if (result.canceled) {
      status("Log export cancelled.");
      return;
    }
    status(`Diagnostic log exported${result.filePath ? ` to ${result.filePath}` : ""}.`);
  } catch (e) {
    status("Could not export log: " + e.message, true);
  }
}

function applyLogLevel(key, { announce = true } = {}) {
  if (!(key in LOG_LEVEL_PRESETS)) return;
  logLevelKey = key;
  setLogLevel(LOG_LEVEL_PRESETS[key]);
  saveLogLevel(appStorage(), key);
  if (els.logLevel) els.logLevel.value = key;
  if (announce) {
    const label = LOG_LEVEL_NAMES[LOG_LEVEL_PRESETS[key]] ?? key;
    status(`Log level: ${label}.`);
  }
}

// --- Wire up buttons ---------------------------------------------------

els.btnConnect.addEventListener("click", connect);
wireLibrarianDropTargets();
wireLibrarianButtons();
els.btnSync.addEventListener("click", syncToPedal);
els.btnRestore.addEventListener("click", restoreToSlot);
els.btnSave.addEventListener("click", savePatch);
els.btnLoad.addEventListener("click", loadPatch);
els.btnBackup.addEventListener("click", backupAll);
els.btnExportLog.addEventListener("click", exportLog);
if (els.logLevel) {
  els.logLevel.value = logLevelKey;
  els.logLevel.addEventListener("change", () => applyLogLevel(els.logLevel.value));
}

// Set up the chain as a drop zone for the effect library
setupChainDropZone();

els.patchName.addEventListener("change", async () => {
  if (profile?.layout === "fixed-panel") {
    await renamePodProgram();
    return;
  }
  if (!device?.currentPatch) return;
  device.currentPatch.name = els.patchName.value;
  // Name edits are sent character-by-character on real hardware (see the
  // "Name edited" message in zoom-explorer's protocol notes) - not wired
  // up yet. For now this updates the local patch object; use Sync to
  // Pedal to push the whole patch, name included.
});

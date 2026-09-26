import { iconSvgFor, categorize } from "./effect-icons.js";
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
  setKnobVisual,
  wireKnobDrag,
} from "./ui/controls.js";

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
  panelWrap: el("panel-wrap"),
  panelModel: el("panel-model"),
  panelProgram: el("panel-program"),
  panelNote: el("panel-note"),
  panelGroups: el("panel-groups"),
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
    effectMap = await res.json();
  } catch (e) {
    status("Could not load effect map: " + e.message, true);
  }
}

function effectInfo(id) {
  const key = (id >>> 0).toString(16).padStart(8, "0");
  return effectMap[key] || null;
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
    dev.addTempoChangedListener((d, tempo) => { els.patchTempo.textContent = tempo; });
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
    li.innerHTML = `<span class="p-num">${String(i).padStart(2, "0")}</span>` +
      `<span class="p-name">${escapeHtml(patch?.name || "(empty)")}</span>`;
    li.addEventListener("click", () => selectPatchFromList(i, li));
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
    li.innerHTML = `<span class="p-num">${escapeHtml(program.label ?? "??")}</span>` +
      `<span class="p-name">${escapeHtml(program.name || "(empty)")}</span>`;
    li.addEventListener("click", () => selectProgramFromList(program.programNumber));
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
      settings.parameters[i] = param.default ?? 0;
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
  for (let paramIndex = 0; paramIndex < paramCount; paramIndex++) {
    const value = eff.parameters[paramIndex];
    const paramInfo = info?.parameters?.[paramIndex];
    const max = paramInfo?.max ?? 127;
    const name = paramInfo?.name ?? `Param ${paramIndex + 1}`;
    const isUndocumented = /^hidden/i.test(name);

    const unit = document.createElement("div");
    unit.className = "knob-unit" + (isUndocumented ? " undocumented" : "");
    unit.title = isUndocumented
      ? "This is a real, controllable parameter that thammer's reverse-engineering found in the sysex protocol, but its actual function was never identified - likely because it's not shown on the pedal's own display either. Safe to experiment with; just know that neither this app nor the pedal can currently tell you what it does."
      : "";
    unit.innerHTML =
      `<div class="knob" data-param="${paramIndex}" data-max="${max}"></div>` +
      `<div class="knob-name">${escapeHtml(name)}</div>` +
      `<div class="knob-value">${escapeHtml(displayValue(paramInfo, value))}</div>`;
    els.detailKnobs.appendChild(unit);

    const knobEl = unit.querySelector(".knob");
    setKnobVisual(knobEl, value, max);
    wireKnobDrag(knobEl, {
      min: 0,
      max,
      getValue: () => device.currentPatch.effectSettings[slot].parameters[paramIndex],
      onChange: (newValue) => {
        unit.querySelector(".knob-value").textContent = displayValue(paramInfo, newValue);
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
  const max = Number(knobEl.dataset.max);
  setKnobVisual(knobEl, value, max);
  const info = device?.currentPatch ? effectInfo(device.currentPatch.effectSettings[selectedSlot].id) : null;
  const paramInfo = info?.parameters?.[paramIndex];
  knobEl.parentElement.querySelector(".knob-value").textContent = displayValue(paramInfo, value);
}

// --- Fixed-panel rendering (Bass POD Pro) ----------------------------------
//
// Unlike the Zoom chain, this panel is data-driven: every control, range and
// value name comes from the device's profile JSON (renderer/data/), so adding
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

async function backupPodPrograms(dirResult) {
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
    await window.fileAPI.writeFileInDir({
      dirPath: dirResult.dirPath,
      fileName: `${safeFileName(program.label, String(i))}_${safeFileName(program.name, `program_${i}`)}.syx`,
      data: buildProgramDump(i, bytes, version),
      binary: true,
    });
    saved++;
  }
  if (saved > 0) status(`Backed up ${saved} programs to ${dirResult.dirPath}`);
  else status("No programs to back up.", true);
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
  const dirResult = await window.fileAPI.openDirectory();
  if (dirResult.canceled) return;

  if (profile?.layout === "fixed-panel") {
    try {
      await backupPodPrograms(dirResult);
    } catch (e) {
      status("Backup failed: " + e.message, true);
    }
    return;
  }

  status("Backing up all patches…");
  try {
    await device.updatePatchListFromPedal();
    const patches = device.patchList;
    for (let i = 0; i < patches.length; i++) {
      status(`Backing up [${i + 1}/${patches.length}]…`);
      const patch = patches[i] ?? (await device.downloadPatchFromMemorySlot(i));
      if (!patch) continue;
      const data = patchToBytes(patch);
      if (!data) continue;
      const name = safeFileName(patch.name, `patch_${i}`);
      await window.fileAPI.writeFileInDir({
        dirPath: dirResult.dirPath,
        fileName: `${String(i).padStart(2, "0")}_${name}.zpatch`,
        data,
        binary: true,
      });
    }
    status(`Backed up ${patches.length} patches to ${dirResult.dirPath}`);
  } catch (e) {
    status("Backup failed: " + e.message, true);
  }
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

// --- Wire up buttons ---------------------------------------------------

els.btnConnect.addEventListener("click", connect);
els.btnSync.addEventListener("click", syncToPedal);
els.btnRestore.addEventListener("click", restoreToSlot);
els.btnSave.addEventListener("click", savePatch);
els.btnLoad.addEventListener("click", loadPatch);
els.btnBackup.addEventListener("click", backupAll);

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

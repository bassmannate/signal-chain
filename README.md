# Signal Chain

A native desktop patch editor for Zoom's MS Plus multistomp pedals
(MS-50G+, MS-60B+; MS-70CDR+ partially - see below), built as an
alternative interface to [zoom-explorer](https://github.com/thammer/zoom-explorer), reusing its
underlying protocol/patch logic under the MIT license. See
`THIRD_PARTY_NOTICES.md` for the attribution details.

It also drives the **Line 6 Bass POD Pro**, which is a different kind of
device entirely - see [Line 6 Bass POD Pro](#line-6-bass-pod-pro) below.

## What it looks like

A "rack unit" aesthetic rather than a generic settings page: the current
patch renders as an actual signal chain - effect modules wired left to
right, like pedals sitting on a board - with real rotary knob controls
instead of sliders.

Devices with a *fixed* signal path (the Bass POD Pro) render as grouped rows
of those same knobs instead, because there is nothing to reorder - what the
panel shows is closer to the pedal's own front panel.

## Setup

```bash
npm install
npm start        # desktop app (Electron)
npm run web      # browser build: http://localhost:8000/web/index.html
```

`npm start` needs Electron; `npm run web` needs only Python 3 and a
Chromium browser (Chrome/Edge - WebMIDI with sysex needs a secure
context, so localhost for local use or HTTPS when hosted, and Firefox /
Safari cannot do MIDI at all). Requires Node.js (for Electron itself, not
for talking to the pedal - all MIDI happens through the Web MIDI API, same as
sym.bios.is in a browser).

## Status - what works and what doesn't yet

- ✅ Connect / auto-identify (via the same `getMIDIDeviceList()` identity-
  request logic that resolved the "which Plus pedal is this" question)
- ✅ Browse and load patches from the pedal's memory
- ✅ View the current patch as a signal chain, select an effect module
- ✅ Adjust parameters with real knob controls (drag up/down)
- ✅ Toggle an effect on/off
- ✅ Sync current patch to the pedal
- ✅ Save/load a single patch to/from a `.zpatch` file (the pedal's own
  binary patch format via `ZoomPatch.buildPTCFChunk()` /
  `fromPatchData()` - not a lossy reinterpretation)
- ✅ Backup every patch on the pedal to a folder of `.zpatch` files
- ✅ Restore a single patch back into a specific memory slot (vs. just
  the edit buffer via Sync)
- ⚠️ MS-70CDR+ effect names/parameter ranges aren't wired in yet - only
  MS-50G+ (model `0x23`) and MS-60B+ (model `0x27`) are mapped in
  `app.js`'s `MODEL_TO_MAPPING_FILE`. The effect mapping JSON for
  MS-70CDR+ is already bundled in `shared/data/` though - it just
  needs that pedal's model number confirmed and added.
- ❌ Patch renaming isn't sent to the pedal live yet (real hardware sends
  name edits character-by-character; this app lets you edit the name box
  and updates the patch, but you still have to hit Sync to push it down)
- ✅ Re-order effects within a patch - drag and drop modules within the
  signal chain to reorder them
- ✅ Add effects from a drag-and-drop library - effect library panel shows
  all effects available on the connected pedal, organized by category;
  drag effects into the chain up to the pedal's maximum (typically 6)
- ✅ Remove effects from the chain - click the × button on each module
  to remove it
- ❌ Offline font loading - `index.html` currently pulls IBM Plex from
  Google Fonts; falls back to system fonts if offline, but for a fully
  offline-capable app the font files should be bundled locally

### Line 6 Bass POD Pro

The POD Pro is not a patch editor in the way the Zoom pedals are: every
front-panel control is mirrored by a plain MIDI control-change message, so
the app drives it live rather than uploading a patch blob. What works today:

- ✅ Identification (the POD answers the same identity request the Zoom
  pedals do, with manufacturer `00 01 0C`, family `02 00`)
- ✅ Amp model (CC 12), cabinet (CC 71) and effect (CC 19) selection
- ✅ Every continuous front-panel control: drive, bass, middle, treble,
  channel volume, compress, effect tweak, FX lo-cut, noise gate, parametric
  EQ (freq/Q/gain) and mid sweep, plus the digital output level and the
  D.I. effects switch
- ✅ The parameters with no knob of their own on the POD: AIR level (in the
  Cabinet section) and the compressor's ratio, attack and release. Those are
  also the ones the POD never *reports* - its documentation marks them
  NO TRANSMIT - so they stay dimmed until a patch dump has been read. The
  ratio's readout names the band the POD displays (2:1, 3.3:1, 8:1, 12:1,
  Inf:1) while the knob still holds the exact stored value: real patches store
  30 and 104, and a five-position control would quietly rewrite those on Sync.
- ✅ Manual, Tuner and the 36 internal programs (1A-9D) via program change
- ✅ The pedal's own knob movements and program changes are reflected back in
  the UI as they happen
- ✅ "Sync to Pedal" replays the panel's settings as control changes
- ✅ Reading a program: the patch list shows all 36 programs with their real
  names (one all-programs sys-ex dump), and clicking one recalls it on the
  POD and reads it back, so the panel shows what the program actually
  contains. Connecting does the same for the program the POD is playing.
- ✅ Following the POD: change program on the pedal itself - footswitches, the
  program knob, or the Manual/Tuner buttons - and the app reads the newly
  selected program and paints it on. The POD announces the change with a
  program change but sends none of the new program's values, so the app has to
  ask for it. Manual and the tuner have no stored program behind them, so the
  panel goes back to "unknown" (dimmed) instead of leaving the last patch on
  screen looking current.
- ✅ Save/Load/Backup/Restore. The POD side of these moves 80-byte programs as
  `.syx` files holding one complete sys-ex dump - the same bytes the pedal
  sends, so the files are readable by any Line 6 tool. **Save** writes the
  program on screen (as a single-program dump when it came from a slot, or an
  edit-buffer dump when it didn't); **Load** reads a file into the edit buffer
  and repaints the panel; **Backup All** reads all 36 programs in one
  all-programs dump and writes one `.syx` per slot named
  `1A_Name.syx`-style; **Restore to Slot** writes a file into the program the
  sidebar points at and shows it too. Raw 80-byte files are accepted on the way
  back in as well.
- ✅ Renaming: the name box in the header is editable for the POD too. The name
  lives in bytes 64-79 of the program, so it can only travel as a program dump -
  control changes cannot carry it. Editing the box writes the new name into the
  copy of the program the app holds, then pushes that program back to its slot
  (so the rename survives re-selecting it) and to the edit buffer (so the POD
  shows it now). With no slot selected, only the edit buffer gets the new name.

  These write paths follow the Line 6 document (`mapping/Bass POD Pro Sysex -
  English .pdf`) and are covered by the byte-level tests, but **have not been
  checked against real hardware yet** - the read side is the only half a POD has
  actually been plugged into.

Two things worth knowing before connecting one:

- The POD Pro has 5-pin DIN MIDI only, so you need a MIDI interface (there's
  no USB-MIDI port). Set the POD's global MIDI Channel to match the app's
  (1 by default) - the POD ignores messages on any other channel.
- Control changes only travel one way: the POD does not report a program's
  settings when it is recalled, so the app cannot see a knob until it is
  moved. It reads programs as sys-ex dumps instead, which is why the panel
  fills in when you connect and when you click a patch in the list.
- A control the dump says nothing about stays dimmed with a "?" rather than
  showing a made-up value, and "Sync to Pedal" only ever sends controls it
  actually knows - it will not zero a knob on the pedal. The noise gate is the
  one control with a caveat: CC 22 is a switch (0-63 off, 64-127 on) and the
  gate's actual amount is a parameter that has no control-change number at all,
  so the dump's on/off bit loads as 64 (on).

The amp, cabinet and effect tables were checked against a dump of a real POD's
36 programs, which is worth a paragraph because it corrected one of them:

- The 16 effects are stored as the "Bass Pod Internal Value" column of the
  EFFECT TYPE PARAMETER TABLE in the PDF, which is *not* the order the POD's
  knob cycles through them (Orange Phase is 0, Bypass is 10, ...).
  `valueTables.effects` is in that order, and the dump agrees: the program
  called "Jaco clean chorus" stores 9, which that table calls Analog Chorus,
  and 26 of the 36 programs store 10 - Bypass.
- The amp and cabinet codes line up the same way, which is how those tables
  were checked: "Jazz Tone" stores the Jazz Tone amp code and its Polytone
  cabinet, "Rock Classic" the Ampeg SVT head and the 8x10 to go with it.
- Continuous parameters are stored in 6 bits while their control-change range
  runs 0-126, so a dump reads back as "stored x 2". That is what makes 126 the
  top of those ranges, and every program in that dump decodes inside it. If a
  knob ever reads back at exactly half what the POD's display shows, that
  conversion is the line to change (`sysexLayout.fields[].scale`).
- Not every parameter is 6-bit, though, and the dump settles which are which:
  the noise gate and the individual compressor parameters are 7-bit and use the
  full 0-127. Attack reaches 127 in that capture and ratio 104, neither of
  which a 6-bit field could hold.

One more thing the hardware made clear: a long dump does not arrive as a single
sys-ex message. The all-programs reply came back as 23 messages of 256 bytes,
where only the first carries the F0 and only the last carries the F7, so the
app stitches them back together before parsing (see `_handleSysex()`).

## To Do
- Verify functionality with other devices. I only have the MS-60B+ to test
  with so other pedals such as the MS-50G+ are all theoretical.
- More identifiable effect icons. Just about all of them are completely generic.
- Bass POD Pro: check the write path against real hardware. Sending a program
  dump back to the POD (`buildProgramDump` / `buildEditBufferDump` /
  `buildAllProgramsDump` in `shared/devices/bassPodProSysex.js`, nibble-encoded
  with the version byte the document asks for) is what Save/Load/Backup/Restore
  and renaming use now, and the byte layouts are pinned by tests - but no POD has
  been plugged in to confirm it accepts an upload, or what it does with one.
- Bass POD Pro: the remaining decoded-but-not-on-the-panel parameters - gate
  threshold (CC 23) and decay (CC 24), wah (CC 4/44/45), volume pedal
  (CC 7/46/47) and D.I. alignment/mix (CC 74/75). They are already in
  `sysexLayout.fields` and already decode from a dump, so each one is a
  profile entry away.
- Bass POD Pro: the compressor's *separate* threshold (program byte 26) has no
  control-change number at all in the Line 6 document, so it can never be set
  from this panel - only read, and only once something shows dump-only values.
  Setting it means writing into the program bytes directly, which the sys-ex
  write path above now makes possible.
- Bass POD Pro: confirm on hardware that the POD announces program changes made
  on its own front panel (the sys-ex PDF says it transmits 0 = Manual, 1-36,
  Tuner = 37; capturing it needs somebody to step on the pedal). The app
  follows those changes when they arrive.

## Tests

```bash
npm test        # same as: node --test test/
```

No MIDI hardware, no Electron and no display needed. The vendored protocol
code in `shared/lib/` is plain ES modules, so `test/bass-pod-pro.test.mjs`
drives the real identity-reply parser and the real CC adapter through a fake
MIDI proxy and asserts the exact bytes on the wire,
`test/bass-pod-pro-sysex.test.mjs` does the same for the dump codec, the
patch-list flow and the write side - renaming a program, the exact upload
messages Save/Load/Backup/Restore send, and the bytes Backup All would write -
and `test/controls.test.mjs` drives the panel widgets through
a minimal DOM stub. `shared/package.json` exists only so the Node test
runner treats `shared/**/*.js` as ES modules - the app itself never reads it.

The dump tests run against real captures in `test/fixtures/`: a Bass POD Pro on
firmware 1.40 answering an identity request and an edit-buffer request (while a
patch named "Eighties" was in its edit buffer), and answering an all-programs
request - which also pins down the chunked delivery, since that reply arrives as
23 messages rather than one. They exist so the byte offsets in `sysexLayout`, the
value tables and the chunk handling are checked against hardware data instead of
against the same document they came from.

## Packaging as a real installable app

`npm run icons` regenerates `assets/icon.{png,ico,icns}` (rack-unit
faceplate in the app's own brass-on-charcoal theme; needs Pillow -
`pip install pillow` - and is checked in, so you only re-run it to change
the artwork).

```bash
npm run pack        # unpacked directory build, quick sanity check
npm run dist:linux  # Signal-Chain-<version>-linux.AppImage in dist/
npm run dist:win    # NSIS installer .exe in dist/ (run on Windows)
npm run dist        # both targets (only works where both toolchains exist)
```

Linux builds run anywhere, including this container. **Windows builds must
run on Windows** (or the `package-win` GitHub Actions job): electron-builder
needs Wine to build an NSIS installer from Linux, and Wine is not installed
here, so `dist:win` on Linux fails by design - push and let CI make the
`.exe`. No code signing is configured, so Windows SmartScreen will warn on
first launch; that goes away only once you buy a certificate and wire its
`CSC_*` secrets into `.github/workflows/build.yml`.

## Screen shots
<img width="1280" height="830" alt="image" src="https://github.com/user-attachments/assets/065c01fc-9e50-417a-95f1-ad5252c607db" />
<img width="1283" height="831" alt="image" src="https://github.com/user-attachments/assets/01d56c86-d339-4e4f-a6a5-a61e30c011e5" />



## Project layout

```
electron/
  main.js            Electron main process (window, MIDI permission, file IPC)
  preload.js         contextBridge - the only path from the Electron UI to files
web/
  index.html         browser entry - same DOM as shared/index.html, plus file-api.js
  file-api.js        window.fileAPI via browser APIs (download / file picker /
                     File System Access); Backup All falls back to downloads
                     where there is no folder picker (Firefox/Safari)
  serve.py           zero-dependency static server (`npm run web`)
shared/              UI + protocol code used by BOTH shells, unchanged
  index.html         Electron entry (no file-api.js - preload provides fileAPI)
  styles.css         original design
  app.js             UI orchestration - picks a device, builds its view
  lib/                zoom-explorer core (MIT, unmodified) - protocol, device
                       model, patch (de)serialization
  data/                effect mapping JSON (MIT, unmodified), plus
                       bass-pod-pro.json - the POD's control map and the byte
                       layout of its 80-byte programs
  devices/             one protocol adapter per device, and profiles.js which
                       decides what a MIDI identity reply means and which view
                       layout that device gets
  devices/bassPodProSysex.js
                       the POD's dump codec: requests, nibble encoding, and
                       program bytes <-> panel values, both directions
  ui/controls.js       knobs/selects/toggles shared by both view layouts
  package.json         {"type": "module"} - for the Node test runner only
test/                  node --test suites (no test dependencies)
test/fixtures/         real hardware captures the dump tests run against
mapping/               the source documents the POD's numbers came from
```

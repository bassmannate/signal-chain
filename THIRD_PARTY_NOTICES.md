# Third-party code

`shared/lib/*.js` and `shared/data/zoom-effect-mappings-*.json` are
copied, unmodified, from Thomas Hammer's
[zoom-explorer](https://github.com/thammer/zoom-explorer) project
(MIT licensed - see `shared/lib/LICENSE`). They provide the MIDI
sysex protocol handling, device discovery, and per-effect parameter data
for the Zoom MS Plus pedal series.

Everything else in this repository - the Electron shell
(`electron/main.js`, `electron/preload.js`), the web shell (`web/`),
the UI (`shared/index.html`, `shared/styles.css`, `shared/app.js`),
and the visual design - is original, written for this project.

This project is not affiliated with Thomas Hammer, sym.bios.is, or Zoom
Corporation. It exists to provide an alternative, native-desktop
interface to the same well-documented, community-reverse-engineered
protocol that sym.bios.is (the original, actively maintained,
web-based tool) already implements excellently. If you just want a
working patch manager today, use sym.bios.is - this project is for
people who specifically want a native app.

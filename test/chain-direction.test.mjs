// Device-aware chain direction (Change 1, Phase 1).
//
//   node --test test/
//
// chainDirectionFor() in devices/profiles.js is the single source of truth
// for which way the effect chain paints: MS Plus pedals flow right to left
// (input jack on the right, like the hardware on a board), everything else
// left to right. profiles.js is original code (not vendored), so it imports
// cleanly under node with no DOM.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CHAIN_DIRECTION_OVERRIDES, chainDirectionFor } from "../shared/devices/profiles.js";

test("MS Plus models paint the chain right to left", () => {
  for (const name of ["MS-50G+", "MS-60B+", "MS-70CDR+", "MS-200D+", "MS-90LP+"]) {
    assert.equal(chainDirectionFor(name), "rtl", name);
  }
  assert.equal(chainDirectionFor("  MS-60B+  "), "rtl", "model names are trimmed");
});

test("every other device defaults to left to right", () => {
  const names = [
    "B1X Four",                        // older pedal - must stay ltr
    "MS-50G", "MS-60B", "MS-70CDR",    // pre-Plus hardware: no trailing +
    "G2/G2X FOUR", "B2 FOUR", "GCE-3",
    "Line 6 Bass POD Pro",
    "52 6E 00 1C 00",                  // unknown model: miditools' hex fallback
    "",
  ];
  for (const name of names) assert.equal(chainDirectionFor(name), "ltr", name);
  assert.equal(chainDirectionFor(null), "ltr", "no device");
  assert.equal(chainDirectionFor(undefined), "ltr", "no device");
});

test("per-model overrides beat the pattern", () => {
  // The escape hatch for future models: an explicit entry always wins.
  CHAIN_DIRECTION_OVERRIDES["MS-60B+"] = "ltr";
  try {
    assert.equal(chainDirectionFor("MS-60B+"), "ltr", "override beats the rtl pattern");
  } finally {
    delete CHAIN_DIRECTION_OVERRIDES["MS-60B+"];
  }
  assert.equal(chainDirectionFor("MS-60B+"), "rtl", "pattern applies again once removed");
});

test("the UI reads direction from one place and tags the chain", () => {
  const app = fs.readFileSync("shared/app.js", "utf8");
  assert.ok(
    app.includes("import { chainDirectionFor, findProfileFor"),
    "app.js imports the single source of truth from profiles.js"
  );
  // Exactly one write site: data-direction only changes through
  // updateChainDirection(), so model checks cannot scatter through the UI.
  const marker = 'setAttribute("data-direction"';
  const writeSites = app.split(marker).length - 1;
  assert.equal(writeSites, 1, `data-direction write sites: ${writeSites}`);
  assert.ok(!app.includes("/^MS-"), "app.js must not carry its own MS model pattern");

  const css = fs.readFileSync("shared/styles.css", "utf8");
  assert.ok(css.includes('#chain[data-direction="rtl"]'), "rtl selector exists");
  assert.ok(css.includes("flex-direction: row-reverse"), "rtl paints via row-reverse");
});

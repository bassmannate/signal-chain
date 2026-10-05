// Application icon packaging: the built icon files must exist, match the
// source artwork, and be fresh - so swapping signal-chain-icon.png without
// running `npm run icons` fails loudly instead of shipping a stale icon.
//
//   node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SOURCE = "assets/signal-chain-icon.png";

function pngDimensions(path) {
  const buf = fs.readFileSync(path);
  assert.ok(buf.subarray(1, 4).toString() === "PNG", `${path} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("packaging icons exist and match the source artwork", () => {
  for (const file of ["assets/icon.png", "assets/icon.ico", "assets/icon.icns"]) {
    assert.ok(fs.existsSync(file), `${file} is missing - run npm run icons`);
  }
  const sourceMtime = fs.statSync(SOURCE).mtimeMs;
  for (const file of ["assets/icon.png", "assets/icon.ico", "assets/icon.icns"]) {
    assert.ok(
      fs.statSync(file).mtimeMs >= sourceMtime - 1000,
      `${file} is older than ${SOURCE} - run npm run icons`
    );
  }
  const dims = pngDimensions("assets/icon.png");
  assert.deepEqual([dims.width, dims.height], [1024, 1024], "icon.png must be 1024x1024");
  const icoSize = fs.statSync("assets/icon.ico").size;
  assert.ok(icoSize > 20000, `icon.ico suspiciously small (${icoSize} bytes)`);
});

test("the icon generator converts the PNG source, not procedural art", () => {
  const script = fs.readFileSync("scripts/generate-icons.py", "utf8");
  assert.ok(
    script.includes("signal-chain-icon.png"),
    "the generator must read the PNG source artwork"
  );
  assert.ok(
    !script.includes("ImageDraw") && !script.includes("rounded_rectangle"),
    "the old procedural faceplate drawing must be gone"
  );
});

// Unit tests for the in-memory diagnostic log (shared/lib/Logger.js).
//
//   node --test test/
//
import test from "node:test";
import assert from "node:assert/strict";
import {
  LogLevel,
  setLogLevel,
  getLogLevel,
  getMaxEntries,
  clearLogEntries,
  log,
  getLogText,
} from "../shared/lib/Logger.js";

function reset() {
  clearLogEntries();
  setLogLevel(LogLevel.All);
}

test("log() stores gated entries that getLogText() formats", () => {
  reset();
  log(LogLevel.Warning, "ZoomDevice", "wobbly pot");
  const text = getLogText();
  assert.match(text, /Warning/);
  assert.match(text, /\[ZoomDevice\] wobbly pot/);
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
});

test("log() respects the current level: filtered-out entries are not stored", () => {
  reset();
  setLogLevel(LogLevel.Warning);
  assert.equal(getLogLevel(), LogLevel.Warning);
  log(LogLevel.Info, "ZoomDevice", "chatty probe");
  log(LogLevel.Warning, "ZoomDevice", "kept warning");
  const text = getLogText();
  assert.ok(!text.includes("chatty probe"), "Info must not be stored at Warning level");
  assert.ok(text.includes("kept warning"), "Warning must be stored at Warning level");
});

test("the ring buffer keeps only the newest MAX_ENTRIES entries", () => {
  reset();
  setLogLevel(LogLevel.All);
  const max = getMaxEntries();
  for (let i = 0; i < max + 25; i++) log(LogLevel.Info, "t", `msg-${i}`);
  const text = getLogText();
  const lines = text.split("\n");
  assert.equal(lines.length, max);
  assert.ok(!text.includes("msg-0"), "oldest entries are evicted");
  assert.ok(text.includes(`msg-${max + 24}`), "newest entries are kept");
});

test("default log level is Warning", async () => {
  // Fresh module state: re-import to observe the initial value without the
  // mutations above leaking in.
  const fresh = await import(`../shared/lib/Logger.js?fresh=${Date.now()}`);
  assert.equal(fresh.getLogLevel(), fresh.LogLevel.Warning);
});

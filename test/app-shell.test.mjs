// Shell-integrity tests for shared/app.js itself.
//
//   node --test test/
//
// Two things are checked, both invisible to a syntax check and painful to
// catch by hand:
//
//  1. Every element id app.js looks up exists in BOTH page shells
//     (shared/index.html for Electron, web/index.html for the browser), and
//     the two shells expose the same id set. That is the mechanic behind the
//     rule "any UI chrome change goes in both files": without it, a control
//     added to one page only works in one of the two builds.
//  2. app.js reaches the end of module initialisation against a minimal DOM,
//     i.e. its top-level button/drop-target wiring does not throw. A missing
//     helper or a bad id reference shows up here instead of in the browser.
//
// Like test/controls.test.mjs this brings its own tiny DOM - no jsdom, no
// browser, no new dependencies.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SHELLS = ["shared/index.html", "web/index.html"];

/** Every id app.js passes to el("..."). */
function idsAppLooksUp() {
  const app = fs.readFileSync("shared/app.js", "utf8");
  return [...new Set([...app.matchAll(/el\("([^"]+)"\)/g)].map((m) => m[1]))];
}

function idsInShell(path) {
  const html = fs.readFileSync(path, "utf8");
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}

test("every id app.js uses exists in both page shells", () => {
  const ids = idsAppLooksUp();
  assert.ok(ids.length > 30, `expected many ids, found ${ids.length}`);
  for (const shell of SHELLS) {
    const have = idsInShell(shell);
    const missing = ids.filter((id) => !have.has(id));
    assert.deepEqual(missing, [], `${shell} is missing: ${missing.join(", ")}`);
  }
});

test("the two page shells expose the same id set", () => {
  const [electron, web] = SHELLS.map(idsInShell);
  const onlyElectron = [...electron].filter((id) => !web.has(id));
  const onlyWeb = [...web].filter((id) => !electron.has(id));
  assert.deepEqual(onlyElectron, [], `shared/index.html only: ${onlyElectron.join(", ")}`);
  assert.deepEqual(onlyWeb, [], `web/index.html only: ${onlyWeb.join(", ")}`);
});

test("the shells differ only in how they load the app", () => {
  // The markup is deliberately duplicated, so the surviving differences must
  // stay the intended ones: module path, web-only file API + viewport meta,
  // and the web-only MIDI requirements note.
  const [electronLines, webLines] = SHELLS.map((p) => fs.readFileSync(p, "utf8").split("\n"));
  const strip = (lines) =>
    lines
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !/^<script|^<meta name="viewport"|^<link rel="stylesheet"|^<p class="muted">Needs a Chromium/.test(l));
  assert.deepEqual(strip(webLines), strip(electronLines));
});

// --- Boot check ---------------------------------------------------------

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { for (const n of names) this.names.add(n); }
  remove(...names) { for (const n of names) this.names.delete(n); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.listeners = new Map();
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.disabled = false;
    this.title = "";
    this.checked = false;
    this.draggable = false;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  append(...kids) { this.children.push(...kids); }
  appendChild(kid) { this.children.push(kid); return kid; }
  remove() {}
  querySelector() { return new FakeElement(); }
  querySelectorAll() { return []; }
  focus() {}
  click() {}
  setAttribute() {}
  getAttribute() { return null; }
  closest() { return null; }
  contains() { return false; }
  /** Listener count for a type - proves the wiring actually ran. */
  listenerCount(type) { return this.listeners.get(type)?.length ?? 0; }
}

const elements = new Map();
function elementFor(id) {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
}

globalThis.document = {
  getElementById: (id) => elementFor(id),
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => new FakeElement(),
  querySelectorAll: () => [],
  body: new FakeElement("body"),
  addEventListener() {},
};
globalThis.window = {
  addEventListener() {},
  confirm: () => true,
  fileAPI: {
    saveFile: async () => ({ canceled: true }),
    openFile: async () => ({ canceled: true }),
    openDirectory: async () => ({ canceled: true }),
    writeFileInDir: async () => ({}),
    listDir: async () => [],
    readFileInDir: async () => ({}),
  },
};
globalThis.navigator = {
  requestMIDIAccess: async () => ({ inputs: new Map(), outputs: new Map() }),
};

// Dynamic so the globals above are installed before app.js runs.
await import("../shared/app.js");

test("app.js initialises and wires the transport and librarian controls", () => {
  for (const id of ["btn-connect", "btn-sync", "btn-restore", "btn-backup", "btn-save", "btn-load"]) {
    assert.equal(elementFor(id).listenerCount("click"), 1, id);
  }
  for (const id of ["btn-lib-new", "btn-lib-open", "btn-lib-save", "btn-lib-save-as", "btn-lib-close"]) {
    assert.equal(elementFor(id).listenerCount("click"), 1, id);
  }
  assert.equal(elementFor("patch-library-list").listenerCount("dragover"), 1,
    "the library accepts dropped device patches");
  assert.equal(elementFor("panel-head").listenerCount("dragover"), 1,
    "the POD edit buffer accepts dropped library patches");
});

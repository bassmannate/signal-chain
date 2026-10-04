// Widget tests for shared/ui/controls.js - the knobs, drop-downs and
// switches shared by the Zoom chain view and the Bass POD Pro fixed panel.
//
//   node --test test/
//
// controls.js is DOM code, so this file brings its own very small DOM: just
// the handful of things the widgets touch (createElement, classList, dataset,
// style.setProperty, addEventListener). No jsdom, no browser, no Electron -
// the repo has no test dependencies and this keeps it that way.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildActionUnit,
  buildKnobUnit,
  buildSelectUnit,
  buildToggleUnit,
  clamp,
  formatByBands,
  isKnobReverseWheel,
  setKnobReverseWheel,
  setKnobVisual,
} from "../shared/ui/controls.js";

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
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = { values: {}, setProperty(key, value) { this.values[key] = String(value); } };
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
  }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  // The widgets set classes both ways - className = "..." and classList.add()
  // - so the two have to stay in step, exactly as they do in a real DOM.
  get className() { return [...this.classList.names].join(" "); }
  set className(value) { this.classList.names = new Set(String(value).split(/\s+/).filter(Boolean)); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  /** Pretend the user did something to this element. */
  fire(type, event = {}) { this.listeners.get(type)?.({ preventDefault() {}, target: this, ...event }); }
  // Only the one innerHTML shape the widgets use: a flat run of empty divs.
  set innerHTML(html) {
    this.children = [];
    for (const match of String(html).matchAll(/<div class="([^"]+)"><\/div>/g)) {
      const child = new FakeElement("div");
      child.classList.add(match[1]);
      this.appendChild(child);
    }
  }
  get innerHTML() { return this.children.map((c) => `<div class="${[...c.classList.names][0]}"></div>`).join(""); }
  querySelectorAll(selector) { return this._walk(selector); }
  querySelector(selector) { return this._walk(selector)[0]; }
  _walk(selector) {
    const className = selector.replace(/^\./, "");
    const found = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.classList.contains(className)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

const fakeWindow = {
  listeners: new Map(),
  addEventListener(type, listener) { this.listeners.set(type, listener); },
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); },
  fire(type, event) { this.listeners.get(type)?.(event); },
};

globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
globalThis.window = fakeWindow;

const AMP_MODELS = Array.from({ length: 16 }, (_, i) => ({ name: `Model ${i}`, modeled: `Amp ${i}` }));


test("knob: the shared arc maths put the middle of the range at 0 degrees", () => {
  const knob = new FakeElement("div");
  setKnobVisual(knob, 0, 126);
  assert.equal(knob.style.values["--pct"], "0.0");
  assert.equal(knob.style.values["--angle"], "-135.0deg");

  setKnobVisual(knob, 63, 126);
  assert.equal(knob.style.values["--pct"], "50.0");
  assert.equal(knob.style.values["--angle"], "0.0deg");

  setKnobVisual(knob, 126, 126);
  assert.equal(knob.style.values["--pct"], "100.0");
  assert.equal(knob.style.values["--angle"], "135.0deg");
});

test("knob: starts dimmed while the pedal's real value is unknown", () => {
  const knob = buildKnobUnit({ label: "Drive", min: 0, max: 126, value: 0, unset: true });
  assert.equal(knob.el.classList.contains("unset"), true, "shown as an unknown value");
  assert.equal(knob.el.querySelector(".knob-name").textContent, "Drive");
  assert.equal(knob.el.querySelector(".knob-value").textContent, "0");
  assert.equal(knob.el.querySelector(".knob").dataset.max, "126");
});

test("knob: dragging up sends increasing values and clamps at the top of the range", () => {
  const sent = [];
  const knob = buildKnobUnit({ label: "Drive", min: 0, max: 126, value: 0, unset: true, onChange: (v) => sent.push(v) });

  knob.knobEl.fire("pointerdown", { clientY: 100 });
  fakeWindow.fire("pointermove", { clientY: 25 }); // 75px of the 150px sweep = half of 126
  fakeWindow.fire("pointermove", { clientY: -1400 }); // far past the top
  fakeWindow.fire("pointerup", {});

  assert.deepEqual(sent, [63, 126]);
  assert.equal(knob.el.classList.contains("unset"), false, "once moved, the value is known");
  assert.equal(knob.el.querySelector(".knob-value").textContent, "126");
});

test("knob: scroll wheel steps the value up and down without dragging", () => {
  const sent = [];
  const knob = buildKnobUnit({ label: "Drive", min: 0, max: 126, value: 60, onChange: (v) => sent.push(v) });
  let prevented = 0;
  const wheel = (deltaY, shiftKey = false) => {
    knob.knobEl.fire("wheel", { deltaY, shiftKey, preventDefault: () => { prevented++; } });
  };

  wheel(-100); // wheel up increases
  wheel(-100);
  wheel(53); // wheel down decreases, odd pixel counts still step once
  assert.deepEqual(sent, [61, 62, 61]);
  assert.equal(prevented, 3, "the page must not scroll underneath the knob");
  assert.equal(knob.el.querySelector(".knob-value").textContent, "61");
});

test("knob: wheel clamps at the ends, ignores flat ticks, and Shift jumps in tens", () => {
  const sent = [];
  const knob = buildKnobUnit({ label: "Gain", min: 0, max: 127, value: 125, onChange: (v) => sent.push(v) });
  const wheel = (deltaY, shiftKey = false) => knob.knobEl.fire("wheel", { deltaY, shiftKey });

  wheel(-300); // line-mode wheels report big deltas; still a single step
  wheel(-100);
  wheel(-100); // past the top: clamped, not wrapped
  assert.deepEqual(sent, [126, 127, 127]);

  const before = sent.length;
  wheel(0); // flat trackpad tick: no value, no send
  assert.equal(sent.length, before);

  wheel(100, true); // Shift+wheel down: coarse jump
  assert.deepEqual(sent.slice(-1), [117]);
});

test("knob: reversed wheel polarity flips the step direction only on knobs", () => {
  assert.equal(isKnobReverseWheel(), false, "default is wheel-up increases");
  const sent = [];
  const knob = buildKnobUnit({ label: "Drive", min: 0, max: 126, value: 60, onChange: (v) => sent.push(v) });
  const wheel = (deltaY, shiftKey = false) => knob.knobEl.fire("wheel", { deltaY, shiftKey });

  setKnobReverseWheel(true);
  try {
    assert.equal(isKnobReverseWheel(), true);
    wheel(-100); // would increase normally; now decreases (touchpad-natural)
    wheel(100, true); // Shift jump follows the same flipped polarity
    assert.deepEqual(sent, [59, 69], "59 then 59+10: polarity flips, magnitude rule unchanged");
  } finally {
    setKnobReverseWheel(false); // other tests assume the default
  }
  assert.equal(isKnobReverseWheel(), false);
  wheel(-100);
  assert.deepEqual(sent.slice(-1), [70], "default polarity restored");
});

test("knob: wheel after a drag continues from the live value", () => {
  const sent = [];
  const knob = buildKnobUnit({ label: "Drive", min: 0, max: 126, value: 0, unset: true, onChange: (v) => sent.push(v) });

  knob.knobEl.fire("pointerdown", { clientY: 100 });
  fakeWindow.fire("pointermove", { clientY: 25 }); // half the 150px sweep = 63
  fakeWindow.fire("pointerup", {});
  knob.knobEl.fire("wheel", { deltaY: -100 });
  assert.deepEqual(sent, [63, 64], "the wheel reads getValue(), not a stale drag start");
});

test("knob: setValue is display-only, setUnset puts it back to unknown", () => {
  const sent = [];
  const knob = buildKnobUnit({ label: "Bass", min: 0, max: 126, value: 0, unset: true, onChange: (v) => sent.push(v) });
  knob.setValue(40);
  assert.equal(knob.el.querySelector(".knob-value").textContent, "40");
  assert.equal(knob.el.classList.contains("unset"), false);
  assert.deepEqual(sent, [], "reporting the pedal's own value must not be echoed back to it");

  knob.setUnset();
  assert.equal(knob.el.classList.contains("unset"), true);
});

test("select: options are indexed by control value, and picking one sends that index", () => {
  const sent = [];
  const select = buildSelectUnit({ label: "Amp Model", options: AMP_MODELS, unset: true, onChange: (v) => sent.push(v) });

  assert.equal(select.selectEl.children.length, 17, "16 models plus the unknown placeholder");
  assert.equal(select.selectEl.value, "", "starts on the placeholder, not on model 0");
  assert.equal(select.selectEl.children[5].textContent, "Model 4 (Amp 4)");
  assert.equal(select.selectEl.children[5].value, "4", "the option's value is the CC value");

  select.selectEl.value = "";
  select.selectEl.fire("change");
  assert.deepEqual(sent, [], "the placeholder is not a value");

  select.selectEl.value = "5";
  select.selectEl.fire("change");
  assert.deepEqual(sent, [5]);
  assert.equal(select.el.classList.contains("unset"), false);

  select.setValue(11);
  assert.deepEqual(sent, [5], "setValue is display-only");
  assert.equal(select.getValue(), 11);
});

test("toggle: reports the on/off values the hardware expects", () => {
  const sent = [];
  const toggle = buildToggleUnit({ label: "Apply FX to D.I.", value: 0, offValue: 0, onValue: 127, unset: true, onChange: (v) => sent.push(v) });
  assert.equal(toggle.inputEl.checked, false);
  assert.equal(toggle.el.classList.contains("unset"), true);

  toggle.inputEl.checked = true;
  toggle.inputEl.fire("change");
  assert.deepEqual(sent, [127]);
  assert.equal(toggle.el.classList.contains("unset"), false);

  toggle.setValue(0);
  assert.equal(toggle.inputEl.checked, false);
  assert.equal(toggle.getValue(), 0);
});

test("action: a button (Manual, Tuner) fires its handler", () => {
  let clicks = 0;
  const action = buildActionUnit({ label: "Tuner", hint: "PC 37", onClick: () => { clicks++; } });
  assert.equal(action.buttonEl.textContent, "Tuner");
  assert.equal(action.el.querySelector(".control-hint").textContent, "PC 37");
  action.buttonEl.fire("click");
  assert.equal(clicks, 1);
});

test("clamp keeps values inside the control's documented range", () => {
  assert.equal(clamp(200, 0, 126), 126);
  assert.equal(clamp(-5, 0, 126), 0);
  assert.equal(clamp(64, 0, 126), 64);
});

test("formatByBands: a banded control names its value the way the hardware shows it", () => {
  const bands = [
    { from: 0, label: "2:1" },
    { from: 25, label: "3.3:1" },
    { from: 50, label: "8:1" },
    { from: 75, label: "12:1" },
    { from: 100, label: "Inf:1" },
  ];
  assert.equal(formatByBands(0, bands), "2:1");
  assert.equal(formatByBands(25, bands), "3.3:1");
  assert.equal(formatByBands(100, bands), "Inf:1");
  assert.equal(formatByBands(127, bands), "Inf:1 (127)", "past the last edge the number stays visible");
  assert.equal(formatByBands(30, bands), "3.3:1 (30)", "a value between two edges is not rounded away");
  assert.equal(formatByBands(24, bands), "2:1 (24)");

  // The order the bands are listed in doesn't matter, and a control with no
  // bands - or a band table that says nothing useful - falls back to the number.
  assert.equal(formatByBands(60, [...bands].reverse()), "8:1 (60)");
  assert.equal(formatByBands(7, undefined), "7");
  assert.equal(formatByBands(7, []), "7");
  assert.equal(formatByBands(7, [{ label: "only" }]), "only (7)", "a band with no 'from' starts at 0");
});

test("knob: a banded control shows the band name, and setValue keeps the exact number", () => {
  const ratio = buildKnobUnit({
    label: "Ratio",
    min: 0,
    max: 127,
    value: 50,
    formatValue: (value) => formatByBands(value, [{ from: 0, label: "2:1" }, { from: 50, label: "8:1" }]),
  });
  assert.equal(ratio.el.querySelector(".knob-value").textContent, "8:1");

  // A patch that stored 30 isn't displayed as the 25 it sits near, and Sync
  // sends back the 30 the patch actually holds.
  ratio.setValue(30);
  assert.equal(ratio.el.querySelector(".knob-value").textContent, "2:1 (30)");
  assert.equal(ratio.getValue(), 30);
});

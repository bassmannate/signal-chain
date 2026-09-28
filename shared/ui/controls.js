// Shared control widgets.
//
// These started life inside app.js as the Zoom chain's knob helpers and were
// moved here so the fixed-panel layout (Bass POD Pro) can use the same rotary
// look and the same drag feel instead of growing a second, slightly different
// knob implementation. The Zoom path is unchanged: same markup, same CSS
// hooks, same drag maths.

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Names a value the way the hardware displays it, using the bands a control
 * declares in its profile entry.
 *
 * The POD's compression ratio is why this exists: one continuous 0-127 control
 * that the pedal shows as 2:1, 3.3:1, 8:1, 12:1 or Inf:1, with a new band
 * starting at 0, 25, 50, 75 and 100. A value that falls between bands keeps its
 * number - a patch that really stores 30 reads "3.3:1 (30)" instead of being
 * rounded to the band start, because the knob sends exactly what it holds.
 *
 * @param value The control's current value
 * @param bands [{ from, label }] - the highest "from" that is <= value wins, so
 *              the order in the profile doesn't matter. A band without "from"
 *              acts as the fallback.
 */
export function formatByBands(value, bands) {
    if (!Array.isArray(bands) || bands.length === 0) return String(value);
    let match;
    for (const band of bands) {
        const from = band.from ?? 0;
        if (value >= from && (match === undefined || from > (match.from ?? 0))) match = band;
    }
    if (!match) return String(value);
    const name = match.label ?? String(value);
    // At a band's own edge the name says everything; inside a band the number
    // stays visible, so a stored value of 30 isn't silently shown as 25.
    return (match.from ?? 0) === value ? name : `${name} (${value})`;
}

/**
 * Positions a knob's arc and pointer.
 * @param min Lowest value the knob can show (0 for everything in this app)
 * @param max Highest value
 */
export function setKnobVisual(knobEl, value, max, min = 0) {
    const span = max - min;
    const fraction = span > 0 ? clamp((value - min) / span, 0, 1) : 0;
    const angle = -135 + (270 * fraction); // -135deg..+135deg sweep
    knobEl.style.setProperty("--pct", (fraction * 100).toFixed(1));
    knobEl.style.setProperty("--angle", `${angle.toFixed(1)}deg`);
}

/**
 * Vertical-drag editing for a knob.
 * @param options {
 *   min, max,          numeric range
 *   getValue(),        current value at drag start
 *   onChange(value),   called for every step of the drag
 *   dragRangePx        how far you drag for a full sweep (default 150)
 * }
 */
export function wireKnobDrag(knobEl, options) {
    const { min = 0, max = 127, getValue, onChange, dragRangePx = 150 } = options;
    let dragging = false;
    let startY = 0;
    let startValue = 0;
    const span = max - min;

    const onMove = (ev) => {
        if (!dragging) return;
        const deltaY = startY - ev.clientY; // dragging up increases value
        const deltaValue = Math.round((deltaY / dragRangePx) * span);
        const newValue = clamp(startValue + deltaValue, min, max);
        setKnobVisual(knobEl, newValue, max, min);
        onChange(newValue);
    };
    const onUp = () => {
        dragging = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
    };

    knobEl.addEventListener("pointerdown", (ev) => {
        dragging = true;
        startY = ev.clientY;
        startValue = getValue();
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    });
}

/**
 * A rotary knob with a name and a value readout, matching the Zoom chain's
 * .knob-unit markup so both layouts share one stylesheet.
 *
 * Starts "unset" when the real hardware value isn't known yet: the knob is
 * dimmed and its readout gets a "?" until either the user moves it or the
 * device reports a CC for it.
 *
 * @returns { el, knobEl, getValue, setValue, setUnset }
 */
export function buildKnobUnit({ label, min = 0, max = 127, value = min, formatValue, onChange, unset = false, title = "" }) {
    const unit = document.createElement("div");
    unit.className = "knob-unit" + (unset ? " unset" : "");
    unit.title = title;
    unit.innerHTML = `<div class="knob"></div><div class="knob-name"></div><div class="knob-value"></div>`;
    const knobEl = unit.querySelector(".knob");
    const valueEl = unit.querySelector(".knob-value");
    unit.querySelector(".knob-name").textContent = label;
    knobEl.dataset.max = String(max);

    let current = clamp(value, min, max);
    const render = () => {
        setKnobVisual(knobEl, current, max, min);
        valueEl.textContent = formatValue ? formatValue(current) : String(current);
    };
    wireKnobDrag(knobEl, {
        min,
        max,
        getValue: () => current,
        onChange: (newValue) => {
            current = newValue;
            unit.classList.remove("unset");
            render();
            onChange?.(newValue);
        },
    });
    render();

    return {
        el: unit,
        knobEl,
        getValue: () => current,
        setValue: (newValue) => {
            current = clamp(newValue, min, max);
            unit.classList.remove("unset");
            render();
        },
        setUnset: () => unit.classList.add("unset"),
    };
}


/**
 * A drop-down for parameters whose values are named rather than numeric
 * (amp model, cabinet, effect). Options are indexed by control value, so the
 * option's position IS the value sent as a CC.
 *
 * @param options Array of { name, modeled? } straight from the profile data
 * @returns { el, getValue, setValue, setUnset }
 */
export function buildSelectUnit({ label, options = [], value = 0, onChange, unset = false, title = "", hint = "" }) {
    const unit = document.createElement("div");
    unit.className = "select-unit" + (unset ? " unset" : "");
    unit.title = title;

    const nameEl = document.createElement("div");
    nameEl.className = "select-name";
    nameEl.textContent = label;
    unit.appendChild(nameEl);

    const select = document.createElement("select");
    select.className = "select-input";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.disabled = true;
    placeholder.textContent = "— not read from the POD yet —";
    select.appendChild(placeholder);
    options.forEach((option, index) => {
        const optionEl = document.createElement("option");
        optionEl.value = String(index);
        optionEl.textContent = option.modeled ? `${option.name} (${option.modeled})` : option.name;
        select.appendChild(optionEl);
    });
    select.value = unset ? "" : String(value);
    unit.appendChild(select);

    if (hint) {
        const hintEl = document.createElement("div");
        hintEl.className = "control-hint";
        hintEl.textContent = hint;
        unit.appendChild(hintEl);
    }

    select.addEventListener("change", () => {
        if (select.value === "") return; // the placeholder isn't a value
        const newValue = Number(select.value);
        unit.classList.remove("unset");
        onChange?.(newValue);
    });

    return {
        el: unit,
        selectEl: select,
        getValue: () => (select.value === "" ? undefined : Number(select.value)),
        setValue: (newValue) => {
            select.value = String(clamp(Math.round(newValue), 0, options.length - 1));
            unit.classList.remove("unset");
        },
        setUnset: () => {
            select.value = "";
            unit.classList.add("unset");
        },
    };
}

/**
 * An on/off switch for a parameter the hardware maps to a CC pair.
 * @returns { el, getValue, setValue, setUnset }
 */
export function buildToggleUnit({ label, value = 0, offValue = 0, onValue = 127, onChange, unset = false, title = "", hint = "" }) {
    const unit = document.createElement("label");
    unit.className = "toggle-unit" + (unset ? " unset" : "");
    unit.title = title;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value >= (offValue + onValue) / 2;
    const text = document.createElement("span");
    text.textContent = label;
    unit.appendChild(input);
    unit.appendChild(text);

    if (hint) {
        const hintEl = document.createElement("div");
        hintEl.className = "control-hint";
        hintEl.textContent = hint;
        unit.appendChild(hintEl);
    }

    input.addEventListener("change", () => {
        unit.classList.remove("unset");
        onChange?.(input.checked ? onValue : offValue);
    });

    return {
        el: unit,
        inputEl: input,
        getValue: () => (input.checked ? onValue : offValue),
        setValue: (newValue) => {
            input.checked = newValue >= (offValue + onValue) / 2;
            unit.classList.remove("unset");
        },
        setUnset: () => unit.classList.add("unset"),
    };
}

/**
 * A momentary button for panel actions that aren't parameters
 * (Manual / Tuner on the POD front panel).
 */
export function buildActionUnit({ label, title = "", hint = "", onClick }) {
    const unit = document.createElement("div");
    unit.className = "action-unit";
    unit.title = title;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = label;
    button.addEventListener("click", () => onClick?.());
    unit.appendChild(button);

    if (hint) {
        const hintEl = document.createElement("div");
        hintEl.className = "control-hint";
        hintEl.textContent = hint;
        unit.appendChild(hintEl);
    }

    return { el: unit, buttonEl: button };
}

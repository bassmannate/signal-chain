/**
 * Procedurally generated, per-effect icons.
 *
 * Rather than one fixed icon per effect subtype (chorus/phaser/etc all
 * looking identical to each other), each effect's icon is generated
 * from:
 *   1. Real facts about that specific effect - its parameter count,
 *      and whether specific parameters exist (Cabinet, Bright, Rate,
 *      Depth, Feedback, etc.) - pulled from the bundled effect mapping
 *      data, not guessed.
 *   2. A deterministic hash of the effect's name, used to vary things
 *      like curvature, spacing, and rotation - so two effects with the
 *      same parameter *shape* still render distinguishably rather than
 *      identically.
 *
 * This is original, generated artwork - explicitly NOT an attempt to
 * recreate the appearance of any real branded product (see the
 * conversation this was built in: recreating e.g. the Ampeg B-15's
 * actual portaflex silhouette would be trade dress territory, not just
 * copyright, so icons vary by generic/functional traits - speaker
 * count, control density - never by brand-specific cosmetic details).
 *
 * The function is pure: the same effect (same id + name + parameters)
 * always renders the same icon. It's not random per render - it's
 * seeded by the effect's own data.
 */

// --- deterministic hash + seeded fractions ---------------------------

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A different, stable pseudo-random fraction (0..1) per (hash, salt) pair -
// lets multiple independent "random" choices be derived from one hash.
function seedFrac(hash, salt) {
  const x = Math.imul(hash ^ salt, 2654435761) >>> 0;
  return ((x >>> 8) % 10000) / 10000;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// --- reading real facts about the effect ------------------------------

function paramCount(info) {
  return info?.parameters?.length ?? 4;
}

function hasParam(info, pattern) {
  return !!info?.parameters?.some((p) => pattern.test(p.name || ""));
}

// --- shape-family generators --------------------------------------------
// Each returns inner SVG markup for a 24x24 viewBox. `hash` seeds the
// continuous variation; the other args are real per-effect facts.

function waveFamily(hash, n, ampBase, style) {
  n = clamp(n, 3, 7);
  const jitter = seedFrac(hash, 1) * 0.6 + 0.7; // 0.7..1.3
  const amp = ampBase * jitter;
  const step = 20 / n;
  let d = `M2 12`;
  for (let i = 0; i < n; i++) {
    const cx = 2 + step * (i + 0.5);
    const dir = i % 2 === 0 ? -1 : 1;
    const localAmp = amp * (0.75 + seedFrac(hash, 10 + i) * 0.5);
    d += ` Q${cx.toFixed(1)} ${(12 + dir * localAmp).toFixed(1)} ${(2 + step * (i + 1)).toFixed(1)} 12`;
  }
  let extra = "";
  if (style === "clipped") {
    extra = `<path d="M3 6h18M3 18h18" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity="0.5"/>`;
  } else if (style === "ceiling") {
    extra = `<path d="M3 5h18" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity="0.6"/>`;
  }
  return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>${extra}`;
}

function jaggedFamily(hash, n) {
  n = clamp(n, 4, 8);
  const step = 20 / n;
  let d = `M2 ${(12 + (seedFrac(hash, 2) - 0.5) * 4).toFixed(1)}`;
  for (let i = 1; i <= n; i++) {
    const y = 12 + (i % 2 === 0 ? -1 : 1) * (5 + seedFrac(hash, 20 + i) * 4);
    d += ` L${(2 + step * i).toFixed(1)} ${y.toFixed(1)}`;
  }
  return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function oscFamily(hash, n, ampScale, voices) {
  n = clamp(n, 3, 6);
  const phaseShift = seedFrac(hash, 29) * 0.6; // shifts the whole wave's starting point
  let out = "";
  for (let v = 0; v < voices; v++) {
    const yOff = v * (2 + seedFrac(hash, 30 + v) * 2);
    const opacity = v === 0 ? 1 : 0.5 - v * 0.15;
    const step = 20 / n;
    let d = `M2 ${(12 + yOff).toFixed(1)}`;
    for (let i = 0; i < n; i++) {
      const cx = 2 + step * (i + 0.5 + phaseShift);
      const dir = i % 2 === 0 ? -1 : 1;
      // Per-hump amplitude jitter from hash - this is what actually
      // varies single-voice waves (the old version only varied yOff,
      // which is zero for voice 0, so single-voice effects with the
      // same param count rendered byte-identical regardless of name).
      const localAmp = ampScale * (0.7 + seedFrac(hash, 35 + i) * 0.6);
      d += ` Q${cx.toFixed(1)} ${(12 + yOff + dir * localAmp).toFixed(1)} ${(2 + step * (i + 1)).toFixed(1)} ${(12 + yOff).toFixed(1)}`;
    }
    out += `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="${opacity.toFixed(2)}"/>`;
  }
  return out;
}

function circleCascade(hash, n, shrinking) {
  n = clamp(n, 2, 5);
  let out = "";
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 0 : i / (n - 1);
    const r = shrinking ? 2.4 - t * 1.1 : 1.3 + t * 1.1;
    const cx = 4 + t * 16 + (seedFrac(hash, 40 + i) - 0.5) * 1.2;
    const op = shrinking ? 1 - t * 0.65 : 0.35 + t * 0.65;
    out += i === 0
      ? `<circle cx="${cx.toFixed(1)}" cy="12" r="${r.toFixed(1)}" fill="currentColor" opacity="${op.toFixed(2)}"/>`
      : `<circle cx="${cx.toFixed(1)}" cy="12" r="${r.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.4" opacity="${op.toFixed(2)}"/>`;
  }
  return out;
}

function reverbArcs(hash, n) {
  n = clamp(n, 2, 5);
  let out = `<circle cx="4" cy="12" r="1.5" fill="currentColor"/>`;
  for (let i = 1; i <= n; i++) {
    const bulge = 2.6 + i * 1.4 + seedFrac(hash, 50 + i) * 1.6;
    const yTop = 12 - bulge / 1.6;
    const op = Math.max(0.15, 0.85 - i * 0.16);
    out += `<path d="M${(2 + i * 2.2).toFixed(1)} ${yTop.toFixed(1)}c${(bulge * 0.5).toFixed(1)} ${(bulge * 0.3).toFixed(1)} ${(bulge * 0.5).toFixed(1)} ${(bulge * 1.3).toFixed(1)} 0 ${(bulge * 1.6).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="${op.toFixed(2)}"/>`;
  }
  return out;
}

function sliderFamily(hash, n) {
  n = clamp(n, 2, 6);
  const step = 20 / (n + 1);
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = 2 + step * (i + 1);
    const dotY = 5 + seedFrac(hash, 60 + i) * 14;
    out += `<path d="M${x.toFixed(1)} 3v18" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.5"/>` +
           `<circle cx="${x.toFixed(1)}" cy="${dotY.toFixed(1)}" r="1.7" fill="currentColor"/>`;
  }
  return out;
}

function ampFamily(hash, speakerCount, wide, format, info) {
  speakerCount = clamp(speakerCount, 1, 8); // was capped at 4 - couldn't represent an 8x10 cab at all
  const rx = 0.5 + seedFrac(hash, 71) * 0.8; // tighter than before - high rounding was reading as "blobby" at small sizes
  const rowMajorSeed = seedFrac(hash, 72);

  function speakerGrid(x0, y0, w, h, count) {
    let out = "";
    const cols = count <= 2 ? count : count <= 4 ? 2 : 4;
    const rows = Math.ceil(count / cols);
    const cellW = w / cols, cellH = h / rows;
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
    if (rowMajorSeed <= 0.5) cells.reverse();
    let i = 0;
    for (const [r, c] of cells) {
      if (i >= count) break;
      const cx = x0 + cellW * (c + 0.5);
      const cy = y0 + cellH * (r + 0.5);
      const rad = Math.min(cellW, cellH) / 2 - 0.6 + seedFrac(hash, 73 + i) * 0.6;
      out += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${Math.max(0.6, rad).toFixed(2)}" fill="none" stroke="currentColor" stroke-width="1.1"/>`;
      i++;
    }
    return out;
  }

  function panel(x0, y0, w, h, knobCount) {
    // a thin control-panel strip with knob dots - used atop cabs/heads
    let out = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="${(rx * 0.6).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.3"/>`;
    const n = clamp(knobCount, 2, 6);
    const step = w / (n + 1);
    for (let i = 0; i < n; i++) {
      const cx = x0 + step * (i + 1);
      const cy = y0 + h / 2;
      out += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(h * 0.22).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1"/>`;
    }
    return out;
  }

  switch (format) {
    case "stack2": { // separate head unit on top of one cabinet below
      const headH = 5.5;
      const bodyW = wide ? 19 : 15, x0 = wide ? 2.5 : 4.5;
      let out = `<rect x="${x0}" y="3" width="${bodyW}" height="${headH}" rx="${(rx * 0.6).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.4"/>`;
      out += panel(x0 + 1, 4, bodyW - 2, headH - 2, clamp(speakerCount + 1, 2, 5));
      out += `<rect x="${x0}" y="${3 + headH + 0.8}" width="${bodyW}" height="${16 - headH}" rx="${rx.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
      out += speakerGrid(x0, 3 + headH + 0.8, bodyW, 16 - headH, speakerCount);
      return out;
    }
    case "stack3": { // head atop two stacked cabinets - "full stack" silhouette
      const headH = 4, cabH = 6.5;
      const bodyW = wide ? 18 : 14, x0 = wide ? 3 : 5;
      let out = `<rect x="${x0}" y="1.5" width="${bodyW}" height="${headH}" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/>`;
      out += panel(x0 + 0.8, 2.2, bodyW - 1.6, headH - 1.4, clamp(speakerCount + 1, 2, 4));
      let y = 1.5 + headH + 0.6;
      const perCab = Math.ceil(speakerCount / 2);
      out += `<rect x="${x0}" y="${y.toFixed(1)}" width="${bodyW}" height="${cabH}" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.3"/>`;
      out += speakerGrid(x0, y, bodyW, cabH, Math.min(perCab, speakerCount));
      y += cabH + 0.5;
      out += `<rect x="${x0}" y="${y.toFixed(1)}" width="${bodyW}" height="${cabH}" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.3"/>`;
      out += speakerGrid(x0, y, bodyW, cabH, Math.min(speakerCount - perCab, speakerCount) || 1);
      return out;
    }
    case "rack": { // 1U-style rack preamp - wide, short, no visible speaker
      const y0 = 8 + seedFrac(hash, 76) * 3;
      let out = `<rect x="2" y="${y0.toFixed(1)}" width="20" height="7" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.3"/>`;
      // Dot size reflects that specific parameter's real range (max value)
      // instead of uniform decoration - a preamp with a wide-range Gain
      // knob draws a visibly bigger dot than one with a narrow-range
      // switch-like parameter, so two rack units with different real
      // controls actually look different, not just differently spaced.
      const params = (info?.parameters || []).slice(0, 7);
      const n = Math.max(params.length, 3);
      const step = 18 / (n + 1);
      for (let i = 0; i < n; i++) {
        const cx = 3 + step * (i + 1);
        const max = params[i]?.max ?? 10;
        const r = 0.55 + clamp(Math.log2(max + 1) / 9, 0, 1) * 0.9;
        out += `<circle cx="${cx.toFixed(1)}" cy="${(y0 + 3.5).toFixed(1)}" r="${r.toFixed(2)}" fill="currentColor" opacity="0.85"/>`;
      }
      out += `<circle cx="20" cy="${y0.toFixed(1)}" r="0.6" fill="currentColor"/>`; // power LED
      return out;
    }
    case "tallCombo": { // narrower, taller, portable-looking combo - single speaker
      const w = 12, x0 = 6 + (seedFrac(hash, 77) - 0.5) * 2;
      let out = `<rect x="${x0.toFixed(1)}" y="3" width="${w}" height="18" rx="${rx.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
      out += panel(x0 + 1, 4.2, w - 2, 3, clamp(speakerCount + 1, 2, 4));
      out += speakerGrid(x0, 8.5, w, 11.5, 1);
      return out;
    }
    default: { // "combo" - single box, amp panel on top, speaker(s) below
      const w = wide ? 19 : 15, x0 = wide ? 2.5 : 4.5;
      let out = `<rect x="${x0}" y="5" width="${w}" height="14" rx="${rx.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
      out += speakerGrid(x0, 5, w, 14, speakerCount);
      return out;
    }
  }
}

// A small number of user-confirmed real speaker-configuration facts,
// used to correct the generated icon's speaker count for specific
// effects where the default paramCount-based guess was wrong. These are
// factual specs (how many speakers a real amp has), not appearance -
// still rendered through the same abstract box-and-circles vocabulary,
// not a recreation of any real product's look. Deliberately minimal -
// only added when actually confirmed, not guessed at.
const KNOWN_SPEAKER_COUNTS = {
  "FlipTop": 1,   // single 15" combo
  "AMPG SVT": 8,  // 8x10" cab pairing
};

function chooseAmpFormat(hash, hasCabinet, forcedCount) {
  if (forcedCount === 1) return "combo"; // single big speaker reads cleanest in the plain box, no extra panel clutter
  if (forcedCount >= 6) return "combo"; // a wide box with the 4x2 grid is clearer than splitting an 8-speaker wall across stacked tiers
  const options = hasCabinet
    ? ["combo", "combo", "stack2", "stack3", "tallCombo"] // weighted toward combo/stack since it has a real cab
    : ["combo", "rack", "rack", "tallCombo"]; // no cabinet param - lean toward head/rack/compact
  const idx = Math.floor(seedFrac(hash, 78) * options.length);
  return options[Math.min(idx, options.length - 1)];
}

function boxFamily(hash) {
  // preamp / DI - a gain-stage triangle, size/position nudged by seed
  const nudge = (seedFrac(hash, 80) - 0.5) * 2;
  return `<path d="M${(4 + nudge).toFixed(1)} 6v12l14-6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`;
}

function pedalBoxFamily(hash, info) {
  // Generic horizontal stompbox silhouette - a rounded rectangle with
  // knob dots across the top (sized from each parameter's real range,
  // same approach as the rack format) and a footswitch dot at the
  // bottom. This is the shared, generic shape of essentially every
  // guitar/bass pedal ever made - not evocative of any single brand's
  // distinctive cosmetic design. Used for "amp" category effects that
  // don't actually have a Cabinet parameter (DI boxes, preamps) - those
  // aren't simulating a speaker at all, so they shouldn't render with
  // speaker circles like a combo/stack does.
  const params = (info?.parameters || []).slice(0, 6);
  const n = Math.max(params.length, 2);
  const w = 19, x0 = 2.5, y0 = 3.5, h = 12;
  const rx = 0.6 + seedFrac(hash, 81) * 0.8;
  let out = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="${rx.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.4"/>`;
  const step = w / (n + 1);
  for (let i = 0; i < n; i++) {
    // Real per-parameter max drives the base size, but many different
    // amp-head sims share an identical control template (same param
    // names/ranges), so real data alone isn't always enough to tell
    // them apart - hash-seeded jitter on top ensures two effects with
    // an identical parameter signature still render distinguishably.
    const cx = x0 + step * (i + 1) + (seedFrac(hash, 82 + i) - 0.5) * (step * 0.3);
    const cy = y0 + h * 0.42;
    const max = params[i]?.max ?? 10;
    const baseR = 0.7 + clamp(Math.log2(max + 1) / 9, 0, 1) * 0.9;
    const r = baseR + seedFrac(hash, 90 + i) * 0.5;
    out += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="none" stroke="currentColor" stroke-width="1.1"/>`;
  }
  out += `<circle cx="12" cy="${(y0 + h - 1.8).toFixed(1)}" r="1.5" fill="currentColor" opacity="0.85"/>`;
  // Sloped-panel accent line - many stompbox enclosures have an angled
  // top face rather than a flat one, purely a generic ergonomic
  // convention (better knob visibility when the pedal's on the floor),
  // not any one manufacturer's distinctive shape.
  const bendX = x0 + w * (0.55 + seedFrac(hash, 95) * 0.15);
  out += `<path d="M${x0.toFixed(1)} ${(y0 + h * 0.72).toFixed(1)}H${bendX.toFixed(1)}L${(bendX + 2).toFixed(1)} ${(y0 + h * 0.9).toFixed(1)}H${(x0 + w).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4"/>`;
  return out;
}

function starFamily(hash, points) {
  points = clamp(points, 4, 9);
  const cx = 12, cy = 12, rOuter = 9, rInner = 3.5 + seedFrac(hash, 90) * 2;
  const rot = seedFrac(hash, 91) * (Math.PI * 2);
  let d = "";
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + (Math.PI * i) / points;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
  }
  return `<path d="${d}Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`;
}

function squareWaveFamily(hash, n) {
  n = clamp(n, 3, 6);
  const step = 20 / n;
  let d = `M2 15`;
  for (let i = 0; i < n; i++) {
    const up = i % 2 === 0;
    const h = 6 + seedFrac(hash, 100 + i) * 4;
    const x0 = 2 + step * i, x1 = 2 + step * (i + 1);
    d += ` V${up ? (15 - h).toFixed(1) : 15} H${x1.toFixed(1)}`;
  }
  return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`;
}

function arrowFamily(hash, up, down, ringmod) {
  if (ringmod) {
    const sep = 4 + seedFrac(hash, 110) * 2.5;
    return `<circle cx="${(12 - sep).toFixed(1)}" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
           `<circle cx="${(12 + sep).toFixed(1)}" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
  }
  const downLen = 7 + seedFrac(hash, 111) * 5;
  const upLen = 7 + seedFrac(hash, 112) * 5;
  const downX = 5 + seedFrac(hash, 113) * 2.5;
  const upX = 16 + seedFrac(hash, 114) * 2.5;
  let out = "";
  if (down) out += `<path d="M${downX.toFixed(1)} ${(18).toFixed(1)}V${(18 - downLen).toFixed(1)}m0 0-3 3m3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (up) out += `<path d="M${upX.toFixed(1)} ${(18 - upLen - 2).toFixed(1)}v${upLen.toFixed(1)}m0 0-3-3m3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  return out;
}

function pedalFamily(hash) {
  const tilt = (seedFrac(hash, 120) - 0.5) * 3;
  return `<path d="M${(4 + tilt).toFixed(1)} 18h16l-5-10H${(9 + tilt).toFixed(1)}z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`;
}

function gateFamily(hash, n) {
  n = clamp(n, 3, 6);
  const step = 20 / (n - 1 || 1);
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = 2 + step * i;
    // Real per-bar variation from hash, not just a fixed picket-fence -
    // heights and vertical position both differ per bar/per effect, so
    // two effects with the same bar count don't render identically.
    const h = 12 + seedFrac(hash, 150 + i) * 6;
    const yTop = 3 + seedFrac(hash, 160 + i) * 3;
    out += `<path d="M${x.toFixed(1)} ${yTop.toFixed(1)}v${h.toFixed(1)}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
  }
  return out;
}

function pipesFamily(hash, n) {
  n = clamp(n, 4, 7);
  const step = 20 / (n - 1 || 1);
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = 2 + step * i;
    const h = 8 + seedFrac(hash, 130 + i) * 12;
    out += `<path d="M${x.toFixed(1)} 20V${(20 - h).toFixed(1)}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
  }
  return out;
}

// --- dynamics subtypes: multiband / optical / swell -----------------------

function miniWaveAt(hash, salt, n, amp, cy) {
  n = clamp(n, 2, 4);
  const step = 18 / n;
  let d = `M3 ${cy}`;
  for (let i = 0; i < n; i++) {
    const cx = 3 + step * (i + 0.5);
    const dir = i % 2 === 0 ? -1 : 1;
    const localAmp = amp * (0.7 + seedFrac(hash, salt + i) * 0.6);
    d += ` Q${cx.toFixed(1)} ${(cy + dir * localAmp).toFixed(1)} ${(3 + step * (i + 1)).toFixed(1)} ${cy}`;
  }
  return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`;
}

function multibandFamily(hash) {
  // two independently-compressed bands, stacked - reflects that these
  // effects genuinely split the signal (real LoComp/HiComp-style params)
  const ampTop = 2 + seedFrac(hash, 171) * 1.4;
  const ampBot = 2 + seedFrac(hash, 172) * 1.4;
  return `<path d="M2 12h20" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity="0.45"/>` +
    miniWaveAt(hash, 180, 3, ampTop, 7) + miniWaveAt(hash, 190, 3, ampBot, 17);
}

function opticalFamily(hash) {
  // soft glow rather than a hard-edged shape, for the smoother
  // response optical/photocell compressors are known for
  const r1 = 6.5 + seedFrac(hash, 220) * 1.8;
  const r2 = r1 - 2.4;
  const r3 = 1.5 + seedFrac(hash, 221) * 1;
  return `<circle cx="12" cy="12" r="${r1.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>` +
         `<circle cx="12" cy="12" r="${r2.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.65"/>` +
         `<circle cx="12" cy="12" r="${r3.toFixed(1)}" fill="currentColor"/>`;
}

function swellFamily(hash) {
  // gradual rise to a plateau, not a symmetric squeeze - matches what a
  // slow-attack/volume-swell effect actually does to a signal
  const riseX = 9 + seedFrac(hash, 230) * 4;
  const h = 11 + seedFrac(hash, 231) * 5;
  return `<path d="M2 19Q${(riseX * 0.6).toFixed(1)} 19 ${riseX.toFixed(1)} ${(19 - h).toFixed(1)}T22 ${(19 - h).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
}

// --- filter subtypes: comb / step / envelope / splitter / exciter / parametric-eq

function combFamily(hash, n) {
  n = clamp(n, 5, 9);
  const step = 20 / (n - 1 || 1);
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = 2 + step * i;
    const h = 4 + ((n - i) / n) * 12 * (0.7 + seedFrac(hash, 240 + i) * 0.5);
    out += `<path d="M${x.toFixed(1)} 20V${(20 - h).toFixed(1)}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`;
  }
  return out;
}

function stepFilterFamily(hash, n) {
  n = clamp(n, 4, 7);
  const step = 20 / n;
  let d = `M2 18`;
  for (let i = 0; i < n; i++) {
    const y = 5 + seedFrac(hash, 250 + i) * 12;
    const x1 = 2 + step * (i + 1);
    d += ` V${y.toFixed(1)} H${x1.toFixed(1)}`;
  }
  return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function envelopeFamily(hash) {
  const peakX = 7 + seedFrac(hash, 260) * 5;
  const peakY = 4 + seedFrac(hash, 261) * 4;
  return `<path d="M2 19L${peakX.toFixed(1)} ${peakY.toFixed(1)}L22 19" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function splitterFamily(hash) {
  const forkX = 9 + seedFrac(hash, 270) * 4;
  const spread = 4.5 + seedFrac(hash, 271) * 3;
  return `<path d="M2 12H${forkX.toFixed(1)}M${forkX.toFixed(1)} 12L22 ${(12 - spread).toFixed(1)}M${forkX.toFixed(1)} 12L22 ${(12 + spread).toFixed(1)}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>`;
}

function exciterFamily(hash, n) {
  const wave = waveFamily(hash, Math.max(n, 3), 4, "normal");
  const sparkX = 17 + seedFrac(hash, 280) * 3, sparkY = 5 + seedFrac(hash, 281) * 3;
  const spark = `<path d="M${sparkX.toFixed(1)} ${(sparkY - 2).toFixed(1)}v4M${(sparkX - 2).toFixed(1)} ${sparkY.toFixed(1)}h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`;
  return wave + spark;
}

function parametricEqFamily(hash) {
  // a single adjustable bell/peak, in contrast to the multi-slider graphic
  // EQ icon - matches what a parametric EQ actually gives you (one band)
  const peakX = 8 + seedFrac(hash, 290) * 7;
  const width = 4.5 + seedFrac(hash, 291) * 3;
  const height = 5.5 + seedFrac(hash, 292) * 4.5;
  const d = `M2 16C${(peakX - width).toFixed(1)} 16 ${(peakX - width * 0.5).toFixed(1)} ${(16 - height).toFixed(1)} ${peakX.toFixed(1)} ${(16 - height).toFixed(1)}S${(peakX + width).toFixed(1)} 16 22 16`;
  return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="${peakX.toFixed(1)}" cy="${(16 - height).toFixed(1)}" r="1.4" fill="currentColor"/>`;
}

// --- category/subtype classification (unchanged logic from before) -------

const PREFIX_CATEGORY = {
  0x23: { // MS-50G+
    "01": "dynamics", "02": "filter", "03": "drive", "04": "amp",
    "06": "modulation", "07": "sfx", "08": "delay", "09": "reverb",
  },
  0x27: { // MS-60B+
    "01": "dynamics", "02": "filter", "03": "drive", "04": "amp", "05": "amp",
    "06": "modulation", "07": "pitch", "08": "synth", "09": "sfx",
    "0a": "delay", "0b": "reverb",
  },
  // MS-70CDR+: model number unconfirmed - see README/app.js for how to add it.
};

const SUBTYPE_RULES = {
  dynamics: [
    [/limit|lmt/i, "limiter"],
    [/gate|noise|znr/i, "gate"],
    [/dual|multi|\bmb\b/i, "multiband"],
    [/opt/i, "optical"],
    [/slow/i, "swell"],
  ],
  drive: [[/fuzz/i, "fuzz"], [/dist/i, "distortion"], [/boost/i, "boost"]],
  filter: [
    [/wah/i, "wah"],
    [/geq/i, "eq"],
    [/comb/i, "comb"],
    [/seq|step|rndm|random|lfo/i, "step-filter"],
    [/cry|tron|envfilter/i, "envelope"],
    [/splitter/i, "splitter"],
    [/exciter|bottom/i, "exciter"],
    [/peq|parae|\blow eq\b|\bhigh eq\b/i, "parametric-eq"],
  ],
  modulation: [
    [/cho/i, "chorus"], [/phase/i, "phaser"], [/flang/i, "flanger"],
    [/rotary|leslie/i, "rotary"], [/vibe|vibrato/i, "vibrato"], [/trem/i, "tremolo"],
  ],
  delay: [[/tape/i, "tape-echo"], [/analog/i, "analog-delay"]],
  reverb: [[/spring/i, "spring-reverb"], [/plate/i, "plate-reverb"], [/hall/i, "hall-reverb"]],
  pitch: [[/ringmod/i, "ring-mod"], [/oct/i, "octave"]],
  amp: [[/cabinet|\bcab\b/i, "cabinet"], [/preamp|\bdi\b/i, "preamp"]],
  sfx: [[/organ/i, "organ"]],
};

const PITCH_OVERRIDE = /oct|pitch|\bhps\b|polyshift|ringmod|geminos/i;
const SYNTH_OVERRIDE = /synth|organ/i;

export function categorize(modelNumberByte, id, name) {
  const table = PREFIX_CATEGORY[modelNumberByte];
  const prefix = (id >>> 0).toString(16).padStart(8, "0").slice(0, 2);
  let category = table?.[prefix];
  if (!category) return "fx";
  if (category === "modulation" && PITCH_OVERRIDE.test(name)) return "pitch";
  if (category === "sfx" && SYNTH_OVERRIDE.test(name)) return "synth";
  return category;
}

function subtypeFor(category, name) {
  const rules = SUBTYPE_RULES[category];
  if (!rules) return category;
  for (const [pattern, key] of rules) {
    if (pattern.test(name)) return key;
  }
  return category;
}

// --- putting it together --------------------------------------------------

function buildIconInner(category, subtype, hash, info) {
  const n = paramCount(info);

  switch (subtype) {
    case "limiter": return waveFamily(hash, n, 4.5, "ceiling");
    case "gate": return gateFamily(hash, n);
    case "multiband": return multibandFamily(hash);
    case "optical": return opticalFamily(hash);
    case "swell": return swellFamily(hash);
    case "dynamics": return waveFamily(hash, n, 5, "normal");

    case "fuzz": return jaggedFamily(hash, n);
    case "distortion": return waveFamily(hash, n, 5, "clipped");
    case "boost": return gateFamily(hash, Math.min(n, 4)); // reuse bar-rise look via ascending bars below
    case "drive": return waveFamily(hash, n, 4, "clipped");

    case "wah": return pedalFamily(hash);
    case "eq": return sliderFamily(hash, n);
    case "parametric-eq": return parametricEqFamily(hash);
    case "comb": return combFamily(hash, n);
    case "step-filter": return stepFilterFamily(hash, n);
    case "envelope": return envelopeFamily(hash);
    case "splitter": return splitterFamily(hash);
    case "exciter": return exciterFamily(hash, n);
    case "filter": return waveFamily(hash, n, 6, "normal");

    case "chorus": return oscFamily(hash, n, 3.5, 2);
    case "phaser": {
      const rOuter = 6 + seedFrac(hash, 4) * 2.5;
      const rInner = 2.5 + seedFrac(hash, 5) * 3;
      const cx = 12 + (seedFrac(hash, 6) - 0.5) * 3;
      return `<circle cx="12" cy="12" r="${rOuter.toFixed(2)}" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>` +
             `<circle cx="${cx.toFixed(2)}" cy="12" r="${rInner.toFixed(2)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
    }
    case "flanger": return oscFamily(hash, n, 4.5, 1) +
      `<path d="M17 6l3 1-1 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "rotary": {
      const spokes = clamp(n, 3, 5);
      let out = `<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
      for (let i = 0; i < spokes; i++) {
        const a = (Math.PI * 2 * i) / spokes + seedFrac(hash, 6) * Math.PI;
        out += `<path d="M12 12L${(12 + Math.cos(a) * 6).toFixed(1)} ${(12 + Math.sin(a) * 6).toFixed(1)}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
      }
      return out;
    }
    case "vibrato": {
      const amp = 3 + seedFrac(hash, 121) * 3;
      const cx = 7 + seedFrac(hash, 122) * 4;
      return `<path d="M${cx.toFixed(1)} 2c${amp.toFixed(1)} 2 ${amp.toFixed(1)} 4 0 6s-${amp.toFixed(1)} 4 0 6 ${amp.toFixed(1)} 4 0 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
    }
    case "tremolo": return gateFamily(hash, clamp(n, 3, 5));
    case "modulation": return oscFamily(hash, n, 3.5, 1);

    case "tape-echo": return circleCascade(hash, Math.min(n, 3), false) + `<path d="M11 12h2" stroke="currentColor" stroke-width="1.5"/>`;
    case "analog-delay": return circleCascade(hash, n, true) +
      `<path d="M2 17c4-3 4 3 8 0s4 3 8 0" fill="none" stroke="currentColor" stroke-width="1" opacity="0.35"/>`; // warm underlay, distinguishes from plain digital delay
    case "delay": return circleCascade(hash, n, true);

    case "spring-reverb": return jaggedFamily(hash, clamp(n, 5, 8));
    case "plate-reverb": return sliderFamily(hash, Math.min(n, 3));
    case "hall-reverb": {
      const rx8 = 6 + seedFrac(hash, 123) * 3;
      const ry6 = 4 + seedFrac(hash, 124) * 3;
      const h10 = 8 + seedFrac(hash, 125) * 4;
      return `<path d="M4 20V${(20 - h10).toFixed(1)}a${rx8.toFixed(1)} ${ry6.toFixed(1)} 0 0 1 16 0v${h10.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
    }
    case "reverb": return reverbArcs(hash, n);

    case "ring-mod": return arrowFamily(hash, false, false, true);
    case "octave": return arrowFamily(hash, true, true, false);
    case "pitch": return arrowFamily(hash, true, true, false);

    case "cabinet": return ampFamily(hash, clamp(n - 2, 1, 4), true, chooseAmpFormat(hash, true), info);
    case "preamp": return boxFamily(hash);
    case "amp": {
      const hasCabinet = hasParam(info, /cabinet|cab\b/i);
      if (!hasCabinet) {
        // No Cabinet parameter means this effect isn't simulating a
        // speaker at all (a DI box, preamp, or similar) - it shouldn't
        // render with speaker circles like a combo/stack does. Generic
        // stompbox shape instead.
        return pedalBoxFamily(hash, info);
      }
      const known = KNOWN_SPEAKER_COUNTS[info?.name];
      const speakers = known ?? clamp(n - 3, 2, 4);
      const wide = true; // hasCabinet is always true in this branch (see the return above)
      const format = chooseAmpFormat(hash, hasCabinet, known);
      return ampFamily(hash, speakers, wide, format, info);
    }

    case "synth": return squareWaveFamily(hash, n);

    case "organ": return pipesFamily(hash, n);
    case "sfx": return starFamily(hash, clamp(n, 4, 7));

    default: {
      const rot = seedFrac(hash, 200) * 40 - 20;
      return `<g transform="rotate(${rot.toFixed(1)} 12 12)"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 12h6M12 9v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></g>`;
    }
  }
}

// --- Hand-drawn overrides -----------------------------------------------
// Draw your own icon for a specific effect and it takes priority over the
// generator entirely. Key by the effect's hex id (the same 8-char hex
// string used as keys in the zoom-effect-mappings-*.json files, e.g.
// "01000010" for the first Dynamics effect) - easiest way to find an id:
// open the relevant JSON file and search for the effect's `name`.
//
// Each entry is just the INNER svg markup (no outer <svg> tag) for a
// 24x24 viewBox - use `currentColor` for stroke/fill so it automatically
// follows the module's normal/hover/selected color, the same as every
// generated icon does.
//
// Example - a hand-drawn icon for SMR400 (id "05000000" on the MS-60B+):
//   "05000000": `<rect x="3" y="6" width="18" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>
//                <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
export const EFFECT_ICON_OVERRIDES = {
  // "hexid": `<svg markup>`,
};

export function iconSvgFor(modelNumberByte, id, info) {
  const key = (id >>> 0).toString(16).padStart(8, "0");
  const override = EFFECT_ICON_OVERRIDES[key];
  if (override) {
    return `<svg viewBox="0 0 24 24" width="58" height="58">${override}</svg>`;
  }

  const name = info?.name || "";
  const category = categorize(modelNumberByte, id, name);
  const subtype = subtypeFor(category, name);
  const hash = hashString(name || String(id));
  const inner = buildIconInner(category, subtype, hash, info);
  // No blanket rotation here on purpose - an earlier version rotated
  // every icon by a hash-seeded angle as a cheap anti-collision trick,
  // but it just made shapes look crooked without reliably fixing the
  // underlying sameness (checked by actually rendering and looking -
  // see the conversation this was fixed in). Distinctness now comes
  // from real structural variation (shape family, format, per-parameter
  // data) instead of cosmetic tilt.
  return `<svg viewBox="0 0 24 24" width="58" height="58">${inner}</svg>`;
}

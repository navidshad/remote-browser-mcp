// The SHAPE of human input: timing, pointer paths, the keyboard, and stitching a page that was
// scrolled through rather than resized.
//
// CDP input is TRUSTED (`isTrusted` is true), so a page cannot tell it from a person by the event
// itself — only by its shape. A pointer that teleports to the exact centre of every target and
// clicks in 0 ms, text that appears with no key ever pressed, a page that jumps to each element
// with no wheel events, a viewport that grows to the height of the document for a screenshot:
// none of those is something a person does, and bot-scoring scripts look for exactly that.
//
// Pure functions only — no chrome.*, no CDP. The executor decides WHEN; this file decides HOW.

export const rand = (a, b) => a + Math.random() * (b - a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
/** Roughly normal on [-1, 1] — most values near the middle, few near the edge. */
export const bell = () => (Math.random() + Math.random() + Math.random()) / 1.5 - 1;

export const WHEEL_TICK = 100; // px per notch, Chrome's default on every desktop OS
export const MAX_WHEEL_TICKS = 40;

// ── pointer ─────────────────────────────────────────────────────────────────────────────────────

/** The part of an element's box inside the viewport, or null if none of it is. */
export function visiblePart(box) {
  if (box.w == null || box.vw == null) return null;
  const l = Math.max(box.left, 0);
  const t = Math.max(box.top, 0);
  const r = Math.min(box.left + box.w, box.vw);
  const b = Math.min(box.top + box.h, box.vh);
  return r - l >= 1 && b - t >= 1 ? { l, t, r, b } : null;
}

/** Is enough of the element on screen to click it the way a person would? Wholly visible, or —
 *  for something larger than the viewport — covering its middle. */
export function onScreen(box) {
  if (box.w == null || box.vw == null) return true; // nothing to judge by — trust the caller
  const v = visiblePart(box);
  if (!v) return false;
  const fitsY = box.top >= 0 && box.top + box.h <= box.vh;
  const fitsX = box.left >= 0 && box.left + box.w <= box.vw;
  const spansY = box.h > box.vh * 0.6 && v.b - v.t >= box.vh * 0.4;
  const spansX = box.w > box.vw * 0.6 && v.r - v.l >= box.vw * 0.4;
  return (fitsY || spansY) && (fitsX || spansX);
}

/** A random point inside the visible part of the box, biased to its middle. */
export function aimPoint(box) {
  const v = visiblePart(box);
  if (!v) return { x: box.x, y: box.y };
  const cx = (v.l + v.r) / 2;
  const cy = (v.t + v.b) / 2;
  const hw = (v.r - v.l) / 2;
  const hh = (v.b - v.t) / 2;
  return {
    x: clamp(cx + bell() * hw * 0.6, v.l + Math.min(2, hw), v.r - Math.min(2, hw)),
    y: clamp(cy + bell() * hh * 0.6, v.t + Math.min(2, hh), v.b - Math.min(2, hh)),
  };
}

/** Points along a cubic Bézier from `a` to `b`, bowed to one side and eased in and out. */
export function mousePath(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 3) return [b];
  // Perpendicular unit vector, for the bow.
  const px = -dy / dist;
  const py = dx / dist;
  const bow1 = rand(-0.25, 0.25) * dist;
  const bow2 = rand(-0.25, 0.25) * dist;
  const c1 = { x: a.x + dx * rand(0.2, 0.4) + px * bow1, y: a.y + dy * rand(0.2, 0.4) + py * bow1 };
  const c2 = { x: a.x + dx * rand(0.6, 0.8) + px * bow2, y: a.y + dy * rand(0.6, 0.8) + py * bow2 };
  const steps = clamp(Math.round(dist / rand(18, 30)), 6, 35);
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t0 = i / steps;
    const t = t0 < 0.5 ? 2 * t0 * t0 : 1 - Math.pow(-2 * t0 + 2, 2) / 2; // ease in-out
    const u = 1 - t;
    const x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x;
    const y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y;
    // Sub-pixel tremor everywhere but the landing point, which must be exactly where we aimed.
    out.push(i === steps ? b : { x: x + rand(-0.6, 0.6), y: y + rand(-0.6, 0.6) });
  }
  return out;
}

// ── keyboard ────────────────────────────────────────────────────────────────────────────────────
//
// A key event a page can inspect carries `key`, `code` and `keyCode`. The old fallback sent
// `code: "a"` and no keyCode at all — values no physical keyboard produces. This is the US layout,
// which is what `code` means everywhere (it names the PHYSICAL key, whatever the layout prints on
// it); a character with no key here (é, ß, 漢, emoji) is inserted the way an IME would insert it.

const PLATFORM =
  (globalThis.navigator && ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform)) || "";
export const IS_MAC = /mac/i.test(PLATFORM);

/** CDP `modifiers` bits. */
export const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const NAMED = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Insert: { code: "Insert", vk: 45 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageDown: { code: "PageDown", vk: 34 },
  PageUp: { code: "PageUp", vk: 33 },
  CapsLock: { code: "CapsLock", vk: 20 },
  ContextMenu: { code: "ContextMenu", vk: 93 },
  Shift: { code: "ShiftLeft", vk: 16, location: 1 },
  Control: { code: "ControlLeft", vk: 17, location: 1 },
  Alt: { code: "AltLeft", vk: 18, location: 1 },
  Meta: { code: "MetaLeft", vk: 91, location: 1 },
};
for (let i = 1; i <= 12; i++) NAMED["F" + i] = { code: "F" + i, vk: 111 + i };

/** Names agents actually write, mapped to the DOM's. */
const ALIASES = {
  Return: "Enter", Esc: "Escape", Del: "Delete", Ctrl: "Control", Control: "Control", Cmd: "Meta",
  Command: "Meta", Super: "Meta", Win: "Meta", Option: "Alt", Opt: "Alt", Up: "ArrowUp",
  Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", PgUp: "PageUp", PgDn: "PageDown",
  Space: " ", Spacebar: " ",
};

const PUNCT = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188],
  ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
};
const SHIFTED = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
  "~": "`",
};

/** The physical key for one printable character, or null when no US key types it. */
export function charKey(ch) {
  if (ch === " ") return { key: " ", code: "Space", vk: 32, text: " ", shift: false };
  if (/^[a-z]$/.test(ch)) return { key: ch, code: "Key" + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), text: ch, shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: "Key" + ch, vk: ch.charCodeAt(0), text: ch, shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: "Digit" + ch, vk: ch.charCodeAt(0), text: ch, shift: false };
  if (PUNCT[ch]) return { key: ch, code: PUNCT[ch][0], vk: PUNCT[ch][1], text: ch, shift: false };
  if (SHIFTED[ch]) {
    const base = charKey(SHIFTED[ch]);
    return { key: ch, code: base.code, vk: base.vk, text: ch, shift: true };
  }
  return null;
}

/** A key by name ("Enter", "ArrowDown", "F5", "a", "Esc") — null if it names nothing we know. */
export function namedKey(name) {
  const n = ALIASES[name] || name;
  if (NAMED[n]) return { key: n, ...NAMED[n] };
  if (n.length === 1) return charKey(n) || { key: n, code: "", vk: 0, text: n, shift: false };
  return null;
}

/**
 * "Control+Shift+K", "Meta+a", "Shift+Tab", "Control++" → modifiers plus the final key.
 * `Mod` is the platform's command key (⌘ on a Mac, Ctrl elsewhere), so a caller can say
 * "Mod+a" and mean select-all on both.
 */
export function parseCombo(combo) {
  const s = String(combo);
  const parts = s.endsWith("++") ? [...s.slice(0, -2).split("+").filter(Boolean), "+"] : s.split("+");
  const keyName = parts.pop();
  const mods = [];
  for (const p of parts) {
    const m = p === "Mod" ? (IS_MAC ? "Meta" : "Control") : ALIASES[p] || p;
    if (!(m in MOD)) return null;
    if (!mods.includes(m)) mods.push(m);
  }
  const key = namedKey(keyName === "Mod" ? (IS_MAC ? "Meta" : "Control") : keyName);
  return key ? { mods, key } : null;
}

/** Editing commands a Mac shortcut means. Chrome's Mac build does not run them for synthetic key
 *  events by itself — the real one asks the OS menu, which CDP input never reaches. */
export function macCommands(mods, key) {
  if (!IS_MAC || !mods.includes("Meta")) return undefined;
  const k = String(key.key).toLowerCase();
  const shift = mods.includes("Shift");
  const map = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: shift ? "redo" : "undo" };
  return map[k] ? [map[k]] : undefined;
}

/** How long a person takes to press the next key after `prev`. */
export function keyGap(prev) {
  if (Math.random() < 0.03) return rand(300, 800); // the occasional hesitation
  if (prev === " " || /[.,;:!?\n]/.test(prev || "")) return rand(90, 260); // between words
  return rand(45, 150);
}

/** How long a key stays down. */
export const keyHold = () => rand(25, 85);

// ── screenshots ─────────────────────────────────────────────────────────────────────────────────

/**
 * One tall PNG from viewport captures taken at scroll offsets `y` (CSS px), each `vh` CSS px high.
 * Later frames are drawn over earlier ones, so the overlap of the last, short scroll resolves to
 * what was on screen last. Returns base64, or null where there is no OffscreenCanvas (not a
 * browser), and the caller falls back.
 *
 * SELF-CONTAINED on purpose — no closure over this module — so a test can evaluate its source in
 * a real page to prove the pixels line up.
 */
export async function stitchFrames(frames, vh) {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return null;
  const bitmaps = [];
  for (const f of frames) {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    bitmaps.push(await createImageBitmap(new Blob([bytes], { type: "image/png" })));
  }
  const scale = bitmaps[0].height / vh;
  const y0 = frames[0].y;
  const last = frames[frames.length - 1];
  const height = Math.round((last.y - y0) * scale) + bitmaps[bitmaps.length - 1].height;
  const canvas = new OffscreenCanvas(bitmaps[0].width, height);
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < frames.length; i++) ctx.drawImage(bitmaps[i], 0, Math.round((frames[i].y - y0) * scale));
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const out = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(s);
}

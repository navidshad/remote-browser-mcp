// Functions that run IN the page (serialized to source and evaluated via CDP
// Runtime.evaluate). They build a Playwright-MCP-like accessibility snapshot and
// resolve [ref=eNN] ids back to live elements. Refs live on window.__rbm and are
// regenerated every snapshot (per-snapshot epoch) — the same contract Playwright
// uses: re-snapshot after navigation/DOM changes.

/** Returns a YAML-ish accessibility tree string; stamps window.__rbm.elements. */
export const SNAPSHOT_FN = function () {
  const W = window;
  W.__rbm = W.__rbm || {};
  W.__rbm.epoch = (W.__rbm.epoch || 0) + 1;
  const els = {};
  let seq = 0;
  const lines = [];

  function visible(el) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    return true;
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "button" || ty === "submit" || ty === "reset") return "button";
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "hidden") return null;
      return "textbox";
    }
    const map = {
      a: el.hasAttribute("href") ? "link" : null,
      button: "button",
      textarea: "textbox",
      select: "combobox",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
    };
    return map[tag] || null;
  }

  function nameOf(el) {
    const al = el.getAttribute("aria-label");
    if (al) return al.trim();
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const n = document.getElementById(lb);
      if (n) return (n.innerText || "").trim();
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.id) {
        try {
          const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lab) return (lab.innerText || "").trim();
        } catch (e) {}
      }
      const ph = el.getAttribute("placeholder");
      if (ph) return ph.trim();
    }
    const alt = el.getAttribute("alt");
    if (alt) return alt.trim();
    const title = el.getAttribute("title");
    if (title) return title.trim();
    const txt = (el.innerText || "").trim().replace(/\s+/g, " ");
    return txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
  }

  const ACTIONABLE = new Set([
    "link",
    "button",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "menuitem",
    "menuitemcheckbox",
    "tab",
    "switch",
    "slider",
    "searchbox",
    "option",
  ]);

  function interesting(role) {
    return role && (ACTIONABLE.has(role) || role === "heading");
  }

  function walk(node, depth) {
    const kids = node.children;
    if (!kids) return;
    for (const el of kids) {
      if (!visible(el)) continue;
      const role = roleOf(el);
      let consumed = false;
      if (interesting(role)) {
        const ref = "e" + ++seq;
        els[ref] = el;
        const name = nameOf(el).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        let extra = "";
        if (role === "heading") {
          const m = el.tagName.match(/^H(\d)/i);
          if (m) extra = " [level=" + m[1] + "]";
        }
        if (el.disabled) extra += " [disabled]";
        lines.push("  ".repeat(depth) + '- ' + role + ' "' + name + '"' + extra + " [ref=" + ref + "]");
        consumed = true;
      }
      walk(el, consumed ? depth + 1 : depth);
      if (el.shadowRoot) walk(el.shadowRoot, consumed ? depth + 1 : depth);
    }
  }

  W.__rbm.elements = els;
  walk(document.body, 1);
  const header = '- page "' + (document.title || "") + '" (' + location.href + ")";
  return header + "\n" + (lines.join("\n") || "  (no interactable elements found)");
};

/** Resolve a ref to box-center viewport coords (for trusted mouse dispatch). */
export const RESOLVE_BOX_FN = function (ref) {
  const el = window.__rbm && window.__rbm.elements && window.__rbm.elements[ref];
  if (!el) return { found: false };
  try {
    el.scrollIntoView({ block: "center", inline: "center" });
  } catch (e) {}
  const r = el.getBoundingClientRect();
  return {
    found: true,
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    w: r.width,
    h: r.height,
    tag: el.tagName.toLowerCase(),
  };
};

/** Focus a ref's element (for typing). */
export const FOCUS_FN = function (ref) {
  const el = window.__rbm && window.__rbm.elements && window.__rbm.elements[ref];
  if (!el) return { found: false };
  try {
    el.scrollIntoView({ block: "center" });
    el.focus();
  } catch (e) {}
  return { found: true };
};

/** Select all text in a ref's editable element (input/textarea/contenteditable). */
export const SELECT_ALL_FN = function (ref) {
  const el = window.__rbm && window.__rbm.elements && window.__rbm.elements[ref];
  if (!el) return { found: false, empty: true };
  try {
    el.focus();
    if ("value" in el && typeof el.select === "function") {
      const empty = !el.value; // <input> / <textarea>
      el.select();
      return { found: true, empty };
    }
    const empty = !el.textContent; // contenteditable / other
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { found: true, empty };
  } catch (e) {
    return { found: true, empty: false };
  }
};

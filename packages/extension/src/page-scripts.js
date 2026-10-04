// Functions that run IN the page (serialized to source and evaluated via CDP
// Runtime.evaluate). They build a Playwright-MCP-like accessibility snapshot and
// resolve [ref=eNN] ids back to live elements. Refs live on window.__rbm and are
// regenerated every snapshot (per-snapshot epoch) — the same contract Playwright
// uses: re-snapshot after navigation/DOM changes.
//
// THEY RUN IN AN ISOLATED WORLD, not the page's own (see `Executor.isolatedContext`). The DOM is
// shared; the JavaScript globals are not. So `window.__rbm` and every other `__rbm*` name below
// lives on a `window` the page's scripts cannot see — they used to sit on the page's own `window`,
// where any script could read them and conclude an automation tool was driving the tab. Nothing
// here may rely on a property the PAGE's scripts put on an element (an expando such as React's
// `_valueTracker`): from this world those are simply absent.

/** Returns a YAML-ish accessibility tree string; stamps window.__rbm.elements. */
export const SNAPSHOT_FN = function (narrow) {
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

  /** The two characters that would otherwise break out of a quoted name. */
  function esc(v) {
    return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /**
   * Elements whose text is CODE, not content.
   *
   * `visible()` already rejects these through `display: none` — but that is the PAGE's stylesheet
   * deciding what an agent reads. A site that styles `script { display: block }`, or a UA sheet that
   * differs, would otherwise put its own source into an agent's context and its transcript. Naming
   * them makes the guarantee ours rather than the page's.
   */
  const NEVER_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME"]);

  /**
   * The text in an element's OWN child text nodes — never its descendants'.
   *
   * DIRECT is what makes this safe to call on every element without repeating a word. A
   * `<div><p>Hello</p></div>` has no direct text on the div and "Hello" on the p, so the sentence is
   * emitted exactly once, at the depth it actually lives. `innerText` here would repeat the whole
   * page at every level of the tree.
   */
  function directText(el) {
    if (NEVER_TEXT.has(String(el.tagName || "").toUpperCase())) return "";
    const kids = el.childNodes;
    if (!kids) return "";
    let out = "";
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n && n.nodeType === 3) out += n.nodeValue || "";
    }
    return out.trim().replace(/\s+/g, " ");
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
        const name = esc(nameOf(el));
        let extra = "";
        if (role === "heading") {
          const m = el.tagName.match(/^H(\d)/i);
          if (m) extra = " [level=" + m[1] + "]";
        }
        if (el.disabled) extra += " [disabled]";
        lines.push("  ".repeat(depth) + '- ' + role + ' "' + name + '"' + extra + " [ref=" + ref + "]");
        consumed = true;
      } else {
        // PROSE, and it is why this snapshot stopped being an interaction map.
        //
        // `interesting()` admits actionable roles and headings, so a page's actual words — every
        // paragraph, list item and table cell — were silently absent. `browser_read`'s `text`
        // format deliberately routes here too ("the only page read there is"), which meant an
        // agent asked to read a page could not read one: it got the buttons and the <h1> and
        // nothing that was written. A real agent found this on example.com, reported the heading
        // and the link correctly, and said the body paragraph "didn't come through".
        //
        // EMITTED ONLY IN THE `else`. An actionable element's words are already its `name`, so a
        // link would otherwise appear twice — once as `link "Learn more"` and again as text.
        //
        // NO REF, deliberately. Refs exist for `browser_act`, and clicking a paragraph is not a
        // thing; adding one would inflate every ref number for no gain. `find` still matches these
        // lines, which is the narrowing that actually matters on a long page.
        const prose = directText(el);
        if (prose) lines.push("  ".repeat(depth) + '- text "' + esc(prose) + '"');
      }
      walk(el, consumed ? depth + 1 : depth);
      if (el.shadowRoot) walk(el.shadowRoot, consumed ? depth + 1 : depth);
    }
  }

  W.__rbm.elements = els;
  walk(document.body, 1);
  const header = '- page "' + (document.title || "") + '" (' + location.href + ")";

  // NARROWING, which the tool has advertised since day one and silently ignored — `browser_read`
  // offers `find` and `ref`, Crew forwards both, and the whole tree came back regardless. A page
  // of any size costs a few thousand tokens, so an agent that asked for one row and paid for all
  // of them was the common case rather than the edge one.
  //
  // Filtering the OUTPUT rather than the walk is deliberate: `W.__rbm.elements` is still populated
  // for every element, so a ref that is not shown still resolves for `browser_act`. Narrowing
  // changes what the agent READS, never what it can reach.
  var all = lines;

  /**
   * A ceiling on what one read can cost, applied to every exit.
   *
   * Before page text was included, a snapshot was bounded by how many CONTROLS a page had, which is
   * small even on a bad page. Prose has no such ceiling — an article, a docs page or a comment
   * thread can be hundreds of kilobytes, and this string goes verbatim into an agent's context and
   * then into every subsequent turn of that session. Unbounded output reaching a model is a cost
   * and a failure mode, not a detail.
   *
   * It CUTS AT A LINE BOUNDARY and says what it did, because a snapshot truncated mid-element would
   * hand the agent a malformed ref. The footer names `find`, since the agent's next move is to ask
   * a narrower question rather than to give up.
   */
  var MAX_CHARS = 40000;
  function clamp(text) {
    if (text.length <= MAX_CHARS) return text;
    var kept = [];
    var used = 0;
    var rows = text.split("\n");
    for (var i = 0; i < rows.length; i++) {
      if (used + rows[i].length + 1 > MAX_CHARS) break;
      kept.push(rows[i]);
      used += rows[i].length + 1;
    }
    return (
      kept.join("\n") +
      "\n  (…truncated: " + (rows.length - kept.length) + " of " + rows.length +
      " lines dropped. Re-read with `find` to get the part you need.)"
    );
  }
  function out(body) {
    return clamp(header + "\n" + body);
  }

  if (narrow && narrow.ref) {
    var want = "[ref=" + narrow.ref + "]";
    var one = all.filter(function (l) { return l.indexOf(want) !== -1; });
    return out(one.length
      ? one.join("\n")
      : '  (no element ' + narrow.ref + ' on the page now — take a fresh snapshot)');
  }
  if (narrow && narrow.find) {
    var n = String(narrow.find).toLowerCase();
    var hit = all.filter(function (l) { return l.toLowerCase().indexOf(n) !== -1; });
    // The COUNT is the point of the footer: an agent that sees 3 of 412 knows the page is bigger
    // than what it is looking at, and can widen rather than concluding the rest is not there.
    return out(hit.length
      ? hit.join("\n") + '\n  (' + hit.length + " of " + all.length + ' lines match "' + narrow.find + '")'
      : '  (nothing matches "' + narrow.find + '" — ' + all.length + " lines on this page)");
  }
  // "readable", not "interactable": a page of pure prose with no controls is no longer empty here.
  return out(all.join("\n") || "  (nothing readable on this page)");
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

/** Measure a ref WITHOUT scrolling, plus the viewport — the executor scrolls with the mouse wheel
 *  itself, as a person would, and only falls back to `RESOLVE_BOX_FN`'s `scrollIntoView` when the
 *  wheel cannot reach the element (a nested scroller the cursor is not over). */
export const BOX_FN = function (ref) {
  const el = window.__rbm && window.__rbm.elements && window.__rbm.elements[ref];
  if (!el || !el.isConnected) return { found: false };
  const r = el.getBoundingClientRect();
  return {
    found: true,
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    left: r.left,
    top: r.top,
    w: r.width,
    h: r.height,
    vw: window.innerWidth,
    vh: window.innerHeight,
    tag: el.tagName.toLowerCase(),
  };
};

/** Did the last (trusted) click actually put focus in this ref? If something covered it, the
 *  executor falls back to `FOCUS_FN`. */
export const IS_FOCUSED_FN = function (ref) {
  const el = window.__rbm && window.__rbm.elements && window.__rbm.elements[ref];
  const a = document.activeElement;
  return !!(el && a && (el === a || el.contains(a)));
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

/** Show/refresh the agent-activity overlay: a colored ring around the viewport
 *  plus a top-center badge with the current action, so a human watching the
 *  window can see what the agent is doing and where. aria-hidden keeps it out of
 *  snapshots; pointer-events:none keeps it out of the way. Auto-fades after a few
 *  seconds of no agent activity (which also clears stale overlays after detach).
 *
 *  AS LITTLE OF IT AS POSSIBLE IS THE PAGE'S TO SEE. It used to be a `<div id="__rbm-overlay">`
 *  that stayed in the document for good once an agent had acted — one `getElementById` and a page
 *  knew. Now the host is an anonymous `<div>` whose ring and badge sit in a CLOSED shadow root
 *  (the page cannot read the badge's words), its handle lives on the isolated world's `window`,
 *  and it is REMOVED from the document once it has faded rather than hidden in place. What is left
 *  is a styled element present only while the agent is acting.
 *
 *  With arg.block, human input (mouse/keyboard/scroll) is suppressed WHILE the
 *  overlay is visible — capture-phase listeners swallow events unless the
 *  executor raised window.__rbmAllowInput around its own CDP-dispatched input.
 *  Blocking is tied to overlay visibility, so it always self-releases when the
 *  agent goes idle or detaches (a stale overlay can never lock the page). */
export const OVERLAY_FN = function (arg) {
  const color = (arg && arg.color) || "#2563eb";
  const W = window;
  let o = W.__rbmOverlay;
  if (!o) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .25s ease;";
    const root = host.attachShadow({ mode: "closed" });
    const ring = document.createElement("div");
    ring.style.cssText = "position:absolute;inset:0;";
    const badge = document.createElement("div");
    badge.style.cssText =
      "position:absolute;top:10px;left:50%;transform:translateX(-50%);max-width:70vw;" +
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "font:600 12px/1.6 -apple-system,system-ui,sans-serif;color:#fff;" +
      "padding:3px 14px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.25);";
    root.appendChild(ring);
    root.appendChild(badge);
    o = W.__rbmOverlay = { host: host, ring: ring, badge: badge };
  }
  const host = o.host;
  o.ring.style.boxShadow = "inset 0 0 0 3px " + color + ", inset 0 0 28px " + color + "55";
  o.badge.style.background = color;
  o.badge.textContent = (arg && arg.block ? "🔒 " : "⚡ ") + ((arg && arg.text) || "agent active");
  W.__rbmBlockEnabled = !!(arg && arg.block);
  if (W.__rbmBlockEnabled && !W.__rbmBlockInstalled) {
    W.__rbmBlockInstalled = true;
    const swallow = function (e) {
      const h = W.__rbmOverlay && W.__rbmOverlay.host;
      const blocking =
        W.__rbmBlockEnabled && !W.__rbmAllowInput && h && h.isConnected && h.style.opacity === "1";
      if (blocking) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const EVENTS = [
      "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu",
      "wheel", "touchstart", "touchmove", "keydown", "keypress", "keyup",
    ];
    for (const ev of EVENTS) window.addEventListener(ev, swallow, { capture: true, passive: false });
  }
  if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
  host.style.opacity = "1";
  clearTimeout(W.__rbmOverlayTimer);
  W.__rbmOverlayTimer = setTimeout(function () {
    host.style.opacity = "0"; // fading also releases the input block
    W.__rbmOverlayTimer = setTimeout(function () {
      host.remove(); // gone, not hidden — see above
    }, 400);
  }, 4000);
  return true;
};

/** Gate for the input blocker: the executor raises this around its own CDP input
 *  so the agent's synthesized events pass while the human's are suppressed. */
export const ALLOW_INPUT_FN = function (allow) {
  window.__rbmAllowInput = !!allow;
  return true;
};

/** Remove the activity overlay immediately (no fade) — used before screenshots so
 *  the agent's captures show the page, not our ring/badge. */
export const OVERLAY_HIDE_FN = function () {
  const o = window.__rbmOverlay;
  if (o) {
    o.host.style.opacity = "0";
    o.host.remove();
  }
  clearTimeout(window.__rbmOverlayTimer);
  return true;
};

/** Choose an option in a native <select>, by label or by value.
 *
 *  WHY THIS IS NOT A CLICK. Clicking a <select> opens a list drawn by the operating system, not by
 *  the page — CDP input events cannot reach it, so every plausible imitation (click then arrow
 *  keys, click then type) leaves the wrong value chosen while reporting success. The whole popup
 *  is a red herring: it is a way of ASKING a human, and the actual state is one property. So we
 *  set the property and fire the events a real choice fires, which is exactly what Playwright's
 *  `selectOption` does.
 *
 *  Matching is exact-label, then exact-value, then a UNIQUE substring — an ambiguous substring is
 *  a MISS on purpose, because "UK" against both "UK" and "UK (Northern Ireland)" has a right
 *  answer only when it is exact, and quietly taking the first is how an agent ships the wrong
 *  address. A miss hands back the options, so the retry is informed rather than another guess. */
export const SELECT_OPTION_FN = function (arg) {
  const el = window.__rbm && window.__rbm.elements && window.__rbm.elements[arg && arg.ref];
  if (!el) return { found: false };
  if (el.tagName !== "SELECT") return { found: true, notASelect: true, tag: el.tagName.toLowerCase() };
  if (el.disabled) return { found: true, disabled: true };

  const opts = [];
  for (let i = 0; i < el.options.length; i++) {
    const o = el.options[i];
    opts.push({ i: i, label: String(o.label || o.text || "").trim(), value: String(o.value), off: !!o.disabled });
  }
  const want = String(arg && arg.value != null ? arg.value : "").trim();
  const lc = want.toLowerCase();
  const names = opts.map(function (o) { return o.label || o.value; });

  let hit = null;
  let ambiguous = null;
  if (want) {
    for (const o of opts) if (!hit && o.label.toLowerCase() === lc) hit = o;
    for (const o of opts) if (!hit && o.value.toLowerCase() === lc) hit = o;
    if (!hit) {
      const part = opts.filter(function (o) { return o.label.toLowerCase().indexOf(lc) !== -1; });
      if (part.length === 1) hit = part[0];
      else if (part.length > 1) ambiguous = part.map(function (o) { return o.label || o.value; });
    }
  }
  if (!hit) return { found: true, matched: false, ambiguous: ambiguous, options: names };
  // A disabled option is usually the "Choose one…" placeholder. Selecting it would be a no-op the
  // page then rejects on submit, so say so rather than reporting a choice that did not happen.
  if (hit.off) return { found: true, matched: false, optionDisabled: hit.label || hit.value, options: names };

  try {
    el.scrollIntoView({ block: "center" });
    el.focus();
  } catch (e) {}
  // React caches the last value it saw and DROPS a change event that agrees with the cache, so
  // without clearing the tracker the option moves on screen and the application never hears about
  // it — the single most confusing way this can half-work. Setting through the prototype's own
  // setter (rather than `el.value =`) is what keeps that tracker in the loop at all.
  //
  // In the isolated world this runs in, the tracker (a property the PAGE's React put on the
  // element) is not visible, and that is fine: the page-world `value` accessor React installs is
  // not in this world either, so the setter below changes the value WITHOUT updating React's
  // cache — the cache keeps the old value, and the change event is seen as a change. The tracker
  // line stays for a caller that evaluates in the page's own world.
  if (el._valueTracker && typeof el._valueTracker.setValue === "function") el._valueTracker.setValue("");
  const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
  if (desc && desc.set) desc.set.call(el, hit.value);
  else el.value = hit.value;
  // …and the index after it, because `value =` selects the FIRST option carrying that value, and
  // duplicates are legal — two `<option value="">` under one label, or a list that repeats a code.
  // The index is then the only thing that tells them apart. (An earlier version of this comment
  // claimed an option with no `value` attribute has "", which a real browser disproves in one
  // line: it uses the option's TEXT. The reason to set the index survives; the stated one did not.)
  el.selectedIndex = hit.i;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { found: true, matched: true, label: hit.label || hit.value, value: hit.value };
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

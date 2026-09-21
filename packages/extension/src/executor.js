// Executes browser commands against per-session tabs via chrome.debugger (CDP).
//
// Multi-agent / multi-tab model:
//   • A "session" is one logical agent (keyed by the MCP Mcp-Session-Id the bridge
//     passes down; header-less callers share the "default" session for back-compat).
//   • Each session OWNS a set of tabs, addressed by opaque per-session handles
//     ("t1", "t2", …) — the agent never sees raw chrome tabIds. A session can only
//     act on handles it owns (resolveOwnedTab enforces this).
//   • The debugger attaches to many tabs at once (attach is per-target); we never
//     detach one tab to drive another, so different tabs run genuinely in parallel.
//   • Commands to the SAME tab are serialized by a per-chromeTabId promise lock so
//     overlapping CDP input events don't interleave; different tabs are unaffected.
import {
  SNAPSHOT_FN,
  RESOLVE_BOX_FN,
  FOCUS_FN,
  SELECT_ALL_FN,
  SELECT_OPTION_FN,
  OVERLAY_FN,
  OVERLAY_HIDE_FN,
  ALLOW_INPUT_FN,
} from "./page-scripts.js";

const PROTOCOL = "1.3";
const DEFAULT_SESSION = "default";

// Per-session identity color, used for BOTH the Chrome tab group and the
// in-page activity overlay ring, so a human can match tabs to the agent
// driving them at a glance. Names are chrome.tabGroups colors.
const SESSION_COLORS = ["blue", "green", "purple", "orange", "pink", "cyan", "red", "yellow"];
const COLOR_CSS = {
  blue: "#2563eb",
  green: "#16a34a",
  purple: "#9333ea",
  orange: "#ea580c",
  pink: "#db2777",
  cyan: "#0891b2",
  red: "#dc2626",
  yellow: "#ca8a04",
  grey: "#6b7280",
};

const KEY_MAP = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
};

const text = (t) => ({ content: [{ type: "text", text: t }] });

/** Every command that runs against one owned tab — `execute`'s switch, named once up front so an
 *  unknown command is refused before any tab is resolved (or opened). Keep the two in step. */
const TAB_COMMANDS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_press_key",
  "browser_take_screenshot",
  "browser_wait_for",
]);

/** Human-readable overlay caption for an agent command. */
function actionText(name, a) {
  switch (name) {
    case "browser_navigate":
      return `navigate → ${a.url || ""}`;
    case "browser_click":
      return `click: ${a.element || a.ref || ""}`;
    case "browser_type":
      return `type into ${a.element || a.ref || ""}`;
    case "browser_select_option":
      return `choose "${a.value || ""}"`;
    case "browser_press_key":
      return `press ${a.key || "key"}`;
    case "browser_take_screenshot":
      return "screenshot";
    case "browser_snapshot":
      return "reading page";
    case "browser_wait_for":
      return a.time != null ? `wait ${a.time}s` : `waiting for "${a.text ?? a.textGone ?? ""}"`;
    default:
      return name.replace(/^browser_/, "").replace(/_/g, " ");
  }
}

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Executor {
  /**
   * @param {(attached: boolean, tabId: number|null, url: string|null, reason?: string) => void} pushStatus
   * @param {string} [label] group-title label for this executor's tab groups (e.g. the profile name)
   * @param {object} [policy] OPTIONAL, and absent is the upstream path — see below.
   * @param {(url: string, ctx: {sessionId: string, tab: string}) => boolean|string|Promise<boolean|string>} [policy.allowUrl]
   * @param {(chromeTabId: number) => Promise<void>} [policy.onAttached]
   */
  constructor(pushStatus, label, policy) {
    this.pushStatus = pushStatus;
    this.label = label || "Agent";
    /**
     * MAY THIS TAB BE WHERE IT NOW IS? A transport's own question, asked by core.
     *
     * Core must not learn what a blocklist is — that is the fork's word, and this file is shared.
     * So it asks a PREDICATE and reports whatever it says. Resolving `true` allows; resolving
     * `false`, or a STRING, refuses — and a string becomes the message an agent reads, so the
     * transport keeps its own wording.
     *
     * It is asked AFTER an action as well as before, which is the whole point: a command that
     * names a URL can be checked from its argument, and a CLICK cannot. Asking where the tab
     * actually ended up covers the click, a 30x, a meta-refresh and a `window.open` without core
     * knowing any of those exist.
     *
     * NULL BY DEFAULT rather than a `() => true` stub, so a build with no policy runs the exact
     * instruction sequence it ran before: no extra await, no extra `chrome.tabs.get`, nothing that
     * can reject. A default predicate would be observable; absence is not.
     */
    this.allowUrl = policy?.allowUrl || null;
    /**
     * Run after the debugger is attached and the base domains are enabled, and AWAITED before the
     * first command proceeds.
     *
     * Awaited is the entire reason it exists. `pushStatus` already fires on attach and a transport
     * could arm interception from there with no core change at all — but that is fire-and-forget,
     * so `Page.navigate` can commit before the interception is live and the FIRST navigation after
     * every attach goes unprotected. That is the failure this hook is for.
     */
    this.onAttached = policy?.onAttached || null;
    // When true (per-profile popup toggle), human input is suppressed on agent
    // tabs while the activity overlay is visible. Updated live by Connection.
    this.blockInput = false;
    // sessionId -> { id, tabs: Map<handle,{chromeTabId,attached,url}>, activeTab, seq, color, groupId }
    this.sessions = new Map();
    // chromeTabId -> { sessionId, handle } — reverse index for events + ownership
    this.tabIndex = new Map();
    // chromeTabId -> Promise — per-tab serialization of CDP command chains
    this.tabLocks = new Map();
  }

  // ── session / tab bookkeeping ────────────────────────────────────────────────
  getSession(sessionId) {
    const id = sessionId || DEFAULT_SESSION;
    let s = this.sessions.get(id);
    if (!s) {
      const color = SESSION_COLORS[this.sessions.size % SESSION_COLORS.length];
      s = { id, tabs: new Map(), activeTab: null, seq: 0, color, groupId: null };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Put a tab into the session's Chrome tab group (creating it on first use) so
   *  each agent's tabs are visually bundled. Best-effort: grouping is cosmetic
   *  and must never fail a command. */
  async ensureGrouped(session, chromeTabId) {
    if (!chrome.tabs.group || !chrome.tabGroups) return;
    try {
      if (session.groupId != null) {
        try {
          await chrome.tabs.group({ tabIds: [chromeTabId], groupId: session.groupId });
          return;
        } catch (e) {
          session.groupId = null; // group was closed — recreate below
        }
      }
      session.groupId = await chrome.tabs.group({ tabIds: [chromeTabId] });
      await chrome.tabGroups.update(session.groupId, { title: this.label, color: session.color });
    } catch (e) {
      // tab may have closed mid-flight, or grouping unsupported — ignore
    }
  }

  /** Flash the in-page activity overlay (ring + action badge) on a tab. Fire-and-
   *  forget: purely informational for the human watching the window (with
   *  blockInput it also suppresses human input while visible). */
  showAction(chromeTabId, session, text) {
    this.evalFn(chromeTabId, OVERLAY_FN, {
      text,
      color: COLOR_CSS[session.color] || COLOR_CSS.grey,
      block: this.blockInput,
    }).catch(() => {});
  }

  /** Run an input-dispatching command with the human-input blocker lifted for the
   *  agent's own CDP events. Safe: per-tab commands are serialized. */
  async withInputAllowed(chromeTabId, fn) {
    if (!this.blockInput) return fn();
    await this.evalFn(chromeTabId, ALLOW_INPUT_FN, true).catch(() => {});
    try {
      return await fn();
    } finally {
      await this.evalFn(chromeTabId, ALLOW_INPUT_FN, false).catch(() => {});
    }
  }

  allocHandle(session) {
    return "t" + ++session.seq;
  }

  /** Register a chrome tab under a session, allocate a handle, make it active. */
  registerTab(session, chromeTabId, url) {
    const handle = this.allocHandle(session);
    session.tabs.set(handle, { chromeTabId, attached: false, url: url ?? null });
    this.tabIndex.set(chromeTabId, { sessionId: session.id, handle });
    session.activeTab = handle;
    return handle;
  }

  unregisterTab(session, handle) {
    const rec = session.tabs.get(handle);
    if (rec) this.tabIndex.delete(rec.chromeTabId);
    session.tabs.delete(handle);
    if (session.activeTab === handle) {
      const next = session.tabs.keys().next();
      session.activeTab = next.done ? null : next.value;
    }
  }

  anyAttached() {
    for (const idx of this.tabIndex.values()) {
      const rec = this.sessions.get(idx.sessionId)?.tabs.get(idx.handle);
      if (rec && rec.attached) return true;
    }
    return false;
  }

  /** Per-session/per-tab breakdown for StatusMsg. */
  sessionsSummary() {
    const out = [];
    for (const s of this.sessions.values()) {
      out.push({
        sessionId: s.id,
        tabs: [...s.tabs].map(([handle, rec]) => ({
          tab: handle,
          url: rec.url ?? null,
          attached: !!rec.attached,
          active: handle === s.activeTab,
        })),
      });
    }
    return out;
  }

  // `adoptActiveTab()` USED TO LIVE HERE and was deliberately deleted.
  //
  // It found the user's current tab and pulled it into the default session, so a caller that named
  // no tab drove whatever the human happened to be looking at. That was a reasonable convenience
  // for a bridge somebody ran on their own machine for themselves. It is not one for a browser
  // lent to an organisation: it was the ONLY path by which a session touched a tab the person
  // opened, and while it existed, "agents can only see tabs they opened" was false. A sentence a
  // product makes to somebody about their own logged-in Chrome has to be true without an asterisk.
  //
  // What replaces it is the branch below: a session with no tab OPENS one — but only to NAVIGATE.
  // Slightly more work for an agent, and an invariant instead of a footnote.
  //
  // IT USED TO OPEN ONE FOR ANY COMMAND, and a fresh tab is `about:blank`. A snapshot or a screenshot
  // in a session that had never navigated therefore read, or photographed, an empty page — and
  // reported success. That happened for real: an agent whose earlier run had opened a site took a
  // "screenshot of it" in a new session, got a uniformly blank frame back, and said it was done.
  // Nothing about the result looked like an error. Only a navigation has anywhere to go, so only a
  // navigation may open the tab; everything else is told there is no page yet.

  /** Resolve args.tab (or the session's active tab) to an owned chrome tab. With `open` (a
   *  navigation), opens a fresh tab if the session has none yet; otherwise refuses with `no_tab`.
   *  Throws if the handle isn't owned. */
  async resolveOwnedTab(session, tab, { open = true } = {}) {
    if (tab != null) {
      const rec = session.tabs.get(tab);
      if (!rec) {
        throw new ToolError(
          "tab_not_owned",
          `tab ${tab} is not owned by this session — open one with browser_tab_new or list yours with browser_tab_list`
        );
      }
      return { handle: tab, chromeTabId: rec.chromeTabId };
    }
    if (session.activeTab && session.tabs.has(session.activeTab)) {
      return { handle: session.activeTab, chromeTabId: session.tabs.get(session.activeTab).chromeTabId };
    }
    if (!open) {
      // NO COMMAND NAMES in this sentence. It reaches the model word for word through every
      // transport, and not every client exposes this executor's vocabulary: Kilogent folds it into
      // `browser_open` / `browser_read` / `browser_act`, so "call browser_navigate" named a tool its
      // agents do not have. "Navigate to a URL" is true under every vocabulary.
      throw new ToolError(
        "no_tab",
        "No page is open in this session, so there is nothing to read or act on — a new tab would " +
          "only be blank. Navigate to a URL first, then try again."
      );
    }
    // Every session opens its own tab, including the default one. See the note above.
    const created = await chrome.tabs.create({ url: "about:blank", active: true });
    const handle = this.registerTab(session, created.id, "about:blank");
    await this.ensureGrouped(session, created.id);
    return { handle, chromeTabId: created.id };
  }

  // ── lifecycle hooks (wired to chrome.* events in sw.js) ─────────────────────
  onDetach(source, reason) {
    if (!source || source.tabId == null) return;
    const idx = this.tabIndex.get(source.tabId);
    if (!idx) return;
    const rec = this.sessions.get(idx.sessionId)?.tabs.get(idx.handle);
    if (rec) rec.attached = false;
    // Don't auto-reattach: if the user hit the infobar "Cancel" the next command
    // reattaches and re-shows the bar. Report aggregate attach state.
    this.pushStatus(this.anyAttached(), source.tabId, null, reason);
  }

  onTabRemoved(tabId) {
    const idx = this.tabIndex.get(tabId);
    if (!idx) return;
    const session = this.sessions.get(idx.sessionId);
    if (session) this.unregisterTab(session, idx.handle);
    this.tabLocks.delete(tabId);
    this.pushStatus(this.anyAttached(), null, null, "tab_closed");
  }

  // ── CDP helpers ─────────────────────────────────────────────────────────────
  sendCdp(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res);
      });
    });
  }

  /** Evaluate a function (from page-scripts) in the page, returning its value. */
  async evalFn(tabId, fn, arg) {
    const expr = arg === undefined ? `(${fn.toString()})()` : `(${fn.toString()})(${JSON.stringify(arg)})`;
    const res = await this.sendCdp(tabId, "Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res && res.exceptionDetails) {
      throw new ToolError("eval_failed", res.exceptionDetails.text || "page evaluation failed");
    }
    return res && res.result ? res.result.value : undefined;
  }

  /** Attach the debugger to a specific tab (idempotent; never detaches others). */
  async ensureAttached(chromeTabId) {
    const idx = this.tabIndex.get(chromeTabId);
    const rec = idx ? this.sessions.get(idx.sessionId)?.tabs.get(idx.handle) : null;
    if (rec && rec.attached) return chromeTabId;
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId: chromeTabId }, PROTOCOL, () => {
        const err = chrome.runtime.lastError;
        if (err && !/already attached/i.test(err.message)) reject(new ToolError("attach_failed", err.message));
        else resolve();
      });
    });
    await this.sendCdp(chromeTabId, "Page.enable", {});
    await this.sendCdp(chromeTabId, "Runtime.enable", {});
    // AWAITED, and re-run on every re-attach: whatever a transport arms here is per-target and dies
    // with the session, so a tab the human detached from the DevTools infobar comes back unarmed
    // unless this runs again. A failure here fails the attach rather than proceeding unprotected.
    if (this.onAttached) await this.onAttached(chromeTabId);
    if (rec) rec.attached = true;
    const info = await chrome.tabs.get(chromeTabId).catch(() => null);
    if (rec && info) rec.url = info.url;
    this.pushStatus(true, chromeTabId, info ? info.url : null);
    return chromeTabId;
  }

  /**
   * Ask the transport whether this tab may be where it now is. No-op when no policy was supplied.
   *
   * `about:blank` IS SKIPPED, and omitting that skip bricks every session. Core creates its own
   * tabs at `about:blank` (`tabNew`), and a blocklist that canonicalises through an origin cannot
   * produce one for a non-http URL — so a policy that fails closed on "no origin", which is the
   * correct posture for a real address, would refuse core's own placeholder and every session would
   * die at its first command.
   *
   * A PREDICATE THAT THROWS REFUSES. It was asked whether this address is allowed and could not
   * answer; treating that as "yes" is the one interpretation that is never safe.
   */
  async assertAllowed(chromeTabId, sessionId, handle) {
    if (!this.allowUrl) return;
    const info = await chrome.tabs.get(chromeTabId).catch(() => null);
    const url = info?.url;
    if (!url || url === "about:blank") return;
    let verdict;
    try {
      verdict = await this.allowUrl(url, { sessionId, tab: handle });
    } catch (e) {
      verdict = false;
    }
    if (verdict === true) return;
    throw new ToolError(
      "blocked",
      typeof verdict === "string" ? verdict : "That address is not allowed on this browser."
    );
  }

  /** Serialize command chains per chrome tab; different tabs run concurrently. */
  withTabLock(chromeTabId, fn) {
    const prev = this.tabLocks.get(chromeTabId) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.tabLocks.set(
      chromeTabId,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  // ── command dispatch ─────────────────────────────────────────────────────────
  async execute(name, args, deadlineMs, sessionId) {
    if (name === "bridge_ping") return text("pong");

    const session = this.getSession(sessionId);
    const a = args || {};

    // Tab-management commands operate on the session directly (no CDP attach).
    if (name === "browser_tab_list") return this.tabList(session);
    if (name === "browser_tab_new") return this.tabNew(session, a.url, deadlineMs);
    if (name === "browser_tab_close") return this.tabClose(session, a.tab);
    if (name === "browser_tab_select") return this.tabSelect(session, a.tab);

    // Refused by NAME before any tab is resolved: an unknown command must never open a tab, and must
    // be reported as unknown rather than as "no page" in a session that happens to have none.
    if (!TAB_COMMANDS.has(name)) throw new ToolError("unknown_tool", `unknown tool: ${name}`);

    // Action commands run against one owned tab, serialized per tab. Only a navigation may open it —
    // see `resolveOwnedTab`.
    const { handle, chromeTabId } = await this.resolveOwnedTab(session, a.tab, {
      open: name === "browser_navigate",
    });
    return this.withTabLock(chromeTabId, async () => {
      await this.ensureAttached(chromeTabId);
      if (name === "browser_take_screenshot") {
        // Hide the overlay first so captures show the page, not our ring/badge.
        await this.evalFn(chromeTabId, OVERLAY_HIDE_FN).catch(() => {});
      } else {
        this.showAction(chromeTabId, session, actionText(name, a));
      }
      // AFTER the action, not only before it. `browser_click` names no URL, so the only way to know
      // where a click took the tab is to look once the click has happened. The result is computed
      // first and then discarded if the tab moved somewhere it may not be — refusing costs the work
      // but never hands the agent the page.
      const outcome = await (async () => {
      switch (name) {
        case "browser_navigate":
          return this.navigate(session, handle, chromeTabId, a.url, deadlineMs);
        case "browser_snapshot":
          return this.snapshot(chromeTabId, { find: a.find, ref: a.ref });
        case "browser_click":
          return this.withInputAllowed(chromeTabId, () => this.click(chromeTabId, a.ref, a.element));
        case "browser_type":
          return this.withInputAllowed(chromeTabId, () =>
            this.type(chromeTabId, a.ref, a.text, a.submit, a.slowly, a.append)
          );
        case "browser_select_option":
          return this.withInputAllowed(chromeTabId, () => this.selectOption(chromeTabId, a.ref, a.value));
        case "browser_press_key":
          return this.withInputAllowed(chromeTabId, () => this.pressKey(chromeTabId, a.key));
        case "browser_take_screenshot":
          return this.screenshot(chromeTabId, a.fullPage);
        case "browser_wait_for":
          return this.waitFor(chromeTabId, a, deadlineMs);
        default:
          throw new ToolError("unknown_tool", `unknown tool: ${name}`);
      }
      })();
      await this.assertAllowed(chromeTabId, session.id, handle);
      return outcome;
    });
  }

  // ── commands ─────────────────────────────────────────────────────────────────
  async navigate(session, handle, tabId, url, deadlineMs) {
    if (!url) throw new ToolError("bad_args", "url is required");
    // The cheap refusal: a URL core was HANDED can be judged before anything is committed, so a
    // blocked address costs no navigation at all. The post-action check above is what covers the
    // address nobody named.
    if (this.allowUrl) {
      let verdict;
      try {
        verdict = await this.allowUrl(url, { sessionId: session.id, tab: handle });
      } catch (e) {
        verdict = false;
      }
      if (verdict !== true) {
        throw new ToolError(
          "blocked",
          typeof verdict === "string" ? verdict : "That address is not allowed on this browser."
        );
      }
    }
    await this.sendCdp(tabId, "Page.navigate", { url });
    await this.waitForLoad(tabId, Math.min(deadlineMs || 30000, 30000));
    // The navigation wiped the page (and the overlay with it) — re-show it so
    // the ring stays visible on the freshly loaded document.
    this.showAction(tabId, session, `navigate → ${url}`);
    const info = await chrome.tabs.get(tabId).catch(() => null);
    const rec = session.tabs.get(handle);
    if (rec && info) rec.url = info.url;
    return text(
      `[${handle}] Navigated to ${url}\nFinal URL: ${info ? info.url : url}\nTitle: ${info ? info.title : ""}`
    );
  }

  /** Poll until the document is loaded. When a navigation is expected
   *  (`expectNavigation`), the initial about:blank document — whose readyState
   *  is already "complete" before the navigation commits — doesn't count. */
  async waitForLoad(tabId, timeoutMs, expectNavigation) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const state = await this.evalFn(tabId, function () {
          return { ready: document.readyState, href: location.href };
        });
        if (state && state.ready === "complete" && (!expectNavigation || state.href !== "about:blank")) return;
      } catch (e) {
        // navigation in flight can briefly drop the context; keep polling
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async snapshot(tabId, narrow) {
    // `narrow` is `{find}` or `{ref}` — see SNAPSHOT_FN. Passed as one object because `evalFn`
    // takes a single argument, and because a second positional would be the next thing to drift.
    const tree = await this.evalFn(tabId, SNAPSHOT_FN, narrow || null);
    return text(tree || "(empty page)");
  }

  async click(tabId, ref, element) {
    if (!ref) throw new ToolError("bad_args", "ref is required");
    const box = await this.evalFn(tabId, RESOLVE_BOX_FN, ref);
    if (!box || !box.found) {
      throw new ToolError("ref_expired", `ref ${ref} not found — re-run browser_snapshot and use a fresh ref`);
    }
    const { x, y } = box;
    await this.sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return text(`Clicked ${element || ref}`);
  }

  async type(tabId, ref, value, submit, slowly, append) {
    if (!ref) throw new ToolError("bad_args", "ref is required");
    const focused = await this.evalFn(tabId, FOCUS_FN, ref);
    if (!focused || !focused.found) {
      throw new ToolError("ref_expired", `ref ${ref} not found — re-run browser_snapshot and use a fresh ref`);
    }
    if (!append) {
      const sel = await this.evalFn(tabId, SELECT_ALL_FN, ref);
      // Fast path: Input.insertText below replaces the current selection in one call.
      // Slow path types per-char, so clear the selection first with a single Delete.
      if (slowly && sel && !sel.empty) await this.dispatchKey(tabId, "Delete");
    }
    if (slowly) {
      for (const ch of String(value)) {
        await this.sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: ch });
        await this.sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", text: ch });
      }
    } else {
      await this.sendCdp(tabId, "Input.insertText", { text: String(value) });
    }
    if (submit) await this.dispatchKey(tabId, "Enter");
    return text(`Typed into ${ref}${submit ? " and submitted" : ""}`);
  }

  async selectOption(tabId, ref, value) {
    if (!ref) throw new ToolError("bad_args", "ref is required");
    const r = await this.evalFn(tabId, SELECT_OPTION_FN, { ref, value });
    if (!r || !r.found) {
      throw new ToolError("ref_expired", `ref ${ref} not found — re-run browser_snapshot and use a fresh ref`);
    }
    if (r.notASelect) {
      // Not a failure of the page — a page-drawn dropdown IS reachable, just not this way. The
      // sentence has to say so, or the agent retries the one thing that cannot work.
      throw new ToolError(
        "not_a_select",
        `${ref} is a <${r.tag}>, not a native dropdown. Its list is part of the page: click ${ref}, ` +
          `take a fresh snapshot, then click the option you want.`
      );
    }
    if (r.disabled) throw new ToolError("disabled", `${ref} is disabled — nothing can be chosen in it yet.`);
    if (r.optionDisabled) {
      throw new ToolError("option_disabled", `"${r.optionDisabled}" cannot be chosen — it is disabled.`);
    }
    if (!r.matched) {
      // The options come back on a miss so the retry is informed. Capped, with the count kept, for
      // SNAPSHOT_FN's reason: a 240-country list should cost an agent a hint, not a page of tokens.
      const shown = (r.options || []).slice(0, 40);
      const tail = (r.options || []).length > shown.length ? ` (${shown.length} of ${r.options.length})` : "";
      const list = shown.length ? ` Options are: ${shown.map((o) => `"${o}"`).join(", ")}.${tail}` : "";
      if (r.ambiguous) {
        throw new ToolError(
          "ambiguous_option",
          `"${value}" matches ${r.ambiguous.length} options — ${r.ambiguous
            .map((o) => `"${o}"`)
            .join(", ")}. Use the full text of the one you want.`
        );
      }
      throw new ToolError("no_such_option", `No option matching "${value}".${list}`);
    }
    return text(`Selected "${r.label}" in ${ref}`);
  }

  async pressKey(tabId, key) {
    if (!key) throw new ToolError("bad_args", "key is required");
    await this.dispatchKey(tabId, key);
    return text(`Pressed ${key}`);
  }

  async dispatchKey(tabId, key) {
    const def = KEY_MAP[key] || { key, code: key, text: key.length === 1 ? key : undefined };
    await this.sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...def });
    await this.sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...def });
  }

  async screenshot(tabId, fullPage) {
    const params = { format: "png", captureBeyondViewport: !!fullPage };
    const res = await this.sendCdp(tabId, "Page.captureScreenshot", params);
    if (!res || !res.data) throw new ToolError("screenshot_failed", "no image data returned");
    return { content: [{ type: "image", data: res.data, mimeType: "image/png" }] };
  }

  async waitFor(tabId, args, deadlineMs) {
    if (args.time != null) {
      await new Promise((r) => setTimeout(r, Math.min(args.time * 1000, deadlineMs || 60000)));
      return text(`Waited ${args.time}s`);
    }
    const start = Date.now();
    const limit = Math.min(deadlineMs || 60000, 60000);
    while (Date.now() - start < limit) {
      const present = await this.evalFn(
        tabId,
        function (needle) {
          return (document.body && document.body.innerText ? document.body.innerText : "").includes(needle);
        },
        args.text != null ? args.text : args.textGone
      );
      if (args.text != null && present) return text(`Text "${args.text}" appeared`);
      if (args.textGone != null && !present) return text(`Text "${args.textGone}" disappeared`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new ToolError("wait_timeout", "wait_for condition not met before timeout");
  }

  // ── tabs (session-scoped) ─────────────────────────────────────────────────────
  async tabList(session) {
    if (session.tabs.size === 0) return text("(no tabs — open one with browser_tab_new)");
    const lines = [];
    for (const [handle, rec] of session.tabs) {
      const info = await chrome.tabs.get(rec.chromeTabId).catch(() => null);
      const active = handle === session.activeTab ? "*" : " ";
      lines.push(`${handle}: ${active} ${info ? info.title || "(untitled)" : "(gone)"} — ${info ? info.url : rec.url || ""}`);
    }
    return text(lines.join("\n"));
  }

  async tabNew(session, url, deadlineMs) {
    // BEFORE `chrome.tabs.create`, and this one cannot be covered any other way: the tab is created
    // with its URL and the debugger attaches AFTERWARDS, so the first document load happens with
    // nothing intercepting it. This is the only door in front of it.
    if (url && this.allowUrl) {
      let verdict;
      try {
        verdict = await this.allowUrl(url, { sessionId: session.id, tab: null });
      } catch (e) {
        verdict = false;
      }
      if (verdict !== true) {
        throw new ToolError(
          "blocked",
          typeof verdict === "string" ? verdict : "That address is not allowed on this browser."
        );
      }
    }
    const created = await chrome.tabs.create({ url: url || "about:blank", active: true });
    const handle = this.registerTab(session, created.id, url || "about:blank");
    await this.ensureGrouped(session, created.id);
    await this.withTabLock(created.id, () => this.ensureAttached(created.id));
    if (url) await this.waitForLoad(created.id, Math.min(deadlineMs || 30000, 30000), true);
    this.showAction(created.id, session, `opened ${handle}${url ? ` → ${url}` : ""}`);
    const info = await chrome.tabs.get(created.id).catch(() => null);
    if (info) session.tabs.get(handle).url = info.url;
    return text(`Opened tab ${handle} — ${info ? info.url : url || "about:blank"}`);
  }

  async tabClose(session, tab) {
    const handle = tab != null ? tab : session.activeTab;
    if (!handle || !session.tabs.has(handle)) {
      throw new ToolError("tab_not_owned", `no such tab ${tab ?? "(active)"} in this session`);
    }
    const rec = session.tabs.get(handle);
    try {
      await new Promise((r) => chrome.debugger.detach({ tabId: rec.chromeTabId }, () => r()));
    } catch (e) {}
    await chrome.tabs.remove(rec.chromeTabId).catch(() => {});
    this.tabLocks.delete(rec.chromeTabId);
    this.unregisterTab(session, handle);
    return text(`Closed tab ${handle}`);
  }

  async tabSelect(session, tab) {
    if (tab == null || !session.tabs.has(tab)) {
      throw new ToolError("tab_not_owned", `no such tab ${tab} in this session`);
    }
    session.activeTab = tab;
    const rec = session.tabs.get(tab);
    await chrome.tabs.update(rec.chromeTabId, { active: true }).catch(() => {});
    return text(`Active tab is now ${tab}`);
  }

  /** Tear down every tab owned by a session (called on MCP session close). */
  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const [handle, rec] of [...session.tabs]) {
      try {
        await new Promise((r) => chrome.debugger.detach({ tabId: rec.chromeTabId }, () => r()));
      } catch (e) {}
      await chrome.tabs.remove(rec.chromeTabId).catch(() => {});
      this.tabLocks.delete(rec.chromeTabId);
      this.tabIndex.delete(rec.chromeTabId);
      session.tabs.delete(handle);
    }
    this.sessions.delete(sessionId);
    this.pushStatus(this.anyAttached(), null, null, "session_closed");
  }
}

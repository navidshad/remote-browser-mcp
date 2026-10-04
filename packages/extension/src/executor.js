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
  BOX_FN,
  IS_FOCUSED_FN,
  FOCUS_FN,
  SELECT_ALL_FN,
  SELECT_OPTION_FN,
  SELECT_STATE_FN,
  FIELD_STATE_FN,
  ALL_SELECTED_FN,
  CARET_END_FN,
  SCROLL_STATE_FN,
  OVERLAY_FN,
  OVERLAY_HIDE_FN,
  ALLOW_INPUT_FN,
} from "./page-scripts.js";
import {
  rand,
  sleep,
  clamp,
  WHEEL_TICK,
  MAX_WHEEL_TICKS,
  onScreen,
  aimPoint,
  mousePath,
  IS_MAC,
  MOD,
  charKey,
  parseCombo,
  macCommands,
  keyGap,
  keyHold,
  stitchFrames,
} from "./human.js";

const PROTOCOL = "1.3";
/** Name of the isolated world page-scripts run in. Never visible to the page; see `isolatedContext`. */
const WORLD_NAME = "rbm";
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

const text = (t) => ({ content: [{ type: "text", text: t }] });

// HUMAN-SHAPED INPUT lives in human.js: a page cannot tell trusted CDP input from a person by the
// event, only by its shape, so every click, key, scroll and capture below goes through it.

/** Pacing between actions on one tab. Agents rarely act faster than a model round trip, but when
 *  they do — a batch of steps — a person still would not. */
export const PACE = {
  actionGap: [250, 700], // ms between two input actions on one tab
  navGap: [1200, 2500], // ms between two navigations of one tab
  settle: [300, 800], // ms a person spends looking at a page that just loaded
  typeBudgetMs: 15000, // typing time after which the rest is inserted at once (see `type`)
  maxScreens: 10, // viewport captures in one full-page screenshot
};

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
    // chromeTabId -> main frame id, for `Page.createIsolatedWorld` (null: none reported)
    this.frames = new Map();
    // chromeTabId -> {x, y} — where our pointer last was, so the next move starts from there
    this.cursors = new Map();
    // chromeTabId -> ms timestamps of the last input action / navigation, for `PACE`
    this.lastInput = new Map();
    this.lastNav = new Map();
    // Per instance so a harness that TIMES page loads can switch the human pauses off.
    this.pace = PACE;
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
    this.forgetTab(source.tabId);
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
    this.forgetTab(tabId);
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

  /** Drop what we cached about a tab's frame and pointer (detach, close). */
  forgetTab(tabId) {
    this.frames.delete(tabId);
    this.cursors.delete(tabId);
    this.lastInput.delete(tabId);
    this.lastNav.delete(tabId);
  }

  /** Wait until at least a random `[lo, hi]` ms have passed since `map`'s mark for this tab. */
  async spaceOut(map, tabId, [lo, hi]) {
    const last = map.get(tabId);
    if (last == null) return;
    const wait = last + rand(lo, hi) - Date.now();
    if (wait > 0) await sleep(wait);
  }

  /** Run one input action no sooner than a person would have after the previous one. */
  async paced(tabId, fn) {
    await this.spaceOut(this.lastInput, tabId, this.pace.actionGap);
    try {
      return await fn();
    } finally {
      this.lastInput.set(tabId, Date.now());
    }
  }

  /**
   * The execution context of OUR isolated world in the tab's current document.
   *
   * WHY NOT THE PAGE'S OWN WORLD. `Runtime.evaluate` with no `contextId` runs in the page's main
   * world, so everything page-scripts left behind — `window.__rbm` and friends — was a global the
   * page's own scripts could read, and "is `__rbm` defined?" was a complete automation detector.
   * An isolated world shares the DOM and nothing else: same elements, a separate `window`.
   *
   * ASKED FOR EVERY EVALUATION, deliberately, rather than cached. A context id dies with its
   * document, and without `Runtime.enable` (which we no longer send — see `ensureAttached`) nothing
   * tells us it died; worse, after a cross-process navigation a stale number can name a context in
   * the NEW renderer, possibly the page's main world. Chrome keeps one isolated world per frame per
   * name, so this call is idempotent within a document and always returns the live one.
   *
   * Null only when the target reports no frame (the test harnesses' mock chrome); a real Chrome
   * that cannot create the world rejects, and the evaluation fails rather than falling back to the
   * page's world.
   */
  async isolatedContext(tabId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let frameId = this.frames.get(tabId);
      if (frameId === undefined) {
        const tree = await this.sendCdp(tabId, "Page.getFrameTree", {});
        frameId = (tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id) || null;
        this.frames.set(tabId, frameId);
      }
      if (frameId == null) return null;
      try {
        const res = await this.sendCdp(tabId, "Page.createIsolatedWorld", { frameId, worldName: WORLD_NAME });
        return res && res.executionContextId != null ? res.executionContextId : null;
      } catch (e) {
        // The main frame was replaced under us — look it up again, once.
        this.frames.delete(tabId);
        if (attempt === 1) throw e;
      }
    }
    return null;
  }

  /** Evaluate a function (from page-scripts) in our isolated world, returning its value. */
  async evalFn(tabId, fn, arg) {
    const expr = arg === undefined ? `(${fn.toString()})()` : `(${fn.toString()})(${JSON.stringify(arg)})`;
    const params = { expression: expr, returnByValue: true, awaitPromise: true };
    const contextId = await this.isolatedContext(tabId);
    if (contextId != null) params.contextId = contextId;
    const res = await this.sendCdp(tabId, "Runtime.evaluate", params);
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
    // NO `Runtime.enable`. It is the best-known CDP tell there is: with it on, Chrome serializes
    // whatever a page logs to the console for the debugger, and a page that logs an object with a
    // getter (an Error's `stack`, say) sees that getter run when nobody opened DevTools. Nothing
    // here needs its events — `evalFn` asks for its context directly (`isolatedContext`).
    this.frames.delete(chromeTabId);
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
          return this.withInputAllowed(chromeTabId, () =>
            this.paced(chromeTabId, () => this.click(chromeTabId, a.ref, a.element))
          );
        case "browser_type":
          return this.withInputAllowed(chromeTabId, () =>
            this.paced(chromeTabId, () =>
              this.type(chromeTabId, a.ref, a.text, a.submit, a.slowly, a.append, deadlineMs)
            )
          );
        case "browser_select_option":
          return this.withInputAllowed(chromeTabId, () =>
            this.paced(chromeTabId, () => this.selectOption(chromeTabId, a.ref, a.value))
          );
        case "browser_press_key":
          return this.withInputAllowed(chromeTabId, () =>
            this.paced(chromeTabId, () => this.pressKey(chromeTabId, a.key))
          );
        case "browser_take_screenshot":
          return this.screenshot(chromeTabId, a.fullPage, a.ref);
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
    // No faster than a person moves from page to page, and the way a person arrives at a URL they
    // were given: typed into the address bar, which also means no referrer, exactly as before.
    await this.spaceOut(this.lastNav, tabId, this.pace.navGap);
    this.lastNav.set(tabId, Date.now());
    await this.sendCdp(tabId, "Page.navigate", { url, transitionType: "typed" });
    await this.waitForLoad(tabId, Math.min(deadlineMs || 30000, 30000));
    await sleep(rand(...this.pace.settle));
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

  /**
   * Find a ref's box and bring it on screen the way a person would: wheel ticks under the pointer,
   * paced, re-measuring as it goes. Only when the wheel makes no progress (the element lives in a
   * scroller the pointer is not over) does it fall back to `scrollIntoView`.
   */
  async locate(tabId, ref) {
    let box = await this.evalFn(tabId, BOX_FN, ref);
    if (!box || !box.found) {
      throw new ToolError("ref_expired", `ref ${ref} not found — re-run browser_snapshot and use a fresh ref`);
    }
    let stuck = 0;
    for (let tick = 0; tick < MAX_WHEEL_TICKS && !onScreen(box); tick++) {
      const at = this.cursors.get(tabId) || {
        x: box.vw * rand(0.35, 0.65),
        y: box.vh * rand(0.35, 0.65),
      };
      const wantY = box.top + Math.min(box.h, box.vh) / 2 - box.vh / 2; // >0: element is below
      const wantX = box.w > box.vw || (box.left >= 0 && box.left + box.w <= box.vw)
        ? 0
        : box.left + box.w / 2 - box.vw / 2;
      const deltaY = Math.abs(wantY) < 1 ? 0 : Math.sign(wantY) * Math.min(WHEEL_TICK, Math.abs(wantY) + 40);
      const deltaX = Math.abs(wantX) < 1 ? 0 : Math.sign(wantX) * Math.min(WHEEL_TICK, Math.abs(wantX) + 40);
      await this.sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY });
      this.cursors.set(tabId, at);
      // A burst of notches, then the odd pause — a flick of the wheel, not a metronome.
      await sleep(Math.random() < 0.15 ? rand(150, 350) : rand(25, 70));
      const next = await this.evalFn(tabId, BOX_FN, ref);
      if (!next || !next.found) break;
      stuck = Math.abs(next.top - box.top) < 1 && Math.abs(next.left - box.left) < 1 ? stuck + 1 : 0;
      box = next;
      if (stuck >= 2) break;
    }
    if (!onScreen(box)) {
      const jumped = await this.evalFn(tabId, RESOLVE_BOX_FN, ref);
      if (!jumped || !jumped.found) {
        throw new ToolError("ref_expired", `ref ${ref} not found — re-run browser_snapshot and use a fresh ref`);
      }
      box = (await this.evalFn(tabId, BOX_FN, ref)) || jumped;
      await sleep(rand(80, 200));
    }
    return box;
  }

  /** Glide the pointer from wherever it last was to `to`. */
  async moveMouse(tabId, to, box) {
    let from = this.cursors.get(tabId);
    if (!from) {
      // First move in this tab: the pointer "enters" from somewhere plausible nearby.
      const vw = (box && box.vw) || to.x * 2 || 800;
      const vh = (box && box.vh) || to.y * 2 || 600;
      from = { x: clamp(to.x + rand(-300, 300), 0, vw - 1), y: clamp(to.y + rand(-200, 200), 0, vh - 1) };
    }
    for (const p of mousePath(from, to)) {
      await this.sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, buttons: 0 });
      await sleep(rand(6, 16));
    }
    this.cursors.set(tabId, to);
  }

  /** Move to a random point on the (on-screen) box, then a person-paced press and release. */
  async humanClick(tabId, box) {
    const p = aimPoint(box);
    await this.moveMouse(tabId, p, box);
    await sleep(rand(40, 140)); // settle before pressing
    await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: p.x,
      y: p.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await sleep(rand(50, 130)); // a finger, not a relay
    await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: p.x,
      y: p.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  async click(tabId, ref, element) {
    if (!ref) throw new ToolError("bad_args", "ref is required");
    const box = await this.locate(tabId, ref);
    await this.humanClick(tabId, box);
    return text(`Clicked ${element || ref}`);
  }

  /**
   * TYPING IS KEYSTROKES. It used to be one `Input.insertText` — the whole string appearing at once
   * with no key ever pressed, which a page sees as text with no `keydown` before it. Now:
   *
   *   1. the field is focused by CLICKING it (script `focus()` only if something covers it);
   *   2. existing text is selected with ⌘A / Ctrl+A, then typed over — as a person replaces it;
   *   3. each character is a real key — `key`, `code`, `keyCode`, Shift held for capitals — with
   *      a human hold and a human, irregular gap.
   *
   * A BUDGET bounds it. A person types a sentence in seconds and a page in minutes, and a command
   * has a deadline; past `this.pace.typeBudgetMs` (or 40% of the deadline) the remainder is inserted at
   * once, which is what a paste looks like. `slowly` lifts the budget to most of the deadline, for
   * a field that must see every key. Newlines and tabs are always inserted, never pressed: Enter
   * submits a form and Tab leaves the field, neither of which typing text should do.
   */
  async type(tabId, ref, value, submit, slowly, append, deadlineMs) {
    if (!ref) throw new ToolError("bad_args", "ref is required");
    const str = String(value ?? "");
    const box = await this.locate(tabId, ref);
    let focused = false;
    if (box.w > 0 && box.h > 0) {
      await this.humanClick(tabId, box);
      focused = await this.evalFn(tabId, IS_FOCUSED_FN, ref).catch(() => false);
    }
    if (!focused) {
      const f = await this.evalFn(tabId, FOCUS_FN, ref);
      if (!f || !f.found) {
        throw new ToolError("ref_expired", `ref ${ref} not found — re-run browser_snapshot and use a fresh ref`);
      }
    }
    if (append) {
      await this.evalFn(tabId, CARET_END_FN, ref).catch(() => {});
    } else {
      const st = await this.evalFn(tabId, FIELD_STATE_FN, ref).catch(() => null);
      if (!st || !st.empty) {
        await sleep(rand(80, 200));
        await this.pressCombo(tabId, "Mod+a");
        const all = await this.evalFn(tabId, ALL_SELECTED_FN, ref).catch(() => false);
        if (!all) await this.evalFn(tabId, SELECT_ALL_FN, ref);
        // Typing replaces a selection; with nothing to type, the selection still has to go.
        if (!str) await this.pressCombo(tabId, "Backspace");
      }
    }
    const deadline = deadlineMs || 30000;
    const budget = slowly ? deadline * 0.8 : Math.min(this.pace.typeBudgetMs, deadline * 0.4);
    await this.typeText(tabId, str, budget);
    if (submit) {
      await sleep(rand(150, 400));
      await this.pressCombo(tabId, "Enter");
    }
    return text(`Typed into ${ref}${submit ? " and submitted" : ""}`);
  }

  /** Keystroke by keystroke until `budgetMs` is spent, then the rest at once. */
  async typeText(tabId, str, budgetMs) {
    const chars = [...str];
    const start = Date.now();
    let shift = false;
    let i = 0;
    const shiftKey = (type) =>
      this.sendCdp(tabId, "Input.dispatchKeyEvent", {
        type,
        key: "Shift",
        code: "ShiftLeft",
        windowsVirtualKeyCode: 16,
        nativeVirtualKeyCode: 16,
        location: 1,
        modifiers: type === "keyUp" ? 0 : MOD.Shift,
      });
    for (; i < chars.length; i++) {
      if (Date.now() - start > budgetMs) break;
      const ch = chars[i];
      const def = ch === "\n" || ch === "\r" || ch === "\t" ? null : charKey(ch);
      if (def && def.shift !== shift) {
        await shiftKey(def.shift ? "rawKeyDown" : "keyUp");
        shift = def.shift;
        await sleep(rand(30, 80));
      }
      if (def) {
        await this.keyStroke(tabId, def, shift ? MOD.Shift : 0);
      } else {
        if (shift) {
          await shiftKey("keyUp");
          shift = false;
        }
        await this.sendCdp(tabId, "Input.insertText", { text: ch });
      }
      if (i < chars.length - 1) await sleep(keyGap(ch));
    }
    if (shift) await shiftKey("keyUp");
    if (i < chars.length) await this.sendCdp(tabId, "Input.insertText", { text: chars.slice(i).join("") });
  }

  /** One key: down, a human hold, up. Text only when no command modifier is held — Ctrl+A selects,
   *  it does not type an "a". */
  async keyStroke(tabId, def, modifiers, commands) {
    const base = {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      nativeVirtualKeyCode: def.vk,
      modifiers,
    };
    if (def.location) base.location = def.location;
    const typing = def.text && !(modifiers & (MOD.Control | MOD.Meta | MOD.Alt));
    const down = { type: typing ? "keyDown" : "rawKeyDown", ...base };
    if (typing) {
      down.text = def.text;
      down.unmodifiedText = def.text;
    }
    if (commands) down.commands = commands;
    await this.sendCdp(tabId, "Input.dispatchKeyEvent", down);
    await sleep(keyHold());
    await this.sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** "Enter", "Shift+Tab", "Control+a", "Mod+a" (⌘ on a Mac, Ctrl elsewhere): modifiers go down
   *  in order, the key is struck, and they come up in reverse — as fingers do. */
  async pressCombo(tabId, combo) {
    const parsed = parseCombo(combo);
    if (!parsed) throw new ToolError("bad_args", `unknown key "${combo}"`);
    let mods = 0;
    for (const m of parsed.mods) {
      const def = parseCombo(m).key;
      mods |= MOD[m];
      await this.sendCdp(tabId, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.vk,
        nativeVirtualKeyCode: def.vk,
        location: 1,
        modifiers: mods,
      });
      await sleep(rand(30, 90));
    }
    await this.keyStroke(tabId, parsed.key, mods, macCommands(parsed.mods, parsed.key));
    for (const m of [...parsed.mods].reverse()) {
      const def = parseCombo(m).key;
      mods &= ~MOD[m];
      await sleep(rand(20, 60));
      await this.sendCdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.vk,
        nativeVirtualKeyCode: def.vk,
        location: 1,
        modifiers: mods,
      });
    }
  }

  /**
   * CHOSEN WITH THE KEYBOARD FIRST. Setting the property from script fires `input`/`change` events
   * whose `isTrusted` is false — a page can tell. A focused, CLOSED <select> answers typed letters
   * (type-ahead: the whole label, fast, which also crosses spaces) and, off a Mac, arrow keys, and
   * the browser fires trusted events for both. Neither opens the OS-drawn list CDP cannot reach
   * (arrow keys DO open it on a Mac, so there they are never pressed).
   *
   * Every step is CHECKED, never assumed — the failure SELECT_OPTION_FN's note warns about is a
   * keyboard imitation that reports success with the wrong value chosen. If the keyboard cannot
   * land on the option, the scripted path below is the fallback, exactly as before.
   */
  async selectOption(tabId, ref, value) {
    if (!ref) throw new ToolError("bad_args", "ref is required");
    const m = await this.evalFn(tabId, SELECT_OPTION_FN, { ref, value, matchOnly: true });
    this.selectErrors(ref, value, m);
    if (m.current === m.index) return text(`Selected "${m.label}" in ${ref}`);
    if (await this.selectByKeyboard(tabId, ref, m)) return text(`Selected "${m.label}" in ${ref}`);
    const r = await this.evalFn(tabId, SELECT_OPTION_FN, { ref, value });
    this.selectErrors(ref, value, r);
    return text(`Selected "${r.label}" in ${ref}`);
  }

  async selectByKeyboard(tabId, ref, m) {
    const focused = await this.evalFn(tabId, FOCUS_FN, ref).catch(() => null);
    if (!focused || !focused.found) return false;
    const state = async () => {
      const s = await this.evalFn(tabId, SELECT_STATE_FN, ref).catch(() => null);
      return s && s.found ? s.index : null;
    };
    await sleep(rand(120, 300));
    // Type-ahead: the label's printable prefix, inside the browser's one-second window.
    const prefix = [...String(m.label || "")].slice(0, 24);
    if (prefix.length && charKey(prefix[0]) && prefix[0] !== " ") {
      for (const ch of prefix) {
        const def = charKey(ch);
        if (!def) break;
        await this.keyStroke(tabId, def, def.shift ? MOD.Shift : 0);
        await sleep(rand(40, 110));
      }
    }
    let at = await state();
    if (at === m.index) return true;
    if (IS_MAC || at == null) return false;
    for (let step = 0; step < 60 && at !== m.index; step++) {
      await this.pressCombo(tabId, at < m.index ? "ArrowDown" : "ArrowUp");
      await sleep(rand(40, 110));
      const next = await state();
      if (next === at || next == null) return false; // no progress — a disabled run or a page that ate the key
      at = next;
    }
    return at === m.index;
  }

  /** Turn SELECT_OPTION_FN's verdict into the sentence an agent reads. */
  selectErrors(ref, value, r) {
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
  }

  async pressKey(tabId, key) {
    if (!key) throw new ToolError("bad_args", "key is required");
    await this.pressCombo(tabId, key);
    return text(`Pressed ${key}`);
  }

  /** Scroll the document by about `dy` CSS px in wheel notches, then wait for it to come to rest.
   *  Returns the new scroll position. */
  async wheelBy(tabId, dy, vw, vh) {
    const at = this.cursors.get(tabId) || { x: vw * rand(0.35, 0.65), y: vh * rand(0.35, 0.65) };
    this.cursors.set(tabId, at);
    // Whole notches, then the remainder as one smaller delta — a trackpad's last nudge — so a
    // return to a saved position lands on it rather than within a notch of it.
    const steps = new Array(Math.floor(Math.abs(dy) / WHEEL_TICK)).fill(WHEEL_TICK);
    const rest = Math.abs(dy) - steps.length * WHEEL_TICK;
    if (rest >= 2 || !steps.length) steps.push(Math.max(rest, 1));
    for (const step of steps) {
      await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: at.x,
        y: at.y,
        deltaX: 0,
        deltaY: Math.sign(dy) * step,
      });
      await sleep(rand(12, 35));
    }
    // Chrome animates wheel scrolling; capture only once it has stopped.
    let prev = null;
    for (let i = 0; i < 25; i++) {
      await sleep(60);
      const s = await this.evalFn(tabId, SCROLL_STATE_FN).catch(() => null);
      if (!s) return null;
      if (prev != null && Math.abs(s.y - prev) < 0.5) return s.y;
      prev = s.y;
    }
    return prev;
  }

  /**
   * A FULL PAGE IS SCROLLED THROUGH, not resized. `captureBeyondViewport` grows the viewport to
   * the document's height for the capture — the page gets a `resize`, `innerHeight` jumps, media
   * queries and lazy-loaders fire — a thing no person's window does. Instead: wheel to the top,
   * capture a screen, wheel down, capture, …, stitch, and wheel back to where the page was.
   * Falls back to the old capture only when the wheel cannot move the document at all.
   */
  async screenshot(tabId, fullPage, ref) {
    if (ref) {
      const box = await this.locate(tabId, ref);
      const x = Math.max(box.left ?? 0, 0);
      const y = Math.max(box.top ?? 0, 0);
      const w = Math.max(1, Math.min((box.left ?? 0) + (box.w ?? 1), box.vw ?? x + 1) - x);
      const h = Math.max(1, Math.min((box.top ?? 0) + (box.h ?? 1), box.vh ?? y + 1) - y);
      return this.capture(tabId, { clip: { x, y, width: w, height: h, scale: 1 } });
    }
    if (!fullPage) return this.capture(tabId, {});
    const m = await this.evalFn(tabId, SCROLL_STATE_FN).catch(() => null);
    if (!m || !m.vh || m.h <= m.vh + 1) return this.capture(tabId, {});
    const startY = m.y;
    let y = startY > 0 ? await this.wheelBy(tabId, -startY, m.vw, m.vh) : 0;
    if (y == null || y > 1) return this.capture(tabId, { captureBeyondViewport: true });
    const frames = [];
    for (;;) {
      const shot = await this.sendCdp(tabId, "Page.captureScreenshot", { format: "png" });
      if (!shot || !shot.data) throw new ToolError("screenshot_failed", "no image data returned");
      frames.push({ data: shot.data, y });
      if (y + m.vh >= m.h - 1 || frames.length >= this.pace.maxScreens) break;
      const next = await this.wheelBy(tabId, m.vh * rand(0.85, 0.95), m.vw, m.vh);
      if (next == null || next <= y + 0.5) break; // the bottom, or a page that would not scroll
      y = next;
      await sleep(rand(80, 220));
    }
    const back = await this.evalFn(tabId, SCROLL_STATE_FN).catch(() => null);
    if (back && Math.abs(back.y - startY) > 1) await this.wheelBy(tabId, startY - back.y, m.vw, m.vh);
    if (frames.length === 1 && m.h > m.vh + 1) {
      // The wheel reached nothing — an inner scroller under the pointer. One frame of a long page
      // would be a quiet lie about what "full page" returned.
      return this.capture(tabId, { captureBeyondViewport: true });
    }
    const data = frames.length === 1 ? frames[0].data : await this.stitch(frames, m.vh);
    if (data) return { content: [{ type: "image", data, mimeType: "image/png" }] };
    return { content: frames.map((f) => ({ type: "image", data: f.data, mimeType: "image/png" })) };
  }

  /** Overridable for tests; null when there is no canvas (Node), and the frames go back as-is. */
  stitch(frames, vh) {
    return stitchFrames(frames, vh);
  }

  async capture(tabId, extra) {
    const res = await this.sendCdp(tabId, "Page.captureScreenshot", { format: "png", ...extra });
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
    if (url) {
      this.lastNav.set(created.id, Date.now());
      await this.waitForLoad(created.id, Math.min(deadlineMs || 30000, 30000), true);
      await sleep(rand(...this.pace.settle));
    }
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
    this.forgetTab(rec.chromeTabId);
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
      this.forgetTab(rec.chromeTabId);
      this.tabIndex.delete(rec.chromeTabId);
      session.tabs.delete(handle);
    }
    this.sessions.delete(sessionId);
    this.pushStatus(this.anyAttached(), null, null, "session_closed");
  }
}

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
import { SNAPSHOT_FN, RESOLVE_BOX_FN, FOCUS_FN, SELECT_ALL_FN } from "./page-scripts.js";

const PROTOCOL = "1.3";
const DEFAULT_SESSION = "default";

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

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Executor {
  /** @param {(attached: boolean, tabId: number|null, url: string|null, reason?: string) => void} pushStatus */
  constructor(pushStatus) {
    this.pushStatus = pushStatus;
    // sessionId -> { id, tabs: Map<handle,{chromeTabId,attached,url}>, activeTab, seq }
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
      s = { id, tabs: new Map(), activeTab: null, seq: 0 };
      this.sessions.set(id, s);
    }
    return s;
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

  /** Find the active usable tab and adopt it into the default session (back-compat:
   *  header-less callers with no explicit tab drive the current window like before). */
  async adoptActiveTab(session) {
    const tabs = await chrome.tabs.query({});
    const usable = (t) =>
      t.id != null &&
      t.url &&
      !t.url.startsWith("chrome://") &&
      !t.url.startsWith("devtools://") &&
      !this.tabIndex.has(t.id); // not already owned by some session
    const cand = tabs.find((t) => t.active && usable(t)) || tabs.find(usable);
    if (!cand) return null;
    const handle = this.registerTab(session, cand.id, cand.url);
    return { handle, chromeTabId: cand.id };
  }

  /** Resolve args.tab (or the session's active tab) to an owned chrome tab. Opens a
   *  fresh tab if the session has none yet. Throws if the handle isn't owned. */
  async resolveOwnedTab(session, tab) {
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
    if (session.id === DEFAULT_SESSION) {
      const adopted = await this.adoptActiveTab(session);
      if (adopted) return adopted;
    }
    const created = await chrome.tabs.create({ url: "about:blank", active: true });
    const handle = this.registerTab(session, created.id, "about:blank");
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
    if (rec) rec.attached = true;
    const info = await chrome.tabs.get(chromeTabId).catch(() => null);
    if (rec && info) rec.url = info.url;
    this.pushStatus(true, chromeTabId, info ? info.url : null);
    return chromeTabId;
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

    // Action commands run against one owned tab, serialized per tab.
    const { handle, chromeTabId } = await this.resolveOwnedTab(session, a.tab);
    return this.withTabLock(chromeTabId, async () => {
      await this.ensureAttached(chromeTabId);
      switch (name) {
        case "browser_navigate":
          return this.navigate(session, handle, chromeTabId, a.url, deadlineMs);
        case "browser_snapshot":
          return this.snapshot(chromeTabId);
        case "browser_click":
          return this.click(chromeTabId, a.ref, a.element);
        case "browser_type":
          return this.type(chromeTabId, a.ref, a.text, a.submit, a.slowly, a.append);
        case "browser_press_key":
          return this.pressKey(chromeTabId, a.key);
        case "browser_take_screenshot":
          return this.screenshot(chromeTabId, a.fullPage);
        case "browser_wait_for":
          return this.waitFor(chromeTabId, a, deadlineMs);
        default:
          throw new ToolError("unknown_tool", `unknown tool: ${name}`);
      }
    });
  }

  // ── commands ─────────────────────────────────────────────────────────────────
  async navigate(session, handle, tabId, url, deadlineMs) {
    if (!url) throw new ToolError("bad_args", "url is required");
    await this.sendCdp(tabId, "Page.navigate", { url });
    await this.waitForLoad(tabId, Math.min(deadlineMs || 30000, 30000));
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

  async snapshot(tabId) {
    const tree = await this.evalFn(tabId, SNAPSHOT_FN);
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
    const created = await chrome.tabs.create({ url: url || "about:blank", active: true });
    const handle = this.registerTab(session, created.id, url || "about:blank");
    await this.withTabLock(created.id, () => this.ensureAttached(created.id));
    if (url) await this.waitForLoad(created.id, Math.min(deadlineMs || 30000, 30000), true);
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

// Executes browser commands against the agent tab via chrome.debugger (CDP).
// Owns target-tab resolution, lazy debugger attach (so the "started debugging"
// infobar isn't re-shown on every idle/eviction cycle), and the mapping of each
// mirrored Playwright tool name to CDP commands.
import { SNAPSHOT_FN, RESOLVE_BOX_FN, FOCUS_FN, SELECT_ALL_FN } from "./page-scripts.js";

const PROTOCOL = "1.3";

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
    this.attached = false;
    this.attachedTabId = null;
  }

  // ── lifecycle hooks (wired to chrome.* events in sw.js) ─────────────────────
  onDetach(source, reason) {
    if (source && source.tabId === this.attachedTabId) {
      this.attached = false;
      // Don't auto-reattach: if the user hit the infobar "Cancel" (reason
      // "canceled_by_user") the next command reattaches and re-shows the bar.
      this.pushStatus(false, this.attachedTabId, null, reason);
    }
  }

  onTabRemoved(tabId) {
    if (tabId === this.attachedTabId) {
      this.attached = false;
      this.attachedTabId = null;
      chrome.storage.local.remove(["attachedTabId", "attachedTabUrl"]);
      this.pushStatus(false, null, null, "tab_closed");
    }
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

  async resolveTabId() {
    let tabId = this.attachedTabId;
    if (tabId != null) {
      try {
        await chrome.tabs.get(tabId);
        return tabId;
      } catch (e) {
        tabId = null;
      }
    }
    const { attachedTabUrl } = await chrome.storage.local.get("attachedTabUrl");
    const tabs = await chrome.tabs.query({});
    const usable = (t) => t.id != null && t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://");
    let cand = attachedTabUrl ? tabs.find((t) => t.url === attachedTabUrl && usable(t)) : null;
    if (!cand) cand = tabs.find((t) => t.active && usable(t));
    if (!cand) cand = tabs.find(usable);
    if (cand) return cand.id;
    const created = await chrome.tabs.create({ url: "about:blank" });
    return created.id;
  }

  async ensureAttached(targetTabId) {
    const tabId = targetTabId != null ? targetTabId : await this.resolveTabId();
    if (this.attached && this.attachedTabId === tabId) return tabId;
    if (this.attached && this.attachedTabId != null && this.attachedTabId !== tabId) {
      try {
        await new Promise((r) => chrome.debugger.detach({ tabId: this.attachedTabId }, () => r()));
      } catch (e) {}
    }
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, PROTOCOL, () => {
        const err = chrome.runtime.lastError;
        if (err && !/already attached/i.test(err.message)) reject(new Error(err.message));
        else resolve();
      });
    });
    this.attached = true;
    this.attachedTabId = tabId;
    await this.sendCdp(tabId, "Page.enable", {});
    await this.sendCdp(tabId, "Runtime.enable", {});
    const info = await chrome.tabs.get(tabId).catch(() => null);
    await chrome.storage.local.set({ attachedTabId: tabId, attachedTabUrl: info ? info.url : null });
    this.pushStatus(true, tabId, info ? info.url : null);
    return tabId;
  }

  // ── command dispatch ─────────────────────────────────────────────────────────
  async execute(name, args, deadlineMs) {
    if (name === "bridge_ping") return text("pong");

    if (name === "browser_tab_list") return this.tabList();
    if (name === "browser_tab_new") return this.tabNew(args.url);
    if (name === "browser_tab_close") return this.tabClose(args.index);

    const tabId = await this.ensureAttached();
    switch (name) {
      case "browser_navigate":
        return this.navigate(tabId, args.url, deadlineMs);
      case "browser_snapshot":
        return this.snapshot(tabId);
      case "browser_click":
        return this.click(tabId, args.ref, args.element);
      case "browser_type":
        return this.type(tabId, args.ref, args.text, args.submit, args.slowly, args.append);
      case "browser_press_key":
        return this.pressKey(tabId, args.key);
      case "browser_take_screenshot":
        return this.screenshot(tabId, args.fullPage);
      case "browser_wait_for":
        return this.waitFor(tabId, args, deadlineMs);
      default:
        throw new ToolError("unknown_tool", `unknown tool: ${name}`);
    }
  }

  // ── commands ─────────────────────────────────────────────────────────────────
  async navigate(tabId, url, deadlineMs) {
    if (!url) throw new ToolError("bad_args", "url is required");
    await this.sendCdp(tabId, "Page.navigate", { url });
    await this.waitForLoad(tabId, Math.min(deadlineMs || 30000, 30000));
    const info = await chrome.tabs.get(tabId).catch(() => null);
    await chrome.storage.local.set({ attachedTabUrl: info ? info.url : url });
    return text(`Navigated to ${url}\nFinal URL: ${info ? info.url : url}\nTitle: ${info ? info.title : ""}`);
  }

  async waitForLoad(tabId, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ready = await this.evalFn(tabId, function () {
          return document.readyState;
        });
        if (ready === "complete") return;
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

  // ── tabs ─────────────────────────────────────────────────────────────────────
  async tabList() {
    const tabs = await chrome.tabs.query({});
    const lines = tabs.map(
      (t, i) => `${i}: ${t.active ? "*" : " "} ${t.title || "(untitled)"} — ${t.url || ""}`
    );
    return text(lines.join("\n") || "(no tabs)");
  }

  async tabNew(url) {
    const created = await chrome.tabs.create({ url: url || "about:blank", active: true });
    await this.ensureAttached(created.id);
    if (url) await this.waitForLoad(created.id, 30000);
    const info = await chrome.tabs.get(created.id).catch(() => null);
    return text(`Opened tab — ${info ? info.url : url || "about:blank"}`);
  }

  async tabClose(index) {
    const tabs = await chrome.tabs.query({});
    let target;
    if (index != null) target = tabs[index];
    else target = tabs.find((t) => t.id === this.attachedTabId) || tabs.find((t) => t.active);
    if (!target) throw new ToolError("no_tab", "no tab to close");
    await chrome.tabs.remove(target.id);
    return text(`Closed tab ${index != null ? index : "(active)"}`);
  }
}

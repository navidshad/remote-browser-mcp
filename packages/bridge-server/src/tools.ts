// The browser tool surface, mirroring Playwright MCP's tool names + input
// schemas so the VM agent's CONTRACT.md is a near drop-in. The bridge is a dumb
// forwarder: each tool just hands its args to the extension over the WS and
// returns whatever comes back. Execution (chrome.debugger / CDP) lives in the
// extension.
import { z } from "zod";

export interface BridgeTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** Per-tool timeout. Navigation / waits get longer budgets. */
  timeoutMs: number;
}

/** Optional per-command tab handle. Omit to use the session's active tab. Every
 *  action tool accepts this so an agent can drive several tabs concurrently. */
const tabArg = {
  tab: z
    .string()
    .optional()
    .describe("Tab handle from browser_tab_new (e.g. 't2'); defaults to this session's active tab"),
};

export const BROWSER_TOOLS: BridgeTool[] = [
  {
    name: "bridge_ping",
    description:
      "No-op round-trip to the connected browser extension. Returns 'pong' if the " +
      "extension is connected and responsive. Useful for health checks.",
    schema: {},
    timeoutMs: 5_000,
  },
  {
    name: "browser_navigate",
    description:
      "Navigate a tab to a URL and wait for it to load. Targets the tab handle given " +
      "in `tab`, or the session's active tab if omitted (opening one if none exist).",
    schema: { url: z.string().describe("The absolute URL to navigate to"), ...tabArg },
    timeoutMs: 60_000,
  },
  {
    name: "browser_snapshot",
    description:
      "Capture an accessibility snapshot of a tab as text. Interactable elements are " +
      "tagged with [ref=eNN] ids you pass to browser_click / browser_type. Refs are only " +
      "valid for the latest snapshot OF THAT TAB — re-snapshot after navigation or DOM changes. " +
      "Pass `find` or `ref` to read one part of a large page instead of all of it.",
    schema: {
      // Narrowing filters what comes BACK, never what is reachable: every element still gets a
      // ref, so one you were not shown still works. `ref` wins if both are given.
      find: z
        .string()
        .optional()
        .describe("Only return lines containing this text (case-insensitive). Says how many of how many matched."),
      ref: z.string().optional().describe("Only return this one element's line"),
      ...tabArg,
    },
    timeoutMs: 30_000,
  },
  {
    name: "browser_click",
    description: "Click an element identified by its ref from that tab's latest browser_snapshot.",
    schema: {
      element: z.string().describe("Human-readable description of the element (for logging)"),
      ref: z.string().describe("The element's [ref=eNN] id from the latest snapshot"),
      ...tabArg,
    },
    timeoutMs: 30_000,
  },
  {
    name: "browser_type",
    description:
      "Type text into an editable element identified by its ref from that tab's latest snapshot. " +
      "Replaces any existing content by default; pass append:true to keep it.",
    schema: {
      element: z.string().describe("Human-readable description of the element (for logging)"),
      ref: z.string().describe("The element's [ref=eNN] id from the latest snapshot"),
      text: z.string().describe("The text to type"),
      submit: z.boolean().optional().describe("Press Enter after typing"),
      slowly: z
        .boolean()
        .optional()
        .describe(
          "Type every key, however long the text. By default typing is keystrokes too, but text " +
            "past about 15 seconds of typing is inserted at once to stay inside the deadline"
        ),
      append: z
        .boolean()
        .optional()
        .describe("Append to existing content instead of replacing it (default: replace)"),
      ...tabArg,
    },
    timeoutMs: 30_000,
  },
  {
    name: "browser_select_option",
    description:
      "Choose an option in a native <select> dropdown. Give the option's visible text; an exact " +
      "match wins over a substring, and a substring matching two options is refused by name. " +
      "A dropdown a site drew itself out of <div>s is NOT a <select> — click it, take a fresh " +
      "snapshot, then click the option.",
    // No `element` arg, unlike click and type: those pass it only so the extension's overlay can
    // caption what is happening, and this action captions itself with the chosen value.
    schema: {
      ref: z.string().describe("The <select>'s [ref=eNN] id from the latest snapshot"),
      value: z.string().describe("The option's visible text (its value attribute also matches)"),
      ...tabArg,
    },
    timeoutMs: 30_000,
  },
  {
    name: "browser_press_key",
    description:
      "Press a key or shortcut on the focused element of a tab: a key name (Enter, Tab, Escape, " +
      "ArrowDown, F5, a), or modifiers joined with '+' (Shift+Tab, Control+a). 'Mod' is the " +
      "platform's command key — ⌘ on a Mac, Ctrl elsewhere — so 'Mod+a' selects all on both.",
    schema: {
      key: z.string().describe("Key or shortcut, e.g. 'Enter', 'ArrowDown', 'Shift+Tab', 'Mod+a'"),
      ...tabArg,
    },
    timeoutMs: 15_000,
  },
  {
    name: "browser_take_screenshot",
    description: "Take a PNG screenshot of a tab (or a single element if a ref is given).",
    schema: {
      ref: z.string().optional().describe("Screenshot only this element (ref from latest snapshot)"),
      element: z.string().optional().describe("Human-readable description of the element (for logging)"),
      fullPage: z.boolean().optional().describe("Capture the full scrollable page"),
      ...tabArg,
    },
    timeoutMs: 30_000,
  },
  {
    name: "browser_wait_for",
    description: "Wait for text to appear/disappear on a tab's page, or for a fixed time.",
    schema: {
      text: z.string().optional().describe("Wait until this text appears"),
      textGone: z.string().optional().describe("Wait until this text disappears"),
      time: z.number().optional().describe("Wait this many seconds"),
      ...tabArg,
    },
    timeoutMs: 60_000,
  },
  {
    name: "browser_tab_list",
    description: "List this session's tabs with their handles, titles, and URLs (active tab marked *).",
    schema: {},
    timeoutMs: 10_000,
  },
  {
    name: "browser_tab_new",
    description:
      "Open a new tab (optionally at a URL), make it the active tab, and return its stable " +
      "handle (e.g. 't2'). Pass that handle as `tab` to other tools to drive this tab — open " +
      "several and batch tool calls across different tabs to work on them in parallel.",
    schema: { url: z.string().optional().describe("URL to open in the new tab") },
    timeoutMs: 60_000,
  },
  {
    name: "browser_tab_select",
    description: "Set the session's active tab (the default target when `tab` is omitted).",
    schema: { tab: z.string().describe("Tab handle from browser_tab_new / browser_tab_list") },
    timeoutMs: 10_000,
  },
  {
    name: "browser_tab_close",
    description: "Close one of this session's tabs by its handle (defaults to the active tab).",
    schema: { tab: z.string().optional().describe("Tab handle to close (default: active tab)") },
    timeoutMs: 10_000,
  },
];

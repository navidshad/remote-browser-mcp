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
    description: "Navigate the agent browser tab to a URL. Waits for the page to load.",
    schema: { url: z.string().describe("The absolute URL to navigate to") },
    timeoutMs: 60_000,
  },
  {
    name: "browser_snapshot",
    description:
      "Capture an accessibility snapshot of the current page as text. Interactable " +
      "elements are tagged with [ref=eNN] ids you pass to browser_click / browser_type. " +
      "Refs are only valid for the latest snapshot — re-snapshot after navigation or DOM changes.",
    schema: {},
    timeoutMs: 30_000,
  },
  {
    name: "browser_click",
    description: "Click an element identified by its ref from the latest browser_snapshot.",
    schema: {
      element: z.string().describe("Human-readable description of the element (for logging)"),
      ref: z.string().describe("The element's [ref=eNN] id from the latest snapshot"),
    },
    timeoutMs: 30_000,
  },
  {
    name: "browser_type",
    description:
      "Type text into an editable element identified by its ref from the latest snapshot. " +
      "Replaces any existing content by default; pass append:true to keep it.",
    schema: {
      element: z.string().describe("Human-readable description of the element (for logging)"),
      ref: z.string().describe("The element's [ref=eNN] id from the latest snapshot"),
      text: z.string().describe("The text to type"),
      submit: z.boolean().optional().describe("Press Enter after typing"),
      slowly: z
        .boolean()
        .optional()
        .describe("Type one key at a time (fires per-key handlers) instead of inserting at once"),
      append: z
        .boolean()
        .optional()
        .describe("Append to existing content instead of replacing it (default: replace)"),
    },
    timeoutMs: 30_000,
  },
  {
    name: "browser_press_key",
    description: "Press a single key (e.g. Enter, Tab, Escape, ArrowDown) on the focused element.",
    schema: { key: z.string().describe("Key name, e.g. 'Enter', 'Tab', 'ArrowDown'") },
    timeoutMs: 15_000,
  },
  {
    name: "browser_take_screenshot",
    description: "Take a PNG screenshot of the current page (or a single element if a ref is given).",
    schema: {
      ref: z.string().optional().describe("Screenshot only this element (ref from latest snapshot)"),
      element: z.string().optional().describe("Human-readable description of the element (for logging)"),
      fullPage: z.boolean().optional().describe("Capture the full scrollable page"),
    },
    timeoutMs: 30_000,
  },
  {
    name: "browser_wait_for",
    description: "Wait for text to appear/disappear on the page, or for a fixed time.",
    schema: {
      text: z.string().optional().describe("Wait until this text appears"),
      textGone: z.string().optional().describe("Wait until this text disappears"),
      time: z.number().optional().describe("Wait this many seconds"),
    },
    timeoutMs: 60_000,
  },
  {
    name: "browser_tab_list",
    description: "List the tabs in the agent browser profile.",
    schema: {},
    timeoutMs: 10_000,
  },
  {
    name: "browser_tab_new",
    description: "Open a new tab (optionally at a URL) and make it the active agent tab.",
    schema: { url: z.string().optional().describe("URL to open in the new tab") },
    timeoutMs: 60_000,
  },
  {
    name: "browser_tab_close",
    description: "Close a tab by its index from browser_tab_list (defaults to the active tab).",
    schema: { index: z.number().optional().describe("Tab index to close") },
    timeoutMs: 10_000,
  },
];

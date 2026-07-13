# Plan — Custom Browser MCP Extension (Aso profile)

> Brief to start a fresh chat. Goal: let the remote VM agent drive **Navid's real
> Aso Dara Chrome profile** (real logins) reliably, without a focused window,
> without debug ports/flags.

## Why we're pivoting

The current path (Playwright MCP `--cdp-endpoint` → dedicated debug Chrome on :9222,
managed by pm2) **doesn't meet the need**:

- It drives a throwaway `~/.rbm-chrome-debug` profile that **isn't logged into the
  accounts** (Reddit/LinkedIn/etc.) — so the agent can browse but can't act as Aso.
- The earlier extension path (official *Playwright MCP Bridge*) only connected when
  the Aso **window was focused** at connect time → useless for autonomous VM wakes.

Building **our own MV3 extension** is the only approach that hits all three:
real logged-in Aso profile · works unfocused/background · no `--remote-debugging-port`,
no separate profile.

## Target architecture

```
VM agent ──MCP (Streamable HTTP)──> Cloudflare tunnel ──> local MCP relay (Node, :3000)
                                                            ▲  WebSocket, extension dials OUT
                                                            │  (no inbound to Chrome, no focus needed)
                                              Chrome extension (MV3), installed ONLY in Aso profile
                                                            │  chrome.debugger (in-process CDP)
                                                            ▼
                                                   Aso Dara tab (real cookies/logins)
```

Reuse as-is: the Cloudflare **tunnel + Access** (just repoint the `browser` hostname
at the new relay port) and the **daemon** `check_local_status` (redefine "ready" =
extension is connected to the relay). pm2 manages the relay. **Retire** `rbm-chrome`,
`rbm-chrome-guard`, and the CDP debug Chrome — no longer needed once the extension
lives in the user's normally-open Aso window.

## Components to build

1. **`packages/browser-mcp` (Node relay + MCP server)**
   - Streamable HTTP MCP server exposing browser tools (same transport the agent
     already speaks). Ideally mirror Playwright MCP's tool names/schemas so the VM
     agent's CONTRACT barely changes.
   - WebSocket server the extension connects to; bridges MCP tool call → WS command
     → result. Shared token auth so only our extension can attach.
2. **`packages/extension` (MV3 Chrome extension)**
   - Service worker: persistent **outbound** WebSocket to the relay; reconnect loop
     + `chrome.alarms` heartbeat to stay reachable while idle/unfocused (this is the
     make-or-break piece — see risks).
   - Executes commands via **`chrome.debugger`** (DevTools Protocol attached to a tab
     *inside the profile* — full navigate/click/type/screenshot, no debug port).
   - Status/popup page: connection state + token to paste into the relay config.

## Tool surface (minimum the agent needs)

`navigate`, `snapshot`/`get_page_text`, `click`, `type`, `screenshot`,
`tabs` (list/new/close), `wait`. Map each to `chrome.debugger` CDP commands
(`Page.navigate`, `Input.*`, `DOM`/`Runtime`, `Page.captureScreenshot`).

## Milestones

- **M0 — Skeleton:** scaffold relay + extension; WS handshake w/ token; status page
  shows "connected". Extension loaded in Aso profile only.
- **M1 — First tool:** `navigate` + `get_page_text` end-to-end, local
  (agent/test client → relay → extension → Aso tab → back).
- **M2 — Full toolset:** click/type/screenshot/tabs/wait via `chrome.debugger`.
- **M3 — Keepalive hardening (THE risk):** prove the SW stays reachable unfocused
  for hours (idle eviction handled). Dedicated test: leave window background, poll
  from VM every N min.
- **M4 — Productionize:** route through tunnel + Access; daemon presence = "extension
  connected"; pm2-manage the relay; remove CDP apps from `ecosystem.config.cjs`.
- **M5 — Live:** update VM agent CONTRACT; full agent→Aso run with a logged-in action.

## Decide first (in the new chat)

1. **Control API:** `chrome.debugger` (full CDP fidelity — recommended; note the
   "started debugging this browser" infobar tradeoff) vs `chrome.scripting`+content
   scripts (no banner, weaker on complex/cross-origin sites). **Recommend
   `chrome.debugger`.**
2. **Reuse Playwright MCP tool schemas?** Yes if we want near-zero CONTRACT churn on
   the VM.
3. **MV3 keepalive strategy** — settle the WS-keepalive + `chrome.alarms` approach up
   front; it's the whole reason this beats the Playwright MCP Bridge.

## First steps for the new chat

1. Confirm decision #1 (control API).
2. Scaffold `packages/extension` (MV3 manifest, service worker) + `packages/browser-mcp`
   (MCP server + WS bridge).
3. Land M0 (token handshake + "connected" status) before any browser tool.

## Pointers (current repo)

- `ecosystem.config.cjs` / `scripts/rbm-chrome*.sh` — the CDP setup to retire.
- `packages/daemon/src/status.ts` — `check_local_status` probe to redefine.
- `packages/agent/src/smoke-test.ts` — connection pattern to reuse for a local test client.
- `SETUP-LOG.md` — tunnel + Access + Aso-profile facts (token in gitignored `scripts/.rbm-env`).

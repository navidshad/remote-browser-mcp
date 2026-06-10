# Remote Browser MCP

Give an AI agent running on a remote VM (e.g. AWS) control of a **real Chrome on your local machine** through the Model Context Protocol — reusing your real logins, cookies, extensions, and home IP, while you can watch and take over at any time.

This is an **assembly**, not a from-scratch build. Browser control comes from the official [Playwright MCP](https://github.com/microsoft/playwright-mcp); the cloud→local tunnel comes from Cloudflare Tunnel. What we add is a thin **daemon** (presence detection + a desktop notification when a session starts) and a **terminal agent** that ties it together.

See [PRD.md](PRD.md) for the full design rationale.

## Architecture

```
AI agent (terminal app)  ──────────────┐   in dev: runs inside a Docker container
  on the AWS VM                         │           that mocks the AWS VM
                                        │  MCP over Streamable HTTP → public tunnel URLs
                                        v
                          Cloudflare Tunnel (public URL)
                                        ^  outbound-only, dialed from the local machine
                                        │
  Local machine (your laptop):         │
    • cloudflared (dials out)          │
    • Playwright MCP   :3000  ─────────┘   browser tools (navigate/click/type/screenshot)
    • daemon           :3001               presence + notifications
        │  CDP
        v
    Chrome (your real window & profile)
```

The agent always reaches the browser **over the network**, never on localhost — in dev as well as prod — so the Docker container reproduces the real NAT path on a single machine.

## Packages

| Path | What it is |
|---|---|
| [`packages/daemon`](packages/daemon) | The MCP sidecar we build. Exposes `check_local_status`; fires a macOS notification (terminal print elsewhere) when a session starts. Never sits in the browser traffic path. |
| [`packages/agent`](packages/agent) | The terminal agent (mock of the AWS-VM client). Connects to the daemon + Playwright MCP and runs a tool-use loop. The LLM brain is pluggable ([`src/llm`](packages/agent/src/llm)) — **Gemini** by default, Anthropic optional. Includes a no-API-key `smoke` test. |
| [`docker/`](docker) | `Dockerfile.agent` — the agent as a container (mock AWS VM). |
| [`scripts/start-local.sh`](scripts/start-local.sh) | Brings up all host services + Cloudflare tunnels. |

## Prerequisites

- **Node.js 22+**
- **Google Chrome**
- **Docker** (for the M2 mock-VM flow)
- **cloudflared** — `brew install cloudflared` (for the tunnel; M2+)
- **A Gemini API key** — `export GEMINI_API_KEY=...` (the default LLM provider). To use Claude instead, set `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=...`.

## Quick start

```bash
make install
make build
```

### One-time Chrome setup (channel mode — the v1 default)

1. Open Chrome.
2. Visit `chrome://inspect/#remote-debugging`.
3. Enable **"Allow remote debugging for this browser instance."**

This is the Chrome-136-sanctioned way to debug your everyday browser. No launch flags, no separate profile — the agent inherits all your existing logins.

> **Fallback (CDP-port mode)** if channel mode is ever blocked: launch a dedicated debuggable Chrome instead:
> ```bash
> "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
>   --remote-debugging-port=9222 --user-data-dir=/tmp/rbm-chrome-debug
> ```

## Milestones — how to run each

### M1 — Browser end-to-end, local (no tunnel)

Prove the agent can drive your real Chrome on one machine.

```bash
# Terminal 1: daemon + Playwright MCP on the host
make start-local          # or, without tunnels: see scripts/start-local.sh

# Terminal 2: verify the whole path with no API key needed
npm run smoke --workspace=packages/agent
```

Expected smoke-test output:

```
Daemon:
  ✓ connected to http://localhost:3001/mcp
  ✓ check_local_status tool present
  ✓ machine reported online
Playwright MCP:
  ✓ connected to http://localhost:3000
  ✓ browser tools present (23 tools)
Browser drive:
  ✓ navigated to https://example.com
✓ All checks passed.
```

Then drive the browser with the LLM. The `live` script runs one task end-to-end
(handy for a quick check); `start` is the interactive REPL:

```bash
# One-shot live task (uses GEMINI_API_KEY from your environment / .env)
GEMINI_API_KEY=... \
DAEMON_URL=http://localhost:3001/mcp PLAYWRIGHT_URL=http://localhost:3000 \
TASK="Open a new tab, go to example.com, and tell me the page title." \
npm run live --workspace=packages/agent

# Interactive REPL
GEMINI_API_KEY=... \
DAEMON_URL=http://localhost:3001/mcp \
PLAYWRIGHT_URL=http://localhost:3000 \
npm run start --workspace=packages/agent
```

The agent runs a tool-use loop: it calls `check_local_status`, opens a new tab,
navigates, and reports back. Switch the brain with `LLM_PROVIDER=anthropic` (and
`ANTHROPIC_API_KEY`); override the model with `MODEL=...`.

### M2 — Tunnel + Docker mock VM (the real NAT path)

```bash
# Terminal 1: host services + Cloudflare tunnels
make start-local
```

`cloudflared` prints two `https://*.trycloudflare.com` URLs — one for Playwright MCP (:3000), one for the daemon (:3001). Put them in `.env`:

```bash
cp .env.example .env
# Edit .env:
#   PLAYWRIGHT_URL=https://<playwright>.trycloudflare.com
#   DAEMON_URL=https://<daemon>.trycloudflare.com/mcp
#   GEMINI_API_KEY=...
```

```bash
# Terminal 2: run the agent inside the container, reaching the host ONLY via tunnel
make docker-up
```

The container has no browser and no localhost access to the host — exactly like the production AWS VM. If you point it at `http://localhost:...` instead of the tunnel, it fails to connect: that failure *is* the NAT problem this product solves.

### M3 — Daemon (presence + notification)

Built into the daemon. `check_local_status` reports three states; when the agent starts a session it calls it with `notify=true`, firing a native macOS notification (a terminal print on other OSes). The agent calls this automatically before its first browser command.

### M4 — Hardening & human handoff

Because the Chrome window is on **your** screen, you can grab the mouse/keyboard and take over at any time — for captchas, strict bot checks, or sensitive logins. The agent pauses, you finish the step, the agent continues in the same window. The agent also: retries the Playwright connection on the first browser command, surfaces a clear "machine offline" error if the daemon/tunnel is unreachable, and notifies you on every session start so a live session is never silent.

## `check_local_status` states

| `online` | `chrome_running` | `chrome_debug_accessible` | Meaning |
|:--:|:--:|:--:|---|
| true | true  | true  | Ready — agent can drive the browser |
| true | true  | false | Chrome open but debugging not enabled → enable at `chrome://inspect` |
| true | false | false | Machine up, Chrome closed → open Chrome |
| (unreachable) | — | — | Tunnel/daemon down → agent treats as offline |

## Security notes

- The Cloudflare Tunnel public URL should be protected (token / Cloudflare Access) before real use.
- Channel mode opens **no** network debug port; the remote-debugging opt-in is per-instance and local-only.
- The daemon never logs page content or screenshots.
- **`--allowed-hosts`:** Playwright MCP rejects requests whose `Host` header isn't its bound host (DNS-rebinding protection), which a tunnel trips with a `403`. `start-local.sh` passes `--allowed-hosts '*'` so the changing `trycloudflare.com` URL is accepted, relying on the authenticated tunnel as the security boundary. Pin a specific host with `PLAYWRIGHT_ALLOWED_HOSTS=...` once you have a stable tunnel URL.

## Troubleshooting

- **`Browser context management is not supported`** (from a browser tool) — Playwright is attached to Chrome over CDP and the browser has no usable page/window (e.g. its last tab was closed, leaving 0 page targets). Make sure Chrome has at least one normal window open, then retry. With **channel mode** against your everyday Chrome this is rare (you always have windows open); it mostly bites a minimal dedicated debug profile. A clean reset: close the debug Chrome, delete its `--user-data-dir`, relaunch with a real URL, and restart Playwright MCP.
- **`check_local_status` says debugging isn't accessible** — enable it at `chrome://inspect/#remote-debugging` (channel mode) or launch Chrome with `--remote-debugging-port=9222` (CDP-port mode).
- **`403` from Playwright MCP through the tunnel** — see the `--allowed-hosts` note above.

## Make targets

```
make install        Install all dependencies
make build          Build all packages
make start-local    Start host services + Cloudflare tunnels (M2)
make docker-up      Run the agent in a container, mock AWS VM (M2)
make docker-down    Stop the container
make dev-daemon     Watch-mode daemon
make clean          Remove build artifacts
```

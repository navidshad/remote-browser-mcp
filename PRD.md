# PRD — Remote Browser MCP

**Status:** Draft v2 (reframed: assemble, don't build)
**Owner:** Navid
**Last updated:** June 10, 2026

---

## 1. Summary

An AI agent running on an AWS VM has no real browser. It cannot log in to sites, click through pages, or act like a human on the web. This product gives the agent a real browser — the user's own Chrome on their local machine — through an MCP (Model Context Protocol) interface.

**Key reframing from v1:** we do not build the browser tooling from scratch. Most of the system already exists:

- **Browser control** is provided by the official Playwright MCP, which can attach to the user's real, running Chrome over CDP (and reuse its logins, cookies, and extensions).
- **The cloud-to-local tunnel** is provided by an existing dial-out MCP tunnel (mcp-use tunnel, Cloudflare Tunnel, or ngrok), which solves the NAT problem with an outbound-only connection.

What we actually build is a thin daemon: presence detection (is the machine online?), an OS notification when a session starts, and a documented human-handoff flow. The rest is assembly and configuration.

## 2. Problem

- The agent on AWS cannot reach the local machine directly (NAT, firewall, changing home IP).
- Headless or datacenter browsers are easily blocked by websites and have no logged-in sessions.
- The user wants the agent to act through their real browser, with their real identity and logins, while still being able to see and take over what the agent is doing.

## 3. Goals

- Let the AWS agent drive a real Chrome on the user's local machine through MCP tools.
- Reuse existing, maintained components wherever possible; write as little custom code as possible.
- Keep the connection working without the user opening any inbound ports (local machine dials out).
- Persist the browser profile so logins survive across sessions and reboots.
- Make the browser look like a normal human browser to websites (real fingerprint, home IP).
- Notify the user whenever a session starts, and let them watch or take over.
- Tell the agent whether the local machine is online before it tries to use the browser.
- Mirror the production topology in local development using a Docker container as the mock AWS VM.

## 4. Non-goals (v1)

- Building our own navigate/click/type/screenshot tools (Playwright MCP already provides these).
- Building our own tunnel transport (we use an existing one).
- Supporting multiple local machines per user (v1 = one machine).
- Live video streaming of the browser to the agent (v1 uses screenshots on demand).
- A required "approve each session" flow (v1 = auto-start + notify; approval mode is a v2 setting).
- A polished tray-icon UI (v1 = notifications only).
- Native notifications on non-macOS hosts (v1 supports macOS; other OSes get a terminal print instead).

## 5. Users

- **Primary:** the user themselves — a developer running an agent on AWS who wants it to use their browser.
- **The agent:** a terminal app (terminal UI) that acts as the MCP client on the AWS VM, run via `npx` or a cloned repo.

## 6. Component map (what is bought vs built)

| Layer | Source | Status |
|---|---|---|
| Browser tools (navigate, click, type, screenshot, etc.) | Official Playwright MCP (`@playwright/mcp`) | Off-the-shelf |
| Attach to real Chrome over CDP | Playwright MCP `--cdp-endpoint` mode | Off-the-shelf |
| Real-profile takeover (SSO/2FA, existing tabs) | Playwright MCP `--extension` mode | Off-the-shelf (v2 upgrade) |
| Cloud-to-local tunnel (outbound, NAT-safe) | mcp-use tunnel / Cloudflare Tunnel / ngrok | Off-the-shelf |
| Presence check (`check_local_status`) | Custom daemon | **Build** |
| Desktop notification on session start | Custom daemon (native OS notifications) | **Build** |
| Human-handoff flow + docs | Custom (mostly documentation) | **Build** |
| Local dev mock of AWS VM | Docker container running the agent | **Build (dev only)** |

## 7. Architecture

```
AI agent — terminal app (run via npx or cloned repo) on AWS VM
            in dev: same terminal app, run inside a Docker container
      |  MCP over Streamable HTTP, to the tunnel's public URL
      v
Cloudflare Tunnel (public URL)
      ^  outbound connection, kept alive by the tunnel client on the local machine
      |
Local machine:
   - tunnel client (exposes the local MCP port)
   - daemon (presence + notify), running as a sidecar
   - Playwright MCP  --cdp-endpoint=http://localhost:9222
      |  CDP
      v
   Chrome (real window, dedicated debuggable profile)
```

The agent is a terminal app with a terminal UI. In production it runs on the AWS VM, started either with `npx` or by cloning the repo and running it. In development it is the same terminal app, run inside a Docker container that mocks the VM (see section 17).

The local machine runs three small processes: the tunnel client (dials out), Playwright MCP (the real browser tools), and our thin daemon (presence + notifications). The daemon runs as a small status sidecar — the agent calls it separately to ask "is the machine online?" and it triggers the OS notification — so it never sits in the browser traffic path and we never touch Playwright MCP internals.

## 8. Browser control: how we attach (Playwright MCP)

Playwright MCP offers three connection modes. **v1 uses channel mode.**

1. **Channel name** (`--cdp-endpoint=chrome`) — **chosen for v1.** Attaches to the user's already-running, everyday Chrome after the user enables "Allow remote debugging for this browser instance" at `chrome://inspect/#remote-debugging`. No special launch flags, no port to manage, no separate profile. This is the Chrome-136-sanctioned way to debug your real browser, and the lowest-friction option.
2. **CDP endpoint** (`--cdp-endpoint=http://localhost:9222`) — attaches to a Chrome started with `--remote-debugging-port` and usually a dedicated profile. Kept as a fallback if channel mode is ever blocked.
3. **Browser extension** (`--extension`) — connects to existing tabs and reuses the user's real session, including SSO/2FA logins and installed extensions. A later upgrade if channel mode proves limiting.

## 9. The Chrome 136 constraint

Since Chrome 136 (2025), Chrome ignores `--remote-debugging-port` when launched with the **default** profile, to block cookie theft.

**v1 solution: channel mode.** Chrome 136 added a sanctioned per-instance opt-in at `chrome://inspect/#remote-debugging` — "Allow remote debugging for this browser instance." The user enables it once, and Playwright MCP connects by channel name. This works with the real default profile, needs no launch flags, and respects the new security model.

Fallbacks, if channel mode is ever blocked: a dedicated `--user-data-dir` + `--remote-debugging-port` profile, or extension mode (which bypasses the debug port entirely).

## 10. Profile persistence

- With channel mode, the agent uses the user's **real, everyday Chrome profile**. There is no separate profile to create or maintain.
- All logins, cookies, saved passwords, extensions, history, and localStorage are simply whatever is already in the user's normal browser, and they persist exactly as they do in daily use.
- This means zero setup: the user is already logged in to their sites, so the agent inherits those sessions immediately.
- Trade-off: the agent shares the browser the user actively uses (see section 12 note). No dedicated folder to back up, but also no isolation from the user's own browsing.

## 11. Browser realism

- Real Chrome (not bundled Chromium), so websites see a genuine fingerprint, real GPU/fonts, `navigator.webdriver = false`, and no automation banner.
- Traffic uses the user's home IP (residential), not an AWS datacenter IP.
- Aged, logged-in cookies build trust with sites.
- **Known limit:** the strictest bot-detection systems can sometimes detect an attached CDP debugger. Mitigation = human handoff (section 13). Extension mode (v2) reduces this further.

## 12. Session lifecycle

1. Precondition (one-time): the user has enabled remote debugging for their Chrome instance at `chrome://inspect/#remote-debugging`, and Chrome is open.
2. Agent calls `check_local_status` (our daemon). If offline, return offline + reason; agent stops.
3. Agent connects to Playwright MCP through the tunnel and issues `browser_navigate`. Playwright MCP attaches to the running Chrome over the channel.
4. The daemon fires a native OS notification ("Agent started a browser session").
5. Agent issues navigate / click / type / screenshot calls (all from Playwright MCP).
6. Agent finishes; Chrome stays open as the user's normal browser.

**Note (shared browser):** because channel mode uses the user's everyday Chrome, the agent's actions happen in the user's real window. The agent should open a new tab for its work rather than hijacking the active tab, and the OS notification makes it obvious when a session is live.

## 13. Human handoff

Because the Chrome window is visible on the user's real screen, the user can take over with mouse and keyboard at any time — the fallback for hard captchas, strict bot checks, or sensitive logins. The agent pauses, the user completes the step, the agent continues in the same window. Because channel mode uses the user's own everyday Chrome, this is literally their own browser window, so takeover is natural. Documented as a feature.

## 14. Security requirements (v1 minimum)

- Authenticated tunnel: a strong token or access policy on the public URL (Cloudflare Tunnel supports this via Cloudflare Access).
- Use HTTPS / `wss://` on the public side (provided by the tunnel).
- Channel mode does not open a network debug port, so there is no port 9222 to protect. The remote-debugging opt-in is per-instance and local-only; the user enables it knowingly.
- The daemon and tunnel must not log page content or screenshots.

## 15. Error states

| Situation | Behavior |
|---|---|
| Local machine offline | `check_local_status` -> `online: false`; tunnel URL unreachable -> clear "machine offline" error |
| Chrome closed or debugging not enabled | Playwright MCP cannot attach; daemon notifies the user to open Chrome and enable remote debugging |
| Chrome crashed mid-session | Next call returns a session error; agent retries navigate to relaunch |
| Operation timeout | Playwright MCP returns a timeout error |
| Tunnel down | Public URL unreachable; agent treats as machine offline |
| Wrong / missing token | Tunnel refuses the connection |

## 16. Tech stack

- **Browser tools:** `@playwright/mcp` (official Playwright MCP), channel mode (`--cdp-endpoint=chrome`).
- **Tunnel:** Cloudflare Tunnel — free, no time limit, stable URL, outbound-only. (ngrok is fine for the first few minutes of trying things, but its free URLs change on every restart, which keeps breaking the agent config; Cloudflare avoids that.)
- **Daemon (our code):** Node.js, `@modelcontextprotocol/sdk`. Runs as a small status sidecar (see section 7), not in the browser path. Handles `check_local_status` and fires session notifications.
- **Notifications:** macOS is the supported target for v1. The Node daemon fires a native macOS notification via `osascript` (e.g. `display notification "..." with title "..."`), or the `node-notifier` package which wraps the same. On any other OS, the daemon simply prints the notification line to its terminal (stdout) instead — no native call. This keeps the daemon cross-platform without per-OS notification code beyond macOS.
- **Browser:** the user's installed everyday Chrome, real default profile, with remote debugging enabled per-instance (channel mode).

## 17. Local development setup (mock AWS VM with Docker)

The Docker container is a **test convenience only**. In real use the agent is not containerized — it runs directly on the AWS VM (or any machine) either via `npx` or by cloning the repo and running it. The container exists purely so a developer can reproduce the cloud-to-local data path on a single machine, without renting a VM.

During development, the agent side runs inside a Docker container that stands in for the AWS VM. This keeps dev and prod topologically identical: the agent always reaches the browser over the network, never on localhost.

- **Container = the agent (test only).** A Docker container runs the agent the same way it would on the AWS VM. It has no browser of its own. This container is for testing; it is not the production artifact.
- **Host = the local machine.** Chrome, Playwright MCP, the tunnel client, and our daemon run on the developer's host machine (outside the container).
- **The container reaches the host's services through the tunnel's public URL**, the same way the AWS VM will in production. We deliberately do NOT use Docker host networking or `host.docker.internal` for the browser connection, because that would let the container reach the browser directly and hide the NAT problem the product is meant to solve.
- This setup verifies the real failure modes early: tunnel auth, presence detection, reconnection, and the "machine offline" path.
- A `docker-compose.yml` defines the agent container; a Makefile / npm script starts Chrome + Playwright MCP + tunnel + daemon on the host. Bringing the two up together reproduces the production data path on one developer machine.

```
Host (developer machine)               Docker container (mock AWS VM, test only)
  Chrome (CDP :9222)                      agent (terminal app)
  Playwright MCP                              |
  tunnel client  --> public URL  <-----------/  (reaches host only via tunnel)
  daemon (presence + notify)
```

## 18. Milestones

1. **M1 - Browser end to end (local):** enable remote debugging in everyday Chrome (`chrome://inspect`); run Playwright MCP in channel mode on the host; drive it from a local MCP client. No tunnel yet. Confirms channel attach to the real profile.
2. **M2 - Tunnel + Docker mock:** add the tunnel; run the agent inside the Docker mock VM; reach the browser only through the public URL. Confirms the NAT path.
3. **M3 - Daemon:** add `check_local_status` and the session-start notification — native macOS notification via `osascript`, terminal print on other OSes.
4. **M4 - Hardening + handoff:** timeouts, reconnect, tunnel-down handling, documented human-handoff, profile-survives-reboot check.

## 19. Open questions

None blocking for v1 — all major decisions are settled: channel mode, Cloudflare Tunnel, Node daemon as a sidecar, macOS notifications with a terminal fallback, and a Docker-mocked agent for development. Remaining choices (e.g. whether to add a tray-icon kill switch, or extension mode later) are post-v1 improvements, not prerequisites.
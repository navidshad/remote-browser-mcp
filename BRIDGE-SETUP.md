# Bridge Setup — extension ↔ VM agent (direct dial-out path)

> **DEPLOYED 2026-06-14** on `ubuntu@18.199.209.43`. Bridge runs under pm2 as
> `rbm-bridge` (MCP `127.0.0.1:3000`, WS `:3002`); token lives in
> `~/rbm-bridge.config.cjs`. WS is published by **reusing the existing tunnel**
> via a path rule — extension **Agent URL = `wss://aso-agent.subturtle.app/rbm-ws`**.
> The VM's `browser` + `browser-daemon` MCP servers are repointed to
> `http://127.0.0.1:3000/mcp` (backup: `~/.claude.json.bak-pre-bridge-*`).
> Remaining: load the extension in the Aso Dara profile and paste URL + token.

The new architecture: a **bridge-server** on the VM exposes the browser tools as
MCP (localhost) and accepts an authenticated WebSocket from a **custom MV3
extension** running in the real **Aso Dara** Chrome profile on the Mac. The
extension dials OUT to the VM (`wss://`), so nothing inbound is needed on the Mac
— no Mac relay, no Mac tunnel, no Cloudflare Access in front of the browser path.

```
VM:  packages/bridge-server  ──MCP localhost:3000/mcp──>  VM's Claude Code / packages/agent
                             ──WS  localhost:3002──> cloudflared ──> wss://browser-ws.subturtle.app
Mac: Aso Dara Chrome + MV3 extension ──dials out──> wss://browser-ws.subturtle.app  (token auth)
                                     ──chrome.debugger──> the agent tab
```

`check_local_status` and all `browser_*` tools live on the **one** bridge MCP
endpoint (mirrored Playwright MCP names → `CONTRACT.md` barely changes). The
separate Mac-side `daemon` + Playwright MCP + Mac tunnel are **superseded**.

---

## 1. Pick a shared token (once)

```bash
openssl rand -hex 32
```

Use the same value on the VM (`BRIDGE_ACCESS_TOKEN`) and in the extension popup.

## 2. VM — run the bridge-server

```bash
# build (Node 20+):
npm install
npm run build --workspace=packages/bridge-server

# run (MCP face localhost:3000, WS face localhost:3002):
BRIDGE_ACCESS_TOKEN=<token> MCP_PORT=3000 WS_PORT=3002 \
  node packages/bridge-server/dist/index.js

# or under pm2:
BRIDGE_ACCESS_TOKEN=<token> pm2 start packages/bridge-server/dist/index.js --name rbm-bridge
```

## 3. VM — expose the WS face with cloudflared (no Access)

This VM already runs a tunnel (`86e859b2…`, pm2 `ceo-tunnel`,
`~/.cloudflared/config.yml`) serving `aso-agent.subturtle.app → :8787`. The local
`cert.pem` is only an ARGO TUNNEL TOKEN (can run a tunnel, **cannot** edit DNS via
`cloudflared tunnel route dns` → "Authentication error"), so rather than create a
new `browser-ws.subturtle.app` record we **reuse the existing hostname via a path
rule** (no DNS change). Add the `/rbm-ws` rule *before* the webhook catch-all:

```yaml
ingress:
  - hostname: aso-agent.subturtle.app
    path: ^/rbm-ws
    service: http://127.0.0.1:3002      # bridge WS face
  - hostname: aso-agent.subturtle.app
    service: http://localhost:8787      # CEO-Agent webhook (unchanged)
  - service: http_status:404
```

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
pm2 restart ceo-tunnel
```

→ extension **Agent URL = `wss://aso-agent.subturtle.app/rbm-ws`**.

> `aso-agent.subturtle.app` has **no** Cloudflare Access policy (verified: `GET /`
> → 404, not 403), so the browser WebSocket connects fine; auth is the in-band
> token handshake. The MCP face (`:3000`) stays localhost-only, never tunneled.
>
> **Cleaner alternative (optional):** add a dedicated `browser-ws.subturtle.app`
> CNAME → `86e859b2-1a0d-421b-9600-3c8f99f16ed0.cfargotunnel.com` (Proxied) in the
> Cloudflare dashboard, keep the `browser-ws` ingress rule already in the config,
> and switch the Agent URL to `wss://browser-ws.subturtle.app`.

## 4. VM — point Claude Code at the bridge

```bash
claude mcp remove browser 2>/dev/null
claude mcp remove browser-daemon 2>/dev/null
claude mcp add --transport http browser http://localhost:3000/mcp
claude mcp list      # 'browser' → ✓ Connected
```

(No Access headers — it's localhost on the VM.)

## 5. Mac — load the extension into the Aso Dara profile ONLY

1. Open Chrome in the **Aso Dara** profile.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `packages/extension/`.
3. **Isolation:** install it in this profile ONLY. Turn OFF Extensions sync so it
   can't propagate to other profiles. A Chrome extension can only act within its
   own profile, so this is what keeps the agent off your personal profile.
4. Open the extension popup, set:
   - **Agent URL:** `wss://aso-agent.subturtle.app/rbm-ws`
   - **Access Token:** the token from step 1 (currently `~/rbm-bridge.config.cjs` on the VM)
   - **Save & Connect** → status should show **“Connected to agent”**.
5. Keep an Aso Dara window open (background is fine — focus is NOT required). The
   first browser command attaches `chrome.debugger` and shows a thin
   *“…started debugging this browser”* bar; leave it (clicking **Cancel**
   detaches until the next command).

## 6. Verify end-to-end

- Bridge health (VM): `curl -s localhost:3000/health` → `"extensionConnected":true`.
- Local MCP test client (VM): `node packages/bridge-server/dist/test-client.js`
  → connects, `bridge_ping` returns `pong`.
- Real run: from the VM ask Claude Code to `check_local_status` then
  `browser_navigate` to a page and `browser_snapshot` — it should drive the Aso tab.

### Multi-tab & multi-agent sessions

Each MCP client (one agent) is an isolated **session** with its own tab group:

- `browser_tab_new` opens a tab and returns a stable **handle** (`t1`, `t2`, …).
  Pass it as the `tab` arg to `browser_navigate/snapshot/click/type/…`; omit `tab`
  to target the session's active tab. `browser_tab_select` changes the active tab.
- The debugger attaches to **many tabs at once** (one *“…debugging this browser”*
  bar per attached tab is expected). Commands to different tabs run in parallel;
  same-tab commands are serialized.
- Sessions are keyed by the MCP `Mcp-Session-Id` (handled by the SDK client — the
  agent never sets it). A session can only act on tabs it owns; another session's
  handle is rejected with `tab_not_owned`. When an agent disconnects, its tabs are
  closed automatically. Header-less callers share a `default` session (back-compat).

### Keepalive soak test (the make-or-break MV3 risk)

Background/minimize the Aso window, then poll from the VM every ~2 min for hours:

```bash
# loops browser_snapshot via the local MCP client; logs ok/latency
BRIDGE_URL=http://localhost:3000/mcp POLL_TOOL=browser_snapshot \
  node packages/bridge-server/dist/test-client.js   # wrap in a 2-min loop
```

Pass = every poll succeeds (eviction+revival fast enough to be invisible). If
long-idle/minimized polls fail, add an offscreen-document keepalive pacemaker.

---

## Teardown / revert to the retired path

- Mac: remove the unpacked extension from Aso Dara.
- VM: `claude mcp remove browser`; stop the bridge + `cloudflared tunnel delete
  remote-browser-vm`; delete the `browser-ws` DNS record.
- The old Mac `make start-local` / pm2 Playwright stack still works unchanged.

# Setup & Cleanup Log — Remote Browser MCP ↔ CEO-Agent

Everything that was changed to connect the CEO-Agent (AWS Lightsail, `ubuntu@18.199.209.43`)
to the Chrome on this Mac, and **exactly how to undo each piece**.

There are two logs, one per side:

- **This file** — changes on the Mac (laptop side).
- **`~/REMOTE-BROWSER-SETUP-LOG.md` on the VM** — changes on the server side.

Date: 2026-06-10/11. Set up by Claude Code at Navid's request.

---

## Mac (laptop) side

### 1. Cloudflare login (one-time)

- **What:** `cloudflared tunnel login` — authorized the `subturtle.app` zone.
- **Created:** `~/.cloudflared/cert.pem` (account-scoped origin certificate).
- **Undo:** delete `~/.cloudflared/cert.pem`. Optionally revoke under
  Cloudflare dash → `subturtle.app` → SSL/TLS → Origin Server → Argo Tunnel certs.

### 2. Named tunnel `remote-browser-mac`

- **What:** `cloudflared tunnel create remote-browser-mac`
- **Tunnel UUID:** `db59c8d8-518e-4dde-9b5a-b22178d8a55d`
- **Created:** `~/.cloudflared/db59c8d8-518e-4dde-9b5a-b22178d8a55d.json` (tunnel credentials).
- **Undo:**
  ```bash
  cloudflared tunnel delete remote-browser-mac   # removes tunnel + credentials record
  rm -f ~/.cloudflared/db59c8d8-518e-4dde-9b5a-b22178d8a55d.json
  ```

### 3. DNS routes (Cloudflare zone `subturtle.app`)

- **What:** two proxied CNAME records pointing at the tunnel:
  - `browser.subturtle.app` → Playwright MCP (laptop :3000)
  - `browser-daemon.subturtle.app` → daemon (laptop :3001)
- **Created with:** `cloudflared tunnel route dns remote-browser-mac <hostname>`
- **Undo:** delete both CNAME records in Cloudflare dash → `subturtle.app` → DNS
  (tunnel delete does NOT remove them).

### 4. Tunnel config file

- **What:** `~/.cloudflared/remote-browser.yml` — ingress mapping the two hostnames
  to localhost:3000 / localhost:3001.
- **Undo:** `rm ~/.cloudflared/remote-browser.yml`. `start-local.sh` then falls
  back to ephemeral trycloudflare.com quick tunnels automatically.

### 5. Cloudflare Access (auth in front of both hostnames)

- **What:** two self-hosted Access applications, each with a `non_identity`
  (Service Auth) policy that includes **any valid service token** in the account.
  - App `Remote Browser MCP (Playwright)` → `browser.subturtle.app`
    - app id `73572223-fc18-4c3f-8403-5b12b5e33507`, policy id `ee693e9a-14d7-4c36-ba74-42d0b2584eca`
  - App `Remote Browser MCP (Daemon)` → `browser-daemon.subturtle.app`
    - app id `a1ad9bed-4333-46cb-b3b3-a4879d98558a`, policy id `da508521-8484-446d-b698-4339250a26ed`
  - Account id `089893b4ee1278d92e2bb0b33af8cf4c`.
  - The matching service token is `remote-browser-vm` (created by you in the dash);
    its Client ID/Secret live only in the VM's MCP config (`~/.claude.json` on the VM),
    not in this repo.
- **Note — `any_valid_service_token`:** the API token used for setup could create
  apps but not *read* service-token IDs, so the policy allows any valid service
  token in the account rather than naming this one. With a single token in the
  account that is equivalent. To tighten later: edit each app's policy in the dash
  → Include → Service Token → `remote-browser-vm` (removes "any valid").
- **Verified:** `GET https://browser.subturtle.app/` → 403 without the token,
  passes Access with the two `CF-Access-Client-*` headers.
- **Undo:** Cloudflare dash → Zero Trust → Access → Applications: delete both apps;
  Access → Service Auth: delete the `remote-browser-vm` token. Or via API:
  `DELETE /accounts/089893b4ee1278d92e2bb0b33af8cf4c/access/apps/{app_id}` for each.

### 5b. Cloudflare API token (setup-only — REVOKE)

- **What:** a Custom API token (`Account · Access: Apps and Policies · Edit`) you
  created so Claude could build the two Access apps above via API.
- **It has no ongoing role.** Revoke it at
  https://dash.cloudflare.com/profile/api-tokens once setup is confirmed.

### 5c. Browser attach — extension mode (THE LIVE PATH)

- **What:** Playwright MCP attaches to Chrome via the **"Playwright MCP Bridge"**
  Web-Store extension (`--extension`), running in a **dedicated Chrome profile
  named "Aso Dara"**. Real profile, real logins, no Chrome flags, no port 9222 —
  sidesteps every Chrome-136/144 restriction.
- **Isolation guarantee:** the extension is installed **only in the Aso Dara
  profile**. A Chrome extension can act only within its own profile, so the agent
  physically cannot touch Navid's personal/Default profile. (Confirmed: a test
  navigation landed in Aso Dara, never in personal.)
- **Auto-connect (no per-run click):** the extension's status page shows a token;
  setting `PLAYWRIGHT_MCP_EXTENSION_TOKEN` on the server makes `--extension`
  connect with no dialog. Stored in **gitignored `scripts/.rbm-env`** (sourced by
  start-local.sh). The token is per-extension-install, NOT per-profile — so
  isolation rests on 5c's "extension only in Aso Dara", not the token.
- **What you need open:** a window of the Aso Dara profile must be **open** (background
  is fine — **focus is NOT required**; it just has to exist, or the extension worker
  isn't loaded and connections time out). `make start-local` auto-opens it (AUTO_OPEN_ASO=1);
  `make aso-window` opens it on demand. The profile is referenced **by name**
  (`ASO_PROFILE_NAME="Aso Dara"` in `scripts/.rbm-env`), resolved to its `Profile N`
  dir via Chrome's Local State — never hardcode the number. The agent/VM never
  references the profile at all.
- **Isolation depends on the extension being in EXACTLY this one profile.** Chrome
  extension sync had copied it into "CodeBridger LTD" too; that was removed and
  Extensions-sync turned off. `open-aso-window.sh` warns if it ever reappears elsewhere.
- **Undo:** remove the extension from the Aso Dara profile; `rm scripts/.rbm-env`.

### 5d. Dedicated debug Chrome — CDP-port mode (FALLBACK only)

- **When:** only if extension mode is unavailable. Set `BROWSER_MODE=cdp`.
- **What:** Chrome over CDP on `localhost:9222`. Chrome 136+ blocks
  `--remote-debugging-port` on the default profile and the `chrome://inspect`
  toggle doesn't expose a usable port, so this uses a **separate** debug Chrome.
- **How:** `make chrome-debug` (→ `scripts/start-chrome-debug.sh`) →
  `--remote-debugging-port=9222 --user-data-dir=~/.rbm-chrome-debug` (fresh,
  persistent profile; everyday Chrome untouched).
- **Undo:** quit that Chrome window; `rm -rf ~/.rbm-chrome-debug`.

### 6. Repo changes (this repo)

- `scripts/start-local.sh` — named tunnel when `~/.cloudflared/remote-browser.yml`
  exists (quick tunnels fallback); pins `PLAYWRIGHT_ALLOWED_HOSTS`; Node >=20 guard;
  `BROWSER_MODE` switch (extension default / cdp fallback); sources `scripts/.rbm-env`;
  passes `BROWSER_MODE`+`PLAYWRIGHT_PORT` to the daemon.
- `packages/daemon/src/status.ts` — `check_local_status` is now mode-aware: in
  extension mode it probes the Playwright MCP bridge (port 3000) instead of `:9222`.
  (Rebuild: `npm run build --workspace=packages/daemon`.)
- `scripts/open-aso-window.sh` + `make aso-window` — resolve the agent profile BY NAME
  and open a window (start-local auto-runs it in extension mode).
- `scripts/start-chrome-debug.sh` + `make chrome-debug` — CDP-mode fallback (see 5d).
- `scripts/.rbm-env` (gitignored, NOT committed) — holds `PLAYWRIGHT_MCP_EXTENSION_TOKEN`
  and `ASO_PROFILE_NAME`.
- `.gitignore` — adds `scripts/.rbm-env`. `.env.example` — stable hostnames.
- `SETUP-LOG.md` — this file.
- **Undo:** `git checkout <pre-setup-sha> -- scripts/start-local.sh .env.example .gitignore packages/daemon/src/status.ts`,
  rebuild the daemon, `git rm SETUP-LOG.md scripts/start-chrome-debug.sh`, `rm scripts/.rbm-env`.

---

## VM side (summary — full log lives on the VM)

See `~/REMOTE-BROWSER-SETUP-LOG.md` on the server. In short:

- Two user-scope MCP servers registered for Claude Code (`browser`, `browser-daemon`)
  with Cloudflare Access headers → undo with `claude mcp remove`.
- `CONTRACT.md` "Driving the local browser (Aso Dara)" section in `~/CEO-Agent`
  → undo with `git checkout -- CONTRACT.md` (loaded fresh per wake; no rebuild).

---

## Verified working (2026-06-11)

- Tunnel `remote-browser-mac` up, both hostnames live.
- Access: `GET browser.subturtle.app` → **403** without token; MCP `initialize`
  succeeds **with** the two `CF-Access-Client-*` headers, for both servers.
- VM: `claude mcp list` shows `browser` and `browser-daemon` ✔ Connected.
- **Extension mode (live path):** a real `claude --print …
  --dangerously-skip-permissions` wake called `check_local_status`
  (→ ready, "the agent browser (Aso Dara) is ready for remote control") **and
  navigated to example.com in the Aso Dara profile, reading back "Example
  Domain"** — full agent→browser path through the tunnel + Access, in Navid's real
  (Aso Dara) Chrome, never touching the personal profile. ✅
- (CDP-port fallback was also verified earlier before the switch to extension mode.)

## Running the services + the Node gotcha

- For the agent to drive a page, on the Mac:
  1. `make start-local` — daemon + Playwright MCP (`--extension`) + named tunnel
     (foreground; Ctrl+C stops all three).
  2. The **Aso Dara** Chrome window open, with the Playwright MCP Bridge extension.
  - (Fallback only: `BROWSER_MODE=cdp make start-local` + `make chrome-debug`.)
- **Node version trap:** this machine's default login-shell Node is an old nvm
  **v14.21.1**, which crashes the daemon (`Unexpected token '??='`) and breaks
  `npx`. Always start under Node 20+:
  `export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH"` (or `nvm use 22`),
  or Homebrew's `node@22`. `start-local.sh` refuses to run on < 20.
- Services are **manual / ephemeral** (chosen): they live only as long as the
  foreground `start-local.sh`. No pm2/launchd set up.

## Full teardown, in order

1. VM: `claude mcp remove browser; claude mcp remove browser-daemon` (user scope).
2. VM: `cd ~/CEO-Agent && git checkout -- CONTRACT.md` (no rebuild needed).
3. Mac: stop `start-local.sh`; `rm scripts/.rbm-env`; remove the Playwright MCP
   Bridge extension from the Aso Dara profile. (Fallback users: also quit the
   debug Chrome and `rm -rf ~/.rbm-chrome-debug`.)
4. Cloudflare: delete the two Access apps + the service token.
5. Cloudflare: delete the two DNS CNAMEs.
6. Mac: `cloudflared tunnel delete remote-browser-mac`, remove
   `~/.cloudflared/remote-browser.yml` (and `cert.pem` if no other tunnels are wanted).
7. Mac repo: revert the `start-local.sh` / `.env.example` changes, delete this file.

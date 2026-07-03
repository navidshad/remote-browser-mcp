// ──────────────────────────────────────────────────────────────────────────────
// pm2 process definitions for Remote Browser MCP (CDP mode).
//
// Brings up the full host-side stack and keeps it alive across crashes + reboots:
//   rbm-chrome      dedicated debug Chrome on :9222 (persistent ~/.rbm-chrome-debug)
//   rbm-playwright  Playwright MCP on :3000, attached to Chrome over CDP
//   rbm-daemon      presence/notification daemon on :3001
//   rbm-tunnel      named Cloudflare tunnel (browser*.subturtle.app -> :3000/:3001)
//
// Why pin PATH/interpreter: this machine's login shell sometimes resolves to an
// old nvm Node 14, which crashes the daemon and breaks npx. Every app here runs
// under Node 22 explicitly, so pm2 (and launchd at boot) never inherit Node 14.
//
//   Start:    pm2 start ecosystem.config.cjs   (run under Node 22)
//   Persist:  pm2 save                          (snapshot for resurrect)
//   On boot:  pm2 startup                        (install the launchd agent)
//   Status:   pm2 status   |   pm2 logs rbm-daemon
//   Stop all: pm2 delete ecosystem.config.cjs
// ──────────────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME;
const ROOT = __dirname;

const NODE_BIN = `${HOME}/.nvm/versions/node/v22.17.1/bin`;
const NODE = `${NODE_BIN}/node`;

// Minimal, explicit PATH so children resolve correctly even when pm2 is
// resurrected by launchd (whose default PATH is just /usr/bin:/bin:/usr/sbin:/sbin).
const PATH = `${NODE_BIN}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

const CDP_PORT = '9222';
const PLAYWRIGHT_PORT = '3000';
const DAEMON_PORT = '3001';

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PROFILE = `${HOME}/.rbm-chrome-debug`;
const CLOUDFLARED = '/opt/homebrew/bin/cloudflared';
const TUNNEL_CONFIG = `${HOME}/.cloudflared/remote-browser.yml`;

// Matches scripts/start-local.sh: pin the tunnel hostnames + localhost so the
// Host-header check passes both through the tunnel and for on-machine smoke tests.
const ALLOWED_HOSTS =
  'browser.subturtle.app,browser-daemon.subturtle.app,' +
  `localhost,localhost:${PLAYWRIGHT_PORT},127.0.0.1,127.0.0.1:${PLAYWRIGHT_PORT}`;

const common = {
  interpreter: 'none',    // exec the script directly; do not wrap in `node`
  autorestart: true,
  env: { PATH },
};

module.exports = {
  apps: [
    {
      // Dedicated debug Chrome, launched via a foreground wrapper that `exec`s the
      // Chrome binary (not `open -na`) so the pm2-supervised process IS Chrome —
      // pm2 sees it die and relaunches it. The wrapper exists because the binary
      // path has a space ("Google Chrome.app") that pm2's shell handling mangles.
      // Persistent profile: logins to the sites the agent uses stick across restarts.
      name: 'rbm-chrome',
      script: `${ROOT}/scripts/rbm-chrome-fg.sh`,
      interpreter: 'bash',
      autorestart: true,
      env: { PATH, CDP_PORT, RBM_CHROME_PROFILE: CHROME_PROFILE, CHROME_BIN },
      // Guard against flapping if Chrome exits instantly (e.g. another instance
      // already holds the profile): require 15s uptime, back off, cap retries.
      min_uptime: '15s',
      restart_delay: 3000,
      max_restarts: 10,
    },
    {
      name: 'rbm-playwright',
      script: `${NODE_BIN}/npx`,
      args: [
        '--yes', '@playwright/mcp@latest',
        '--port', PLAYWRIGHT_PORT,
        '--browser', 'chrome',
        '--cdp-endpoint', `http://localhost:${CDP_PORT}`,
        '--allowed-hosts', ALLOWED_HOSTS,
      ],
      ...common,
    },
    {
      name: 'rbm-daemon',
      script: `${ROOT}/packages/daemon/dist/index.js`,
      interpreter: NODE,    // pin Node 22 explicitly for the daemon
      autorestart: true,
      cwd: ROOT,
      env: {
        PATH,
        PORT: DAEMON_PORT,
        CDP_PORT,
        BROWSER_MODE: 'cdp',
        PLAYWRIGHT_PORT,
      },
    },
    {
      name: 'rbm-tunnel',
      script: CLOUDFLARED,
      args: ['tunnel', '--config', TUNNEL_CONFIG, 'run'],
      ...common,
    },
    {
      // Health-guard: if the debug Chrome ever drops to 0 page targets (the agent
      // closed the last tab), reopen a blank one so Playwright-over-CDP never hits
      // "Browser context management is not supported". See scripts/rbm-chrome-guard.sh.
      name: 'rbm-chrome-guard',
      script: `${ROOT}/scripts/rbm-chrome-guard.sh`,
      interpreter: 'bash',
      autorestart: true,
      env: { PATH, CDP_PORT },
    },
  ],
};

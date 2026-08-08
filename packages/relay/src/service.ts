// Running the relay as an OS service, so the browsers are reachable whenever the box is up.
//
// Ported from `packages/crew/runner/src/service.ts` in the Lumi repo — hand-written unit files
// rather than a service-manager dependency, because the ecosystem's wrappers (node-linux,
// node-mac) are unmaintained and each of these files is twenty lines somebody can read and edit.
// Nothing here needs root: a systemd `--user` unit and a launchd LaunchAgent both live in the
// user's own home.
//
// THREE DIVERGENCES FROM THE RUNNER'S VERSION, and each is the point of this file:
//
// 1. **The secrets are NOT baked into the unit.** The runner writes `Environment="PATH=…"` into
//    its unit because PATH is not a secret. Ours are: `RELAY_CONTROL_KEY` and `RELAY_TICKET_KEY`.
//    A unit file is world-readable at 0644 under `~/.config/systemd/user`, and `systemctl show`
//    prints its environment to anyone who can ask. So the unit carries `EnvironmentFile=` pointing
//    at `relay.env`, which is 0600 inside a 0700 directory, and the keys exist in exactly one
//    place on disk.
//
// 2. **`LimitNOFILE=65535`.** Every connected browser is one socket is one file descriptor, and
//    the default soft limit of ~1024 caps the box near 950 browsers, then fails inside `accept`
//    as `EMFILE` — which reads in a log like a network fault rather than a limit. The relay reads
//    its own limit back from `/proc/self/limits` and publishes it (metrics.ts), so this line being
//    absent is visible rather than silently in effect.
//
// 3. **No Windows.** The runner supports it because it runs on whatever laptop somebody has. A
//    relay is a Linux box we chose. Refusing outright beats a scheduled task that starts at logon
//    and never restarts.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envFile, logDir } from "./paths.js";

export const SERVICE_LABEL = "com.lumi.relay";
const LINUX_UNIT = "lumi-relay.service";

/** Must exceed `RELAY_DRAIN_GRACE_MS` (default 20 s) — a SIGKILL mid-drain is exactly the
 *  hung-up-on click that draining exists to prevent. */
const STOP_TIMEOUT_SEC = 30;

export const NOFILE_LIMIT = 65535;

export type ServiceState = "running" | "installed" | "not-installed" | "unsupported";

export interface ServiceStatus {
  state: ServiceState;
  detail: string;
  unitPath?: string;
  /** The CLI path baked into the unit. Undefined when it cannot be determined — see `execFacts`. */
  execPath?: string;
  /** `true` ONLY on positive evidence: we read a path and it was absent. */
  execMissing?: boolean;
  /** The `EnvironmentFile=` the unit points at, so `doctor` can check its mode. */
  envFilePath?: string;
}

export interface InstallResult {
  unitPath: string;
  notes: string[];
}

export class ServiceError extends Error {}

function run(command: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** Absolute path of the running CLI — what the unit must exec. */
export function cliPath(): string {
  return fileURLToPath(new URL("./cli/index.js", import.meta.url));
}

function uid(): string {
  return String(process.getuid?.() ?? 0);
}

function launchAgentPath(): string {
  return path.join(os.homedir(), "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function systemdUnitPath(): string {
  return path.join(os.homedir(), ".config/systemd/user", LINUX_UNIT);
}

// ── unit generation ─────────────────────────────────────────────────────────────────────────

export function systemdUnit(): string {
  return `[Unit]
Description=Lumi Crew browser relay
After=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${cliPath()} start
# The keys live HERE, not in this file: a unit is world-readable and \`systemctl show\` prints
# its environment. relay.env is 0600 inside a 0700 directory.
EnvironmentFile=${envFile()}
Restart=always
RestartSec=5
# Must exceed RELAY_DRAIN_GRACE_MS — a SIGKILL mid-drain hangs up on a click already committed to.
TimeoutStopSec=${STOP_TIMEOUT_SEC}
# One browser is one socket is one fd. The default ~1024 caps this box near 950 browsers and then
# fails inside accept() as EMFILE, which reads like a network fault.
LimitNOFILE=${NOFILE_LIMIT}

[Install]
WantedBy=default.target
`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inverse of `escapeXml`. `&amp;` MUST be replaced last — the mirror image of escaping it first —
 *  or `&amp;lt;` collapses to `<` instead of back to `&lt;`. */
export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * launchd has no `EnvironmentFile`, so the macOS unit execs the CLI with `start --env-file`, and
 * the CLI loads it. The keys still never enter the plist.
 *
 * macOS is a DEV convenience only — the relay is a Linux box in production, and `ulimit` on macOS
 * is a different conversation this does not try to have.
 */
export function plistXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(cliPath())}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>${STOP_TIMEOUT_SEC}</integer>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>${NOFILE_LIMIT}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir(), "service.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir(), "service.err.log"))}</string>
</dict>
</plist>
`;
}

// ── unit parsing (the inverse), all fail-open ───────────────────────────────────────────────

/**
 * `ExecStart=` is written unquoted, so a node or CLI path containing a SPACE is genuinely
 * ambiguous. Returns `undefined` rather than guessing: a guess would hand `doctor` a path that
 * does not exist and manufacture a false "your service is broken" on a box that is fine.
 */
export function parseSystemdCliPath(unit: string): string | undefined {
  const line = /^ExecStart=(.*)$/m.exec(unit);
  if (!line) return undefined;
  const command = line[1].trim(); // a unit read back on Windows carries \r
  if (!command.endsWith(" start")) return undefined;
  const parts = command.slice(0, -" start".length).split(" ");
  return parts.length === 2 ? parts[1] : undefined;
}

export function parseSystemdEnvFile(unit: string): string | undefined {
  const line = /^EnvironmentFile=-?(.*)$/m.exec(unit);
  return line ? line[1].trim() || undefined : undefined;
}

/**
 * Anchored on the ProgramArguments key rather than "the first array in the document": a plist
 * somebody hand-added a `WatchPaths` array to would otherwise return the wrong string.
 */
export function parsePlistCliPath(plist: string): string | undefined {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!block) return undefined;
  const args = [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]));
  // [node, cli, 'start'] — the CLI is the second. Anything shorter is not a unit we wrote.
  return args.length >= 2 ? args[1] : undefined;
}

/**
 * What the installed unit points at, and whether that file is still there.
 *
 * FAIL OPEN. `execMissing` is only ever `true` on positive evidence. An unreadable file, an
 * unparseable unit or a platform we do not inspect all yield `{}`. A false "broken" on a healthy
 * box costs more than a missed detection: the only recourse an operator has is to stop trusting
 * the tool.
 *
 * Deliberately NOT compared against `cliPath()`. A baked path that merely DIFFERS from the running
 * CLI is normal — `npm link`, a git checkout, a second Node version. Only non-existence is
 * evidence.
 */
function execFacts(
  unitPath: string,
  parse: (text: string) => string | undefined,
  parseEnvPath?: (text: string) => string | undefined
): Pick<ServiceStatus, "execPath" | "execMissing" | "envFilePath"> {
  let text: string;
  try {
    text = fs.readFileSync(unitPath, "utf8");
  } catch {
    return {}; // EACCES, or a race with uninstall — not evidence of anything.
  }
  const envFilePath = parseEnvPath?.(text);
  const execPath = parse(text);
  const envPart = envFilePath ? { envFilePath } : {};
  if (!execPath || !path.isAbsolute(execPath)) return envPart;
  return { execPath, execMissing: !fs.existsSync(execPath), ...envPart };
}

// ── public API ──────────────────────────────────────────────────────────────────────────────

export function serviceStatus(): ServiceStatus {
  if (process.platform === "linux") {
    const unitPath = systemdUnitPath();
    if (!fs.existsSync(unitPath)) {
      return { state: "not-installed", detail: "No systemd user unit installed." };
    }
    const active = run("systemctl", ["--user", "is-active", LINUX_UNIT]);
    return {
      state: active.out === "active" ? "running" : "installed",
      detail: `systemd user unit is ${active.out || "unknown"}.`,
      unitPath,
      ...execFacts(unitPath, parseSystemdCliPath, parseSystemdEnvFile),
    };
  }

  if (process.platform === "darwin") {
    const unitPath = launchAgentPath();
    if (!fs.existsSync(unitPath)) {
      return { state: "not-installed", detail: "No LaunchAgent installed." };
    }
    const printed = run("launchctl", ["print", `gui/${uid()}/${SERVICE_LABEL}`]);
    const exec = execFacts(unitPath, parsePlistCliPath);
    if (!printed.ok) {
      return { state: "installed", detail: "LaunchAgent present but not loaded.", unitPath, ...exec };
    }
    // `pid = N` appears only while the job is actually running.
    const running = /\bpid = \d+/.test(printed.out);
    return {
      state: running ? "running" : "installed",
      detail: running ? "LaunchAgent loaded and running." : "LaunchAgent loaded but not running.",
      unitPath,
      ...exec,
    };
  }

  return { state: "unsupported", detail: `No service integration for ${process.platform}.` };
}

export function installService(): InstallResult {
  const notes: string[] = [];
  fs.mkdirSync(logDir(), { recursive: true, mode: 0o700 });

  if (!fs.existsSync(envFile())) {
    throw new ServiceError(
      `No configuration at ${envFile()}. Run \`lumi-relay setup\` first — the unit points at that ` +
        "file for its keys, and installing a service that cannot start is worse than not installing one."
    );
  }

  if (process.platform === "linux") {
    const unitPath = systemdUnitPath();
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, systemdUnit());
    const reload = run("systemctl", ["--user", "daemon-reload"]);
    if (!reload.ok) throw new ServiceError(`systemctl daemon-reload failed: ${reload.out}`);
    const enable = run("systemctl", ["--user", "enable", "--now", LINUX_UNIT]);
    if (!enable.ok) throw new ServiceError(`systemctl enable failed: ${enable.out}`);
    // A user unit stops at logout unless lingering is on — the difference between "runs while I am
    // ssh'd in" and a relay that is up at 3am, which is the entire job.
    const linger = run("loginctl", ["show-user", os.userInfo().username, "--property=Linger"]);
    if (!linger.out.includes("Linger=yes")) {
      notes.push(
        `Run \`sudo loginctl enable-linger ${os.userInfo().username}\` — without it this unit stops ` +
          "when you log out and does not start at boot."
      );
    }
    return { unitPath, notes };
  }

  if (process.platform === "darwin") {
    const unitPath = launchAgentPath();
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, plistXml());
    run("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]); // idempotent
    const boot = run("launchctl", ["bootstrap", `gui/${uid()}`, unitPath]);
    if (!boot.ok) throw new ServiceError(`launchctl bootstrap failed: ${boot.out}`);
    notes.push(
      "macOS is supported for local development only. Production is a Linux box — the fd limit and " +
        "the EnvironmentFile story are both different here."
    );
    return { unitPath, notes };
  }

  throw new ServiceError(
    `Service install is not supported on ${process.platform}. The relay targets Linux (systemd); ` +
      "macOS works for development."
  );
}

export function uninstallService(): void {
  if (process.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", LINUX_UNIT]);
    fs.rmSync(systemdUnitPath(), { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  if (process.platform === "darwin") {
    run("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]);
    fs.rmSync(launchAgentPath(), { force: true });
    return;
  }
  throw new ServiceError(`Service uninstall is not supported on ${process.platform}.`);
}

export function restartService(): void {
  if (process.platform === "linux") {
    const result = run("systemctl", ["--user", "restart", LINUX_UNIT]);
    if (!result.ok) throw new ServiceError(`systemctl restart failed: ${result.out}`);
    return;
  }
  if (process.platform === "darwin") {
    const result = run("launchctl", ["kickstart", "-k", `gui/${uid()}/${SERVICE_LABEL}`]);
    if (!result.ok) throw new ServiceError(`launchctl kickstart failed: ${result.out}`);
    return;
  }
  throw new ServiceError(`Service restart is not supported on ${process.platform}.`);
}

export function stopService(): void {
  if (process.platform === "linux") {
    run("systemctl", ["--user", "stop", LINUX_UNIT]);
    return;
  }
  if (process.platform === "darwin") {
    run("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]);
    return;
  }
  throw new ServiceError(`Service stop is not supported on ${process.platform}.`);
}

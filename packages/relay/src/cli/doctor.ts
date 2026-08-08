// `lumi-relay doctor` — every question worth asking before deciding the relay is the problem.
//
// The checks are DATA, not printing, so the ordering and the verdicts are testable without a box
// to run them on. Three verdicts and they mean different things: `fail` is broken now, `warn` is
// working now and will break later (an fd ceiling, no lingering), `skip` is "not applicable here".
//
// The bias throughout is the runner's: **fail open on ambiguity**. A check that cannot read a file
// says so rather than concluding the worst. A false "your relay is broken" on a healthy box costs
// more than a missed detection, because the only recourse an operator has is to stop reading the
// output.

import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { envFile, readEnvFile } from "../paths.js";
import { loadConfig, type RelayConfig } from "../config.js";
import { serviceStatus } from "../service.js";
import { NOFILE_LIMIT } from "../service.js";
import { RELAY_VERSION } from "../version.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it. Present on anything that is not `ok`. */
  fix?: string;
}

const MIN_NODE_MAJOR = 22;

/** Fraction of the fd ceiling above which the box is worth warning about. */
const FD_WARN_AT = 0.7;

function nodeCheck(): Check {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= MIN_NODE_MAJOR) {
    return { name: "node", status: "ok", detail: `node ${process.version}` };
  }
  return {
    name: "node",
    status: "fail",
    detail: `node ${process.version} — the relay needs ${MIN_NODE_MAJOR}+`,
    fix: "Install Node 22 or newer and reinstall the relay.",
  };
}

function configFileChecks(): { checks: Check[]; config: RelayConfig | null } {
  const file = envFile();
  if (!fs.existsSync(file)) {
    return {
      checks: [
        {
          name: "config",
          status: "fail",
          detail: `no configuration at ${file}`,
          fix: "Run `lumi-relay setup`.",
        },
      ],
      config: null,
    };
  }

  const checks: Check[] = [];
  const mode = fs.statSync(file).mode & 0o777;
  checks.push(
    mode === 0o600
      ? { name: "config", status: "ok", detail: `${file} (0600)` }
      : {
          name: "config",
          status: "fail",
          // Not a nit: this file holds both long-lived keys, and one of them can mint a ticket
          // that impersonates somebody's browser.
          detail: `${file} is mode ${mode.toString(8)} — it holds two secrets`,
          fix: `chmod 600 ${file}`,
        }
  );

  const env = readEnvFile();
  let config: RelayConfig | null = null;
  try {
    // The FILE alone, not merged with this shell — the service reads exactly this.
    config = loadConfig({ ...env } as NodeJS.ProcessEnv);
    checks.push({
      name: "keys",
      status: "ok",
      detail: "control and ticket keys present, distinct, long enough",
    });
  } catch (err) {
    checks.push({
      name: "keys",
      status: "fail",
      detail: (err instanceof Error ? err.message : String(err)).split("\n")[0],
      fix: "Run `lumi-relay setup` (it never rotates an existing key unless you pass --rotate).",
    });
  }
  return { checks, config };
}

function serviceChecks(): Check[] {
  const checks: Check[] = [];
  const status = serviceStatus();

  if (status.state === "unsupported") {
    return [
      {
        name: "service",
        status: "skip",
        detail: status.detail,
        fix: "The relay targets Linux (systemd). macOS works for development.",
      },
    ];
  }
  if (status.state === "not-installed") {
    return [
      {
        name: "service",
        status: "warn",
        detail: "not installed — the relay will not come back after a reboot",
        fix: "Run `lumi-relay service install`.",
      },
    ];
  }

  checks.push({
    name: "service",
    status: status.state === "running" ? "ok" : "fail",
    detail: status.detail,
    ...(status.state === "running" ? {} : { fix: "Run `lumi-relay service start` and check `lumi-relay logs`." }),
  });

  if (status.execMissing) {
    checks.push({
      name: "service exec",
      status: "fail",
      // The supervisor respawns forever against a path that is not there, which in a log looks
      // like a crash loop rather than a missing file.
      detail: `the unit execs ${status.execPath}, which does not exist`,
      fix: "Run `lumi-relay service install` again from the install you want it to use.",
    });
  }

  if (status.envFilePath && status.envFilePath !== envFile()) {
    checks.push({
      name: "service env",
      status: "fail",
      detail: `the unit reads ${status.envFilePath}, but this CLI configures ${envFile()}`,
      fix: "Re-run `lumi-relay service install`, or set LUMI_RELAY_HOME to match the unit.",
    });
  }

  if (process.platform === "linux" && status.unitPath) {
    let unit = "";
    try {
      unit = fs.readFileSync(status.unitPath, "utf8");
    } catch {
      /* fail open — see the file header */
    }
    if (unit && !unit.includes("LimitNOFILE=")) {
      checks.push({
        name: "fd limit",
        status: "warn",
        detail: "the unit sets no LimitNOFILE — the default ~1024 caps this box near 950 browsers",
        fix: "Re-run `lumi-relay service install` to rewrite the unit.",
      });
    }
    const linger = spawnSync(
      "loginctl",
      ["show-user", os.userInfo().username, "--property=Linger"],
      { encoding: "utf8" }
    );
    if (!`${linger.stdout ?? ""}`.includes("Linger=yes")) {
      checks.push({
        name: "linger",
        status: "warn",
        detail: "user lingering is off — this unit stops at logout and does not start at boot",
        fix: `sudo loginctl enable-linger ${os.userInfo().username}`,
      });
    }
  }

  return checks;
}

async function reachabilityChecks(config: RelayConfig | null): Promise<Check[]> {
  if (!config) {
    return [{ name: "reachable", status: "skip", detail: "no usable configuration to probe with" }];
  }
  const base = `http://${config.bindHost === "0.0.0.0" ? "127.0.0.1" : config.bindHost}:${config.port}`;

  let liveness: Response;
  try {
    liveness = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
  } catch (err) {
    return [
      {
        name: "reachable",
        status: "fail",
        detail: `nothing answering at ${base}/health (${err instanceof Error ? err.message : String(err)})`,
        fix: "Is it running? `lumi-relay service status`, then `lumi-relay logs`.",
      },
    ];
  }
  if (!liveness.ok) {
    return [
      { name: "reachable", status: "fail", detail: `${base}/health returned HTTP ${liveness.status}` },
    ];
  }

  const checks: Check[] = [
    { name: "reachable", status: "ok", detail: `${base}/health answered` },
  ];

  // The authed probe is the one that proves Crew's own call would work — same key, same route.
  let metrics: Record<string, unknown>;
  try {
    const res = await fetch(`${base}/v1/health`, {
      headers: { authorization: `Bearer ${config.controlKey}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (res.status === 401) {
      checks.push({
        name: "control key",
        status: "fail",
        // The running process was started with a DIFFERENT relay.env than the one on disk now.
        detail: "the running relay rejects the key in relay.env",
        fix: "It is running with an older configuration. `lumi-relay service restart`.",
      });
      return checks;
    }
    if (!res.ok) {
      checks.push({ name: "control key", status: "fail", detail: `/v1/health returned HTTP ${res.status}` });
      return checks;
    }
    metrics = (await res.json()) as Record<string, unknown>;
    checks.push({ name: "control key", status: "ok", detail: "the control plane accepts it" });
  } catch (err) {
    checks.push({
      name: "control key",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
    return checks;
  }

  const version = String(metrics.version ?? "");
  if (version && version !== RELAY_VERSION) {
    checks.push({
      name: "version",
      status: "warn",
      detail: `this CLI is ${RELAY_VERSION}; the running relay is ${version}`,
      fix: "`lumi-relay service restart` picks up the installed version.",
    });
  }

  const openFds = typeof metrics.openFds === "number" ? metrics.openFds : null;
  const maxFds = typeof metrics.maxFds === "number" ? metrics.maxFds : null;
  if (openFds === null || maxFds === null) {
    checks.push({
      name: "fd headroom",
      status: "skip",
      // Explicitly UNKNOWN rather than fine. /proc is Linux-only.
      detail: "the running relay cannot read its own fd limit (not Linux?)",
    });
  } else {
    const used = openFds / maxFds;
    checks.push(
      maxFds < NOFILE_LIMIT
        ? {
            name: "fd headroom",
            status: "warn",
            detail: `soft limit is ${maxFds}, not ${NOFILE_LIMIT} — the unit's LimitNOFILE is not in effect`,
            fix: "`lumi-relay service install` then `lumi-relay service restart`.",
          }
        : used > FD_WARN_AT
          ? {
              name: "fd headroom",
              status: "warn",
              detail: `${openFds} of ${maxFds} descriptors in use`,
              fix: "Raise LimitNOFILE, or move to a bigger box.",
            }
          : { name: "fd headroom", status: "ok", detail: `${openFds} of ${maxFds} descriptors in use` }
    );
  }

  const browsers = typeof metrics.browsers === "number" ? metrics.browsers : 0;
  checks.push({
    name: "browsers",
    status: "ok",
    detail: browsers === 1 ? "1 browser connected" : `${browsers} browsers connected`,
  });

  return checks;
}

function tunnelCheck(): Check {
  const which = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  if (which.status !== 0) {
    return {
      name: "tunnel",
      status: "skip",
      // Not a failure: the relay is fine, it just is not published. Somebody may be terminating
      // TLS in front of it another way.
      detail: "cloudflared not found on PATH — nothing here publishes the relay",
      fix: "If this box should be reachable, install cloudflared and point a named tunnel at the relay's port.",
    };
  }
  return { name: "tunnel", status: "ok", detail: `${`${which.stdout ?? ""}`.trim().split("\n")[0]}` };
}

export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [nodeCheck()];
  const { checks: configChecks, config } = configFileChecks();
  checks.push(...configChecks);
  checks.push(...serviceChecks());
  checks.push(...(await reachabilityChecks(config)));
  checks.push(tunnelCheck());
  return checks;
}

/** Non-zero only on `fail`. A `warn` is a box that works today. */
export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

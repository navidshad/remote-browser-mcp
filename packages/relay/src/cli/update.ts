// `lumi-relay update` — a deliberately short ladder, and the shortness is the decision.
//
// The Crew runner's self-update (Lumi PRD §15.37) is ten rungs, an `updating` flag distinct from
// `shuttingDown`, an attempt counter, and a mirror of its phase into Firestore. It has to be: it
// runs on hundreds of laptops nobody can reach, so "a fix arrives only when a human notices" is a
// real failure mode with a real cost.
//
// This runs on ONE box, which we own, and which we can ssh into. So the ladder keeps only the
// rungs that encode a lesson rather than a fleet, and drops the machinery that exists to survive
// having no operator:
//
//   • Update the thing the SUPERVISOR EXECS, not the thing that happens to be on PATH. A service
//     unit bakes an absolute path; `npm i -g` under a different Node (an nvm switch, a second
//     prefix) installs perfectly into a directory nobody runs. This fails CLOSED — if we cannot
//     show the unit's exec path lives inside the global install we are about to replace, we refuse
//     and say why, rather than "succeeding" and changing nothing.
//   • Never believe npm's exit code. The version is re-read from the installed package.json AFTER
//     the install, at the path the supervisor execs.
//   • Restart through the service manager, never `exec`. The supervisor owns the process.
//
// There is no automatic timer here, and that is on purpose: an unattended restart of the one relay
// every browser is connected to should be something somebody chose.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliPath, serviceStatus } from "../service.js";
import { RELAY_VERSION } from "../version.js";

export const PACKAGE_NAME = "@lumi.ai/relay";

export type InstallMode = "global-npm" | "checkout";

export interface UpdateFacts {
  /** Absolute path of the CLI file currently executing. */
  runningCli: string;
  /** Absolute path the installed service unit execs, when it could be determined. */
  serviceExec?: string;
  /** Whether a service is installed at all. */
  serviceInstalled: boolean;
}

export type UpdateDecision =
  | { action: "install"; reason: string }
  | { action: "refuse"; reason: string; fix: string };

/**
 * Is this CLI a published package, or a working copy?
 *
 * Keyed on the package directory appearing in the path, which is what `npm i -g` produces
 * (`…/lib/node_modules/@lumi.ai/relay/dist/…`). A git checkout, an `npm link`, and a
 * `node dist/cli/index.js` from the repo all fall through to `checkout` — which is correct, since
 * `npm i -g` would not update any of them.
 */
export function detectInstallMode(cli: string): InstallMode {
  return cli.includes(`node_modules${path.sep}${PACKAGE_NAME.replace("/", path.sep)}${path.sep}`)
    ? "global-npm"
    : "checkout";
}

/**
 * Decide whether to run the install, purely — so every refusal is assertable without npm, a
 * service manager, or a box.
 */
export function planUpdate(facts: UpdateFacts): UpdateDecision {
  if (detectInstallMode(facts.runningCli) === "checkout") {
    return {
      action: "refuse",
      reason: "this relay is running from a working copy, not an installed package",
      fix: "git pull && npm ci && npm run build -w packages/relay && lumi-relay service restart",
    };
  }

  // The rung that fails closed. A unit pointing somewhere else means `npm i -g` would replace a
  // bundle the supervisor does not exec, and the relay would keep serving the old version while
  // every surface reported success.
  if (facts.serviceInstalled && facts.serviceExec) {
    if (detectInstallMode(facts.serviceExec) !== "global-npm") {
      return {
        action: "refuse",
        reason: `the service execs ${facts.serviceExec}, which is not the installed package`,
        fix: "Run `lumi-relay service install` from the install you want it to use, then update.",
      };
    }
  }

  return {
    action: "install",
    reason: facts.serviceInstalled
      ? "installed package, and the service execs it"
      : "installed package (no service installed — you will need to restart it yourself)",
  };
}

function run(command: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/**
 * The version of the package that the given CLI path belongs to — read from disk, not from the
 * module we imported, because the whole question is what is on disk NOW.
 */
export function installedVersionAt(cli: string): string | null {
  // …/@lumi.ai/relay/dist/cli/index.js → …/@lumi.ai/relay/package.json
  const marker = `node_modules${path.sep}${PACKAGE_NAME.replace("/", path.sep)}${path.sep}`;
  const at = cli.indexOf(marker);
  if (at < 0) return null;
  const pkgDir = cli.slice(0, at + marker.length);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface UpdateOutcome {
  status: "refused" | "unchanged" | "updated" | "install-failed" | "unverified";
  message: string;
  from?: string;
  to?: string;
}

export function runUpdate(options: { channel?: string; restart?: boolean } = {}): UpdateOutcome {
  const status = serviceStatus();
  const decision = planUpdate({
    runningCli: cliPath(),
    serviceExec: status.execPath,
    serviceInstalled: status.state !== "not-installed" && status.state !== "unsupported",
  });

  if (decision.action === "refuse") {
    return { status: "refused", message: `${decision.reason}\n  → ${decision.fix}` };
  }

  const target = status.execPath ?? cliPath();
  const before = installedVersionAt(target) ?? RELAY_VERSION;
  const spec = `${PACKAGE_NAME}@${options.channel ?? "latest"}`;

  const install = run("npm", ["install", "-g", spec]);
  if (!install.ok) {
    return { status: "install-failed", message: `npm install -g ${spec} failed:\n${install.out}` };
  }

  // npm exited 0. That is not evidence. Re-read the version at the path the supervisor execs —
  // an install into a different Node prefix succeeds completely and changes nothing here.
  const after = installedVersionAt(target);
  if (after === null) {
    return {
      status: "unverified",
      message:
        `npm reported success, but the version at ${target} could not be read.\n` +
        "Check that this is the install the service execs before trusting the result.",
      from: before,
    };
  }
  if (after === before) {
    return {
      status: "unchanged",
      message:
        `npm reported success, but ${target} is still ${after}.\n` +
        "That usually means npm installed into a different prefix (an nvm switch, a second Node) — " +
        "the bundle the service execs was not replaced.",
      from: before,
      to: after,
    };
  }

  if (options.restart === false) {
    return { status: "updated", message: `${before} → ${after} (not restarted)`, from: before, to: after };
  }

  const restart = run(
    process.platform === "linux" ? "systemctl" : "launchctl",
    process.platform === "linux"
      ? ["--user", "restart", "lumi-relay.service"]
      : ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/com.lumi.relay`]
  );
  return {
    status: "updated",
    message: restart.ok
      ? `${before} → ${after}, service restarted`
      : `${before} → ${after}. The restart failed (${restart.out}) — run \`lumi-relay service restart\`.`,
    from: before,
    to: after,
  };
}

/** What the registry is offering, without installing anything. */
export function checkForUpdate(channel = "latest"): { latest: string | null; current: string } {
  const view = run("npm", ["view", `${PACKAGE_NAME}@${channel}`, "version"]);
  return { latest: view.ok ? view.out.trim() || null : null, current: RELAY_VERSION };
}

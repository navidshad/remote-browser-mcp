// Where the relay keeps its state: `~/.lumi-relay/`, overridable with `LUMI_RELAY_HOME`.
//
// ONE FILE, AND IT IS AN ENV FILE, not JSON. Everything the relay needs to be configured with is
// either a secret or a number systemd already knows how to hand a process, so `relay.env` is both
// the config and the systemd `EnvironmentFile` — there is no second representation to keep in
// step, and running the daemon by hand is `set -a; . relay.env` rather than a bespoke loader.
//
// THE MODE IS THE POINT. It holds two long-lived keys, so it is written 0600 inside a 0700
// directory, and `service install` points at it rather than baking the values into the unit —
// see service.ts, where that distinction is load-bearing rather than fastidious.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DIR_NAME = ".lumi-relay";

export function configDir(): string {
  return process.env.LUMI_RELAY_HOME || path.join(os.homedir(), DIR_NAME);
}

export function envFile(): string {
  return path.join(configDir(), "relay.env");
}

export function logDir(): string {
  return path.join(configDir(), "logs");
}

export function ensureConfigDir(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Parse a `KEY=value` file the way systemd's `EnvironmentFile=` does closely enough for our own
 * keys: no interpolation, no `export`, one assignment per line, `#` comments, optional surrounding
 * quotes.
 *
 * Deliberately narrow. A general dotenv parser would accept things systemd would then read
 * differently — multi-line values, `${VAR}` expansion — and the file's ONLY job is to be read
 * identically by two consumers. Anything this cannot represent should not be in here.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function serializeEnvFile(values: Record<string, string>): string {
  const header = [
    "# lumi-relay configuration.",
    "#",
    "# Read by BOTH the daemon and systemd (`EnvironmentFile=`), so keep it to plain KEY=value:",
    "# no interpolation, no `export`, no multi-line values. See packages/relay/README.md.",
    "#",
    "# This file holds two long-lived secrets. It is mode 0600 for a reason; do not copy it around.",
    "",
  ].join("\n");
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return `${header}${body}\n`;
}

export function readEnvFile(): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(envFile(), "utf8"));
  } catch {
    return {};
  }
}

export function writeEnvFile(values: Record<string, string>): string {
  ensureConfigDir();
  const file = envFile();
  fs.writeFileSync(file, serializeEnvFile(values), { mode: 0o600 });
  // Re-assert the mode: writeFileSync's `mode` applies only when it CREATES the file, so a second
  // `setup` on a file somebody had chmod'ed 644 would leave it there.
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * Load `relay.env` into `process.env` WITHOUT overriding anything already set.
 *
 * The precedence is the important half. Under systemd the values arrive as real environment
 * variables and this is a no-op; run by hand, the file fills them in. A variable exported in the
 * shell always wins, so a one-off `RELAY_PORT=9000 lumi-relay start` does what it looks like.
 */
export function loadEnvFileIntoProcess(): void {
  for (const [key, value] of Object.entries(readEnvFile())) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

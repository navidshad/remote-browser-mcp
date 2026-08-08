// `lumi-relay setup` — write `relay.env`, minting the two keys if they do not exist yet.
//
// IDEMPOTENT, AND THAT IS A SAFETY PROPERTY RATHER THAN A CONVENIENCE. Re-running setup must never
// rotate a key: the ticket key is shared with Crew, and rotating it silently disconnects every
// browser on the fleet with `unauthorized` — which the extension correctly treats as "stop and
// tell the human" rather than "retry". Rotation is `--rotate`, spelled out loud, and it prints
// what has to change on the Crew side before it will help.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { envFile, readEnvFile, writeEnvFile } from "../paths.js";

export interface SetupOptions {
  rotate?: boolean;
  port?: string;
  healthUrl?: string;
  instanceId?: string;
}

export interface SetupResult {
  file: string;
  created: boolean;
  rotated: boolean;
  controlKey: string;
  ticketKey: string;
}

function newKey(): string {
  return randomBytes(32).toString("hex");
}

export function runSetup(options: SetupOptions): SetupResult {
  const existing = readEnvFile();
  const created = !fs.existsSync(envFile());
  const rotate = !!options.rotate;

  const controlKey = rotate || !existing.RELAY_CONTROL_KEY ? newKey() : existing.RELAY_CONTROL_KEY;
  let ticketKey = rotate || !existing.RELAY_TICKET_KEY ? newKey() : existing.RELAY_TICKET_KEY;

  // Belt and braces against a hand-edited file that set both to the same string: the daemon would
  // refuse to start, which is correct but happens later and somewhere else.
  while (ticketKey === controlKey) ticketKey = newKey();

  const next: Record<string, string> = {
    ...existing,
    RELAY_CONTROL_KEY: controlKey,
    RELAY_TICKET_KEY: ticketKey,
  };
  if (options.port) next.RELAY_PORT = options.port;
  if (options.instanceId) next.RELAY_INSTANCE_ID = options.instanceId;
  if (options.healthUrl !== undefined) {
    if (options.healthUrl === "") delete next.RELAY_HEALTH_URL;
    else next.RELAY_HEALTH_URL = options.healthUrl;
  }
  // Defaults written EXPLICITLY the first time round, so the file documents what is adjustable
  // instead of being three lines that imply nothing else exists.
  next.RELAY_PORT ??= "8787";
  next.RELAY_BIND_HOST ??= "127.0.0.1";
  next.RELAY_INSTANCE_ID ??= "relay";

  const file = writeEnvFile(next);
  return { file, created, rotated: rotate, controlKey, ticketKey };
}

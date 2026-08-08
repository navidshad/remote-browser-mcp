// The long-running half: load config, start the relay, and shut it down without breaking a click.

import { loadConfig } from "./config.js";
import { startRelay, type RunningRelay } from "./server.js";
import { appendLog } from "./logging.js";
import { RELAY_VERSION } from "./version.js";
import { loadEnvFileIntoProcess } from "./paths.js";

/**
 * Log to stdout AND the rotating file.
 *
 * Both, not either. Under systemd stdout goes to the journal, which is the right place — but this
 * relay may end up on a box where the operator's instinct is `tail -f`, and `journalctl --user`
 * needs a session that `sudo -u` does not give you. One line in two places costs nothing.
 */
function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendLog(line);
}

export async function runDaemon(): Promise<RunningRelay> {
  loadEnvFileIntoProcess();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    appendLog(`FATAL: ${message}`);
    process.exit(1);
  }

  const relay = await startRelay(config, log);

  log(`lumi-relay ${RELAY_VERSION} (${config.instanceId}) — node ${process.version}`);
  log(`  control : http://${config.bindHost}:${relay.port}/v1/*  (bearer required)`);
  log(`  browsers: ws://${config.bindHost}:${relay.port}/ws      (ticket required)`);
  log(`  liveness: http://${config.bindHost}:${relay.port}/health`);
  if (config.bindHost !== "127.0.0.1" && config.bindHost !== "localhost") {
    log(`  NOTE    : bound to ${config.bindHost}, not loopback — the keys are all that is in front.`);
  }
  relay.health.start();

  // ── shutdown ─────────────────────────────────────────────────────────────────────────────
  //
  // Drain BEFORE closing: an in-flight command is a click somebody's agent already committed to,
  // and hanging up on it mid-air is the one failure a restart should never cause. Sockets are then
  // closed with 1012 "Service Restart", which the extension's existing backoff already treats as
  // temporary — so an upgrade costs a browser a few seconds of reconnect and needs no extension
  // change at all.
  //
  // `TimeoutStopSec` in the unit must exceed `RELAY_DRAIN_GRACE_MS`, or systemd SIGKILLs us
  // mid-drain and the draining was theatre. See service.ts.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(
      `[shutdown] ${signal} — draining ${relay.hub.inFlight()} command(s) from ${relay.hub.size} browser(s)`
    );
    await relay.close();
    log("[shutdown] done");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return relay;
}

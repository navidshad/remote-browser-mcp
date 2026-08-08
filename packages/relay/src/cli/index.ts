#!/usr/bin/env node
// lumi-relay — the CLI. `start` is the daemon; everything else is about getting it installed,
// keeping it running, and telling you the truth when it is not.

import { Command } from "commander";
import fs from "node:fs";
import pc from "picocolors";
import { runDaemon } from "../daemon.js";
import { configDir, envFile, readEnvFile, writeEnvFile } from "../paths.js";
import { followLog, logFile, readTail } from "../logging.js";
import {
  installService,
  restartService,
  serviceStatus,
  stopService,
  uninstallService,
} from "../service.js";
import { RELAY_VERSION } from "../version.js";
import { runSetup } from "./setup.js";
import { doctorExitCode, runDoctor, type Check } from "./doctor.js";
import { checkForUpdate, runUpdate } from "./update.js";

const program = new Command();

program
  .name("lumi-relay")
  .description(
    "Lumi Crew browser relay — holds one WebSocket per connected browser so agents can drive it."
  )
  .version(RELAY_VERSION);

// ── start ────────────────────────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Run the relay in the foreground (this is what the service unit execs)")
  .action(async () => {
    await runDaemon();
  });

// ── setup ────────────────────────────────────────────────────────────────────────────────────

program
  .command("setup")
  .description("Write relay.env, minting the two keys if they do not exist yet")
  .option("--rotate", "Mint NEW keys, invalidating the ones Crew currently holds")
  .option("--port <port>", "Port to listen on")
  .option("--instance-id <id>", "Name for this box in its health reports")
  .option("--health-url <url>", "Crew's crewBrowserRelayHealth endpoint (empty string to disable)")
  .action((options) => {
    const result = runSetup(options);
    console.log("");
    console.log(pc.bold(result.created ? "Relay configured." : "Configuration updated."));
    console.log(`  ${result.file}`);
    console.log("");

    if (result.created || result.rotated) {
      console.log(pc.bold("Copy these into Google Secret Manager, then never again:"));
      console.log("");
      console.log(`  CREW_BROWSER_RELAY_KEY   ${result.controlKey}`);
      console.log(`  CREW_BROWSER_TICKET_KEY  ${result.ticketKey}`);
      console.log("");
      console.log(
        pc.dim(
          "Both must exist BEFORE the Crew functions deploy, or workspaceMcp fails to deploy at all\n" +
            "and the Ship loses every tool, not just the browser ones."
        )
      );
      if (result.rotated) {
        console.log("");
        console.log(
          pc.yellow(
            "Rotated. Every connected browser will be refused until Crew is redeployed with the\n" +
              "new ticket key — and the extension treats that refusal as 'stop and tell the human',\n" +
              "not as something to retry."
          )
        );
      }
    } else {
      console.log(
        pc.dim("Existing keys kept. `lumi-relay config show-keys` prints them; --rotate replaces them.")
      );
    }
    console.log("");
    console.log("Next: `lumi-relay service install`, then `lumi-relay doctor`.");
  });

// ── config ───────────────────────────────────────────────────────────────────────────────────

const config = program.command("config").description("Inspect and edit relay.env");

config
  .command("path")
  .description("Print the configuration file path")
  .action(() => console.log(envFile()));

config
  .command("list", { isDefault: true })
  .description("Print the configuration, with the secrets masked")
  .action(() => {
    const env = readEnvFile();
    if (Object.keys(env).length === 0) {
      console.log("No configuration. Run `lumi-relay setup`.");
      return;
    }
    console.log(`# ${envFile()}`);
    for (const [key, value] of Object.entries(env)) {
      // Masked by default. `config list` is the command somebody runs while screen-sharing.
      const masked = /KEY$/.test(key) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
      console.log(`${key}=${masked}`);
    }
  });

config
  .command("show-keys")
  .description("Print the two keys in full (for Secret Manager)")
  .action(() => {
    const env = readEnvFile();
    if (!env.RELAY_CONTROL_KEY) {
      console.error("No configuration. Run `lumi-relay setup`.");
      process.exit(1);
    }
    console.log(`CREW_BROWSER_RELAY_KEY   ${env.RELAY_CONTROL_KEY}`);
    console.log(`CREW_BROWSER_TICKET_KEY  ${env.RELAY_TICKET_KEY}`);
  });

config
  .command("set <key> <value>")
  .description("Set one variable (refuses the two keys — use `setup --rotate`)")
  .action((key: string, value: string) => {
    if (key === "RELAY_CONTROL_KEY" || key === "RELAY_TICKET_KEY") {
      console.error(
        `${key} is not settable here. Changing a key by hand is how it ends up matching the other\n` +
          "one, or shorter than the minimum, or out of step with Crew. Use `lumi-relay setup --rotate`."
      );
      process.exit(1);
    }
    const env = readEnvFile();
    if (Object.keys(env).length === 0) {
      console.error("No configuration. Run `lumi-relay setup`.");
      process.exit(1);
    }
    writeEnvFile({ ...env, [key]: value });
    console.log(`${key}=${value}`);
    console.log(pc.dim("The running relay does not reread this. `lumi-relay service restart`."));
  });

// ── service ──────────────────────────────────────────────────────────────────────────────────

const service = program.command("service").description("Run the relay as an OS service");

service
  .command("install")
  .description("Install and start the service unit")
  .action(() => {
    try {
      const result = installService();
      console.log(`Installed ${result.unitPath}`);
      for (const note of result.notes) console.log(pc.yellow(`  ! ${note}`));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

service
  .command("uninstall")
  .description("Stop and remove the service unit")
  .action(() => {
    uninstallService();
    console.log("Removed.");
  });

service
  .command("start")
  .description("Start (or restart) the service")
  .action(() => {
    restartService();
    console.log("Started.");
  });

service
  .command("restart")
  .description("Restart the service, draining in-flight commands first")
  .action(() => {
    restartService();
    console.log("Restarted.");
  });

service
  .command("stop")
  .description("Stop the service")
  .action(() => {
    stopService();
    console.log("Stopped.");
  });

service
  .command("status", { isDefault: true })
  .description("Print the service state")
  .action(() => {
    const status = serviceStatus();
    console.log(`${status.state}: ${status.detail}`);
    if (status.unitPath) console.log(`  unit: ${status.unitPath}`);
    if (status.execPath) console.log(`  exec: ${status.execPath}${status.execMissing ? " (MISSING)" : ""}`);
    if (status.envFilePath) console.log(`  env : ${status.envFilePath}`);
  });

// ── logs ─────────────────────────────────────────────────────────────────────────────────────

program
  .command("logs")
  .description("Print the relay log")
  .option("-n, --lines <count>", "How many lines", "50")
  .option("-f, --follow", "Follow new lines")
  .action((options: { lines: string; follow?: boolean }) => {
    if (!fs.existsSync(logFile())) {
      console.log(`No log yet at ${logFile()}.`);
      if (!options.follow) return;
    }
    for (const line of readTail(Number.parseInt(options.lines, 10) || 50)) console.log(line);
    if (options.follow) {
      const stop = followLog((line) => console.log(line));
      process.on("SIGINT", () => {
        stop();
        process.exit(0);
      });
    }
  });

// ── doctor ───────────────────────────────────────────────────────────────────────────────────

const MARK: Record<Check["status"], string> = {
  ok: pc.green("✔"),
  warn: pc.yellow("!"),
  fail: pc.red("✖"),
  skip: pc.dim("-"),
};

program
  .command("doctor")
  .description("Check everything worth checking before blaming the relay")
  .action(async () => {
    const checks = await runDoctor();
    console.log("");
    for (const check of checks) {
      console.log(`${MARK[check.status]} ${check.name.padEnd(14)} ${check.detail}`);
      if (check.fix && check.status !== "ok") console.log(`  ${pc.dim(`→ ${check.fix}`)}`);
    }
    console.log("");
    const failures = checks.filter((c) => c.status === "fail").length;
    const warnings = checks.filter((c) => c.status === "warn").length;
    console.log(
      failures > 0
        ? pc.red(`${failures} problem(s) to fix.`)
        : warnings > 0
          ? pc.yellow(`Working, with ${warnings} thing(s) that will bite later.`)
          : pc.green("All good.")
    );
    process.exit(doctorExitCode(checks));
  });

// ── update ───────────────────────────────────────────────────────────────────────────────────

program
  .command("update")
  .description("Update to the latest published relay and restart the service")
  .option("--check", "Only report what is available")
  .option("--channel <tag>", "npm dist-tag to follow", "latest")
  .option("--no-restart", "Install without restarting")
  .action((options: { check?: boolean; channel: string; restart: boolean }) => {
    if (options.check) {
      const { latest, current } = checkForUpdate(options.channel);
      if (!latest) {
        console.log(`Could not reach the registry. Running ${current}.`);
        return;
      }
      console.log(
        latest === current ? `Up to date (${current}).` : `${current} → ${latest} available.`
      );
      return;
    }
    const outcome = runUpdate({ channel: options.channel, restart: options.restart });
    const colour =
      outcome.status === "updated"
        ? pc.green
        : outcome.status === "unchanged" || outcome.status === "refused"
          ? pc.yellow
          : pc.red;
    console.log(colour(outcome.message));
    if (outcome.status === "install-failed" || outcome.status === "unverified") process.exit(1);
  });

// ── where things live ────────────────────────────────────────────────────────────────────────

program
  .command("home")
  .description("Print the state directory")
  .action(() => console.log(configDir()));

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// The CLI's decisions, not its printing: env-file round-tripping, setup's idempotence, the unit
// files and their inverses, and every rung of the update ladder.
//
// `LUMI_RELAY_HOME` points at a scratch directory for the whole file, so nothing here can touch a
// real machine's configuration — the same seam the Crew runner's e2e suite uses.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-relay-test-"));
process.env.LUMI_RELAY_HOME = HOME;

const { parseEnvFile, serializeEnvFile, readEnvFile, writeEnvFile, envFile, loadEnvFileIntoProcess } =
  await import("./paths.js");
const { runSetup } = await import("./cli/setup.js");
const { systemdUnit, plistXml, parseSystemdCliPath, parseSystemdEnvFile, parsePlistCliPath, escapeXml, unescapeXml, NOFILE_LIMIT } =
  await import("./service.js");
const { planUpdate, detectInstallMode } = await import("./cli/update.js");

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

describe("relay.env", () => {
  it("round-trips through the format systemd will read", () => {
    const values = { RELAY_PORT: "8788", RELAY_CONTROL_KEY: "a".repeat(64) };
    assert.deepEqual(parseEnvFile(serializeEnvFile(values)), values);
  });

  it("ignores comments and blank lines, and strips one layer of quotes", () => {
    const parsed = parseEnvFile(
      ["# a comment", "", "RELAY_PORT=8788", 'RELAY_INSTANCE_ID="box one"', "  RELAY_BIND_HOST=127.0.0.1  "].join("\n")
    );
    assert.deepEqual(parsed, {
      RELAY_PORT: "8788",
      RELAY_INSTANCE_ID: "box one",
      RELAY_BIND_HOST: "127.0.0.1",
    });
  });

  it("writes 0600 and re-asserts it on a file somebody chmod'ed open", () => {
    const file = writeEnvFile({ RELAY_PORT: "1" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644);
    writeEnvFile({ RELAY_PORT: "2" });
    // `writeFileSync`'s mode applies only when it CREATES the file, so without the explicit
    // chmod a second setup would leave two long-lived secrets world-readable.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("never overrides a variable the shell already exported", () => {
    writeEnvFile({ RELAY_PORT: "8788", RELAY_INSTANCE_ID: "from-file" });
    process.env.RELAY_INSTANCE_ID = "from-shell";
    delete process.env.RELAY_PORT;
    loadEnvFileIntoProcess();
    assert.equal(process.env.RELAY_PORT, "8788");
    assert.equal(process.env.RELAY_INSTANCE_ID, "from-shell");
    delete process.env.RELAY_INSTANCE_ID;
    delete process.env.RELAY_PORT;
  });
});

describe("setup", () => {
  before(() => fs.rmSync(envFile(), { force: true }));

  it("mints two distinct keys and writes the adjustable defaults explicitly", () => {
    const first = runSetup({});
    assert.equal(first.created, true);
    assert.notEqual(first.controlKey, first.ticketKey);
    assert.equal(first.controlKey.length, 64);
    const env = readEnvFile();
    assert.equal(env.RELAY_PORT, "8787");
    assert.equal(env.RELAY_BIND_HOST, "127.0.0.1");
  });

  it("KEEPS the keys when run again — rotating silently would disconnect the fleet", () => {
    // The ticket key is shared with Crew. Rotating it refuses every connected browser with
    // `unauthorized`, which the extension correctly treats as "stop and tell the human" rather
    // than something to retry — so a second `setup` must never be the thing that does it.
    const before = readEnvFile();
    const again = runSetup({ port: "8788" });
    assert.equal(again.created, false);
    assert.equal(again.rotated, false);
    assert.equal(again.controlKey, before.RELAY_CONTROL_KEY);
    assert.equal(again.ticketKey, before.RELAY_TICKET_KEY);
    assert.equal(readEnvFile().RELAY_PORT, "8788");
  });

  it("rotates only when asked, and to a fresh distinct pair", () => {
    const before = readEnvFile();
    const rotated = runSetup({ rotate: true });
    assert.equal(rotated.rotated, true);
    assert.notEqual(rotated.controlKey, before.RELAY_CONTROL_KEY);
    assert.notEqual(rotated.ticketKey, before.RELAY_TICKET_KEY);
    assert.notEqual(rotated.controlKey, rotated.ticketKey);
  });

  it("clears the health URL on an empty string rather than writing one", () => {
    runSetup({ healthUrl: "https://example.test/health" });
    assert.equal(readEnvFile().RELAY_HEALTH_URL, "https://example.test/health");
    runSetup({ healthUrl: "" });
    assert.equal("RELAY_HEALTH_URL" in readEnvFile(), false);
  });
});

describe("the systemd unit", () => {
  it("points at relay.env rather than carrying the keys", () => {
    const unit = systemdUnit();
    // A unit file is world-readable under ~/.config/systemd/user, and `systemctl show` prints its
    // environment. The keys must exist in exactly one place on disk, at 0600.
    assert.equal(unit.includes("EnvironmentFile="), true);
    assert.equal(unit.includes("RELAY_CONTROL_KEY="), false);
    assert.equal(unit.includes("RELAY_TICKET_KEY="), false);
    assert.equal(parseSystemdEnvFile(unit), envFile());
  });

  it("raises the descriptor ceiling, because one browser is one fd", () => {
    assert.equal(systemdUnit().includes(`LimitNOFILE=${NOFILE_LIMIT}`), true);
  });

  it("waits longer to stop than the relay takes to drain", () => {
    // TimeoutStopSec must exceed RELAY_DRAIN_GRACE_MS (20 s default), or systemd SIGKILLs the
    // process mid-drain and the draining was theatre.
    const seconds = Number(/TimeoutStopSec=(\d+)/.exec(systemdUnit())?.[1]);
    assert.ok(seconds > 20, `TimeoutStopSec=${seconds} does not exceed the 20 s drain grace`);
  });

  it("round-trips its exec path", () => {
    const parsed = parseSystemdCliPath(systemdUnit());
    assert.equal(typeof parsed, "string");
    // Absolute and ending at the CLI entry. NOT asserted to be under `dist/`: `cliPath()` resolves
    // relative to the running module, so it is `src/cli/index.ts`'s neighbour under tsx and
    // `dist/cli/index.js` once built — and the invariant that matters is the same in both.
    assert.equal(path.isAbsolute(parsed!), true);
    assert.equal(parsed!.endsWith(path.join("cli", "index.js")), true);
  });

  it("refuses to guess when the exec line is ambiguous", () => {
    // ExecStart is unquoted, so a path containing a space is genuinely ambiguous. Guessing would
    // hand `doctor` a path that does not exist and manufacture a false "your service is broken".
    assert.equal(parseSystemdCliPath("ExecStart=/usr/bin/node /opt/my relay/cli.js start"), undefined);
    assert.equal(parseSystemdCliPath("ExecStartPre=/bin/true"), undefined);
  });
});

describe("the launchd plist", () => {
  it("round-trips its exec path through XML escaping", () => {
    const parsed = parsePlistCliPath(plistXml());
    assert.equal(typeof parsed, "string");
    assert.equal(path.isAbsolute(parsed!), true);
    assert.equal(parsed!.endsWith(path.join("cli", "index.js")), true);
  });

  it("unescapes in the mirror order it escapes", () => {
    // `&amp;` must be replaced LAST, or `&amp;lt;` (an escaped literal `&lt;`) collapses to `<`.
    const original = 'a & b < c > d "e" &lt;';
    assert.equal(unescapeXml(escapeXml(original)), original);
  });

  it("is anchored on ProgramArguments, not on the first array in the document", () => {
    const withExtraArray = plistXml().replace(
      "<key>ProgramArguments</key>",
      "<key>WatchPaths</key>\n  <array>\n    <string>/tmp/decoy</string>\n  </array>\n  <key>ProgramArguments</key>"
    );
    assert.notEqual(parsePlistCliPath(withExtraArray), "/tmp/decoy");
  });
});

describe("the update ladder", () => {
  const globalCli = path.join(
    "/usr/local/lib/node_modules",
    "@lumi.ai",
    "relay",
    "dist",
    "cli",
    "index.js"
  );

  it("knows an installed package from a working copy", () => {
    assert.equal(detectInstallMode(globalCli), "global-npm");
    assert.equal(detectInstallMode("/home/ubuntu/src/relay/packages/relay/dist/cli/index.js"), "checkout");
  });

  it("refuses to npm-install over a working copy, and says what to do instead", () => {
    const decision = planUpdate({
      runningCli: "/opt/kilogent/relay/packages/relay/dist/cli/index.js",
      serviceInstalled: true,
      serviceExec: "/opt/kilogent/relay/packages/relay/dist/cli/index.js",
    });
    assert.equal(decision.action, "refuse");
    assert.match(decision.action === "refuse" ? decision.fix : "", /git pull/);
  });

  it("FAILS CLOSED when the service execs something other than the installed package", () => {
    // `npm i -g` would replace a bundle the supervisor does not exec. Every surface would report
    // success and the relay would keep serving the old version.
    const decision = planUpdate({
      runningCli: globalCli,
      serviceInstalled: true,
      serviceExec: "/opt/kilogent/relay/packages/relay/dist/cli/index.js",
    });
    assert.equal(decision.action, "refuse");
    assert.match(decision.action === "refuse" ? decision.reason : "", /not the installed package/);
  });

  it("proceeds when the service execs the package this CLI came from", () => {
    const decision = planUpdate({ runningCli: globalCli, serviceInstalled: true, serviceExec: globalCli });
    assert.equal(decision.action, "install");
  });

  it("proceeds with no service installed, but says the restart is yours", () => {
    const decision = planUpdate({ runningCli: globalCli, serviceInstalled: false });
    assert.equal(decision.action, "install");
    assert.match(decision.action === "install" ? decision.reason : "", /restart it yourself/);
  });

  it("does not refuse merely because the unit's exec path could not be read", () => {
    // Fail open on ambiguity: an unparseable unit is not evidence of a wrong install.
    const decision = planUpdate({ runningCli: globalCli, serviceInstalled: true });
    assert.equal(decision.action, "install");
  });
});

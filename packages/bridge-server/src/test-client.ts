#!/usr/bin/env node
// Local test client for the bridge MCP face. Verifies: connect, tool list,
// status, and a bridge_ping round-trip through to the extension. Doubles as the
// M3 keepalive poller when run in a loop (set POLL_TOOL=browser_snapshot).
//
//   npm run test:client --workspace=packages/bridge-server
//   BRIDGE_URL=http://localhost:3000/mcp POLL_TOOL=bridge_ping node dist/test-client.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://localhost:3000/mcp";

type Part = { type: string; text?: string };
const firstText = (r: unknown): string =>
  ((r as { content?: Part[] }).content ?? []).find((p) => p.type === "text")?.text ?? "";

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  console.log(`  ✗ ${m}`);
  failures++;
};

async function main() {
  console.log(`Bridge MCP test client → ${BRIDGE_URL}\n`);

  const client = new Client({ name: "bridge-test-client", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(BRIDGE_URL)));
  pass("connected to bridge MCP face");

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  names.includes("check_local_status") ? pass("check_local_status present") : fail("check_local_status missing");
  names.includes("browser_navigate") ? pass(`browser tools present (${names.length} total)`) : fail("browser tools missing");
  names.includes("bridge_ping") ? pass("bridge_ping present") : fail("bridge_ping missing");

  const status = JSON.parse(firstText(await client.callTool({ name: "check_local_status", arguments: {} })));
  console.log(`    status: ${status.message}`);

  if (status.chrome_debug_accessible) {
    const pong = await client.callTool({ name: "bridge_ping", arguments: {} });
    const text = firstText(pong);
    (pong as { isError?: boolean }).isError
      ? fail(`bridge_ping returned error: ${text}`)
      : pass(`bridge_ping round-trip ok: "${text}"`);
  } else {
    console.log("\n  (extension not connected — skipping bridge_ping round-trip)");
  }

  console.log();
  if (failures === 0) {
    console.log("✓ All checks passed.");
    process.exit(0);
  }
  console.log(`✗ ${failures} check(s) failed.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Test client error:", err);
  process.exit(1);
});

// Integration: a REAL relay on an ephemeral port, with fake extensions dialling in over real
// WebSockets and a fake Crew calling the real control plane over real HTTP.
//
// Deliberately not unit tests of the hub. Everything that can actually go wrong here lives in how
// the pieces meet — a supersede racing an in-flight dispatch, an upgrade on the wrong path, a
// drain with work outstanding, a session reconnecting into a tab group that already exists — and
// none of that is reachable by exercising a class in isolation.

import { describe, it, beforeAll, afterEach, afterAll } from "vitest";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { RelayConfig } from "./config.js";
import { startRelay, type RunningRelay } from "./server.js";
import { resolveAuthProvider } from "./providers/index.js";
import { mintRelayTicket } from "./providers/ticket/ticket.js";

const CONTROL_KEY = "c".repeat(64);
const TICKET_KEY = "t".repeat(64);

const config: RelayConfig = {
  port: 0,
  bindHost: "127.0.0.1",
  controlKey: CONTROL_KEY,
  auth: resolveAuthProvider({ RELAY_CONTROL_KEY: CONTROL_KEY, RELAY_TICKET_KEY: TICKET_KEY }),
  maxBrowsers: 3,
  sessionIdleMs: 0, // no reaper; these tests never idle long enough for it to be anything but flake
  drainGraceMs: 2_000,
  healthUrl: null,
  healthIntervalMs: 30_000,
  instanceId: "test",
};

let relay: RunningRelay;
let base: string;

/** Every extension a test opened, so cleanup happens even when an assertion throws. Without this
 *  a single failure leaks a live socket into the next test, which then fails for a reason that has
 *  nothing to do with what it is testing — and the cascade reads like three bugs. */
const opened: FakeExtension[] = [];

/** A stand-in extension: dials in, answers `cmd` frames however the test says to. */
class FakeExtension {
  readonly received: Array<Record<string, unknown>> = [];
  private ws!: WebSocket;
  /** Latched the moment the socket exists, never on demand. A refusal closes the socket in the
   *  same breath as the error frame, so a listener attached afterwards waits forever for an event
   *  that already fired — which is a hung suite, not a failed assertion. */
  private closed!: Promise<number>;
  /** Set to null to make it go silent — the timeout path. */
  answer: ((cmd: Record<string, unknown>) => unknown) | null = (cmd) => ({
    content: [{ type: "text", text: `did ${String(cmd.name)}` }],
  });

  constructor() {
    opened.push(this);
  }

  async connect(
    ticket: string,
    meta: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    this.ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`);

    // EVERY listener goes on before the first `await`, and that is the whole trick. A refusal —
    // a bad ticket, a full relay — is written and the socket closed in one breath, so the error
    // frame can share a TCP segment with the handshake response and be emitted in the same tick
    // that `open` is. Anything attached one microtask later misses it, and a missed frame here is
    // a promise nobody ever resolves: the suite hangs rather than failing, and the stack when you
    // finally kill it points at whatever test happened to be running.
    this.closed = new Promise<number>((resolve) => this.ws.once("close", (code) => resolve(code)));

    let resolveFirst: (m: Record<string, unknown>) => void;
    const firstFrame = new Promise<Record<string, unknown>>((r) => (resolveFirst = r));
    let seenFirst = false;
    this.ws.on("message", (d) => {
      const msg = JSON.parse(d.toString()) as Record<string, unknown>;
      if (!seenFirst) {
        seenFirst = true;
        resolveFirst(msg);
        return;
      }
      this.received.push(msg);
      if (msg.t === "ping") this.ws.send(JSON.stringify({ t: "pong" }));
      if (msg.t === "cmd" && this.answer) {
        this.ws.send(JSON.stringify({ t: "res", id: msg.id, ok: true, result: this.answer(msg) }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.send(JSON.stringify({ t: "hello", v: 2, ticket, ...meta }));

    // A close with no reply at all still has to resolve to SOMETHING. Silence is the one outcome
    // a test can neither assert on nor recover from.
    return Promise.race([
      firstFrame,
      this.closed.then((code) => ({ t: "closed", code }) as Record<string, unknown>),
    ]);
  }

  /** Connect and insist it worked, so a capacity refusal or a bad ticket surfaces HERE rather
   *  than as a command that mysteriously never arrives. */
  async connectOk(ticket: string, meta: Record<string, unknown> = {}): Promise<void> {
    const reply = await this.connect(ticket, meta);
    assert.equal(reply.t, "welcome", `expected welcome, got ${JSON.stringify(reply)}`);
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  frames(t: string): Array<Record<string, unknown>> {
    return this.received.filter((m) => m.t === t);
  }

  get closeCode(): Promise<number> {
    return this.closed;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}

function ticketFor(ownerId: string, browserId: string, ttlMs?: number): string {
  return mintRelayTicket(TICKET_KEY, { ownerId, browserId, ttlMs });
}

async function control(
  path: string,
  init: { method?: string; body?: unknown; key?: string | null } = {}
): Promise<{ status: number; body: any }> {
  const method = init.method ?? "GET";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? CONTROL_KEY}` }),
    },
    // undici throws outright on a GET with a body, which would fail the test for a reason that
    // has nothing to do with the relay.
    body: method === "GET" || init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.json() };
}

/** Poll rather than sleep — a fixed wait is either flake or slow, and usually both. */
async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("condition never became true");
}

beforeAll(async () => {
  relay = await startRelay(config);
  base = `http://127.0.0.1:${relay.port}`;
});

// Unconditional, so a failing assertion cannot leave a socket behind. One leaked connection is
// enough to push a later test past `maxBrowsers`, and a capacity refusal presents as a command
// that simply never arrives — three failures with one cause, none of them where the cause is.
afterEach(async () => {
  for (const ext of opened) ext.close();
  opened.length = 0;
  await waitFor(() => relay.hub.size === 0);
});

afterAll(async () => {
  await relay.close(0);
});

describe("control plane auth", () => {
  it("serves liveness with no credential and says nothing about who is connected", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    // Derived from `bin`, so this asserts the wiring rather than a literal — a rename that
    // forgot version.ts would show up here.
    assert.equal(body.service, "remote-browser-relay");
    // The lesson from the bridge's /health: this endpoint is deliberately reachable without a
    // credential, so it must never describe a specific human's browser.
    assert.equal("browsers" in body, false);
    assert.equal("sessions" in body, false);
  });

  it("refuses every /v1 route without the key", async () => {
    for (const [method, path] of [
      ["GET", "/v1/health"],
      ["GET", "/v1/browsers"],
      ["POST", "/v1/dispatch"],
      ["POST", "/v1/session/close"],
    ] as const) {
      const res = await control(path, { method, key: null, body: {} });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.deepEqual(res.body, { error: "unauthorized" });
    }
  });

  it("refuses a wrong key", async () => {
    const res = await control("/v1/browsers", { key: "x".repeat(64) });
    assert.equal(res.status, 401);
  });

  it("does not accept the TICKET key on the control plane", async () => {
    // The two secrets authenticate different parties; either one opening both doors would make
    // splitting them pointless.
    const res = await control("/v1/browsers", { key: TICKET_KEY });
    assert.equal(res.status, 401);
  });
});

describe("connecting a browser", () => {
  it("accepts a valid ticket and echoes the identity it proved", async () => {
    const ext = new FakeExtension();
    const welcome = await ext.connect(ticketFor("uid_a", "brw_1"), { label: "A's laptop" });
    assert.equal(welcome.t, "welcome");
    assert.equal(welcome.ownerId, "uid_a");
    assert.equal(welcome.browserId, "brw_1");

    const { body } = await control("/v1/browsers?ownerId=uid_a");
    assert.equal(body.browsers.length, 1);
    assert.equal(body.browsers[0].browserId, "brw_1");
    assert.equal(body.browsers[0].label, "A's laptop");
    assert.equal(body.browsers[0].online, true);
  });

  it("still answers to the OLD spelling of the owner field, on every surface", async () => {
    // `ownerUid` became `ownerId`, and the old name has to keep working for a while: the caller is
    // a deployed backend and the reader is an extension installed on somebody else's machine.
    // Neither changes in the same instant this does, so both spellings are true until they do.
    const ext = new FakeExtension();
    const welcome = await ext.connect(ticketFor("uid_old", "brw_old"));
    assert.equal(welcome.ownerUid, "uid_old", "welcome dropped the old field");
    assert.equal(welcome.ownerId, welcome.ownerUid, "the two names disagreed");

    // TWO owners, or this proves nothing. With one browser connected, an unfiltered list returns
    // that same browser, so `length === 1` holds whether the query param filters or is ignored
    // entirely — the first version of this assertion passed with the whole fallback deleted.
    const other = new FakeExtension();
    await other.connectOk(ticketFor("uid_other", "brw_other"));

    const byOldQuery = await control("/v1/browsers?ownerUid=uid_old");
    assert.equal(byOldQuery.body.browsers.length, 1, "the old query param stopped filtering");
    assert.equal(byOldQuery.body.browsers[0].browserId, "brw_old", "it filtered to the wrong one");
    assert.equal(byOldQuery.body.browsers[0].ownerUid, "uid_old");
    assert.equal(byOldQuery.body.browsers[0].ownerId, "uid_old");
    // And the unfiltered call still sees both, so the 1 above is a filter rather than an empty relay.
    assert.equal((await control("/v1/browsers")).body.browsers.length, 2);

    // The fake answers `cmd` frames by default, so a 200 here proves the dispatch found the socket
    // rather than merely parsing.
    const dispatched = await control("/v1/dispatch", {
      method: "POST",
      body: { ownerUid: "uid_old", browserId: "brw_old", name: "browser_read", args: {} },
    });
    assert.equal(dispatched.status, 200, "a dispatch using the old field name was refused");
    assert.equal(dispatched.body.outcome, "ok");
  });

  it("refuses a ticket signed with the wrong key, with `unauthorized`", async () => {
    const ext = new FakeExtension();
    const reply = await ext.connect(mintRelayTicket("z".repeat(64), { ownerId: "u", browserId: "b" }));
    assert.equal(reply.t, "error");
    assert.equal(reply.code, "unauthorized");
    assert.equal(relay.hub.size, 0);
  });

  it("tells an expired ticket apart, so the extension re-mints instead of backing off", async () => {
    const ext = new FakeExtension();
    const reply = await ext.connect(ticketFor("uid_a", "brw_1", -1));
    assert.equal(reply.t, "error");
    assert.equal(reply.code, "ticket_expired");
    assert.equal(relay.hub.size, 0);
  });

  it("refuses a WebSocket upgrade on any path but /ws", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/dispatch`);
    await new Promise<void>((resolve) => {
      ws.once("error", () => resolve());
      ws.once("open", () => assert.fail("upgrade should have been destroyed"));
    });
  });
});

describe("dispatch", () => {
  it("reaches the right browser and returns its result verbatim", async () => {
    const a = new FakeExtension();
    const b = new FakeExtension();
    await a.connectOk(ticketFor("uid_a", "brw_1"));
    await b.connectOk(ticketFor("uid_b", "brw_1")); // SAME browserId, different owner

    a.answer = () => ({ content: [{ type: "text", text: "from A" }] });
    b.answer = () => ({ content: [{ type: "text", text: "from B" }] });

    const res = await control("/v1/dispatch", {
      method: "POST",
      body: { ownerId: "uid_b", browserId: "brw_1", name: "browser_read", args: {} },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "ok");
    // Same browserId under two owners must not collide — this is the half of the key that stops
    // two colleagues from sharing one entry.
    assert.equal(res.body.result.content[0].text, "from B");
    assert.equal(a.frames("cmd").length, 0);
  });

  it("answers `browser_not_here` for a browser this relay does not hold", async () => {
    // A distinct outcome, not a 500: during a migration between boxes a dispatch can land on the
    // connector that does not hold the socket, and that is a retry rather than a broken browser.
    const res = await control("/v1/dispatch", {
      method: "POST",
      body: { ownerId: "uid_nobody", browserId: "brw_x", name: "browser_read", args: {} },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.outcome, "browser_not_here");
  });

  it("times out inside its own budget rather than hanging", async () => {
    const ext = new FakeExtension();
    await ext.connectOk(ticketFor("uid_t", "brw_t"));
    ext.answer = null; // goes silent

    const started = Date.now();
    const res = await control("/v1/dispatch", {
      method: "POST",
      body: {
        ownerId: "uid_t",
        browserId: "brw_t",
        name: "browser_act",
        args: {},
        timeoutMs: 1_000,
      },
    });
    assert.equal(res.status, 504);
    assert.equal(res.body.outcome, "timeout");
    assert.ok(Date.now() - started < 3_000, "should answer at its own deadline, not the caller's");
  });

  it("passes an extension-reported failure through as a tool result, not a transport error", async () => {
    // The browser answered; the answer is that the page did not cooperate. That is a sentence for
    // the agent to read and act on, not a 502 for Crew to retry.
    const ext = new FakeExtension();
    await ext.connectOk(ticketFor("uid_e", "brw_e"));
    ext.answer = null;

    const ext2 = new FakeExtension();
    await ext2.connectOk(ticketFor("uid_e", "brw_e"));
    ext2.answer = null;
    // Answer manually with ok:false.
    ext2.send({ t: "status", attached: true });
    const pending = control("/v1/dispatch", {
      method: "POST",
      body: { ownerId: "uid_e", browserId: "brw_e", name: "browser_act", args: {}, timeoutMs: 5_000 },
    });
    await waitFor(() => ext2.frames("cmd").length === 1);
    const cmd = ext2.frames("cmd")[0]!;
    ext2.send({ t: "res", id: cmd.id, ok: false, error: { code: "no_such_ref", message: "no element ref e12" } });

    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "ok");
    assert.equal(res.body.result.isError, true);
    assert.equal(res.body.result.content[0].text, "no element ref e12");
  });

  it("rejects a malformed dispatch before it reaches a browser", async () => {
    const res = await control("/v1/dispatch", {
      method: "POST",
      body: { ownerId: "uid_a", name: "browser_read" }, // no browserId
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_request");
  });
});

describe("sessions", () => {
  it("opens a tab group once and pushes the Ship blocklist with it", async () => {
    const ext = new FakeExtension();
    await ext.connectOk(ticketFor("uid_s", "brw_s"));

    const body = {
      ownerId: "uid_s",
      browserId: "brw_s",
      name: "browser_open",
      args: {},
      sessionId: "job_1",
      blockedOrigins: ["https://bank.example"],
    };
    await control("/v1/dispatch", { method: "POST", body });
    await control("/v1/dispatch", { method: "POST", body });

    const opens = ext.frames("session_open");
    assert.equal(opens.length, 1, "a session is announced once, not per command");
    assert.deepEqual(opens[0]!.blockedOrigins, ["https://bank.example"]);
    assert.equal(ext.frames("cmd").length, 2);
  });

  it("pushes a blocklist edit into a session that is ALREADY running", async () => {
    // The whole value of a Ship-level blocklist is during an incident, on the run someone is
    // worried about. A list read only at session-open time would not apply until the job ended.
    const ext = new FakeExtension();
    await ext.connectOk(ticketFor("uid_s2", "brw_s2"));
    const base = {
      ownerId: "uid_s2",
      browserId: "brw_s2",
      name: "browser_act",
      args: {},
      sessionId: "job_2",
    };
    await control("/v1/dispatch", { method: "POST", body: { ...base, blockedOrigins: ["https://a.example"] } });
    await control("/v1/dispatch", {
      method: "POST",
      body: { ...base, blockedOrigins: ["https://a.example", "https://b.example"] },
    });

    const configs = ext.frames("session_config");
    assert.equal(configs.length, 1);
    assert.deepEqual(configs[0]!.blockedOrigins, ["https://a.example", "https://b.example"]);
  });

  it("carries the allow list with the session, and pushes an edit to it", async () => {
    // A run that may only load the sites its caller named. The relay holds no policy — it only has
    // to deliver the list, at open time and when it changes, with the blocklist beside it.
    const ext = new FakeExtension();
    await ext.connectOk(ticketFor("uid_a", "brw_a"));
    const base = {
      ownerId: "uid_a",
      browserId: "brw_a",
      name: "browser_act",
      args: {},
      sessionId: "job_allow",
      blockedOrigins: ["https://bank.example"],
    };
    await control("/v1/dispatch", { method: "POST", body: { ...base, allowedOrigins: ["vinted.com"] } });
    await control("/v1/dispatch", { method: "POST", body: { ...base, allowedOrigins: ["vinted.com"] } });

    const opens = ext.frames("session_open");
    assert.equal(opens.length, 1);
    assert.deepEqual(opens[0]!.allowedOrigins, ["vinted.com"]);
    assert.deepEqual(opens[0]!.blockedOrigins, ["https://bank.example"]);
    assert.equal(ext.frames("session_config").length, 0, "an unchanged list is not pushed again");

    await control("/v1/dispatch", {
      method: "POST",
      body: { ...base, allowedOrigins: ["vinted.com", "example.org"] },
    });
    const configs = ext.frames("session_config");
    assert.equal(configs.length, 1);
    assert.deepEqual(configs[0]!.allowedOrigins, ["vinted.com", "example.org"]);
    assert.deepEqual(
      configs[0]!.blockedOrigins,
      ["https://bank.example"],
      "a push carries BOTH lists, so the extension never merges a partial one",
    );

    // Absent leaves it as it was; [] is a real change back to "any site".
    await control("/v1/dispatch", { method: "POST", body: base });
    assert.equal(ext.frames("session_config").length, 1, "a dispatch that sends no allow list changes nothing");
    await control("/v1/dispatch", { method: "POST", body: { ...base, allowedOrigins: [] } });
    const cleared = ext.frames("session_config");
    assert.equal(cleared.length, 2);
    assert.deepEqual(cleared[1]!.allowedOrigins, []);
  });

  it("a session opened with no allow list announces an empty one", async () => {
    const ext = new FakeExtension();
    await ext.connectOk(ticketFor("uid_a2", "brw_a2"));
    await control("/v1/dispatch", {
      method: "POST",
      body: { ownerId: "uid_a2", browserId: "brw_a2", name: "browser_open", args: {}, sessionId: "job_any" },
    });
    assert.deepEqual(ext.frames("session_open")[0]!.allowedOrigins, []);
  });

  it("refuses an allow list that is not a list of strings", async () => {
    const res = await control("/v1/dispatch", {
      method: "POST",
      body: { ownerId: "uid_x", browserId: "brw_x", name: "browser_open", args: {}, allowedOrigins: "vinted.com" },
    });
    assert.equal(res.status, 400);
  });

  it("closing a session that is not here reports success, not an error", async () => {
    // The tabs we were asked to close went with the browser. Making Crew handle a failure for
    // "already gone" would mean retrying a teardown that can never be needed.
    const res = await control("/v1/session/close", {
      method: "POST",
      body: { ownerId: "uid_gone", browserId: "brw_gone", sessionId: "job_9" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { closed: true, delivered: false });
  });
});

describe("supersede", () => {
  it("a reconnect on the same key replaces the old socket and keeps its sessions", async () => {
    const first = new FakeExtension();
    await first.connectOk(ticketFor("uid_r", "brw_r"));
    await control("/v1/dispatch", {
      method: "POST",
      body: {
        ownerId: "uid_r",
        browserId: "brw_r",
        name: "browser_open",
        args: {},
        sessionId: "job_live",
        blockedOrigins: ["https://x.example"],
      },
    });

    const closed = first.closeCode;
    const second = new FakeExtension();
    await second.connectOk(ticketFor("uid_r", "brw_r"));

    assert.equal(await closed, 4000, "the old socket is closed as superseded");
    assert.equal(relay.hub.size, 1, "one machine, one entry");

    // The tabs died with the old window, but the SESSION is a Crew job that is still running.
    // Forgetting it here would land the next dispatch in an unnamed tab group.
    const reopened = second.frames("session_open");
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0]!.sessionId, "job_live");
    assert.deepEqual(reopened[0]!.blockedOrigins, ["https://x.example"]);
    assert.deepEqual(reopened[0]!.allowedOrigins, [], "and its allow list rides the re-announce too");
  });

  it("settles an in-flight command immediately instead of making the caller wait out its timeout", async () => {
    const first = new FakeExtension();
    await first.connectOk(ticketFor("uid_r2", "brw_r2"));
    first.answer = null; // never answers

    const started = Date.now();
    const pending = control("/v1/dispatch", {
      method: "POST",
      body: {
        ownerId: "uid_r2",
        browserId: "brw_r2",
        name: "browser_act",
        args: {},
        timeoutMs: 25_000,
      },
    });
    await waitFor(() => first.frames("cmd").length === 1);

    const second = new FakeExtension();
    await second.connectOk(ticketFor("uid_r2", "brw_r2"));

    const res = await pending;
    assert.equal(res.body.outcome, "disconnected");
    assert.ok(
      Date.now() - started < 5_000,
      "a command answered by a socket that no longer exists must not burn the full 25 s"
    );
  });

  it("a superseded socket's close does not evict its replacement", async () => {
    // The ordering trap: the old socket's `close` event fires AFTER the new one has taken the key.
    const first = new FakeExtension();
    await first.connectOk(ticketFor("uid_r3", "brw_r3"));
    const second = new FakeExtension();
    await second.connectOk(ticketFor("uid_r3", "brw_r3"));
    await new Promise((r) => setTimeout(r, 150)); // let the old close land

    assert.equal(relay.hub.size, 1);
    const res = await control("/v1/dispatch", {
      method: "POST",
      body: { ownerId: "uid_r3", browserId: "brw_r3", name: "browser_read", args: {} },
    });
    assert.equal(res.body.outcome, "ok");
  });
});

describe("capacity", () => {
  it("refuses past the cap with a code the extension can back off on", async () => {
    const held: FakeExtension[] = [];
    for (let i = 0; i < config.maxBrowsers; i++) {
      const ext = new FakeExtension();
      await ext.connectOk(ticketFor("uid_cap", `brw_${i}`));
      held.push(ext);
    }
    assert.equal(relay.hub.size, config.maxBrowsers);

    const overflow = new FakeExtension();
    const reply = await overflow.connect(ticketFor("uid_cap", "brw_over"));
    assert.equal(reply.t, "error");
    assert.equal(reply.code, "capacity");
    // 1013 "Try Again Later" — temporary by definition, which is what the extension's existing
    // backoff already assumes a close means.
    assert.equal(await overflow.closeCode, 1013);
  });
});

describe("metrics", () => {
  it("reports the fd limit it actually has, and does not close the window on a read", async () => {
    const first = await control("/v1/health");
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "ok");
    assert.equal(typeof first.body.uptimeSec, "number");
    assert.equal(typeof first.body.loopLagP99Ms, "number");
    // Linux-only, and null elsewhere on purpose: a consumer must say "unknown", never "fine".
    if (process.platform === "linux") {
      assert.equal(typeof first.body.openFds, "number");
      assert.equal(typeof first.body.maxFds, "number");
    } else {
      assert.equal(first.body.openFds, null);
      assert.equal(first.body.maxFds, null);
    }

    // A curl must not steal the window the scheduled report to Crew is about to send.
    const second = await control("/v1/health");
    assert.ok(second.body.bytesIn >= first.body.bytesIn);
    assert.ok(second.body.windowMs >= first.body.windowMs);
  });
});

describe("drain", () => {
  it("lets an in-flight command finish, then hangs up with 1012", async () => {
    const own = await startRelay({ ...config, port: 0 });

    const ws = new WebSocket(`ws://127.0.0.1:${own.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ t: "hello", v: 2, ticket: ticketFor("uid_d", "brw_d") }));
    await waitFor(() => own.hub.size === 1);

    let cmdId: string | null = null;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "cmd") cmdId = m.id;
    });

    const pending = fetch(`http://127.0.0.1:${own.port}/v1/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CONTROL_KEY}` },
      body: JSON.stringify({
        ownerId: "uid_d",
        browserId: "brw_d",
        name: "browser_act",
        args: {},
        timeoutMs: 10_000,
      }),
    });
    await waitFor(() => cmdId !== null);

    const closeCode = new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
    const draining = own.close(5_000);
    // Answer AFTER the drain has begun — the whole point is that a click already committed to is
    // not hung up on mid-air.
    ws.send(JSON.stringify({ t: "res", id: cmdId, ok: true, result: { content: [{ type: "text", text: "done" }] } }));

    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { outcome: string }).outcome, "ok");
    await draining;
    // 1012 "Service Restart" — the extension's existing backoff treats it as temporary, which is
    // what makes a relay upgrade invisible to a browser without any extension change.
    assert.equal(await closeCode, 1012);
  });
});

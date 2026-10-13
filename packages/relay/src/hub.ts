// The relay's WebSocket face: many browsers, one process.
//
// This is the piece that made a relay a different program from the bridge rather than a flag on
// it. `ExtensionHub` held ONE socket — one `private socket`, one shared pending map, one ping
// timer, one status object — because a self-hosted bridge serves the person who ran it. A relay
// serves everyone at once, so every one of those becomes per-connection, and the parts that stay
// global are the ones that genuinely are: the map, the caps, the metrics.
//
// WHAT KEYS A CONNECTION. `${ownerId}:${browserId}` — see identity.ts, which owns that rule now
// because every auth provider has to satisfy it. Nothing about a workspace, team or membership
// appears in this file, which is the point: the hub knows presence and dispatch, and the question
// of whether an agent MAY drive a browser is answered upstream, live, on every call.
//
// WHO A BROWSER IS COMES FROM A PROVIDER, not from this file. The hub used to hold a signing key
// and verify tickets itself; it now asks `opts.auth`. That is what makes a second authentication
// scheme a directory rather than a fork of the socket loop.
//
// SUPERSEDE, NEVER EVICT. A second connection with the SAME key replaces the first, because that
// is what a laptop waking from sleep looks like: the old TCP connection is dead and nobody has
// noticed yet. A connection with a DIFFERENT key never displaces anything, because that is what a
// stranger looks like.

import type { WebSocketServer, WebSocket as WsSocket } from "ws";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { FromExtension, ToExtension, ToolResult } from "./protocol.js";
import { parseFromExtension } from "./protocol.js";
import { browserKey, type BrowserIdentity } from "./identity.js";
import type { AuthProvider } from "./providers/index.js";

/** Below MV3's ~30 s idle eviction and well below Cloudflare's 100 s idle close. See protocol.ts. */
export const HEARTBEAT_MS = 20_000;
const HELLO_TIMEOUT_MS = 5_000;
/** A socket is "present" only if a frame arrived within this window — two missed beats. */
const PRESENCE_WINDOW_MS = HEARTBEAT_MS * 2 + 5_000;

/** Ceiling on commands in flight to ONE browser. An extension that stops answering must not be
 *  able to accumulate promises; a real session issues them one at a time. */
const MAX_PENDING_PER_BROWSER = 64;

export interface SessionTab {
  tab: string;
  url: string | null;
  attached: boolean;
  active: boolean;
}

export interface BrowserSummary {
  ownerId: string;
  /** @deprecated The same value as `ownerId`, emitted so a caller written against the old name
   *  keeps working. Delete once every caller reads `ownerId` — see control.ts. */
  ownerUid: string;
  browserId: string;
  label: string | null;
  agentString: string | null;
  extensionVersion: string | null;
  connectedAt: number;
  lastSeenAt: number;
  /** Open socket AND a recent frame. A half-open TCP connection reads false. */
  online: boolean;
  debuggerAttached: boolean;
  ticketExpiresAt: number;
  sessions: Array<{ sessionId: string; tabs: SessionTab[] }>;
  openSessionIds: string[];
  pendingCommands: number;
}

/**
 * What a dispatch did.
 *
 * `browser_not_here` is a distinct outcome from every kind of failure, and a caller is expected to
 * key real behaviour on it: during a migration between boxes a dispatch can land on the relay that
 * does not hold this socket, which is a retry, not an error to report to an agent. A generic 500
 * would make that indistinguishable from a broken browser.
 */
export type DispatchOutcome =
  | { outcome: "ok"; result: ToolResult }
  | { outcome: "browser_not_here" }
  | { outcome: "busy"; pending: number }
  | { outcome: "timeout"; timeoutMs: number }
  | { outcome: "disconnected" }
  | { outcome: "send_failed"; message: string };

export interface DispatchInput {
  ownerId: string;
  browserId: string;
  name: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  sessionId?: string;
  /** The caller's blocklist. Applied when the session is opened, and pushed live if it changed. */
  blockedOrigins?: string[];
  /** The caller's allow list, the same way. Absent or empty means any site but the blocklist. */
  allowedOrigins?: string[];
}

interface Pending {
  settle: (r: DispatchOutcome) => void;
  timer: NodeJS.Timeout;
}

interface SessionState {
  lastActivityAt: number;
  blockedOrigins: string[];
  allowedOrigins: string[];
}

interface BrowserConn {
  key: string;
  identity: BrowserIdentity;
  socket: WsSocket;
  label: string | null;
  agentString: string | null;
  extensionVersion: string | null;
  connectedAt: number;
  lastSeenAt: number;
  debuggerAttached: boolean;
  sessions: Array<{ sessionId: string; tabs: SessionTab[] }>;
  openSessions: Map<string, SessionState>;
  pending: Map<string, Pending>;
  pingTimer: NodeJS.Timeout | null;
  /** Set when a newer socket took this key, so the old socket's `close` handler does not tear
   *  down the entry that now belongs to its replacement. */
  superseded: boolean;
}

export interface HubOptions {
  /** Answers "who is this browser" on the hello frame. See providers/types.ts. */
  auth: AuthProvider;
  /** Refuse new connections beyond this many. Bounds file descriptors on a small box. */
  maxBrowsers: number;
  /** Reap a session with no activity for this long (0 disables). */
  sessionIdleMs: number;
  /** Byte counters, so the box's bandwidth allowance is a signal and not a surprise bill. */
  onBytes?: (direction: "in" | "out", bytes: number) => void;
  log?: (msg: string) => void;
}

export class BrowserHub {
  private readonly conns = new Map<string, BrowserConn>();
  private reaper: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(private readonly opts: HubOptions) {
    if (opts.sessionIdleMs > 0) {
      this.reaper = setInterval(
        () => this.reapIdleSessions(),
        Math.min(opts.sessionIdleMs, 60_000)
      );
      this.reaper.unref?.();
    }
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  get size(): number {
    return this.conns.size;
  }

  attach(wss: WebSocketServer): void {
    wss.on("connection", (ws) => this.onConnection(ws));
  }

  // ── connection lifecycle ───────────────────────────────────────────────────────────────────

  private onConnection(ws: WsSocket): void {
    // Refuse before the handshake rather than after: a socket held open waiting for a hello it
    // will never be allowed to complete is exactly the file descriptor the cap exists to protect.
    if (this.draining || this.conns.size >= this.opts.maxBrowsers) {
      this.send(ws, {
        t: "error",
        code: "capacity",
        message: this.draining ? "relay is shutting down" : "relay at capacity",
      });
      // 1013 "Try Again Later" — the extension's existing backoff already treats a close as
      // temporary, and this says so explicitly rather than looking like a network fault.
      try {
        ws.close(1013, "try again later");
      } catch {
        /* already closing */
      }
      return;
    }

    let conn: BrowserConn | null = null;
    const helloTimer = setTimeout(() => {
      if (!conn) {
        try {
          ws.close(4401, "auth timeout");
        } catch {
          /* already closing */
        }
      }
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => {
      const bytes = typeof data === "string" ? Buffer.byteLength(data) : (data as Buffer).length;
      this.opts.onBytes?.("in", bytes);

      // VALIDATED, not cast. This face is published with no Cloudflare Access policy in front of
      // it — a browser WebSocket cannot send the headers Access needs — so the ticket is the only
      // gate and everything after it must be examined. A frame that is not something the extension
      // may say is DROPPED, not thrown on: the socket is authenticated by now, and killing it
      // would take every in-flight command with it over what is far more likely a version skew.
      let msg: FromExtension | null;
      try {
        msg = parseFromExtension(JSON.parse(data.toString()));
      } catch {
        return; // not JSON at all
      }
      if (msg === null) return;

      if (!conn) {
        if (msg.t !== "hello") return; // still waiting for the handshake; ignore the rest
        clearTimeout(helloTimer);
        conn = this.onHello(ws, msg.ticket, msg);
        return;
      }

      // A second hello on an authenticated socket is refused rather than re-evaluated. Re-keying a
      // live connection would strand its pending commands under the old key.
      if (msg.t === "hello") return;
      this.onAuthedMessage(conn, msg);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (conn) this.onSocketGone(conn);
    });
    ws.on("error", () => {
      /* 'close' always follows and does the cleanup */
    });
  }

  private onHello(
    ws: WsSocket,
    credential: string,
    meta: { label?: string; agentString?: string; extensionVersion?: string }
  ): BrowserConn | null {
    const verdict = this.opts.auth.verifyBrowser(credential);
    if (!verdict.ok) {
      this.send(ws, {
        t: "error",
        code: verdict.reason,
        message:
          verdict.reason === "ticket_expired"
            ? "This ticket has expired. Get a new one and reconnect."
            : "Ticket rejected.",
      });
      try {
        ws.close(4401, verdict.reason);
      } catch {
        /* already closing */
      }
      return null;
    }

    const identity = verdict.identity;
    const key = browserKey(identity.ownerId, identity.browserId);
    const now = Date.now();

    const conn: BrowserConn = {
      key,
      identity,
      socket: ws,
      label: meta.label ?? null,
      agentString: meta.agentString ?? null,
      extensionVersion: meta.extensionVersion ?? null,
      connectedAt: now,
      lastSeenAt: now,
      debuggerAttached: false,
      sessions: [],
      openSessions: new Map(),
      pending: new Map(),
      pingTimer: null,
      superseded: false,
    };

    const previous = this.conns.get(key);
    if (previous) {
      // Carry the open-session set across. The tabs themselves are gone with the old browser
      // window, but the SESSION is a run that is still going, and forgetting it here means
      // the next dispatch silently lands in an unnamed tab group.
      for (const [sid, state] of previous.openSessions) conn.openSessions.set(sid, state);
      this.supersede(previous);
    }

    this.conns.set(key, conn);
    this.send(ws, {
      t: "welcome",
      heartbeatMs: HEARTBEAT_MS,
      ownerId: identity.ownerId,
      // Both names, same value. An extension in the field reads `ownerUid` and there is no way to
      // upgrade every installed copy at once — see protocol.ts.
      ownerUid: identity.ownerId,
      browserId: identity.browserId,
    });
    // Re-announce what we believe is open, so a reconnecting extension rebuilds its tab groups.
    for (const [sid, state] of conn.openSessions) {
      this.send(ws, {
        t: "session_open",
        sessionId: sid,
        blockedOrigins: state.blockedOrigins,
        allowedOrigins: state.allowedOrigins,
      });
    }

    conn.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) this.send(ws, { t: "ping" });
    }, HEARTBEAT_MS);
    conn.pingTimer.unref?.();

    this.log(
      `[hub] ${key} connected` +
        (previous ? " (superseded a live socket)" : "") +
        ` — ${this.conns.size} browser(s)`
    );
    return conn;
  }

  /**
   * Retire a connection that a newer socket has replaced.
   *
   * Its pending commands are settled HERE rather than left to time out. A dispatch in flight when
   * the laptop woke up is answered by a socket that no longer exists; making the caller wait out
   * its full timeout for an answer that provably cannot arrive is a wasted 25 seconds of an
   * agent's turn.
   */
  private supersede(prev: BrowserConn): void {
    prev.superseded = true;
    this.settleAll(prev, { outcome: "disconnected" });
    if (prev.pingTimer) clearInterval(prev.pingTimer);
    prev.pingTimer = null;
    try {
      prev.socket.close(4000, "superseded");
    } catch {
      /* ignore */
    }
  }

  private onSocketGone(conn: BrowserConn): void {
    if (conn.pingTimer) {
      clearInterval(conn.pingTimer);
      conn.pingTimer = null;
    }
    this.settleAll(conn, { outcome: "disconnected" });
    // Only remove the map entry if it is still OURS. A superseded connection's close event fires
    // after its replacement has already taken the key.
    if (!conn.superseded && this.conns.get(conn.key) === conn) {
      this.conns.delete(conn.key);
      this.log(`[hub] ${conn.key} disconnected — ${this.conns.size} browser(s)`);
    }
  }

  private settleAll(conn: BrowserConn, outcome: DispatchOutcome): void {
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.settle(outcome);
    }
    conn.pending.clear();
  }

  // ── inbound frames ─────────────────────────────────────────────────────────────────────────

  private onAuthedMessage(conn: BrowserConn, msg: FromExtension): void {
    conn.lastSeenAt = Date.now();
    switch (msg.t) {
      case "ping":
        this.send(conn.socket, { t: "pong" });
        break;
      case "pong":
        break;
      case "res": {
        const p = conn.pending.get(msg.id);
        if (!p) return; // late or duplicate — already timed out
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok && msg.result) {
          p.settle({ outcome: "ok", result: msg.result });
        } else {
          // An error the EXTENSION reports is still a completed dispatch: the browser answered,
          // and the answer is that the page did not cooperate. It travels as a normal tool result
          // so the agent reads a sentence and self-corrects, rather than as a transport failure.
          const text = msg.error?.message ?? msg.error?.code ?? "browser error";
          p.settle({ outcome: "ok", result: { content: [{ type: "text", text }], isError: true } });
        }
        break;
      }
      case "status":
        conn.debuggerAttached = !!msg.attached;
        if (msg.sessions) conn.sessions = msg.sessions;
        break;
      case "session_closed":
        conn.openSessions.delete(msg.sessionId);
        break;
    }
  }

  // ── outbound ───────────────────────────────────────────────────────────────────────────────

  private send(ws: WsSocket, msg: ToExtension): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(msg);
    this.opts.onBytes?.("out", Buffer.byteLength(payload));
    try {
      ws.send(payload);
    } catch {
      /* the close handler does the cleanup */
    }
  }

  /**
   * Send a tool call to one browser and await its answer.
   *
   * Never throws and never blocks on a human — every failure is a typed outcome the caller can
   * turn into a sentence. The timer is the relay's own budget, and it is meant to sit strictly
   * inside the caller's abort, which sits inside ITS caller's, and so on up to the agent's own MCP
   * client timeout: each layer answers before the one above it gives up, so the layer that knows
   * WHY is always the one that gets to say.
   */
  dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    const key = browserKey(input.ownerId, input.browserId);
    const conn = this.conns.get(key);
    if (!conn || conn.socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ outcome: "browser_not_here" });
    }
    if (conn.pending.size >= MAX_PENDING_PER_BROWSER) {
      return Promise.resolve({ outcome: "busy", pending: conn.pending.size });
    }

    if (input.sessionId) {
      this.ensureSession(conn, input.sessionId, input.blockedOrigins, input.allowedOrigins);
    }

    const id = randomUUID();
    return new Promise<DispatchOutcome>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve({ outcome: "timeout", timeoutMs: input.timeoutMs });
      }, input.timeoutMs);
      timer.unref?.();
      conn.pending.set(id, { settle: resolve, timer });

      const payload = JSON.stringify({
        t: "cmd",
        id,
        name: input.name,
        args: input.args,
        deadlineMs: input.timeoutMs,
        sessionId: input.sessionId,
      });
      this.opts.onBytes?.("out", Buffer.byteLength(payload));
      conn.socket.send(payload, (err) => {
        if (!err) return;
        conn.pending.delete(id);
        clearTimeout(timer);
        resolve({ outcome: "send_failed", message: err.message });
      });
    });
  }

  /**
   * Open the session if it is new; push the blocklist or the allow list if either changed under a
   * live one. A push always carries BOTH lists, so the extension never has to merge a partial one.
   *
   * The live push is what makes Ship settings an actual control rather than a note. A captain
   * blocking an origin during an incident needs it to apply to the run that is already going —
   * the run they are worried about — and a session that only reads its blocklist at open time
   * would ignore them until the job ended.
   */
  private ensureSession(
    conn: BrowserConn,
    sessionId: string,
    blockedOrigins?: string[],
    allowedOrigins?: string[],
  ): void {
    const existing = conn.openSessions.get(sessionId);
    if (!existing) {
      const state = {
        lastActivityAt: Date.now(),
        blockedOrigins: blockedOrigins ?? [],
        allowedOrigins: allowedOrigins ?? [],
      };
      conn.openSessions.set(sessionId, state);
      this.send(conn.socket, {
        t: "session_open",
        sessionId,
        blockedOrigins: state.blockedOrigins,
        allowedOrigins: state.allowedOrigins,
      });
      return;
    }
    existing.lastActivityAt = Date.now();
    // A list the caller did not send is left as it was; only one it sent can change.
    const blockedChanged =
      blockedOrigins !== undefined && !sameOrigins(existing.blockedOrigins, blockedOrigins);
    const allowedChanged =
      allowedOrigins !== undefined && !sameOrigins(existing.allowedOrigins, allowedOrigins);
    if (!blockedChanged && !allowedChanged) return;
    if (blockedChanged) existing.blockedOrigins = blockedOrigins!;
    if (allowedChanged) existing.allowedOrigins = allowedOrigins!;
    this.send(conn.socket, {
      t: "session_config",
      sessionId,
      blockedOrigins: existing.blockedOrigins,
      allowedOrigins: existing.allowedOrigins,
    });
  }

  /** Tell a browser an agent's run ended so it tears down that run's tabs. */
  closeSession(ownerId: string, browserId: string, sessionId: string): boolean {
    const conn = this.conns.get(browserKey(ownerId, browserId));
    if (!conn) return false;
    conn.openSessions.delete(sessionId);
    this.send(conn.socket, { t: "session_close", sessionId });
    return true;
  }

  private reapIdleSessions(): void {
    const now = Date.now();
    for (const conn of this.conns.values()) {
      for (const [sid, state] of conn.openSessions) {
        if (now - state.lastActivityAt > this.opts.sessionIdleMs) {
          this.log(`[hub] reaping idle session ${sid} on ${conn.key}`);
          conn.openSessions.delete(sid);
          this.send(conn.socket, { t: "session_close", sessionId: sid });
        }
      }
    }
  }

  // ── presence ───────────────────────────────────────────────────────────────────────────────

  list(filter?: { ownerId?: string; browserId?: string }): BrowserSummary[] {
    const now = Date.now();
    const out: BrowserSummary[] = [];
    for (const conn of this.conns.values()) {
      if (filter?.ownerId && conn.identity.ownerId !== filter.ownerId) continue;
      if (filter?.browserId && conn.identity.browserId !== filter.browserId) continue;
      out.push({
        ownerId: conn.identity.ownerId,
        ownerUid: conn.identity.ownerId, // see BrowserSummary
        browserId: conn.identity.browserId,
        label: conn.label,
        agentString: conn.agentString,
        extensionVersion: conn.extensionVersion,
        connectedAt: conn.connectedAt,
        lastSeenAt: conn.lastSeenAt,
        online:
          conn.socket.readyState === WebSocket.OPEN && now - conn.lastSeenAt < PRESENCE_WINDOW_MS,
        debuggerAttached: conn.debuggerAttached,
        ticketExpiresAt: conn.identity.expiresAt,
        sessions: conn.sessions,
        openSessionIds: [...conn.openSessions.keys()],
        pendingCommands: conn.pending.size,
      });
    }
    return out;
  }

  /** Commands in flight across every browser — the number a drain waits on. */
  inFlight(): number {
    let n = 0;
    for (const conn of this.conns.values()) n += conn.pending.size;
    return n;
  }

  /**
   * Stop taking work, let what is running finish, then hang up on everyone.
   *
   * Used by both SIGTERM and the self-update restart. The close code is 1012 "Service Restart",
   * which the extension's existing backoff already treats as temporary — so a relay upgrade is
   * invisible to a browser beyond a few seconds of reconnect, and needs no extension change at
   * all. Draining first is what stops an upgrade from failing whatever click was mid-air.
   */
  async drain(graceMs: number): Promise<void> {
    this.draining = true;
    const deadline = Date.now() + graceMs;
    while (this.inFlight() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const conn of this.conns.values()) {
      if (conn.pingTimer) clearInterval(conn.pingTimer);
      conn.pingTimer = null;
      this.settleAll(conn, { outcome: "disconnected" });
      try {
        conn.socket.close(1012, "service restart");
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }
}

function sameOrigins(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

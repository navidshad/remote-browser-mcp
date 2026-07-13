// The WS face of the bridge. Holds at most ONE authenticated extension socket
// (a new authed socket supersedes the old — handles laptop sleep/wake dupes),
// runs the token handshake + heartbeat, and correlates MCP tool calls with the
// extension's responses. The WS is the durable channel; MCP requests come and go.
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID, timingSafeEqual } from "crypto";
import type { FromExtension, ToolResult } from "./protocol.js";

const HEARTBEAT_MS = 20_000; // < MV3's 30s idle window, so inbound frames keep the SW resident
const HELLO_TIMEOUT_MS = 5_000;

export interface SessionTab {
  tab: string;
  url: string | null;
  attached: boolean;
  active: boolean;
}

export interface HubStatus {
  extensionConnected: boolean;
  debuggerAttached: boolean;
  lastHeartbeatAt: number | null;
  tabId: number | null;
  url: string | null;
  /** Per-session tab breakdown from the extension's latest status frame. */
  sessions: Array<{ sessionId: string; tabs: SessionTab[] }>;
}

interface Pending {
  settle: (r: ToolResult) => void;
  timer: NodeJS.Timeout;
}

function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function notConnectedResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          "Agent browser not connected. Open the Aso Dara Chrome window and make sure the " +
          "Remote Browser extension shows 'connected'.",
      },
    ],
    isError: true,
  };
}

export class ExtensionHub {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private pingTimer: NodeJS.Timeout | null = null;
  private status: HubStatus = {
    extensionConnected: false,
    debuggerAttached: false,
    lastHeartbeatAt: null,
    tabId: null,
    url: null,
    sessions: [],
  };
  /** MCP sessions the bridge has opened (so a reconnecting extension can be
   *  told to re-establish them). Keyed by Mcp-Session-Id. */
  private openSessions = new Set<string>();

  constructor(private readonly token: string) {}

  /** How many tabs a given MCP session currently owns (from the last status). */
  tabCountFor(sessionId: string | undefined): number {
    if (!sessionId) return 0;
    return this.status.sessions.find((s) => s.sessionId === sessionId)?.tabs.length ?? 0;
  }

  /** Tell the extension a new MCP session exists. Best-effort (no-op if offline;
   *  the session is also created lazily on its first command). */
  openSession(sessionId: string): void {
    this.openSessions.add(sessionId);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: "session_open", sessionId }));
    }
  }

  /** Tell the extension an MCP session ended so it tears down that session's tabs. */
  closeSession(sessionId: string): void {
    this.openSessions.delete(sessionId);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: "session_close", sessionId }));
    }
  }

  attach(wss: WebSocketServer): void {
    wss.on("connection", (ws) => this.onConnection(ws));
  }

  /** Snapshot of connectivity. `extensionConnected` requires both an open
   *  socket and a recent heartbeat, so a half-open TCP connection reads false. */
  getStatus(): HubStatus {
    const fresh =
      this.status.lastHeartbeatAt !== null &&
      Date.now() - this.status.lastHeartbeatAt < HEARTBEAT_MS * 2;
    const connected =
      this.socket?.readyState === WebSocket.OPEN && this.status.extensionConnected && fresh;
    return { ...this.status, extensionConnected: connected };
  }

  private onConnection(ws: WebSocket): void {
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) {
        try {
          ws.close(4401, "auth timeout");
        } catch {
          /* already closing */
        }
      }
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg: FromExtension;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed frames
      }

      if (!authed) {
        if (msg.t === "hello" && typeof msg.token === "string" && tokenEquals(msg.token, this.token)) {
          authed = true;
          clearTimeout(helloTimer);
          this.adoptSocket(ws);
          ws.send(JSON.stringify({ t: "welcome", heartbeatMs: HEARTBEAT_MS }));
        } else {
          try {
            ws.send(JSON.stringify({ t: "error", code: "unauthorized" }));
          } catch {
            /* ignore */
          }
          ws.close(4401, "unauthorized");
        }
        return;
      }

      this.onAuthedMessage(msg);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.socket === ws) this.onSocketGone();
    });
    ws.on("error", () => {
      /* the 'close' handler does the cleanup */
    });
  }

  private adoptSocket(ws: WebSocket): void {
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.close(4000, "superseded");
      } catch {
        /* ignore */
      }
    }
    this.socket = ws;
    this.status.extensionConnected = true;
    this.status.lastHeartbeatAt = Date.now();
    // A fresh extension has no sessions; re-announce the ones we know about so
    // status reflects them (their tabs, if any, are gone with the old browser).
    for (const sid of this.openSessions) {
      try {
        ws.send(JSON.stringify({ t: "session_open", sessionId: sid }));
      } catch {
        /* ignore */
      }
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ t: "ping" }));
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_MS);
    console.log("[hub] extension connected & authenticated");
  }

  private onAuthedMessage(msg: FromExtension): void {
    switch (msg.t) {
      case "ping":
        this.status.lastHeartbeatAt = Date.now();
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ t: "pong" }));
        }
        break;
      case "pong":
        this.status.lastHeartbeatAt = Date.now();
        break;
      case "res": {
        const p = this.pending.get(msg.id);
        if (!p) return; // late/duplicate — already timed out
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok && msg.result) {
          p.settle(msg.result);
        } else {
          const text = msg.error?.message ?? msg.error?.code ?? "extension error";
          p.settle({ content: [{ type: "text", text }], isError: true });
        }
        break;
      }
      case "status":
        this.status.debuggerAttached = !!msg.attached;
        this.status.tabId = msg.tabId ?? null;
        this.status.url = msg.url ?? null;
        if (msg.sessions) this.status.sessions = msg.sessions;
        this.status.lastHeartbeatAt = Date.now();
        break;
      case "session_closed":
        // Extension finished tearing down the session's tabs; nothing to await.
        break;
    }
  }

  private onSocketGone(): void {
    console.log("[hub] extension disconnected");
    this.socket = null;
    this.status.extensionConnected = false;
    this.status.debuggerAttached = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.settle(notConnectedResult());
    }
    this.pending.clear();
  }

  /** Send a tool call to the extension and await its result. Never throws —
   *  not-connected / timeout / disconnect all resolve as isError tool results
   *  so the agent can read the message and self-correct. */
  async sendCommand(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    sessionId?: string
  ): Promise<ToolResult> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return notConnectedResult();
    }
    const id = randomUUID();
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          content: [
            {
              type: "text",
              text: `${name} timed out after ${timeoutMs}ms (extension unreachable or page hung).`,
            },
          ],
          isError: true,
        });
      }, timeoutMs);
      this.pending.set(id, { settle: resolve, timer });
      ws.send(JSON.stringify({ t: "cmd", id, name, args, deadlineMs: timeoutMs, sessionId }), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          resolve({
            content: [{ type: "text", text: `failed to send command: ${err.message}` }],
            isError: true,
          });
        }
      });
    });
  }
}

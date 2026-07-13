// Wire protocol between the bridge-server (VM) and the MV3 extension (Mac).
// One JSON object per WebSocket text frame. The extension dials OUT to the
// bridge, so auth happens IN-BAND as the first frame (a browser WebSocket
// cannot set Authorization/CF-Access-* headers).

/** Extension -> bridge: first frame, authenticates the connection. */
export interface HelloMsg {
  t: "hello";
  token: string;
  ext?: string;
  v?: number;
  profile?: string;
}

/** Bridge -> extension: auth accepted; tells the extension the heartbeat cadence. */
export interface WelcomeMsg {
  t: "welcome";
  heartbeatMs: number;
}

/** Bridge -> extension: an MCP tool call to execute. */
export interface CmdMsg {
  t: "cmd";
  id: string;
  name: string;
  args: Record<string, unknown>;
  deadlineMs: number;
  /** Logical agent/session that owns the target tabs. Absent => "default". */
  sessionId?: string;
}

/** Bridge -> extension: pre-register a session (optional; sessions are also created
 *  lazily on first cmd). Sent when an MCP client opens a stateful transport. */
export interface SessionOpenMsg {
  t: "session_open";
  sessionId: string;
}

/** Bridge -> extension: an MCP client disconnected; tear down its owned tabs. */
export interface SessionCloseMsg {
  t: "session_close";
  sessionId: string;
}

/** Extension -> bridge: ack that a session's tabs were cleaned up. */
export interface SessionClosedMsg {
  t: "session_closed";
  sessionId: string;
}

/** MCP-shaped content part (text or image), passed straight through to the agent. */
export interface ContentPart {
  type: "text" | "image";
  text?: string;
  data?: string; // base64 (image)
  mimeType?: string;
}

export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
}

/** Extension -> bridge: result of a cmd. `result` is already MCP-shaped. */
export interface ResMsg {
  t: "res";
  id: string;
  ok: boolean;
  result?: ToolResult;
  error?: { code?: string; message?: string };
}

/** Extension -> bridge: debugger attach/detach/tab-close notifications. The
 *  top-level fields describe aggregate/most-recent state (kept for the popup and
 *  legacy status); `sessions` carries the per-session/per-tab breakdown. */
export interface StatusMsg {
  t: "status";
  attached: boolean;
  tabId?: number | null;
  url?: string | null;
  reason?: string;
  sessions?: Array<{
    sessionId: string;
    tabs: Array<{ tab: string; url: string | null; attached: boolean; active: boolean }>;
  }>;
}

/** Bidirectional app-level heartbeat. Native WS ping/pong frames are not
 *  visible to service-worker JS and do not reliably reset the MV3 idle timer,
 *  so we use observable app-level pings instead. */
export interface PingMsg {
  t: "ping";
}
export interface PongMsg {
  t: "pong";
}

/** Bridge -> extension: auth rejected. */
export interface ErrorMsg {
  t: "error";
  code: string;
}

export type FromExtension = HelloMsg | ResMsg | StatusMsg | SessionClosedMsg | PingMsg | PongMsg;
export type ToExtension =
  | WelcomeMsg
  | CmdMsg
  | SessionOpenMsg
  | SessionCloseMsg
  | PingMsg
  | PongMsg
  | ErrorMsg;

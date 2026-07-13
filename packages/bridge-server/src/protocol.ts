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

/** Extension -> bridge: debugger attach/detach/tab-close notifications. */
export interface StatusMsg {
  t: "status";
  attached: boolean;
  tabId?: number | null;
  url?: string | null;
  reason?: string;
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

export type FromExtension = HelloMsg | ResMsg | StatusMsg | PingMsg | PongMsg;
export type ToExtension = WelcomeMsg | CmdMsg | PingMsg | PongMsg | ErrorMsg;

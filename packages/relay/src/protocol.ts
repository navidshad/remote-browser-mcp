// Wire protocol between the relay and the browser extension.
//
// One JSON object per WebSocket text frame. The extension dials OUT — a browser on somebody's
// laptop has no address anyone can call — so authentication happens IN-BAND as the first frame: a
// browser WebSocket cannot set `Authorization` or the `CF-Access-*` headers Cloudflare Access
// needs, which is also why the WS route deliberately has no Access policy in front of it.
//
// WHY THIS IS A SEPARATE FILE FROM the bridge's protocol, which it resembles: they speak to two
// different modes of the same extension. The bridge authenticates a static shared token typed into
// a form by whoever runs it, and serves an MCP face itself; the relay authenticates whatever its
// auth provider says, and serves no MCP at all. What IS deliberately identical is the command
// vocabulary — `cmd`/`res`/`status`/`ping` — so the extension's executor never learns which server
// it is talking to.

// ─── extension → relay ───────────────────────────────────────────────────────────────────────

/**
 * First frame. Authenticates the connection and describes the machine.
 *
 * IDENTITY COMES FROM THE CREDENTIAL AND NOTHING ELSE. There is deliberately no `ownerId` or
 * `browserId` field here: a self-asserted id beside a verified one is an invitation to check the
 * wrong one. Everything else in this frame is display metadata, believed only as far as it is
 * shown back to the person it describes.
 */
export interface HelloMsg {
  t: "hello";
  /** Protocol version. 2 is the relay's credential hello; 1 was the bridge's shared-token hello. */
  v: 2;
  /** Opaque credential, interpreted only by the configured auth provider. Called `ticket` because
   *  that is what it is on the wire and renaming a field costs more than the word is worth. */
  ticket: string;
  /** Human label for the machine, e.g. "Navid's MacBook". */
  label?: string;
  /** The browser's own user-agent string, for the Browsers panel. */
  agentString?: string;
  /** Extension version, so a stale install is visible rather than mysterious. */
  extensionVersion?: string;
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

/** Result of a `cmd`. `result` is already MCP-shaped — the relay never reshapes it. */
export interface ResMsg {
  t: "res";
  id: string;
  ok: boolean;
  result?: ToolResult;
  error?: { code?: string; message?: string };
}

/**
 * Debugger attach/detach/tab-close notification. The top-level fields describe the most recent
 * event; `sessions` carries the per-session/per-tab breakdown the Browsers panel shows.
 */
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

/** Ack that a session's tabs were torn down. */
export interface SessionClosedMsg {
  t: "session_closed";
  sessionId: string;
}

// ─── relay → extension ───────────────────────────────────────────────────────────────────────

/**
 * Auth accepted. Echoes the identity the credential proved, so the popup can show whose it is.
 *
 * TWO NAMES FOR ONE VALUE, and the duplication is the migration. `ownerUid` was a Firebase word in
 * a program that has no Firebase in it; `ownerId` is what the relay calls it now. Renaming it
 * outright would be a wire break with no rollback: extensions are installed on other people's
 * machines and update on their own schedule, so for a while both spellings have to be true.
 * `ownerUid` goes away when no installed extension reads it — not before.
 */
export interface WelcomeMsg {
  t: "welcome";
  heartbeatMs: number;
  ownerId: string;
  /** @deprecated Same value as `ownerId`. */
  ownerUid: string;
  browserId: string;
}

/** A tool call to execute. */
export interface CmdMsg {
  t: "cmd";
  id: string;
  name: string;
  args: Record<string, unknown>;
  deadlineMs: number;
  /** The tab group this call belongs to — one agent run. Absent means an unscoped one-off. */
  sessionId?: string;
}

/**
 * Open a tab group, with the caller's blocklist attached.
 *
 * The blocklist rides the session rather than each command because it is a property of the run,
 * not of a click — and because putting it on `cmd` would re-serialize the whole list on every
 * single action. See `session_config` for what happens when it is edited mid-run.
 */
export interface SessionOpenMsg {
  t: "session_open";
  sessionId: string;
  /** Level 1 of the two-level blocklist. The extension UNIONS this with its own; see README. */
  blockedOrigins?: string[];
  /**
   * The only sites this run may load. Absent or empty means any site except the blocklist, and the
   * blocklist wins over it. How an entry matches is the extension's business — the relay only
   * carries it.
   */
  allowedOrigins?: string[];
}

/** A live update to an already-open session's configuration. */
export interface SessionConfigMsg {
  t: "session_config";
  sessionId: string;
  blockedOrigins?: string[];
  allowedOrigins?: string[];
}

/** An agent's run ended; tear down its tabs. */
export interface SessionCloseMsg {
  t: "session_close";
  sessionId: string;
}

/**
 * Bidirectional app-level heartbeat.
 *
 * Native WS ping/pong frames are invisible to service-worker JS and do not reliably reset the MV3
 * idle timer, so the heartbeat has to be an observable application message. It serves four masters
 * at once — MV3's ~30 s idle eviction, Cloudflare's 100 s idle WebSocket close, half-open TCP
 * detection, and the relay's own presence view — which is why raising the interval past ~25 s
 * breaks the product in ways no log on the box will explain.
 */
export interface PingMsg {
  t: "ping";
}
export interface PongMsg {
  t: "pong";
}

/**
 * Auth rejected, or the relay is going away.
 *
 * `code` is load-bearing to the client, not decoration: `ticket_expired` means "mint another and
 * retry now", while `unauthorized` means "stop and tell the human". An extension that backs off
 * exponentially on an expired ticket is a browser that silently stops working after ten minutes.
 */
export interface ErrorMsg {
  t: "error";
  code: "unauthorized" | "ticket_expired" | "capacity" | "protocol";
  message?: string;
}

export type FromExtension = HelloMsg | ResMsg | StatusMsg | SessionClosedMsg | PingMsg | PongMsg;

export type ToExtension =
  | WelcomeMsg
  | CmdMsg
  | SessionOpenMsg
  | SessionConfigMsg
  | SessionCloseMsg
  | PingMsg
  | PongMsg
  | ErrorMsg;

// ─── validation ──────────────────────────────────────────────────────────────────────────────
//
// BOUNDS, NOT JUST TYPES. These frames arrive from the open internet through a route that has no
// Access policy in front of it, so the in-band ticket is the only gate and everything after it
// must be examined. The counts are what stop one frame from being expensive on a $5 box; the
// image bound is deliberately generous, because a real screenshot IS large and a cap that refuses
// one is a broken product rather than a defended one.

import { z } from "zod";

/** A screenshot arrives base64 in `data`. Generous on purpose — see above. */
const MAX_IMAGE_CHARS = 8_000_000;
const MAX_CONTENT_PARTS = 64;
const MAX_SESSIONS = 200;
const MAX_TABS_PER_SESSION = 200;

const contentPartSchema = z.object({
  type: z.enum(["text", "image"]),
  text: z.string().max(MAX_IMAGE_CHARS).optional(),
  data: z.string().max(MAX_IMAGE_CHARS).optional(),
  mimeType: z.string().max(200).optional(),
});

const toolResultSchema = z.object({
  content: z.array(contentPartSchema).max(MAX_CONTENT_PARTS),
  isError: z.boolean().optional(),
});

const helloSchema = z.object({
  t: z.literal("hello"),
  v: z.literal(2),
  ticket: z.string().min(1).max(4096),
  label: z.string().max(200).optional(),
  agentString: z.string().max(1000).optional(),
  extensionVersion: z.string().max(50).optional(),
});

const resSchema = z.object({
  t: z.literal("res"),
  id: z.string().min(1).max(200),
  ok: z.boolean(),
  result: toolResultSchema.optional(),
  error: z
    .object({ code: z.string().max(200).optional(), message: z.string().max(4000).optional() })
    .optional(),
});

const statusSchema = z.object({
  t: z.literal("status"),
  attached: z.boolean(),
  tabId: z.number().int().nullable().optional(),
  url: z.string().max(4000).nullable().optional(),
  reason: z.string().max(1000).optional(),
  sessions: z
    .array(
      z.object({
        sessionId: z.string().max(200),
        tabs: z
          .array(
            z.object({
              tab: z.string().max(200),
              url: z.string().max(4000).nullable(),
              attached: z.boolean(),
              active: z.boolean(),
            })
          )
          .max(MAX_TABS_PER_SESSION),
      })
    )
    .max(MAX_SESSIONS)
    .optional(),
});

const sessionClosedSchema = z.object({
  t: z.literal("session_closed"),
  sessionId: z.string().min(1).max(200),
});

const fromExtensionSchema = z.discriminatedUnion("t", [
  helloSchema,
  resSchema,
  statusSchema,
  sessionClosedSchema,
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("pong") }),
]);

/**
 * Parse one inbound frame, or null if it is not something the extension may say.
 *
 * Returns null rather than throwing because the caller's only sane response to a bad frame is to
 * drop it: the socket is authenticated by then, and one malformed message is far more likely to be
 * a version skew than an attack. Throwing would take down the connection and every in-flight
 * command on it.
 */
export function parseFromExtension(raw: unknown): FromExtension | null {
  const parsed = fromExtensionSchema.safeParse(raw);
  return parsed.success ? (parsed.data as FromExtension) : null;
}

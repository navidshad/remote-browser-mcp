// One live bridge connection per profile, and a manager that reconciles the set
// of connections against the stored profile list.
//
// Isolation model (nested, all enforced client-side):
//   Profile  → one Connection = one WS to one bridge, with its OWN Executor,
//              so tabs are private to the profile that opened them.
//   Session  → within a profile, the Executor's per-Mcp-Session-Id ownership
//              still isolates one agent's tabs from another's.
//   Tab      → addressed by per-session handle.
//
// Dependency-injected (WebSocketCtor, makeExecutor) so this runs in Node tests
// without Chrome; tab/debugger side-effects go through the global `chrome` API,
// exactly like Executor does.

const DEFAULT_HEARTBEAT_MS = 20000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;

export class Connection {
  /**
   * @param {{id:string,name?:string,agentUrl:string,accessToken:string}} profile
   * @param {{WebSocketCtor:typeof WebSocket, makeExecutor:(pushStatus:Function)=>any, onStateChange?:()=>void, log?:Function}} deps
   */
  constructor(profile, deps) {
    this.profile = profile;
    this.deps = deps;
    this.socket = null;
    this.heartbeatTimer = null;
    this.backoff = 0;
    this.connState = "init"; // init | connecting | connected | auth_error | disconnected
    this.closed = false; // set on teardown → stop reconnecting
    // Each connection owns its Executor → tabs are isolated per profile.
    this.executor = deps.makeExecutor((attached, tabId, url, reason) =>
      this.pushStatus(attached, tabId, url, reason)
    );
  }

  log(...args) {
    this.deps.log?.(`[conn ${this.profile.name || this.profile.id}]`, ...args);
  }

  setState(state) {
    this.connState = state;
    this.deps.onStateChange?.();
  }

  ownsTab(tabId) {
    return this.executor.tabIndex.has(tabId);
  }

  routeDetach(source, reason) {
    this.executor.onDetach(source, reason);
  }

  routeTabRemoved(tabId) {
    this.executor.onTabRemoved(tabId);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────
  connect() {
    if (this.closed) return;
    const { agentUrl, accessToken } = this.profile;
    if (!agentUrl || !accessToken) {
      this.setState("unconfigured");
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState("connecting");
    let ws;
    try {
      ws = new this.deps.WebSocketCtor(agentUrl);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;

    ws.onopen = () => {
      this.send({ t: "hello", token: accessToken, ext: "rbm-extension", v: 1, profile: this.profile.name || this.profile.id });
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      /* onclose follows and handles cleanup */
    };
    ws.onclose = () => {
      if (this.socket === ws) {
        this.stopHeartbeat();
        this.socket = null;
        if (!this.closed && this.connState !== "auth_error") this.setState("disconnected");
        this.scheduleReconnect();
      }
    };
  }

  /** Force a fresh reconnect (popup "Reconnect"). */
  reconnect() {
    this.stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {}
    }
    this.socket = null;
    this.backoff = 0;
    this.connect();
  }

  /** Permanently stop this connection (profile disabled/removed). Detaches the
   *  debugger from its tabs but LEAVES the tabs open. */
  teardown() {
    this.closed = true;
    this.stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {}
    }
    this.socket = null;
    for (const tabId of this.executor.tabIndex.keys()) {
      try {
        chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
      } catch (e) {}
    }
    this.setState("disconnected");
  }

  onMessage(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch (e) {
      return;
    }
    switch (m.t) {
      case "welcome":
        this.backoff = 0;
        this.setState("connected");
        this.startHeartbeat(m.heartbeatMs || DEFAULT_HEARTBEAT_MS);
        break;
      case "error":
        this.setState("auth_error"); // bad token; bridge will close the socket
        break;
      case "ping":
        this.send({ t: "pong" });
        break;
      case "pong":
        break;
      case "cmd":
        this.handleCmd(m);
        break;
      case "session_open":
        this.executor.getSession(m.sessionId);
        break;
      case "session_close":
        this.executor.closeSession(m.sessionId).finally(() => this.send({ t: "session_closed", sessionId: m.sessionId }));
        break;
    }
  }

  async handleCmd(m) {
    try {
      const result = await this.executor.execute(m.name, m.args || {}, m.deadlineMs, m.sessionId);
      this.send({ t: "res", id: m.id, ok: true, result });
    } catch (e) {
      this.send({ t: "res", id: m.id, ok: false, error: { code: e.code || "error", message: String(e.message || e) } });
    }
  }

  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(obj));
      } catch (e) {}
    }
  }

  pushStatus(attached, tabId, url, reason) {
    this.send({ t: "status", attached, tabId: tabId ?? null, url: url ?? null, reason, sessions: this.executor.sessionsSummary() });
    this.deps.onStateChange?.();
  }

  startHeartbeat(intervalMs) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ t: "ping" }), intervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, this.backoff)) + Math.random() * 500;
    this.backoff = Math.min(this.backoff + 1, 5);
    setTimeout(() => this.connect(), delay);
  }

  statusSnapshot() {
    let tabCount = 0;
    for (const s of this.executor.sessions.values()) tabCount += s.tabs.size;
    return {
      id: this.profile.id,
      name: this.profile.name || this.profile.id,
      agentUrl: this.profile.agentUrl,
      connState: this.connState,
      socketOpen: !!this.socket && this.socket.readyState === WebSocket.OPEN,
      debuggerAttached: this.executor.anyAttached(),
      tabCount,
    };
  }
}

export class ConnectionManager {
  /** @param {{WebSocketCtor:typeof WebSocket, makeExecutor:(pushStatus:Function)=>any, onStateChange?:()=>void, log?:Function}} deps */
  constructor(deps) {
    this.deps = deps;
    this.connections = new Map(); // profileId -> Connection
  }

  /** Bring the live connection set in line with the stored profiles: connect
   *  enabled ones, tear down disabled/removed ones, recreate on config change. */
  reconcile(profiles) {
    const wanted = new Map(
      (profiles || []).filter((p) => p && p.enabled && p.agentUrl && p.accessToken).map((p) => [p.id, p])
    );

    for (const [id, conn] of this.connections) {
      if (!wanted.has(id)) {
        conn.teardown();
        this.connections.delete(id);
      }
    }

    for (const [id, p] of wanted) {
      let conn = this.connections.get(id);
      if (conn && (conn.profile.agentUrl !== p.agentUrl || conn.profile.accessToken !== p.accessToken)) {
        conn.teardown();
        this.connections.delete(id);
        conn = null;
      }
      if (!conn) {
        conn = new Connection(p, this.deps);
        this.connections.set(id, conn);
      } else {
        conn.profile = p; // pick up name/metadata changes
      }
      conn.connect();
    }
    this.deps.onStateChange?.();
  }

  reconnectAll() {
    for (const conn of this.connections.values()) conn.reconnect();
  }

  onDetach(source, reason) {
    if (!source || source.tabId == null) return;
    for (const conn of this.connections.values()) {
      if (conn.ownsTab(source.tabId)) return conn.routeDetach(source, reason);
    }
  }

  onTabRemoved(tabId) {
    for (const conn of this.connections.values()) {
      if (conn.ownsTab(tabId)) return conn.routeTabRemoved(tabId);
    }
  }

  statusSnapshot() {
    return { profiles: [...this.connections.values()].map((c) => c.statusSnapshot()) };
  }
}

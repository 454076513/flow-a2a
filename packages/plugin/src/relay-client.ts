/**
 * Flow-A2A — Relay Client
 *
 * Reused from reef/src/relay-client.ts with telemetry send method added.
 * Auto-reconnect with exponential backoff (2s → 30s), heartbeat (30s).
 */

import WebSocket from "ws";
import type { LobsterIdentity, ServerMessage, LobbyAdapter, MentionTarget, LobsterInfo, TelemetryRecord } from "@flow-a2a/shared";

export interface RelayClientConfig extends LobsterIdentity {
  relayUrl: string;
  token?: string;
  adapter?: LobbyAdapter;
  log?: (...args: unknown[]) => void;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private config: RelayClientConfig;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private stopped = false;
  private reconnectDelay = 2000;
  public onlineLobsters: LobsterInfo[] = [];

  constructor(config: RelayClientConfig) {
    this.config = config;
  }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) { try { this.ws.close(1000); } catch {} this.ws = null; }
    this.connected = false;
  }

  isConnected() { return this.connected; }

  // --- Send methods ---

  sendLobby(text: string) { this.raw({ type: "lobby", text }); }
  sendDm(to: string, text: string) { this.raw({ type: "dm", to, text }); }

  sendFeishuRelay(params: {
    chatId: string; text: string;
    messageId?: string; threadId?: string;
    mentions?: MentionTarget[];
  }) { this.raw({ type: "feishu", ...params }); }

  sendTelemetry(batch: TelemetryRecord[]) {
    this.raw({ type: "telemetry", batch });
  }

  requestWho() { this.raw({ type: "who" }); }
  requestHistory() { this.raw({ type: "history" }); }

  // --- Connection ---

  private connect() {
    if (this.stopped) return;
    const log = this.config.log || console.log;

    try { this.ws = new WebSocket(this.config.relayUrl); }
    catch (e: any) { log(`[a2a] Connect failed: ${e.message}`); this.scheduleReconnect(); return; }

    this.ws.on("open", () => {
      this.reconnectDelay = 2000;
      this.raw({
        type: "register",
        lobsterId: this.config.lobsterId,
        name: this.config.name,
        botOpenId: this.config.botOpenId,
        token: this.config.token,
        groups: this.config.groups || [],
        meta: this.config.meta || {},
      });
      this.pingTimer = setInterval(() => {
        this.raw({ type: "ping" });
        // Also send ws-level ping to detect dead TCP connections
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30_000);
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.dispatch(msg);
    });

    this.ws.on("close", () => {
      this.connected = false; this.clearTimers();
      this.scheduleReconnect();
    });

    this.ws.on("error", (e: Error) => {
      (this.config.log || console.log)(`[a2a] WS error: ${e.message}`);
    });
  }

  private dispatch(msg: ServerMessage) {
    const adapter = this.config.adapter;
    const log = this.config.log || console.log;

    switch (msg.type) {
      case "registered":
        this.connected = true;
        this.onlineLobsters = msg.lobsters;
        log(`[a2a] Connected as "${this.config.name}" — ${msg.lobsters.length} online`);
        break;
      case "lobby":
        adapter?.onLobbyMessage?.(msg);
        break;
      case "dm":
        if (!(msg as any).echo) adapter?.onDirectMessage?.(msg);
        break;
      case "feishu":
        adapter?.onFeishuRelay?.(msg);
        break;
      case "join":
      case "leave":
        adapter?.onPresence?.({ type: msg.type, lobsterId: msg.lobsterId, name: msg.name });
        break;
      case "history":
        adapter?.onHistory?.(msg.messages);
        break;
      case "who":
        this.onlineLobsters = msg.lobsters;
        break;
      case "telemetry_ack":
        // Ack received — reporter handles retry logic
        break;
      case "error":
        log(`[a2a] Error: ${msg.message}`);
        break;
    }
  }

  private raw(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch {
        this.connected = false;
        this.clearTimers();
        try { this.ws.close(); } catch {}
        this.ws = null;
        this.scheduleReconnect();
      }
    } else if (this.ws && !this.stopped) {
      // Connection stale — force reconnect
      this.connected = false;
      this.clearTimers();
      try { this.ws.close(); } catch {}
      this.ws = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30_000);
      this.connect();
    }, this.reconnectDelay);
  }

  private clearTimers() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

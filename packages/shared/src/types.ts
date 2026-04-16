/**
 * Flow-A2A — Shared Protocol Types
 *
 * Extends reef's protocol with telemetry message types.
 * Used by plugin (client), center (server), and shared tooling.
 */

// ─── Agent Identity ─────────────────────────────────────────────────────────

export interface LobsterIdentity {
  lobsterId: string;
  name: string;
  botOpenId?: string;
  groups?: string[];
  meta?: Record<string, unknown>;
}

export interface LobsterInfo {
  id: string;
  name: string;
  botOpenId?: string;
  groups: string[];
  connectedAt: number;
  meta?: Record<string, unknown>;
}

export interface MentionTarget {
  name: string;
  openId?: string;
}

// ─── Client → Server Messages ───────────────────────────────────────────────

export type ClientMessage =
  | ({ type: "register"; token?: string } & LobsterIdentity)
  | { type: "lobby"; text: string }
  | { type: "dm"; to: string; text: string }
  | { type: "feishu"; chatId: string; text: string; messageId?: string; threadId?: string; mentions?: MentionTarget[] }
  | { type: "history" }
  | { type: "ping" }
  | { type: "who" }
  | { type: "telemetry"; batch: TelemetryRecord[] };

// ─── Server → Client Messages ───────────────────────────────────────────────

export type ServerMessage =
  | { type: "registered"; lobsterId: string; lobsters: LobsterInfo[] }
  | { type: "lobby"; from: string; fromName: string; text: string; ts: number }
  | { type: "dm"; from: string; fromName: string; text: string; ts: number; echo?: boolean }
  | { type: "feishu"; from: string; fromName: string; fromBotOpenId: string; chatId: string; text: string; messageId: string; threadId?: string; ts: number }
  | { type: "join"; lobsterId: string; name: string; ts: number }
  | { type: "leave"; lobsterId: string; name: string; ts: number }
  | { type: "history"; messages: ServerMessage[] }
  | { type: "who"; lobsters: LobsterInfo[] }
  | { type: "pong" }
  | { type: "error"; message: string }
  | { type: "telemetry_ack"; accepted: number; errors?: string[] };

// ─── Telemetry Types ────────────────────────────────────────────────────────

export interface TelemetryRecord {
  kind: "llm" | "tool";
  ts: number;
  sessionKey?: string;
  agentId?: string;

  // Trigger user attribution
  triggerUser?: string;
  triggerUserId?: string;
  triggerSource?: string; // "feishu" | "reef-dm" | "reef-lobby" | "api"

  // Channel context
  channel?: string;          // "feishu" | "reef" | "api" | "gateway"
  scope?: string;            // "group" | "p2p" | "lobby" | "dm"
  conversationId?: string;   // chat_id / group_id (e.g., "oc_xxx")
  conversationName?: string; // human-readable group/chat name

  // kind === "llm"
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costSource?: string; // "telemetry" | "calculated" | "estimated"
  trigger?: string;    // "user" | "tool-result" | "auto"
  isSubagent?: boolean;

  // kind === "tool"
  toolName?: string;
  success?: boolean;
  durationMs?: number;

}

export interface TriggerUserInfo {
  triggerUser: string;
  triggerUserId: string;
  triggerSource: string;
  channel?: string;
  scope?: string;
  conversationId?: string;
  conversationName?: string;
  ts: number; // when mapping was created, for TTL
}

// ─── Lobby Adapter Interface ────────────────────────────────────────────────

export interface LobbyAdapter {
  onLobbyMessage?(msg: { from: string; fromName: string; text: string; ts: number }): void;
  onDirectMessage?(msg: { from: string; fromName: string; text: string; ts: number }): void;
  onFeishuRelay?(msg: { from: string; fromName: string; fromBotOpenId: string; chatId: string; text: string; messageId: string; threadId?: string; ts: number }): void;
  onPresence?(msg: { type: "join" | "leave"; lobsterId: string; name: string }): void;
  onHistory?(messages: ServerMessage[]): void;
}

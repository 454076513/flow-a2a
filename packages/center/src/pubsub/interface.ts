import type { ServerMessage, LobsterInfo } from "@flow-a2a/shared";

// ─── Agent Presence (serializable, no ws handle) ───────────────────────────

export interface AgentPresence {
  id: string;
  name: string;
  botOpenId: string | null;
  groups: string[];
  meta: Record<string, unknown>;
  connectedAt: number;
  nodeId: string; // which center instance owns this connection
}

export function presenceToLobsterInfo(p: AgentPresence): LobsterInfo {
  return {
    id: p.id,
    name: p.name,
    botOpenId: p.botOpenId || undefined,
    groups: p.groups,
    connectedAt: p.connectedAt,
    meta: p.meta,
  };
}

// ─── Cluster Messages ──────────────────────────────────────────────────────

export type ClusterMessage =
  | { type: "relay"; targetId: string; payload: ServerMessage }
  | { type: "broadcast"; payload: ServerMessage; excludeId?: string }
  | { type: "evict"; lobsterId: string };

// ─── PubSub Interface ──────────────────────────────────────────────────────

export interface PubSub {
  close(): Promise<void>;

  // Agent global registry
  registerAgent(info: AgentPresence): Promise<void>;
  unregisterAgent(id: string): Promise<void>;
  listAllAgents(): Promise<AgentPresence[]>;
  getAgent(id: string): Promise<AgentPresence | null>;

  // Lobby history
  pushLobbyMessage(msg: ServerMessage, maxHistory: number): Promise<void>;
  getLobbyHistory(count: number): Promise<ServerMessage[]>;

  // Cross-instance messaging
  publish(msg: ClusterMessage): Promise<void>;
  subscribe(handler: (msg: ClusterMessage) => void): void;
}

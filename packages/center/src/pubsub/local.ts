import type { ServerMessage } from "@flow-a2a/shared";
import type { PubSub, AgentPresence, ClusterMessage } from "./interface.js";

/**
 * LocalPubSub — single-instance in-memory implementation.
 * All state lives in this process. publish() calls handler directly.
 * Behavior is identical to pre-cluster center.
 */
export class LocalPubSub implements PubSub {
  private agents = new Map<string, AgentPresence>();
  private lobbyHistory: ServerMessage[] = [];
  private handler: ((msg: ClusterMessage) => void) | null = null;

  async close(): Promise<void> {
    this.agents.clear();
    this.lobbyHistory = [];
  }

  // ─── Agent Registry ──────────────────────────────────────────────────────

  async registerAgent(info: AgentPresence): Promise<void> {
    this.agents.set(info.id, info);
  }

  async unregisterAgent(id: string): Promise<void> {
    this.agents.delete(id);
  }

  async listAllAgents(): Promise<AgentPresence[]> {
    return [...this.agents.values()];
  }

  async getAgent(id: string): Promise<AgentPresence | null> {
    return this.agents.get(id) ?? null;
  }

  // ─── Lobby History ───────────────────────────────────────────────────────

  async pushLobbyMessage(msg: ServerMessage, maxHistory: number): Promise<void> {
    this.lobbyHistory.push(msg);
    if (this.lobbyHistory.length > maxHistory) {
      this.lobbyHistory = this.lobbyHistory.slice(-maxHistory);
    }
  }

  async getLobbyHistory(count: number): Promise<ServerMessage[]> {
    return this.lobbyHistory.slice(-count);
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  async publish(msg: ClusterMessage): Promise<void> {
    // In single-instance mode, deliver directly to local handler
    this.handler?.(msg);
  }

  subscribe(handler: (msg: ClusterMessage) => void): void {
    this.handler = handler;
  }
}

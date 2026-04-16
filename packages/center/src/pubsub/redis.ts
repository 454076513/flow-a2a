import { Redis as IORedis } from "ioredis";
import type { ServerMessage } from "@flow-a2a/shared";
import type { PubSub, AgentPresence, ClusterMessage } from "./interface.js";

const KEY_AGENTS = "center:agents";
const KEY_LOBBY = "center:lobby";
const CHANNEL = "center:broadcast";

/**
 * RedisPubSub — cluster-mode implementation.
 *
 * Uses Redis hash for global agent registry, list for lobby history,
 * and pub/sub for cross-instance message relay.
 *
 * Requires two Redis connections: one for pub/sub subscriber (blocking),
 * one for commands.
 */
export class RedisPubSub implements PubSub {
  private cmd: IORedis;
  private sub: IORedis;
  private nodeId: string;

  constructor(redisUrl: string, nodeId: string) {
    this.cmd = new IORedis(redisUrl);
    this.sub = new IORedis(redisUrl);
    this.nodeId = nodeId;
  }

  async close(): Promise<void> {
    this.sub.disconnect();
    this.cmd.disconnect();
  }

  // ─── Agent Registry ──────────────────────────────────────────────────────

  async registerAgent(info: AgentPresence): Promise<void> {
    await this.cmd.hset(KEY_AGENTS, info.id, JSON.stringify(info));
  }

  async unregisterAgent(id: string): Promise<void> {
    await this.cmd.hdel(KEY_AGENTS, id);
  }

  async listAllAgents(): Promise<AgentPresence[]> {
    const all: Record<string, string> = await this.cmd.hgetall(KEY_AGENTS);
    return Object.values(all).map((v) => JSON.parse(v));
  }

  async getAgent(id: string): Promise<AgentPresence | null> {
    const raw = await this.cmd.hget(KEY_AGENTS, id);
    return raw ? JSON.parse(raw) : null;
  }

  // ─── Lobby History ───────────────────────────────────────────────────────

  async pushLobbyMessage(msg: ServerMessage, maxHistory: number): Promise<void> {
    const pipeline = this.cmd.pipeline();
    pipeline.rpush(KEY_LOBBY, JSON.stringify(msg));
    pipeline.ltrim(KEY_LOBBY, -maxHistory, -1);
    await pipeline.exec();
  }

  async getLobbyHistory(count: number): Promise<ServerMessage[]> {
    const items = await this.cmd.lrange(KEY_LOBBY, -count, -1);
    return items.map((s: string) => JSON.parse(s));
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  async publish(msg: ClusterMessage): Promise<void> {
    const envelope = JSON.stringify({ nodeId: this.nodeId, msg });
    await this.cmd.publish(CHANNEL, envelope);
  }

  subscribe(handler: (msg: ClusterMessage) => void): void {
    this.sub.subscribe(CHANNEL);
    this.sub.on("message", (_channel: string, raw: string) => {
      try {
        const envelope = JSON.parse(raw) as { nodeId: string; msg: ClusterMessage };
        // Skip messages from self — we already handled them locally
        if (envelope.nodeId === this.nodeId) return;
        handler(envelope.msg);
      } catch (err) {
        console.error("[center] Redis message parse error:", err);
      }
    });
  }
}

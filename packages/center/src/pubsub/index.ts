import crypto from "crypto";
import type { CenterConfig } from "../config.js";
import type { PubSub } from "./interface.js";

export type { PubSub } from "./interface.js";
export type { AgentPresence, ClusterMessage } from "./interface.js";
export { presenceToLobsterInfo } from "./interface.js";

export async function createPubSub(config: CenterConfig): Promise<PubSub> {
  if (config.redisUrl) {
    const { RedisPubSub } = await import("./redis.js");
    const nodeId = `center-${crypto.randomUUID().slice(0, 8)}`;
    console.log(`[center] Cluster mode: Redis (node=${nodeId})`);
    return new RedisPubSub(config.redisUrl, nodeId);
  }
  const { LocalPubSub } = await import("./local.js");
  console.log("[center] Single-instance mode (no Redis)");
  return new LocalPubSub();
}

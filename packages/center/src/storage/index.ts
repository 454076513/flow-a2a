import type { CenterConfig } from "../config.js";
import type { Storage } from "./interface.js";

export type { Storage } from "./interface.js";
export type {
  CostSummary,
  CostByAgent,
  CostByModel,
  CostByTriggerUser,
  CostByChannel,
  CostByConversation,
  CostFilters,
  AgentInfo,
  HourlySpend,
  YesterdaySpend,
  DailySpend,
  SessionBreakdown,
  TriggerBreakdown,
  RecommendationData,
} from "./interface.js";

export async function createStorage(config: CenterConfig): Promise<Storage> {
  if (config.dbType === "postgres") {
    const { PostgresStorage } = await import("./postgres.js");
    const storage = new PostgresStorage(config.postgresUrl);
    await storage.init();
    return storage;
  }
  const { SqliteStorage } = await import("./sqlite.js");
  return new SqliteStorage(config.dbPath);
}

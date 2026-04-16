import type { TelemetryRecord } from "@flow-a2a/shared";

// ─── Query Result Types ────────────────────────────────────────────────────

export interface CostSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCalls: number;
  modelCount: number;
  agentCount: number;
}

export interface CostByAgent {
  agentName: string;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostByModel {
  model: string;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostByTriggerUser {
  triggerUser: string;
  triggerSource: string | null;
  channel: string | null;
  scope: string | null;
  conversationId: string | null;
  conversationName: string | null;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostByChannel {
  channel: string;
  scope: string | null;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  userCount: number;
}

export interface CostByConversation {
  conversationId: string;
  conversationName: string | null;
  channel: string | null;
  scope: string | null;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  userCount: number;
}

export interface CostFilters {
  channel?: string;
  scope?: string;
  user?: string;
  agent?: string;
  model?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  agentId: string | null;
  lastSeenAt: number;
}

export interface HourlySpend {
  hour: string; // "00"–"23"
  costUsd: number;
  tokens: number;
}

export interface YesterdaySpend {
  totalUsd: number;
  totalTokens: number;
  eventCount: number;
}

export interface DailySpend {
  date: string; // YYYY-MM-DD
  costUsd: number;
}

export interface SessionBreakdown {
  sessionKey: string;
  costUsd: number;
  eventCount: number;
  startTs: number;
  endTs: number;
}

export interface TriggerBreakdown {
  trigger: string;
  isSubagent: number;
  costUsd: number;
  tokens: number;
  eventCount: number;
}

export interface RecommendationData {
  topModel: { model: string; costUsd: number; avgOutputTokens: number; eventCount: number } | null;
  failedTools: number;
  totalTools: number;
}

// ─── Storage Interface ─────────────────────────────────────────────────────

export interface Storage {
  close(): Promise<void>;

  // Agent Registry
  upsertAgent(id: string, name: string, agentId?: string, instanceId?: string, botOpenId?: string): Promise<void>;
  touchAgent(id: string): Promise<void>;
  removeAgent(id: string): Promise<void>;
  listAgents(): Promise<AgentInfo[]>;

  // Telemetry
  insertTelemetryBatch(
    agentName: string,
    agentId: string | undefined,
    instanceId: string | undefined,
    batch: TelemetryRecord[],
  ): Promise<{ accepted: number; errors: string[] }>;

  // Queries
  getSummary(since?: number): Promise<CostSummary>;
  getCostsByAgent(since?: number): Promise<CostByAgent[]>;
  getCostsByModel(since?: number): Promise<CostByModel[]>;
  getCostsByTriggerUser(since?: number, filters?: CostFilters): Promise<CostByTriggerUser[]>;
  getCostsByChannel(since?: number): Promise<CostByChannel[]>;
  getCostsByConversation(since?: number): Promise<CostByConversation[]>;

  // Extended queries (ported from costclaw-telemetry)
  getHourlySpend(since?: number): Promise<HourlySpend[]>;
  getYesterdaySpend(): Promise<YesterdaySpend>;
  getLast30DaysDailySpend(since?: number): Promise<DailySpend[]>;
  getSessionBreakdown(limit?: number): Promise<SessionBreakdown[]>;
  getTriggerBreakdown(since?: number): Promise<TriggerBreakdown[]>;
  getRecommendationData(): Promise<RecommendationData>;
}

import { getDb } from "./db.js";
import type { TelemetryRecord } from "@flow-a2a/shared";

// ─── Agent Registry ─────────────────────────────────────────────────────────

export function upsertAgent(id: string, name: string, agentId?: string, instanceId?: string, botOpenId?: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (id, name, agent_id, instance_id, bot_open_id, registered_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      agent_id = COALESCE(excluded.agent_id, agents.agent_id),
      instance_id = COALESCE(excluded.instance_id, agents.instance_id),
      bot_open_id = COALESCE(excluded.bot_open_id, agents.bot_open_id),
      last_seen_at = excluded.last_seen_at
  `).run(id, name, agentId ?? null, instanceId ?? null, botOpenId ?? null, now, now);
}

export function touchAgent(id: string): void {
  const db = getDb();
  db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function removeAgent(id: string): void {
  getDb().prepare(`DELETE FROM agents WHERE id = ?`).run(id);
}

export function listAgents(): Array<{ id: string; name: string; agentId: string | null; lastSeenAt: number }> {
  return getDb().prepare(`SELECT id, name, agent_id AS agentId, last_seen_at AS lastSeenAt FROM agents ORDER BY last_seen_at DESC`).all() as any;
}

// ─── Telemetry Batch Insert ─────────────────────────────────────────────────

export function insertTelemetryBatch(agentName: string, agentId: string | undefined, instanceId: string | undefined, batch: TelemetryRecord[]): { accepted: number; errors: string[] } {
  const db = getDb();
  const now = Date.now();
  let accepted = 0;
  const errors: string[] = [];

  const insertLlm = db.prepare(`
    INSERT INTO llm_costs
      (agent_name, agent_id, instance_id, session_key, model, input_tokens, output_tokens,
       cost_usd, cost_source, trigger, is_subagent, trigger_user, trigger_user_id, trigger_source,
       channel, scope, conversation_id, conversation_name, ts, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTool = db.prepare(`
    INSERT INTO tool_calls
      (agent_name, agent_id, tool_name, success, duration_ms, trigger_user, trigger_source, ts, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const runBatch = db.transaction(() => {
    for (const rec of batch) {
      try {
        switch (rec.kind) {
          case "llm":
            insertLlm.run(
              agentName, agentId ?? null, instanceId ?? null,
              rec.sessionKey ?? null, rec.model ?? "unknown",
              rec.inputTokens ?? 0, rec.outputTokens ?? 0,
              rec.costUsd ?? 0, rec.costSource ?? null,
              rec.trigger ?? null, rec.isSubagent ? 1 : 0,
              rec.triggerUser ?? null, rec.triggerUserId ?? null, rec.triggerSource ?? null,
              rec.channel ?? null, rec.scope ?? null,
              rec.conversationId ?? null, rec.conversationName ?? null,
              rec.ts, now
            );
            break;
          case "tool":
            insertTool.run(
              agentName, agentId ?? null,
              rec.toolName ?? null,
              rec.success != null ? (rec.success ? 1 : 0) : null,
              rec.durationMs ?? null,
              rec.triggerUser ?? null, rec.triggerSource ?? null,
              rec.ts, now
            );
            break;
        }
        accepted++;
      } catch (err) {
        errors.push(`${rec.kind}@${rec.ts}: ${String(err)}`);
      }
    }
  });

  runBatch();
  return { accepted, errors };
}

// ─── Query Functions ────────────────────────────────────────────────────────

export interface CostSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCalls: number;
  modelCount: number;
  agentCount: number;
}

export function getSummary(since?: number): CostSummary {
  const db = getDb();
  const sinceTs = since ?? 0;

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0)       AS totalCostUsd,
      COALESCE(SUM(input_tokens), 0)    AS totalInputTokens,
      COALESCE(SUM(output_tokens), 0)   AS totalOutputTokens,
      COUNT(*)                           AS totalCalls,
      COUNT(DISTINCT model)             AS modelCount,
      COUNT(DISTINCT agent_name)        AS agentCount
    FROM llm_costs
    WHERE ts >= ?
  `).get(sinceTs) as CostSummary;

  return row;
}

export interface CostByAgent {
  agentName: string;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export function getCostsByAgent(since?: number): CostByAgent[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      agent_name      AS agentName,
      SUM(cost_usd)   AS costUsd,
      COUNT(*)         AS calls,
      SUM(input_tokens)  AS inputTokens,
      SUM(output_tokens) AS outputTokens
    FROM llm_costs
    WHERE ts >= ?
    GROUP BY agent_name
    ORDER BY costUsd DESC
  `).all(since ?? 0) as CostByAgent[];
}

export interface CostByModel {
  model: string;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export function getCostsByModel(since?: number): CostByModel[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      model,
      SUM(cost_usd)   AS costUsd,
      COUNT(*)         AS calls,
      SUM(input_tokens)  AS inputTokens,
      SUM(output_tokens) AS outputTokens
    FROM llm_costs
    WHERE ts >= ?
    GROUP BY model
    ORDER BY costUsd DESC
  `).all(since ?? 0) as CostByModel[];
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

export function getCostsByTriggerUser(since?: number, filters?: CostFilters): CostByTriggerUser[] {
  const db = getDb();
  const { where, params } = buildFilterClause(since, filters);
  return db.prepare(`
    SELECT
      COALESCE(trigger_user, 'unknown') AS triggerUser,
      trigger_source                     AS triggerSource,
      channel,
      scope,
      conversation_id                    AS conversationId,
      conversation_name                  AS conversationName,
      SUM(cost_usd)                      AS costUsd,
      COUNT(*)                           AS calls,
      SUM(input_tokens)                  AS inputTokens,
      SUM(output_tokens)                 AS outputTokens
    FROM llm_costs
    ${where}
    GROUP BY trigger_user, trigger_source, channel, scope
    ORDER BY costUsd DESC
  `).all(...params) as CostByTriggerUser[];
}

// ─── Cost by Channel ──────────────────────────────────────────────────────

export interface CostByChannel {
  channel: string;
  scope: string | null;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  userCount: number;
}

export function getCostsByChannel(since?: number): CostByChannel[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      COALESCE(channel, 'unknown')  AS channel,
      scope,
      SUM(cost_usd)                 AS costUsd,
      COUNT(*)                      AS calls,
      SUM(input_tokens)             AS inputTokens,
      SUM(output_tokens)            AS outputTokens,
      COUNT(DISTINCT trigger_user)  AS userCount
    FROM llm_costs
    WHERE ts >= ?
    GROUP BY channel, scope
    ORDER BY costUsd DESC
  `).all(since ?? 0) as CostByChannel[];
}

// ─── Cost by Conversation ─────────────────────────────────────────────────

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

export function getCostsByConversation(since?: number): CostByConversation[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      COALESCE(conversation_id, 'unknown') AS conversationId,
      conversation_name                     AS conversationName,
      channel,
      scope,
      SUM(cost_usd)                         AS costUsd,
      COUNT(*)                              AS calls,
      SUM(input_tokens)                     AS inputTokens,
      SUM(output_tokens)                    AS outputTokens,
      COUNT(DISTINCT trigger_user)          AS userCount
    FROM llm_costs
    WHERE ts >= ?
    GROUP BY conversation_id, conversation_name, channel, scope
    ORDER BY costUsd DESC
  `).all(since ?? 0) as CostByConversation[];
}

// ─── Filtered Queries ─────────────────────────────────────────────────────

export interface CostFilters {
  channel?: string;
  scope?: string;
  user?: string;
  agent?: string;
  model?: string;
}

function buildFilterClause(since?: number, filters?: CostFilters): { where: string; params: unknown[] } {
  const conditions: string[] = ["ts >= ?"];
  const params: unknown[] = [since ?? 0];

  if (filters?.channel) { conditions.push("channel = ?"); params.push(filters.channel); }
  if (filters?.scope) { conditions.push("scope = ?"); params.push(filters.scope); }
  if (filters?.user) { conditions.push("trigger_user = ?"); params.push(filters.user); }
  if (filters?.agent) { conditions.push("agent_name = ?"); params.push(filters.agent); }
  if (filters?.model) { conditions.push("model = ?"); params.push(filters.model); }

  return { where: "WHERE " + conditions.join(" AND "), params };
}

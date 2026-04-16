import pg from "pg";
import type { TelemetryRecord } from "@flow-a2a/shared";
import type {
  Storage,
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

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  agent_id      TEXT,
  instance_id   TEXT,
  bot_open_id   TEXT,
  registered_at BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_costs (
  id              SERIAL PRIMARY KEY,
  agent_name      TEXT NOT NULL,
  agent_id        TEXT,
  instance_id     TEXT,
  session_key     TEXT,
  model           TEXT NOT NULL,
  input_tokens    BIGINT NOT NULL DEFAULT 0,
  output_tokens   BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_source     TEXT,
  trigger         TEXT,
  is_subagent     INTEGER NOT NULL DEFAULT 0,
  trigger_user    TEXT,
  trigger_user_id TEXT,
  trigger_source  TEXT,
  channel         TEXT,
  scope           TEXT,
  conversation_id   TEXT,
  conversation_name TEXT,
  ts              BIGINT NOT NULL,
  received_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              SERIAL PRIMARY KEY,
  agent_name      TEXT NOT NULL,
  agent_id        TEXT,
  tool_name       TEXT,
  success         INTEGER,
  duration_ms     BIGINT,
  trigger_user    TEXT,
  trigger_source  TEXT,
  ts              BIGINT NOT NULL,
  received_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at BIGINT NOT NULL
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_llm_costs_ts           ON llm_costs(ts);
CREATE INDEX IF NOT EXISTS idx_llm_costs_agent        ON llm_costs(agent_name);
CREATE INDEX IF NOT EXISTS idx_llm_costs_model        ON llm_costs(model);
CREATE INDEX IF NOT EXISTS idx_llm_costs_trigger      ON llm_costs(trigger_user);
CREATE INDEX IF NOT EXISTS idx_llm_costs_channel      ON llm_costs(channel);
CREATE INDEX IF NOT EXISTS idx_llm_costs_scope        ON llm_costs(scope);
CREATE INDEX IF NOT EXISTS idx_llm_costs_conversation ON llm_costs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts          ON tool_calls(ts);
CREATE INDEX IF NOT EXISTS idx_agents_name            ON agents(name);
`;

export class PostgresStorage implements Storage {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(BASE_SCHEMA);
    await this.pool.query(INDEXES);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ─── Agent Registry ──────────────────────────────────────────────────────

  async upsertAgent(id: string, name: string, agentId?: string, instanceId?: string, botOpenId?: string): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO agents (id, name, agent_id, instance_id, bot_open_id, registered_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET
         name = EXCLUDED.name,
         agent_id = COALESCE(EXCLUDED.agent_id, agents.agent_id),
         instance_id = COALESCE(EXCLUDED.instance_id, agents.instance_id),
         bot_open_id = COALESCE(EXCLUDED.bot_open_id, agents.bot_open_id),
         last_seen_at = EXCLUDED.last_seen_at`,
      [id, name, agentId ?? null, instanceId ?? null, botOpenId ?? null, now, now],
    );
  }

  async touchAgent(id: string): Promise<void> {
    await this.pool.query(`UPDATE agents SET last_seen_at = $1 WHERE id = $2`, [Date.now(), id]);
  }

  async removeAgent(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM agents WHERE id = $1`, [id]);
  }

  async listAgents(): Promise<AgentInfo[]> {
    const { rows } = await this.pool.query(
      `SELECT id, name, agent_id AS "agentId", last_seen_at AS "lastSeenAt" FROM agents ORDER BY last_seen_at DESC`,
    );
    return rows.map((r) => ({ ...r, lastSeenAt: Number(r.lastSeenAt) }));
  }

  // ─── Telemetry Batch Insert ──────────────────────────────────────────────

  async insertTelemetryBatch(
    agentName: string,
    agentId: string | undefined,
    instanceId: string | undefined,
    batch: TelemetryRecord[],
  ): Promise<{ accepted: number; errors: string[] }> {
    const now = Date.now();
    let accepted = 0;
    const errors: string[] = [];

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const rec of batch) {
        try {
          switch (rec.kind) {
            case "llm":
              await client.query(
                `INSERT INTO llm_costs
                  (agent_name, agent_id, instance_id, session_key, model, input_tokens, output_tokens,
                   cache_read_tokens, cache_creation_tokens,
                   cost_usd, cost_source, trigger, is_subagent, trigger_user, trigger_user_id, trigger_source,
                   channel, scope, conversation_id, conversation_name, ts, received_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
                [
                  agentName, agentId ?? null, instanceId ?? null,
                  rec.sessionKey ?? null, rec.model ?? "unknown",
                  rec.inputTokens ?? 0, rec.outputTokens ?? 0,
                  rec.cacheReadTokens ?? 0, rec.cacheCreationTokens ?? 0,
                  rec.costUsd ?? 0, rec.costSource ?? null,
                  rec.trigger ?? null, rec.isSubagent ? 1 : 0,
                  rec.triggerUser ?? null, rec.triggerUserId ?? null, rec.triggerSource ?? null,
                  rec.channel ?? null, rec.scope ?? null,
                  rec.conversationId ?? null, rec.conversationName ?? null,
                  rec.ts, now,
                ],
              );
              break;
            case "tool":
              await client.query(
                `INSERT INTO tool_calls
                  (agent_name, agent_id, tool_name, success, duration_ms, trigger_user, trigger_source, ts, received_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [
                  agentName, agentId ?? null,
                  rec.toolName ?? null,
                  rec.success != null ? (rec.success ? 1 : 0) : null,
                  rec.durationMs ?? null,
                  rec.triggerUser ?? null, rec.triggerSource ?? null,
                  rec.ts, now,
                ],
              );
              break;
          }
          accepted++;
        } catch (err) {
          errors.push(`${rec.kind}@${rec.ts}: ${String(err)}`);
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return { accepted, errors };
  }

  // ─── Query Functions ─────────────────────────────────────────────────────

  async getSummary(since?: number): Promise<CostSummary> {
    const sinceTs = since ?? 0;
    const { rows } = await this.pool.query(
      `SELECT
        COALESCE(SUM(cost_usd), 0)               AS "totalCostUsd",
        COALESCE(SUM(input_tokens), 0)            AS "totalInputTokens",
        COALESCE(SUM(output_tokens), 0)           AS "totalOutputTokens",
        COALESCE(SUM(cache_read_tokens), 0)       AS "totalCacheReadTokens",
        COALESCE(SUM(cache_creation_tokens), 0)   AS "totalCacheCreationTokens",
        COUNT(*)                                   AS "totalCalls",
        COUNT(DISTINCT model)                     AS "modelCount",
        COUNT(DISTINCT agent_name)                AS "agentCount"
      FROM llm_costs
      WHERE ts >= $1`,
      [sinceTs],
    );
    const row = rows[0];
    return {
      totalCostUsd: Number(row.totalCostUsd),
      totalInputTokens: Number(row.totalInputTokens),
      totalOutputTokens: Number(row.totalOutputTokens),
      totalCacheReadTokens: Number(row.totalCacheReadTokens),
      totalCacheCreationTokens: Number(row.totalCacheCreationTokens),
      totalCalls: Number(row.totalCalls),
      modelCount: Number(row.modelCount),
      agentCount: Number(row.agentCount),
    };
  }

  async getCostsByAgent(since?: number): Promise<CostByAgent[]> {
    const { rows } = await this.pool.query(
      `SELECT
        agent_name      AS "agentName",
        SUM(cost_usd)   AS "costUsd",
        COUNT(*)         AS calls,
        SUM(input_tokens)  AS "inputTokens",
        SUM(output_tokens) AS "outputTokens"
      FROM llm_costs
      WHERE ts >= $1
      GROUP BY agent_name
      ORDER BY "costUsd" DESC`,
      [since ?? 0],
    );
    return rows.map((r) => ({
      agentName: r.agentName,
      costUsd: Number(r.costUsd),
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
    }));
  }

  async getCostsByModel(since?: number): Promise<CostByModel[]> {
    const { rows } = await this.pool.query(
      `SELECT
        model,
        SUM(cost_usd)   AS "costUsd",
        COUNT(*)         AS calls,
        SUM(input_tokens)  AS "inputTokens",
        SUM(output_tokens) AS "outputTokens"
      FROM llm_costs
      WHERE ts >= $1
      GROUP BY model
      ORDER BY "costUsd" DESC`,
      [since ?? 0],
    );
    return rows.map((r) => ({
      model: r.model,
      costUsd: Number(r.costUsd),
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
    }));
  }

  async getCostsByTriggerUser(since?: number, filters?: CostFilters): Promise<CostByTriggerUser[]> {
    const { where, params } = this.buildFilterClause(since, filters);
    const { rows } = await this.pool.query(
      `SELECT
        COALESCE(trigger_user, 'unknown') AS "triggerUser",
        trigger_source                     AS "triggerSource",
        channel,
        scope,
        conversation_id                    AS "conversationId",
        conversation_name                  AS "conversationName",
        SUM(cost_usd)                      AS "costUsd",
        COUNT(*)                           AS calls,
        SUM(input_tokens)                  AS "inputTokens",
        SUM(output_tokens)                 AS "outputTokens"
      FROM llm_costs
      ${where}
      GROUP BY trigger_user, trigger_source, channel, scope, conversation_id, conversation_name
      ORDER BY "costUsd" DESC`,
      params,
    );
    return rows.map((r) => ({
      triggerUser: r.triggerUser,
      triggerSource: r.triggerSource,
      channel: r.channel,
      scope: r.scope,
      conversationId: r.conversationId,
      conversationName: r.conversationName,
      costUsd: Number(r.costUsd),
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
    }));
  }

  async getCostsByChannel(since?: number): Promise<CostByChannel[]> {
    const { rows } = await this.pool.query(
      `SELECT
        COALESCE(channel, 'unknown')  AS channel,
        scope,
        SUM(cost_usd)                 AS "costUsd",
        COUNT(*)                      AS calls,
        SUM(input_tokens)             AS "inputTokens",
        SUM(output_tokens)            AS "outputTokens",
        COUNT(DISTINCT trigger_user)  AS "userCount"
      FROM llm_costs
      WHERE ts >= $1
      GROUP BY channel, scope
      ORDER BY "costUsd" DESC`,
      [since ?? 0],
    );
    return rows.map((r) => ({
      channel: r.channel,
      scope: r.scope,
      costUsd: Number(r.costUsd),
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      userCount: Number(r.userCount),
    }));
  }

  async getCostsByConversation(since?: number): Promise<CostByConversation[]> {
    const { rows } = await this.pool.query(
      `SELECT
        COALESCE(conversation_id, 'unknown') AS "conversationId",
        conversation_name                     AS "conversationName",
        channel,
        scope,
        SUM(cost_usd)                         AS "costUsd",
        COUNT(*)                              AS calls,
        SUM(input_tokens)                     AS "inputTokens",
        SUM(output_tokens)                    AS "outputTokens",
        COUNT(DISTINCT trigger_user)          AS "userCount"
      FROM llm_costs
      WHERE ts >= $1
      GROUP BY conversation_id, conversation_name, channel, scope
      ORDER BY "costUsd" DESC`,
      [since ?? 0],
    );
    return rows.map((r) => ({
      conversationId: r.conversationId,
      conversationName: r.conversationName,
      channel: r.channel,
      scope: r.scope,
      costUsd: Number(r.costUsd),
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      userCount: Number(r.userCount),
    }));
  }

  // ─── Extended Queries ───────────────────────────────────────────────────

  async getHourlySpend(since?: number): Promise<HourlySpend[]> {
    const today = new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(today + "T00:00:00Z").getTime();
    const sinceTs = Math.max(since ?? 0, startOfDay);
    const { rows } = await this.pool.query(
      `SELECT
        to_char(to_timestamp(ts / 1000) AT TIME ZONE 'UTC', 'HH24') AS hour,
        COALESCE(SUM(cost_usd), 0)                                   AS "costUsd",
        COALESCE(SUM(input_tokens + output_tokens), 0)               AS tokens
      FROM llm_costs
      WHERE ts >= $1
      GROUP BY hour
      ORDER BY hour ASC`,
      [sinceTs],
    );
    return rows.map((r) => ({
      hour: r.hour,
      costUsd: Number(r.costUsd),
      tokens: Number(r.tokens),
    }));
  }

  async getYesterdaySpend(): Promise<YesterdaySpend> {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const startTs = new Date(yesterday + "T00:00:00Z").getTime();
    const endTs = startTs + 86400000;
    const { rows } = await this.pool.query(
      `SELECT
        COALESCE(SUM(cost_usd), 0)                     AS "totalUsd",
        COALESCE(SUM(input_tokens + output_tokens), 0)  AS "totalTokens",
        COUNT(*)                                         AS "eventCount"
      FROM llm_costs
      WHERE ts >= $1 AND ts < $2`,
      [startTs, endTs],
    );
    const row = rows[0];
    return {
      totalUsd: Number(row.totalUsd),
      totalTokens: Number(row.totalTokens),
      eventCount: Number(row.eventCount),
    };
  }

  async getLast30DaysDailySpend(since?: number): Promise<DailySpend[]> {
    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    const sinceTs = Math.max(since ?? 0, thirtyDaysAgo);
    const { rows } = await this.pool.query(
      `SELECT
        to_char(to_timestamp(ts / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        COALESCE(SUM(cost_usd), 0)                                         AS "costUsd"
      FROM llm_costs
      WHERE ts >= $1
      GROUP BY date
      ORDER BY date ASC`,
      [sinceTs],
    );
    return rows.map((r) => ({
      date: r.date,
      costUsd: Number(r.costUsd),
    }));
  }

  async getSessionBreakdown(limit?: number): Promise<SessionBreakdown[]> {
    const { rows } = await this.pool.query(
      `SELECT
        COALESCE(session_key, 'unknown') AS "sessionKey",
        SUM(cost_usd)  AS "costUsd",
        COUNT(*)        AS "eventCount",
        MIN(ts)         AS "startTs",
        MAX(ts)         AS "endTs"
      FROM llm_costs
      GROUP BY session_key
      ORDER BY "costUsd" DESC
      LIMIT $1`,
      [limit ?? 20],
    );
    return rows.map((r) => ({
      sessionKey: r.sessionKey,
      costUsd: Number(r.costUsd),
      eventCount: Number(r.eventCount),
      startTs: Number(r.startTs),
      endTs: Number(r.endTs),
    }));
  }

  async getTriggerBreakdown(since?: number): Promise<TriggerBreakdown[]> {
    const { rows } = await this.pool.query(
      `SELECT
        COALESCE(trigger, 'user')              AS trigger,
        is_subagent                             AS "isSubagent",
        SUM(cost_usd)                           AS "costUsd",
        SUM(input_tokens + output_tokens)       AS tokens,
        COUNT(*)                                AS "eventCount"
      FROM llm_costs
      WHERE ts >= $1
      GROUP BY trigger, is_subagent
      ORDER BY "costUsd" DESC`,
      [since ?? 0],
    );
    return rows.map((r) => ({
      trigger: r.trigger,
      isSubagent: Number(r.isSubagent),
      costUsd: Number(r.costUsd),
      tokens: Number(r.tokens),
      eventCount: Number(r.eventCount),
    }));
  }

  async getRecommendationData(): Promise<RecommendationData> {
    const thirtyDaysAgo = Date.now() - 30 * 86400000;

    const { rows: topModelRows } = await this.pool.query(
      `SELECT
        model,
        SUM(cost_usd)      AS "costUsd",
        AVG(output_tokens) AS "avgOutputTokens",
        COUNT(*)           AS "eventCount"
      FROM llm_costs
      WHERE ts >= $1 AND cost_usd > 0
      GROUP BY model
      ORDER BY "costUsd" DESC
      LIMIT 1`,
      [thirtyDaysAgo],
    );
    const topModel = topModelRows.length > 0
      ? {
          model: topModelRows[0].model,
          costUsd: Number(topModelRows[0].costUsd),
          avgOutputTokens: Number(topModelRows[0].avgOutputTokens),
          eventCount: Number(topModelRows[0].eventCount),
        }
      : null;

    const { rows: failedRows } = await this.pool.query(
      `SELECT COUNT(*) AS total FROM tool_calls WHERE success = 0`,
    );
    const { rows: totalRows } = await this.pool.query(
      `SELECT COUNT(*) AS total FROM tool_calls`,
    );

    return {
      topModel,
      failedTools: Number(failedRows[0].total),
      totalTools: Number(totalRows[0].total),
    };
  }

  private buildFilterClause(since?: number, filters?: CostFilters): { where: string; params: unknown[] } {
    const conditions: string[] = ["ts >= $1"];
    const params: unknown[] = [since ?? 0];
    let idx = 2;

    if (filters?.channel) { conditions.push(`channel = $${idx}`); params.push(filters.channel); idx++; }
    if (filters?.scope) { conditions.push(`scope = $${idx}`); params.push(filters.scope); idx++; }
    if (filters?.user) { conditions.push(`trigger_user = $${idx}`); params.push(filters.user); idx++; }
    if (filters?.agent) { conditions.push(`agent_name = $${idx}`); params.push(filters.agent); idx++; }
    if (filters?.model) { conditions.push(`model = $${idx}`); params.push(filters.model); idx++; }

    return { where: "WHERE " + conditions.join(" AND "), params };
  }
}

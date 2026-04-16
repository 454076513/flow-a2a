import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
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
  registered_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_costs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name      TEXT NOT NULL,
  agent_id        TEXT,
  instance_id     TEXT,
  session_key     TEXT,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  cost_source     TEXT,
  trigger         TEXT,
  is_subagent     INTEGER NOT NULL DEFAULT 0,
  trigger_user    TEXT,
  trigger_user_id TEXT,
  trigger_source  TEXT,
  ts              INTEGER NOT NULL,
  received_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name      TEXT NOT NULL,
  agent_id        TEXT,
  tool_name       TEXT,
  success         INTEGER,
  duration_ms     INTEGER,
  trigger_user    TEXT,
  trigger_source  TEXT,
  ts              INTEGER NOT NULL,
  received_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_costs_ts      ON llm_costs(ts);
CREATE INDEX IF NOT EXISTS idx_llm_costs_agent   ON llm_costs(agent_name);
CREATE INDEX IF NOT EXISTS idx_llm_costs_model   ON llm_costs(model);
CREATE INDEX IF NOT EXISTS idx_llm_costs_trigger ON llm_costs(trigger_user);
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts     ON tool_calls(ts);
CREATE INDEX IF NOT EXISTS idx_agents_name       ON agents(name);
`;

const MIGRATIONS: Array<{ version: number; description: string; sql: string }> = [
  {
    version: 1,
    description: "Add channel context columns to llm_costs",
    sql: `
      ALTER TABLE llm_costs ADD COLUMN channel TEXT;
      ALTER TABLE llm_costs ADD COLUMN scope TEXT;
      ALTER TABLE llm_costs ADD COLUMN conversation_id TEXT;
      ALTER TABLE llm_costs ADD COLUMN conversation_name TEXT;
      CREATE INDEX IF NOT EXISTS idx_llm_costs_channel ON llm_costs(channel);
      CREATE INDEX IF NOT EXISTS idx_llm_costs_scope ON llm_costs(scope);
      CREATE INDEX IF NOT EXISTS idx_llm_costs_conversation ON llm_costs(conversation_id)
    `,
  },
  {
    version: 2,
    description: "Add cache token columns to llm_costs",
    sql: `
      ALTER TABLE llm_costs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE llm_costs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0
    `,
  },
];

export class SqliteStorage implements Storage {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(BASE_SCHEMA);
    this.runMigrations();
  }

  private runMigrations(): void {
    const applied = new Set<number>(
      (this.db.prepare(`SELECT version FROM schema_migrations`).all() as { version: number }[])
        .map((r) => r.version),
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;

      console.log(`[center] Running migration v${migration.version}: ${migration.description}`);

      const statements = migration.sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);

      this.db.transaction(() => {
        for (const stmt of statements) {
          try {
            this.db.prepare(stmt).run();
          } catch (err: unknown) {
            if (String(err).includes("duplicate column")) continue;
            throw err;
          }
        }
        this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
          migration.version,
          Date.now(),
        );
      })();
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ─── Agent Registry ──────────────────────────────────────────────────────

  async upsertAgent(id: string, name: string, agentId?: string, instanceId?: string, botOpenId?: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
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

  async touchAgent(id: string): Promise<void> {
    this.db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  async removeAgent(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.db.prepare(
      `SELECT id, name, agent_id AS agentId, last_seen_at AS lastSeenAt FROM agents ORDER BY last_seen_at DESC`,
    ).all() as AgentInfo[];
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

    const insertLlm = this.db.prepare(`
      INSERT INTO llm_costs
        (agent_name, agent_id, instance_id, session_key, model, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens,
         cost_usd, cost_source, trigger, is_subagent, trigger_user, trigger_user_id, trigger_source,
         channel, scope, conversation_id, conversation_name, ts, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTool = this.db.prepare(`
      INSERT INTO tool_calls
        (agent_name, agent_id, tool_name, success, duration_ms, trigger_user, trigger_source, ts, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const runBatch = this.db.transaction(() => {
      for (const rec of batch) {
        try {
          switch (rec.kind) {
            case "llm":
              insertLlm.run(
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
              );
              break;
            case "tool":
              insertTool.run(
                agentName, agentId ?? null,
                rec.toolName ?? null,
                rec.success != null ? (rec.success ? 1 : 0) : null,
                rec.durationMs ?? null,
                rec.triggerUser ?? null, rec.triggerSource ?? null,
                rec.ts, now,
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

  // ─── Query Functions ─────────────────────────────────────────────────────

  async getSummary(since?: number): Promise<CostSummary> {
    const sinceTs = since ?? 0;
    return this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0)               AS totalCostUsd,
        COALESCE(SUM(input_tokens), 0)            AS totalInputTokens,
        COALESCE(SUM(output_tokens), 0)           AS totalOutputTokens,
        COALESCE(SUM(cache_read_tokens), 0)       AS totalCacheReadTokens,
        COALESCE(SUM(cache_creation_tokens), 0)   AS totalCacheCreationTokens,
        COUNT(*)                                   AS totalCalls,
        COUNT(DISTINCT model)                     AS modelCount,
        COUNT(DISTINCT agent_name)                AS agentCount
      FROM llm_costs
      WHERE ts >= ?
    `).get(sinceTs) as CostSummary;
  }

  async getCostsByAgent(since?: number): Promise<CostByAgent[]> {
    return this.db.prepare(`
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

  async getCostsByModel(since?: number): Promise<CostByModel[]> {
    return this.db.prepare(`
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

  async getCostsByTriggerUser(since?: number, filters?: CostFilters): Promise<CostByTriggerUser[]> {
    const { where, params } = this.buildFilterClause(since, filters);
    return this.db.prepare(`
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

  async getCostsByChannel(since?: number): Promise<CostByChannel[]> {
    return this.db.prepare(`
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

  async getCostsByConversation(since?: number): Promise<CostByConversation[]> {
    return this.db.prepare(`
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

  // ─── Additional Queries (ported from costclaw-telemetry) ─────────────────

  async getHourlySpend(since?: number): Promise<HourlySpend[]> {
    const today = new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(today + "T00:00:00Z").getTime();
    const sinceTs = Math.max(since ?? 0, startOfDay);
    return this.db.prepare(`
      SELECT
        strftime('%H', ts / 1000, 'unixepoch', 'localtime') AS hour,
        COALESCE(SUM(cost_usd), 0)                          AS costUsd,
        COALESCE(SUM(input_tokens + output_tokens), 0)      AS tokens
      FROM llm_costs
      WHERE ts >= ?
      GROUP BY hour
      ORDER BY hour ASC
    `).all(sinceTs) as HourlySpend[];
  }

  async getYesterdaySpend(): Promise<YesterdaySpend> {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const startTs = new Date(yesterday + "T00:00:00Z").getTime();
    const endTs = startTs + 86400000;
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0)                     AS totalUsd,
        COALESCE(SUM(input_tokens + output_tokens), 0)  AS totalTokens,
        COUNT(*)                                         AS eventCount
      FROM llm_costs
      WHERE ts >= ? AND ts < ?
    `).get(startTs, endTs) as YesterdaySpend;
    return row;
  }

  async getLast30DaysDailySpend(since?: number): Promise<DailySpend[]> {
    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    const sinceTs = Math.max(since ?? 0, thirtyDaysAgo);
    return this.db.prepare(`
      SELECT
        date(ts / 1000, 'unixepoch', 'localtime') AS date,
        COALESCE(SUM(cost_usd), 0)                 AS costUsd
      FROM llm_costs
      WHERE ts >= ?
      GROUP BY date
      ORDER BY date ASC
    `).all(sinceTs) as DailySpend[];
  }

  async getSessionBreakdown(limit?: number): Promise<SessionBreakdown[]> {
    return this.db.prepare(`
      SELECT
        COALESCE(session_key, 'unknown') AS sessionKey,
        SUM(cost_usd)  AS costUsd,
        COUNT(*)        AS eventCount,
        MIN(ts)         AS startTs,
        MAX(ts)         AS endTs
      FROM llm_costs
      GROUP BY session_key
      ORDER BY costUsd DESC
      LIMIT ?
    `).all(limit ?? 20) as SessionBreakdown[];
  }

  async getTriggerBreakdown(since?: number): Promise<TriggerBreakdown[]> {
    return this.db.prepare(`
      SELECT
        COALESCE(trigger, 'user')              AS trigger,
        is_subagent                             AS isSubagent,
        SUM(cost_usd)                           AS costUsd,
        SUM(input_tokens + output_tokens)       AS tokens,
        COUNT(*)                                AS eventCount
      FROM llm_costs
      WHERE ts >= ?
      GROUP BY trigger, is_subagent
      ORDER BY costUsd DESC
    `).all(since ?? 0) as TriggerBreakdown[];
  }

  async getRecommendationData(): Promise<RecommendationData> {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86400000;

    const topModel = this.db.prepare(`
      SELECT
        model,
        SUM(cost_usd)      AS costUsd,
        AVG(output_tokens) AS avgOutputTokens,
        COUNT(*)           AS eventCount
      FROM llm_costs
      WHERE ts >= ? AND cost_usd > 0
      GROUP BY model
      ORDER BY costUsd DESC
      LIMIT 1
    `).get(thirtyDaysAgo) as { model: string; costUsd: number; avgOutputTokens: number; eventCount: number } | undefined;

    const failedTools = this.db.prepare(
      `SELECT COUNT(*) AS total FROM tool_calls WHERE success = 0`
    ).get() as { total: number };

    const totalTools = this.db.prepare(
      `SELECT COUNT(*) AS total FROM tool_calls`
    ).get() as { total: number };

    return { topModel: topModel ?? null, failedTools: failedTools.total, totalTools: totalTools.total };
  }

  private buildFilterClause(since?: number, filters?: CostFilters): { where: string; params: unknown[] } {
    const conditions: string[] = ["ts >= ?"];
    const params: unknown[] = [since ?? 0];

    if (filters?.channel) { conditions.push("channel = ?"); params.push(filters.channel); }
    if (filters?.scope) { conditions.push("scope = ?"); params.push(filters.scope); }
    if (filters?.user) { conditions.push("trigger_user = ?"); params.push(filters.user); }
    if (filters?.agent) { conditions.push("agent_name = ?"); params.push(filters.agent); }
    if (filters?.model) { conditions.push("model = ?"); params.push(filters.model); }

    return { where: "WHERE " + conditions.join(" AND "), params };
  }
}

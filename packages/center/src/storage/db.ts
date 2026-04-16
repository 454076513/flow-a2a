import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

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
];

function runMigrations(): void {
  const applied = new Set<number>(
    (db.prepare(`SELECT version FROM schema_migrations`).all() as { version: number }[])
      .map((r) => r.version)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    console.log(`[center] Running migration v${migration.version}: ${migration.description}`);

    const statements = migration.sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    db.transaction(() => {
      for (const stmt of statements) {
        try {
          db.prepare(stmt).run();
        } catch (err: unknown) {
          if (String(err).includes("duplicate column")) continue;
          throw err;
        }
      }
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
        migration.version,
        Date.now()
      );
    })();
  }
}

export function initDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(BASE_SCHEMA);
  runMigrations();
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

export function closeDb(): void {
  db?.close();
}

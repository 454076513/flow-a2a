#!/usr/bin/env node
/**
 * Flow-A2A Center Service
 *
 * Standalone Node.js process:
 * - WebSocket relay (agent communication + telemetry ingestion)
 * - SQLite / PostgreSQL storage (cost data)
 * - HTTP API + Prometheus /metrics endpoint
 */

import { loadConfig } from "./config.js";
import { createStorage } from "./storage/index.js";
import { startWsServer, stopWsServer } from "./ws-server.js";
import { startHttpServer, stopHttpServer } from "./http-api.js";

const config = loadConfig();

console.log("[center] Flow-A2A Center starting...");
console.log(`[center] DB: ${config.dbType === "postgres" ? "PostgreSQL" : config.dbPath}`);

const storage = await createStorage(config);

startWsServer(config, storage);
startHttpServer(config, storage);

console.log("[center] Ready.");

function shutdown() {
  console.log("\n[center] Shutting down...");
  stopWsServer();
  stopHttpServer();
  storage.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

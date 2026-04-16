#!/usr/bin/env node
/**
 * Flow-A2A Center Service
 *
 * Standalone Node.js process:
 * - WebSocket relay (agent communication + telemetry ingestion)
 * - SQLite storage (cost data)
 * - HTTP API + Prometheus /metrics endpoint
 */

import { loadConfig } from "./config.js";
import { initDb, closeDb } from "./storage/db.js";
import { startWsServer, stopWsServer } from "./ws-server.js";
import { startHttpServer, stopHttpServer } from "./http-api.js";

const config = loadConfig();

console.log("[center] Flow-A2A Center starting...");
console.log(`[center] DB: ${config.dbPath}`);

initDb(config.dbPath);
startWsServer(config);
startHttpServer(config);

console.log("[center] Ready.");

function shutdown() {
  console.log("\n[center] Shutting down...");
  stopWsServer();
  stopHttpServer();
  closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

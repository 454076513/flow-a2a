/**
 * Flow-A2A Integration Tests
 *
 * Tests center service in-process: WS relay, telemetry ingestion,
 * agent communication, trigger user attribution, Prometheus metrics.
 *
 * Run: npx tsx packages/center/test/integration.ts
 */

import WebSocket from "ws";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { PostgresStorage } from "../src/storage/postgres.js";
import { startWsServer, stopWsServer } from "../src/ws-server.js";
import { startHttpServer, stopHttpServer } from "../src/http-api.js";
import type { CenterConfig } from "../src/config.js";
import type { TelemetryRecord, ClientMessage, ServerMessage } from "../../shared/src/types.js";
import type { Storage } from "../src/storage/index.js";
import { registry } from "../src/metrics.js";
import fs from "fs";
import path from "path";
import os from "os";

// ─── Test Helpers ───────────────────────────────────────────────────────────

const WS_PORT = 19876;
const HTTP_PORT = 13100;
const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_POSTGRES = DATABASE_URL.length > 0;
let dbPath: string;
let storage: Storage;

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function createWsClient(name: string, lobsterId: string, token = ""): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    const messages: ServerMessage[] = [];

    ws.on("open", () => {
      const registerMsg: any = {
        type: "register",
        lobsterId,
        name,
        token,
        groups: [],
        meta: { agentId: `agent-${lobsterId}`, instanceId: `inst-${lobsterId}` },
      };
      ws.send(JSON.stringify(registerMsg));
    });

    ws.on("message", (raw: WebSocket.Data) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      messages.push(msg);
      if (msg.type === "registered") {
        resolve({ ws, messages });
      }
    });

    ws.on("error", reject);
    setTimeout(() => reject(new Error(`WS connect timeout for ${name}`)), 5000);
  });
}

function sendMsg(ws: WebSocket, msg: any): void {
  ws.send(JSON.stringify(msg));
}

function waitForMessage(messages: ServerMessage[], type: string, timeout = 3000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const start = messages.length;
    const check = () => {
      for (let i = start; i < messages.length; i++) {
        if (messages[i].type === type) return resolve(messages[i]);
      }
    };
    check();
    const interval = setInterval(() => {
      check();
    }, 50);
    setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timeout waiting for message type="${type}"`));
    }, timeout);
  });
}

async function httpGet(urlPath: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${urlPath}`);
  if (urlPath === "/metrics") return res.text();
  return res.json();
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

async function setup() {
  dbPath = path.join(os.tmpdir(), `flow-a2a-test-${Date.now()}.db`);
  const config: CenterConfig = {
    wsPort: WS_PORT,
    httpPort: HTTP_PORT,
    dbType: USE_POSTGRES ? "postgres" : "sqlite",
    dbPath,
    postgresUrl: DATABASE_URL,
    relayToken: "",
    maxHistory: 100,
  };

  if (USE_POSTGRES) {
    console.log(`[test] Using PostgreSQL: ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
    const pg = new PostgresStorage(DATABASE_URL);
    await pg.init();
    storage = pg;
  } else {
    console.log(`[test] Using SQLite: ${dbPath}`);
    storage = new SqliteStorage(dbPath);
  }

  startWsServer(config, storage);
  startHttpServer(config, storage);
  await delay(500); // let servers start
}

async function teardown() {
  stopWsServer();
  stopHttpServer();
  await storage.close();
  if (!USE_POSTGRES) {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + "-wal"); } catch {}
    try { fs.unlinkSync(dbPath + "-shm"); } catch {}
  }
}

// ─── Test 1: Telemetry Ingestion ────────────────────────────────────────────

async function test1_telemetryIngestion() {
  console.log("\n═══ Test 1: Telemetry Ingestion ═══");

  const { ws, messages } = await createWsClient("BillingBot", "billing-001");

  // Send telemetry batch
  const batch: TelemetryRecord[] = [
    {
      kind: "llm",
      ts: Date.now(),
      sessionKey: "sess-001",
      model: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0075,
      costSource: "calculated",
      trigger: "user",
      isSubagent: false,
    },
    {
      kind: "llm",
      ts: Date.now(),
      sessionKey: "sess-001",
      model: "claude-opus-4-6",
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.105,
      costSource: "calculated",
      trigger: "user",
      isSubagent: false,
    },
    {
      kind: "tool",
      ts: Date.now(),
      toolName: "web_search",
      success: true,
      durationMs: 1200,
    },
  ];

  sendMsg(ws, { type: "telemetry", batch });
  const ack = await waitForMessage(messages, "telemetry_ack");

  assert(ack.type === "telemetry_ack", "Received telemetry_ack");
  assert((ack as any).accepted === 3, `Accepted 3 records (got ${(ack as any).accepted})`);

  // Verify HTTP API
  await delay(100);
  const summary = await httpGet("/api/summary");
  assert(summary.totalCalls === 2, `Summary totalCalls=2 (got ${summary.totalCalls})`);
  assert(Math.abs(summary.totalCostUsd - 0.1125) < 0.0001, `Summary totalCostUsd≈0.1125 (got ${summary.totalCostUsd})`);
  assert(summary.modelCount === 2, `Summary modelCount=2 (got ${summary.modelCount})`);

  const byModel = await httpGet("/api/costs/by-model");
  assert(byModel.length === 2, `2 models in breakdown (got ${byModel.length})`);

  const agents = await httpGet("/api/agents");
  assert(agents.some((a: any) => a.name === "BillingBot"), "BillingBot in agents list");

  // Verify Prometheus metrics
  const metrics = await httpGet("/metrics") as string;
  assert(metrics.includes("a2a_llm_calls_total"), "Prometheus has a2a_llm_calls_total");
  assert(metrics.includes("a2a_llm_cost_usd_total"), "Prometheus has a2a_llm_cost_usd_total");
  assert(metrics.includes("a2a_tool_calls_total"), "Prometheus has a2a_tool_calls_total");

  ws.close();
  await delay(200);
}

// ─── Test 2: Agent-to-Agent Communication ───────────────────────────────────

async function test2_agentCommunication() {
  console.log("\n═══ Test 2: Agent-to-Agent Communication ═══");

  const agentA = await createWsClient("AgentAlpha", "alpha-001");
  const agentB = await createWsClient("AgentBeta", "beta-001");

  await delay(200); // let both register

  // Lobby broadcast
  sendMsg(agentA.ws, { type: "lobby", text: "Hello from Alpha!" });
  const lobbyMsg = await waitForMessage(agentB.messages, "lobby");
  assert(lobbyMsg.type === "lobby", "AgentB received lobby message");
  assert((lobbyMsg as any).fromName === "AgentAlpha", `Lobby from AgentAlpha (got ${(lobbyMsg as any).fromName})`);
  assert((lobbyMsg as any).text === "Hello from Alpha!", "Lobby text matches");

  // DM
  sendMsg(agentA.ws, { type: "dm", to: "beta-001", text: "Private message for Beta" });
  const dmMsg = await waitForMessage(agentB.messages, "dm");
  assert(dmMsg.type === "dm", "AgentB received DM");
  assert((dmMsg as any).text === "Private message for Beta", "DM text matches");

  // Who
  sendMsg(agentA.ws, { type: "who" });
  const whoMsg = await waitForMessage(agentA.messages, "who");
  assert(whoMsg.type === "who", "Received who response");
  assert((whoMsg as any).lobsters.length >= 2, `At least 2 agents online (got ${(whoMsg as any).lobsters.length})`);

  // Verify message metrics
  const metrics = await httpGet("/metrics") as string;
  assert(metrics.includes("a2a_messages_total"), "Prometheus has a2a_messages_total");

  agentA.ws.close();
  agentB.ws.close();
  await delay(200);
}

// ─── Test 3: Trigger User Attribution ───────────────────────────────────────

async function test3_triggerUserAttribution() {
  console.log("\n═══ Test 3: Trigger User Attribution ═══");

  const { ws, messages } = await createWsClient("Wall-E", "walle-001");

  // Simulate: "张三 @agent in Feishu group" triggers LLM call
  const batch: TelemetryRecord[] = [
    {
      kind: "llm",
      ts: Date.now(),
      sessionKey: "feishu-sess-001",
      model: "gr-claude-opus-4.6",
      inputTokens: 5000,
      outputTokens: 2000,
      costUsd: 0.25,
      costSource: "calculated",
      trigger: "user",
      isSubagent: false,
      triggerUser: "张三",
      triggerUserId: "ou_feishu_zhangsan_123",
      triggerSource: "feishu",
    },
    {
      kind: "llm",
      ts: Date.now(),
      sessionKey: "feishu-sess-001",
      model: "gr-claude-opus-4.6",
      inputTokens: 3000,
      outputTokens: 1000,
      costUsd: 0.15,
      costSource: "calculated",
      trigger: "tool-result",
      isSubagent: false,
      triggerUser: "张三",
      triggerUserId: "ou_feishu_zhangsan_123",
      triggerSource: "feishu",
    },
    {
      kind: "tool",
      ts: Date.now(),
      toolName: "lobby",
      success: true,
      durationMs: 50,
      triggerUser: "张三",
      triggerSource: "feishu",
    },
  ];

  sendMsg(ws, { type: "telemetry", batch });
  const ack = await waitForMessage(messages, "telemetry_ack");
  assert((ack as any).accepted === 3, `Accepted 3 records (got ${(ack as any).accepted})`);

  await delay(100);

  // Verify costs attributed to 张三
  const byTrigger = await httpGet("/api/costs/by-trigger");
  const zhangsan = byTrigger.find((t: any) => t.triggerUser === "张三");
  assert(zhangsan !== undefined, "张三 found in costs-by-trigger");
  assert(Math.abs(zhangsan.costUsd - 0.40) < 0.001, `张三 total cost≈0.40 (got ${zhangsan?.costUsd})`);
  assert(zhangsan.calls === 2, `张三 calls=2 (got ${zhangsan?.calls})`);
  assert(zhangsan.triggerSource === "feishu", `triggerSource=feishu (got ${zhangsan?.triggerSource})`);

  // Verify Prometheus has trigger_user label
  const metrics = await httpGet("/metrics") as string;
  assert(
    metrics.includes('trigger_user="张三"'),
    "Prometheus metric has trigger_user=张三 label",
  );
  assert(
    metrics.includes('trigger_source="feishu"'),
    "Prometheus metric has trigger_source=feishu label",
  );

  ws.close();
  await delay(200);
}

// ─── Test 4: Multiple Users, Multiple Models ────────────────────────────────

async function test4_multiUserMultiModel() {
  console.log("\n═══ Test 4: Multiple Users, Multiple Models ═══");

  const { ws, messages } = await createWsClient("MultiBot", "multi-001");

  const batch: TelemetryRecord[] = [
    // 李四 uses gpt-4o
    {
      kind: "llm", ts: Date.now(), model: "gpt-4o",
      inputTokens: 800, outputTokens: 400, costUsd: 0.006,
      triggerUser: "李四", triggerUserId: "ou_lisi", triggerSource: "reef-dm",
    },
    // 李四 uses claude
    {
      kind: "llm", ts: Date.now(), model: "claude-sonnet-4-6",
      inputTokens: 1200, outputTokens: 600, costUsd: 0.0126,
      triggerUser: "李四", triggerUserId: "ou_lisi", triggerSource: "reef-dm",
    },
    // 王五 uses gpt-4o
    {
      kind: "llm", ts: Date.now(), model: "gpt-4o",
      inputTokens: 500, outputTokens: 200, costUsd: 0.00325,
      triggerUser: "王五", triggerUserId: "ou_wangwu", triggerSource: "reef-lobby",
    },
    // Tool call from 李四's session
    {
      kind: "tool", ts: Date.now(), toolName: "code_review",
      success: true, durationMs: 3500,
      triggerUser: "李四", triggerSource: "reef-dm",
    },
    // Tool failure from 王五's session
    {
      kind: "tool", ts: Date.now(), toolName: "web_search",
      success: false, durationMs: 30000,
      triggerUser: "王五", triggerSource: "reef-lobby",
    },
  ];

  sendMsg(ws, { type: "telemetry", batch });
  const ack = await waitForMessage(messages, "telemetry_ack");
  assert((ack as any).accepted === 5, `Accepted 5 records (got ${(ack as any).accepted})`);

  await delay(100);

  // Verify per-user breakdown
  const byTrigger = await httpGet("/api/costs/by-trigger");
  const lisi = byTrigger.find((t: any) => t.triggerUser === "李四");
  const wangwu = byTrigger.find((t: any) => t.triggerUser === "王五");

  assert(lisi !== undefined, "李四 found in breakdown");
  assert(wangwu !== undefined, "王五 found in breakdown");
  assert(lisi.calls === 2, `李四 calls=2 (got ${lisi?.calls})`);
  assert(wangwu.calls === 1, `王五 calls=1 (got ${wangwu?.calls})`);
  assert(Math.abs(lisi.costUsd - 0.0186) < 0.001, `李四 cost≈0.0186 (got ${lisi?.costUsd})`);

  // Verify per-model breakdown includes both models
  const byModel = await httpGet("/api/costs/by-model");
  const models = byModel.map((m: any) => m.model);
  assert(models.includes("gpt-4o"), "gpt-4o in model breakdown");
  assert(models.includes("claude-sonnet-4-6"), "claude-sonnet-4-6 in model breakdown");

  // Verify tool metrics include success and failure
  const metrics = await httpGet("/metrics") as string;
  assert(metrics.includes('status="success"'), "Tool success metrics recorded");
  assert(metrics.includes('status="failure"'), "Tool failure metrics recorded");

  ws.close();
  await delay(200);
}

// ─── Run All Tests ──────────────────────────────────────────────────────────

async function main() {
  console.log("Flow-A2A Integration Tests");
  console.log("═".repeat(50));

  try {
    await setup();
    console.log(`Center started — WS:${WS_PORT} HTTP:${HTTP_PORT} DB:${dbPath}`);

    // Verify health
    const health = await httpGet("/api/health");
    assert(health.status === "ok", "Center health check passed");

    await test1_telemetryIngestion();
    await test2_agentCommunication();
    await test3_triggerUserAttribution();
    await test4_multiUserMultiModel();

  } catch (err) {
    console.error("\n💥 Fatal error:", err);
    failed++;
  } finally {
    await teardown();
  }

  console.log("\n" + "═".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

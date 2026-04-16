import { Counter, Histogram, Gauge, Registry } from "prom-client";
import type { TelemetryRecord } from "@flow-a2a/shared";

export const registry = new Registry();

// ─── LLM Cost Metrics ───────────────────────────────────────────────────────

const llmCostTotal = new Counter({
  name: "a2a_llm_cost_usd_total",
  help: "Total LLM cost in USD",
  labelNames: ["agent", "model", "instance", "trigger_user", "trigger_source", "channel", "scope"] as const,
  registers: [registry],
});

const llmTokensTotal = new Counter({
  name: "a2a_llm_tokens_total",
  help: "Total LLM tokens consumed",
  labelNames: ["agent", "model", "direction", "trigger_user", "channel", "scope"] as const,
  registers: [registry],
});

const llmCallsTotal = new Counter({
  name: "a2a_llm_calls_total",
  help: "Total LLM calls",
  labelNames: ["agent", "model", "trigger_user", "channel", "scope"] as const,
  registers: [registry],
});

const llmCostPerCall = new Histogram({
  name: "a2a_llm_cost_per_call_usd",
  help: "LLM cost per call distribution in USD",
  labelNames: ["agent", "model"] as const,
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0],
  registers: [registry],
});

// ─── Tool Call Metrics ──────────────────────────────────────────────────────

const toolCallsTotal = new Counter({
  name: "a2a_tool_calls_total",
  help: "Total tool calls",
  labelNames: ["agent", "tool", "status"] as const,
  registers: [registry],
});

const toolDuration = new Histogram({
  name: "a2a_tool_duration_seconds",
  help: "Tool call duration in seconds",
  labelNames: ["agent", "tool"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

// ─── Communication Metrics ──────────────────────────────────────────────────

const messagesTotal = new Counter({
  name: "a2a_messages_total",
  help: "Total messages",
  labelNames: ["type"] as const,
  registers: [registry],
});

const agentsOnline = new Gauge({
  name: "a2a_agents_online",
  help: "Number of online agents",
  registers: [registry],
});

const wsConnections = new Gauge({
  name: "a2a_websocket_connections",
  help: "Active WebSocket connections",
  registers: [registry],
});

// ─── Recording Functions ────────────────────────────────────────────────────

export function recordLlmCost(agentName: string, instanceId: string, rec: TelemetryRecord): void {
  const model = rec.model ?? "unknown";
  const triggerUser = rec.triggerUser ?? "";
  const triggerSource = rec.triggerSource ?? "";
  const channel = rec.channel ?? "";
  const scope = rec.scope ?? "";
  const costUsd = rec.costUsd ?? 0;

  llmCostTotal.inc({ agent: agentName, model, instance: instanceId, trigger_user: triggerUser, trigger_source: triggerSource, channel, scope }, costUsd);
  llmTokensTotal.inc({ agent: agentName, model, direction: "input", trigger_user: triggerUser, channel, scope }, rec.inputTokens ?? 0);
  llmTokensTotal.inc({ agent: agentName, model, direction: "output", trigger_user: triggerUser, channel, scope }, rec.outputTokens ?? 0);
  llmTokensTotal.inc({ agent: agentName, model, direction: "cache_read", trigger_user: triggerUser, channel, scope }, rec.cacheReadTokens ?? 0);
  llmTokensTotal.inc({ agent: agentName, model, direction: "cache_creation", trigger_user: triggerUser, channel, scope }, rec.cacheCreationTokens ?? 0);
  llmCallsTotal.inc({ agent: agentName, model, trigger_user: triggerUser, channel, scope });
  llmCostPerCall.observe({ agent: agentName, model }, costUsd);
}

export function recordToolCall(agentName: string, rec: TelemetryRecord): void {
  const tool = rec.toolName ?? "unknown";
  const status = rec.success === false ? "failure" : "success";
  toolCallsTotal.inc({ agent: agentName, tool, status });
  if (rec.durationMs != null) {
    toolDuration.observe({ agent: agentName, tool }, rec.durationMs / 1000);
  }
}

export function recordMessage(type: "lobby" | "dm" | "feishu"): void {
  messagesTotal.inc({ type });
}

export function setAgentsOnline(count: number): void {
  agentsOnline.set(count);
}

export function setWsConnections(count: number): void {
  wsConnections.set(count);
}

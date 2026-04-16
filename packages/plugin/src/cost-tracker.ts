/**
 * Flow-A2A — Cost Tracker
 *
 * Captures LLM and tool events, computes costs, and manages
 * session → trigger user attribution mapping.
 */

import { computeCost, type TelemetryRecord, type TriggerUserInfo } from "@flow-a2a/shared";
import { redact } from "./pii-redact.js";

const subagentIds = new Set<string>();
const sessionUserMap = new Map<string, TriggerUserInfo>();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Periodic cleanup of stale session mappings
setInterval(() => {
  const now = Date.now();
  for (const [key, info] of sessionUserMap) {
    if (now - info.ts > SESSION_TTL_MS) sessionUserMap.delete(key);
  }
}, 5 * 60 * 1000); // every 5 minutes

// ─── Session → User Mapping ────────────────────────────────────────────────

export function setTriggerUser(sessionKey: string, info: Omit<TriggerUserInfo, "ts">): void {
  sessionUserMap.set(sessionKey, { ...info, ts: Date.now() });
}

export function getTriggerUser(sessionKey?: string, channelHint?: string): TriggerUserInfo | undefined {
  if (!sessionKey) return undefined;

  // Direct match (e.g., "a2a-feishu-zhangsan-..." from handleIncomingDm)
  const direct = sessionUserMap.get(sessionKey);
  if (direct) return direct;

  // For channel-dispatched sessions (feishu, etc.), the sessionKey looks like
  // "agent:main:feishu:group:oc_xxx" — extract the conversation ID and try conv: prefix
  const parts = sessionKey.split(":");
  if (parts.length >= 3) {
    // Try the last segment (e.g., "oc_xxx")
    const convId = parts[parts.length - 1];
    const byConv = sessionUserMap.get(`conv:${convId}`);
    if (byConv) return byConv;

    // Try "group:oc_xxx" or longer suffixes
    for (let i = parts.length - 2; i >= 2; i--) {
      const suffix = parts.slice(i).join(":");
      const match = sessionUserMap.get(`conv:${suffix}`);
      if (match) return match;
    }
  }

  // Fallback: use the most recent sender for this channel (set by message_received)
  // This handles p2p sessions where sessionKey is generic like "agent:main:main"
  if (channelHint) {
    const lastSender = sessionUserMap.get(`last:${channelHint}`);
    if (lastSender) return lastSender;
  }

  return undefined;
}

// ─── Subagent Tracking ─────────────────────────────────────────────────────

export function markSubagent(agentId: string): void {
  subagentIds.add(agentId);
}

// ─── Event → TelemetryRecord ───────────────────────────────────────────────

/**
 * Parse channel and scope from a session key as fallback.
 * e.g. "agent:main:feishu:group:oc_xxx" → { channel: "feishu", scope: "group", conversationId: "oc_xxx" }
 */
function parseSessionKey(sessionKey?: string): { channel?: string; scope?: string; conversationId?: string } {
  if (!sessionKey) return {};
  const parts = sessionKey.split(":");
  // Look for known channel names in parts
  const channelIdx = parts.findIndex(p => ["feishu", "telegram", "discord", "slack", "whatsapp", "line"].includes(p));
  if (channelIdx < 0) return {};
  const channel = parts[channelIdx];
  const scope = parts[channelIdx + 1]; // "group" | "dm" | "p2p" etc.
  const conversationId = parts.slice(channelIdx + 2).join(":") || undefined;
  return { channel, scope, conversationId };
}

export function trackLlmEvent(
  event: { runId: string; model: string; usage?: { input?: number; output?: number } },
  ctx: { sessionKey?: string; agentId?: string; trigger?: string; channelId?: string; conversationId?: string; messageProvider?: string }
): TelemetryRecord | null {
  // Always track LLM calls even if usage is unavailable (provider may not report tokens)
  const inputTokens = event.usage?.input ?? 0;
  const outputTokens = event.usage?.output ?? 0;
  const { costUsd, source } = computeCost(event.model, inputTokens, outputTokens);
  const channelHint = ctx.channelId || ctx.messageProvider;
  const trigger = getTriggerUser(ctx.sessionKey, channelHint);

  // Use trigger info if available, fall back to parsing session key, then ctx fields
  const skParsed = parseSessionKey(ctx.sessionKey);
  const channel = trigger?.channel || skParsed.channel || channelHint;
  const scope = trigger?.scope || skParsed.scope;
  const conversationId = trigger?.conversationId || skParsed.conversationId;
  const conversationName = trigger?.conversationName;

  return {
    kind: "llm",
    ts: Date.now(),
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    triggerUser: trigger?.triggerUser,
    triggerUserId: trigger?.triggerUserId,
    triggerSource: trigger?.triggerSource,
    channel,
    scope,
    conversationId,
    conversationName,
    model: event.model,
    inputTokens,
    outputTokens,
    costUsd,
    costSource: source,
    trigger: ctx.trigger ?? "user",
    isSubagent: ctx.agentId ? subagentIds.has(ctx.agentId) : false,
  };
}

export function trackToolEvent(
  event: { toolName: string; runId?: string; durationMs?: number; error?: string },
  ctx: { sessionKey?: string }
): TelemetryRecord {
  const trigger = getTriggerUser(ctx.sessionKey);

  return {
    kind: "tool",
    ts: Date.now(),
    sessionKey: ctx.sessionKey,
    triggerUser: trigger?.triggerUser,
    triggerUserId: trigger?.triggerUserId,
    triggerSource: trigger?.triggerSource,
    toolName: redact(event.toolName),
    success: !event.error,
    durationMs: event.durationMs,
  };
}

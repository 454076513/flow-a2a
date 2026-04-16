/**
 * Flow-A2A — OpenClaw Plugin Entry Point
 *
 * Merges reef (agent communication) + costclaw (LLM cost tracking) into a
 * unified plugin with real-time telemetry reporting to the Center service.
 */

import { Type } from "@sinclair/typebox";
import type { TelemetryRecord } from "@flow-a2a/shared";
import { computeCost } from "@flow-a2a/shared";
import { RelayClient } from "./relay-client.js";
import { Reporter } from "./reporter.js";
import { trackLlmEvent, trackToolEvent, markSubagent, setTriggerUser } from "./cost-tracker.js";
import { loadRules, redact } from "./pii-redact.js";
import { registerLobbyTool } from "./lobby-tool.js";

let _globalClient: RelayClient | null = null;
let _globalReporter: Reporter | null = null;

export default function register(api: any) {
  const log = api.logger || { info: console.log, warn: console.warn, error: console.error };
  const runtime = api.runtime;

  log.info("[a2a] Flow-A2A plugin registered");

  // ── Load config ───────────────────────────────────────────────────────────
  const fullConfig = runtime?.config?.loadConfig?.() || {};
  const pluginCfg = fullConfig?.plugins?.entries?.["flow-a2a"]?.config
                 || api.pluginConfig
                 || {};

  const relayUrl = pluginCfg.relayUrl || process.env.A2A_RELAY_URL || "";
  const lobsterId = pluginCfg.lobsterId || process.env.A2A_ID || "";
  const name = pluginCfg.name || process.env.A2A_NAME || "";
  const autoReply = pluginCfg.autoReply !== false;
  const reportIntervalMs = pluginCfg.reportIntervalMs ?? 10_000;
  const dashboardPort = pluginCfg.dashboardPort ?? 0; // 0 = disabled

  // Gateway config for spawning agent sessions
  const gwPort = fullConfig?.gateway?.port || 18789;
  const gwToken = fullConfig?.gateway?.auth?.token || "";

  // PII rules
  const stateDir: string = runtime?.state?.resolveStateDir?.() || ".";
  const piiRulesPath = pluginCfg.piiRulesPath || `${stateDir}/flow-a2a-pii-rules.json`;
  loadRules(piiRulesPath);

  // Feishu delivery config
  const deliverGroupId = pluginCfg.deliverGroupId || "";
  const lobsterFeishuMap = pluginCfg.lobsterFeishuMap || {};

  // ── Helper: get Feishu tenant token ──────────────────────────────────────
  async function getFeishuToken(): Promise<string | null> {
    const cfg = runtime?.config?.loadConfig?.() || {};
    const feishuCfg = cfg?.channels?.feishu;
    const appId = feishuCfg?.appId;
    const appSecret = feishuCfg?.appSecret;
    if (!appId || !appSecret) return null;

    const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenData = await tokenRes.json() as any;
    return tokenData.tenant_access_token || null;
  }

  // ── Helper: get Feishu chat name (cached) ────────────────────────────────
  const chatNameCache = new Map<string, string>();

  async function getFeishuChatName(chatId: string): Promise<string | undefined> {
    if (chatNameCache.has(chatId)) return chatNameCache.get(chatId);
    try {
      const token = await getFeishuToken();
      if (!token) return undefined;

      const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      const data = await res.json() as any;
      const name = data?.data?.name;
      if (name) {
        chatNameCache.set(chatId, name);
        return name;
      }
    } catch (err: any) {
      log.error(`[a2a] Feishu getChatName failed: ${err.message}`);
    }
    return undefined;
  }

  // ── Helper: send to Feishu group ──────────────────────────────────────────
  async function sendToFeishuGroup(text: string) {
    try {
      const cfg = runtime?.config?.loadConfig?.() || {};
      const a2aCfg = cfg?.plugins?.entries?.["flow-a2a"]?.config || {};
      const groupId = a2aCfg.deliverGroupId || deliverGroupId;
      if (!groupId) return;

      const token = await getFeishuToken();
      if (!token) return;

      await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          receive_id: groupId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      });
    } catch (err: any) {
      log.error(`[a2a] Feishu send failed: ${err.message}`);
    }
  }

  // ── Helper: spawn agent session via Gateway API ───────────────────────────
  async function spawnAgentSession(from: string, fromName: string, text: string, sessionKeyOverride?: string): Promise<boolean> {
    const prompt = [
      `[a2a] DM received from ${fromName} (lobsterId: ${from}).`,
      ``,
      `Their message:`,
      `${text}`,
      ``,
      `Instructions:`,
      `1. Read and understand the message.`,
      `2. Think about an appropriate response.`,
      `3. Use the lobby tool with action="dm", to="${from}" to send your reply.`,
      `4. Keep your reply concise, helpful, and in character.`,
      `5. If they asked you to do something (review PR, check data, etc.), do it and report back.`,
    ].join("\n");

    try {
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${gwToken}`,
        "Content-Type": "application/json",
      };
      if (sessionKeyOverride) {
        headers["X-OpenClaw-Session-Key"] = sessionKeyOverride;
      }

      const res = await fetch(`http://localhost:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: prompt }],
          user: fromName,
          stream: false,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        log.error(`[a2a] Agent session failed (${res.status}): ${errText.slice(0, 200)}`);
        return false;
      }

      return true;
    } catch (err: any) {
      log.error(`[a2a] Agent session error: ${err.message}`);
      return false;
    }
  }

  // ── Handle incoming DM / @mention ─────────────────────────────────────────
  async function handleIncomingDm(from: string, fromName: string, text: string, triggerSource: string) {
    // Set trigger user mapping for this session
    const sessionKey = `a2a-${from}-${Date.now()}`;
    // Derive channel/scope from triggerSource: "reef-lobby" → reef/lobby, "reef-dm" → reef/dm
    const [chan, sc] = triggerSource.includes("-")
      ? triggerSource.split("-", 2) : [triggerSource, "dm"];
    setTriggerUser(sessionKey, {
      triggerUser: fromName,
      triggerUserId: from,
      triggerSource,
      channel: chan,
      scope: sc,
      conversationName: fromName,
    });

    log.info(`[a2a] Spawning agent session for ${triggerSource} from ${fromName}`);
    const ok = await spawnAgentSession(from, fromName, text, sessionKey);
    if (!ok) {
      log.error(`[a2a] Agent session failed for ${fromName}`);
      await sendToFeishuGroup(`[a2a] Agent 处理 ${fromName} 的消息失败`);
    }
  }

  // ── Hook: capture sender from incoming messages (feishu, etc.) ────────────
  api.on(
    "message_received",
    (
      event: {
        from: string; content: string; timestamp?: number;
        metadata?: {
          provider?: string; surface?: string; senderId?: string;
          senderName?: string; senderUsername?: string;
          originatingChannel?: string; channelName?: string;
          threadId?: string; to?: string;
        };
      },
      ctx: { channelId?: string; accountId?: string; conversationId?: string; sessionKey?: string }
    ) => {
      const senderId = event.metadata?.senderId;
      const senderName = event.metadata?.senderName || event.metadata?.senderUsername || event.from;
      const channel = ctx.channelId || event.metadata?.provider || "unknown";
      let convName = event.metadata?.channelName || undefined;

      // Derive scope from the "to" field prefix: "chat:" → group, "user:" → p2p
      const toField = event.metadata?.to || "";
      let scope: string | undefined;
      if (toField.startsWith("chat:")) scope = "group";
      else if (toField.startsWith("user:")) scope = "p2p";

      log.info(`[a2a] message_received: ${senderName} [${channel}/${scope}]`);

      if (senderName) {
        // Strip "chat:", "user:" prefixes from conversationId for matching against sessionKey
        const rawConvId = ctx.conversationId || "";
        const convId = rawConvId.replace(/^(?:chat|user|channel):/, "");

        const storeTrigger = (name?: string) => {
          const info = {
            triggerUser: senderName,
            triggerUserId: senderId || event.from,
            triggerSource: channel,
            channel,
            scope,
            conversationId: convId || undefined,
            conversationName: name,
          };

          if (convId) {
            setTriggerUser(`conv:${convId}`, info);
          }
          if (channel) {
            setTriggerUser(`last:${channel}`, info);
          }
          log.info(`[a2a] trigger: ${senderName} [${channel}/${scope}] conv:${convId || '-'} name:${name || '-'}`);
        };

        if (convName) {
          // channelName already provided by OpenClaw
          storeTrigger(convName);
        } else if (scope === "group" && convId && channel === "feishu") {
          // Feishu group but no channelName — fetch from API
          getFeishuChatName(convId).then((name) => {
            storeTrigger(name);
          }).catch(() => {
            storeTrigger(undefined);
          });
        } else {
          storeTrigger(senderName);
        }
      }
    }
  );

  // ── Hook: track subagents ─────────────────────────────────────────────────
  api.on("subagent_spawning", (event: { agentId?: string }) => {
    if (event.agentId) markSubagent(event.agentId);
  });

  // ── Hook: capture LLM usage ───────────────────────────────────────────────
  api.on(
    "llm_output",
    (
      event: { runId: string; model: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } },
      ctx: { sessionKey?: string; agentId?: string; trigger?: string; channelId?: string; conversationId?: string; sessionId?: string; messageProvider?: string }
    ) => {
      const record = trackLlmEvent(event, ctx);
      if (record && _globalReporter) {
        _globalReporter.push(record);
      }
    }
  );

  // ── Hook: capture tool calls ──────────────────────────────────────────────
  api.on(
    "after_tool_call",
    (
      event: { toolName: string; runId?: string; durationMs?: number; error?: string },
      ctx: { sessionKey?: string }
    ) => {
      const record = trackToolEvent(event, ctx);
      if (_globalReporter) {
        _globalReporter.push(record);
      }
    }
  );

  // ── Start relay client ────────────────────────────────────────────────────
  if (relayUrl && lobsterId) {
    if (_globalClient?.isConnected()) {
      log.info("[a2a] Client already connected, reusing");
    } else {
      if (_globalClient) {
        _globalClient.stop();
        _globalClient = null;
      }
      if (_globalReporter) {
        _globalReporter.stop();
        _globalReporter = null;
      }

      const client = new RelayClient({
        relayUrl, lobsterId, name,
        botOpenId: pluginCfg.botOpenId || undefined,
        token: pluginCfg.token || undefined,
        groups: Array.isArray(pluginCfg.groups) ? pluginCfg.groups : [],
        meta: pluginCfg.meta || {},
        adapter: {
          onLobbyMessage(msg) {
            log.info(`[a2a] [lobby] ${msg.fromName}: ${msg.text.slice(0, 100)}`);
            if (autoReply && msg.from !== lobsterId) {
              const mentionPatterns = [
                `@${lobsterId}`, `@${name}`,
              ].map(p => p.toLowerCase());
              const textLower = msg.text.toLowerCase();
              if (mentionPatterns.some(p => textLower.includes(p))) {
                log.info(`[a2a] Detected mention from ${msg.fromName}, handling as DM`);
                handleIncomingDm(msg.from, msg.fromName, msg.text, "reef-lobby").catch(() => {});
              }
            }
          },
          onDirectMessage(msg) {
            log.info(`[a2a] [DM] ${msg.fromName}: ${msg.text.slice(0, 100)}`);
            if (autoReply && msg.from !== lobsterId) {
              handleIncomingDm(msg.from, msg.fromName, msg.text, "reef-dm").catch(() => {});
            }
          },
          onFeishuRelay(msg) {
            log.info(`[a2a] [feishu] ${msg.fromName}: ${msg.text.slice(0, 80)}`);
          },
          onPresence(msg) {
            log.info(`[a2a] ${msg.name} ${msg.type === "join" ? "joined" : "left"}`);
          },
          onHistory(messages) {
            log.info(`[a2a] Got ${messages.length} history messages`);
          },
        },
        log: (...args: any[]) => log.info(...args),
      });

      client.start();
      _globalClient = client;

      // Start telemetry reporter
      const reporter = new Reporter(client, reportIntervalMs);
      reporter.start();
      _globalReporter = reporter;

      log.info(`[a2a] Relay client started → ${relayUrl}`);
      log.info(`[a2a] Telemetry reporter: interval=${reportIntervalMs}ms`);
    }
  } else {
    log.info("[a2a] Relay disabled (missing relayUrl or lobsterId)");
  }

  // ── Register lobby tool ───────────────────────────────────────────────────
  if (_globalClient) {
    registerLobbyTool(api, {
      client: _globalClient,
      lobsterId,
      name,
      deliverGroupId,
      lobsterFeishuMap,
      sendToFeishuGroup,
    });
    log.info("[a2a] Lobby tool registered");
  }

  // ── Register a2a_status tool ──────────────────────────────────────────────
  api.registerTool({
    name: "a2a_status",
    label: "Flow-A2A Status",
    description:
      "Returns connection status, cost summary (today/month), cache token usage, and telemetry info for the A2A plugin.",
    parameters: Type.Object({}),
    async execute() {
      const connected = _globalClient?.isConnected() ?? false;
      const online = _globalClient?.onlineLobsters ?? [];
      const lines = [
        `**Flow-A2A Status**`,
        `• Relay: ${connected ? "connected" : "disconnected"}`,
        `• Online agents: ${online.length}`,
        `• Telemetry reporter: ${_globalReporter ? "active" : "inactive"}`,
      ];

      // Try to fetch cost summary from center service
      if (relayUrl) {
        try {
          const httpBase = relayUrl
            .replace(/^ws:/, "http:")
            .replace(/^wss:/, "https:")
            .replace(/:\d+$/, ":3000"); // assume HTTP on port 3000
          const todayStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
          const monthStart = new Date(new Date().toISOString().slice(0, 7) + "-01T00:00:00Z").getTime();

          const [todayRes, monthRes] = await Promise.all([
            fetch(`${httpBase}/api/summary?since=${todayStart}`).then(r => r.ok ? r.json() as any : null).catch(() => null),
            fetch(`${httpBase}/api/summary?since=${monthStart}`).then(r => r.ok ? r.json() as any : null).catch(() => null),
          ]);

          if (todayRes) {
            lines.push(`• Today: $${todayRes.totalCostUsd?.toFixed(4) ?? "?"} (${todayRes.totalCalls ?? 0} calls)`);
          }
          if (monthRes) {
            lines.push(`• This month: $${monthRes.totalCostUsd?.toFixed(4) ?? "?"} (${monthRes.totalCalls ?? 0} calls)`);
            lines.push(`• Models: ${monthRes.modelCount ?? 0}, Agents: ${monthRes.agentCount ?? 0}`);
            const cacheRead = monthRes.totalCacheReadTokens ?? 0;
            const cacheCreate = monthRes.totalCacheCreationTokens ?? 0;
            if (cacheRead > 0 || cacheCreate > 0) {
              lines.push(`• Cache tokens: read=${cacheRead.toLocaleString()}, create=${cacheCreate.toLocaleString()}`);
            }
          }
        } catch {
          // Center unreachable — show local-only info
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  });

  // ── Service lifecycle ─────────────────────────────────────────────────────
  api.registerService({
    id: "flow-a2a",
    start: async () => {
      log.info("[a2a] Service started");
    },
    stop: async () => {
      _globalReporter?.stop();
      _globalClient?.stop();
      _globalReporter = null;
      _globalClient = null;
      log.info("[a2a] Service stopped");
    },
  });
}

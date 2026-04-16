/**
 * Flow-A2A Center — WebSocket Server
 *
 * Handles agent communication (register/lobby/dm/feishu/who/history/ping)
 * and telemetry ingestion. Reused from reef/src/relay-server.ts with
 * telemetry handler added.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage, LobsterInfo, MentionTarget, TelemetryRecord } from "@flow-a2a/shared";
import type { CenterConfig } from "./config.js";
import { upsertAgent, removeAgent, touchAgent } from "./storage/queries.js";
import { insertTelemetryBatch } from "./storage/queries.js";
import { recordLlmCost, recordToolCall, recordMessage, setAgentsOnline, setWsConnections } from "./metrics.js";

// ─── State ──────────────────────────────────────────────────────────────────

interface Lobster {
  ws: WebSocket;
  id: string;
  name: string;
  botOpenId: string | null;
  groups: Set<string>;
  meta: Record<string, unknown>;
  connectedAt: number;
  lastPing: number;
}

const lobsters = new Map<string, Lobster>();
const botOpenIdIndex = new Map<string, string>();
const botNameIndex = new Map<string, string>();
let lobbyHistory: ServerMessage[] = [];
let maxHistory = 200;

// ─── Server ─────────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let staleTimer: ReturnType<typeof setInterval> | null = null;

export function startWsServer(config: CenterConfig): WebSocketServer {
  maxHistory = config.maxHistory;
  const relayToken = config.relayToken;

  wss = new WebSocketServer({ port: config.wsPort });
  console.log(`[center] WebSocket relay: ws://0.0.0.0:${config.wsPort}`);
  if (relayToken) console.log(`[center] Auth: token required`);

  wss.on("connection", (ws: WebSocket) => {
    let registeredId: string | null = null;
    setWsConnections(wss!.clients.size);

    ws.on("message", (raw: Buffer) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); }
      catch { return send(ws, { type: "error", message: "Invalid JSON" }); }

      switch (msg.type) {
        case "register":  handleRegister(ws, msg, relayToken); registeredId = msg.lobsterId; break;
        case "lobby":     handleLobby(ws, msg, registeredId); break;
        case "dm":        handleDm(ws, msg, registeredId); break;
        case "feishu":    handleFeishu(ws, msg, registeredId); break;
        case "history":   handleHistory(ws, registeredId); break;
        case "telemetry": handleTelemetry(ws, msg, registeredId); break;
        case "ping":
          if (registeredId && lobsters.has(registeredId)) {
            lobsters.get(registeredId)!.lastPing = Date.now();
            touchAgent(registeredId);
          }
          send(ws, { type: "pong" });
          break;
        case "who":
          send(ws, { type: "who", lobsters: listLobsters() });
          break;
        default:
          send(ws, { type: "error", message: `Unknown: ${(msg as any).type}` });
      }
    });

    ws.on("close", () => {
      if (registeredId && lobsters.has(registeredId)) {
        const info = lobsters.get(registeredId)!;
        cleanup(registeredId);
        removeAgent(registeredId);
        broadcast({ type: "leave", lobsterId: registeredId, name: info.name, ts: Date.now() }, registeredId);
        console.log(`[center] ${info.name} left [${lobsters.size} online]`);
        setAgentsOnline(lobsters.size);
      }
      setWsConnections(wss?.clients.size ?? 0);
    });

    ws.on("error", (err: Error) => {
      console.error(`[center] WS error (${registeredId || "?"}):`, err.message);
    });
  });

  // Evict stale connections every 60s
  staleTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, info] of lobsters) {
      if (now - info.lastPing > 120_000) {
        console.log(`[center] Evicting stale: ${info.name}`);
        try { info.ws.close(4002, "stale"); } catch {}
        cleanup(id);
        removeAgent(id);
        broadcast({ type: "leave", lobsterId: id, name: info.name, ts: Date.now() });
      }
    }
    setAgentsOnline(lobsters.size);
  }, 60_000);

  return wss;
}

export function stopWsServer(): void {
  if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
  wss?.close();
  wss = null;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

function handleRegister(ws: WebSocket, msg: ClientMessage & { type: "register" }, relayToken: string) {
  const { lobsterId, name, botOpenId, token, groups, meta } = msg;
  if (!lobsterId || !name) return send(ws, { type: "error", message: "Missing lobsterId/name" });
  if (relayToken && token !== relayToken) return send(ws, { type: "error", message: "Invalid token" });

  // Evict old connection
  if (lobsters.has(lobsterId)) {
    const old = lobsters.get(lobsterId)!;
    try { old.ws.close(4001, "replaced"); } catch {}
    cleanup(lobsterId);
  }

  const info: Lobster = {
    ws, id: lobsterId,
    name: name.trim(),
    botOpenId: botOpenId?.trim() || null,
    groups: new Set(Array.isArray(groups) ? groups : []),
    meta: meta || {},
    connectedAt: Date.now(),
    lastPing: Date.now(),
  };
  lobsters.set(lobsterId, info);
  if (info.botOpenId) botOpenIdIndex.set(info.botOpenId, lobsterId);
  botNameIndex.set(info.name.toLowerCase(), lobsterId);

  // Persist agent registration
  upsertAgent(lobsterId, info.name, (meta as any)?.agentId, (meta as any)?.instanceId, info.botOpenId ?? undefined);

  send(ws, { type: "registered", lobsterId, lobsters: listLobsters() });
  broadcast({ type: "join", lobsterId, name: info.name, ts: Date.now() }, lobsterId);

  if (lobbyHistory.length > 0) {
    send(ws, { type: "history", messages: lobbyHistory.slice(-50) });
  }

  setAgentsOnline(lobsters.size);
  console.log(`[center] ${info.name} (${lobsterId}${info.botOpenId ? `, bot=${info.botOpenId}` : ""}) joined [${lobsters.size} online]`);
}

function handleLobby(ws: WebSocket, msg: { text: string }, senderId: string | null) {
  if (!senderId || !lobsters.has(senderId)) return send(ws, { type: "error", message: "Not registered" });
  const sender = lobsters.get(senderId)!;
  const text = msg.text?.trim();
  if (!text) return send(ws, { type: "error", message: "Empty text" });

  const payload: ServerMessage = { type: "lobby", from: senderId, fromName: sender.name, text, ts: Date.now() };
  lobbyHistory.push(payload);
  if (lobbyHistory.length > maxHistory) lobbyHistory.shift();

  recordMessage("lobby");
  console.log(`[center] [lobby] ${sender.name}: ${text.slice(0, 120)}`);
  for (const [, info] of lobsters) send(info.ws, payload);
}

function handleDm(ws: WebSocket, msg: { to: string; text: string }, senderId: string | null) {
  if (!senderId || !lobsters.has(senderId)) return send(ws, { type: "error", message: "Not registered" });
  const sender = lobsters.get(senderId)!;
  if (!msg.to || !msg.text?.trim()) return send(ws, { type: "error", message: "Missing to/text" });

  const targetId = lobsters.has(msg.to) ? msg.to : botNameIndex.get(msg.to.toLowerCase()) || null;
  if (!targetId || !lobsters.has(targetId)) {
    return send(ws, { type: "error", message: `'${msg.to}' not found. Online: ${[...lobsters.keys()].join(", ")}` });
  }

  const payload: ServerMessage = { type: "dm", from: senderId, fromName: sender.name, text: msg.text.trim(), ts: Date.now() };
  recordMessage("dm");
  console.log(`[center] [DM] ${sender.name} → ${lobsters.get(targetId)!.name}: ${msg.text.trim().slice(0, 120)}`);
  send(lobsters.get(targetId)!.ws, payload);
  send(ws, { ...payload, echo: true });
}

function handleFeishu(ws: WebSocket, msg: { chatId: string; text: string; messageId?: string; threadId?: string; mentions?: MentionTarget[] }, senderId: string | null) {
  if (!senderId || !lobsters.has(senderId)) return send(ws, { type: "error", message: "Not registered" });
  const sender = lobsters.get(senderId)!;
  if (!sender.botOpenId) return send(ws, { type: "error", message: "No botOpenId — Feishu relay needs it" });
  if (!msg.chatId || !msg.text) return send(ws, { type: "error", message: "Missing chatId/text" });

  const payload: ServerMessage = {
    type: "feishu", from: senderId, fromName: sender.name, fromBotOpenId: sender.botOpenId,
    chatId: msg.chatId, text: msg.text, messageId: msg.messageId || `relay-${senderId}-${Date.now()}`,
    threadId: msg.threadId, ts: Date.now(),
  };

  let targets: string[] = [];
  if (Array.isArray(msg.mentions) && msg.mentions.length > 0) {
    for (const m of msg.mentions) {
      const tid = (m.openId && botOpenIdIndex.get(m.openId)) || (m.name && botNameIndex.get(m.name.trim().toLowerCase()));
      if (tid && tid !== senderId && lobsters.has(tid)) targets.push(tid);
    }
  } else {
    for (const [id, info] of lobsters) {
      if (id !== senderId && (info.groups.has(msg.chatId) || info.groups.size === 0)) targets.push(id);
    }
  }

  targets = [...new Set(targets)];
  recordMessage("feishu");
  for (const tid of targets) send(lobsters.get(tid)!.ws, payload);
  if (targets.length > 0) {
    console.log(`[center] Feishu: ${sender.name} → [${targets.map(t => lobsters.get(t)?.name).join(", ")}] in ${msg.chatId}`);
  }
}

function handleHistory(ws: WebSocket, senderId: string | null) {
  if (!senderId) return send(ws, { type: "error", message: "Not registered" });
  send(ws, { type: "history", messages: lobbyHistory.slice(-50) });
}

function handleTelemetry(ws: WebSocket, msg: { batch: TelemetryRecord[] }, senderId: string | null) {
  if (!senderId || !lobsters.has(senderId)) return send(ws, { type: "error", message: "Not registered" });
  const sender = lobsters.get(senderId)!;

  if (!Array.isArray(msg.batch) || msg.batch.length === 0) {
    return send(ws, { type: "telemetry_ack", accepted: 0, errors: ["Empty batch"] });
  }

  // Persist to SQLite
  const { accepted, errors } = insertTelemetryBatch(
    sender.name,
    (sender.meta as any)?.agentId,
    (sender.meta as any)?.instanceId,
    msg.batch
  );

  // Update Prometheus metrics
  for (const rec of msg.batch) {
    switch (rec.kind) {
      case "llm":
        recordLlmCost(sender.name, sender.id, rec);
        break;
      case "tool":
        recordToolCall(sender.name, rec);
        break;
    }
  }

  send(ws, { type: "telemetry_ack", accepted, errors: errors.length > 0 ? errors : undefined });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function cleanup(lobsterId: string) {
  const info = lobsters.get(lobsterId);
  if (!info) return;
  if (info.botOpenId) botOpenIdIndex.delete(info.botOpenId);
  botNameIndex.delete(info.name.toLowerCase());
  lobsters.delete(lobsterId);
}

function listLobsters(): LobsterInfo[] {
  return [...lobsters.values()].map(l => ({
    id: l.id, name: l.name, botOpenId: l.botOpenId || undefined,
    groups: [...l.groups], connectedAt: l.connectedAt,
    meta: l.meta,
  }));
}

function broadcast(payload: ServerMessage, excludeId?: string) {
  for (const [id, info] of lobsters) {
    if (id !== excludeId) send(info.ws, payload);
  }
}

function send(ws: WebSocket, data: ServerMessage) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

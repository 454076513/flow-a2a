/**
 * Flow-A2A Center — WebSocket Server
 *
 * Handles agent communication (register/lobby/dm/feishu/who/history/ping)
 * and telemetry ingestion.
 *
 * Cluster-aware: uses PubSub for cross-instance agent registry,
 * lobby history, and message relay.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage, LobsterInfo, MentionTarget, TelemetryRecord } from "@flow-a2a/shared";
import type { CenterConfig } from "./config.js";
import type { Storage } from "./storage/index.js";
import type { PubSub, ClusterMessage } from "./pubsub/index.js";
import { presenceToLobsterInfo, type AgentPresence } from "./pubsub/index.js";
import { recordLlmCost, recordToolCall, recordMessage, setAgentsOnline, setWsConnections } from "./metrics.js";

// ─── Local State (this instance only) ──────────────────────────────────────

interface LocalAgent {
  ws: WebSocket;
  id: string;
  name: string;
  botOpenId: string | null;
  groups: Set<string>;
  meta: Record<string, unknown>;
  connectedAt: number;
  lastPing: number;
}

/** Agents connected to THIS instance (keyed by lobsterId) */
const localAgents = new Map<string, LocalAgent>();

// ─── Module State ──────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let staleTimer: ReturnType<typeof setInterval> | null = null;
let _storage: Storage;
let _pubsub: PubSub;
let _maxHistory = 200;
let _nodeId = "";

export function startWsServer(config: CenterConfig, storage: Storage, pubsub: PubSub): WebSocketServer {
  _maxHistory = config.maxHistory;
  _storage = storage;
  _pubsub = pubsub;
  _nodeId = `center-${process.pid}`;
  const relayToken = config.relayToken;

  // Subscribe to cross-instance messages
  _pubsub.subscribe(handleClusterMessage);

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
          if (registeredId && localAgents.has(registeredId)) {
            localAgents.get(registeredId)!.lastPing = Date.now();
            _storage.touchAgent(registeredId);
          }
          send(ws, { type: "pong" });
          break;
        case "who":
          handleWho(ws);
          break;
        default:
          send(ws, { type: "error", message: `Unknown: ${(msg as any).type}` });
      }
    });

    ws.on("close", () => {
      if (registeredId && localAgents.has(registeredId)) {
        const info = localAgents.get(registeredId)!;
        cleanupLocal(registeredId);
        _storage.removeAgent(registeredId);
        _pubsub.unregisterAgent(registeredId);

        const leaveMsg: ServerMessage = { type: "leave", lobsterId: registeredId, name: info.name, ts: Date.now() };
        broadcastLocal(leaveMsg, registeredId);
        _pubsub.publish({ type: "broadcast", payload: leaveMsg, excludeId: registeredId });

        console.log(`[center] ${info.name} left [${localAgents.size} local]`);
        setAgentsOnline(localAgents.size);
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
    for (const [id, info] of localAgents) {
      if (now - info.lastPing > 120_000) {
        console.log(`[center] Evicting stale: ${info.name}`);
        try { info.ws.close(4002, "stale"); } catch {}
        cleanupLocal(id);
        _storage.removeAgent(id);
        _pubsub.unregisterAgent(id);

        const leaveMsg: ServerMessage = { type: "leave", lobsterId: id, name: info.name, ts: Date.now() };
        broadcastLocal(leaveMsg);
        _pubsub.publish({ type: "broadcast", payload: leaveMsg });
      }
    }
    setAgentsOnline(localAgents.size);
  }, 60_000);

  return wss;
}

export function stopWsServer(): void {
  if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
  wss?.close();
  wss = null;
}

// ─── Cluster Message Handler ───────────────────────────────────────────────

function handleClusterMessage(msg: ClusterMessage): void {
  switch (msg.type) {
    case "relay": {
      // Deliver to local agent if present
      const local = localAgents.get(msg.targetId);
      if (local) send(local.ws, msg.payload);
      break;
    }
    case "broadcast": {
      broadcastLocal(msg.payload, msg.excludeId);
      break;
    }
    case "evict": {
      const local = localAgents.get(msg.lobsterId);
      if (local) {
        try { local.ws.close(4001, "replaced"); } catch {}
        cleanupLocal(msg.lobsterId);
      }
      break;
    }
  }
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function handleRegister(ws: WebSocket, msg: ClientMessage & { type: "register" }, relayToken: string) {
  const { lobsterId, name, botOpenId, token, groups, meta } = msg;
  if (!lobsterId || !name) return send(ws, { type: "error", message: "Missing lobsterId/name" });
  if (relayToken && token !== relayToken) return send(ws, { type: "error", message: "Invalid token" });

  // Evict old connection on this instance
  if (localAgents.has(lobsterId)) {
    const old = localAgents.get(lobsterId)!;
    try { old.ws.close(4001, "replaced"); } catch {}
    cleanupLocal(lobsterId);
  }

  // Evict old connection on other instances
  _pubsub.publish({ type: "evict", lobsterId });

  const info: LocalAgent = {
    ws, id: lobsterId,
    name: name.trim(),
    botOpenId: botOpenId?.trim() || null,
    groups: new Set(Array.isArray(groups) ? groups : []),
    meta: meta || {},
    connectedAt: Date.now(),
    lastPing: Date.now(),
  };
  localAgents.set(lobsterId, info);

  // Register in global registry
  const presence: AgentPresence = {
    id: lobsterId,
    name: info.name,
    botOpenId: info.botOpenId,
    groups: [...info.groups],
    meta: info.meta,
    connectedAt: info.connectedAt,
    nodeId: _nodeId,
  };
  await _pubsub.registerAgent(presence);

  // Persist agent in DB
  _storage.upsertAgent(lobsterId, info.name, (meta as any)?.agentId, (meta as any)?.instanceId, info.botOpenId ?? undefined);

  // Send registered + global agent list
  const allAgents = await _pubsub.listAllAgents();
  const lobsters: LobsterInfo[] = allAgents.map(presenceToLobsterInfo);
  send(ws, { type: "registered", lobsterId, lobsters });

  // Broadcast join
  const joinMsg: ServerMessage = { type: "join", lobsterId, name: info.name, ts: Date.now() };
  broadcastLocal(joinMsg, lobsterId);
  _pubsub.publish({ type: "broadcast", payload: joinMsg, excludeId: lobsterId });

  // Send lobby history
  const history = await _pubsub.getLobbyHistory(50);
  if (history.length > 0) {
    send(ws, { type: "history", messages: history });
  }

  setAgentsOnline(localAgents.size);
  console.log(`[center] ${info.name} (${lobsterId}${info.botOpenId ? `, bot=${info.botOpenId}` : ""}) joined [${localAgents.size} local]`);
}

function handleLobby(ws: WebSocket, msg: { text: string }, senderId: string | null) {
  if (!senderId || !localAgents.has(senderId)) return send(ws, { type: "error", message: "Not registered" });
  const sender = localAgents.get(senderId)!;
  const text = msg.text?.trim();
  if (!text) return send(ws, { type: "error", message: "Empty text" });

  const payload: ServerMessage = { type: "lobby", from: senderId, fromName: sender.name, text, ts: Date.now() };

  // Push to shared lobby history
  _pubsub.pushLobbyMessage(payload, _maxHistory);

  // Broadcast to local agents
  broadcastLocal(payload);
  // Broadcast to other instances
  _pubsub.publish({ type: "broadcast", payload });

  recordMessage("lobby");
  console.log(`[center] [lobby] ${sender.name}: ${text.slice(0, 120)}`);
}

async function handleDm(ws: WebSocket, msg: { to: string; text: string }, senderId: string | null) {
  if (!senderId || !localAgents.has(senderId)) return send(ws, { type: "error", message: "Not registered" });
  const sender = localAgents.get(senderId)!;
  if (!msg.to || !msg.text?.trim()) return send(ws, { type: "error", message: "Missing to/text" });

  // Resolve target: try direct id, then search global registry by name
  const targetId = await resolveTarget(msg.to);
  if (!targetId) {
    const allAgents = await _pubsub.listAllAgents();
    const names = allAgents.map((a) => a.id);
    return send(ws, { type: "error", message: `'${msg.to}' not found. Online: ${names.join(", ")}` });
  }

  const payload: ServerMessage = { type: "dm", from: senderId, fromName: sender.name, text: msg.text.trim(), ts: Date.now() };
  recordMessage("dm");

  // Try local delivery first
  const localTarget = localAgents.get(targetId);
  if (localTarget) {
    console.log(`[center] [DM] ${sender.name} → ${localTarget.name}: ${msg.text.trim().slice(0, 120)}`);
    send(localTarget.ws, payload);
  } else {
    // Relay to the instance that owns this agent
    console.log(`[center] [DM] ${sender.name} → ${targetId} (remote): ${msg.text.trim().slice(0, 120)}`);
    _pubsub.publish({ type: "relay", targetId, payload });
  }

  send(ws, { ...payload, echo: true });
}

async function handleFeishu(ws: WebSocket, msg: { chatId: string; text: string; messageId?: string; threadId?: string; mentions?: MentionTarget[] }, senderId: string | null) {
  if (!senderId || !localAgents.has(senderId)) return send(ws, { type: "error", message: "Not registered" });
  const sender = localAgents.get(senderId)!;
  if (!sender.botOpenId) return send(ws, { type: "error", message: "No botOpenId — Feishu relay needs it" });
  if (!msg.chatId || !msg.text) return send(ws, { type: "error", message: "Missing chatId/text" });

  const payload: ServerMessage = {
    type: "feishu", from: senderId, fromName: sender.name, fromBotOpenId: sender.botOpenId,
    chatId: msg.chatId, text: msg.text, messageId: msg.messageId || `relay-${senderId}-${Date.now()}`,
    threadId: msg.threadId, ts: Date.now(),
  };

  // Resolve targets from global registry
  const allAgents = await _pubsub.listAllAgents();
  let targetIds: string[] = [];

  if (Array.isArray(msg.mentions) && msg.mentions.length > 0) {
    for (const m of msg.mentions) {
      const found = allAgents.find(
        (a) => (m.openId && a.botOpenId === m.openId) || (m.name && a.name.toLowerCase() === m.name.trim().toLowerCase()),
      );
      if (found && found.id !== senderId) targetIds.push(found.id);
    }
  } else {
    for (const a of allAgents) {
      if (a.id !== senderId && (a.groups.includes(msg.chatId) || a.groups.length === 0)) {
        targetIds.push(a.id);
      }
    }
  }

  targetIds = [...new Set(targetIds)];
  recordMessage("feishu");

  for (const tid of targetIds) {
    const localTarget = localAgents.get(tid);
    if (localTarget) {
      send(localTarget.ws, payload);
    } else {
      _pubsub.publish({ type: "relay", targetId: tid, payload });
    }
  }

  if (targetIds.length > 0) {
    const targetNames = targetIds.map((tid) => {
      const local = localAgents.get(tid);
      if (local) return local.name;
      return allAgents.find((a) => a.id === tid)?.name ?? tid;
    });
    console.log(`[center] Feishu: ${sender.name} → [${targetNames.join(", ")}] in ${msg.chatId}`);
  }
}

async function handleHistory(ws: WebSocket, senderId: string | null) {
  if (!senderId) return send(ws, { type: "error", message: "Not registered" });
  const history = await _pubsub.getLobbyHistory(50);
  send(ws, { type: "history", messages: history });
}

async function handleWho(ws: WebSocket) {
  const allAgents = await _pubsub.listAllAgents();
  const lobsters: LobsterInfo[] = allAgents.map(presenceToLobsterInfo);
  send(ws, { type: "who", lobsters });
}

async function handleTelemetry(ws: WebSocket, msg: { batch: TelemetryRecord[] }, senderId: string | null) {
  if (!senderId || !localAgents.has(senderId)) return send(ws, { type: "error", message: "Not registered" });
  const sender = localAgents.get(senderId)!;

  if (!Array.isArray(msg.batch) || msg.batch.length === 0) {
    return send(ws, { type: "telemetry_ack", accepted: 0, errors: ["Empty batch"] });
  }

  // Persist to storage
  const { accepted, errors } = await _storage.insertTelemetryBatch(
    sender.name,
    (sender.meta as any)?.agentId,
    (sender.meta as any)?.instanceId,
    msg.batch,
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

/** Resolve a target by lobsterId or agent name using global registry */
async function resolveTarget(to: string): Promise<string | null> {
  // Direct id match — check global registry
  const byId = await _pubsub.getAgent(to);
  if (byId) return to;

  // Name match — search global registry
  const allAgents = await _pubsub.listAllAgents();
  const byName = allAgents.find((a) => a.name.toLowerCase() === to.toLowerCase());
  return byName?.id ?? null;
}

function cleanupLocal(lobsterId: string) {
  localAgents.delete(lobsterId);
}

/** Broadcast to all agents on THIS instance */
function broadcastLocal(payload: ServerMessage, excludeId?: string) {
  for (const [id, info] of localAgents) {
    if (id !== excludeId) send(info.ws, payload);
  }
}

function send(ws: WebSocket, data: ServerMessage) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

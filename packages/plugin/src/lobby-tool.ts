/**
 * Flow-A2A — Lobby Tool Registration
 *
 * Reused from reef/src/openclaw-plugin.ts lobby tool.
 * Actions: who, say, dm, status
 */

import type { RelayClient } from "./relay-client.js";

interface ToolContext {
  client: RelayClient;
  lobsterId: string;
  name: string;
  deliverGroupId: string;
  lobsterFeishuMap: Record<string, { openId?: string; name?: string }>;
  sendToFeishuGroup: (text: string) => Promise<void>;
}

export function registerLobbyTool(api: any, ctx: ToolContext): void {
  api.registerTool((_toolCtx: any) => ({
    name: "lobby",
    label: "Flow-A2A Lobby",
    description: "Chat with other AI agents on the relay. Actions: who (list online), say (broadcast), dm (direct message), status (connection info)",
    parameters: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["who", "say", "dm", "status"], description: "Action to perform" },
        to: { type: "string", description: "Target lobsterId for dm action" },
        text: { type: "string", description: "Message text for say/dm actions" },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: any) {
      const { client, lobsterId, name: agentName, deliverGroupId, lobsterFeishuMap, sendToFeishuGroup } = ctx;
      const result = (data: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

      if (!client.isConnected()) {
        return result({ ok: false, error: "Not connected to relay" });
      }

      switch (params.action) {
        case "who":
          client.requestWho();
          await new Promise(r => setTimeout(r, 500));
          return result({
            ok: true,
            online: (client.onlineLobsters || []).map((l: any) => ({
              id: l.id, name: l.name, meta: l.meta || {}, connectedAt: l.connectedAt,
            }))
          });

        case "say":
          if (!params.text?.trim()) return result({ ok: false, error: "text is required" });
          client.sendLobby(params.text);
          if (deliverGroupId) {
            sendToFeishuGroup(`[a2a] ${agentName}: ${params.text}`).catch(() => {});
          }
          return result({ ok: true, action: "lobby_broadcast", text: params.text });

        case "dm": {
          if (!params.to || !params.text) return result({ ok: false, error: "to and text are required" });
          client.sendDm(params.to, params.text);
          if (deliverGroupId) {
            const targetInfo = lobsterFeishuMap[params.to];
            const targetOpenId = targetInfo?.openId;
            const targetName = targetInfo?.name || params.to;
            const atTarget = targetOpenId
              ? `<at user_id="${targetOpenId}">${targetName}</at>`
              : `@${params.to}`;
            sendToFeishuGroup(`[a2a] ${atTarget} ${params.text}`).catch(() => {});
          }
          return result({ ok: true, action: "dm_sent", to: params.to, text: params.text });
        }

        case "status":
          return result({
            ok: true,
            connected: client.isConnected(),
            online: (client.onlineLobsters || []).map((l: any) => ({
              id: l.id, name: l.name, meta: l.meta || {},
            }))
          });

        default:
          return result({ ok: false, error: `Unknown action: ${params.action}` });
      }
    },
  }), { name: "lobby" });
}

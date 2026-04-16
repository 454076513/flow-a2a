import http from "http";
import type { CenterConfig } from "./config.js";
import { registry } from "./metrics.js";
import type { Storage, CostFilters } from "./storage/index.js";
import { generateRecommendations } from "./recommendations/engine.js";
import { DASHBOARD_HTML } from "./dashboard-html.js";

let server: http.Server | null = null;

export function startHttpServer(config: CenterConfig, storage: Storage): http.Server {
  server = http.createServer(async (req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const params = new URL(req.url ?? "/", `http://localhost:${config.httpPort}`).searchParams;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");

    if (url === "/" || url === "/dashboard") {
      // Inject the WS port so the dashboard JS can connect to the relay
      const html = DASHBOARD_HTML.replace(
        "const WS_PORT = location.port || '9876';",
        `const WS_PORT = '${config.wsPort}';`,
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url === "/metrics") {
      try {
        const metrics = await registry.metrics();
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(metrics);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(String(err));
      }
      return;
    }

    const since = parseInt(params.get("since") || "0", 10) || 0;
    const filters: CostFilters = {
      channel: params.get("channel") || undefined,
      scope: params.get("scope") || undefined,
      user: params.get("user") || undefined,
      agent: params.get("agent") || undefined,
      model: params.get("model") || undefined,
    };

    const routes: Record<string, () => Promise<unknown>> = {
      "/api/health": async () => ({ status: "ok", ts: Date.now() }),
      "/api/summary": () => storage.getSummary(since),
      "/api/agents": () => storage.listAgents(),
      "/api/costs/by-agent": () => storage.getCostsByAgent(since),
      "/api/costs/by-model": () => storage.getCostsByModel(since),
      "/api/costs/by-trigger": () => storage.getCostsByTriggerUser(since, filters),
      "/api/costs/by-channel": () => storage.getCostsByChannel(since),
      "/api/costs/by-conversation": () => storage.getCostsByConversation(since),
      "/api/costs/hourly": () => storage.getHourlySpend(since),
      "/api/costs/yesterday": () => storage.getYesterdaySpend(),
      "/api/costs/trend30": () => storage.getLast30DaysDailySpend(since),
      "/api/costs/by-session": () => storage.getSessionBreakdown(20),
      "/api/costs/by-trigger-type": () => storage.getTriggerBreakdown(since),
      "/api/recommendations": () => generateRecommendations(storage),
    };

    const handler = routes[url];
    if (handler) {
      try {
        const data = await handler();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(config.httpPort, "0.0.0.0", () => {
    console.log(`[center] HTTP API: http://0.0.0.0:${config.httpPort}`);
    console.log(`[center] Dashboard: http://0.0.0.0:${config.httpPort}/dashboard`);
    console.log(`[center] Prometheus: http://0.0.0.0:${config.httpPort}/metrics`);
  });

  return server;
}

export function stopHttpServer(): void {
  server?.close();
  server = null;
}

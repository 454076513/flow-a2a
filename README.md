# Flow-A2A

> Agent-to-Agent Communication & LLM Cost Tracking for [OpenClaw](https://github.com/454076513/openclaw)

Flow-A2A is an OpenClaw plugin + center service combo that unifies **real-time agent communication** (lobby, DM, Feishu bridge) with **LLM cost tracking** (per-user attribution, per-channel breakdown, Prometheus metrics, and a live dashboard).

## Features

- **Agent Lobby** -- Multi-agent WebSocket communication (broadcast, DM, presence)
- **LLM Cost Tracking** -- Automatically captures token usage and computes costs for every LLM call
- **Trigger User Attribution** -- Attributes costs to the user who triggered the call (Feishu @bot, DM, lobby mention)
- **Channel Context** -- Distinguishes channels (feishu/reef/api), scopes (group/p2p/lobby/dm), and conversation IDs
- **Real-time Telemetry** -- Batched telemetry reporting to center service with offline buffering
- **SQLite + Prometheus** -- Persistent storage + standard metrics, ready for Grafana
- **Web Dashboard** -- Built-in dashboard for live cost monitoring, agent status, and chat history
- **PII Redaction** -- 10+ built-in sensitive data redaction rules with custom rule support
- **Feishu Bridge** -- Automatic message forwarding between agents and Feishu groups

## Architecture

```
┌──────────────────────────────────────────────────┐
│              Center Service (Node.js)             │
│                                                   │
│  WebSocket Relay <──> SQLite    HTTP API          │
│  (agent comm +       (costs,    (/api/* + /metrics│
│   telemetry)          agents)    + /dashboard)    │
└────────────┬──────────────────────────────────────┘
             │ ws://center:9876
     ┌───────┼───────┐
     │       │       │
  ┌──┴──┐ ┌─┴──┐ ┌──┴──┐
  │OC #1│ │OC#2│ │OC #N│   <- OpenClaw instances
  │+a2a │ │+a2a│ │+a2a │     each with flow-a2a plugin
  └─────┘ └────┘ └─────┘
```

## Quick Start

### Prerequisites

- Node.js >= 18
- pnpm
- Docker (for center service)

### 1. Build

```bash
pnpm install
pnpm build
```

### 2. Start Center Service

```bash
# Via Docker
docker build -f Dockerfile.center -t flow-a2a-center:local .
docker run -p 9876:9876 -p 3000:3000 -v ./data:/data flow-a2a-center:local

# Or directly
cd packages/center && node dist/index.js
```

### 3. Configure Plugin

Add to your OpenClaw `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "flow-a2a": {
        "enabled": true,
        "config": {
          "relayUrl": "ws://localhost:9876",
          "lobsterId": "my-agent",
          "name": "My Agent",
          "autoReply": true,
          "reportIntervalMs": 10000
        }
      }
    }
  }
}
```

### 4. Access Dashboard

Open `http://localhost:3000/dashboard`

## Monorepo Structure

```
flow-a2a/
├── packages/
│   ├── shared/                  # Shared types and pricing logic
│   │   └── src/
│   │       ├── types.ts         # Protocol types, TelemetryRecord, TriggerUserInfo
│   │       ├── pricing.ts       # MODEL_PRICING table + computeCost()
│   │       └── index.ts         # Re-exports
│   │
│   ├── plugin/                  # OpenClaw plugin
│   │   ├── scripts/prepare.sh   # Build standalone plugin for Docker mount
│   │   └── src/
│   │       ├── index.ts         # register(api) entry, hook registration, config
│   │       ├── relay-client.ts  # WebSocket client with auto-reconnect and heartbeat
│   │       ├── cost-tracker.ts  # Cost calculation, trigger attribution, session mapping
│   │       ├── reporter.ts      # Batched telemetry reporting (10s interval, 10K buffer)
│   │       ├── lobby-tool.ts    # Lobby tool registration (who/say/dm/status)
│   │       └── pii-redact.ts    # PII redaction engine
│   │
│   └── center/                  # Center service
│       ├── Dockerfile           # Multi-stage Docker build
│       ├── test/integration.ts  # In-process integration tests (36 tests)
│       └── src/
│           ├── index.ts         # Entry point
│           ├── config.ts        # Environment variable config
│           ├── ws-server.ts     # WebSocket relay + telemetry receiver
│           ├── http-api.ts      # REST API + dashboard
│           ├── metrics.ts       # Prometheus metric definitions
│           ├── dashboard-html.ts# Embedded SPA dashboard
│           └── storage/
│               ├── db.ts        # SQLite init + migrations
│               └── queries.ts   # Query helpers
│
├── e2e/
│   ├── e2e.sh                   # E2E test: single agent
│   ├── e2e-agents.sh            # E2E test: agent-to-agent @mention
│   └── e2e-multi-user.sh        # E2E test: multi-user trigger attribution
│
├── docker-compose.yml           # Test environment (center + 2 OpenClaw instances)
├── package.json                 # Workspace root
└── pnpm-workspace.yaml
```

## Plugin Configuration

| Field              | Type     | Default                              | Description                                            |
| ------------------ | -------- | ------------------------------------ | ------------------------------------------------------ |
| `relayUrl`         | string   | `$A2A_RELAY_URL`                     | Center WebSocket URL                                   |
| `lobsterId`        | string   | `$A2A_ID`                            | Unique agent identifier                                |
| `name`             | string   | `$A2A_NAME`                          | Agent display name                                     |
| `autoReply`        | boolean  | `true`                               | Auto-spawn agent session on incoming DM                |
| `reportIntervalMs` | number   | `10000`                              | Telemetry report interval (ms)                         |
| `dashboardPort`    | number   | `0`                                  | Local dashboard port (0 = disabled)                    |
| `piiRulesPath`     | string   | `{stateDir}/flow-a2a-pii-rules.json` | Custom PII rules path                                  |
| `botOpenId`        | string   | --                                   | Feishu bot open_id (for relay routing)                 |
| `token`            | string   | --                                   | Relay auth token                                       |
| `groups`           | string[] | `[]`                                 | Feishu group chat_id subscriptions                     |
| `meta`             | object   | `{}`                                 | Custom metadata                                        |
| `deliverGroupId`   | string   | --                                   | Feishu delivery group ID (forward agent messages here) |
| `lobsterFeishuMap` | object   | `{}`                                 | lobsterId -> Feishu openId/name mapping                |

## Center Configuration

| Environment Variable | Default                | Description                             |
| -------------------- | ---------------------- | --------------------------------------- |
| `WS_PORT`            | `9876`                 | WebSocket relay port                    |
| `HTTP_PORT`          | `3000`                 | HTTP API port                           |
| `DB_PATH`            | `./flow-a2a-center.db` | SQLite database path                    |
| `RELAY_TOKEN`        | _(empty)_              | WebSocket auth token (empty = no auth)  |
| `MAX_HISTORY`        | `200`                  | Lobby history message count (in-memory) |

## API Endpoints

| Method | Path                                                 | Description                    |
| ------ | ---------------------------------------------------- | ------------------------------ |
| GET    | `/dashboard`                                         | Web dashboard                  |
| GET    | `/metrics`                                           | Prometheus metrics             |
| GET    | `/api/health`                                        | Health check                   |
| GET    | `/api/summary?since=`                                | Cost summary                   |
| GET    | `/api/agents`                                        | Agent list                     |
| GET    | `/api/costs/by-agent?since=`                         | Cost breakdown by agent        |
| GET    | `/api/costs/by-model?since=`                         | Cost breakdown by model        |
| GET    | `/api/costs/by-trigger?since=&channel=&scope=&user=` | Cost breakdown by trigger user |
| GET    | `/api/costs/by-channel?since=`                       | Cost breakdown by channel      |
| GET    | `/api/costs/by-conversation?since=`                  | Cost breakdown by conversation |

All `/api/costs/*` endpoints accept a `since` parameter (Unix ms timestamp). The `by-trigger` endpoint additionally supports `channel`, `scope`, `user`, `agent`, and `model` filters.

## Docker Deployment

```bash
# Build
pnpm build
pnpm docker:build

# Test environment (Center + 2 OpenClaw agents)
pnpm docker:up

# Access
# Dashboard:  http://localhost:3100/dashboard
# API:        http://localhost:3100/api/summary
# Prometheus: http://localhost:3100/metrics

# Tear down
pnpm docker:down
```

## License

[MIT](LICENSE)

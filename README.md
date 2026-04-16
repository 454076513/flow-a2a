# Flow-A2A

> Agent-to-Agent Communication & LLM Cost Tracking for [OpenClaw](https://github.com/454076513/openclaw)

Flow-A2A is an OpenClaw plugin + center service combo that unifies **real-time agent communication** (lobby, DM, Feishu bridge) with **LLM cost tracking** (per-user attribution, per-channel breakdown, Prometheus metrics, and a live dashboard).

## Features

- **Agent Lobby** -- Multi-agent WebSocket communication (broadcast, DM, presence)
- **LLM Cost Tracking** -- Automatically captures token usage and computes costs for every LLM call
- **Trigger User Attribution** -- Attributes costs to the user who triggered the call (Feishu @bot, DM, lobby mention)
- **Channel Context** -- Distinguishes channels (feishu/reef/api), scopes (group/p2p/lobby/dm), and conversation IDs
- **Real-time Telemetry** -- Batched telemetry reporting to center service with offline buffering
- **SQLite / PostgreSQL** -- Pluggable storage backend, ready for single-instance or cluster
- **Redis Cluster Mode** -- Multi-instance deployment with Redis pub/sub for agent registry and message relay
- **Prometheus Metrics** -- Standard metrics, ready for Grafana
- **Web Dashboard** -- Built-in dashboard for live cost monitoring, agent status, and chat history
- **PII Redaction** -- 10+ built-in sensitive data redaction rules with custom rule support
- **Feishu Bridge** -- Automatic message forwarding between agents and Feishu groups

## Architecture

### Single Instance

```
┌──────────────────────────────────────────────────┐
│              Center Service (Node.js)             │
│                                                   │
│  WebSocket Relay <──> SQLite/PG   HTTP API        │
│  (agent comm +       (costs,      (/api/* +       │
│   telemetry)          agents)      /metrics +     │
│                                    /dashboard)    │
└────────────┬──────────────────────────────────────┘
             │ ws://center:9876
     ┌───────┼───────┐
     │       │       │
  ┌──┴──┐ ┌─┴──┐ ┌──┴──┐
  │OC #1│ │OC#2│ │OC #N│   <- OpenClaw instances
  │+a2a │ │+a2a│ │+a2a │     each with flow-a2a plugin
  └─────┘ └────┘ └─────┘
```

### Cluster Mode (with Redis)

```
                    ┌──────────┐
                    │  Redis   │  pub/sub + agent registry
                    └────┬─────┘  + lobby history
          ┌──────────────┼──────────────┐
          │              │              │
  ┌───────┴───────┐ ┌───┴────────┐ ┌───┴────────┐
  │  Center #1    │ │ Center #2  │ │ Center #N  │
  │  (WS + HTTP)  │ │ (WS + HTTP)│ │ (WS + HTTP)│
  └───────┬───────┘ └───┬────────┘ └───┬────────┘
          │             │              │
      ┌───┴───┐    ┌────┴──┐     ┌────┴──┐
      │ OC #1 │    │ OC #2 │     │ OC #N │
      └───────┘    └───────┘     └───────┘
                        │
                 ┌──────┴──────┐
                 │ PostgreSQL  │  persistent storage
                 └─────────────┘
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
│           ├── storage/
│           │   ├── interface.ts # Storage interface + query types
│           │   ├── index.ts     # Factory: createStorage(config)
│           │   ├── sqlite.ts    # SQLite backend (better-sqlite3)
│           │   └── postgres.ts  # PostgreSQL backend (pg)
│           └── pubsub/
│               ├── interface.ts # PubSub interface + cluster types
│               ├── index.ts     # Factory: createPubSub(config)
│               ├── local.ts     # In-memory (single instance)
│               └── redis.ts     # Redis backend (ioredis)
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

| Environment Variable | Default                | Description                                        |
| -------------------- | ---------------------- | -------------------------------------------------- |
| `WS_PORT`            | `9876`                 | WebSocket relay port                               |
| `HTTP_PORT`          | `3000`                 | HTTP API port                                      |
| `DB_TYPE`            | `sqlite`               | Storage backend: `sqlite` or `postgres`            |
| `DB_PATH`            | `./flow-a2a-center.db` | SQLite database file path (when `DB_TYPE=sqlite`)  |
| `DATABASE_URL`       | _(empty)_              | PostgreSQL connection string (when `DB_TYPE=postgres`) |
| `REDIS_URL`          | _(empty)_              | Redis URL for cluster mode (empty = single-instance) |
| `RELAY_TOKEN`        | _(empty)_              | WebSocket auth token (empty = no auth)             |
| `MAX_HISTORY`        | `200`                  | Lobby history message count                        |

### Deployment Modes

**Single Instance (default)** -- no extra dependencies:

```bash
# SQLite storage, in-process agent registry and lobby history
WS_PORT=9876 HTTP_PORT=3000 node dist/index.js
```

**Single Instance + PostgreSQL** -- use PostgreSQL for persistent storage:

```bash
DB_TYPE=postgres \
DATABASE_URL=postgres://user:pass@localhost:5432/flow_a2a \
node dist/index.js
```

**Cluster Mode** -- multiple center instances with shared state via Redis + PostgreSQL:

```bash
DB_TYPE=postgres \
DATABASE_URL=postgres://user:pass@pg-host:5432/flow_a2a \
REDIS_URL=redis://redis-host:6379 \
node dist/index.js
```

When `REDIS_URL` is set, center uses Redis for:
- **Agent registry** -- all instances share a global agent list (Redis hash)
- **Lobby history** -- shared lobby message history (Redis list)
- **Message relay** -- cross-instance DM/Feishu delivery and broadcast (Redis pub/sub)

This allows agents connected to different center instances to communicate with each other seamlessly.

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

# Test environment (Center + PostgreSQL + Redis + 2 OpenClaw agents)
pnpm docker:up

# Access
# Dashboard:  http://localhost:3100/dashboard
# API:        http://localhost:3100/api/summary
# Prometheus: http://localhost:3100/metrics

# Tear down
pnpm docker:down
```

### docker-compose.yml Services

| Service      | Port          | Description                          |
| ------------ | ------------- | ------------------------------------ |
| `postgres`   | `15432:5432`  | PostgreSQL 16 for persistent storage |
| `redis`      | `16379:6379`  | Redis 7 for cluster state            |
| `center`     | `9876`, `3100`| Center service (WS + HTTP)           |
| `openclaw-1` | `28789`       | OpenClaw agent instance #1           |
| `openclaw-2` | `38789`       | OpenClaw agent instance #2           |

## License

[MIT](LICENSE)

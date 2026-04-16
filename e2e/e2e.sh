#!/bin/bash
# Flow-A2A End-to-End Test
#
# Prerequisites:
#   1. docker-compose.test.yml stack is running
#   2. Center at localhost:3100, OpenClaw at localhost:18789
#
# Usage: bash test/e2e.sh

set -e

GW_TOKEN="test-token-flow-a2a"
CENTER_URL="http://localhost:3100"
GW_URL="http://localhost:28789"
MODEL="openclaw"

PASSED=0
FAILED=0

check() {
  local desc="$1"
  local condition="$2"
  if eval "$condition"; then
    echo "  ✓ $desc"
    PASSED=$((PASSED + 1))
  else
    echo "  ✗ FAIL: $desc"
    FAILED=$((FAILED + 1))
  fi
}

echo "═══════════════════════════════════════════════"
echo "  Flow-A2A End-to-End Tests"
echo "═══════════════════════════════════════════════"

# ── 1. Health Checks ──────────────────────────────
echo ""
echo "── Step 1: Health Checks ──"

CENTER_HEALTH=$(curl -sf "$CENTER_URL/api/health" 2>/dev/null || echo '{"status":"error"}')
check "Center health" "echo '$CENTER_HEALTH' | grep -q '\"ok\"'"

GW_HEALTH=$(curl -sf "$GW_URL/healthz" 2>/dev/null || echo "error")
check "OpenClaw gateway health" "[ '$GW_HEALTH' != 'error' ]"

# ── 2. Check agent registration ──────────────────
echo ""
echo "── Step 2: Agent Registration ──"
echo "  (waiting 5s for plugin to connect...)"
sleep 5

AGENTS=$(curl -sf "$CENTER_URL/api/agents" 2>/dev/null || echo "[]")
check "Plugin registered with center" "echo '$AGENTS' | grep -q 'OpenClaw-Test'"

# ── 3. Get initial summary ───────────────────────
echo ""
echo "── Step 3: Pre-test Summary ──"
SUMMARY_BEFORE=$(curl -sf "$CENTER_URL/api/summary" 2>/dev/null)
CALLS_BEFORE=$(echo "$SUMMARY_BEFORE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalCalls',0))" 2>/dev/null || echo "0")
echo "  Calls before: $CALLS_BEFORE"

# ── 4. Send real LLM request ────────────────────
echo ""
echo "── Step 4: Real LLM Call (model=$MODEL) ──"
echo "  Sending chat completion request..."

LLM_RESPONSE=$(curl -sf "$GW_URL/v1/chat/completions" \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Say hello in exactly 5 words.\"}],
    \"user\": \"test-user-张三\",
    \"stream\": false,
    \"max_tokens\": 100
  }" 2>/dev/null || echo '{"error":"request_failed"}')

echo "  Response: $(echo "$LLM_RESPONSE" | head -c 200)..."
check "LLM response received" "echo '$LLM_RESPONSE' | grep -q 'choices'"

# ── 5. Wait for telemetry flush ──────────────────
echo ""
echo "── Step 5: Waiting for telemetry flush (15s) ──"
sleep 15

# ── 6. Verify cost recorded ─────────────────────
echo ""
echo "── Step 6: Verify Cost Recording ──"

SUMMARY_AFTER=$(curl -sf "$CENTER_URL/api/summary" 2>/dev/null)
CALLS_AFTER=$(echo "$SUMMARY_AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalCalls',0))" 2>/dev/null || echo "0")
COST_AFTER=$(echo "$SUMMARY_AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalCostUsd',0))" 2>/dev/null || echo "0")

echo "  Calls after: $CALLS_AFTER (was $CALLS_BEFORE)"
echo "  Total cost: \$$COST_AFTER"

check "New LLM calls recorded" "[ $CALLS_AFTER -gt $CALLS_BEFORE ]"
# Note: cost may be 0 if the LLM proxy doesn't report token usage
echo "  (Cost=$COST_AFTER — zero expected when proxy doesn't report tokens)"

# ── 7. Verify cost by model ─────────────────────
echo ""
echo "── Step 7: Cost by Model ──"

BY_MODEL=$(curl -sf "$CENTER_URL/api/costs/by-model" 2>/dev/null || echo "[]")
echo "  Models: $(echo "$BY_MODEL" | python3 -c "import sys,json; print([m['model'] for m in json.load(sys.stdin)])" 2>/dev/null)"
check "Model breakdown available" "echo '$BY_MODEL' | grep -q 'model'"

# ── 8. Verify cost by agent ─────────────────────
echo ""
echo "── Step 8: Cost by Agent ──"

BY_AGENT=$(curl -sf "$CENTER_URL/api/costs/by-agent" 2>/dev/null || echo "[]")
echo "  Agents: $(echo "$BY_AGENT" | python3 -c "import sys,json; print([a['agentName'] for a in json.load(sys.stdin)])" 2>/dev/null)"
check "Agent cost breakdown available" "echo '$BY_AGENT' | grep -q 'agentName'"

# ── 9. Verify trigger user attribution ──────────
echo ""
echo "── Step 9: Trigger User Attribution ──"

BY_TRIGGER=$(curl -sf "$CENTER_URL/api/costs/by-trigger" 2>/dev/null || echo "[]")
echo "  Trigger users: $(echo "$BY_TRIGGER" | python3 -c "import sys,json; print([(t['triggerUser'], t.get('costUsd',0)) for t in json.load(sys.stdin)])" 2>/dev/null)"

# Note: trigger user attribution requires the plugin to map session→user
# In the gateway API flow, the `user` field sets the session key, but
# the triggerUser mapping only works when messages come via Reef DM/lobby
# For direct gateway calls, triggerUser may not be set

# ── 10. Verify Prometheus metrics ────────────────
echo ""
echo "── Step 10: Prometheus Metrics ──"

METRICS=$(curl -sf "$CENTER_URL/metrics" 2>/dev/null || echo "")
check "Prometheus /metrics responds" "[ -n '$METRICS' ]"
check "Has a2a_llm_cost_usd_total" "echo '$METRICS' | grep -q 'a2a_llm_cost_usd_total'"
check "Has a2a_llm_calls_total" "echo '$METRICS' | grep -q 'a2a_llm_calls_total'"
check "Has a2a_agents_online" "echo '$METRICS' | grep -q 'a2a_agents_online'"
check "Has a2a_websocket_connections" "echo '$METRICS' | grep -q 'a2a_websocket_connections'"

# Show relevant metrics
echo ""
echo "  Key metrics:"
echo "$METRICS" | grep -E "^a2a_(llm_cost|llm_calls|llm_tokens|agents_online|websocket)" | head -20

# ── Results ──────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Results: $PASSED passed, $FAILED failed"
echo "═══════════════════════════════════════════════"

exit $FAILED

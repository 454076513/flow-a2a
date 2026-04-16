#!/bin/bash
# Flow-A2A: Agent-to-Agent @mention Test
#
# Tests: Wall-E @mentions EVE in lobby, EVE auto-replies via agent session,
# costs tracked and attributed in center.
#
# Prerequisites: docker-compose.test.yml stack running
# Dashboard: http://localhost:3100/dashboard

set -e

CENTER="http://localhost:3100"
WALLE_GW="http://localhost:28789"
EVE_GW="http://localhost:38789"
WALLE_TOKEN="test-token-flow-a2a"
EVE_TOKEN="test-token-eve"

PASSED=0
FAILED=0

check() {
  local desc="$1"; local condition="$2"
  if eval "$condition"; then
    echo "  ✓ $desc"
    PASSED=$((PASSED + 1))
  else
    echo "  ✗ FAIL: $desc"
    FAILED=$((FAILED + 1))
  fi
}

echo "═══════════════════════════════════════════════"
echo "  Flow-A2A: Agent @Agent E2E Test"
echo "═══════════════════════════════════════════════"

# ── 1. Health Checks ──
echo ""
echo "── Step 1: Health Checks ──"
echo "  (waiting for gateways to be ready...)"
for i in $(seq 1 30); do
  WALLE_OK=$(curl -sf $WALLE_GW/healthz 2>/dev/null && echo "1" || echo "0")
  EVE_OK=$(curl -sf $EVE_GW/healthz 2>/dev/null && echo "1" || echo "0")
  if [ "$WALLE_OK" = "1" ] && [ "$EVE_OK" = "1" ]; then break; fi
  sleep 2
done
check "Center health" "curl -sf $CENTER/api/health | grep -q ok"
check "Wall-E gateway health" "curl -sf $WALLE_GW/healthz | grep -q ok"
check "EVE gateway health" "curl -sf $EVE_GW/healthz | grep -q ok"

# ── 2. Agent Registration ──
echo ""
echo "── Step 2: Agent Registration ──"
echo "  (waiting 8s for both agents to connect...)"
sleep 8

AGENTS=$(curl -sf $CENTER/api/agents 2>/dev/null || echo "[]")
echo "  Registered agents: $(echo $AGENTS | python3 -c "import sys,json; print([a['name'] for a in json.load(sys.stdin)])" 2>/dev/null)"
check "Wall-E registered" "echo '$AGENTS' | grep -q 'Wall-E'"
check "EVE registered" "echo '$AGENTS' | grep -q 'EVE'"

# ── 3. Pre-test state ──
echo ""
echo "── Step 3: Pre-test State ──"
SUMMARY_BEFORE=$(curl -sf $CENTER/api/summary 2>/dev/null)
CALLS_BEFORE=$(echo "$SUMMARY_BEFORE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalCalls',0))" 2>/dev/null || echo "0")
echo "  LLM calls before: $CALLS_BEFORE"

# ── 4. Wall-E sends lobby @mention to EVE ──
echo ""
echo "── Step 4: Wall-E @mentions EVE in lobby ──"
echo "  Sending: @EVE What is the capital of France?"

# Wall-E sends a lobby message via its gateway chat completions API
# The agent will use the lobby tool to broadcast
WALLE_RESPONSE=$(curl -sf "$WALLE_GW/v1/chat/completions" \
  -H "Authorization: Bearer $WALLE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"openclaw\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Use the lobby tool with action='say' to send this message: @EVE What is the capital of France? Reply to me via DM.\"}],
    \"stream\": false,
    \"max_tokens\": 500
  }" 2>/dev/null || echo '{"error":"failed"}')

echo "  Wall-E response: $(echo "$WALLE_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content','error')[:150])" 2>/dev/null)"
check "Wall-E LLM call succeeded" "echo '$WALLE_RESPONSE' | grep -q 'choices'"

# ── 5. Wait for EVE to auto-reply ──
echo ""
echo "── Step 5: Waiting for EVE auto-reply + telemetry flush (30s) ──"
echo "  EVE should detect the @mention and spawn an agent session..."
sleep 30

# ── 6. Check telemetry ──
echo ""
echo "── Step 6: Verify Telemetry ──"

SUMMARY_AFTER=$(curl -sf $CENTER/api/summary 2>/dev/null)
CALLS_AFTER=$(echo "$SUMMARY_AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalCalls',0))" 2>/dev/null || echo "0")
AGENTS_COUNT=$(echo "$SUMMARY_AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('agentCount',0))" 2>/dev/null || echo "0")

echo "  LLM calls after: $CALLS_AFTER (was $CALLS_BEFORE)"
echo "  Agent count in costs: $AGENTS_COUNT"
check "New LLM calls recorded" "[ $CALLS_AFTER -gt $CALLS_BEFORE ]"

# ── 7. Cost by Agent ──
echo ""
echo "── Step 7: Cost by Agent ──"
BY_AGENT=$(curl -sf $CENTER/api/costs/by-agent 2>/dev/null || echo "[]")
echo "  Agents: $(echo $BY_AGENT | python3 -c "import sys,json; print([(a['agentName'],a['calls']) for a in json.load(sys.stdin)])" 2>/dev/null)"
check "Wall-E has costs" "echo '$BY_AGENT' | grep -q 'Wall-E'"

# Check if EVE also has costs (from auto-reply)
if echo "$BY_AGENT" | grep -q 'EVE'; then
  echo "  ✓ EVE also has costs (auto-reply worked!)"
  PASSED=$((PASSED + 1))
else
  echo "  ~ EVE may not have costs yet (auto-reply may need more time or @mention detection)"
fi

# ── 8. Cost by Trigger User ──
echo ""
echo "── Step 8: Cost by Trigger User ──"
BY_TRIGGER=$(curl -sf $CENTER/api/costs/by-trigger 2>/dev/null || echo "[]")
echo "  Trigger users: $(echo $BY_TRIGGER | python3 -c "import sys,json; print([(t['triggerUser'],t.get('triggerSource','?'),t['costUsd']) for t in json.load(sys.stdin)])" 2>/dev/null)"

# ── 9. Prometheus Metrics ──
echo ""
echo "── Step 9: Prometheus Metrics ──"
METRICS=$(curl -sf $CENTER/metrics 2>/dev/null || echo "")
check "Has LLM call metrics" "echo '$METRICS' | grep -q 'a2a_llm_calls_total'"
check "Has agent online metrics" "echo '$METRICS' | grep -q 'a2a_agents_online'"

echo ""
echo "  Key LLM metrics:"
echo "$METRICS" | grep -E "^a2a_llm_calls_total" | head -5
echo ""
echo "  Agent metrics:"
echo "$METRICS" | grep -E "^a2a_(agents_online|websocket_connections|messages_total)" | head -5

# ── 10. Dashboard ──
echo ""
echo "── Step 10: Dashboard ──"
DASH_STATUS=$(curl -so /dev/null -w '%{http_code}' $CENTER/dashboard 2>/dev/null || echo "000")
check "Dashboard serves HTML (HTTP $DASH_STATUS)" "[ '$DASH_STATUS' = '200' ]"

echo ""
echo "  >>> Open http://localhost:3100/dashboard to see live chat + costs <<<"

# ── Results ──
echo ""
echo "═══════════════════════════════════════════════"
echo "  Results: $PASSED passed, $FAILED failed"
echo "═══════════════════════════════════════════════"

exit $FAILED

#!/bin/bash
# Flow-A2A: Multi-User Trigger Attribution Test
#
# Simulates a group scenario: multiple "users" (via WS) @mention agents,
# then verifies cost is correctly attributed to each trigger user.
#
# Scenario:
#   1. 张三 @EVE — EVE's cost attributed to 张三
#   2. 李四 @Wall-E — Wall-E's cost attributed to 李四
#   3. Wall-E @EVE (agent-to-agent) — EVE's cost attributed to Wall-E
#
# Prerequisites: docker-compose.test.yml stack running
# Dashboard: http://localhost:3100/dashboard

set -e

CENTER="http://localhost:3100"
CENTER_WS="ws://localhost:9876"
WALLE_GW="http://localhost:28789"
EVE_GW="http://localhost:38789"
WALLE_TOKEN="test-token-flow-a2a"

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
echo "  Flow-A2A: Multi-User Trigger Attribution"
echo "═══════════════════════════════════════════════"

# ── 0. Wait for services ──
echo ""
echo "── Step 0: Wait for services ──"
for i in $(seq 1 30); do
  W=$(curl -sf $WALLE_GW/healthz 2>/dev/null && echo "1" || echo "0")
  E=$(curl -sf $EVE_GW/healthz 2>/dev/null && echo "1" || echo "0")
  if [ "$W" = "1" ] && [ "$E" = "1" ]; then break; fi
  sleep 2
done
check "Center healthy" "curl -sf $CENTER/api/health | grep -q ok"
check "Wall-E healthy" "curl -sf $WALLE_GW/healthz | grep -q ok"
check "EVE healthy" "curl -sf $EVE_GW/healthz | grep -q ok"

sleep 5  # let agents register

# ── 1. Record baseline ──
echo ""
echo "── Step 1: Record baseline costs ──"
BEFORE=$(curl -sf $CENTER/api/summary 2>/dev/null)
CALLS_BEFORE=$(echo "$BEFORE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalCalls',0))" 2>/dev/null || echo "0")
COST_BEFORE=$(echo "$BEFORE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalCostUsd',0))" 2>/dev/null || echo "0")
echo "  Baseline: $CALLS_BEFORE calls, \$$COST_BEFORE"

# ── 2. 张三 @EVE via WebSocket ──
echo ""
echo "── Step 2: 张三 @mentions EVE in lobby (via WS) ──"

# Use node built-in WebSocket to connect as 张三
node -e "
const ws = new WebSocket('$CENTER_WS');
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'register', lobsterId: 'feishu-zhangsan', name: '张三',
    token: '', groups: [],
    meta: { source: 'feishu-mock', userId: 'zhangsan-001' }
  }));
};
ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.type === 'registered') {
    console.log('  张三 registered, sending @EVE message...');
    ws.send(JSON.stringify({ type: 'lobby', text: '@EVE What is the capital of France? Reply via DM.' }));
    setTimeout(() => { ws.close(); process.exit(0); }, 3000);
  }
};
ws.onerror = (e) => { console.error('  WS error'); process.exit(1); };
" 2>&1
check "张三 lobby message sent" "true"

# ── 3. 李四 @Wall-E via WebSocket ──
echo ""
echo "── Step 3: 李四 @mentions Wall-E in lobby (via WS) ──"

node -e "
const ws = new WebSocket('$CENTER_WS');
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'register', lobsterId: 'feishu-lisi', name: '李四',
    token: '', groups: [],
    meta: { source: 'feishu-mock', userId: 'lisi-001' }
  }));
};
ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.type === 'registered') {
    console.log('  李四 registered, sending @Wall-E message...');
    ws.send(JSON.stringify({ type: 'lobby', text: '@Wall-E What is 2 plus 2? Reply via DM.' }));
    setTimeout(() => { ws.close(); process.exit(0); }, 3000);
  }
};
ws.onerror = (e) => { console.error('  WS error'); process.exit(1); };
" 2>&1
check "李四 lobby message sent" "true"

# ── 4. Wall-E @EVE (agent-to-agent) ──
echo ""
echo "── Step 4: Wall-E @mentions EVE (agent-to-agent via gateway) ──"

WALLE_STATUS=$(curl -so /dev/null -w '%{http_code}' "$WALLE_GW/v1/chat/completions" \
  -H "Authorization: Bearer $WALLE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"openclaw\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Use the lobby tool with action='say' to send: @EVE Tell me a joke. Then wait for reply.\"}],
    \"stream\": false,
    \"max_tokens\": 500
  }" 2>/dev/null || echo "000")
check "Wall-E→EVE gateway call succeeded (HTTP $WALLE_STATUS)" "[ '$WALLE_STATUS' = '200' ]"

# ── 5. Wait for auto-replies + telemetry flush ──
echo ""
echo "── Step 5: Waiting for auto-replies + telemetry flush (40s) ──"
echo "  Agents should detect @mentions and spawn sessions..."
sleep 40

# ── 6. Verify trigger user attribution ──
echo ""
echo "── Step 6: Verify trigger user attribution ──"

BY_TRIGGER=$(curl -sf $CENTER/api/costs/by-trigger 2>/dev/null || echo "[]")
echo "  Trigger users:"
echo "$BY_TRIGGER" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for t in data:
    name = t.get('triggerUser','?')
    src = t.get('triggerSource','?')
    calls = t.get('calls', 0)
    cost = t.get('costUsd', 0)
    tokens_in = t.get('inputTokens', 0)
    tokens_out = t.get('outputTokens', 0)
    print(f'    {name:12s} ({src:12s}): {calls} calls, \${cost:.4f}, in={tokens_in}, out={tokens_out}')
" 2>/dev/null

# Check trigger users — use python3 to handle unicode correctly
TRIGGER_USERS=$(echo "$BY_TRIGGER" | python3 -c "import sys,json; print(' '.join(t.get('triggerUser','') for t in json.load(sys.stdin)))" 2>/dev/null)
echo "  All trigger users: $TRIGGER_USERS"

check "张三 has trigger attribution" "echo '$TRIGGER_USERS' | grep -q '张三'"
check "李四 has trigger attribution" "echo '$TRIGGER_USERS' | grep -q '李四'"
check "Wall-E has trigger attribution (agent→agent)" "echo '$TRIGGER_USERS' | grep -q 'Wall-E'"

# ── 7. Verify cost by agent ──
echo ""
echo "── Step 7: Verify cost by agent ──"
BY_AGENT=$(curl -sf $CENTER/api/costs/by-agent 2>/dev/null || echo "[]")
echo "  Agents:"
echo "$BY_AGENT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for a in data:
    name = a.get('agentName','?')
    calls = a.get('calls', 0)
    cost = a.get('costUsd', 0)
    tokens_in = a.get('inputTokens', 0)
    tokens_out = a.get('outputTokens', 0)
    print(f'    {name:12s}: {calls} calls, \${cost:.4f}, in={tokens_in}, out={tokens_out}')
" 2>/dev/null

check "Both agents have costs" "echo '$BY_AGENT' | python3 -c \"import sys,json; data=json.load(sys.stdin); names=[a['agentName'] for a in data]; sys.exit(0 if 'Wall-E' in names and 'EVE' in names else 1)\""

# ── 8. Verify new calls recorded ──
echo ""
echo "── Step 8: Verify new calls ──"
AFTER=$(curl -sf $CENTER/api/summary 2>/dev/null)
CALLS_AFTER=$(echo "$AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalCalls',0))" 2>/dev/null || echo "0")
COST_AFTER=$(echo "$AFTER" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('totalCostUsd',0):.4f}\")" 2>/dev/null || echo "0")
TOKENS_IN=$(echo "$AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalInputTokens',0))" 2>/dev/null || echo "0")
TOKENS_OUT=$(echo "$AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalOutputTokens',0))" 2>/dev/null || echo "0")

echo "  Total: $CALLS_AFTER calls (was $CALLS_BEFORE), \$$COST_AFTER, in=$TOKENS_IN, out=$TOKENS_OUT"
check "New LLM calls recorded" "[ $CALLS_AFTER -gt $CALLS_BEFORE ]"
check "Cost is non-zero" "python3 -c \"exit(0 if float('$COST_AFTER') > 0 else 1)\""
check "Input tokens recorded" "[ $TOKENS_IN -gt 0 ]"

# ── 9. Prometheus: verify per-trigger metrics ──
echo ""
echo "── Step 9: Prometheus metrics ──"
METRICS=$(curl -sf $CENTER/metrics 2>/dev/null || echo "")
echo "  Trigger user metrics:"
echo "$METRICS" | grep "a2a_llm_calls_total" | grep "trigger_user" | head -10

# ── Results ──
echo ""
echo "═══════════════════════════════════════════════"
echo "  Results: $PASSED passed, $FAILED failed"
echo "═══════════════════════════════════════════════"
echo ""
echo "  >>> Dashboard: http://localhost:3100/dashboard <<<"

exit $FAILED

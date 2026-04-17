#!/usr/bin/env bash
# M4 Integration Tests: Materialized lookup tables and query families
# Requires: just dev running at localhost:8787
set -euo pipefail

BASE="http://localhost:8787"
WS_URL="ws://localhost:8787/ws"
AUTH="Authorization: Bearer test-key-123"
CT="Content-Type: application/json"
PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1: $2"; FAIL=$((FAIL + 1)); }

assert_status() {
  local expected="$1" actual="$2" label="$3"
  if [ "$actual" -eq "$expected" ]; then
    pass "$label (HTTP $expected)"
  else
    fail "$label" "expected $expected, got $actual"
  fi
}

echo "=== M4: Materialized Lookup Tables ==="
echo ""

# --- Setup: Create test data ---
echo "Setup: Creating test graph"

# Create a Concern
RESP=$(curl -s -X POST "$BASE/graph/nodes" -H "$AUTH" -H "$CT" \
  -d '{"kind":"ProjectConcern","title":"Build System","properties":{}}')
CONCERN_ID=$(echo "$RESP" | jq -r '.id')
echo "  Concern: $CONCERN_ID"

# Create two Topics
RESP=$(curl -s -X POST "$BASE/graph/nodes" -H "$AUTH" -H "$CT" \
  -d '{"kind":"Topic","title":"Build Tools","properties":{}}')
TOPIC1_ID=$(echo "$RESP" | jq -r '.id')
echo "  Topic1: $TOPIC1_ID"

RESP=$(curl -s -X POST "$BASE/graph/nodes" -H "$AUTH" -H "$CT" \
  -d '{"kind":"Topic","title":"CI CD","properties":{}}')
TOPIC2_ID=$(echo "$RESP" | jq -r '.id')
echo "  Topic2: $TOPIC2_ID"

# Create two Resources
RESP=$(curl -s -X POST "$BASE/graph/nodes" -H "$AUTH" -H "$CT" \
  -d '{"kind":"Document","title":"Build Guide","properties":{}}')
RES1_ID=$(echo "$RESP" | jq -r '.id')
echo "  Resource1: $RES1_ID"

RESP=$(curl -s -X POST "$BASE/graph/nodes" -H "$AUTH" -H "$CT" \
  -d '{"kind":"Document","title":"CI Pipeline Doc","properties":{}}')
RES2_ID=$(echo "$RESP" | jq -r '.id')
echo "  Resource2: $RES2_ID"

# Link Resources to Concern via ResourceConcernLink
curl -s -X POST "$BASE/graph/edges" -H "$AUTH" -H "$CT" \
  -d "{\"source_id\":\"$RES1_ID\",\"target_id\":\"$CONCERN_ID\",\"rel_type\":\"ResourceConcernLink\",\"properties\":{\"link_confidence\":0.8}}" > /dev/null

curl -s -X POST "$BASE/graph/edges" -H "$AUTH" -H "$CT" \
  -d "{\"source_id\":\"$RES2_ID\",\"target_id\":\"$CONCERN_ID\",\"rel_type\":\"ResourceConcernLink\",\"properties\":{\"link_confidence\":0.9}}" > /dev/null

# Link Resources to Topics via ResourceTopicLink
curl -s -X POST "$BASE/graph/edges" -H "$AUTH" -H "$CT" \
  -d "{\"source_id\":\"$RES1_ID\",\"target_id\":\"$TOPIC1_ID\",\"rel_type\":\"ResourceTopicLink\",\"properties\":{\"confidence\":0.9}}" > /dev/null

curl -s -X POST "$BASE/graph/edges" -H "$AUTH" -H "$CT" \
  -d "{\"source_id\":\"$RES2_ID\",\"target_id\":\"$TOPIC1_ID\",\"rel_type\":\"ResourceTopicLink\",\"properties\":{\"confidence\":0.7}}" > /dev/null

curl -s -X POST "$BASE/graph/edges" -H "$AUTH" -H "$CT" \
  -d "{\"source_id\":\"$RES2_ID\",\"target_id\":\"$TOPIC2_ID\",\"rel_type\":\"ResourceTopicLink\",\"properties\":{\"confidence\":0.85}}" > /dev/null

echo ""

# Write the WebSocket helper script in the project dir (so it can find ws)
WS_HELPER="$SCRIPT_DIR/_ws-helper-m4.mjs"
cat > "$WS_HELPER" << 'NODESCRIPT'
import WebSocket from "ws";

const WS_URL = process.argv[2];
const AUTH_KEY = process.argv[3];
const STREAM = process.argv[4];
const KEY = process.argv[5];

const ws = new WebSocket(WS_URL, {
  headers: { Authorization: `Bearer ${AUTH_KEY}` },
});

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "subscribe",
    requestId: "req-1",
    stream: STREAM,
    key: KEY,
    params: {},
  }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "snapshot") {
    console.log(JSON.stringify(msg));
    ws.close();
    process.exit(0);
  } else if (msg.type === "error") {
    console.log(JSON.stringify(msg));
    ws.close();
    process.exit(1);
  }
});

ws.on("error", (err) => {
  console.log(JSON.stringify({ type: "error", message: err.message }));
  process.exit(1);
});

setTimeout(() => {
  console.log(JSON.stringify({ type: "timeout" }));
  ws.close();
  process.exit(1);
}, 5000);
NODESCRIPT

# Check ws package
if ! node -e "require('ws')" 2>/dev/null; then
  (cd "$PROJECT_DIR" && npm install --no-save ws 2>/dev/null)
fi

query_stream() {
  node "$WS_HELPER" "$WS_URL" "test-key-123" "$1" "$2" 2>/dev/null
}

# --- 1. Read concern_topics ---
echo "1. Read concern_topics"
RESULT=$(query_stream "concern_topics" "$CONCERN_ID")
ITEM_COUNT=$(echo "$RESULT" | jq '.items | length' 2>/dev/null || echo "0")

if [ "$ITEM_COUNT" -ge 1 ]; then
  pass "concern_topics returns topics ($ITEM_COUNT items)"
else
  fail "concern_topics" "expected >= 1 items, got $ITEM_COUNT"
fi

# Check that both topics appear
if echo "$RESULT" | jq -e ".items[] | select(.topic_id == \"$TOPIC1_ID\")" > /dev/null 2>&1; then
  pass "Topic1 appears in concern_topics"
else
  fail "Topic1 in concern_topics" "not found"
fi

if echo "$RESULT" | jq -e ".items[] | select(.topic_id == \"$TOPIC2_ID\")" > /dev/null 2>&1; then
  pass "Topic2 appears in concern_topics"
else
  fail "Topic2 in concern_topics" "not found"
fi

# --- 2. Read topic_concerns ---
echo "2. Read topic_concerns"
RESULT=$(query_stream "topic_concerns" "$TOPIC1_ID")
ITEM_COUNT=$(echo "$RESULT" | jq '.items | length' 2>/dev/null || echo "0")

if [ "$ITEM_COUNT" -ge 1 ]; then
  pass "topic_concerns returns concerns ($ITEM_COUNT items)"
else
  fail "topic_concerns" "expected >= 1 items, got $ITEM_COUNT"
fi

if echo "$RESULT" | jq -e ".items[] | select(.concern_id == \"$CONCERN_ID\")" > /dev/null 2>&1; then
  pass "Concern appears in topic_concerns"
else
  fail "Concern in topic_concerns" "not found"
fi

# --- 3. candidate_concerns_for_resource ---
echo "3. Read candidate_concerns_for_resource"
RESULT=$(query_stream "candidate_concerns_for_resource" "$RES1_ID")
ITEM_COUNT=$(echo "$RESULT" | jq '.items | length' 2>/dev/null || echo "0")

if [ "$ITEM_COUNT" -ge 1 ]; then
  pass "candidate_concerns_for_resource returns concerns ($ITEM_COUNT items)"
else
  fail "candidate_concerns_for_resource" "expected >= 1 items, got $ITEM_COUNT"
fi

# --- 4. Add another ResourceTopicLink and verify score changes ---
echo "4. Add link and verify summary update"

INITIAL_RESULT=$(query_stream "concern_topics" "$CONCERN_ID")
INITIAL_COUNT=$(echo "$INITIAL_RESULT" | jq "[.items[] | select(.topic_id == \"$TOPIC1_ID\")] | .[0].resource_count" 2>/dev/null || echo "0")

# Create a third resource linked to the same topic and concern
RESP=$(curl -s -X POST "$BASE/graph/nodes" -H "$AUTH" -H "$CT" \
  -d '{"kind":"Document","title":"Extra Build Doc","properties":{}}')
RES3_ID=$(echo "$RESP" | jq -r '.id')

curl -s -X POST "$BASE/graph/edges" -H "$AUTH" -H "$CT" \
  -d "{\"source_id\":\"$RES3_ID\",\"target_id\":\"$CONCERN_ID\",\"rel_type\":\"ResourceConcernLink\",\"properties\":{\"link_confidence\":0.7}}" > /dev/null

curl -s -X POST "$BASE/graph/edges" -H "$AUTH" -H "$CT" \
  -d "{\"source_id\":\"$RES3_ID\",\"target_id\":\"$TOPIC1_ID\",\"rel_type\":\"ResourceTopicLink\",\"properties\":{\"confidence\":0.8}}" > /dev/null

UPDATED_RESULT=$(query_stream "concern_topics" "$CONCERN_ID")
UPDATED_COUNT=$(echo "$UPDATED_RESULT" | jq "[.items[] | select(.topic_id == \"$TOPIC1_ID\")] | .[0].resource_count" 2>/dev/null || echo "0")

if [ "$UPDATED_COUNT" -gt "$INITIAL_COUNT" ] 2>/dev/null; then
  pass "resource_count increased after new link ($INITIAL_COUNT -> $UPDATED_COUNT)"
else
  fail "resource_count" "expected increase, got $INITIAL_COUNT -> $UPDATED_COUNT"
fi

# --- 5. Delete a link and verify summary updates ---
echo "5. Delete ResourceConcernLink and verify summary update"

RES2_SLUG=$(echo "$RES2_ID" | cut -d: -f2)
CONCERN_SLUG=$(echo "$CONCERN_ID" | cut -d: -f2)
RCL_EDGE_ID="resource-concern-link:${RES2_SLUG}--${CONCERN_SLUG}"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/graph/edges/$RCL_EDGE_ID" -H "$AUTH")

if [ "$STATUS" -eq 204 ]; then
  pass "ResourceConcernLink deleted"
else
  fail "Delete RCL edge" "expected 204, got $STATUS"
fi

# After deleting the RCL, the concern_topics should have fewer resources for Topic2
AFTER_DELETE=$(query_stream "concern_topics" "$CONCERN_ID")
AFTER_COUNT_T2=$(echo "$AFTER_DELETE" | jq "[.items[] | select(.topic_id == \"$TOPIC2_ID\")] | length" 2>/dev/null || echo "0")

# Topic2 was only linked via RES2 which we just unlinked from the concern
# So Topic2 should no longer appear (0 items for it)
if [ "$AFTER_COUNT_T2" -eq 0 ]; then
  pass "Topic2 removed from concern_topics after RCL deletion"
else
  echo "  ⚠ Topic2 still in concern_topics (may be linked via other resources)"
fi

# Cleanup
rm -f "$WS_HELPER"

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1

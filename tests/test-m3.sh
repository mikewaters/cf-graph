#!/usr/bin/env bash
# M3 Integration Tests: WebSocket subscriptions with hibernation
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

echo "=== M3: WebSocket Subscriptions ==="
echo ""

# Create a test node first
echo "Setup: Creating test node"
curl -s -X POST "$BASE/graph/nodes" -H "$AUTH" -H "$CT" \
  -d '{"kind":"Topic","title":"WS Test Topic","properties":{"info":"initial"}}' > /dev/null 2>&1 || true

# Write the Node.js helper script inside the project (so it can find ws)
WS_HELPER="$SCRIPT_DIR/_ws-helper.mjs"
cat > "$WS_HELPER" << 'NODESCRIPT'
import WebSocket from "ws";

const WS_URL = process.argv[2];
const AUTH_KEY = process.argv[3];
const TEST = process.argv[4];

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${AUTH_KEY}` },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Connection timeout")), 5000);
  });
}

function waitForMessage(ws, timeout = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function runTest() {
  switch (TEST) {
    case "subscribe": {
      const ws = await connect();
      ws.send(JSON.stringify({
        type: "subscribe",
        requestId: "req-1",
        stream: "get_node",
        key: "topic:ws-test-topic",
        params: {},
      }));
      const msg = await waitForMessage(ws);
      ws.close();
      if (msg && msg.type === "snapshot" && msg.stream === "get_node") {
        console.log(JSON.stringify({ ok: true, msg }));
      } else {
        console.log(JSON.stringify({ ok: false, msg }));
      }
      break;
    }

    case "fanout": {
      const ws = await connect();
      ws.send(JSON.stringify({
        type: "subscribe",
        requestId: "req-1",
        stream: "get_node",
        key: "topic:ws-test-topic",
        params: {},
      }));
      const initial = await waitForMessage(ws);
      if (!initial || initial.type !== "snapshot") {
        console.log(JSON.stringify({ ok: false, error: "no initial snapshot" }));
        ws.close();
        break;
      }

      // Signal ready for mutation
      console.error("READY_FOR_MUTATION");

      // Wait for fan-out snapshot
      const fanout = await waitForMessage(ws, 5000);
      ws.close();
      if (fanout && fanout.type === "snapshot") {
        console.log(JSON.stringify({ ok: true, msg: fanout }));
      } else {
        console.log(JSON.stringify({ ok: false, error: "no fanout snapshot" }));
      }
      break;
    }

    case "unsubscribe": {
      const ws = await connect();
      ws.send(JSON.stringify({
        type: "subscribe",
        requestId: "req-1",
        stream: "get_node",
        key: "topic:ws-test-topic",
        params: {},
      }));
      await waitForMessage(ws); // initial snapshot

      ws.send(JSON.stringify({
        type: "unsubscribe",
        requestId: "req-2",
        stream: "get_node",
        key: "topic:ws-test-topic",
      }));

      await new Promise(r => setTimeout(r, 200));
      console.error("READY_FOR_MUTATION");

      // Should NOT receive a snapshot
      const msg = await waitForMessage(ws, 2000);
      ws.close();
      console.log(JSON.stringify({ ok: msg === null, msg }));
      break;
    }

    case "ping": {
      const ws = await connect();
      ws.send(JSON.stringify({ type: "ping" }));
      const msg = await waitForMessage(ws);
      ws.close();
      console.log(JSON.stringify({ ok: msg && msg.type === "pong", msg }));
      break;
    }

    case "unknown_stream": {
      const ws = await connect();
      ws.send(JSON.stringify({
        type: "subscribe",
        requestId: "req-err",
        stream: "nonexistent_stream",
        key: "whatever",
        params: {},
      }));
      const msg = await waitForMessage(ws);
      ws.close();
      console.log(JSON.stringify({
        ok: msg && msg.type === "error" && msg.code === "unknown_stream",
        msg,
      }));
      break;
    }

    default:
      console.log(JSON.stringify({ ok: false, error: "Unknown test: " + TEST }));
  }
}

runTest().then(() => process.exit(0)).catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
NODESCRIPT

# Check if ws package is available
if ! node -e "require('ws')" 2>/dev/null; then
  echo "Installing ws package for WebSocket tests..."
  (cd "$PROJECT_DIR" && npm install --no-save ws 2>/dev/null)
fi

run_ws_test() {
  node "$WS_HELPER" "$WS_URL" "test-key-123" "$1" 2>/dev/null
}

# --- 1. Subscribe and receive snapshot ---
echo "1. Subscribe to get_node"
RESULT=$(run_ws_test "subscribe")
if echo "$RESULT" | jq -e '.ok == true' > /dev/null 2>&1; then
  pass "Subscribe returns snapshot"
else
  fail "Subscribe" "$(echo "$RESULT" | jq -r '.error // .msg // "unknown error"')"
fi

# --- 2. Mutation fan-out ---
echo "2. Mutation fan-out"
node "$WS_HELPER" "$WS_URL" "test-key-123" "fanout" > /tmp/fanout-result.json 2>/tmp/fanout-stderr.txt &
WS_PID=$!

for i in $(seq 1 20); do
  if grep -q "READY_FOR_MUTATION" /tmp/fanout-stderr.txt 2>/dev/null; then
    break
  fi
  sleep 0.25
done

curl -s -X PATCH "$BASE/graph/nodes/topic:ws-test-topic" \
  -H "$AUTH" -H "$CT" \
  -d '{"properties":{"info":"mutated"}}' > /dev/null

wait $WS_PID 2>/dev/null || true
RESULT=$(cat /tmp/fanout-result.json 2>/dev/null || echo '{"ok":false}')

if echo "$RESULT" | jq -e '.ok == true' > /dev/null 2>&1; then
  pass "Fan-out snapshot received after mutation"
else
  fail "Fan-out" "$(echo "$RESULT" | jq -r '.error // "no snapshot received"')"
fi

# --- 3. Ping/pong ---
echo "3. Ping/pong"
RESULT=$(run_ws_test "ping")
if echo "$RESULT" | jq -e '.ok == true' > /dev/null 2>&1; then
  pass "Ping returns pong"
else
  fail "Ping/pong" "$(echo "$RESULT" | jq -r '.error // "no pong"')"
fi

# --- 4. Unknown stream ---
echo "4. Unknown stream"
RESULT=$(run_ws_test "unknown_stream")
if echo "$RESULT" | jq -e '.ok == true' > /dev/null 2>&1; then
  pass "Unknown stream returns error with unknown_stream code"
else
  fail "Unknown stream" "$(echo "$RESULT" | jq -r '.error // .msg // "wrong response"')"
fi

# --- 5. Unsubscribe ---
echo "5. Unsubscribe"
node "$WS_HELPER" "$WS_URL" "test-key-123" "unsubscribe" > /tmp/unsub-result.json 2>/tmp/unsub-stderr.txt &
WS_PID=$!

for i in $(seq 1 20); do
  if grep -q "READY_FOR_MUTATION" /tmp/unsub-stderr.txt 2>/dev/null; then
    break
  fi
  sleep 0.25
done

curl -s -X PATCH "$BASE/graph/nodes/topic:ws-test-topic" \
  -H "$AUTH" -H "$CT" \
  -d '{"properties":{"info":"after-unsub"}}' > /dev/null

wait $WS_PID 2>/dev/null || true
RESULT=$(cat /tmp/unsub-result.json 2>/dev/null || echo '{"ok":false}')

if echo "$RESULT" | jq -e '.ok == true' > /dev/null 2>&1; then
  pass "No snapshot after unsubscribe"
else
  fail "Unsubscribe" "received unexpected snapshot after unsubscribe"
fi

# Cleanup
rm -f "$WS_HELPER" /tmp/fanout-result.json /tmp/fanout-stderr.txt /tmp/unsub-result.json /tmp/unsub-stderr.txt

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1

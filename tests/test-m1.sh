#!/usr/bin/env bash
# M1 Integration Tests: CRUD mutations + R2 file proxy
# Requires: just dev running at localhost:8787
set -euo pipefail

BASE="http://localhost:8787"
AUTH="Authorization: Bearer test-key-123"
CT="Content-Type: application/json"
PASS=0
FAIL=0

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

echo "=== M1: CRUD Mutations + File Proxy ==="
echo ""

# --- 1. Health check ---
echo "1. Health check"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
assert_status 200 "$STATUS" "GET /health"

# --- 2. Auth rejection ---
echo "2. Auth rejection"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/graph/nodes")
assert_status 401 "$STATUS" "Request without auth"

# --- 3. Create node ---
echo "3. Create node"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/graph/nodes" \
  -H "$AUTH" -H "$CT" \
  -d '{"kind":"Topic","title":"Machine Learning","properties":{"slug":"machine-learning"}}')
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 201 "$STATUS" "POST /graph/nodes"

NODE_ID=$(echo "$BODY" | jq -r '.id')
if [ "$NODE_ID" = "topic:machine-learning" ]; then
  pass "ID is topic:machine-learning"
else
  fail "ID check" "got $NODE_ID"
fi

if echo "$BODY" | jq -e '.kind == "Topic"' > /dev/null 2>&1; then
  pass "kind is Topic"
else
  fail "kind check" "$(echo "$BODY" | jq -r '.kind')"
fi

if echo "$BODY" | jq -e '.created_at' > /dev/null 2>&1; then
  pass "has created_at"
else
  fail "created_at" "missing"
fi

# --- 4. Create node (duplicate title) ---
echo "4. Create node (duplicate title)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/graph/nodes" \
  -H "$AUTH" -H "$CT" \
  -d '{"kind":"Topic","title":"Machine Learning","properties":{}}')
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 201 "$STATUS" "POST /graph/nodes (dup)"

DUP_ID=$(echo "$BODY" | jq -r '.id')
if [ "$DUP_ID" = "topic:machine-learning-2" ]; then
  pass "Duplicate ID is topic:machine-learning-2"
else
  fail "Duplicate ID" "got $DUP_ID"
fi

# --- 5. Create node (no title) ---
echo "5. Create node (no title)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/graph/nodes" \
  -H "$AUTH" -H "$CT" \
  -d '{"kind":"Note","properties":{}}')
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 201 "$STATUS" "POST /graph/nodes (no title)"

ULID_ID=$(echo "$BODY" | jq -r '.id')
if [[ "$ULID_ID" == note:* ]]; then
  pass "ID starts with note:"
else
  fail "ULID ID" "got $ULID_ID"
fi

# --- 6. Read node ---
echo "6. Read node"
RESP=$(curl -s -w "\n%{http_code}" "$BASE/graph/nodes/topic:machine-learning" \
  -H "$AUTH")
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 200 "$STATUS" "GET /graph/nodes/:id"

if echo "$BODY" | jq -e '.id == "topic:machine-learning"' > /dev/null 2>&1; then
  pass "Read returns correct node"
else
  fail "Read node" "wrong id"
fi

# --- 7. Read node (not found) ---
echo "7. Read node (not found)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/graph/nodes/topic:nonexistent" \
  -H "$AUTH")
assert_status 404 "$STATUS" "GET /graph/nodes/:id (404)"

# --- 8. Update node ---
echo "8. Update node"
RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/graph/nodes/topic:machine-learning" \
  -H "$AUTH" -H "$CT" \
  -d '{"properties":{"description":"ML stuff"}}')
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 200 "$STATUS" "PATCH /graph/nodes/:id"

if echo "$BODY" | jq -e '.properties.description == "ML stuff"' > /dev/null 2>&1; then
  pass "description updated"
else
  fail "Update properties" "description not set"
fi

if echo "$BODY" | jq -e '.properties.slug == "machine-learning"' > /dev/null 2>&1; then
  pass "original slug preserved"
else
  fail "Original property preserved" "slug missing"
fi

# --- 9. Delete node (cascade) ---
echo "9. Delete node (cascade)"
# Create a temp node and edge
curl -s -X POST "$BASE/graph/nodes" -H "$AUTH" -H "$CT" \
  -d '{"kind":"Document","title":"Temp Doc","properties":{}}' > /dev/null

curl -s -X POST "$BASE/graph/edges" -H "$AUTH" -H "$CT" \
  -d '{"source_id":"document:temp-doc","target_id":"topic:machine-learning","rel_type":"ResourceTopicLink","properties":{}}' > /dev/null

# Get the edge ID
EDGE_RESP=$(curl -s "$BASE/graph/nodes/document:temp-doc" -H "$AUTH")

# Delete the node
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/graph/nodes/document:temp-doc" \
  -H "$AUTH")
assert_status 204 "$STATUS" "DELETE /graph/nodes/:id"

# Verify the edge is gone
EDGE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/graph/edges/resource-topic-link:temp-doc--machine-learning" \
  -H "$AUTH")
assert_status 404 "$EDGE_STATUS" "Cascade-deleted edge"

# --- 10. Create edge ---
echo "10. Create edge"
# Create a target node first
curl -s -X POST "$BASE/graph/nodes" -H "$AUTH" -H "$CT" \
  -d '{"kind":"Document","title":"Test Doc","properties":{}}' > /dev/null

RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/graph/edges" \
  -H "$AUTH" -H "$CT" \
  -d '{"source_id":"document:test-doc","target_id":"topic:machine-learning","rel_type":"ResourceTopicLink","properties":{"confidence":0.9}}')
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 201 "$STATUS" "POST /graph/edges"

EDGE_ID=$(echo "$BODY" | jq -r '.id')
if [[ -n "$EDGE_ID" && "$EDGE_ID" != "null" ]]; then
  pass "Edge has generated ID: $EDGE_ID"
else
  fail "Edge ID" "missing"
fi

# --- 11. Create edge (missing target) ---
echo "11. Create edge (missing target)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/graph/edges" \
  -H "$AUTH" -H "$CT" \
  -d '{"source_id":"document:test-doc","target_id":"topic:nonexistent","rel_type":"ResourceTopicLink","properties":{}}')
assert_status 400 "$STATUS" "POST /graph/edges (missing target)"

# --- 12. Read edge ---
echo "12. Read edge"
RESP=$(curl -s -w "\n%{http_code}" "$BASE/graph/edges/$EDGE_ID" \
  -H "$AUTH")
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 200 "$STATUS" "GET /graph/edges/:id"

# --- 13. Update edge ---
echo "13. Update edge"
RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/graph/edges/$EDGE_ID" \
  -H "$AUTH" -H "$CT" \
  -d '{"properties":{"confidence":0.95,"role":"primary"}}')
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 200 "$STATUS" "PATCH /graph/edges/:id"

if echo "$BODY" | jq -e '.properties.confidence == 0.95' > /dev/null 2>&1; then
  pass "Edge confidence updated"
else
  fail "Edge update" "confidence not set"
fi

# --- 14. Delete edge ---
echo "14. Delete edge"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/graph/edges/$EDGE_ID" \
  -H "$AUTH")
assert_status 204 "$STATUS" "DELETE /graph/edges/:id"

# Verify it's gone
GONE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/graph/edges/$EDGE_ID" \
  -H "$AUTH")
assert_status 404 "$GONE_STATUS" "Edge deleted"

# --- 15. R2 file proxy ---
echo "15. R2 file proxy"

# PUT
RESP=$(curl -s -w "\n%{http_code}" -X PUT "$BASE/files/test/hello.txt" \
  -H "$AUTH" -H "Content-Type: text/plain" \
  -d "hello world")
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 200 "$STATUS" "PUT /files/test/hello.txt"

if echo "$BODY" | jq -e '.key == "test/hello.txt"' > /dev/null 2>&1; then
  pass "File upload response has key"
else
  fail "File upload key" "missing"
fi

# GET
RESP=$(curl -s -w "\n%{http_code}" "$BASE/files/test/hello.txt" -H "$AUTH")
BODY=$(echo "$RESP" | head -n -1)
STATUS=$(echo "$RESP" | tail -n 1)
assert_status 200 "$STATUS" "GET /files/test/hello.txt"

if [ "$BODY" = "hello world" ]; then
  pass "File content matches"
else
  fail "File content" "got '$BODY'"
fi

# DELETE
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/files/test/hello.txt" -H "$AUTH")
assert_status 204 "$STATUS" "DELETE /files/test/hello.txt"

# GET after delete
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/files/test/hello.txt" -H "$AUTH")
assert_status 404 "$STATUS" "GET /files/test/hello.txt (after delete)"

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1

# PRD: Graph Store Platform Implementation

This document specifies the implementation work required to bring the cf-graph platform from its current stub state to a working system that satisfies the use cases in [USE_CASES.md](./USE_CASES.md).

## Current State

- **Worker** (`src/index.ts`): Routes requests, authenticates via Bearer token, stubs presigned URL generation.
- **GraphDO** (`src/graph-do.ts`): Accepts WebSocket upgrades, stubs mutation routing and subscription handling.
- **Migrations** (`src/migrations.ts`): Framework works. Migration #1 creates `nodes` and `edges` tables with basic indexes.
- **Schema**: LinkML schema transformed into `graph-manifest.json` with 49 node types, 13 concrete edge types, 32 enums.

## Scope

This PRD covers four implementation milestones, designed to be built in order:

1. **M1: CRUD mutations with URI generation**
2. **M2: Batch operations and topic tree management**
3. **M3: WebSocket subscriptions with hibernation**
4. **M4: Materialized lookup tables and query families**

---

## M1: CRUD Mutations with URI Generation

### Goal

A client can create, read, update, and delete nodes and edges over HTTP. The server assigns URIs to new entities.

### URI Scheme

All entity IDs are CURIEs of the form `<kind>:<slug>`:

- `kind` is the lowercased, hyphenated class name (e.g., `project-concern`, `document`, `topic-taxonomy`)
- `slug` is derived from the entity's `title` property, slugified (lowercase, hyphens for spaces, stripped of special characters)
- Duplicate protection: if `<kind>:<slug>` already exists, append `-2`, `-3`, etc.
- If no `title` is provided, fall back to a ULID

Examples:
- `document:quarterly-review-q2-2026`
- `topic:machine-learning`
- `project-concern:website-redesign`
- `note:xk4f9a2b` (no title, ULID fallback)

### Implementation: `src/uri.ts` (new file)

```
function slugify(title: string): string
function generateId(sql: SqlStorage, kind: string, title?: string): string
```

`generateId` logic:
1. Convert `kind` from PascalCase to kebab-case.
2. If `title` is provided, slugify it (truncate to 80 chars).
3. Query `SELECT id FROM nodes WHERE id = ?` to check existence.
4. If collision, try `<kind>:<slug>-2`, `<kind>:<slug>-3`, etc. (cap at 100 attempts).
5. If no `title`, generate a ULID (use a small inline implementation — no npm dependency).

### Implementation: `src/graph-do.ts` — mutation routing

The `handleGraphRequest` method parses the URL and delegates:

| Method | Path | Handler | Response |
|--------|------|---------|----------|
| `POST` | `/graph/nodes` | `createNode(body)` | 201 + node |
| `GET` | `/graph/nodes/:id` | `getNode(id)` | 200 + node |
| `PATCH` | `/graph/nodes/:id` | `updateNode(id, body)` | 200 + node |
| `DELETE` | `/graph/nodes/:id` | `deleteNode(id)` | 204 |
| `POST` | `/graph/edges` | `createEdge(body)` | 201 + edge |
| `GET` | `/graph/edges/:id` | `getEdge(id)` | 200 + edge |
| `PATCH` | `/graph/edges/:id` | `updateEdge(id, body)` | 200 + edge |
| `DELETE` | `/graph/edges/:id` | `deleteEdge(id)` | 204 |

#### Node CRUD

**Create node** (`POST /graph/nodes`):

Request body:
```json
{
  "kind": "Document",
  "title": "Quarterly Review",
  "properties": { "format": "pdf", "media_type": "application/pdf" }
}
```

Processing:
1. Validate `kind` is present.
2. Call `generateId(sql, kind, title)` to produce the CURIE.
3. `INSERT INTO nodes (id, kind, properties, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))`.
4. Return the full row as JSON.

Response:
```json
{
  "id": "document:quarterly-review",
  "kind": "Document",
  "properties": { "format": "pdf", "media_type": "application/pdf" },
  "created_at": "2026-04-15T12:00:00",
  "updated_at": "2026-04-15T12:00:00"
}
```

**Read node** (`GET /graph/nodes/:id`):

The `:id` is the full CURIE, URL-encoded. `SELECT * FROM nodes WHERE id = ?`. Return 404 if not found.

**Update node** (`PATCH /graph/nodes/:id`):

Request body: `{ "properties": { ... } }`. Merges into existing properties (shallow merge — top-level keys in the patch overwrite, keys not in the patch are preserved). Updates `updated_at`.

```sql
UPDATE nodes
SET properties = json_patch(properties, ?),
    updated_at = datetime('now')
WHERE id = ?
```

**Delete node** (`DELETE /graph/nodes/:id`):

Cascade-deletes edges where `source_id = ?` or `target_id = ?`, then deletes the node. All in one transaction.

```sql
DELETE FROM edges WHERE source_id = ? OR target_id = ?;
DELETE FROM nodes WHERE id = ?;
```

Return 204. Return 204 even if the node didn't exist (idempotent delete).

#### Edge CRUD

**Create edge** (`POST /graph/edges`):

Request body:
```json
{
  "source_id": "document:quarterly-review",
  "target_id": "topic:machine-learning",
  "rel_type": "ResourceTopicLink",
  "properties": { "confidence": 0.9, "role": "primary" }
}
```

Processing:
1. Validate `source_id`, `target_id`, `rel_type` are present.
2. Verify both source and target nodes exist (SELECT). Return 400 if not.
3. Generate edge ID: `<rel_type_kebab>:<source_slug>--<target_slug>` (e.g., `resource-topic-link:quarterly-review--machine-learning`). Duplicate protection same as nodes.
4. INSERT and return.

**Read edge** (`GET /graph/edges/:id`): Direct PK lookup.

**Update edge** (`PATCH /graph/edges/:id`): Same shallow-merge pattern as nodes.

**Delete edge** (`DELETE /graph/edges/:id`): Simple DELETE, return 204.

#### Error handling

All errors return `{ "error": "message" }` with appropriate status codes. No stack traces.

- 400: missing required fields, referential integrity violations
- 404: entity not found (for GET/PATCH)
- 409: ID collision after max attempts (unlikely)

---

## M2: Batch Operations and Topic Tree Management

### Goal

A client can atomically create a taxonomy with a tree of topics in a single request. The server maintains `TopicEdge` (parent-child) and `TopicClosure` (ancestor-descendant with depth) edges automatically.

### Batch Endpoint

`POST /graph/batch`

Request body:
```json
{
  "nodes": [
    { "kind": "TopicTaxonomy", "title": "Engineering Topics", "properties": { ... } },
    { "kind": "Topic", "title": "Machine Learning", "properties": { "slug": "machine-learning" } },
    { "kind": "Topic", "title": "Deep Learning", "properties": { "slug": "deep-learning" } }
  ],
  "edges": [
    { "source_id": "$0", "target_id": "$1", "rel_type": "TopicEdge", "properties": { "edge_role": "taxonomy_root" } },
    { "source_id": "$1", "target_id": "$2", "rel_type": "TopicEdge" }
  ]
}
```

**Back-references**: Edges can reference nodes created in the same batch using `$N` where N is the 0-based index into the `nodes` array. The server resolves these to the generated IDs after node creation.

Processing (all within a single SQLite transaction):
1. Create all nodes in order, collecting generated IDs.
2. Resolve `$N` references in edges to actual IDs.
3. Create all edges.
4. If any step fails, the transaction rolls back entirely.

Response: `201 Created`
```json
{
  "nodes": [ { "id": "topic-taxonomy:engineering-topics", ... }, ... ],
  "edges": [ { "id": "topic-edge:engineering-topics--machine-learning", ... }, ... ]
}
```

### Topic Closure Maintenance

When a `TopicEdge` (parent→child) is created, the system must maintain the `TopicClosure` table — a set of edges with `rel_type = "TopicClosure"` that encode transitive ancestor-descendant relationships with a `depth` property.

**On TopicEdge creation** (parent P → child C):

```sql
-- Self-closure for C (if not already present)
INSERT OR IGNORE INTO edges (id, source_id, target_id, rel_type, properties, created_at, updated_at)
VALUES (?, C, C, 'TopicClosure', '{"depth":0}', datetime('now'), datetime('now'));

-- All ancestors of P are also ancestors of C
INSERT OR IGNORE INTO edges (id, source_id, target_id, rel_type, properties, created_at, updated_at)
SELECT
  ? || '-' || rowid,
  source_id,
  C,
  'TopicClosure',
  json_object('depth', json_extract(properties, '$.depth') + 1),
  datetime('now'),
  datetime('now')
FROM edges
WHERE target_id = P AND rel_type = 'TopicClosure';
```

**On TopicEdge deletion** (parent P → child C):

Remove all closure edges where `source_id` is an ancestor of P (or P itself) and `target_id` is C or a descendant of C. This requires a subtree enumeration:

```sql
-- Find all descendants of C (inclusive) via closure
-- Delete closure edges from ancestors-of-P to descendants-of-C
DELETE FROM edges
WHERE rel_type = 'TopicClosure'
  AND source_id IN (SELECT source_id FROM edges WHERE target_id = P AND rel_type = 'TopicClosure')
  AND target_id IN (SELECT target_id FROM edges WHERE source_id = C AND rel_type = 'TopicClosure');
```

Then re-derive closure for any remaining parents of C's descendants if they have other paths. For simplicity in v1, deleting a TopicEdge triggers a full closure rebuild for the affected taxonomy. This is acceptable because topic trees are small (hundreds, not millions) and writes are rare.

### Implementation: `src/topics.ts` (new file)

```
function maintainClosureOnCreate(sql: SqlStorage, parentId: string, childId: string): void
function maintainClosureOnDelete(sql: SqlStorage, parentId: string, childId: string): void
function rebuildClosureForTaxonomy(sql: SqlStorage, taxonomyNodeId: string): void
```

The `createEdge` handler checks if `rel_type === "TopicEdge"` and calls `maintainClosureOnCreate` within the same transaction. Similarly for delete.

---

## M3: WebSocket Subscriptions with Hibernation

### Goal

Clients can open a WebSocket, subscribe to query family streams, and receive `snapshot` messages whenever the underlying data changes. Subscriptions survive DO hibernation via WebSocket attachment state.

### Subscription Registry

In-memory data structure (rebuilt from attachments on rehydration):

```typescript
type Subscription = {
  stream: string;   // query family name
  key: string;      // logical key, e.g. "topic:machine-learning"
  params: Record<string, unknown>;
};

// Per-socket attachment (serialized to JSON)
type SocketAttachment = {
  subs: Subscription[];
};
```

The DO maintains no global in-memory subscription index. On mutation, it iterates `ctx.getWebSockets()`, reads each socket's attachment, and sends snapshots to those whose subscriptions are affected.

### Subscribe Flow

1. Client sends `{ type: "subscribe", requestId, stream, key, params }`.
2. Server validates the `stream` name against known query families.
3. Server adds the subscription to the socket's attachment.
4. Server executes the query family and sends `{ type: "snapshot", stream, key, version, items }`.
5. If the stream is unknown, server sends `{ type: "error", requestId, code: "unknown_stream", message }`.

### Unsubscribe Flow

1. Client sends `{ type: "unsubscribe", requestId, stream, key }`.
2. Server removes the matching subscription from the socket's attachment.
3. No response message (per protocol spec).

### Mutation Fan-Out

After every successful mutation (create/update/delete node or edge), the DO must:

1. Determine which `(stream, key)` pairs are affected by the mutation.
2. For each active WebSocket, check its attachment subscriptions against the affected set.
3. For each match, execute the query and send a `snapshot`.

**Affected stream determination** — a mapping from mutation type to affected streams:

| Mutation | Affected streams |
|----------|-----------------|
| Create/update/delete node of kind K | `get_node` where key = node.id |
| Create/update/delete node of kind Topic | `taxonomy_topics` where key = taxonomy id, `topic_children` where key = parent id, `topic_ancestors` where key = topic id |
| Create/update/delete edge of type ResourceTopicLink | `concern_topics` for linked concern, `topic_concerns` for linked topic, `resource_topics` for source resource |
| Create/update/delete edge of type ResourceConcernLink | `concern_topics` for linked concern, `topic_concerns` for topics linked to the resource |
| Any edge mutation | `neighborhood` where key = source or target node |

For v1, we use a conservative approach: after any mutation, iterate all sockets and re-evaluate all subscriptions. The single-user, few-clients scenario means this is O(small). We can optimize later with a reverse index if needed.

### Hibernation

**On DO sleep**: No action needed. Subscriptions are already persisted in WebSocket attachments.

**On DO wake** (rehydration): The `webSocketMessage` / `webSocketClose` / `webSocketError` handlers are already registered. Attachment state is readable immediately. No reconstruction step is needed — we read attachments lazily when iterating sockets for fan-out.

### Version Tracking

Each `(stream, key)` pair has a monotonic version number. We store this in a lightweight in-memory `Map<string, number>` (keyed by `stream:key`). On rehydration, versions reset to 0 — this is acceptable because the client receives a full snapshot anyway (not a delta), so the version is only used for client-side change detection.

Alternatively, we can derive the version from `MAX(updated_at)` of the relevant rows, converted to an epoch integer. This survives hibernation with no extra state. **Decision: use epoch-based versions** derived from query results.

### Query Families (implemented as stream handlers)

Each stream name maps to a function:

```typescript
type StreamHandler = (sql: SqlStorage, key: string, params: Record<string, unknown>) => {
  version: number;
  items: unknown[];
};
```

| Stream | Key | Query | Milestone |
|--------|-----|-------|-----------|
| `get_node` | node URI | `SELECT * FROM nodes WHERE id = ?` | M3 |
| `taxonomy_topics` | taxonomy node URI | Recursive query via TopicEdge/TopicClosure from taxonomy root | M3 |
| `topic_children` | topic URI | `SELECT * FROM edges JOIN nodes ON ... WHERE source_id = ? AND rel_type = 'TopicEdge'` | M3 |
| `topic_ancestors` | topic URI | `SELECT * FROM edges JOIN nodes ON ... WHERE target_id = ? AND rel_type = 'TopicClosure' ORDER BY depth` | M3 |
| `resource_topics` | resource URI | Topics linked via ResourceTopicLink | M3 |
| `neighborhood` | any node URI | Bounded BFS over canonical edges, depth 1-3 | M3 |
| `concern_topics` | concern URI | Topics linked through Resources (materialized) | M4 |
| `topic_concerns` | topic URI | Concerns linked through Resources (materialized) | M4 |
| `candidate_concerns_for_resource` | resource URI | Concerns reachable through the resource's topics (materialized) | M4 |

### Implementation

- `src/streams.ts` (new file): Registry of stream handlers + `executeStream(sql, stream, key, params)` dispatcher.
- `src/graph-do.ts`: `webSocketMessage` calls the stream handler on subscribe; mutation handlers call fan-out after commit.

---

## M4: Materialized Lookup Tables and Query Families

### Goal

Pre-compute the two-hop Concern-to-Topic and Topic-to-Concern joins so they can be served as single-table reads.

### Migration #2: Lookup Tables

```sql
-- Concern → Topic summary (UC-1)
CREATE TABLE IF NOT EXISTS concern_topic_summary (
  concern_id TEXT NOT NULL REFERENCES nodes(id),
  topic_id TEXT NOT NULL REFERENCES nodes(id),
  score REAL NOT NULL DEFAULT 0.0,
  resource_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (concern_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_cts_concern ON concern_topic_summary(concern_id);
CREATE INDEX IF NOT EXISTS idx_cts_topic ON concern_topic_summary(topic_id);

-- Topic → Concern summary (UC-2)
CREATE TABLE IF NOT EXISTS topic_concern_summary (
  topic_id TEXT NOT NULL REFERENCES nodes(id),
  concern_id TEXT NOT NULL REFERENCES nodes(id),
  concern_kind TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0.0,
  resource_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (topic_id, concern_id)
);
CREATE INDEX IF NOT EXISTS idx_tcs_topic ON topic_concern_summary(topic_id);
CREATE INDEX IF NOT EXISTS idx_tcs_concern ON topic_concern_summary(concern_id);
```

### Materialization Logic

**When to materialize**: On every edge mutation involving `ResourceTopicLink` or `ResourceConcernLink`, re-derive the affected summary rows.

**Derivation query** (Concern → Topic):

```sql
-- For a given concern_id, recompute all its topic associations
DELETE FROM concern_topic_summary WHERE concern_id = ?;

INSERT INTO concern_topic_summary (concern_id, topic_id, score, resource_count, updated_at)
SELECT
  rcl.target_id AS concern_id,          -- concern_id from ResourceConcernLink (target)
  rtl.target_id AS topic_id,            -- topic_id from ResourceTopicLink (target)
  AVG(COALESCE(json_extract(rtl.properties, '$.confidence'), 0.5)
    * COALESCE(json_extract(rcl.properties, '$.link_confidence'), 0.5)) AS score,
  COUNT(DISTINCT rcl.source_id) AS resource_count,
  datetime('now') AS updated_at
FROM edges rcl
JOIN edges rtl ON rcl.source_id = rtl.source_id  -- same resource
WHERE rcl.rel_type = 'ResourceConcernLink'
  AND rtl.rel_type = 'ResourceTopicLink'
  AND rcl.target_id = ?                           -- the concern
GROUP BY rcl.target_id, rtl.target_id;
```

The reverse (Topic → Concern) is symmetric — swap the grouping.

**On ResourceTopicLink create/delete**: Re-derive summaries for all concerns linked to the same resource.

**On ResourceConcernLink create/delete**: Re-derive summaries for the linked concern.

### Implementation: `src/materialized.ts` (new file)

```
function refreshConcernTopics(sql: SqlStorage, concernId: string): void
function refreshTopicConcerns(sql: SqlStorage, topicId: string): void
function refreshSummariesForResource(sql: SqlStorage, resourceId: string): void
```

Called from the edge mutation handlers when `rel_type` is `ResourceTopicLink` or `ResourceConcernLink`.

### Query Families (M4 streams)

| Stream | Key | Query |
|--------|-----|-------|
| `concern_topics` | concern URI | `SELECT * FROM concern_topic_summary WHERE concern_id = ? ORDER BY score DESC` |
| `topic_concerns` | topic URI | `SELECT * FROM topic_concern_summary WHERE topic_id = ? ORDER BY score DESC` |
| `candidate_concerns_for_resource` | resource URI | Join ResourceTopicLink → topic_concern_summary for topics linked to the resource |

---

## R2 File Proxy

### Goal

The Worker provides `PUT/GET/DELETE /files/:key` routes that proxy file content to/from R2 via the binding. File content never enters the Durable Object. See [ADR-3](./ADRs.md#adr-3-r2-for-large-payloads-worker-proxied-uploads).

### Implementation

Handled directly in the Worker (`src/index.ts`), not routed to the DO:

```typescript
// PUT /files/:key — upload
const key = url.pathname.slice("/files/".length);
await env.FILES_BUCKET.put(key, request.body, {
  httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" },
});
return Response.json({ key, size: request.headers.get("Content-Length"), contentType });

// GET /files/:key — download
const obj = await env.FILES_BUCKET.get(key);
if (!obj) return new Response("Not Found", { status: 404 });
return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream" } });

// DELETE /files/:key — delete
await env.FILES_BUCKET.delete(key);
return new Response(null, { status: 204 });
```

No extra secrets needed. Works fully in local dev (wrangler emulates R2). Max file size: 100MB (Worker request body limit).

### Test (M1)

Add to `tests/test-m1.sh`:
- `PUT /files/test/hello.txt` with body `"hello world"`. Assert 200, response has `key`.
- `GET /files/test/hello.txt`. Assert 200, body is `"hello world"`.
- `DELETE /files/test/hello.txt`. Assert 204.
- `GET /files/test/hello.txt`. Assert 404.

---

## File Inventory

### New Files

| File | Purpose |
|------|---------|
| `src/uri.ts` | URI generation: slugify, generateId, ULID |
| `src/streams.ts` | Query family registry and stream execution |
| `src/topics.ts` | TopicClosure maintenance logic |
| `src/materialized.ts` | Summary table refresh logic |

### Modified Files

| File | Changes |
|------|---------|
| `src/index.ts` | Add `/files/:key` proxy routes, remove `/upload-url` stub |
| `src/graph-do.ts` | Full mutation routing, subscription handling, fan-out |
| `src/migrations.ts` | Add migration #2 (summary tables) |
| `features/API.md` | Update to reflect file proxy, batch endpoint, GET routes |
| `features/USE_CASES.md` | Already updated |

### No Changes

| File | Reason |
|------|--------|
| `wrangler.jsonc` | Config is complete |
| `features/001-do-graph.md` | Requirements are stable |
| `features/PROTOCOL.md` | Protocol is stable |
| `features/ADRs.md` | No new architectural decisions needed (R2 proxy is a tactical choice, not an ADR) |

---

## Local Testing

Every milestone must be testable end-to-end against the local Wrangler dev server before being considered complete.

### Setup

```sh
just install       # npm install
just dev           # starts wrangler dev server at http://localhost:8787
```

The `.dev.vars` file provides secrets for local development:
```
API_KEY=test-key-123
```

### Test Approach: Shell Scripts with curl

Each milestone gets a test script in `tests/` that exercises the implemented functionality against the local dev server using `curl` and `jq`. These are not unit tests — they are integration tests that hit the running Worker + DO + SQLite.

Scripts should be runnable via `just test-m1`, `just test-m2`, etc.

### M1 Test Script: `tests/test-m1.sh`

Tests node and edge CRUD:

1. **Health check**: `GET /health` returns 200.
2. **Auth rejection**: Request without Bearer token returns 401.
3. **Create node**: `POST /graph/nodes` with `kind: Topic, title: "Machine Learning"`. Assert 201, response has `id` matching `topic:machine-learning`, `kind`, `properties`, timestamps.
4. **Create node (duplicate title)**: Same request again. Assert 201, `id` is `topic:machine-learning-2`.
5. **Create node (no title)**: `POST /graph/nodes` with `kind: Note, properties: {}`. Assert 201, `id` starts with `note:`.
6. **Read node**: `GET /graph/nodes/topic:machine-learning`. Assert 200, body matches created node.
7. **Read node (not found)**: `GET /graph/nodes/topic:nonexistent`. Assert 404.
8. **Update node**: `PATCH /graph/nodes/topic:machine-learning` with `properties: { "description": "ML stuff" }`. Assert 200, `description` is set, `title` is unchanged in properties.
9. **Delete node**: Create a node, create an edge from it, `DELETE /graph/nodes/:id`. Assert 204. Assert edge is also gone (GET returns 404).
10. **Create edge**: `POST /graph/edges` with `source_id`, `target_id`, `rel_type: ResourceTopicLink`. Assert 201, response has generated `id`.
11. **Create edge (missing target)**: Assert 400.
12. **Read edge**: `GET /graph/edges/:id`. Assert 200.
13. **Update edge**: `PATCH /graph/edges/:id`. Assert 200.
14. **Delete edge**: `DELETE /graph/edges/:id`. Assert 204.

### M2 Test Script: `tests/test-m2.sh`

Tests batch operations and topic tree:

1. **Batch create**: `POST /graph/batch` with a TopicTaxonomy, 3 Topics, and TopicEdge relationships forming a tree. Assert 201, all IDs returned.
2. **Closure edges exist**: `GET /graph/edges` filtered by `rel_type=TopicClosure`. Verify ancestor-descendant pairs and correct depths.
3. **Read taxonomy tree**: Subscribe (or query) `taxonomy_topics` stream for the taxonomy. Verify all topics returned with tree structure.
4. **Delete a TopicEdge**: Remove a parent-child edge. Verify closure edges are updated.
5. **Batch rollback**: Submit a batch with one invalid node (e.g., edge referencing `$99`). Assert error, verify no partial state was committed.

### M3 Test Script: `tests/test-m3.sh`

Tests WebSocket subscriptions. Uses `websocat` (installable via `brew install websocat`) or a small Node.js script.

1. **Connect**: Open WebSocket to `ws://localhost:8787/ws` with auth.
2. **Subscribe**: Send `subscribe` for `get_node` stream with key = a known node ID. Assert `snapshot` received with the node.
3. **Mutation fan-out**: While subscribed, `PATCH` the node via HTTP. Assert a new `snapshot` is received on the WebSocket with updated data.
4. **Multiple subscriptions**: Subscribe to two streams. Mutate data affecting one. Assert only the affected subscription gets a snapshot.
5. **Unsubscribe**: Send `unsubscribe`. Mutate the node. Assert no snapshot received (wait with a short timeout).
6. **Ping/pong**: Send `ping`, assert `pong`.
7. **Unknown stream**: Subscribe to `nonexistent_stream`. Assert `error` with `unknown_stream` code.

### M4 Test Script: `tests/test-m4.sh`

Tests materialized lookup tables:

1. **Setup**: Create a Concern, two Resources, two Topics. Link Resources to Concern via `ResourceConcernLink`. Link Resources to Topics via `ResourceTopicLink`.
2. **Read concern_topics**: Subscribe to `concern_topics` for the Concern. Assert snapshot contains both Topics with computed scores.
3. **Read topic_concerns**: Subscribe to `topic_concerns` for a Topic. Assert the Concern appears.
4. **Add another link**: Create a third ResourceTopicLink to an existing Topic. Assert the score/resource_count changes in the next snapshot.
5. **Delete a link**: Remove a ResourceConcernLink. Assert the summary updates.

### Justfile Targets

```just
# Run M1 integration tests (requires `just dev` running)
test-m1:
    bash tests/test-m1.sh

# Run M2 integration tests
test-m2:
    bash tests/test-m2.sh

# Run M3 integration tests
test-m3:
    bash tests/test-m3.sh

# Run M4 integration tests
test-m4:
    bash tests/test-m4.sh

# Run all integration tests
test-all: test-m1 test-m2 test-m3 test-m4
```

### Dev Environment Prerequisites

- Node.js (for wrangler)
- `just` (task runner)
- `curl` and `jq` (for test scripts)
- `websocat` (for WebSocket tests, `brew install websocat`)

---

## Open Questions

1. **Property validation**: Should `createNode` validate that the `properties` object matches the graph manifest's declared properties for the given `kind`? **Proposed answer**: No, not in v1. The graph store is schema-flexible; the manifest is a documentation/tooling artifact, not a runtime schema.

2. **Cascade semantics for batch**: If one node in a batch fails validation, does the whole batch fail? **Proposed answer**: Yes, atomic all-or-nothing. This is the point of the batch endpoint.

3. **Topic closure rebuild scope**: When a TopicEdge is deleted, should we rebuild closure for just the affected subtree or the entire taxonomy? **Proposed answer**: Entire taxonomy in v1 (topic trees are small). Optimize to subtree-only if we observe performance issues.

4. **R2 proxy size limit**: What's the maximum file size we'll accept through the Worker proxy? **Proposed answer**: 100MB (Cloudflare Workers request body limit). Document this and revisit with presigned URLs if larger files are needed.

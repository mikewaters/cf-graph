# Deferred Features

Requirements and capabilities that were explicitly descoped from the initial implementation. Each entry notes the original requirement and the trigger condition for revisiting it.

## Incremental Patches

**Original:** Server sends `patch` messages with diffs for large result sets.

**Decision:** Snapshots only. All subscription updates send the full result set.

**Revisit when:** A specific query family produces result sets large enough that full snapshots cause measurable latency or bandwidth issues.

## Mutation Idempotency

**Original:** All mutations idempotent by client request id or mutation token, with server-side deduplication.

**Decision:** Last-write-wins. Single user, rare writes, no dedup infrastructure.

**Revisit when:** We add automated/batch writers or observe duplicate mutations in logs.

## Intent-Based External Payload Writes

**Original:** Two-step saga-style write process with intent records for R2 + graph reference atomicity.

**Decision:** Simple write-then-reference. Client retries on failure. Orphaned R2 objects swept by lifecycle rules.

**Revisit when:** We observe meaningful orphan accumulation or need to guarantee upload-to-reference atomicity.

## Message Batching

**Original:** Batch outbound WebSocket messages and graph updates during bursty write periods.

**Decision:** Each mutation pushes snapshots immediately to affected subscribers.

**Revisit when:** Write bursts cause noticeable fan-out cost or client-side rendering churn.

## SSE Transport

**Original:** SSE as an optional read-only alternative to WebSockets.

**Decision:** WebSocket only.

**Revisit when:** A client environment cannot support WebSockets (unlikely for our use case).

## Per-Principal Authorization

**Original:** Authorization enforced per workspace/tenant/graph shard with subscription key and mutation target validation against authenticated principal's access scope.

**Decision:** Single shared API key. No per-principal scoping.

**Revisit when:** The system is no longer single-user.

## Observability Metrics

**Original:** Seven metric categories (query latency, mutation latency, socket count, subscription count, hibernation events, cache rates, fan-out count) plus hot-shard analysis.

**Decision:** Structured JSON logging only.

**Revisit when:** We need to answer a specific cost or performance question that logging can't answer.

## Summary Table Repair Tool

**Original:** A repair path for rebuilding materialized summary rows from canonical nodes and edges without full-system outage.

**Decision:** Deferred. The data model property that summaries are *derivable* from canonical data is maintained; the repair *tool* is not built yet.

**Revisit when:** We first observe summary drift or corruption in practice.

## SQLite Subscription State Overflow

**Original:** If WebSocket attachment budget is exceeded, persist subscription sets in SQLite.

**Decision:** Attachment-only. Single user with few clients stays within budget.

**Revisit when:** We observe attachment serialization failures or add significantly more concurrent clients.

## HTTP Query Bootstrap

**Original:** HTTP GET endpoints for initial query results without a WebSocket connection.

**Decision:** Removed. The `snapshot` response to a `subscribe` message serves the same purpose.

**Revisit when:** We need a client that fetches data without establishing a WebSocket (e.g. a CLI tool or server-side consumer).

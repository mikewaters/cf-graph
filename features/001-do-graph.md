# Requirements Specification: Durable Objects Graph Store and Realtime Query Channel

## Overview

This document specifies a Cloudflare-based architecture for storing and querying a graph-oriented application using Durable Objects (DOs), SQLite-backed DO storage, and persistent client connections over WebSockets.[1][2][3]

The target workload is a single-user, multi-client property graph application centered on bounded 1-3 hop traversals with write-time derivation of candidate relationships and read-time serving of precomputed graph summaries. Writes are infrequent; concurrent reads from multiple long-lived client connections are the primary access pattern. The system must support transactional graph mutations, efficient neighborhood reads, and persistent client subscriptions. Architectural decisions are documented in [ADRs.md](./ADRs.md); specific node types and query families are defined in [USE_CASES.md](./USE_CASES.md).[2][3][6]

## Goals

The system shall provide transactional graph mutation semantics for canonical node and edge data within the graph.[1][2]

The system shall optimize for bounded neighborhood queries (1-3 hops) rather than arbitrary deep graph traversals, favoring denormalized summary tables instead of a runtime traversal engine. Specific use cases and their query families, lookup tables, and workflows are defined in [USE_CASES.md](./USE_CASES.md).[3][2]

The system shall provide a persistent client connection model for subscriptions, with WebSockets as the transport. Mutations are submitted over HTTP.[6][7]

## Non-Goals

The system is not required to support arbitrary unbounded graph traversal.[4]

The system is not required to store file content, document bodies, embeddings, or binary assets in Durable Object storage. Such content is stored in R2 with references in the graph layer.[2][3][8]

## Functional Requirements

### Graph Data Model

The system shall persist canonical graph state in Durable Object storage (see [ADR-2](./ADRs.md#adr-2-sqlite-backed-durable-object-storage-for-canonical-graph-state)).

The canonical model shall support at minimum:

- Node records with a stable id, a kind or type discriminator, timestamps, and lightweight property references.
- Edge records with source id, destination id, relationship type, timestamps, and lightweight edge property references.
- Version or timestamp fields sufficient to support incremental update propagation.

The system shall support typed or indexed lookup tables for hot traversal paths, treated as materialized graph summaries derived from canonical edges and maintained transactionally within the owning Durable Object when the affected neighborhood is bounded and known. Specific table definitions are in [USE_CASES.md](./USE_CASES.md).[2]

### Schema Migration

The data model will evolve frequently. Since Cloudflare does not support `PRAGMA user_version` in DO SQLite, the system shall manage schema migrations as follows:[4][2]

- The Durable Object constructor shall run all pending migrations inside `blockConcurrencyWhile()` before processing any requests.
- A `_sql_schema_migrations` table shall track which migrations have been applied, using a monotonic integer id and an applied-at timestamp.
- Each migration shall be a sequentially numbered, idempotent SQL block that runs within a transaction.
- Migrations shall be defined in application code (not in wrangler config); wrangler migrations are only used for DO class lifecycle (create/rename/delete).

### File Storage

Files uploaded as part of graph mutations are stored in R2 per [ADR-3](./ADRs.md#adr-3-r2-for-large-payloads-presigned-url-uploads). The graph layer stores only a reference key, content type, size, and upload timestamp.

The upload flow shall be:

1. Client requests an upload URL from the Worker via HTTP.
2. Worker generates a presigned R2 PUT URL with a scoped key and short expiry, and returns it to the client.
3. Client uploads the file directly to R2 using the presigned URL.
4. Client confirms the upload to the Worker, which creates or updates the corresponding node or edge reference in the graph transactionally.

If the confirmation step fails, the client retries. Orphaned R2 objects (uploaded but never confirmed) may be cleaned up by R2 object lifecycle rules.[8]

### Query Model

The system shall support first-class query families exposed by the graph Durable Object, as enumerated in [USE_CASES.md](./USE_CASES.md).

Each query family shall define:

- A stable logical stream name.
- An explicit key namespace, such as `project:123` or `draft:abc`.
- Optional pagination, ordering, and result size limits.
- A version or updated-at value for incremental invalidation and client synchronization.

The system shall prefer indexed reads against materialized summary tables over recomputing the same 2-hop or 3-hop result on every request.[2]

### Mutation Model

The system shall expose mutation operations over HTTP for creating, updating, and deleting nodes and edges.[2]

Use-case-specific mutation workflows are defined in [USE_CASES.md](./USE_CASES.md).

Mutations shall execute within one Durable Object transaction to guarantee serialized consistency for canonical rows and derived summary rows.[2]

### Realtime Connectivity

The system shall provide a persistent WebSocket connection channel associated with the graph Durable Object, using the transport described in [ADR-4](./ADRs.md#adr-4-websocket-with-hibernation-as-primary-realtime-transport). WebSocket connections are read-only subscription channels; mutations are submitted separately over HTTP.[7][6]

The Worker entry point shall authenticate the caller using a shared secret or API key and route the request to the graph Durable Object.[6][1]

### Subscription Protocol

A single persistent connection shall support multiple concurrent logical subscriptions rather than binding one connection to one query permanently.

The protocol shall support at minimum the following client message types:

- `subscribe`
- `unsubscribe`
- `ping`

The protocol shall support at minimum the following server message types:

- `snapshot`
- `invalidated`
- `error`
- `pong`

Each subscription shall include:

- Stream name.
- Logical key.
- Optional parameter object.
- Client request id.

The server shall multiplex many logical subscriptions over one socket and route updates only to clients subscribed to the affected stream and key.

### Hibernation and Session Recovery

The system shall be compatible with Durable Object WebSocket hibernation semantics, which allow the DO to sleep while sockets remain connected.[7][6]

Per-socket subscription state shall be stored in WebSocket attachment data so it survives hibernation eviction. With a single user and a small number of client apps, the attachment budget is sufficient without a SQLite fallback.[6]

On rehydration, the Durable Object shall reconstruct live session state by enumerating active sockets and restoring attachment metadata to resume subscription routing.[6]

### Change Propagation

The system shall use versioned result sets or equivalent monotonic update markers for each query family and logical key.

Every mutation that changes canonical graph state and affects a materialized query family shall also update the corresponding result version or updated-at marker within the same local transaction when possible.[2]

When a mutation commits, the Durable Object shall send a fresh `snapshot` to each subscription whose stream and key are affected by the changed data.

## Non-Functional Requirements

### Consistency

Graph mutations and summary-table updates shall be strongly serialized and transactionally consistent within the Durable Object.[1][2]

### Performance

The system shall optimize for low-latency local reads from Durable Object storage for hot graph neighborhoods and precomputed summaries.[2]

The system should target serving common query families from indexed tables or in-memory caches without external round trips, except where heavyweight payload hydration is explicitly requested.[3][2]

### Cost

Cost-sensitive architectural decisions (payload split, hibernation, write-time materialization) are documented in [ADRs.md](./ADRs.md).

### Reliability

The system shall persist sufficient state (via WebSocket attachments) to recover active subscriptions and resume change propagation after Durable Object eviction or restart.[6]

### Security

The Worker shall authenticate requests using a shared secret or API key before routing to the graph Durable Object.

## API and Protocol Requirements

### HTTP Endpoints

The system shall support HTTP endpoints for:

- Graph mutations (create, update, delete nodes and edges).
- Presigned upload URL generation for R2 file storage.
- Health or readiness inspection for operational use.

The system shall support a persistent WebSocket endpoint routed through the Worker to the graph Durable Object.[6]

### Message Envelope

All protocol messages shall be JSON objects with a top-level `type` field.

Client messages should include a `requestId` for tracing. Server messages should include a `stream`, `key`, and `version` when they correspond to a subscription update.

An example subscription request envelope:

```json
{
  "type": "subscribe",
  "requestId": "req-001",
  "stream": "project_topics",
  "key": "project:123",
  "params": { "limit": 10 }
}
```

An example snapshot response:

```json
{
  "type": "snapshot",
  "stream": "project_topics",
  "key": "project:123",
  "version": 43,
  "items": []
}
```

## Data Integrity Requirements

Canonical edges shall be the source of truth for graph topology.

Materialized lookup and ranking tables shall be derivable from canonical graph state. Every materialized row family should carry timestamps or versions sufficient to detect staleness.

## Observability Requirements

The system shall emit structured JSON logs for mutations, subscription lifecycle events (connect, subscribe, disconnect), and hibernation wake-ups. Formal metrics and counters are deferred until a specific cost or performance question requires them.

## Acceptance Criteria

The implementation shall be considered aligned with this specification when all of the following are true:

- The graph Durable Object can persist canonical nodes and edges transactionally.[2]
- The system can answer the query families defined in [USE_CASES.md](./USE_CASES.md) using bounded local reads and derived summary tables.[2]
- A client can open a persistent WebSocket connection and hold multiple simultaneous read-only subscriptions, receiving snapshot updates when underlying data changes.[6]
- The Durable Object can hibernate and later recover subscription routing state from WebSocket attachments without losing subscription identity.[7][6]
- Mutations are accepted over HTTP and execute transactionally within the Durable Object.
- Schema migrations run automatically on DO startup and can be iterated without manual intervention.[2]
- Files are uploaded to R2 via presigned URLs and referenced in the graph by key; file content never passes through the Durable Object.[8]

Sources
[1] Overview · Cloudflare Durable Objects docs https://developers.cloudflare.com/durable-objects/
[2] Zero-latency SQLite storage in every Durable Object https://blog.cloudflare.com/sqlite-in-durable-objects/
[3] Control and data plane architectural pattern for Durable Objects https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/
[4] Rules of Durable Objects - Cloudflare Docs https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
[5] Pricing · Cloudflare Durable Objects docs https://developers.cloudflare.com/durable-objects/platform/pricing/
[6] Use WebSockets · Cloudflare Durable Objects docs https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[7] Build a WebSocket server with WebSocket Hibernation https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
[8] Storing user-generated content with R2 signed URLs https://developers.cloudflare.com/reference-architecture/diagrams/storage/storing-user-generated-content/


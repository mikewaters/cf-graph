# Implementation Model

How the domain entities from [DOMAIN_MODEL.md](./DOMAIN_MODEL.md) are stored, linked, and queried inside the graph platform. This covers the generic storage schema, edge types, computed structures, and materialized views.

---

## Storage Schema

All domain entities are stored in two generic tables inside a SQLite database within a Cloudflare Durable Object. The schema is type-discriminated — the `kind` and `rel_type` columns carry the domain semantics, while the table structure is uniform.

### `nodes`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | CURIE identifier (`<kind-kebab>:<slug>`) |
| `kind` | TEXT NOT NULL | PascalCase domain type (e.g. `ProjectConcern`, `Topic`) |
| `properties` | TEXT NOT NULL | JSON bag of all domain-specific properties |
| `created_at` | TEXT NOT NULL | ISO 8601 timestamp |
| `updated_at` | TEXT NOT NULL | ISO 8601 timestamp |

Index: `idx_nodes_kind` on `kind`.

### `edges`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | CURIE identifier (`<rel-type-kebab>:<src-slug>--<tgt-slug>`) |
| `source_id` | TEXT NOT NULL | FK → `nodes.id` |
| `target_id` | TEXT NOT NULL | FK → `nodes.id` |
| `rel_type` | TEXT NOT NULL | PascalCase relationship type |
| `properties` | TEXT NOT NULL | JSON bag of edge-specific properties |
| `created_at` | TEXT NOT NULL | ISO 8601 timestamp |
| `updated_at` | TEXT NOT NULL | ISO 8601 timestamp |

Indexes: `idx_edges_source` on `(source_id, rel_type)`, `idx_edges_target` on `(target_id, rel_type)`, `idx_edges_rel_type` on `rel_type`.

---

## URI Generation

Entity IDs follow the CURIE pattern `<kind>:<slug>`:

- **kind** — PascalCase class name converted to kebab-case (`ProjectConcern` → `project-concern`)
- **slug** — derived from `title` (lowercased, hyphenated, special chars stripped, max 80 chars). If no title, a ULID is used.
- **Collision handling** — if `<kind>:<slug>` exists, append `-2`, `-3`, etc. (up to 100 attempts).

Edge IDs: `<rel-type-kebab>:<source-slug>--<target-slug>`, with the same collision handling.

Implemented in `src/uri.ts`.

---

## Edge Types (Qualified Links)

Edges are the implementation mechanism for relationships between domain entities. Each edge type carries its own properties in the JSON `properties` column.

### Canonical link types

These represent direct, user-created relationships.

| rel_type | Source → Target | Key Properties | Description |
|----------|----------------|----------------|-------------|
| `ResourceTopicLink` | Resource → Topic | confidence, role, provenance | Subject classification of a resource |
| `ResourceConcernLink` | Resource → Concern | link_confidence, role, provenance | Associates a resource with a concern |
| `ConcernConceptLink` | Topic → Concern | role, confidence | What a concern is *about* (themes, metrics, constraints) |
| `ConcernEntityLink` | Entity → Concern | role, confidence | Who is involved in a concern (owner, collaborator, stakeholder) |
| `TopicEdge` | Topic/Taxonomy → Topic | edge_role | Direct parent→child in topic hierarchy |
| `EffortActivityLink` | Effort → Activity | role, confidence | Organizational link from strategic to tactical work |
| `GoalEffortLink` | Goal → Effort | role, confidence | Goal advances through effort |
| `ActivityTopicLink` | Activity → Topic | role, confidence | Work is about a topic |
| `EffortTopicLink` | Effort → Topic | role, confidence | Strategic work organized around topics |
| `ActivityResourceLink` | Activity → Resource | role, confidence | Work uses/produces a resource |
| `EffortResourceLink` | Effort → Resource | role, confidence | Strategic work spans resources |
| `ResourceActivityLink` | Resource → Activity | role, confidence | Resource supports work |

### Computed edge types

These are derived from canonical edges and maintained automatically by the platform.

| rel_type | Source → Target | Key Properties | Maintained by |
|----------|----------------|----------------|---------------|
| `TopicClosure` | Ancestor → Descendant | depth (integer) | `src/topics.ts` — rebuilt from `TopicEdge` edges |

---

## Computed Structures

### Topic Closure Table

The `TopicClosure` edges form a transitive closure of the topic hierarchy. For every ancestor-descendant pair reachable through `TopicEdge` edges, a closure edge exists with `depth` indicating the distance.

- **Self-closure**: Every topic has a closure edge to itself with `depth: 0`.
- **On TopicEdge create**: Closure edges are incrementally added for all ancestors of the parent.
- **On TopicEdge delete**: The entire taxonomy's closure is rebuilt from scratch. Topic trees are small and writes are rare, so this is acceptable.

Implemented in `src/topics.ts`.

### Materialized Summary Tables

Pre-computed two-hop joins for the Concern↔Topic query path. These are **not** in the `edges` table — they have their own dedicated tables for efficient reads.

#### `concern_topic_summary`

Answers: "Given a Concern, what are its most relevant Topics?" (UC-1)

Path: Concern ← ResourceConcernLink ← Resource → ResourceTopicLink → Topic

| Column | Type | Description |
|--------|------|-------------|
| `concern_id` | TEXT PK | FK → `nodes.id` |
| `topic_id` | TEXT PK | FK → `nodes.id` |
| `score` | REAL | Aggregated confidence (avg of link confidences) |
| `resource_count` | INTEGER | Number of bridging resources |
| `updated_at` | TEXT | Last recomputation time |

#### `topic_concern_summary`

Answers: "Given a Topic, what Concerns are associated with it?" (UC-2)

Path: Topic ← ResourceTopicLink ← Resource → ResourceConcernLink → Concern

| Column | Type | Description |
|--------|------|-------------|
| `topic_id` | TEXT PK | FK → `nodes.id` |
| `concern_id` | TEXT PK | FK → `nodes.id` |
| `concern_kind` | TEXT | The concern's `kind` value |
| `score` | REAL | Aggregated confidence |
| `resource_count` | INTEGER | Number of bridging resources |
| `updated_at` | TEXT | Last recomputation time |

**Refresh triggers**: Any create/update/delete of a `ResourceTopicLink` or `ResourceConcernLink` edge triggers a refresh for all concerns and topics linked to the same resource.

Implemented in `src/materialized.ts`.

---

## Query Families (Streams)

Named queries that can be subscribed to over WebSocket. Each stream takes a `key` (usually a node URI) and returns `{ version, items }`.

| Stream | Key | Returns | Source |
|--------|-----|---------|--------|
| `get_node` | node URI | The node | `nodes` table |
| `taxonomy_topics` | taxonomy URI | All topics in the taxonomy with depth | `TopicClosure` edges |
| `topic_children` | topic URI | Direct children | `TopicEdge` edges |
| `topic_ancestors` | topic URI | Ancestors ordered by distance | `TopicClosure` edges |
| `resource_topics` | resource URI | Linked topics | `ResourceTopicLink` edges |
| `neighborhood` | any node URI | Nodes and edges within 1-3 hops | Canonical edges (BFS) |
| `concern_topics` | concern URI | Ranked topics by score | `concern_topic_summary` |
| `topic_concerns` | topic URI | Ranked concerns by score | `topic_concern_summary` |
| `candidate_concerns_for_resource` | resource URI | Concerns reachable through the resource's topics | `ResourceTopicLink` → `topic_concern_summary` |

Implemented in `src/streams.ts`.

---

## Migrations

Schema changes are tracked in `_sql_schema_migrations` and applied sequentially in the DO constructor.

| Migration | Description |
|-----------|-------------|
| 1 | `nodes` and `edges` tables with indexes |
| 2 | `concern_topic_summary` and `topic_concern_summary` tables with indexes |

Implemented in `src/migrations.ts`.

---

## Property Storage

All domain-specific properties are stored as JSON in the `properties` TEXT column. This keeps the schema flexible while the data model is evolving. Properties are read and written as opaque JSON — the platform does not validate property shapes against the graph manifest at runtime.

If specific properties become hot query paths, they can be promoted to indexed columns via a new migration.

## File Storage

Binary files (PDFs, images, etc.) are stored in Cloudflare R2 via the Worker's `/files/:key` proxy. File content never enters SQLite or the Durable Object. Nodes reference files by storing the R2 key in their properties:

```json
{ "file": { "key": "uploads/abc123.pdf", "content_type": "application/pdf", "size": 204800 } }
```

# Use Cases

Use cases for the graph store. Each use case includes the query families, materialized lookup tables, and mutation workflows it requires from the platform described in [001-do-graph.md](./001-do-graph.md).

---

## UC-T: Taxonomy and Topic management

Read and write taxonomies and topics. Clients may:

- Create or update a `TopicTaxonomy` node.
- Create or update individual `Topic` nodes (parented via `TopicEdge` or unparented).
- Write a batch graph of topics: a `TopicTaxonomy` plus a tree of `Topic` nodes with parent-child relationships, created atomically.
- Write a flat list of topics (no hierarchy), attached to a taxonomy.
- Read a taxonomy and its full topic tree.

**Mutations:**
- `POST /graph/nodes` with `kind: TopicTaxonomy`
- `POST /graph/nodes` with `kind: Topic`
- `POST /graph/edges` with `rel_type: TopicEdge` (parent→child)
- `POST /graph/batch` — atomically create a taxonomy + topics + edges in one request

**Query families:**
- `taxonomy_topics(taxonomyId)` — all topics in a taxonomy as a tree
- `topic_children(topicId)` — direct children of a topic
- `topic_ancestors(topicId)` — ancestors via `TopicClosure`

**Lookup tables:**
- `TopicEdge` (canonical parent→child edges)
- `TopicClosure` (ancestor→descendant with depth, maintained at write time)

---

## UC-E: Entity creation with URI assignment

Create any entity node. The server assigns a canonical URI (the `id` field, range `uriorcurie`) and returns it to the client.

**Mutation:**
- `POST /graph/nodes` with `kind` and `properties`
- Server generates `id` if not provided (e.g., `lifeos:<kind>/<ulid>`)
- Response includes the assigned `id`

**Query family:**
- `get_node(id)` — read any entity by its URI

---

## UC-R: Read any entity by URI

Given a URI, return the full node with its properties.

**Query family:**
- `get_node(id)` — direct primary key lookup on `nodes` table

---

## UC-1: Concern to top related Topics

Given any Concern (ProjectConcern, GoalConcern, RoutineConcern, etc.), return its most relevant Topics ranked by score.

The path is: Concern ←ResourceConcernLink→ Resource ←ResourceTopicLink→ Topic. The materialized lookup table pre-computes this two-hop join.

**Query family:** `concern_topics(concernId, options)`

**Lookup table:** `concern_topic(concern_id, topic_id, score, resource_count, updated_at)`

---

## UC-2: Topic to related Concerns

Given a Topic, return the Concerns most associated with it, across all Concern subtypes.

Reverse of UC-1: Topic ←ResourceTopicLink→ Resource ←ResourceConcernLink→ Concern.

**Query family:** `topic_concerns(topicId, options)`

**Lookup table:** `topic_concern(topic_id, concern_id, concern_kind, score, resource_count, updated_at)`

---

## UC-3: Draft Resource to candidate Topics, then candidate Concerns

Given a draft Resource (Document, Note, Bookmark, Highlight, etc.), discover candidate Topics and then surface candidate Concerns through those Topics. Multi-step workflow:

1. Create a draft Resource node.
2. Attach proposed Topic relationships (`ResourceTopicLink`).
3. Compute candidate Concerns from Topic-to-Concern summaries (UC-2 lookup) or bounded local traversal.
4. Return ranked Concern proposals to the client.
5. Client confirms selected Concerns.
6. Persist finalized `ResourceConcernLink` edges and refresh affected summary tables.

**Query families:**
- `resource_topics(resourceId, options)` — topics linked to a resource
- `candidate_concerns_for_resource(resourceId, options)` — concerns reachable through the resource's topics

**Lookup tables:**
- `concern_topic` (from UC-1, read path)
- `topic_concern` (from UC-2, read path)

---

## UC-4: Neighborhood reads (1-3 hops)

Given any node (Concern, Topic, Resource, Activity, Effort, etc.), return its local neighborhood within 1-3 hops. Uses canonical `edges` table with bounded traversal.

**Query family:** `neighborhood(nodeId, depth, options)` — general bounded traversal over canonical edges

**Lookup table:** None (uses canonical edge indexes: `idx_edges_source`, `idx_edges_target`, `idx_edges_rel_type`)

---

## Acceptance Criteria

- UC-T: A client can write a taxonomy with a tree of topics in a single request and read it back as a tree.
- UC-E: Creating any entity returns a server-assigned URI.
- UC-R: Any entity can be read by its URI.
- UC-1: Concern-to-Topics queries return ranked results from a materialized lookup table.
- UC-2: Topic-to-Concerns queries return ranked results from a materialized lookup table.
- UC-3: A draft Resource can discover candidate Concerns through its Topics.
- UC-4: Neighborhood reads within 1-3 hops complete using indexed canonical edges.

## Sources

Source references follow [001-do-graph.md](./001-do-graph.md) numbering.

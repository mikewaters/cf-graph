/**
 * Query family registry and stream execution.
 *
 * Each stream name maps to a handler function that executes a query
 * and returns { version, items }.
 */

interface StreamResult {
  version: number;
  items: unknown[];
}

type StreamHandler = (
  sql: SqlStorage,
  key: string,
  params: Record<string, unknown>,
) => StreamResult;

// ─── Stream handlers ────────────────────────────────────────────

/**
 * get_node: Direct primary key lookup on nodes table.
 * Key = node URI (CURIE)
 */
function getNode(sql: SqlStorage, key: string): StreamResult {
  const rows = sql
    .exec<{
      id: string;
      kind: string;
      properties: string;
      created_at: string;
      updated_at: string;
    }>("SELECT * FROM nodes WHERE id = ?", key)
    .toArray();

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    properties: JSON.parse(r.properties),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return {
    version: deriveVersion(rows.map((r) => r.updated_at)),
    items,
  };
}

/**
 * taxonomy_topics: All topics in a taxonomy as a flat list with depth info.
 * Key = taxonomy node URI
 *
 * Uses TopicClosure edges to get all descendants of the taxonomy root.
 */
function taxonomyTopics(sql: SqlStorage, key: string): StreamResult {
  const rows = sql
    .exec<{
      id: string;
      kind: string;
      properties: string;
      created_at: string;
      updated_at: string;
      depth: number;
    }>(
      `SELECT n.id, n.kind, n.properties, n.created_at, n.updated_at,
              CAST(json_extract(e.properties, '$.depth') AS INTEGER) as depth
       FROM edges e
       JOIN nodes n ON e.target_id = n.id
       WHERE e.source_id = ? AND e.rel_type = 'TopicClosure' AND e.target_id != ?
       ORDER BY depth ASC`,
      key, key,
    )
    .toArray();

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    properties: JSON.parse(r.properties),
    created_at: r.created_at,
    updated_at: r.updated_at,
    depth: r.depth,
  }));

  return {
    version: deriveVersion(rows.map((r) => r.updated_at)),
    items,
  };
}

/**
 * topic_children: Direct children of a topic via TopicEdge.
 * Key = parent topic URI
 */
function topicChildren(sql: SqlStorage, key: string): StreamResult {
  const rows = sql
    .exec<{
      id: string;
      kind: string;
      properties: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT n.id, n.kind, n.properties, n.created_at, n.updated_at
       FROM edges e
       JOIN nodes n ON e.target_id = n.id
       WHERE e.source_id = ? AND e.rel_type = 'TopicEdge'
       ORDER BY n.id`,
      key,
    )
    .toArray();

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    properties: JSON.parse(r.properties),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return {
    version: deriveVersion(rows.map((r) => r.updated_at)),
    items,
  };
}

/**
 * topic_ancestors: Ancestors of a topic via TopicClosure, ordered by depth.
 * Key = topic URI
 */
function topicAncestors(sql: SqlStorage, key: string): StreamResult {
  const rows = sql
    .exec<{
      id: string;
      kind: string;
      properties: string;
      created_at: string;
      updated_at: string;
      depth: number;
    }>(
      `SELECT n.id, n.kind, n.properties, n.created_at, n.updated_at,
              CAST(json_extract(e.properties, '$.depth') AS INTEGER) as depth
       FROM edges e
       JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.rel_type = 'TopicClosure' AND e.source_id != ?
       ORDER BY depth ASC`,
      key, key,
    )
    .toArray();

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    properties: JSON.parse(r.properties),
    created_at: r.created_at,
    updated_at: r.updated_at,
    depth: r.depth,
  }));

  return {
    version: deriveVersion(rows.map((r) => r.updated_at)),
    items,
  };
}

/**
 * resource_topics: Topics linked to a resource via ResourceTopicLink.
 * Key = resource URI
 */
function resourceTopics(sql: SqlStorage, key: string): StreamResult {
  const rows = sql
    .exec<{
      id: string;
      kind: string;
      properties: string;
      created_at: string;
      updated_at: string;
      edge_properties: string;
    }>(
      `SELECT n.id, n.kind, n.properties, n.created_at, n.updated_at,
              e.properties as edge_properties
       FROM edges e
       JOIN nodes n ON e.target_id = n.id
       WHERE e.source_id = ? AND e.rel_type = 'ResourceTopicLink'
       ORDER BY n.id`,
      key,
    )
    .toArray();

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    properties: JSON.parse(r.properties),
    edge_properties: JSON.parse(r.edge_properties),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return {
    version: deriveVersion(rows.map((r) => r.updated_at)),
    items,
  };
}

/**
 * neighborhood: Bounded BFS over canonical edges, depth 1-3.
 * Key = any node URI
 * Params: depth (default 1, max 3)
 */
function neighborhood(
  sql: SqlStorage,
  key: string,
  params: Record<string, unknown>,
): StreamResult {
  const maxDepth = Math.min(Number(params.depth ?? 1), 3);

  const visited = new Set<string>();
  visited.add(key);
  let frontier = [key];
  const allEdges: Array<{
    id: string;
    source_id: string;
    target_id: string;
    rel_type: string;
    properties: string;
    created_at: string;
    updated_at: string;
  }> = [];

  for (let d = 0; d < maxDepth; d++) {
    if (frontier.length === 0) break;

    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      // Outgoing edges
      const outgoing = sql
        .exec<{
          id: string;
          source_id: string;
          target_id: string;
          rel_type: string;
          properties: string;
          created_at: string;
          updated_at: string;
        }>(
          "SELECT * FROM edges WHERE source_id = ? AND rel_type != 'TopicClosure'",
          nodeId,
        )
        .toArray();

      for (const edge of outgoing) {
        allEdges.push(edge);
        if (!visited.has(edge.target_id)) {
          visited.add(edge.target_id);
          nextFrontier.push(edge.target_id);
        }
      }

      // Incoming edges
      const incoming = sql
        .exec<{
          id: string;
          source_id: string;
          target_id: string;
          rel_type: string;
          properties: string;
          created_at: string;
          updated_at: string;
        }>(
          "SELECT * FROM edges WHERE target_id = ? AND rel_type != 'TopicClosure'",
          nodeId,
        )
        .toArray();

      for (const edge of incoming) {
        allEdges.push(edge);
        if (!visited.has(edge.source_id)) {
          visited.add(edge.source_id);
          nextFrontier.push(edge.source_id);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Fetch all visited nodes
  const nodeIds = Array.from(visited);
  const nodes: unknown[] = [];

  for (const nid of nodeIds) {
    const rows = sql
      .exec<{
        id: string;
        kind: string;
        properties: string;
        created_at: string;
        updated_at: string;
      }>("SELECT * FROM nodes WHERE id = ?", nid)
      .toArray();

    for (const r of rows) {
      nodes.push({
        id: r.id,
        kind: r.kind,
        properties: JSON.parse(r.properties),
        created_at: r.created_at,
        updated_at: r.updated_at,
      });
    }
  }

  // Deduplicate edges by id
  const seenEdges = new Set<string>();
  const uniqueEdges = allEdges.filter((e) => {
    if (seenEdges.has(e.id)) return false;
    seenEdges.add(e.id);
    return true;
  });

  const edges = uniqueEdges.map((e) => ({
    id: e.id,
    source_id: e.source_id,
    target_id: e.target_id,
    rel_type: e.rel_type,
    properties: JSON.parse(e.properties),
    created_at: e.created_at,
    updated_at: e.updated_at,
  }));

  const timestamps = [
    ...nodes.map((n: any) => n.updated_at),
    ...edges.map((e: any) => e.updated_at),
  ];

  return {
    version: deriveVersion(timestamps),
    items: [{ nodes, edges }],
  };
}

// ─── M4 stream handlers ────────────────────────────────────────

/**
 * concern_topics: Topics associated with a concern via materialized summary.
 * Key = concern URI
 */
function concernTopics(sql: SqlStorage, key: string): StreamResult {
  const rows = sql
    .exec<{
      concern_id: string;
      topic_id: string;
      score: number;
      resource_count: number;
      updated_at: string;
    }>(
      "SELECT * FROM concern_topic_summary WHERE concern_id = ? ORDER BY score DESC",
      key,
    )
    .toArray();

  return {
    version: deriveVersion(rows.map((r) => r.updated_at)),
    items: rows,
  };
}

/**
 * topic_concerns: Concerns associated with a topic via materialized summary.
 * Key = topic URI
 */
function topicConcerns(sql: SqlStorage, key: string): StreamResult {
  const rows = sql
    .exec<{
      topic_id: string;
      concern_id: string;
      concern_kind: string;
      score: number;
      resource_count: number;
      updated_at: string;
    }>(
      "SELECT * FROM topic_concern_summary WHERE topic_id = ? ORDER BY score DESC",
      key,
    )
    .toArray();

  return {
    version: deriveVersion(rows.map((r) => r.updated_at)),
    items: rows,
  };
}

/**
 * candidate_concerns_for_resource: Concerns reachable through a resource's topics.
 * Key = resource URI
 *
 * Join ResourceTopicLink → topic_concern_summary for topics linked to the resource.
 */
function candidateConcernsForResource(sql: SqlStorage, key: string): StreamResult {
  const rows = sql
    .exec<{
      concern_id: string;
      concern_kind: string;
      topic_id: string;
      score: number;
      resource_count: number;
      updated_at: string;
    }>(
      `SELECT tcs.concern_id, tcs.concern_kind, tcs.topic_id, tcs.score, tcs.resource_count, tcs.updated_at
       FROM edges e
       JOIN topic_concern_summary tcs ON e.target_id = tcs.topic_id
       WHERE e.source_id = ? AND e.rel_type = 'ResourceTopicLink'
       ORDER BY tcs.score DESC`,
      key,
    )
    .toArray();

  return {
    version: deriveVersion(rows.map((r) => r.updated_at)),
    items: rows,
  };
}

// ─── Registry ──────────────────────────────────────────────────

const STREAM_HANDLERS: Record<string, StreamHandler> = {
  get_node: (sql, key, _params) => getNode(sql, key),
  taxonomy_topics: (sql, key, _params) => taxonomyTopics(sql, key),
  topic_children: (sql, key, _params) => topicChildren(sql, key),
  topic_ancestors: (sql, key, _params) => topicAncestors(sql, key),
  resource_topics: (sql, key, _params) => resourceTopics(sql, key),
  neighborhood: (sql, key, params) => neighborhood(sql, key, params),
  concern_topics: (sql, key, _params) => concernTopics(sql, key),
  topic_concerns: (sql, key, _params) => topicConcerns(sql, key),
  candidate_concerns_for_resource: (sql, key, _params) => candidateConcernsForResource(sql, key),
};

export function isKnownStream(stream: string): boolean {
  return stream in STREAM_HANDLERS;
}

export function executeStream(
  sql: SqlStorage,
  stream: string,
  key: string,
  params: Record<string, unknown>,
): StreamResult {
  const handler = STREAM_HANDLERS[stream];
  if (!handler) {
    throw new Error(`Unknown stream: ${stream}`);
  }
  return handler(sql, key, params);
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Derive a version number from updated_at timestamps.
 * Uses the max timestamp converted to epoch ms.
 */
function deriveVersion(timestamps: string[]): number {
  if (timestamps.length === 0) return 0;

  let maxTime = 0;
  for (const ts of timestamps) {
    const epoch = new Date(ts + "Z").getTime();
    if (epoch > maxTime) maxTime = epoch;
  }
  return maxTime;
}

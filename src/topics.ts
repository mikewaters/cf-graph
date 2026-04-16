/**
 * TopicClosure maintenance for the topic tree.
 *
 * TopicEdge = direct parent→child
 * TopicClosure = transitive ancestor→descendant with depth property
 */

import { generateEdgeId } from "./uri";

/**
 * After creating a TopicEdge (parent P → child C), maintain the closure table.
 *
 * 1. Add self-closure for C (depth 0) if not present.
 * 2. All ancestors of P (via existing closure) become ancestors of C.
 */
export function maintainClosureOnCreate(
  sql: SqlStorage,
  parentId: string,
  childId: string,
): void {
  // Self-closure for child (depth 0)
  const selfId = `topic-closure:${extractSlug(childId)}--${extractSlug(childId)}`;
  const selfExists = sql
    .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM edges WHERE id = ?", selfId)
    .one().cnt;

  if (selfExists === 0) {
    sql.exec(
      "INSERT INTO edges (id, source_id, target_id, rel_type, properties, created_at, updated_at) VALUES (?, ?, ?, 'TopicClosure', '{\"depth\":0}', datetime('now'), datetime('now'))",
      selfId, childId, childId,
    );
  }

  // Self-closure for parent (depth 0) if not present
  const parentSelfId = `topic-closure:${extractSlug(parentId)}--${extractSlug(parentId)}`;
  const parentSelfExists = sql
    .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM edges WHERE id = ?", parentSelfId)
    .one().cnt;

  if (parentSelfExists === 0) {
    sql.exec(
      "INSERT INTO edges (id, source_id, target_id, rel_type, properties, created_at, updated_at) VALUES (?, ?, ?, 'TopicClosure', '{\"depth\":0}', datetime('now'), datetime('now'))",
      parentSelfId, parentId, parentId,
    );
  }

  // All ancestors of P (including P itself via self-closure) become ancestors of C
  // For each ancestor A of P with depth D, create closure edge A→C with depth D+1
  const ancestors = sql
    .exec<{ source_id: string; depth: number }>(
      "SELECT source_id, CAST(json_extract(properties, '$.depth') AS INTEGER) as depth FROM edges WHERE target_id = ? AND rel_type = 'TopicClosure'",
      parentId,
    )
    .toArray();

  for (const ancestor of ancestors) {
    const newDepth = ancestor.depth + 1;
    const closureId = generateClosureId(ancestor.source_id, childId, newDepth);

    // Check if this closure edge already exists
    const exists = sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM edges WHERE id = ?", closureId)
      .one().cnt;

    if (exists === 0) {
      sql.exec(
        "INSERT INTO edges (id, source_id, target_id, rel_type, properties, created_at, updated_at) VALUES (?, ?, ?, 'TopicClosure', ?, datetime('now'), datetime('now'))",
        closureId, ancestor.source_id, childId, JSON.stringify({ depth: newDepth }),
      );
    }
  }
}

/**
 * After deleting a TopicEdge (parent P → child C), rebuild closure for the
 * entire affected taxonomy.
 *
 * For v1, we do a full closure rebuild: delete all TopicClosure edges for
 * the taxonomy and re-derive from TopicEdge edges. Topic trees are small
 * (hundreds, not millions) and writes are rare.
 */
export function maintainClosureOnDelete(
  sql: SqlStorage,
  parentId: string,
  _childId: string,
): void {
  // Find the taxonomy root by traversing TopicEdge ancestry from the parent
  const taxonomyId = findTaxonomyRoot(sql, parentId);
  if (taxonomyId) {
    rebuildClosureForTaxonomy(sql, taxonomyId);
  }
}

/**
 * Find the taxonomy root for a given node by traversing TopicEdge ancestry.
 * The root is either a TopicTaxonomy node or the topmost node with no parents.
 */
function findTaxonomyRoot(sql: SqlStorage, nodeId: string): string | null {
  let current = nodeId;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(current)) break; // cycle protection
    visited.add(current);

    // Check if current is a TopicTaxonomy node
    const node = sql
      .exec<{ kind: string }>("SELECT kind FROM nodes WHERE id = ?", current)
      .toArray();
    if (node.length > 0 && node[0].kind === "TopicTaxonomy") {
      return current;
    }

    // Find parent via TopicEdge (parent→child means source_id is parent)
    const parent = sql
      .exec<{ source_id: string }>(
        "SELECT source_id FROM edges WHERE target_id = ? AND rel_type = 'TopicEdge' LIMIT 1",
        current,
      )
      .toArray();

    if (parent.length === 0) {
      // No parent found; this node is the root
      return current;
    }

    current = parent[0].source_id;
  }

  return null;
}

/**
 * Rebuild all TopicClosure edges for a taxonomy from scratch.
 *
 * 1. Find all nodes reachable from the taxonomy root via TopicEdge.
 * 2. Delete all TopicClosure edges involving those nodes.
 * 3. Re-derive closure edges using BFS.
 */
export function rebuildClosureForTaxonomy(
  sql: SqlStorage,
  taxonomyNodeId: string,
): void {
  // Collect all nodes in the taxonomy via BFS over TopicEdge
  const allNodes = new Set<string>();
  const queue = [taxonomyNodeId];
  allNodes.add(taxonomyNodeId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = sql
      .exec<{ target_id: string }>(
        "SELECT target_id FROM edges WHERE source_id = ? AND rel_type = 'TopicEdge'",
        current,
      )
      .toArray();

    for (const child of children) {
      if (!allNodes.has(child.target_id)) {
        allNodes.add(child.target_id);
        queue.push(child.target_id);
      }
    }
  }

  // Delete all existing TopicClosure edges for these nodes
  for (const nodeId of allNodes) {
    sql.exec(
      "DELETE FROM edges WHERE (source_id = ? OR target_id = ?) AND rel_type = 'TopicClosure'",
      nodeId, nodeId,
    );
  }

  // Re-derive closure via BFS from each node
  // For each node, add self-closure (depth 0)
  for (const nodeId of allNodes) {
    const selfId = generateClosureId(nodeId, nodeId, 0);
    sql.exec(
      "INSERT INTO edges (id, source_id, target_id, rel_type, properties, created_at, updated_at) VALUES (?, ?, ?, 'TopicClosure', '{\"depth\":0}', datetime('now'), datetime('now'))",
      selfId, nodeId, nodeId,
    );
  }

  // BFS from root, propagating closure edges down
  const bfsQueue: Array<{ nodeId: string; ancestors: Array<{ id: string; depth: number }> }> = [
    { nodeId: taxonomyNodeId, ancestors: [{ id: taxonomyNodeId, depth: 0 }] },
  ];

  const visited = new Set<string>();
  visited.add(taxonomyNodeId);

  while (bfsQueue.length > 0) {
    const { nodeId, ancestors } = bfsQueue.shift()!;

    const children = sql
      .exec<{ target_id: string }>(
        "SELECT target_id FROM edges WHERE source_id = ? AND rel_type = 'TopicEdge'",
        nodeId,
      )
      .toArray();

    for (const child of children) {
      const childId = child.target_id;
      if (visited.has(childId)) continue;
      visited.add(childId);

      // For each ancestor, create closure edge ancestor→child with depth+1
      const childAncestors: Array<{ id: string; depth: number }> = [];
      for (const anc of ancestors) {
        const newDepth = anc.depth + 1;
        const closureId = generateClosureId(anc.id, childId, newDepth);
        sql.exec(
          "INSERT INTO edges (id, source_id, target_id, rel_type, properties, created_at, updated_at) VALUES (?, ?, ?, 'TopicClosure', ?, datetime('now'), datetime('now'))",
          closureId, anc.id, childId, JSON.stringify({ depth: newDepth }),
        );
        childAncestors.push({ id: anc.id, depth: newDepth });
      }

      // Child's own self-closure is already created, add it to ancestors list
      childAncestors.push({ id: childId, depth: 0 });

      bfsQueue.push({ nodeId: childId, ancestors: childAncestors });
    }
  }
}

function extractSlug(curie: string): string {
  return curie.includes(":") ? curie.split(":").slice(1).join(":") : curie;
}

function generateClosureId(sourceId: string, targetId: string, depth: number): string {
  const srcSlug = extractSlug(sourceId);
  const tgtSlug = extractSlug(targetId);
  if (srcSlug === tgtSlug) {
    return `topic-closure:${srcSlug}--${tgtSlug}`;
  }
  return `topic-closure:${srcSlug}--${tgtSlug}-d${depth}`;
}

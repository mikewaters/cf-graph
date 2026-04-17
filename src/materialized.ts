/**
 * Materialized lookup table refresh logic.
 *
 * Pre-computes Concern↔Topic joins so they can be served as single-table reads.
 * - concern_topic_summary: Concern → Topics (UC-1)
 * - topic_concern_summary: Topic → Concerns (UC-2)
 */

/**
 * Refresh concern_topic_summary for a given concern.
 *
 * Path: Concern ←ResourceConcernLink← Resource →ResourceTopicLink→ Topic
 */
export function refreshConcernTopics(sql: SqlStorage, concernId: string): void {
  sql.exec("DELETE FROM concern_topic_summary WHERE concern_id = ?", concernId);

  sql.exec(
    `INSERT INTO concern_topic_summary (concern_id, topic_id, score, resource_count, updated_at)
     SELECT
       rcl.target_id AS concern_id,
       rtl.target_id AS topic_id,
       AVG(COALESCE(json_extract(rtl.properties, '$.confidence'), 0.5)
         * COALESCE(json_extract(rcl.properties, '$.link_confidence'), 0.5)) AS score,
       COUNT(DISTINCT rcl.source_id) AS resource_count,
       datetime('now') AS updated_at
     FROM edges rcl
     JOIN edges rtl ON rcl.source_id = rtl.source_id
     WHERE rcl.rel_type = 'ResourceConcernLink'
       AND rtl.rel_type = 'ResourceTopicLink'
       AND rcl.target_id = ?
     GROUP BY rcl.target_id, rtl.target_id`,
    concernId,
  );
}

/**
 * Refresh topic_concern_summary for a given topic.
 *
 * Path: Topic ←ResourceTopicLink← Resource →ResourceConcernLink→ Concern
 */
export function refreshTopicConcerns(sql: SqlStorage, topicId: string): void {
  sql.exec("DELETE FROM topic_concern_summary WHERE topic_id = ?", topicId);

  sql.exec(
    `INSERT INTO topic_concern_summary (topic_id, concern_id, concern_kind, score, resource_count, updated_at)
     SELECT
       rtl.target_id AS topic_id,
       rcl.target_id AS concern_id,
       n.kind AS concern_kind,
       AVG(COALESCE(json_extract(rtl.properties, '$.confidence'), 0.5)
         * COALESCE(json_extract(rcl.properties, '$.link_confidence'), 0.5)) AS score,
       COUNT(DISTINCT rtl.source_id) AS resource_count,
       datetime('now') AS updated_at
     FROM edges rtl
     JOIN edges rcl ON rtl.source_id = rcl.source_id
     JOIN nodes n ON rcl.target_id = n.id
     WHERE rtl.rel_type = 'ResourceTopicLink'
       AND rcl.rel_type = 'ResourceConcernLink'
       AND rtl.target_id = ?
     GROUP BY rtl.target_id, rcl.target_id, n.kind`,
    topicId,
  );
}

/**
 * Refresh all summaries affected by a resource's edges changing.
 *
 * When a ResourceTopicLink or ResourceConcernLink is created/deleted,
 * we need to refresh summaries for:
 * - All concerns linked to this resource (via ResourceConcernLink)
 * - All topics linked to this resource (via ResourceTopicLink)
 */
export function refreshSummariesForResource(
  sql: SqlStorage,
  resourceId: string,
): void {
  // Find all concerns linked to this resource
  const concerns = sql
    .exec<{ target_id: string }>(
      "SELECT target_id FROM edges WHERE source_id = ? AND rel_type = 'ResourceConcernLink'",
      resourceId,
    )
    .toArray();

  for (const c of concerns) {
    refreshConcernTopics(sql, c.target_id);
  }

  // Find all topics linked to this resource
  const topics = sql
    .exec<{ target_id: string }>(
      "SELECT target_id FROM edges WHERE source_id = ? AND rel_type = 'ResourceTopicLink'",
      resourceId,
    )
    .toArray();

  for (const t of topics) {
    refreshTopicConcerns(sql, t.target_id);
  }
}

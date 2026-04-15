/**
 * Schema migrations for the graph Durable Object's SQLite database.
 *
 * Each migration is a sequentially numbered, idempotent SQL block.
 * Migrations run inside blockConcurrencyWhile() in the DO constructor
 * and are tracked in the _sql_schema_migrations table.
 */

export interface Migration {
  id: number;
  sql: string;
}

export const migrations: Migration[] = [
  // Migration 1: bootstrap — migration tracking table + canonical graph schema
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES nodes(id),
        target_id TEXT NOT NULL REFERENCES nodes(id),
        rel_type TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, rel_type);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, rel_type);
      CREATE INDEX IF NOT EXISTS idx_edges_rel_type ON edges(rel_type);

      INSERT INTO _sql_schema_migrations (id) VALUES (1);
    `,
  },

  // Add new migrations here. Each must end with:
  //   INSERT INTO _sql_schema_migrations (id) VALUES (N);
];

/**
 * Run all pending migrations. Call inside blockConcurrencyWhile().
 */
export function runMigrations(sql: SqlStorage): void {
  // Ensure tracking table exists
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const result = sql
    .exec<{ version: number }>(
      "SELECT COALESCE(MAX(id), 0) as version FROM _sql_schema_migrations",
    )
    .one();
  const currentVersion = result.version;

  for (const migration of migrations) {
    if (migration.id > currentVersion) {
      sql.exec(migration.sql);
    }
  }
}

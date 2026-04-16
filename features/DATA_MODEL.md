# Data Model

This document defines the graph data model — the conceptual schema (from LinkML) and the derived SQLite physical schema that lives inside the GraphDO Durable Object.

## Conceptual Model (LinkML)

<!-- TODO: paste or link the LinkML schema here -->

## Node Types

<!-- Derived from LinkML classes. Each node type becomes a `kind` value in the `nodes` table. -->

| Kind | Description | Key Properties |
|------|-------------|----------------|
| | | |

## Edge Types

<!-- Derived from LinkML slots/relationships. Each becomes a `rel_type` value in the `edges` table. -->

| rel_type | Source Kind | Target Kind | Description | Key Properties |
|----------|------------|-------------|-------------|----------------|
| | | | | |

## Canonical SQLite Schema

The canonical tables store the source-of-truth graph topology. These are generic and type-discriminated.

```sql
-- See src/migrations.ts migration #1 for the current schema.
-- Canonical tables: nodes, edges
-- Tracking table: _sql_schema_migrations
```

## Materialized Lookup Tables

Derived summary tables for hot query paths. Each is tied to a use case in [USE_CASES.md](./USE_CASES.md) and maintained transactionally at write time.

<!-- TODO: define these once use cases are finalized -->

| Table | Use Case | Columns | Updated On |
|-------|----------|---------|------------|
| | | | |

## Property Storage

Node and edge properties are stored as JSON in a `properties TEXT` column. This keeps the schema flexible while the data model is evolving. If specific properties become hot query paths, they can be promoted to indexed columns in a later migration.

## File References

Files stored in R2 are referenced by nodes or edges via a properties entry:

```json
{
  "file": {
    "key": "uploads/abc123.pdf",
    "content_type": "application/pdf",
    "size": 204800,
    "uploaded_at": "2026-04-15T12:00:00Z"
  }
}
```

File content never lives in SQLite. See [ADR-3](./ADRs.md#adr-3-r2-for-large-payloads-presigned-url-uploads).

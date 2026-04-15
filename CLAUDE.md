# cf-graph

A graph store on Cloudflare Durable Objects. See `THIS.md` for a one-liner and `features/` for the specification.

## Architecture

- **Worker** (`src/index.ts`): Entry point. Handles auth, routes HTTP mutations and WebSocket upgrades to the single graph DO. Generates presigned R2 upload URLs.
- **GraphDO** (`src/graph-do.ts`): The Durable Object. Owns all graph state in SQLite. Handles WebSocket subscriptions with hibernation.
- **Migrations** (`src/migrations.ts`): Sequential, idempotent SQL migrations run in the DO constructor via `blockConcurrencyWhile()`. Tracked in `_sql_schema_migrations`.
- **R2**: Stores file uploads. Clients upload directly via presigned URLs; the graph stores only reference keys.

## Key constraints

- Single graph in a single DO instance (id derived from name "default").
- Single-user system. Auth is a shared API key (`API_KEY` secret).
- WebSocket connections are read-only subscription channels. Mutations are HTTP-only.
- Writes are infrequent; concurrent reads from long-lived clients are the primary pattern.
- The data model will change frequently — migrations must be easy to add and test.

## Development

```sh
just install    # npm install
just types      # generate TS types from wrangler config
just dev        # local dev server
just check      # type-check
just deploy     # deploy to Cloudflare
```

## Specification files

- `features/001-do-graph.md` — requirements specification
- `features/USE_CASES.md` — use cases with query families and lookup tables
- `features/ADRs.md` — architectural decision records

## Conventions

- Use `just` (justfile) for task running, not `make`.
- Prefer explicit SQL migrations in `src/migrations.ts` over ad-hoc schema changes.
- Keep node types generic in the platform layer; specific types live in use cases.
- No SSE, no incremental patches, no mutation-over-WebSocket — keep the protocol simple.

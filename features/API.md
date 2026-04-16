# HTTP API

Defines the HTTP endpoints exposed by the Worker. All requests require `Authorization: Bearer <API_KEY>`.

## Endpoints

### Health

```
GET /health
```

Returns `200 ok`. No auth required (TODO: decide).

### Graph Mutations

All mutation endpoints route through the Worker to the GraphDO.

#### Create Node

```
POST /graph/nodes
Content-Type: application/json

{
  "id": "optional-client-id",
  "kind": "project",
  "properties": { ... }
}
```

Response: `201 Created`
```json
{
  "id": "generated-or-provided-id",
  "kind": "project",
  "properties": { ... },
  "created_at": "...",
  "updated_at": "..."
}
```

#### Update Node

```
PATCH /graph/nodes/:id
Content-Type: application/json

{
  "properties": { ... }
}
```

Response: `200 OK`

#### Delete Node

```
DELETE /graph/nodes/:id
```

Response: `204 No Content`

Deleting a node also deletes all edges where it is source or target.

#### Create Edge

```
POST /graph/edges
Content-Type: application/json

{
  "id": "optional-client-id",
  "source_id": "node-abc",
  "target_id": "node-def",
  "rel_type": "has_topic",
  "properties": { ... }
}
```

Response: `201 Created`

#### Update Edge

```
PATCH /graph/edges/:id
Content-Type: application/json

{
  "properties": { ... }
}
```

Response: `200 OK`

#### Delete Edge

```
DELETE /graph/edges/:id
```

Response: `204 No Content`

### File Operations

Files are stored in R2 via the Worker (see [ADR-3](./ADRs.md#adr-3-r2-for-large-payloads-worker-proxied-uploads)). The Worker streams request bodies to/from R2; file content never enters the Durable Object.

#### Upload File

```
PUT /files/:key
Content-Type: application/pdf

<binary body>
```

Response: `200 OK`
```json
{
  "key": "uploads/my-file.pdf",
  "size": 204800,
  "contentType": "application/pdf"
}
```

The client then creates or updates the relevant node or edge with the file reference key in its properties. Max file size: 100MB (Worker request body limit).

#### Download File

```
GET /files/:key
```

Response: `200 OK` with the file body and appropriate `Content-Type` header. Returns `404` if the key does not exist.

#### Delete File

```
DELETE /files/:key
```

Response: `204 No Content`

### WebSocket

```
GET /ws
Upgrade: websocket
```

Upgrades to a WebSocket connection routed to the GraphDO. See [PROTOCOL.md](./PROTOCOL.md) for the message format.

## Error Responses

All errors return JSON:

```json
{
  "error": "description of what went wrong"
}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (missing/invalid fields) |
| 401 | Unauthorized (missing or invalid API key) |
| 404 | Not found (unknown route or entity) |
| 501 | Not implemented (stub endpoint) |

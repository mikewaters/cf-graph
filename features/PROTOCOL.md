# WebSocket Subscription Protocol

Defines the message protocol for the read-only WebSocket subscription channel between clients and the GraphDO Durable Object. See [001-do-graph.md](./001-do-graph.md) for the requirements this implements.

## Connection Lifecycle

1. Client opens a WebSocket to the Worker (`/ws`).
2. Worker authenticates (API key in query param or header) and upgrades to the GraphDO.
3. Client sends `subscribe` messages to register for query family streams.
4. Server sends `snapshot` for each subscription (initial data + on every change).
5. Client sends `unsubscribe` to stop receiving updates.
6. Connection may hibernate (DO sleeps, socket stays open). On wake, subscriptions resume from attachment metadata.

## Client Messages

### subscribe

```json
{
  "type": "subscribe",
  "requestId": "req-001",
  "stream": "project_topics",
  "key": "project:123",
  "params": { "limit": 10 }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | `"subscribe"` | yes | |
| requestId | string | yes | Client-generated, for tracing |
| stream | string | yes | Query family name |
| key | string | yes | Logical key (e.g. `project:123`) |
| params | object | no | Query parameters (limit, order, etc.) |

### unsubscribe

```json
{
  "type": "unsubscribe",
  "requestId": "req-002",
  "stream": "project_topics",
  "key": "project:123"
}
```

### ping

```json
{ "type": "ping" }
```

## Server Messages

### snapshot

Sent on initial subscribe and whenever the underlying data changes.

```json
{
  "type": "snapshot",
  "stream": "project_topics",
  "key": "project:123",
  "version": 43,
  "items": [...]
}
```

| Field | Type | Description |
|-------|------|-------------|
| type | `"snapshot"` | |
| stream | string | Query family name |
| key | string | Logical key |
| version | number | Monotonic version for this stream+key |
| items | array | Full result set |

### invalidated

Sent when a subscription's data has changed but the server cannot compute a snapshot (e.g. query family not yet implemented).

```json
{
  "type": "invalidated",
  "stream": "project_topics",
  "key": "project:123"
}
```

### error

```json
{
  "type": "error",
  "requestId": "req-001",
  "code": "unknown_stream",
  "message": "No query family named 'foo'"
}
```

### pong

```json
{ "type": "pong" }
```

## Hibernation

Subscription state is stored in WebSocket attachment data (serialized JSON). On DO rehydration, attachments are read to reconstruct the subscription registry without requiring the client to re-subscribe.

Attachment format (compact):

```json
{
  "subs": [
    { "stream": "project_topics", "key": "project:123", "params": {} }
  ]
}
```

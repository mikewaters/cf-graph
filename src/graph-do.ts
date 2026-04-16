import { DurableObject } from "cloudflare:workers";
import { runMigrations } from "./migrations";
import { generateNodeId, generateEdgeId } from "./uri";
import { maintainClosureOnCreate, maintainClosureOnDelete, rebuildClosureForTaxonomy } from "./topics";
import { refreshSummariesForResource, refreshConcernTopics, refreshTopicConcerns } from "./materialized";
import { executeStream, isKnownStream } from "./streams";
import type { Env } from "./index";

type NodeRow = {
  id: string;
  kind: string;
  properties: string;
  created_at: string;
  updated_at: string;
  [key: string]: SqlStorageValue;
};

type EdgeRow = {
  id: string;
  source_id: string;
  target_id: string;
  rel_type: string;
  properties: string;
  created_at: string;
  updated_at: string;
  [key: string]: SqlStorageValue;
};

interface Subscription {
  stream: string;
  key: string;
  params: Record<string, unknown>;
}

interface SocketAttachment {
  subs: Subscription[];
}

export class GraphDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      runMigrations(this.sql);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname.startsWith("/graph")) {
      return this.handleGraphRequest(request, url);
    }

    return new Response("Not Found", { status: 404 });
  }

  // ─── HTTP mutation routing ───────────────────────────────────────

  private async handleGraphRequest(
    request: Request,
    url: URL,
  ): Promise<Response> {
    try {
      // POST /graph/batch
      if (url.pathname === "/graph/batch" && request.method === "POST") {
        return await this.handleBatch(request);
      }

      // /graph/nodes routes
      if (url.pathname === "/graph/nodes" && request.method === "POST") {
        return await this.createNode(request);
      }

      const nodesMatch = url.pathname.match(/^\/graph\/nodes\/(.+)$/);
      if (nodesMatch) {
        const id = decodeURIComponent(nodesMatch[1]);
        switch (request.method) {
          case "GET": return this.getNode(id);
          case "PATCH": return await this.updateNode(id, request);
          case "DELETE": return this.deleteNode(id);
        }
      }

      // /graph/edges routes
      if (url.pathname === "/graph/edges" && request.method === "POST") {
        return await this.createEdge(request);
      }

      const edgesMatch = url.pathname.match(/^\/graph\/edges\/(.+)$/);
      if (edgesMatch) {
        const id = decodeURIComponent(edgesMatch[1]);
        switch (request.method) {
          case "GET": return this.getEdge(id);
          case "PATCH": return await this.updateEdge(id, request);
          case "DELETE": return this.deleteEdge(id);
        }
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // ─── Node CRUD ──────────────────────────────────────────────────

  private async createNode(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      kind?: string;
      title?: string;
      properties?: Record<string, unknown>;
    };

    if (!body.kind) {
      throw new HttpError(400, "kind is required");
    }

    const id = generateNodeId(this.sql, body.kind, body.title);
    const props = JSON.stringify(body.properties ?? {});

    this.sql.exec(
      "INSERT INTO nodes (id, kind, properties, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
      id, body.kind, props,
    );

    const row = this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE id = ?", id).one();
    const node = formatNode(row);

    this.fanOutAfterMutation();
    return Response.json(node, { status: 201 });
  }

  private getNode(id: string): Response {
    const row = this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE id = ?", id).toArray();
    if (row.length === 0) {
      throw new HttpError(404, "Node not found");
    }
    return Response.json(formatNode(row[0]));
  }

  private async updateNode(id: string, request: Request): Promise<Response> {
    const existing = this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE id = ?", id).toArray();
    if (existing.length === 0) {
      throw new HttpError(404, "Node not found");
    }

    const body = (await request.json()) as {
      properties?: Record<string, unknown>;
    };

    if (body.properties) {
      const patchJson = JSON.stringify(body.properties);
      this.sql.exec(
        "UPDATE nodes SET properties = json_patch(properties, ?), updated_at = datetime('now') WHERE id = ?",
        patchJson, id,
      );
    }

    const row = this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE id = ?", id).one();
    const node = formatNode(row);

    this.fanOutAfterMutation();
    return Response.json(node);
  }

  private deleteNode(id: string): Response {
    // Cascade-delete edges, then the node, all in one transaction
    this.sql.exec("DELETE FROM edges WHERE source_id = ? OR target_id = ?", id, id);
    this.sql.exec("DELETE FROM nodes WHERE id = ?", id);

    // Clean up any summary table rows referencing this node
    this.sql.exec("DELETE FROM concern_topic_summary WHERE concern_id = ? OR topic_id = ?", id, id);
    this.sql.exec("DELETE FROM topic_concern_summary WHERE concern_id = ? OR topic_id = ?", id, id);

    this.fanOutAfterMutation();
    return new Response(null, { status: 204 });
  }

  // ─── Edge CRUD ──────────────────────────────────────────────────

  private async createEdge(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      source_id?: string;
      target_id?: string;
      rel_type?: string;
      properties?: Record<string, unknown>;
    };

    return this.createEdgeFromBody(body);
  }

  createEdgeFromBody(body: {
    source_id?: string;
    target_id?: string;
    rel_type?: string;
    properties?: Record<string, unknown>;
  }): Response {
    if (!body.source_id || !body.target_id || !body.rel_type) {
      throw new HttpError(400, "source_id, target_id, and rel_type are required");
    }

    // Verify source and target nodes exist
    const srcCount = this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM nodes WHERE id = ?", body.source_id,
    ).one().cnt;
    if (srcCount === 0) {
      throw new HttpError(400, `Source node not found: ${body.source_id}`);
    }

    const tgtCount = this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM nodes WHERE id = ?", body.target_id,
    ).one().cnt;
    if (tgtCount === 0) {
      throw new HttpError(400, `Target node not found: ${body.target_id}`);
    }

    const id = generateEdgeId(this.sql, body.rel_type, body.source_id, body.target_id);
    const props = JSON.stringify(body.properties ?? {});

    this.sql.exec(
      "INSERT INTO edges (id, source_id, target_id, rel_type, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
      id, body.source_id, body.target_id, body.rel_type, props,
    );

    // Topic closure maintenance
    if (body.rel_type === "TopicEdge") {
      maintainClosureOnCreate(this.sql, body.source_id, body.target_id);
    }

    // Materialized summary maintenance
    if (body.rel_type === "ResourceTopicLink" || body.rel_type === "ResourceConcernLink") {
      refreshSummariesForResource(this.sql, body.source_id);
    }

    const row = this.sql.exec<EdgeRow>("SELECT * FROM edges WHERE id = ?", id).one();
    const edge = formatEdge(row);

    this.fanOutAfterMutation();
    return Response.json(edge, { status: 201 });
  }

  private getEdge(id: string): Response {
    const row = this.sql.exec<EdgeRow>("SELECT * FROM edges WHERE id = ?", id).toArray();
    if (row.length === 0) {
      throw new HttpError(404, "Edge not found");
    }
    return Response.json(formatEdge(row[0]));
  }

  private async updateEdge(id: string, request: Request): Promise<Response> {
    const existing = this.sql.exec<EdgeRow>("SELECT * FROM edges WHERE id = ?", id).toArray();
    if (existing.length === 0) {
      throw new HttpError(404, "Edge not found");
    }

    const body = (await request.json()) as {
      properties?: Record<string, unknown>;
    };

    if (body.properties) {
      const patchJson = JSON.stringify(body.properties);
      this.sql.exec(
        "UPDATE edges SET properties = json_patch(properties, ?), updated_at = datetime('now') WHERE id = ?",
        patchJson, id,
      );
    }

    const row = this.sql.exec<EdgeRow>("SELECT * FROM edges WHERE id = ?", id).one();
    const edge = formatEdge(row);

    // Refresh summaries if relevant edge type
    if (row.rel_type === "ResourceTopicLink" || row.rel_type === "ResourceConcernLink") {
      refreshSummariesForResource(this.sql, row.source_id);
    }

    this.fanOutAfterMutation();
    return Response.json(edge);
  }

  private deleteEdge(id: string): Response {
    const existing = this.sql.exec<EdgeRow>("SELECT * FROM edges WHERE id = ?", id).toArray();

    if (existing.length > 0) {
      const edge = existing[0];

      // Delete the edge first
      this.sql.exec("DELETE FROM edges WHERE id = ?", id);

      // Topic closure maintenance (must happen AFTER the edge is deleted
      // so the rebuild doesn't see the removed TopicEdge)
      if (edge.rel_type === "TopicEdge") {
        maintainClosureOnDelete(this.sql, edge.source_id, edge.target_id);
      }

      // Refresh summaries if relevant edge type
      if (edge.rel_type === "ResourceTopicLink" || edge.rel_type === "ResourceConcernLink") {
        refreshSummariesForResource(this.sql, edge.source_id);
      }
    }

    this.fanOutAfterMutation();
    return new Response(null, { status: 204 });
  }

  // ─── Batch endpoint ─────────────────────────────────────────────

  private async handleBatch(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      nodes?: Array<{
        kind: string;
        title?: string;
        properties?: Record<string, unknown>;
      }>;
      edges?: Array<{
        source_id: string;
        target_id: string;
        rel_type: string;
        properties?: Record<string, unknown>;
      }>;
    };

    const nodes = body.nodes ?? [];
    const edges = body.edges ?? [];
    const createdNodes: Array<ReturnType<typeof formatNode>> = [];
    const createdEdges: Array<ReturnType<typeof formatEdge>> = [];
    const nodeIdMap: string[] = []; // index -> generated id

    // Everything in a single transaction via ingest
    // SQLite in DO is auto-transactional per synchronous block,
    // so we do all operations synchronously.

    // 1. Create all nodes
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.kind) {
        throw new HttpError(400, `Node at index ${i} is missing 'kind'`);
      }

      const id = generateNodeId(this.sql, n.kind, n.title);
      const props = JSON.stringify(n.properties ?? {});

      this.sql.exec(
        "INSERT INTO nodes (id, kind, properties, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
        id, n.kind, props,
      );

      nodeIdMap.push(id);
      const row = this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE id = ?", id).one();
      createdNodes.push(formatNode(row));
    }

    // 2. Resolve $N references and create edges
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      let sourceId = e.source_id;
      let targetId = e.target_id;

      // Resolve back-references
      if (sourceId.startsWith("$")) {
        const idx = parseInt(sourceId.slice(1), 10);
        if (isNaN(idx) || idx < 0 || idx >= nodeIdMap.length) {
          throw new HttpError(400, `Invalid back-reference '${sourceId}' in edge at index ${i}`);
        }
        sourceId = nodeIdMap[idx];
      }
      if (targetId.startsWith("$")) {
        const idx = parseInt(targetId.slice(1), 10);
        if (isNaN(idx) || idx < 0 || idx >= nodeIdMap.length) {
          throw new HttpError(400, `Invalid back-reference '${targetId}' in edge at index ${i}`);
        }
        targetId = nodeIdMap[idx];
      }

      if (!e.rel_type) {
        throw new HttpError(400, `Edge at index ${i} is missing 'rel_type'`);
      }

      // Verify both endpoints exist
      const srcCount = this.sql.exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM nodes WHERE id = ?", sourceId,
      ).one().cnt;
      if (srcCount === 0) {
        throw new HttpError(400, `Source node not found: ${sourceId}`);
      }

      const tgtCount = this.sql.exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM nodes WHERE id = ?", targetId,
      ).one().cnt;
      if (tgtCount === 0) {
        throw new HttpError(400, `Target node not found: ${targetId}`);
      }

      const id = generateEdgeId(this.sql, e.rel_type, sourceId, targetId);
      const props = JSON.stringify(e.properties ?? {});

      this.sql.exec(
        "INSERT INTO edges (id, source_id, target_id, rel_type, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        id, sourceId, targetId, e.rel_type, props,
      );

      // Topic closure maintenance
      if (e.rel_type === "TopicEdge") {
        maintainClosureOnCreate(this.sql, sourceId, targetId);
      }

      const row = this.sql.exec<EdgeRow>("SELECT * FROM edges WHERE id = ?", id).one();
      createdEdges.push(formatEdge(row));
    }

    // Refresh summaries for any resource-related edges
    const resourceIds = new Set<string>();
    for (const e of edges) {
      if (e.rel_type === "ResourceTopicLink" || e.rel_type === "ResourceConcernLink") {
        let sourceId = e.source_id;
        if (sourceId.startsWith("$")) {
          const idx = parseInt(sourceId.slice(1), 10);
          sourceId = nodeIdMap[idx];
        }
        resourceIds.add(sourceId);
      }
    }
    for (const rid of resourceIds) {
      refreshSummariesForResource(this.sql, rid);
    }

    this.fanOutAfterMutation();
    return Response.json({ nodes: createdNodes, edges: createdEdges }, { status: 201 });
  }

  // ─── WebSocket handling ─────────────────────────────────────────

  private handleWebSocketUpgrade(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    // Initialize empty subscription list
    const attachment: SocketAttachment = { subs: [] };
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "parse_error", message: "Invalid JSON" }));
      return;
    }

    switch (data.type) {
      case "subscribe":
        this.handleSubscribe(ws, data);
        break;
      case "unsubscribe":
        this.handleUnsubscribe(ws, data);
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      default:
        ws.send(JSON.stringify({
          type: "error",
          requestId: data.requestId,
          code: "unknown_type",
          message: `Unknown message type: ${data.type}`,
        }));
    }
  }

  private handleSubscribe(ws: WebSocket, data: Record<string, unknown>): void {
    const stream = data.stream as string;
    const key = data.key as string;
    const params = (data.params ?? {}) as Record<string, unknown>;
    const requestId = data.requestId as string | undefined;

    if (!stream || !key) {
      ws.send(JSON.stringify({
        type: "error",
        requestId,
        code: "invalid_request",
        message: "stream and key are required",
      }));
      return;
    }

    if (!isKnownStream(stream)) {
      ws.send(JSON.stringify({
        type: "error",
        requestId,
        code: "unknown_stream",
        message: `No query family named '${stream}'`,
      }));
      return;
    }

    // Add to attachment
    const attachment = ws.deserializeAttachment() as SocketAttachment;
    // Avoid duplicate subscriptions
    const alreadySubscribed = attachment.subs.some(
      (s) => s.stream === stream && s.key === key,
    );
    if (!alreadySubscribed) {
      attachment.subs.push({ stream, key, params });
      ws.serializeAttachment(attachment);
    }

    // Send initial snapshot
    const result = executeStream(this.sql, stream, key, params);
    ws.send(JSON.stringify({
      type: "snapshot",
      stream,
      key,
      version: result.version,
      items: result.items,
    }));
  }

  private handleUnsubscribe(ws: WebSocket, data: Record<string, unknown>): void {
    const stream = data.stream as string;
    const key = data.key as string;

    const attachment = ws.deserializeAttachment() as SocketAttachment;
    attachment.subs = attachment.subs.filter(
      (s) => !(s.stream === stream && s.key === key),
    );
    ws.serializeAttachment(attachment);
    // No response message per protocol spec
  }

  // ─── Fan-out ────────────────────────────────────────────────────

  /**
   * After any mutation, iterate all connected WebSockets and re-evaluate
   * all subscriptions, sending snapshots for each.
   *
   * Conservative approach: re-evaluate everything. Single-user, few-clients
   * scenario means this is O(small).
   */
  private fanOutAfterMutation(): void {
    const sockets = this.ctx.getWebSockets();

    for (const ws of sockets) {
      let attachment: SocketAttachment;
      try {
        attachment = ws.deserializeAttachment() as SocketAttachment;
      } catch {
        continue;
      }
      if (!attachment?.subs) continue;

      for (const sub of attachment.subs) {
        try {
          const result = executeStream(this.sql, sub.stream, sub.key, sub.params);
          ws.send(JSON.stringify({
            type: "snapshot",
            stream: sub.stream,
            key: sub.key,
            version: result.version,
            items: result.items,
          }));
        } catch {
          // Skip failed stream executions during fan-out
        }
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close(1011, "Unexpected error");
  }
}

// ─── Helpers ────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function formatNode(row: NodeRow) {
  return {
    id: row.id,
    kind: row.kind,
    properties: JSON.parse(row.properties),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatEdge(row: EdgeRow) {
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    rel_type: row.rel_type,
    properties: JSON.parse(row.properties),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

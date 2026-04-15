import { DurableObject } from "cloudflare:workers";
import { runMigrations } from "./migrations";
import type { Env } from "./index";

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

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    // HTTP mutation routes
    if (url.pathname.startsWith("/graph")) {
      return this.handleGraphRequest(request, url);
    }

    return new Response("Not Found", { status: 404 });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleGraphRequest(
    request: Request,
    url: URL,
  ): Promise<Response> {
    // TODO: implement mutation routing
    return Response.json({ status: "not implemented" }, { status: 501 });
  }

  // --- WebSocket hibernation handlers ---

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;

    const data = JSON.parse(message);

    switch (data.type) {
      case "subscribe":
        // TODO: register subscription, send initial snapshot
        break;
      case "unsubscribe":
        // TODO: remove subscription
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    ws.close(1011, "Unexpected error");
  }
}

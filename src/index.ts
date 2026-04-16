import { GraphDO } from "./graph-do";

export { GraphDO };

export interface Env {
  GRAPH_DO: DurableObjectNamespace<GraphDO>;
  FILES_BUCKET: R2Bucket;
  API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check (no auth required)
    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // Auth check
    const apiKey = request.headers.get("Authorization")?.replace("Bearer ", "");
    if (apiKey !== env.API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    // R2 file proxy — handled directly in the Worker, not routed to the DO
    if (url.pathname.startsWith("/files/")) {
      return handleFileRequest(request, url, env);
    }

    // All graph/ws requests route to the single graph DO
    const id = env.GRAPH_DO.idFromName("default");
    const stub = env.GRAPH_DO.get(id);

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return stub.fetch(request);
    }

    // Graph mutations route to the DO
    if (url.pathname.startsWith("/graph")) {
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleFileRequest(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const key = url.pathname.slice("/files/".length);
  if (!key) {
    return Response.json({ error: "File key is required" }, { status: 400 });
  }

  switch (request.method) {
    case "PUT": {
      const contentType =
        request.headers.get("Content-Type") || "application/octet-stream";
      await env.FILES_BUCKET.put(key, request.body, {
        httpMetadata: { contentType },
      });
      return Response.json({
        key,
        size: request.headers.get("Content-Length"),
        contentType,
      });
    }

    case "GET": {
      const obj = await env.FILES_BUCKET.get(key);
      if (!obj) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(obj.body, {
        headers: {
          "Content-Type":
            obj.httpMetadata?.contentType || "application/octet-stream",
        },
      });
    }

    case "DELETE": {
      await env.FILES_BUCKET.delete(key);
      return new Response(null, { status: 204 });
    }

    default:
      return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
}

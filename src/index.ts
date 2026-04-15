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

    // Auth check
    const apiKey = request.headers.get("Authorization")?.replace("Bearer ", "");
    if (apiKey !== env.API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    // All requests route to the single graph DO
    const id = env.GRAPH_DO.idFromName("default");
    const stub = env.GRAPH_DO.get(id);

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return stub.fetch(request);
    }

    // HTTP routes
    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // Presigned upload URL generation
    if (url.pathname === "/upload-url" && request.method === "POST") {
      return handleUploadUrl(request, env);
    }

    // Graph mutations route to the DO
    if (url.pathname.startsWith("/graph")) {
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleUploadUrl(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = (await request.json()) as {
    key: string;
    contentType?: string;
  };

  if (!body.key) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }

  // TODO: generate presigned R2 PUT URL
  // This requires R2 API credentials (not the binding) for presigned URLs.
  // For now, stub the response shape.
  return Response.json({
    key: body.key,
    uploadUrl: "TODO: presigned URL generation requires R2 API credentials",
    expiresIn: 3600,
  });
}

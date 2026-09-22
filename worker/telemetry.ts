// App-Health endpoint telemetry: per-route method/status/duration shipped to
// the ingest collector. Silent no-op until APP_HEALTH_INGEST_KEY is set —
// routes stay unobserved in local/test runs. Cache hits are recorded too so
// the dashboard shows traffic shape and hit ratio, not just origin cost.
import { createAppHealthClient } from "@saas-maker/app-health";

const INGEST_ENDPOINT = "https://ingest.sassmaker.com/v1/ingest";

// Route templates — telemetry must never leak raw path params (ids, slugs).
function routeFor(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/products") return "/api/products";
  if (/^\/api\/products\/[^/]+$/.test(path)) return "/api/products/:id";
  if (/^\/products\/[^/]+\.md$/.test(path)) return "/products/:id.md";
  if (/^\/products\/[^/]+$/.test(path)) return "/products/:id";
  const exact = [
    "/",
    "/api/coverage",
    "/api/ai",
    "/health",
    "/sitemap.xml",
    "/llms.txt",
    "/llms-full.txt",
    "/index.md",
  ];
  return exact.includes(path) ? path : null;
}

export function observeRequest(
  request: Request,
  response: Response,
  startedAt: number,
  env: Env,
  ctx: ExecutionContext,
  edgeCache: "hit" | "miss" | "bypass",
): void {
  const key = typeof env.APP_HEALTH_INGEST_KEY === "string" ? env.APP_HEALTH_INGEST_KEY.trim() : "";
  const route = routeFor(new URL(request.url).pathname);
  if (!key || !route) return;
  try {
    const client = createAppHealthClient({
      key,
      endpoint: INGEST_ENDPOINT,
      environment: "production",
      runtime: "worker",
      maxQueueSize: 2,
      maxBatchSize: 2,
      maxRetries: 0,
      requestTimeoutMs: 1000,
      disableTimer: true,
    });
    client.record({
      method: request.method,
      route,
      status_code: response.status,
      duration_ms: Math.max(0, Math.round(Date.now() - startedAt)),
    });
    // Cache hits/misses ride along as a log event so hit ratio is visible per
    // route — record() only accepts endpoint-summary fields.
    client.log("edge_cache", {
      level: "info",
      props: { route, edge_cache: edgeCache },
    });
    ctx.waitUntil(client.flush().catch(() => undefined));
  } catch {
    // Telemetry must never take down the request path.
  }
}

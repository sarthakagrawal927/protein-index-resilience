import { Hono } from "hono";
import type { ReviewDecision, ReviewStatus, ReviewType } from "../shared/api";
import {
  INDEX_MD,
  LLMS_TXT,
  buildApiAiCatalog,
  buildSitemapXml,
  isActivePublicProduct,
  listPublicProductRoutes,
  productToHtml,
  productToMarkdown,
} from "./agent-index";
import { getProductDetail, searchProducts, validateSearch } from "./catalog";
import {
  getCompletionLabels,
  getCompletionLedger,
  validateCompletionLabels,
  validateCompletionLedger,
} from "./completion";
import { getCoverage } from "./coverage";
import { verifyProductIdentity } from "./identity-evidence";
import { listReviews, resolveReview } from "./reviews";
import { observeRequest } from "./telemetry";
import {
  listTerminalEvidence,
  recordTerminalEvidence,
  validateTerminalEvidenceList,
} from "./terminal-evidence";

export const app = new Hono<{ Bindings: Env }>();

function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function text(body: string, type: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=300",
    },
  });
}

// --- Agent / LLM indexing (must win over SPA asset fallback) ---
app.get("/llms.txt", (c) => text(LLMS_TXT, "text/plain; charset=utf-8"));
app.get("/index.md", (c) => text(INDEX_MD, "text/markdown; charset=utf-8"));
app.get("/sitemap.xml", async (c) => {
  const origin = new URL(c.req.url).origin;
  return text(buildSitemapXml(await listPublicProductRoutes(c.env.DB), origin), "application/xml; charset=utf-8");
});
app.get("/api/ai", async (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json(buildApiAiCatalog(await listPublicProductRoutes(c.env.DB), origin));
});
app.get("/products/:id{[^/]+\\.md}", async (c) => {
  const pathId = c.req.param("id") ?? "";
  const id = pathId.endsWith(".md") ? pathId.slice(0, -3) : "";
  if (!(await isActivePublicProduct(c.env.DB, id))) {
    return text("# Not found\n\nProduct not found.\n", "text/markdown; charset=utf-8", 404);
  }
  const product = await getProductDetail(c.env.DB, id);
  if (!product) return text("# Not found\n\nProduct not found.\n", "text/markdown; charset=utf-8", 404);
  return text(productToMarkdown(product as unknown as Record<string, unknown>, new URL(c.req.url).origin), "text/markdown; charset=utf-8");
});
app.get("/products/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await isActivePublicProduct(c.env.DB, id))) {
    return text("<!doctype html><title>Product not found</title><h1>Product not found</h1>", "text/html; charset=utf-8", 404);
  }
  const product = await getProductDetail(c.env.DB, id);
  if (!product) return text("<!doctype html><title>Product not found</title><h1>Product not found</h1>", "text/html; charset=utf-8", 404);
  return text(productToHtml(product as unknown as Record<string, unknown>, new URL(c.req.url).origin), "text/html; charset=utf-8");
});
app.get("/api/products/:id{[^/]+\\.md}", async (c) => {
  const pathId = c.req.param("id") ?? "";
  const id = pathId.endsWith(".md") ? pathId.slice(0, -3) : "";
  const product = await getProductDetail(c.env.DB, id);
  if (!product) {
    return text("# Not found\n\nProduct not found.\n", "text/markdown; charset=utf-8", 404);
  }
  return text(
    productToMarkdown(product as unknown as Record<string, unknown>, new URL(c.req.url).origin),
    "text/markdown; charset=utf-8"
  );
});

app.get("/api/health", async (c) => {
  const [productResult, runResult] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS products FROM products WHERE is_active = 1"),
    c.env.DB.prepare("SELECT completed_at, source_complete FROM ingestion_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1"),
  ]);
  const products = productResult?.results[0] as { products?: number } | undefined;
  const run = runResult?.results[0] as { completed_at?: string | null; source_complete?: number | null } | undefined;
  const hostname = new URL(c.req.url).hostname;
  const runtime = ["localhost", "127.0.0.1", "::1"].includes(hostname) ? "local" : "production";
  return c.json({
    status: "ok",
    products: products?.products ?? 0,
    runtime,
    latestPublishedAt: run?.completed_at ?? null,
    sourceComplete: run?.source_complete === undefined || run.source_complete === null ? null : run.source_complete === 1,
    mutations: "local_only",
  });
});

app.get("/api/products", async (c) => {
  const parsed = validateSearch(new URL(c.req.url).searchParams);
  if (!parsed.value) return c.json(errorBody("validation_error", parsed.error ?? "Invalid query"), 400);
  return c.json(await searchProducts(c.env.DB, parsed.value));
});

app.get("/api/products/:id", async (c) => {
  const product = await getProductDetail(c.env.DB, c.req.param("id"));
  return product ? c.json(product) : c.json(errorBody("not_found", "Product not found"), 404);
});

app.get("/api/products/:productId/terminal-evidence", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    return c.json(errorBody(
      "mutations_disabled",
      "Terminal evidence review is local-only until operator authentication is configured",
    ), 403);
  }
  const productId = c.req.param("productId");
  if (!productId || productId.length > 512) {
    return c.json(errorBody("validation_error", "Invalid product ID"), 400);
  }
  const parsed = validateTerminalEvidenceList(new URL(c.req.url).searchParams);
  if (!parsed.value) return c.json(errorBody("validation_error", parsed.error ?? "Invalid evidence filters"), 400);
  const response = await listTerminalEvidence(c.env.DB, productId, parsed.value);
  return response ? c.json(response) : c.json(errorBody("not_found", "Product not found"), 404);
});

app.post("/api/products/:productId/terminal-evidence", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    return c.json(errorBody(
      "mutations_disabled",
      "Terminal evidence mutations are local-only until operator authentication is configured",
    ), 403);
  }
  const productId = c.req.param("productId");
  if (!productId || productId.length > 512) {
    return c.json(errorBody("validation_error", "Invalid product ID"), 400);
  }
  const body: unknown = await c.req.json().catch(() => null);
  const result = await recordTerminalEvidence(c.env.DB, productId, body);
  if (!("error" in result)) return c.json(result, result.status === "created" ? 201 : 200);
  if (result.error === "validation_error") {
    return c.json(errorBody("validation_error", result.message, result.details), 400);
  }
  if (result.error === "not_found") return c.json(errorBody("not_found", result.message, result.details), 404);
  if (result.error === "stale_evidence") return c.json(errorBody("stale_evidence", result.message, result.details), 409);
  return c.json(errorBody("conflict", result.message, result.details), 409);
});

app.post("/api/products/:productId/identity-evidence", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    return c.json(errorBody(
      "mutations_disabled",
      "Identity evidence mutations are local-only until operator authentication is configured",
    ), 403);
  }
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json(errorBody("validation_error", "Expected a JSON object"), 400);
  }
  const input = body as Record<string, unknown>;
  const expectedKeys = ["sourceRecordId", "evidenceUrl", "rationale"];
  if (Object.keys(input).some((key) => !expectedKeys.includes(key))) {
    return c.json(errorBody("validation_error", "Identity evidence contains unsupported fields"), 400);
  }
  if (typeof input.sourceRecordId !== "string" || input.sourceRecordId.trim().length < 1 || input.sourceRecordId.length > 256) {
    return c.json(errorBody("validation_error", "A current source record ID is required"), 400);
  }
  if (typeof input.rationale !== "string" || input.rationale.trim().length < 3 || input.rationale.length > 2_000) {
    return c.json(errorBody("validation_error", "A rationale between 3 and 2,000 characters is required"), 400);
  }
  if (typeof input.evidenceUrl !== "string" || input.evidenceUrl.length > 2_048) {
    return c.json(errorBody("validation_error", "A current HTTPS evidence URL is required"), 400);
  }
  let evidenceUrl: string;
  try {
    const parsed = new URL(input.evidenceUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("unsafe URL");
    evidenceUrl = parsed.href;
  } catch {
    return c.json(errorBody("validation_error", "Evidence URL must use HTTPS without embedded credentials"), 400);
  }
  const result = await verifyProductIdentity(c.env.DB, c.req.param("productId"), {
    sourceRecordId: input.sourceRecordId.trim(),
    evidenceUrl,
    rationale: input.rationale.trim(),
  });
  if (result.status === "not_found") return c.json(errorBody("not_found", "Active product not found"), 404);
  if (result.status === "invalid_binding") {
    return c.json(errorBody(
      "validation_error",
      "Source record is not a current exact identity binding for this product",
      result.errors ? { errors: result.errors } : undefined,
    ), 400);
  }
  if (result.status === "conflict") {
    return c.json(errorBody("conflict", "A different immutable identity decision already exists for this binding"), 409);
  }
  return c.json(result, result.idempotent ? 200 : 201);
});

app.get("/api/coverage", async (c) => c.json(await getCoverage(c.env.DB)));

app.get("/api/completion-ledger", async (c) => {
  const parsed = validateCompletionLedger(new URL(c.req.url).searchParams);
  if (!parsed.value) return c.json(errorBody("validation_error", parsed.error ?? "Invalid completion filters"), 400);
  return c.json(await getCompletionLedger(c.env.DB, parsed.value));
});

app.get("/api/completion-ledger/:productId/labels", async (c) => {
  const parsed = validateCompletionLabels(new URL(c.req.url).searchParams);
  if (!parsed.value) return c.json(errorBody("validation_error", parsed.error ?? "Invalid label filters"), 400);
  const result = await getCompletionLabels(c.env.DB, c.req.param("productId"), parsed.value);
  return result ? c.json(result) : c.json(errorBody("not_found", "Product not found"), 404);
});

app.get("/api/reviews", async (c) => {
  const status = c.req.query("status") ?? "open";
  const type = c.req.query("type") ?? "all";
  const reviewId = c.req.query("id") ?? null;
  const page = Number(c.req.query("page") ?? 1);
  const pageSize = Number(c.req.query("pageSize") ?? 50);
  const statuses: ReviewStatus[] = ["open", "resolved", "dismissed"];
  const types: Array<ReviewType | "all"> = [
    "all",
    "identity",
    "invalid_gtin",
    "nutrition_validation",
    "nutrition_conflict",
    "ingredient_conflict",
    "coverage_gap",
  ];
  if (
    !statuses.includes(status as ReviewStatus)
    || !types.includes(type as ReviewType | "all")
    || !Number.isInteger(page)
    || page < 1
    || !Number.isInteger(pageSize)
    || pageSize < 1
    || pageSize > 100
    || (reviewId !== null && (reviewId.length < 1 || reviewId.length > 200))
  ) {
    return c.json(errorBody("validation_error", "Invalid review filters"), 400);
  }
  return c.json(await listReviews(
    c.env.DB,
    status as ReviewStatus,
    type as ReviewType | "all",
    page,
    pageSize,
    reviewId,
  ));
});

app.post("/api/reviews/:id/resolve", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    return c.json(errorBody("mutations_disabled", "Review mutations are local-only until operator authentication is configured"), 403);
  }
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json(errorBody("validation_error", "Expected a JSON object"), 400);
  }
  const input = body as Record<string, unknown>;
  const decisions: ReviewDecision[] = [
    "verify_nutrition",
    "reject_nutrition",
    "redundant_nutrition",
    "verify_ingredients",
    "reject_ingredients",
    "dismiss",
    "match",
    "create_new",
    "no_match",
  ];
  if (typeof input.decision !== "string" || !decisions.includes(input.decision as ReviewDecision)) {
    return c.json(errorBody("validation_error", "Invalid review decision"), 400);
  }
  if (typeof input.rationale !== "string" || input.rationale.trim().length < 3 || input.rationale.length > 2_000) {
    return c.json(errorBody("validation_error", "A rationale between 3 and 2,000 characters is required"), 400);
  }
  let evidenceUrl: string | null = null;
  if (input.evidenceUrl !== undefined && input.evidenceUrl !== null && input.evidenceUrl !== "") {
    if (typeof input.evidenceUrl !== "string") return c.json(errorBody("validation_error", "Evidence URL must be a string"), 400);
    try {
      const parsed = new URL(input.evidenceUrl);
      if (parsed.protocol !== "https:") throw new Error("unsupported protocol");
      evidenceUrl = parsed.toString();
    } catch {
      return c.json(errorBody("validation_error", "Evidence URL must be a valid HTTPS URL"), 400);
    }
  }
  if (["verify_nutrition", "verify_ingredients", "match", "create_new"].includes(input.decision) && evidenceUrl === null) {
    return c.json(errorBody("validation_error", "Verification requires a current label or authoritative-source evidence URL"), 400);
  }
  if (input.decision === "redundant_nutrition" && evidenceUrl !== null) {
    return c.json(errorBody("validation_error", "Redundant nutrition uses the source-bound candidate image"), 400);
  }
  const candidateProductId = input.candidateProductId === undefined || input.candidateProductId === null || input.candidateProductId === ""
    ? null
    : typeof input.candidateProductId === "string" ? input.candidateProductId : undefined;
  if (candidateProductId === undefined) return c.json(errorBody("validation_error", "Candidate product ID must be a string"), 400);
  const reviewedText = input.reviewedText === undefined || input.reviewedText === null
    ? null
    : typeof input.reviewedText === "string" ? input.reviewedText : undefined;
  if (reviewedText === undefined) return c.json(errorBody("validation_error", "Reviewed ingredient text must be a string"), 400);
  if (input.decision === "verify_ingredients" && !reviewedText?.trim()) {
    return c.json(errorBody("validation_error", "Ingredient verification requires reviewer-confirmed label text"), 400);
  }
  if (reviewedText !== null && reviewedText.length > 25_000) {
    return c.json(errorBody("validation_error", "Reviewed ingredient text must not exceed 25,000 characters"), 400);
  }
  if (input.decision !== "verify_ingredients" && reviewedText !== null) {
    return c.json(errorBody("validation_error", "Reviewed ingredient text is only valid for ingredient verification"), 400);
  }
  const reviewedProjection = input.reviewedProjection === undefined || input.reviewedProjection === null
    ? null
    : input.reviewedProjection;
  if (input.decision !== "verify_nutrition" && reviewedProjection !== null) {
    return c.json(errorBody("validation_error", "Reviewed nutrition is only valid for nutrition verification"), 400);
  }
  const result = await resolveReview(
    c.env.DB,
    c.req.param("id"),
    input.decision as ReviewDecision,
    input.rationale.trim(),
    evidenceUrl,
    candidateProductId,
    reviewedText,
    reviewedProjection,
  );
  if (result === "not_found") return c.json(errorBody("not_found", "Review item not found"), 404);
  if (result === "conflict") return c.json(errorBody("conflict", "Review item was already resolved"), 409);
  if (result === "invalid_decision") return c.json(errorBody("validation_error", "Decision is not valid for this review type"), 400);
  if (result === "invalid_candidate") return c.json(errorBody("validation_error", "Candidate is not valid for this review item"), 400);
  return c.json({ status: "resolved", id: c.req.param("id"), decision: input.decision });
});

app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));

app.onError((error, c) => {
  console.error(JSON.stringify({ message: "request_failed", error: error.message, path: c.req.path }));
  return c.json(errorBody("internal_error", "The request could not be completed"), 500);
});

// Anonymous read surfaces are cached per-colo in the Workers Cache API for
// five minutes (matching the Cache-Control already sent on text responses).
// Catalog data only changes through the publication workflow, so short-lived
// edge copies cannot diverge from anything a faster TTL would serve. This is
// the primary guard against crawler pagination walks re-running the ~100k-row
// catalog queries on every hit. Reads carry no auth, so the public corpus is
// safe to share; mutations are local-only and never reach this path.
const EDGE_CACHEABLE_PATH =
  /^\/(api\/(products|ai|coverage)(\/|$)|products\/|sitemap\.xml|llms(-full)?\.txt|index\.md)/;

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    // `caches.default` is the Workers Cache API; the DOM CacheStorage typing
    // in worker-configuration.d.ts does not declare it.
    const url = new URL(request.url);
    // Localhost bypasses the cache entirely: mutations only run there, and the
    // operator/review flows must see post-mutation state immediately.
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    const cache = (globalThis.caches as unknown as { default?: Cache } | undefined)?.default;
    if (request.method !== "GET" || local || !cache || !EDGE_CACHEABLE_PATH.test(url.pathname)) {
      const response = await app.fetch(request, env, ctx);
      observeRequest(request, response, startedAt, env, ctx, "bypass");
      return response;
    }
    const key = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(key);
    if (hit) {
      const response = new Response(hit.body, hit);
      response.headers.set("x-edge-cache", "HIT");
      observeRequest(request, response, startedAt, env, ctx, "hit");
      return response;
    }
    const response = await app.fetch(request, env, ctx);
    if (response.status === 200) {
      const stored = new Response(response.clone().body, response);
      stored.headers.set("Cache-Control", "public, max-age=300");
      ctx.waitUntil(cache.put(key, stored));
      response.headers.set("x-edge-cache", "MISS");
    }
    observeRequest(request, response, startedAt, env, ctx, "miss");
    return response;
  },
} satisfies ExportedHandler<Env>;

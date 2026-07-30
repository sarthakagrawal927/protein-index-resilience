## Context

Protein Index publishes a React catalog backed by active D1 product records.
The homepage is the only current HTML route; product records are available only
through JSON and a legacy Markdown API route. The existing sitemap is a static
list of machine endpoints, while `/api/ai` advertises a placeholder instead of
the actual public route collection.

The public catalog can contain thousands of active products, so exhaustive
discovery must remain bounded per response. Evidence claims must continue to
come only from the selected catalog fields; this change must not write data,
publish evidence, or expose operator mutation routes.

## Goals / Non-Goals

**Goals:**

- Give the homepage and every active product a canonical HTML page.
- Give every canonical HTML page a substantive Markdown equivalent.
- Derive URLs, sitemap entries, and catalog templates from one route module.
- Keep sitemap and catalog generation bounded as the active catalog grows.
- Preserve the catalog's explicit evidence and completeness boundaries.

**Non-Goals:**

- Changing ingestion, evidence selection, review, or publication behavior.
- Adding a new database table, dependency, or search ranking model.
- Deploying the implementation or claiming production coverage before deploy.

## Decisions

### Active products define the public detail inventory

Only `products.is_active = 1` records receive canonical detail URLs. This uses
the existing public-catalog boundary instead of adding a second publication
flag that could drift.

### One route module owns all route construction

The homepage, product HTML, product Markdown, sitemap index, and shard URLs are
constructed in `worker/public-routes.ts`. Renderers and handlers consume these
functions rather than assembling paths independently.

### Sitemap responses are sharded

`/sitemap.xml` is a sitemap index. It references one static-page sitemap and
bounded product shards of 5,000 active IDs each. Each shard queries one ordered
page of active IDs. This avoids a single unbounded D1 query or response while
remaining exhaustive.

### The agent catalog describes dynamic products as a collection

`/api/ai` exposes the homepage as a directly testable surface and the complete
product detail set as a collection with an exact active count, URL templates,
Markdown templates, and sitemap discovery. It does not materialize thousands
of entries into the top-level `surfaces` array, which keeps automated catalog
audits bounded.

### Product HTML and Markdown share a normalized page model

Both representations are rendered from the same `ProductDetailResponse`.
Missing evidence is stated as unavailable, not inferred. The JSON API remains
available, and `/api/products/:id.md` remains as a compatibility alias, but the
canonical Markdown URL is `/products/:id.md`.

## Risks / Trade-offs

- **Large catalogs create several sitemap requests** → Use deterministic 5,000
  item shards and expose their exact count.
- **Offset pagination can move during concurrent publication** → The catalog is
  published in controlled runs, and ordered IDs make each response
  deterministic for a stable snapshot; crawlers can retry after publication.
- **Server-rendered product pages do not reuse the React drawer UI** → Keep the
  page intentionally evidence-focused and link back to the interactive catalog.
- **Escaping mistakes could corrupt HTML or metadata** → Escape all text, URLs,
  XML, and JSON-LD output and cover hostile characters in focused tests.

## Migration Plan

1. Ship the Worker-first route handlers and static homepage metadata together.
2. Verify the sitemap index, a product shard, HTML, Markdown, and `/api/ai`
   against a representative local D1 fixture.
3. Deploy only through the repository's separate manual release process.
4. Roll back by reverting the source commit; no data migration is involved.

## Open Questions

None. Production active-product count remains runtime data and is deliberately
not embedded in source.

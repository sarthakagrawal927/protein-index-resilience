---
title: Architecture overview
description: System topology, data flow, and the boundaries between producer, publication, and serving.
---

# Architecture overview

Protein Index is a Vite + React single-page app served by one Cloudflare
Worker, backed by one D1 database and one private R2 bucket. The interesting
architecture is not the web stack but the **producer → publication → serving**
boundary, which exists to keep unverified source data and model output from
becoming verified facts.

## Topology

| Resource | Binding | Purpose |
| --- | --- | --- |
| Worker `protein-index` | — | Public read-only API + SPA + agent surfaces |
| D1 `protein-index` | `DB` | Catalog, evidence, review, and run ledger |
| R2 `protein-index-labels` | `LABELS` | Private retained label images |

Configuration: [`wrangler.jsonc`](../../wrangler.jsonc). The public application
is read-only until operator authentication exists.

## Three boundaries

```
        PRODUCER (no credentials)          PUBLICATION (credentials, gated)        SERVING (read-only)
        ─────────────────────────────      ─────────────────────────────────       ──────────────────────
  GitHub Actions workflows            Manual dispatch + explicit confirm        Cloudflare Worker + D1 + R2
  source-sync, enrich, extract        publish-catalog, publish-*-evidence,      catalog, detail, coverage,
  → checksummed artifacts in          publish-guarded-reviewed-labels,          completion, reviews APIs
  GitHub Actions storage              publish-robotoff-candidates               (mutations denied in prod)
```

1. **Producer** workflows run without production credentials. They download
   sources, run adapters, and upload checksummed artifacts. They never write to
   D1. Successful runs do not trigger publication.
2. **Publication** is always an explicit, separately dispatched workflow. It
   revalidates the artifact, checks source/cohort accounting, refuses pending
   migrations, and writes idempotent SQL. The `production` GitHub environment
   scopes credentials as defense in depth; explicit dispatch confirmation is
   the repository-enforced approval gate.
3. **Serving** is read-only. The Worker denies mutations in production. Catalog
   corrections are republished as new evidence-preserving runs, never by
   deleting the audit trail.

## Data flow

```
Open Food Facts TSV export
   │  source-sync workflow (weekly cron, Mon 02:23 UTC)
   ▼
staged products + exclusion ledger  ────────────────►  checksummed artifact
   │  (workflow_run trigger on source-sync)                │
   ├──► enrich-open-food-facts  ── richer API records ────┤
   ├──► extract-robotoff        ── nutrition candidates ──┤
   └──► extract-robotoff-ingredients ── ingredient cand. ─┤
                                                           │
   official-brand-discovery (weekly cron, Mon 03:19 UTC)   │
   └──► brand sitemaps ── discovery records ───────────────┤
                                                           │
   review-decisions/ (human-reviewed bundles) ◄────────────┤
                                                           ▼
                              publish-* workflows (manual dispatch + confirm)
                                                           │
                                                           ▼
                                                 D1 (evidence ledger) + R2 (labels)
                                                           │
                                                           ▼
                                                 Worker (read-only API + SPA)
```

## Code map

The codebase is intentionally split into three layers. Implementation detail
lives in code; this table is a navigation aid, not a substitute for reading it.

| Layer | Path | Responsibility |
| --- | --- | --- |
| Worker (serving) | [`worker/`](../../worker/) | Hono routes: catalog, completion, coverage, reviews, terminal/identity evidence, agent-index |
| Shared domain | [`shared/`](../../shared/) | Pure domain logic: types, evidence-decisions, extraction-outcomes, identity/ingredient/terminal evidence, nutrition, metrics, gtin, classification |
| Scripts (producer) | [`scripts/`](../../scripts/) | sync, reconcile, review-bundles, publication, machine-label*, guarded-publication, audit-decisions |
| Adapters | [`scripts/adapters/`](../../scripts/adapters/) | open-food-facts (+ `-api`), robotoff (+ `-api`), robotoff-ingredients (+ `-api`), label-image, official-brand-sitemap, datakart, response-cache, extraction-progress, run-budget |
| Migrations | [`migrations/`](../../migrations/) | D1 schema, applied in order; see [data model](data-model.md) |
| Tests | [`test/`](../../test/) | unit + Worker/D1 integration via `@cloudflare/vitest-pool-workers` |
| Frontend | [`src/`](../../src/) | React SPA: catalog, evidence detail, review controls, completion worklist |

## Agent / LLM surfaces

The Worker serves machine-readable surfaces before SPA fallback so agents do
not receive fake HTML 200s. Some surfaces are Worker routes
([`worker/agent-index.ts`](../../worker/agent-index.ts), registered in
[`worker/index.ts`](../../worker/index.ts)); others are plain static assets in
[`public/`](../../public/).

| Path | Content | Served by |
| --- | --- | --- |
| `/llms.txt` | Compact agent index | Worker route |
| `/index.md` | Product brief in Markdown | Worker route |
| `/api/ai` | JSON catalog of public surfaces | Worker route |
| `/products/:id` | Canonical server-rendered product detail | Worker route |
| `/products/:id.md` | Equivalent per-product Markdown | Worker route |
| `/api/products/:id.md` | Compatibility product Markdown | Worker route |
| `/sitemap.xml` | Runtime active-product sitemap | Worker route |
| `/llms-full.txt` | Full agent brief | Static asset (`public/`) |
| `/robots.txt` | Allow rules for agent paths | Static asset (`public/`) |

`wrangler.jsonc` lists `/api/*`, `/products/*`, `/llms.txt`, `/llms-full.txt`,
`/index.md`, and `/sitemap.xml` under `assets.run_worker_first` so the Worker's
dynamic surfaces win over the SPA HTML fallback. `/robots.txt` is a plain static
asset and is not in that list.

## See also

- [Data model](data-model.md) for the D1 schema and migration narrative.
- [Evidence pipeline](evidence-pipeline.md) for the path from raw source to
  verified fact.
- [Decision log](decisions/README.md) for the ADRs behind these boundaries.

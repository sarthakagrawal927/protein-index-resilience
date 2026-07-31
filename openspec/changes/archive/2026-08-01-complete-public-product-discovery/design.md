## Context

The Worker already wins over SPA fallback for machine routes and exposes public catalog detail through D1. Its current sitemap and agent catalog are constants, while per-product Markdown is an API template with no canonical HTML counterpart. See the proposal and capability specs for the behavioral contract.

## Goals / Non-Goals

**Goals:**

- Derive one runtime inventory from active product IDs and public identity fields.
- Render safe, concise HTML and Markdown from the existing public detail projection.
- Keep sitemap, catalog, metadata, and route representations in parity.

**Non-Goals:**

- Publishing or changing catalog data, migrations, deployment, or reactivation automation.
- Exposing R2 labels, review payloads, mutation routes, source-record internals, or full evidence provenance.
- Replacing the SPA catalog or product drawer.

## Decisions

### Query only active public identity fields for discovery inventories

The sitemap and catalog query `id`, `name`, and `brand` from active products in deterministic ID order. Detail routes continue through the existing public projection. Querying review/evidence tables was rejected because those fields are unnecessary for discovery and would risk crossing trust boundaries.

### Use canonical `/products/:id` routes

The Worker will serve HTML at `/products/:id` and Markdown at `/products/:id.md`; the existing `/api/products/:id` JSON remains unchanged and the old API Markdown path remains as compatibility. Canonical URLs belong outside `/api` so crawlers do not treat API resources as product pages.

### Render minimal escaped documents in the Worker

Small deterministic renderers avoid adding SSR infrastructure to the Vite SPA. All text and JSON-LD are escaped, and only identity, five macros, density, and evidence-state labels are shown. Client-side rendering was rejected because it reproduces the current empty-shell indexing problem.

### Generate runtime sitemap and catalog from one inventory

Both surfaces receive the same ordered product list, ensuring publication changes are reflected without rebuilding static assets. Results use short public cache headers to bound repeated D1 work. A static generated sitemap was rejected because data publication is intentionally independent from source releases.

## Risks / Trade-offs

- [Large catalogs produce large sitemap and catalog responses] → Emit compact deterministic output, retain only required identity fields, and use bounded public caching.
- [Unsafe product text enters HTML or JSON-LD] → Escape HTML attributes/text and serialize JSON-LD with `<` escaped.
- [Encoded IDs drift across surfaces] → Centralize route construction and assert parity in unit and Worker tests.
- [SPA asset fallback masks missing routes] → Register product and machine routes before the existing fallback and cover content types and 404s in Worker tests.

## Migration Plan

Merge code and specifications after the full check passes. No database change, data publication, or deployment occurs; rollback is a code revert.

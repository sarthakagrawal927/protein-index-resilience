## Why

Protein Index's public indexing surfaces currently describe a template API route rather than the active catalog, and the SPA has no crawlable product detail URL. Search engines and agents need truthful, source-derived route parity without crossing the product's evidence or publication boundaries.

## What Changes

- Add canonical server-rendered HTML product pages with equivalent Markdown routes.
- Generate `/sitemap.xml` and `/api/ai` from active public products at request time.
- Align robots, canonical metadata, Open Graph metadata, structured data, and agent guidance with those routes.
- Preserve Trusted/Discovery evidence labels and exclude review mutations, private R2 artifacts, and inactive products.
- Add route, sitemap, catalog, HTML, and Markdown parity tests.

## Capabilities

### New Capabilities

- `public-product-discovery`: Runtime public-product route inventory and its search-engine and agent-readable representations.

### Modified Capabilities

- `macro-first-product-detail`: Product detail becomes available as canonical server-rendered HTML and equivalent Markdown in addition to the existing SPA drawer and JSON API.

## Impact

This affects Worker routes, the agent-index renderer, public crawler guidance, tests, and product documentation. It adds no dependency, database migration, publication, deployment, mutation route, or access to private evidence artifacts.

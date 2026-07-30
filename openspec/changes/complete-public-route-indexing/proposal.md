## Why

Protein Index currently advertises only the SPA shell and a product-route
placeholder, so search engines cannot discover canonical product pages and
agents cannot prove that each public data-derived page has an equivalent
Markdown representation. The public catalog needs a scalable route contract
that stays synchronized with active D1 products without weakening its evidence
boundaries.

## What Changes

- Add canonical server-rendered HTML and Markdown detail routes for every active
  public product.
- Define product URL, Markdown URL, sitemap shard, and catalog-template behavior
  from one route module.
- Generate a runtime sitemap index plus bounded product sitemap shards from the
  active public product set.
- Make `/api/ai`, `llms.txt`, `llms-full.txt`, robots, homepage metadata, and
  product metadata accurately describe the same public surface.
- Add parity tests covering routes, sitemap shards, catalog collection metadata,
  HTML/Markdown substance, canonical URLs, Open Graph, and structured data.

## Capabilities

### New Capabilities

- `public-product-indexing`: Canonical SEO and agent-readable coverage for the
  homepage and every active public product record.

### Modified Capabilities

<!-- No existing capability requirements change. -->

## Impact

The change affects Worker read routes, the static SPA document, public indexing
assets, Worker-first routing, and focused tests. It adds no dependency, performs
no D1 write or data publication, exposes no review mutation or private evidence,
and does not deploy.

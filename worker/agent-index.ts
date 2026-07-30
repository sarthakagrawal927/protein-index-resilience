import type { ProductDetailResponse } from "../shared/api";
import {
  PUBLIC_ORIGIN,
  PRODUCT_SITEMAP_PAGE_SIZE,
  absoluteUrl,
  productMarkdownPath,
  productPath,
  routeTemplateUrl,
} from "./public-routes";

export const LLMS_TXT = buildLlmsTxt();
export const INDEX_MD = buildIndexMarkdown();

export function buildLlmsTxt(origin = PUBLIC_ORIGIN): string {
  return `# Protein Index

> Source-aware catalog of Indian food products. Verified label evidence is
> separated from broader discovery data; missing values are not inferred.

## Canonical public pages

- [Catalog](${absoluteUrl("/", origin)}): Browse and compare the active catalog
- [Homepage markdown](${absoluteUrl("/index.md", origin)}): Non-JavaScript product brief
- Product pages: \`${routeTemplateUrl("/products/{id}", origin)}\`
- Product markdown: \`${routeTemplateUrl("/products/{id}.md", origin)}\`
- [Sitemap index](${absoluteUrl("/sitemap.xml", origin)}): Exhaustive active-page discovery
- [Full agent guide](${absoluteUrl("/llms-full.txt", origin)}): Route and evidence contract

## Machine resources

- [Agent catalog](${absoluteUrl("/api/ai", origin)}): Exact active count and route templates
- [Health](${absoluteUrl("/api/health", origin)}): Publication status
- [Coverage](${absoluteUrl("/api/coverage", origin)}): Evidence coverage
- [Search](${absoluteUrl("/api/products", origin)}): Public catalog JSON

## Evidence boundary

The catalog does not claim complete Indian-market coverage and is not medical
advice. Prefer selected verified evidence, treat unverified values as
unverified, and never invent missing nutrition.
`;
}

export function buildIndexMarkdown(origin = PUBLIC_ORIGIN): string {
  return `# Protein Index

Protein Index is a source-aware catalog for comparing protein foods sold in
India. It keeps verified label evidence separate from discovery data and makes
missing evidence explicit.

## What the catalog provides

- Canonical active products with GTIN-oriented identity
- Nutrition, ingredient, source, and completeness status
- Evidence-aware protein-density and consumer metrics when inputs are available
- Public HTML, Markdown, JSON, and sitemap discovery

## Trust boundary

Protein Index is not a complete market census or medical advice. A missing
value means the catalog has not verified it. Unverified nutrition remains
clearly marked and must not be treated as a label-confirmed claim.

## Explore

- [Interactive catalog](${absoluteUrl("/", origin)})
- [Agent catalog](${absoluteUrl("/api/ai", origin)})
- [Sitemap index](${absoluteUrl("/sitemap.xml", origin)})
- [Full agent guide](${absoluteUrl("/llms-full.txt", origin)})
`;
}

export function buildLlmsFullTxt(
  activeProductCount: number,
  origin = PUBLIC_ORIGIN,
): string {
  return `${buildLlmsTxt(origin)}

## Current public route inventory

- Canonical HTML templates: 2
- Homepage pages: 1
- Active product pages: ${activeProductCount}
- Total canonical HTML pages: ${activeProductCount + 1}
- Product sitemap shard size: ${PRODUCT_SITEMAP_PAGE_SIZE}

Each active product has a canonical HTML page at
\`${routeTemplateUrl("/products/{id}", origin)}\` and an equivalent Markdown page at
\`${routeTemplateUrl("/products/{id}.md", origin)}\`. The sitemap index is the
exhaustive discovery source; the JSON catalog stays bounded by describing this
collection as a template with an exact count.

## JSON API

\`GET /api/products\` supports search and filters. \`GET /api/products/{id}\`
returns one active product record. Review and evidence mutations remain
operator-only and are not public agent surfaces.
`;
}

export function buildApiAiCatalog(
  origin = PUBLIC_ORIGIN,
  activeProductCount = 0,
) {
  const productShardCount = Math.ceil(
    activeProductCount / PRODUCT_SITEMAP_PAGE_SIZE,
  );
  return {
    name: "Protein Index",
    version: "2",
    url: absoluteUrl("/", origin),
    llms: absoluteUrl("/llms.txt", origin),
    llmsFull: absoluteUrl("/llms-full.txt", origin),
    sitemap: absoluteUrl("/sitemap.xml", origin),
    markdown: { suffix: ".md", negotiation: false },
    surfaces: [
      {
        id: "home",
        url: absoluteUrl("/", origin),
        md: absoluteUrl("/index.md", origin),
        kind: "page",
        description: "Interactive source-aware protein catalog",
      },
    ],
    collections: [
      {
        id: "products",
        kind: "dynamic_pages",
        count: activeProductCount,
        urlTemplate: routeTemplateUrl("/products/{id}", origin),
        markdownTemplate: routeTemplateUrl("/products/{id}.md", origin),
        sitemap: absoluteUrl("/sitemap.xml", origin),
        sitemapShardTemplate: routeTemplateUrl("/sitemaps/products-{page}.xml", origin),
        sitemapShardCount: productShardCount,
        description: "One canonical HTML and Markdown page per active product",
      },
    ],
    resources: [
      { id: "health", url: absoluteUrl("/api/health", origin), kind: "api" },
      { id: "coverage", url: absoluteUrl("/api/coverage", origin), kind: "api" },
      {
        id: "products_search",
        url: absoluteUrl("/api/products", origin),
        kind: "api",
      },
      {
        id: "product_detail",
        urlTemplate: routeTemplateUrl("/api/products/{id}", origin),
        kind: "api",
      },
    ],
    auth: {
      public: true,
      notes:
        "Catalog reads are public. Review and evidence mutations remain local/operator-only.",
    },
    evidence: {
      policy:
        "Verified, machine-verified, unverified, conflicting, and missing evidence remain distinct.",
      marketCoverage: "incomplete",
      medicalAdvice: false,
    },
  };
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonLd(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function productDescription(product: ProductDetailResponse): string {
  const owner = product.brand ? `${product.brand} ` : "";
  return `${owner}${product.name}: source-aware nutrition and ingredient evidence, with ${product.nutritionStatus} nutrition status and ${product.completeness}% catalog completeness.`;
}

function evidenceLabel(product: ProductDetailResponse): string {
  if (product.nutritionStatus === "verified") return "Verified nutrition evidence";
  if (product.nutritionStatus === "machine_verified") {
    return "Machine-verified label evidence";
  }
  if (product.nutritionStatus === "missing") return "Nutrition evidence unavailable";
  return `${product.nutritionStatus.replaceAll("_", " ")} nutrition evidence`;
}

function metric(value: number | null, unit: string): string {
  return value === null ? "Not available" : `${value} ${unit}`;
}

export function productToMarkdown(
  product: ProductDetailResponse,
  origin = PUBLIC_ORIGIN,
): string {
  const canonical = absoluteUrl(productPath(product.id), origin);
  return `# ${product.name}

**Brand:** ${product.brand || "Not available"}  
**GTIN:** ${product.gtin || "Not available"}  
**Category:** ${product.category}  
**Canonical URL:** ${canonical}

## Evidence status

- Nutrition: ${evidenceLabel(product)}
- Ingredient evidence: ${product.ingredientStatus}
- Catalog completeness: ${product.completeness}%
- Open review items: ${product.openReviewCount}

## Nutrition

Basis: ${product.nutrition.basis}

| Measure | Value |
| --- | --- |
| Energy | ${metric(product.nutrition.calories, "kcal")} |
| Protein | ${metric(product.nutrition.proteinGrams, "g")} |
| Carbohydrate | ${metric(product.nutrition.carbohydrateGrams, "g")} |
| Sugar | ${metric(product.nutrition.sugarGrams, "g")} |
| Fat | ${metric(product.nutrition.fatGrams, "g")} |
| Saturated fat | ${metric(product.nutrition.saturatedFatGrams, "g")} |
| Fibre | ${metric(product.nutrition.fibreGrams, "g")} |
| Sodium | ${metric(product.nutrition.sodiumMg, "mg")} |

## Ingredients and sources

${product.ingredientStatement || "No verified ingredient statement is available."}

Source records: ${product.sourceRecords.length}. Nutrition evidence URL:
${product.nutritionEvidenceUrl || "Not available"}.

## Interpretation boundary

This record reflects the catalog's current selected evidence. Missing values are
not zero and must not be inferred. Unverified values are not label-confirmed.
Protein Index is not medical advice and does not claim complete market coverage.

[Browse the catalog](${absoluteUrl("/", origin)}) · [JSON record](${absoluteUrl(`/api/products/${encodeURIComponent(product.id)}`, origin)}) · [Markdown](${absoluteUrl(productMarkdownPath(product.id), origin)})
`;
}

export function productToHtml(
  product: ProductDetailResponse,
  origin = PUBLIC_ORIGIN,
): string {
  const canonical = absoluteUrl(productPath(product.id), origin);
  const markdown = absoluteUrl(productMarkdownPath(product.id), origin);
  const description = productDescription(product);
  const title = `${product.name} by ${product.brand || "Unknown brand"} | Protein Index`;
  const structuredData: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    brand: product.brand ? { "@type": "Brand", name: product.brand } : undefined,
    gtin: product.gtin || undefined,
    category: product.category,
    url: canonical,
    image: product.imageUrl || undefined,
    additionalProperty: [
      {
        "@type": "PropertyValue",
        name: "Nutrition evidence status",
        value: product.nutritionStatus,
      },
      {
        "@type": "PropertyValue",
        name: "Catalog completeness",
        value: `${product.completeness}%`,
      },
    ],
  };
  const rows: Array<{ name: string; value: string }> = [
    { name: "Energy", value: metric(product.nutrition.calories, "kcal") },
    { name: "Protein", value: metric(product.nutrition.proteinGrams, "g") },
    {
      name: "Carbohydrate",
      value: metric(product.nutrition.carbohydrateGrams, "g"),
    },
    { name: "Sugar", value: metric(product.nutrition.sugarGrams, "g") },
    { name: "Fat", value: metric(product.nutrition.fatGrams, "g") },
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <meta name="description" content="${htmlEscape(description)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${htmlEscape(canonical)}">
  <link rel="alternate" type="text/markdown" href="${htmlEscape(markdown)}">
  <meta property="og:type" content="product">
  <meta property="og:site_name" content="Protein Index">
  <meta property="og:title" content="${htmlEscape(title)}">
  <meta property="og:description" content="${htmlEscape(description)}">
  <meta property="og:url" content="${htmlEscape(canonical)}">
  ${product.imageUrl ? `<meta property="og:image" content="${htmlEscape(product.imageUrl)}">` : ""}
  <meta name="twitter:card" content="${product.imageUrl ? "summary_large_image" : "summary"}">
  <meta name="twitter:title" content="${htmlEscape(title)}">
  <meta name="twitter:description" content="${htmlEscape(description)}">
  <script type="application/ld+json">${jsonLd(structuredData)}</script>
  <style>body{margin:0;background:#0b0f0d;color:#edf4ef;font:16px/1.6 system-ui,sans-serif}main{max-width:880px;margin:auto;padding:3rem 1.25rem}a{color:#8de1c1}h1{font-size:clamp(2rem,6vw,4rem);line-height:1.05}h2{margin-top:2.5rem}dl,table{width:100%;border-collapse:collapse}dt,th{color:#9fb0a7}td,th{padding:.6rem;border-bottom:1px solid #29332e;text-align:left}.notice{border-left:3px solid #8de1c1;padding-left:1rem}</style>
</head>
<body>
<main>
  <p><a href="/">Protein Index</a> / ${htmlEscape(product.category)}</p>
  <h1>${htmlEscape(product.name)}</h1>
  <p>${htmlEscape(product.brand || "Brand unavailable")} · ${htmlEscape(evidenceLabel(product))}</p>
  <h2>Product identity</h2>
  <dl>
    <dt>GTIN</dt><dd>${htmlEscape(product.gtin || "Not available")}</dd>
    <dt>Category</dt><dd>${htmlEscape(product.category)}</dd>
    <dt>Catalog completeness</dt><dd>${product.completeness}%</dd>
  </dl>
  <h2>Nutrition</h2>
  <p>Basis: ${htmlEscape(product.nutrition.basis)}</p>
  <table><thead><tr><th>Measure</th><th>Value</th></tr></thead><tbody>${rows
    .map(
      ({ name, value }) =>
        `<tr><td>${htmlEscape(name)}</td><td>${htmlEscape(value)}</td></tr>`,
    )
    .join("")}</tbody></table>
  <h2>Ingredients and evidence</h2>
  <p>${htmlEscape(product.ingredientStatement || "No verified ingredient statement is available.")}</p>
  <p>Ingredient evidence: ${htmlEscape(product.ingredientStatus)}. Source records: ${product.sourceRecords.length}.</p>
  <h2>Interpretation boundary</h2>
  <p class="notice">Missing values are not zero and must not be inferred. Unverified values are not label-confirmed. Protein Index is not medical advice and does not claim complete market coverage.</p>
  <p><a href="${htmlEscape(markdown)}">Read as Markdown</a> · <a href="${htmlEscape(absoluteUrl(`/api/products/${encodeURIComponent(product.id)}`, origin))}">View JSON</a></p>
</main>
</body>
</html>`;
}

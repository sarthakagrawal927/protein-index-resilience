import { describe, expect, it } from "vitest";
import type { ProductDetailResponse } from "../shared/api";
import {
  INDEX_MD,
  LLMS_TXT,
  buildApiAiCatalog,
  buildLlmsFullTxt,
  productToHtml,
  productToMarkdown,
} from "../worker/agent-index";
import {
  PRODUCT_SITEMAP_PAGE_SIZE,
  buildProductSitemap,
  buildSitemapIndex,
  buildStaticSitemap,
  productMarkdownPath,
  productPath,
} from "../worker/public-routes";

function product(): ProductDetailResponse {
  return {
    id: "test/id & one",
    gtin: "8900000000012",
    imageUrl: "https://images.example/product.jpg",
    nutritionImageUrl: null,
    brand: "Acme & Sons",
    name: "Test <Protein>",
    flavour: null,
    category: "other",
    netQuantityGrams: 100,
    servingSizeGrams: 50,
    marketedProtein: true,
    marketedReasons: ["name"],
    nutritionallyProteinDense: null,
    nutritionReasons: [],
    nutritionStatus: "verified",
    nutritionEvidenceAuthority: "human_reviewed_label",
    nutritionEvidenceUrl: "https://evidence.example/label",
    nutritionEvidenceKind: "label",
    ingredientStatus: "missing",
    ingredientEvidenceUrl: null,
    ingredientEvidenceKind: null,
    ingredientTerminalOutcome: null,
    completeness: 72,
    nutrition: {
      calories: 360,
      proteinGrams: 24,
      carbohydrateGrams: 48,
      sugarGrams: null,
      fatGrams: 8,
      saturatedFatGrams: null,
      fibreGrams: null,
      sodiumMg: null,
      basis: "per_100g",
      observedAt: "2026-07-31T00:00:00.000Z",
      labelVerifiedAt: "2026-07-31T00:00:00.000Z",
    },
    metrics: {
      proteinPer100Calories: { value: 6.67, reason: null },
      proteinCaloriePercentage: { value: 26.67, reason: null },
      caloriesFor25gProtein: { value: 375, reason: null },
      sugarPer25gProtein: { value: null, reason: "missing_sugar" },
      saturatedFatPer25gProtein: { value: null, reason: "missing_saturated_fat" },
      fibrePer100Calories: { value: null, reason: "missing_fibre" },
    },
    sourceRecords: [
      {
        id: "source-1",
        source: "brand",
        sourceRecordId: "record-1",
        sourceUrl: "https://evidence.example/product",
        observedAt: "2026-07-31T00:00:00.000Z",
        resolutionRule: "exact_gtin",
      },
    ],
    ingredientStatement: null,
    ingredients: [],
    allergens: [],
    additives: [],
    nutrients: [],
    ratings: [],
    provenance: [],
    completenessMissing: ["ingredients"],
    openReviewCount: 0,
  };
}

describe("agent-index surfaces", () => {
  it("publishes substantive homepage agent documents", () => {
    expect(LLMS_TXT.startsWith("# Protein Index")).toBe(true);
    expect(LLMS_TXT).toContain("/products/{id}.md");
    expect(INDEX_MD).toContain("verified label evidence");
    expect(buildLlmsFullTxt(27)).toContain("Total canonical HTML pages: 28");
  });

  it("describes the complete product collection without expanding surfaces", () => {
    const catalog = buildApiAiCatalog(
      "https://protein.significanthobbies.com",
      10_001,
    );
    expect(catalog.surfaces).toHaveLength(1);
    const productCollection = catalog.collections[0];
    expect(productCollection).toMatchObject({
      id: "products",
      count: 10_001,
      sitemapShardCount: 3,
    });
    expect(productCollection?.urlTemplate).toContain("/products/{id}");
    expect(productCollection?.markdownTemplate).toContain("/products/{id}.md");
  });

  it("uses one encoded route contract for HTML and markdown", () => {
    expect(productPath("test/id & one")).toBe("/products/test%2Fid%20%26%20one");
    expect(productMarkdownPath("test/id & one")).toBe(
      "/products/test%2Fid%20%26%20one.md",
    );
  });

  it("builds an exhaustive bounded sitemap index and canonical page sitemaps", () => {
    const index = buildSitemapIndex(PRODUCT_SITEMAP_PAGE_SIZE * 2 + 1);
    expect(index).toContain("<sitemapindex");
    expect(index.match(/products-[0-9]+\.xml/g)).toHaveLength(3);
    expect(buildStaticSitemap()).toContain(
      "<loc>https://protein.significanthobbies.com/</loc>",
    );
    const products = buildProductSitemap(["a", "b & c"]);
    expect(products).toContain("/products/a");
    expect(products).toContain("/products/b%20%26%20c");
    expect(products).not.toContain("/api/");
  });

  it("renders equivalent, substantive, safely escaped product HTML and markdown", () => {
    const fixture = product();
    const html = productToHtml(fixture);
    const markdown = productToMarkdown(fixture);
    const canonical =
      "https://protein.significanthobbies.com/products/test%2Fid%20%26%20one";

    expect(html).toContain("<h1>Test &lt;Protein&gt;</h1>");
    expect(html).toContain(`rel="canonical" href="${canonical}"`);
    expect(html).toContain('property="og:title"');
    expect(html).toContain('type="application/ld+json"');
    expect(html).not.toContain("<h1>Test <Protein></h1>");

    expect(markdown).toContain("# Test <Protein>");
    expect(markdown).toContain(`**Canonical URL:** ${canonical}`);
    expect(markdown).toContain("Verified nutrition evidence");
    expect(markdown).toContain("| Protein | 24 g |");
    expect(markdown).toContain("| Sugar | Not available |");
  });
});

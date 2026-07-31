import { describe, expect, it } from "vitest";
import {
  INDEX_MD,
  LLMS_TXT,
  buildApiAiCatalog,
  buildSitemapXml,
  productToHtml,
  productToMarkdown,
} from "../worker/agent-index";

const routes = [
  {
    id: "prd/a&b",
    name: "Test <Protein>",
    brand: "Acme & Co",
    path: "/products/prd%2Fa%26b",
    markdownPath: "/products/prd%2Fa%26b.md",
  },
];

const product = {
  id: "prd/a&b",
  name: "Test <Protein>",
  brand: "Acme & Co",
  gtin: "123",
  nutritionStatus: "unverified",
  ingredientStatus: "missing",
  nutrition: {
    calories: 360,
    proteinGrams: 52,
    carbohydrateGrams: 20,
    fatGrams: 8,
    fibreGrams: 6,
  },
  metrics: { proteinPer100Calories: { value: 14.4, reason: null } },
  openReviewCount: 7,
  provenance: [{ private: "must not render" }],
};

describe("agent-index surfaces", () => {
  it("llms.txt is agent-readable markdown/text", () => {
    expect(LLMS_TXT.startsWith("# Protein Index")).toBe(true);
    expect(LLMS_TXT).toContain("/api/ai");
    expect(LLMS_TXT).not.toContain("<!doctype");
  });

  it("index.md describes the product for agents", () => {
    expect(INDEX_MD.startsWith("# Protein Index")).toBe(true);
    expect(INDEX_MD).toContain("verified label evidence");
  });

  it("api/ai catalog matches fleet contract", () => {
    const cat = buildApiAiCatalog(routes, "https://protein.significanthobbies.com");
    expect(cat.name).toBe("Protein Index");
    expect(cat.llms).toContain("/llms.txt");
    expect(Array.isArray(cat.surfaces)).toBe(true);
    expect(cat.surfaces.some((s) => s.id === "home")).toBe(true);
    expect(cat.markdown.negotiation).toBe(true);
    expect(cat.surfaces.some((s) => s.id === "prd/a&b" && s.url.endsWith("/products/prd%2Fa%26b"))).toBe(true);
  });

  it("formats product markdown without inventing fields", () => {
    const md = productToMarkdown(product);
    expect(md).toContain("# Test <Protein>");
    expect(md).toContain("Acme & Co");
    expect(md).toContain("/products/prd%2Fa%26b");
    expect(md).toContain("52 g");
    expect(md).toContain("Nutrition evidence: unverified");
    expect(md).not.toContain("must not render");
    expect(md).not.toContain("openReviewCount");
  });

  it("renders escaped canonical HTML with matching public facts", () => {
    const html = productToHtml(product);
    expect(html).toContain('<link rel="canonical" href="https://protein.significanthobbies.com/products/prd%2Fa%26b">');
    expect(html).toContain('<meta property="og:url" content="https://protein.significanthobbies.com/products/prd%2Fa%26b">');
    expect(html).toContain("Test &lt;Protein&gt;");
    expect(html).not.toContain("<h1>Test <Protein></h1>");
    expect(html).toContain("52 g");
    expect(html).toContain("unverified");
    expect(html).not.toContain("must not render");
  });

  it("builds an HTML-only sitemap from the same encoded routes", () => {
    const sitemap = buildSitemapXml(routes);
    expect(sitemap.match(/<url>/g)).toHaveLength(2);
    expect(sitemap).toContain("/products/prd%2Fa%26b");
    expect(sitemap).not.toContain(".md");
    expect(sitemap).not.toContain("/api/");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductDrawer, CatalogTable, HeaderProductLookup, lookupDestination } from "../src/App";
import type { CatalogProduct, CatalogResponse, ProductDetailResponse } from "../shared/api";
import { calculateMetrics } from "../shared/metrics";

function product(input: { calories: number | null; proteinGrams: number | null }): CatalogProduct {
  const nutrition = {
    calories: input.calories,
    proteinGrams: input.proteinGrams,
    carbohydrateGrams: 20,
    sugarGrams: 4,
    fatGrams: 8,
    saturatedFatGrams: 3,
    fibreGrams: 6,
    sodiumMg: 250,
  };
  return {
    id: "prd_fixture",
    gtin: "08900000000012",
    imageUrl: null,
    nutritionImageUrl: "https://images.openfoodfacts.org/fixture.jpg",
    brand: "Atlas",
    name: "Protein Food",
    flavour: null,
    category: "protein_powder",
    netQuantityGrams: 500,
    servingSizeGrams: 50,
    marketedProtein: true,
    marketedReasons: ["protein"],
    nutritionallyProteinDense: true,
    nutritionReasons: ["protein_at_least_10g_per_100kcal"],
    nutritionStatus: "verified",
    nutritionEvidenceAuthority: "human_reviewed_label",
    nutritionEvidenceUrl: "https://images.openfoodfacts.org/fixture.jpg",
    nutritionEvidenceKind: "label",
    ingredientStatus: "verified",
    ingredientEvidenceUrl: "https://images.openfoodfacts.org/fixture-ingredients.jpg",
    ingredientEvidenceKind: "label",
    ingredientTerminalOutcome: null,
    completeness: 100,
    nutrition: {
      ...nutrition,
      basis: "per_100g",
      observedAt: "2026-07-17T00:00:00.000Z",
      labelVerifiedAt: "2026-07-17T00:00:00.000Z",
    },
    metrics: (() => {
      const metrics = calculateMetrics({
      nutrition,
      nutritionBasis: "per_100g",
      netQuantityGrams: 500,
      servingSizeGrams: 50,
      sellingPrice: null,
      });
      return {
        proteinPer100Calories: metrics.proteinPer100Calories,
        proteinCaloriePercentage: metrics.proteinCaloriePercentage,
        caloriesFor25gProtein: metrics.caloriesFor25gProtein,
        sugarPer25gProtein: metrics.sugarPer25gProtein,
        saturatedFatPer25gProtein: metrics.saturatedFatPer25gProtein,
        fibrePer100Calories: metrics.fibrePer100Calories,
      };
    })(),
  };
}

function renderCatalog(item: CatalogProduct): string {
  const data: CatalogResponse = {
    products: [item],
    pagination: { page: 1, pageSize: 25, total: 1, pages: 1 },
    trustedDefault: true,
    filters: {},
  };
  return renderToStaticMarkup(createElement(CatalogTable, {
    data,
    onOpen: () => undefined,
    onExplore: () => undefined,
    page: 1,
    onPage: () => undefined,
  }));
}

describe("catalog comparison surface", () => {
  it("shows the five comparison macros and protein density directly in the table and mobile card", () => {
    const markup = renderCatalog(product({ calories: 360, proteinGrams: 52 }));

    expect(markup).toContain("Protein / 100 kcal");
    for (const label of ["Protein", "Carbs", "Fat", "Fibre", "Calories"]) expect(markup).toContain(label);
    expect(markup).toContain("52 g");
    expect(markup.match(/360 kcal/g)).toHaveLength(2);
    expect(markup).not.toContain("Cost / 25 g");
    expect(markup).not.toContain("Current offer");
  });

  it("keeps mobile cards macro-first without ingredient or evidence drill-down copy", () => {
    const markup = renderCatalog(product({ calories: 360, proteinGrams: 52 }));
    const mobile = markup.slice(markup.indexOf('class="catalog-mobile"'));

    expect(mobile).toContain("product-card-macros");
    expect(mobile).not.toContain("Ingredients");
    expect(mobile).not.toContain("status-verified");
  });

  it("labels machine nutrition as label-backed without presenting it as human-reviewed", () => {
    const item = product({ calories: 360, proteinGrams: 52 });
    item.nutritionStatus = "machine_verified";
    item.nutritionEvidenceAuthority = "machine_verified_label";
    const markup = renderCatalog(item);

    expect(markup).toContain("machine-verified from label");
    expect(markup).not.toContain("verified nutrition");
  });

  it("does not surface ingredient terminal evidence in the macro comparison surface", () => {
    const item = product({ calories: 360, proteinGrams: 52 });
    item.ingredientStatus = "missing";
    item.ingredientTerminalOutcome = "not_declared";
    const markup = renderCatalog(item);

    expect(markup).not.toContain("ingredients: not declared");
    expect(markup).not.toContain("Ingredients");
  });

  it("keeps absent calories explicit instead of synthesizing a value", () => {
    const markup = renderCatalog(product({ calories: null, proteinGrams: 52 }));

    expect(markup).toContain("Calories");
    expect(markup).toContain("— kcal");
    expect(markup).not.toMatch(/>0 kcal</);
  });

  it("renders the compact header lookup with product evidence", () => {
    const item = product({ calories: 360, proteinGrams: 52 });
    item.nutritionStatus = "machine_verified";
    const markup = renderToStaticMarkup(createElement(HeaderProductLookup, {
      query: "atlas",
      products: [item],
      loading: false,
      error: null,
      onQuery: () => undefined,
      onSelect: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain("Protein Food");
    expect(markup).toContain("machine-verified from label");
  });

  it("opens an exact lookup match and hands ambiguous queries to the full catalog", () => {
    const item = product({ calories: 360, proteinGrams: 52 });
    expect(lookupDestination("atlas protein", [item])).toEqual({ kind: "open", productId: item.id });
    expect(lookupDestination("protein", [item, { ...item, id: "prd_second" }])).toEqual({ kind: "catalog", query: "protein" });
  });
});

function renderDetail(overrides: Partial<ProductDetailResponse> = {}): string {
  const detail: ProductDetailResponse = {
    ...product({ calories: 16, proteinGrams: 4 }),
    sourceRecords: [], ingredientStatement: null, ingredients: [], allergens: [],
    additives: [], nutrients: [], ratings: [], provenance: [], completenessMissing: [], openReviewCount: 0,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ProductDrawer, { detail, loading: false, error: null, onClose: () => undefined }));
}

describe("product detail evidence", () => {
  it("keeps unverified source evidence beside the macros and qualifies derived density", () => {
    const markup = renderDetail({ nutritionStatus: "unverified", nutritionEvidenceAuthority: "community", nutritionEvidenceKind: "source", nutritionEvidenceUrl: "https://example.com/product" });
    expect(markup).toContain("unverified nutrition");
    expect(markup).toContain("Community-provided data.");
    expect(markup).toContain('href="https://example.com/product"');
    expect(markup).toContain("View nutrition source");
    expect(markup).toContain("2026-07-17");
    expect(markup).toContain("the same evidence status applies");
    expect(markup).toContain("25 g");
  });

  it("distinguishes machine labels from human review", () => {
    const markup = renderDetail({ nutritionStatus: "machine_verified", nutritionEvidenceAuthority: "machine_verified_label" });
    expect(markup).toContain("machine-verified from label");
    expect(markup).toContain("not human reviewed");
    expect(markup).toContain("View original nutrition label");
    expect(markup).not.toContain("Human-reviewed label.");
  });

  it.each([null, "javascript:alert(1)", "not-a-url"])("makes unavailable evidence explicit for %s", (url) => {
    const nutrition = { ...product({ calories: 16, proteinGrams: 4 }).nutrition, observedAt: null };
    const markup = renderDetail({ nutritionEvidenceUrl: url, nutritionEvidenceAuthority: null, nutrition });
    expect(markup).toContain("Original nutrition source link unavailable.");
    expect(markup).toContain("Observation date unavailable.");
    expect(markup).toContain("Evidence authority not recorded.");
    expect(markup).not.toContain("javascript:");
  });
});


describe("detail source records", () => {
  it("exposes original records even when selected nutrition evidence is missing", () => {
    const markup = renderDetail({ nutritionStatus: "unverified", nutritionEvidenceUrl: null, sourceRecords: [{ id: "source-1", source: "open_food_facts", sourceRecordId: "8906090641067", sourceUrl: "https://world.openfoodfacts.org/product/8906090641067", observedAt: "2026-04-12T17:42:54.000Z", resolutionRule: "exact_gtin" }] });
    expect(markup).toContain("Original nutrition source link unavailable.");
    expect(markup).toContain('href="https://world.openfoodfacts.org/product/8906090641067"');
    expect(markup).toContain("These links do not verify the macros above.");
    expect(markup).toContain("2026-04-12");
  });

  it("does not turn unsafe source records into links", () => {
    const markup = renderDetail({ sourceRecords: [{ id: "source-1", source: "community", sourceRecordId: "1", sourceUrl: "javascript:alert(1)", observedAt: "invalid", resolutionRule: null }] });
    expect(markup).not.toContain("javascript:");
    expect(markup).toContain("source link unavailable");
    expect(markup).toContain("observation date unavailable");
  });
});

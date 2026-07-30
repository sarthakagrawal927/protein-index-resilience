import type { CatalogProduct, CatalogResponse, NutritionEvidenceStatus, ProductDetailResponse } from "../shared/api";
import { normalizeText } from "../shared/gtin";
import { calculateMetrics } from "../shared/metrics";
import { hasNutritionErrors, validateNutrition } from "../shared/nutrition";
import { PRODUCT_CATEGORIES, type EvidenceStatus, type NormalizedIngredient, type ProductCategory } from "../shared/types";

interface ProductRow {
  id: string;
  gtin: string | null;
  image_url: string | null;
  nutrition_image_url: string | null;
  brand: string;
  name: string;
  flavour: string | null;
  category: ProductCategory;
  net_quantity_grams: number | null;
  serving_size_grams: number | null;
  marketed_protein: number | null;
  marketed_reasons_json: string;
  nutritionally_protein_dense: number | null;
  nutrition_reasons_json: string;
  completeness: number;
  completeness_missing_json: string;
  nutrition_status: NutritionEvidenceStatus | null;
  nutrition_evidence_authority: CatalogProduct["nutritionEvidenceAuthority"];
  nutrition_evidence_url: string | null;
  nutrition_evidence_kind: "label" | "source" | null;
  ingredient_status: EvidenceStatus | null;
  ingredient_evidence_url: string | null;
  ingredient_evidence_kind: "label" | "source" | null;
  ingredient_terminal_outcome: "not_declared" | "not_applicable" | null;
  calories: number | null;
  protein_grams: number | null;
  carbohydrate_grams: number | null;
  sugar_grams: number | null;
  fat_grams: number | null;
  saturated_fat_grams: number | null;
  fibre_grams: number | null;
  sodium_mg: number | null;
  nutrition_basis: "per_100g" | "per_100ml" | "per_serving" | "unknown" | null;
  nutrition_observed_at: string | null;
  label_verified_at: string | null;
}

interface CountRow { total: number }

function booleanValue(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapProduct(row: ProductRow): CatalogProduct {
  const nutritionPer100g = {
    calories: row.calories,
    proteinGrams: row.protein_grams,
    carbohydrateGrams: row.carbohydrate_grams,
    sugarGrams: row.sugar_grams,
    fatGrams: row.fat_grams,
    saturatedFatGrams: row.saturated_fat_grams,
    fibreGrams: row.fibre_grams,
    sodiumMg: row.sodium_mg,
  };
  const nutrition = {
    ...nutritionPer100g,
    observedAt: row.nutrition_observed_at,
    labelVerifiedAt: row.label_verified_at,
    basis: row.nutrition_basis ?? "unknown",
  };
  const calculatedMetrics = calculateMetrics({
    nutrition,
    nutritionBasis: nutrition.basis,
    netQuantityGrams: row.net_quantity_grams,
    servingSizeGrams: row.serving_size_grams,
    sellingPrice: null,
  });
  const nutritionPassesValidation = !hasNutritionErrors(validateNutrition(
    nutritionPer100g,
    row.nutrition_basis ?? "unknown",
  ));
  const metrics = (row.nutrition_status === "verified" || row.nutrition_status === "machine_verified" || row.nutrition_status === "unverified") && nutritionPassesValidation
    ? {
      proteinPer100Calories: calculatedMetrics.proteinPer100Calories,
      proteinCaloriePercentage: calculatedMetrics.proteinCaloriePercentage,
      caloriesFor25gProtein: calculatedMetrics.caloriesFor25gProtein,
      sugarPer25gProtein: calculatedMetrics.sugarPer25gProtein,
      saturatedFatPer25gProtein: calculatedMetrics.saturatedFatPer25gProtein,
      fibrePer100Calories: calculatedMetrics.fibrePer100Calories,
    }
    : {
        proteinPer100Calories: { value: null, reason: nutritionPassesValidation ? `nutrition_${row.nutrition_status ?? "missing"}` : "nutrition_validation_error" },
        proteinCaloriePercentage: { value: null, reason: nutritionPassesValidation ? `nutrition_${row.nutrition_status ?? "missing"}` : "nutrition_validation_error" },
        caloriesFor25gProtein: { value: null, reason: nutritionPassesValidation ? `nutrition_${row.nutrition_status ?? "missing"}` : "nutrition_validation_error" },
        sugarPer25gProtein: { value: null, reason: nutritionPassesValidation ? `nutrition_${row.nutrition_status ?? "missing"}` : "nutrition_validation_error" },
        saturatedFatPer25gProtein: { value: null, reason: nutritionPassesValidation ? `nutrition_${row.nutrition_status ?? "missing"}` : "nutrition_validation_error" },
        fibrePer100Calories: { value: null, reason: nutritionPassesValidation ? `nutrition_${row.nutrition_status ?? "missing"}` : "nutrition_validation_error" },
      };
  return {
    id: row.id,
    gtin: row.gtin,
    imageUrl: row.image_url,
    nutritionImageUrl: row.nutrition_image_url,
    brand: row.brand,
    name: row.name,
    flavour: row.flavour,
    category: row.category,
    netQuantityGrams: row.net_quantity_grams,
    servingSizeGrams: row.serving_size_grams,
    marketedProtein: booleanValue(row.marketed_protein),
    marketedReasons: parseJson(row.marketed_reasons_json, []),
    nutritionallyProteinDense: booleanValue(row.nutritionally_protein_dense),
    nutritionReasons: parseJson(row.nutrition_reasons_json, []),
    nutritionStatus: row.nutrition_status ?? "missing",
    nutritionEvidenceAuthority: row.nutrition_evidence_authority,
    nutritionEvidenceUrl: row.nutrition_evidence_url,
    nutritionEvidenceKind: row.nutrition_evidence_kind,
    ingredientStatus: row.ingredient_status ?? "missing",
    ingredientEvidenceUrl: row.ingredient_evidence_url,
    ingredientEvidenceKind: row.ingredient_evidence_kind,
    ingredientTerminalOutcome: row.ingredient_terminal_outcome,
    completeness: row.completeness,
    nutrition,
    metrics,
  };
}

export interface SearchInput {
  q: string;
  category: string;
  trust: string;
  marketed: string;
  dense: string;
  verification: string;
  ingredientVerification: string;
  scope: string;
  minCompleteness: number;
  sort: string;
  page: number;
  pageSize: number;
}

export function validateSearch(input: URLSearchParams): { value?: SearchInput; error?: string } {
  const number = (name: string, fallback: number): number => {
    const value = Number(input.get(name) ?? fallback);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const value: SearchInput = {
    q: input.get("q")?.trim() ?? "",
    category: input.get("category") ?? "all",
    trust: input.get("trust") ?? "all",
    marketed: input.get("marketed") ?? "all",
    dense: input.get("dense") ?? "all",
    verification: input.get("verification") ?? "all",
    ingredientVerification: input.get("ingredientVerification") ?? "all",
    scope: input.get("scope") ?? "all",
    minCompleteness: number("minCompleteness", 0),
    sort: input.get("sort") ?? "protein_density",
    page: number("page", 1),
    pageSize: number("pageSize", 25),
  };
  if (value.category !== "all" && !PRODUCT_CATEGORIES.includes(value.category as ProductCategory)) return { error: "Invalid category" };
  const searchTerms = normalizeText(value.q).split(" ").filter(Boolean);
  if (value.q.length > 200 || searchTerms.length > 12) return { error: "Search query is too long" };
  if (!["all", "true", "false"].includes(value.marketed)) return { error: "Invalid marketed filter" };
  if (!["all", "strict"].includes(value.trust)) return { error: "Invalid trust filter" };
  if (!["all", "true", "false", "unknown"].includes(value.dense)) return { error: "Invalid dense filter" };
  if (!["all", "missing", "unverified", "machine_verified", "verified", "conflict"].includes(value.verification)) return { error: "Invalid verification filter" };
  if (!["all", "missing", "unverified", "verified", "conflict"].includes(value.ingredientVerification)) {
    return { error: "Invalid ingredient verification filter" };
  }
  if (!["all", "protein", "protein_branded"].includes(value.scope)) return { error: "Invalid scope" };
  if (!["protein_density", "completeness", "name"].includes(value.sort)) return { error: "Invalid sort" };
  if (!Number.isInteger(value.page) || value.page < 1) return { error: "Page must be a positive integer" };
  if (!Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 100) return { error: "Page size must be between 1 and 100" };
  if (!Number.isInteger(value.minCompleteness) || value.minCompleteness < 0 || value.minCompleteness > 100) return { error: "Minimum completeness must be between 0 and 100" };
  return { value };
}

const SELECT_PRODUCT = `
  SELECT p.id, p.gtin, p.image_url, p.nutrition_image_url, p.brand, p.name, p.flavour, p.category,
    p.net_quantity_grams, p.serving_size_grams, p.marketed_protein,
    p.marketed_reasons_json, p.nutritionally_protein_dense,
    p.nutrition_reasons_json, p.completeness, p.completeness_missing_json,
    CASE
      WHEN verified_nutrition.product_id IS NOT NULL THEN 'verified'
      WHEN machine_nutrition.product_id IS NOT NULL THEN 'machine_verified'
      WHEN n.status = 'verified' THEN 'unverified'
      ELSE n.status
    END AS nutrition_status,
    CASE
      WHEN verified_nutrition.product_id IS NOT NULL AND verified_nutrition.evidence_kind = 'source' THEN 'authoritative_source'
      WHEN verified_nutrition.product_id IS NOT NULL THEN 'human_reviewed_label'
      WHEN machine_nutrition.product_id IS NOT NULL THEN 'machine_verified_label'
      WHEN n.status IS NOT NULL AND n.status <> 'missing' AND nutrition_source.kind = 'brand' THEN 'first_party_structured_source'
      WHEN n.status IS NOT NULL AND n.status <> 'missing' THEN 'community'
      ELSE NULL
    END AS nutrition_evidence_authority,
    CASE
      WHEN i.status = 'verified' AND verified_ingredients.product_id IS NULL THEN 'unverified'
      ELSE i.status
    END AS ingredient_status,
    COALESCE(verified_nutrition.evidence_url, machine_nutrition.evidence_url) AS nutrition_evidence_url,
    COALESCE(verified_nutrition.evidence_kind, machine_nutrition.evidence_kind) AS nutrition_evidence_kind,
    COALESCE(verified_ingredients.evidence_url, ingredient_terminal.evidence_url) AS ingredient_evidence_url,
    COALESCE(verified_ingredients.evidence_kind, ingredient_terminal_decision.evidence_kind) AS ingredient_evidence_kind,
    ingredient_terminal.outcome AS ingredient_terminal_outcome,
    COALESCE(verified_nutrition.calories, machine_nutrition.calories, n.calories) AS calories,
    COALESCE(verified_nutrition.protein_grams, machine_nutrition.protein_grams, n.protein_grams) AS protein_grams,
    COALESCE(verified_nutrition.carbohydrate_grams, machine_nutrition.carbohydrate_grams, n.carbohydrate_grams) AS carbohydrate_grams,
    COALESCE(verified_nutrition.sugar_grams, machine_nutrition.sugar_grams, n.sugar_grams) AS sugar_grams,
    COALESCE(verified_nutrition.fat_grams, machine_nutrition.fat_grams, n.fat_grams) AS fat_grams,
    COALESCE(verified_nutrition.saturated_fat_grams, machine_nutrition.saturated_fat_grams, n.saturated_fat_grams) AS saturated_fat_grams,
    COALESCE(verified_nutrition.fibre_grams, machine_nutrition.fibre_grams, n.fibre_grams) AS fibre_grams,
    COALESCE(verified_nutrition.sodium_mg, machine_nutrition.sodium_mg, n.sodium_mg) AS sodium_mg,
    COALESCE(verified_nutrition.basis, machine_nutrition.basis, n.basis) AS nutrition_basis,
    COALESCE(verified_nutrition.observed_at, machine_nutrition.verified_at, n.observed_at) AS nutrition_observed_at,
    COALESCE(verified_nutrition.label_verified_at, machine_nutrition.verified_at, n.label_verified_at) AS label_verified_at
  FROM products p
  LEFT JOIN nutrition_facts n ON n.product_id = p.id
  LEFT JOIN source_records nutrition_record ON nutrition_record.id = n.source_record_id
  LEFT JOIN sources nutrition_source ON nutrition_source.id = nutrition_record.source_id
  LEFT JOIN ingredient_statements i ON i.product_id = p.id
  LEFT JOIN current_verified_nutrition_facts verified_nutrition
    ON verified_nutrition.product_id = p.id
  LEFT JOIN current_machine_verified_nutrition_facts machine_nutrition
    ON machine_nutrition.product_id = p.id
  LEFT JOIN current_verified_ingredient_statements verified_ingredients
    ON verified_ingredients.product_id = p.id
  LEFT JOIN terminal_evidence_projection_candidates ingredient_terminal_decision
    ON ingredient_terminal_decision.product_id = p.id
    AND ingredient_terminal_decision.field_family = 'ingredients'
    AND ingredient_terminal_decision.projection_rank = 1
  LEFT JOIN evidence_outcomes ingredient_terminal
    ON ingredient_terminal.product_id = ingredient_terminal_decision.product_id
    AND ingredient_terminal.field_family = ingredient_terminal_decision.field_family
    AND ingredient_terminal.outcome = ingredient_terminal_decision.outcome
    AND ingredient_terminal.source_record_id = ingredient_terminal_decision.source_record_id
    AND ingredient_terminal.evidence_url = ingredient_terminal_decision.evidence_url
    AND ingredient_terminal.observed_at = ingredient_terminal_decision.source_observed_at
    AND ingredient_terminal.verified_at = ingredient_terminal_decision.decided_at
    AND ingredient_terminal.decided_by = 'terminal_evidence_projection'
    AND ingredient_terminal.notes = 'terminal_evidence_decision:' || ingredient_terminal_decision.id
  `;

function filtersFor(input: SearchInput): { sql: string; bindings: Array<string | number> } {
  const clauses: string[] = ["p.is_active = 1"];
  const bindings: Array<string | number> = [];
  if (input.q) {
    for (const term of normalizeText(input.q).split(" ").filter(Boolean)) {
      clauses.push("(p.name_normalized LIKE ? OR p.brand_normalized LIKE ? OR COALESCE(p.flavour_normalized, '') LIKE ? OR p.gtin LIKE ? OR p.category LIKE ? OR COALESCE(p.category_raw, '') LIKE ? OR p.marketed_reasons_json LIKE ?)");
      const like = `%${term}%`;
      bindings.push(like, like, like, like, like, like, like);
    }
  }
  if (input.category !== "all") { clauses.push("p.category = ?"); bindings.push(input.category); }
  if (input.trust === "strict") clauses.push("p.id IN (SELECT id FROM strict_trusted_products)");
  if (input.marketed !== "all") { clauses.push("p.marketed_protein = ?"); bindings.push(input.marketed === "true" ? 1 : 0); }
  if (input.dense !== "all") {
    clauses.push(input.dense === "unknown" ? "p.nutritionally_protein_dense IS NULL" : "p.nutritionally_protein_dense = ?");
    if (input.dense !== "unknown") bindings.push(input.dense === "true" ? 1 : 0);
  }
  if (input.verification !== "all") {
    clauses.push(`COALESCE(CASE
      WHEN verified_nutrition.product_id IS NOT NULL THEN 'verified'
      WHEN machine_nutrition.product_id IS NOT NULL THEN 'machine_verified'
      WHEN n.status = 'verified' THEN 'unverified'
      ELSE n.status
    END, 'missing') = ?`);
    bindings.push(input.verification);
  }
  if (input.ingredientVerification !== "all") {
    clauses.push(`COALESCE(CASE
      WHEN i.status = 'verified' AND verified_ingredients.product_id IS NULL THEN 'unverified'
      ELSE i.status
    END, 'missing') = ?`);
    bindings.push(input.ingredientVerification);
  }
  if (input.scope === "protein") clauses.push("(p.marketed_protein = 1 OR p.nutritionally_protein_dense = 1)");
  if (input.scope === "protein_branded") {
    clauses.push("(p.marketed_protein = 1 OR p.brand_normalized LIKE '%protein%' OR p.brand_normalized LIKE '%whey%' OR p.brand_normalized LIKE '%casein%')");
  }
  clauses.push("p.completeness >= ?");
  bindings.push(input.minCompleteness);
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", bindings };
}

export async function searchProducts(db: D1Database, input: SearchInput): Promise<CatalogResponse> {
  const filters = filtersFor(input);
  const order = {
    protein_density: "CASE WHEN (verified_nutrition.product_id IS NOT NULL OR machine_nutrition.product_id IS NOT NULL OR n.status IN ('verified', 'unverified')) AND COALESCE(verified_nutrition.calories, machine_nutrition.calories, n.calories) > 0 AND COALESCE(verified_nutrition.protein_grams, machine_nutrition.protein_grams, n.protein_grams) >= 0 AND COALESCE(verified_nutrition.protein_grams, machine_nutrition.protein_grams, n.protein_grams) * 4.0 <= COALESCE(verified_nutrition.calories, machine_nutrition.calories, n.calories) THEN COALESCE(verified_nutrition.protein_grams, machine_nutrition.protein_grams, n.protein_grams) * 100.0 / COALESCE(verified_nutrition.calories, machine_nutrition.calories, n.calories) END DESC, p.name_normalized",
    completeness: "p.completeness DESC, p.name_normalized",
    name: "p.name_normalized, p.brand_normalized",
  }[input.sort] ?? "p.name_normalized";
  const offset = (input.page - 1) * input.pageSize;
  const list = db.prepare(`${SELECT_PRODUCT}${filters.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...filters.bindings, input.pageSize, offset);
  const count = db.prepare(`SELECT COUNT(*) AS total FROM products p
    LEFT JOIN nutrition_facts n ON n.product_id = p.id
    LEFT JOIN ingredient_statements i ON i.product_id = p.id
    LEFT JOIN current_verified_nutrition_facts verified_nutrition
      ON verified_nutrition.product_id = p.id
    LEFT JOIN current_machine_verified_nutrition_facts machine_nutrition
      ON machine_nutrition.product_id = p.id
    LEFT JOIN current_verified_ingredient_statements verified_ingredients
      ON verified_ingredients.product_id = p.id${filters.sql}`).bind(...filters.bindings);
  const batch = await db.batch<ProductRow | CountRow>([list, count]);
  const listResult = batch[0];
  const countResult = batch[1];
  if (!listResult || !countResult) throw new Error("Catalog query batch returned an incomplete result");
  const rows = listResult.results as ProductRow[];
  const total = (countResult.results[0] as CountRow | undefined)?.total ?? 0;
  return {
    products: rows.map(mapProduct),
    pagination: { page: input.page, pageSize: input.pageSize, total, pages: Math.ceil(total / input.pageSize) },
    trustedDefault: input.trust === "strict",
    filters: { ...input },
  };
}

interface SourceRow { id: string; source_id: string; source_record_id: string; source_url: string | null; observed_at: string; resolution_rule: string | null }
interface IngredientRow { id: string; parent_id: string | null; position: number; raw_text: string; normalized_name: string | null; percentage: number | null }
interface AllergenRow { name: string; declaration: "contains" | "may_contain" | "source_tag" }
interface AdditiveRow { identifier: string }
interface NutrientRow { nutrient_code: string; quantity: number; unit: string; basis: string; status: string; observed_at: string }
interface RatingRow { retailer: string; retailer_listing_id: string; stars: number; rating_count: number; review_count: number | null; observed_at: string }
interface ProvenanceRow { field_path: string; raw_value_json: string; normalized_value_json: string; source_id: string; confidence: string; authority: number; observed_at: string; evidence_url: string | null; selected: number }
interface IngredientStatementRow { raw_text: string | null }
interface OpenReviewRow { count: number }

function ingredientTree(rows: IngredientRow[], parentId: string | null = null): NormalizedIngredient[] {
  return rows
    .filter((row) => row.parent_id === parentId)
    .sort((a, b) => a.position - b.position)
    .map((row) => ({
      raw: row.raw_text,
      normalizedName: row.normalized_name,
      percentage: row.percentage,
      position: row.position,
      children: ingredientTree(rows, row.id),
    }));
}

export async function getProductDetail(db: D1Database, id: string): Promise<ProductDetailResponse | null> {
  const productStatement = db.prepare(`${SELECT_PRODUCT} WHERE p.id = ? AND p.is_active = 1`).bind(id);
  const statements = [
    productStatement,
    db.prepare("SELECT id, source_id, source_record_id, source_url, observed_at, resolution_rule FROM source_records WHERE product_id = ? ORDER BY observed_at DESC").bind(id),
    db.prepare("SELECT pi.id, pi.parent_id, pi.position, pi.raw_text, pi.normalized_name, pi.percentage FROM product_ingredients pi JOIN ingredient_statements s ON s.product_id = pi.product_id AND s.source_record_id = pi.source_record_id WHERE pi.product_id = ? ORDER BY pi.position").bind(id),
    db.prepare("SELECT DISTINCT name, declaration FROM product_allergens WHERE product_id = ? ORDER BY declaration, name").bind(id),
    db.prepare("SELECT DISTINCT identifier FROM product_additives WHERE product_id = ? ORDER BY identifier").bind(id),
    db.prepare(`SELECT DISTINCT nutrient.nutrient_code, nutrient.quantity, nutrient.unit,
      nutrient.basis,
      CASE
        WHEN nutrient.status = 'verified' AND NOT EXISTS (
          SELECT 1
          FROM current_verified_nutrition_facts verified
          WHERE verified.product_id = nutrient.product_id
            AND verified.source_record_id = nutrient.source_record_id
        ) THEN 'unverified'
        ELSE nutrient.status
      END AS status,
      nutrient.observed_at
      FROM nutrient_values nutrient
      WHERE nutrient.product_id = ?
      ORDER BY nutrient.nutrient_code LIMIT 300`).bind(id),
    db.prepare("SELECT retailer, retailer_listing_id, stars, rating_count, review_count, observed_at FROM ratings WHERE product_id = ? ORDER BY observed_at DESC LIMIT 100").bind(id),
    db.prepare("SELECT f.field_path, f.raw_value_json, f.normalized_value_json, s.source_id, f.confidence, f.authority, f.observed_at, f.evidence_url, f.selected FROM field_observations f JOIN source_records s ON s.id = f.source_record_id WHERE f.product_id = ? ORDER BY f.field_path, f.authority DESC").bind(id),
    db.prepare("SELECT raw_text FROM ingredient_statements WHERE product_id = ?").bind(id),
    db.prepare("SELECT COUNT(*) AS count FROM review_items WHERE product_id = ? AND status = 'open'").bind(id),
  ];
  const results = await db.batch(statements);
  const productRow = results[0]?.results[0] as ProductRow | undefined;
  if (!productRow) return null;
  const product = mapProduct(productRow);
  const ingredientRows = (results[2]?.results ?? []) as IngredientRow[];
  const statement = results[8]?.results[0] as IngredientStatementRow | undefined;
  const openReview = results[9]?.results[0] as OpenReviewRow | undefined;
  return {
    ...product,
    sourceRecords: ((results[1]?.results ?? []) as SourceRow[]).map((row) => ({ id: row.id, source: row.source_id, sourceRecordId: row.source_record_id, sourceUrl: row.source_url, observedAt: row.observed_at, resolutionRule: row.resolution_rule })),
    ingredientStatement: statement?.raw_text ?? null,
    ingredients: ingredientTree(ingredientRows),
    allergens: ((results[3]?.results ?? []) as AllergenRow[]).map((row) => ({ name: row.name, declaration: row.declaration })),
    additives: ((results[4]?.results ?? []) as AdditiveRow[]).map(({ identifier }) => identifier),
    nutrients: ((results[5]?.results ?? []) as NutrientRow[]).map((row) => ({ code: row.nutrient_code, quantity: row.quantity, unit: row.unit, basis: row.basis, status: row.status, observedAt: row.observed_at })),
    ratings: ((results[6]?.results ?? []) as RatingRow[]).map((row) => ({ retailer: row.retailer, listingId: row.retailer_listing_id, stars: row.stars, ratingCount: row.rating_count, reviewCount: row.review_count, observedAt: row.observed_at })),
    provenance: ((results[7]?.results ?? []) as ProvenanceRow[]).map((row) => ({ field: row.field_path, raw: parseJson(row.raw_value_json, null), normalized: parseJson(row.normalized_value_json, null), source: row.source_id, confidence: row.confidence, authority: row.authority, observedAt: row.observed_at, evidenceUrl: row.evidence_url, selected: row.selected === 1 })),
    completenessMissing: parseJson(productRow.completeness_missing_json, []),
    openReviewCount: openReview?.count ?? 0,
  };
}

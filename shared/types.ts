export const PRODUCT_CATEGORIES = [
  "protein_powder",
  "protein_bar",
  "protein_snack",
  "soy_product",
  "dairy",
  "plant_dairy",
  "ready_to_drink",
  "breakfast",
  "spread",
  "other",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];
type ProductKind =
  | "retail_packaged"
  | "raw_food"
  | "foodservice"
  | "prepared_dish"
  | "recipe"
  | "supplement";
export type EvidenceStatus = "missing" | "unverified" | "verified" | "conflict";
type Confidence = "low" | "medium" | "high";
type TriState = true | false | null;

export interface NutritionPer100g {
  calories: number | null;
  proteinGrams: number | null;
  carbohydrateGrams: number | null;
  sugarGrams: number | null;
  fatGrams: number | null;
  saturatedFatGrams: number | null;
  fibreGrams: number | null;
  sodiumMg: number | null;
}

export interface NutritionEvidence {
  per100g: NutritionPer100g;
  servingSizeGrams: number | null;
  basis: "per_100g" | "per_100ml" | "per_serving" | "unknown";
  preparationState: "as_sold" | "prepared" | "unknown";
  status: EvidenceStatus;
  confidence: Confidence;
  source: string;
  observedAt: string;
  labelVerifiedAt: string | null;
}

export interface NormalizedIngredient {
  raw: string;
  normalizedName: string | null;
  percentage: number | null;
  position: number;
  children: NormalizedIngredient[];
}

export interface AllergenDeclaration {
  name: string;
  declaration: "contains" | "may_contain" | "source_tag";
}

interface IngredientEvidence {
  raw: string | null;
  language: string | null;
  normalized: NormalizedIngredient[];
  allergens: AllergenDeclaration[];
  additives: string[];
  status: EvidenceStatus;
  confidence: Confidence;
  source: string;
  observedAt: string;
}

export interface GenericNutrientValue {
  code: string;
  quantity: number;
  unit: "g" | "mg" | "µg" | "kcal" | "kj";
  basis: "per_100g" | "per_100ml" | "per_serving" | "unknown";
  preparationState: "as_sold" | "prepared" | "unknown";
}

export interface StagedOffer {
  retailer: string;
  retailerListingId: string;
  pincode: string | null;
  seller: string | null;
  mrp: number | null;
  sellingPrice: number;
  available: boolean;
  url: string;
  observedAt: string;
}

interface StagedRating {
  retailer: string;
  retailerListingId: string;
  stars: number;
  ratingCount: number;
  reviewCount: number | null;
  observedAt: string;
}

export interface ProteinClassification {
  marketed: TriState;
  marketedReasons: string[];
  nutritionallyDense: TriState;
  nutritionReasons: string[];
  version: string;
}

export interface StagedProduct {
  source: string;
  sourceKind: "official" | "brand" | "open_data" | "retailer" | "label" | "fixture";
  sourceAuthority: {
    identity: number;
    nutrition: number;
    ingredients: number;
  };
  sourceLicenseUrl: string | null;
  sourceRetentionNotes: string;
  sourceRecordId: string;
  sourceUrl: string | null;
  observedAt: string;
  contentHash: string;
  gtinRaw: string | null;
  gtin: string | null;
  brand: string;
  name: string;
  flavour: string | null;
  category: ProductCategory;
  categoryRaw: string | null;
  productKind: ProductKind;
  netQuantityGrams: number | null;
  servingSizeGrams: number | null;
  imageUrl: string | null;
  nutritionImageUrl: string | null;
  ingredientImageUrl: string | null;
  offers: StagedOffer[];
  ratings: StagedRating[];
  nutrition: NutritionEvidence;
  nutrients: GenericNutrientValue[];
  ingredients: IngredientEvidence;
  classification: ProteinClassification;
  completeness: number;
  completenessMissing: string[];
  rawEvidence: Record<string, unknown>;
  validationIssues: ValidationIssue[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "warning" | "error";
  field: string;
  details?: Record<string, unknown>;
}

export interface SourceManifest {
  schemaVersion: 1;
  source: string;
  sourceKind: "official" | "brand" | "open_data" | "retailer" | "label" | "fixture";
  sourceAuthority: {
    identity: number;
    nutrition: number;
    ingredients: number;
  };
  sourceLicenseUrl: string | null;
  sourceRetentionNotes: string;
  adapterVersion: string;
  input: string;
  inputHash: string | null;
  inputBytes: number | null;
  sourceUpdatedAt: string | null;
  startedAt: string;
  completedAt: string;
  mode: "sample" | "production";
  terminalEvidence: "end_of_file" | "limit" | "error";
  sourceComplete: boolean;
  /** Present on exact label-extraction manifests. Source traversal and evidence verification are separate. */
  outcomeAccountingComplete?: boolean;
  verificationComplete?: boolean;
  residualExceptionCount?: number;
  residualExceptionRate?: number;
  residualExceptionLimits?: {
    maxCount: number;
    maxRate: number;
  };
  marketComplete: false;
  advertisedTotal: number | null;
  recordsRead: number;
  indiaRecords: number;
  stagedRecords: number;
  invalidRecords: number;
  duplicateRecords: number;
  newRecords: number;
  changedRecords: number;
  unchangedRecords: number;
  missingSinceRecords: number;
  knownExclusions: string[];
  disconnectedSources: string[];
}

export interface MetricResult {
  value: number | null;
  reason: string | null;
}

export interface ProductMetrics {
  proteinPer100Calories: MetricResult;
  proteinCaloriePercentage: MetricResult;
  costPer25gProtein: MetricResult;
  proteinPerInr100: MetricResult;
  caloriesFor25gProtein: MetricResult;
  sugarPer25gProtein: MetricResult;
  saturatedFatPer25gProtein: MetricResult;
  fibrePer100Calories: MetricResult;
  pricePerServing: MetricResult;
  totalProteinInPack: MetricResult;
}

import type {
  AllergenDeclaration,
  EvidenceStatus,
  NormalizedIngredient,
  NutritionPer100g,
  ProductCategory,
  ProductMetrics,
} from "./types";
import type { ReviewedNutritionProjection, SelectedNutritionProjection } from "./evidence-decisions";

export type NutritionEvidenceStatus = EvidenceStatus | "machine_verified";

type ConsumerMetrics = Pick<ProductMetrics,
  | "proteinPer100Calories"
  | "proteinCaloriePercentage"
  | "caloriesFor25gProtein"
  | "sugarPer25gProtein"
  | "saturatedFatPer25gProtein"
  | "fibrePer100Calories"
>;

export interface CatalogProduct {
  id: string;
  gtin: string | null;
  imageUrl: string | null;
  nutritionImageUrl: string | null;
  brand: string;
  name: string;
  flavour: string | null;
  category: ProductCategory;
  netQuantityGrams: number | null;
  servingSizeGrams: number | null;
  marketedProtein: boolean | null;
  marketedReasons: string[];
  nutritionallyProteinDense: boolean | null;
  nutritionReasons: string[];
  nutritionStatus: NutritionEvidenceStatus;
  nutritionEvidenceAuthority: "human_reviewed_label" | "authoritative_source" | "machine_verified_label" | "first_party_structured_source" | "community" | null;
  nutritionEvidenceUrl: string | null;
  nutritionEvidenceKind: "label" | "source" | null;
  ingredientStatus: EvidenceStatus;
  ingredientEvidenceUrl: string | null;
  ingredientEvidenceKind: "label" | "source" | null;
  ingredientTerminalOutcome: TerminalUnavailableOutcome | null;
  completeness: number;
  nutrition: {
    calories: number | null;
    proteinGrams: number | null;
    carbohydrateGrams: number | null;
    sugarGrams: number | null;
    fatGrams: number | null;
    saturatedFatGrams: number | null;
    fibreGrams: number | null;
    sodiumMg: number | null;
    basis: "per_100g" | "per_100ml" | "per_serving" | "unknown";
    observedAt: string | null;
    labelVerifiedAt: string | null;
  };
  metrics: ConsumerMetrics;
}

export interface CatalogResponse {
  products: CatalogProduct[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
  trustedDefault: boolean;
  filters: Record<string, string | number | null>;
}

export interface ProductDetailResponse extends CatalogProduct {
  sourceRecords: Array<{
    id: string;
    source: string;
    sourceRecordId: string;
    sourceUrl: string | null;
    observedAt: string;
    resolutionRule: string | null;
  }>;
  ingredientStatement: string | null;
  ingredients: NormalizedIngredient[];
  allergens: AllergenDeclaration[];
  additives: string[];
  nutrients: Array<{ code: string; quantity: number; unit: string; basis: string; status: string; observedAt: string }>;
  ratings: Array<{ retailer: string; listingId: string; stars: number; ratingCount: number; reviewCount: number | null; observedAt: string }>;
  provenance: Array<{ field: string; raw: unknown; normalized: unknown; source: string; confidence: string; authority: number; observedAt: string; evidenceUrl: string | null; selected: boolean }>;
  completenessMissing: string[];
  openReviewCount: number;
}

export interface ReviewItem {
  id: string;
  type: string;
  priority: number;
  status: string;
  productId: string | null;
  productName: string | null;
  brand: string | null;
  sourceRecordId: string | null;
  sourceUrl: string | null;
  candidateProductIds: string[];
  candidates: Array<{
    id: string;
    gtin: string | null;
    brand: string;
    name: string;
    flavour: string | null;
    netQuantityGrams: number | null;
    category: ProductCategory;
  }>;
  evidence: unknown;
  selectedProjection: SelectedNutritionProjection | null;
  /** Present for reviewer-corrected nutrition decisions. Older responses omit it. */
  reviewedProjection?: ReviewedNutritionProjection | null;
  /** Field-level audit summary supplied by the review API for corrected decisions. */
  nutritionChanges?: NutritionReviewChange[];
  redundantProjectionMatches: boolean;
  redundantEligible: boolean;
  createdAt: string;
  decision: ReviewDecision | null;
  rationale: string | null;
  decisionEvidenceUrl: string | null;
  decidedBy: string | null;
}

interface NutritionReviewChange {
  field: keyof NutritionPer100g;
  originalValue: number | null;
  reviewedValue: number | null;
}

export type ReviewDecision =
  | "verify_nutrition"
  | "reject_nutrition"
  | "redundant_nutrition"
  | "verify_ingredients"
  | "reject_ingredients"
  | "dismiss"
  | "match"
  | "create_new"
  | "no_match";

export type ReviewStatus = "open" | "resolved" | "dismissed";

export type ReviewType =
  | "identity"
  | "invalid_gtin"
  | "nutrition_validation"
  | "nutrition_conflict"
  | "ingredient_conflict"
  | "coverage_gap";

export interface ReviewResponse {
  items: ReviewItem[];
  counts: { open: number; resolved: number; dismissed: number };
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

export interface CoverageResponse {
  catalog: {
    products: number;
    validGtin: number;
    missingNutrition: number;
    structuredNutrition: number;
    nutritionLabelImages: number;
    extractionCandidates: number;
    verifiedNutrition: number;
    machineVerifiedNutrition: number;
    unverifiedNutrition: number;
    conflictingNutrition: number;
    unverifiedIngredients: number;
    verifiedIngredients: number;
    marketedProtein: number;
    proteinBranded: number;
    proteinBrandedWithUsableNutrition: number;
    nutritionallyProteinDense: number;
    terminalUnavailableNutrition: number;
    terminalUnavailableIngredients: number;
  };
  completion: {
    status: "complete" | "incomplete";
    sourceCoverageComplete: boolean;
    outstandingIdentity: number;
    outstandingNutrition: number;
    outstandingIngredients: number;
    contradictions: number;
    snapshotAt: string | null;
    families: Record<CompletionFamily, CompletionSummary>;
  };
  sources: Array<{
    id: string;
    name: string;
    kind: string;
    latestRunStatus: string | null;
    latestRunAt: string | null;
    recordsRead: number | null;
    indiaRecords: number | null;
    sourceComplete: boolean | null;
    marketComplete: false;
  }>;
  disconnectedSources: string[];
  claim: "configured_sources_only";
}

export type CompletionFamily = "identity" | "nutrition" | "ingredients";
export type CompletionState = "verified" | "terminal_unavailable" | "outstanding";
export type CompletionStateFilter = CompletionState | "all";
export type CompletionLane =
  | "evidence_inconsistent"
  | "conflict_resolution"
  | "review_ready"
  | "retry_extraction"
  | "run_extraction"
  | "manual_label_review"
  | "structured_evidence_review"
  | "source_evidence_needed";
export type CompletionLaneFilter = CompletionLane | "all";
export type TerminalUnavailableOutcome = "not_applicable" | "not_declared";
type ExtractionLabelOutcome = "candidate" | "no_prediction" | "rejected" | "failed";

interface CompletionExtractionSummary {
  labels: number;
  candidate: number;
  noPrediction: number;
  rejected: number;
  failed: number;
  unattempted: number;
  stale: number;
  conflicts: number;
}

export interface CompletionLabelEvidence {
  attemptId: string;
  labelAssetId: string;
  sourceImageId: string;
  role: "requested" | "prediction";
  outcome: ExtractionLabelOutcome;
  labelUrl: string;
  contentSha256: string;
  fetchedAt: string;
  attemptedAt: string;
  reasonCodes: string[];
}

export interface CompletionSummary {
  family: CompletionFamily;
  activeProducts: number;
  verified: number;
  terminalUnavailable: number;
  outstanding: number;
  contradictions: number;
  accounted: number;
  invariantHolds: boolean;
  lanes: Record<CompletionLane, number>;
}

export interface CompletionLedgerItem {
  product: {
    id: string;
    gtin: string | null;
    brand: string;
    name: string;
    category: ProductCategory;
    imageUrl: string | null;
  };
  family: CompletionFamily;
  state: CompletionState;
  lane: CompletionLane | null;
  fieldStatus: EvidenceStatus | null;
  terminalOutcome: TerminalUnavailableOutcome | null;
  labelUrl: string | null;
  sourceUrl: string | null;
  sourceId: string | null;
  sourceRecordId: string | null;
  evidenceObservedAt: string | null;
  openCandidateCount: number;
  openReviewCount: number;
  primaryReviewId: string | null;
  primaryActionId: string;
  extraction: CompletionExtractionSummary;
  reasonCodes: string[];
  labels: CompletionLabelEvidence[];
  labelsTruncated: boolean;
}

export interface CompletionLedgerFilters {
  family: CompletionFamily;
  state: CompletionStateFilter;
  lane: CompletionLaneFilter;
  q: string;
  page: number;
  pageSize: number;
}

export interface CompletionLedgerResponse {
  items: CompletionLedgerItem[];
  summary: CompletionSummary;
  pagination: { page: number; pageSize: number; total: number; pages: number };
  filters: CompletionLedgerFilters;
  snapshotAt: string | null;
}

export interface CompletionLabelEvidenceResponse {
  productId: string;
  family: Exclude<CompletionFamily, "identity">;
  items: CompletionLabelEvidence[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

export interface IdentityEvidenceDecisionRequest {
  sourceRecordId: string;
  evidenceUrl: string;
  rationale: string;
}

export interface IdentityEvidenceDecisionResponse {
  status: "verified";
  productId: string;
  sourceRecordId: string;
  decisionId: string;
  idempotent: boolean;
}

export interface HealthResponse {
  status: "ok";
  products: number;
  runtime: "local" | "production";
  latestPublishedAt: string | null;
  sourceComplete: boolean | null;
  mutations: "local_only";
}

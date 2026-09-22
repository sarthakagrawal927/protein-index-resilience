import type { ReviewDecision, ReviewItem, ReviewResponse, ReviewStatus, ReviewType } from "../shared/api";
import {
  canonicalJson,
  effectiveNutritionProjection,
  isCorrectedNutritionDecisionPayload,
  nutritionCandidateFromEvidence,
  nutritionCandidateHash,
  nutritionDecisionCandidate,
  nutritionDecisionMatchesSelectedProjection,
  parseNutritionDecisionPayload,
  sha256Hex,
  validateEvidenceDecision,
  type NutritionDecisionPayload,
  type NutritionEvidenceDecisionInput,
  type EvidenceDecisionInput,
  type NutritionCandidate,
  type SelectedNutritionProjection,
} from "../shared/evidence-decisions";
import {
  ingredientCandidateFromEvidence,
  ingredientCandidateHash,
  validateIngredientEvidenceDecision,
  type IngredientEvidenceDecisionInput,
} from "../shared/ingredient-evidence";
import { parseIngredients } from "../shared/ingredients";
import {
  identityEvidenceDecisionDisposition,
  validateIdentityEvidenceDecision,
  type IdentityEvidenceDecision,
  type IdentityEvidenceDecisionDisposition,
} from "../shared/identity-evidence";
import type { EvidenceStatus, NormalizedIngredient, NutritionPer100g } from "../shared/types";
import {
  buildIdentityEvidenceDecision,
  currentIdentityEvidenceDecision,
  identityEvidenceWriteStatements,
} from "./identity-evidence";

interface ReviewRow {
  id: string;
  type: string;
  priority: number;
  status: string;
  product_id: string | null;
  product_name: string | null;
  brand: string | null;
  source_record_id: string | null;
  source_id: string | null;
  source_record_key: string | null;
  source_url: string | null;
  source_content_hash: string | null;
  product_gtin: string | null;
  candidate_product_ids_json: string;
  candidates_json: string;
  evidence_json: string;
  created_at: string;
  decision: string | null;
  decision_rationale: string | null;
  decision_evidence_url: string | null;
  decided_by: string | null;
  nutrition_status: string | null;
  nutrition_authority: number | null;
  nutrition_basis: string | null;
  calories: number | null;
  protein_grams: number | null;
  carbohydrate_grams: number | null;
  sugar_grams: number | null;
  fat_grams: number | null;
  saturated_fat_grams: number | null;
  fibre_grams: number | null;
  sodium_mg: number | null;
  nutrition_decision_candidate_hash: string | null;
  nutrition_decision_payload_json: string | null;
}

interface ReviewCountRow { status: "open" | "resolved" | "dismissed"; count: number }
interface ReviewTotalRow { total: number }

function parsed(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function extractionLinkFromEvidence(value: string, candidateHash: string): {
  extractionAttemptId?: string;
  labelAssetId?: string;
} | null {
  const root = parsed(value);
  const record = typeof root === "object" && root !== null && !Array.isArray(root)
    ? root as Record<string, unknown>
    : null;
  const details = typeof record?.details === "object" && record.details !== null && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : null;
  const attempt = details?.extractionAttemptId;
  const asset = details?.labelAssetId;
  if ((attempt === undefined || attempt === null) && (asset === undefined || asset === null)) return {};
  if (typeof attempt !== "string" || !/^xat_[a-f0-9]{24}$/.test(attempt)
    || typeof asset !== "string" || !/^lbl_[a-f0-9]{24}$/.test(asset)
    || details?.candidateHash !== candidateHash) return null;
  return { extractionAttemptId: attempt, labelAssetId: asset };
}

const EVIDENCE_STATUSES: EvidenceStatus[] = ["missing", "unverified", "verified", "conflict"];
const REVIEW_DECISIONS: ReviewDecision[] = [
  "verify_nutrition", "reject_nutrition", "redundant_nutrition",
  "verify_ingredients", "reject_ingredients", "dismiss", "match", "create_new", "no_match",
];

function reviewDecision(value: string | null): ReviewDecision | null {
  return REVIEW_DECISIONS.includes(value as ReviewDecision) ? value as ReviewDecision : null;
}

function selectedNutritionProjection(row: ReviewRow): SelectedNutritionProjection | null {
  if (
    !row.product_id
    || !EVIDENCE_STATUSES.includes(row.nutrition_status as EvidenceStatus)
    || (row.nutrition_basis !== "per_100g" && row.nutrition_basis !== "per_100ml")
  ) return null;
  const nutrition: NutritionPer100g = {
    calories: row.calories,
    proteinGrams: row.protein_grams,
    carbohydrateGrams: row.carbohydrate_grams,
    sugarGrams: row.sugar_grams,
    fatGrams: row.fat_grams,
    saturatedFatGrams: row.saturated_fat_grams,
    fibreGrams: row.fibre_grams,
    sodiumMg: row.sodium_mg,
  };
  if (Object.values(nutrition).some((value) => value !== null && !Number.isFinite(value))) return null;
  return {
    productId: row.product_id,
    status: row.nutrition_status as EvidenceStatus,
    authority: row.nutrition_authority ?? -1,
    basis: row.nutrition_basis,
    nutrition,
  };
}

async function redundantDecision(
  row: ReviewRow,
  candidate: NutritionCandidate | null,
  decidedAt = row.created_at,
): Promise<EvidenceDecisionInput | null> {
  if (
    !candidate || row.source_id !== "open_food_facts_robotoff" || !row.source_record_key
    || !row.source_record_id || !row.source_content_hash || !row.product_id
  ) return null;
  const candidateHash = await nutritionCandidateHash(candidate);
  const extractionLink = extractionLinkFromEvidence(row.evidence_json, candidateHash);
  if (extractionLink === null) return null;
  return {
    id: `evd_${row.id}`,
    sourceId: row.source_id,
    sourceRecordKey: row.source_record_key,
    sourceRecordId: row.source_record_id,
    sourceContentHash: row.source_content_hash,
    productId: row.product_id,
    candidateHash,
    ...extractionLink,
    fieldFamily: "nutrition",
    decision: "redundant",
    payload: candidate,
    evidenceUrl: candidate.imageUrl,
    rationale: row.decision_rationale ?? "Exact duplicate projection",
    decidedBy: row.decided_by ?? "local_operator",
    decidedAt,
  };
}

const NUTRITION_FIELDS = [
  ["calories", "calories", "kcal"],
  ["proteinGrams", "protein_grams", "g"],
  ["carbohydrateGrams", "carbohydrate_grams", "g"],
  ["sugarGrams", "sugar_grams", "g"],
  ["fatGrams", "fat_grams", "g"],
  ["saturatedFatGrams", "saturated_fat_grams", "g"],
  ["fibreGrams", "fibre_grams", "g"],
  ["sodiumMg", "sodium_mg", "mg"],
] as const;

interface ReviewedIngredientRow {
  id: string;
  parentId: string | null;
  ingredient: NormalizedIngredient;
}

function reviewedIngredientRows(
  reviewId: string,
  ingredients: NormalizedIngredient[],
  parentId: string | null = null,
  path = "",
): ReviewedIngredientRow[] {
  return ingredients.flatMap((ingredient) => {
    const itemPath = path ? `${path}_${ingredient.position}` : String(ingredient.position);
    const id = `ing_review_${reviewId}_${itemPath}`;
    return [
      { id, parentId, ingredient },
      ...reviewedIngredientRows(reviewId, ingredient.children, id, itemPath),
    ];
  });
}

async function correctedNutritionHistory(
  row: ReviewRow,
  candidate: NutritionCandidate | null,
): Promise<Pick<ReviewItem, "reviewedProjection" | "nutritionChanges"> | null> {
  if (
    !candidate
    || row.decision !== "verify_nutrition"
    || !row.nutrition_decision_candidate_hash
    || !row.nutrition_decision_payload_json
  ) return null;
  const payload = parseNutritionDecisionPayload(
    parsed(row.nutrition_decision_payload_json),
    row.product_gtin,
  );
  if (!payload || !isCorrectedNutritionDecisionPayload(payload)) return null;
  const candidateHash = await nutritionCandidateHash(candidate);
  if (
    candidateHash !== row.nutrition_decision_candidate_hash
    || canonicalJson(payload.candidate) !== canonicalJson(candidate)
  ) return null;
  const original = effectiveNutritionProjection(candidate).nutrition;
  const reviewed = effectiveNutritionProjection(payload).nutrition;
  return {
    reviewedProjection: payload.reviewedProjection,
    nutritionChanges: NUTRITION_FIELDS.flatMap(([field]) => (
      original[field] === reviewed[field]
        ? []
        : [{ field, originalValue: original[field], reviewedValue: reviewed[field] }]
    )),
  };
}

export async function listReviews(
  db: D1Database,
  status: ReviewStatus,
  type: ReviewType | "all",
  page: number,
  pageSize: number,
  reviewId: string | null = null,
): Promise<ReviewResponse> {
  const typeFilter = type === "all" ? "" : " AND r.type = ?";
  const idFilter = reviewId === null ? "" : " AND r.id = ?";
  const offset = (page - 1) * pageSize;
  const filteredBindings: Array<string | number> = [status];
  if (type !== "all") filteredBindings.push(type);
  if (reviewId !== null) filteredBindings.push(reviewId);
  const itemBindings = [...filteredBindings, pageSize, offset];
  const totalBindings = filteredBindings;
  const countBindings = type === "all" ? [] : [type];
  const batch = await db.batch([
    db.prepare(`SELECT r.id, r.type, r.priority, r.status, r.product_id, p.name AS product_name, p.brand,
      r.source_record_id, s.source_id, s.source_record_id AS source_record_key, s.source_url,
      s.content_hash AS source_content_hash, p.gtin AS product_gtin,
      r.candidate_product_ids_json, r.evidence_json, r.created_at, r.decision, r.decision_rationale,
      r.decision_evidence_url, r.decided_by,
      nf.status AS nutrition_status, nf.authority AS nutrition_authority, nf.basis AS nutrition_basis,
      nf.calories, nf.protein_grams, nf.carbohydrate_grams, nf.sugar_grams, nf.fat_grams,
      nf.saturated_fat_grams, nf.fibre_grams, nf.sodium_mg,
      nutrition_decision.candidate_hash AS nutrition_decision_candidate_hash,
      nutrition_decision.payload_json AS nutrition_decision_payload_json,
      COALESCE((SELECT json_group_array(json_object(
        'id', candidate.id,
        'gtin', candidate.gtin,
        'brand', candidate.brand,
        'name', candidate.name,
        'flavour', candidate.flavour,
        'netQuantityGrams', candidate.net_quantity_grams,
        'category', candidate.category
      )) FROM json_each(r.candidate_product_ids_json) listed
      JOIN products candidate ON candidate.id = listed.value), '[]') AS candidates_json
      FROM review_items r
      LEFT JOIN products p ON p.id = r.product_id
      LEFT JOIN source_records s ON s.id = r.source_record_id
      LEFT JOIN nutrition_facts nf ON nf.product_id = r.product_id
      LEFT JOIN evidence_decisions nutrition_decision
        ON nutrition_decision.source_id = s.source_id
        AND nutrition_decision.source_record_key = s.source_record_id
        AND nutrition_decision.source_record_id = s.id
        AND nutrition_decision.source_content_hash = s.content_hash
        AND nutrition_decision.product_id = r.product_id
        AND (
          nutrition_decision.candidate_hash = json_extract(r.evidence_json, '$.details.candidateHash')
          OR (
            json_extract(r.evidence_json, '$.details.candidateHash') IS NULL
            AND (
              nutrition_decision.id = 'evd_' || r.id
              OR instr(nutrition_decision.id, 'evd_' || r.id || '_') = 1
            )
          )
        )
        AND nutrition_decision.field_family = 'nutrition'
        AND nutrition_decision.decision = 'verify'
        AND nutrition_decision.active = 1
      WHERE r.status = ?${typeFilter}${idFilter}
      ORDER BY r.priority DESC, r.created_at, r.id LIMIT ? OFFSET ?`).bind(...itemBindings),
    db.prepare(`SELECT COUNT(*) AS total FROM review_items r WHERE r.status = ?${typeFilter}${idFilter}`).bind(...totalBindings),
    db.prepare(`SELECT status, COUNT(*) AS count FROM review_items${type === "all" ? "" : " WHERE type = ?"} GROUP BY status`)
      .bind(...countBindings),
  ]);
  const itemsResult = batch[0];
  const totalResult = batch[1];
  const countsResult = batch[2];
  if (!itemsResult || !totalResult || !countsResult) throw new Error("Review query batch returned an incomplete result");
  const items = await Promise.all((itemsResult.results as ReviewRow[]).map<Promise<ReviewItem>>(async (row) => {
    const evidence = parsed(row.evidence_json);
    const candidate = row.source_id === "open_food_facts_robotoff"
      ? nutritionCandidateFromEvidence(evidence, row.product_gtin)
      : null;
    const selectedProjection = selectedNutritionProjection(row);
    const duplicate = await redundantDecision(row, candidate);
    const redundantProjectionMatches = duplicate !== null && selectedProjection !== null
      && nutritionDecisionMatchesSelectedProjection(duplicate, selectedProjection);
    const correctedHistory = await correctedNutritionHistory(row, candidate);
    return {
      id: row.id,
      type: row.type,
      priority: row.priority,
      status: row.status,
      productId: row.product_id,
      productName: row.product_name,
      brand: row.brand,
      sourceRecordId: row.source_record_id,
      sourceUrl: row.source_url,
      candidateProductIds: parsed(row.candidate_product_ids_json) as string[] ?? [],
      candidates: parsed(row.candidates_json) as ReviewItem["candidates"] ?? [],
      evidence,
      selectedProjection,
      ...(correctedHistory ?? {}),
      redundantProjectionMatches,
      redundantEligible: row.status === "open" && redundantProjectionMatches,
      createdAt: row.created_at,
      decision: reviewDecision(row.decision),
      rationale: row.decision_rationale,
      decisionEvidenceUrl: row.decision_evidence_url,
      decidedBy: row.decided_by,
    };
  }));
  const total = (totalResult.results[0] as ReviewTotalRow | undefined)?.total ?? 0;
  const counts = { open: 0, resolved: 0, dismissed: 0 };
  for (const row of countsResult.results as ReviewCountRow[]) counts[row.status] = row.count;
  return {
    items,
    counts,
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
  };
}

export async function resolveReview(
  db: D1Database,
  id: string,
  decision: ReviewDecision,
  rationale: string,
  evidenceUrl: string | null,
  candidateProductId: string | null,
  reviewedText: string | null,
  reviewedProjection: unknown | null,
): Promise<"resolved" | "not_found" | "conflict" | "invalid_decision" | "invalid_candidate"> {
  const review = await db.prepare(`SELECT r.id, r.status, r.product_id, r.type, r.candidate_product_ids_json,
    r.source_record_id, r.evidence_json, s.source_id, s.source_record_id AS source_record_key,
    s.content_hash AS source_content_hash, s.identity_hash, s.observed_at AS source_observed_at,
    p.gtin AS product_gtin, nf.product_id AS nutrition_product_id,
    nf.status AS nutrition_status, nf.authority AS nutrition_authority, nf.basis AS nutrition_basis,
    nf.calories, nf.protein_grams, nf.carbohydrate_grams, nf.sugar_grams, nf.fat_grams,
    nf.saturated_fat_grams, nf.fibre_grams, nf.sodium_mg
    FROM review_items r
    LEFT JOIN source_records s ON s.id = r.source_record_id
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN nutrition_facts nf ON nf.product_id = r.product_id
    WHERE r.id = ?`).bind(id).first<{
    id: string;
    status: string;
    product_id: string | null;
    type: string;
    candidate_product_ids_json: string;
    source_record_id: string | null;
    evidence_json: string;
    source_id: string | null;
    source_record_key: string | null;
    source_content_hash: string | null;
    identity_hash: string | null;
    source_observed_at: string | null;
    product_gtin: string | null;
    nutrition_product_id: string | null;
    nutrition_status: string | null;
    nutrition_authority: number | null;
    nutrition_basis: string | null;
    calories: number | null;
    protein_grams: number | null;
    carbohydrate_grams: number | null;
    sugar_grams: number | null;
    fat_grams: number | null;
    saturated_fat_grams: number | null;
    fibre_grams: number | null;
    sodium_mg: number | null;
  }>();
  if (!review) return "not_found";
  if (review.status !== "open") return "conflict";
  const nutritionReview = ["nutrition_validation", "nutrition_conflict", "coverage_gap"].includes(review.type);
  if (["verify_nutrition", "reject_nutrition", "redundant_nutrition"].includes(decision) && !nutritionReview) return "invalid_decision";
  const ingredientReview = review.type === "ingredient_conflict"
    && review.source_id === "open_food_facts_robotoff_ingredients";
  if (["verify_ingredients", "reject_ingredients"].includes(decision) && !ingredientReview) return "invalid_decision";
  if (ingredientReview && !["verify_ingredients", "reject_ingredients", "dismiss"].includes(decision)) return "invalid_decision";
  const identityReview = review.type === "identity";
  if (["match", "create_new", "no_match"].includes(decision) && !identityReview) return "invalid_decision";
  if (identityReview && !["match", "create_new", "no_match", "dismiss"].includes(decision)) return "invalid_decision";
  const candidateIds = parsed(review.candidate_product_ids_json);
  if (decision === "match" && (
    !candidateProductId ||
    !Array.isArray(candidateIds) ||
    !candidateIds.includes(candidateProductId)
  )) return "invalid_candidate";
  if (decision !== "match" && candidateProductId !== null) return "invalid_candidate";
  if (identityReview && decision !== "dismiss" && (
    !review.product_id ||
    !review.source_record_id ||
    !review.source_id ||
    !review.source_record_key ||
    !review.identity_hash ||
    !review.source_observed_at
  )) return "invalid_decision";
  if (identityReview && ["match", "create_new"].includes(decision) && evidenceUrl === null) {
    return "invalid_decision";
  }
  const candidate = review.source_id === "open_food_facts_robotoff"
    ? nutritionCandidateFromEvidence(parsed(review.evidence_json), review.product_gtin)
    : null;
  const ingredientCandidate = review.source_id === "open_food_facts_robotoff_ingredients"
    ? ingredientCandidateFromEvidence(parsed(review.evidence_json), review.product_gtin)
    : null;
  if (["verify_nutrition", "reject_nutrition", "redundant_nutrition"].includes(decision) && review.source_id === "open_food_facts_robotoff" && !candidate) return "invalid_candidate";
  if (decision === "verify_nutrition" && !candidate && !review.nutrition_product_id) return "invalid_decision";
  if (decision === "redundant_nutrition" && (review.source_id !== "open_food_facts_robotoff" || !candidate)) return "invalid_decision";
  if (["verify_ingredients", "reject_ingredients"].includes(decision) && !ingredientCandidate) return "invalid_candidate";
  if (reviewedProjection !== null && (decision !== "verify_nutrition" || !candidate)) return "invalid_candidate";
  const status = decision === "dismiss" ? "dismissed" : "resolved";
  const decidedAt = new Date().toISOString();
  let evidenceDecision: NutritionEvidenceDecisionInput | null = null;
  let ingredientEvidenceDecision: IngredientEvidenceDecisionInput | null = null;
  let identityEvidenceDecision: IdentityEvidenceDecision | null = null;
  let identityEvidenceDisposition: IdentityEvidenceDecisionDisposition | null = null;
  const identityTargetProductId = decision === "match"
    ? candidateProductId
    : decision === "create_new" ? review.product_id : null;
  if (
    identityReview
    && (decision === "match" || decision === "create_new")
    && identityTargetProductId
    && review.source_id
    && review.source_record_key
    && review.source_record_id
    && review.identity_hash
    && review.source_observed_at
    && evidenceUrl
  ) {
    const attempted = await buildIdentityEvidenceDecision({
      productId: identityTargetProductId,
      sourceId: review.source_id,
      sourceRecordKey: review.source_record_key,
      sourceRecordId: review.source_record_id,
      identityHash: review.identity_hash,
      evidenceUrl,
      sourceObservedAt: review.source_observed_at,
      rationale,
      decidedAt,
    });
    if ((await validateIdentityEvidenceDecision(attempted)).length > 0) return "invalid_candidate";
    const existing = await currentIdentityEvidenceDecision(db, attempted);
    identityEvidenceDisposition = identityEvidenceDecisionDisposition(existing, attempted);
    if (identityEvidenceDisposition === "conflict") return "conflict";
    identityEvidenceDecision = identityEvidenceDisposition === "idempotent" && existing
      ? existing
      : attempted;
  }
  if (
    candidate && review.source_id && review.source_record_key && review.source_record_id &&
    review.source_content_hash && review.product_id && ["verify_nutrition", "reject_nutrition", "redundant_nutrition"].includes(decision)
  ) {
    const candidateHash = await nutritionCandidateHash(candidate);
    const extractionLink = extractionLinkFromEvidence(review.evidence_json, candidateHash);
    if (extractionLink === null) return "invalid_candidate";
    const baseDecisionId = `evd_${id}`;
    const priorBaseDecision = await db.prepare("SELECT active FROM evidence_decisions WHERE id = ?")
      .bind(baseDecisionId).first<{ active: number }>();
    const decisionId = priorBaseDecision?.active === 0
      ? `${baseDecisionId}_${(await sha256Hex({ sourceContentHash: review.source_content_hash, candidateHash })).slice(0, 16)}`
      : baseDecisionId;
    let payload: NutritionDecisionPayload = candidate;
    if (reviewedProjection !== null) {
      const parsedPayload = parseNutritionDecisionPayload({ candidate, reviewedProjection }, candidate.barcode);
      if (!parsedPayload || !isCorrectedNutritionDecisionPayload(parsedPayload)) return "invalid_candidate";
      payload = parsedPayload;
    }
    const commonDecision = {
      id: decisionId,
      sourceId: review.source_id,
      sourceRecordKey: review.source_record_key,
      sourceRecordId: review.source_record_id,
      sourceContentHash: review.source_content_hash,
      productId: review.product_id,
      candidateHash,
      ...extractionLink,
      fieldFamily: "nutrition" as const,
      evidenceUrl: decision === "redundant_nutrition" ? candidate.imageUrl : evidenceUrl ?? candidate.imageUrl,
      rationale,
      decidedBy: "local_operator",
      decidedAt,
    };
    const builtDecision: NutritionEvidenceDecisionInput = isCorrectedNutritionDecisionPayload(payload)
      ? { ...commonDecision, decision: "verify", payload }
      : {
        ...commonDecision,
        decision: decision === "verify_nutrition" ? "verify" : decision === "reject_nutrition" ? "reject" : "redundant",
        payload,
      };
    evidenceDecision = builtDecision;
    if ((await validateEvidenceDecision(builtDecision)).length > 0) return "invalid_candidate";
    if (decision === "redundant_nutrition") {
      const selectedProjection: SelectedNutritionProjection | null = (
        review.product_id
        && EVIDENCE_STATUSES.includes(review.nutrition_status as EvidenceStatus)
        && (review.nutrition_basis === "per_100g" || review.nutrition_basis === "per_100ml")
      ) ? {
        productId: review.product_id,
        status: review.nutrition_status as EvidenceStatus,
        authority: review.nutrition_authority ?? -1,
        basis: review.nutrition_basis,
        nutrition: {
          calories: review.calories,
          proteinGrams: review.protein_grams,
          carbohydrateGrams: review.carbohydrate_grams,
          sugarGrams: review.sugar_grams,
          fatGrams: review.fat_grams,
          saturatedFatGrams: review.saturated_fat_grams,
          fibreGrams: review.fibre_grams,
          sodiumMg: review.sodium_mg,
        },
      } : null;
      if (!selectedProjection || !nutritionDecisionMatchesSelectedProjection(builtDecision, selectedProjection)) {
        return "invalid_candidate";
      }
    }
    const conflicting = await db.prepare(`SELECT id FROM evidence_decisions
      WHERE id = ? OR (
        source_id = ? AND source_record_key = ? AND candidate_hash = ? AND field_family = 'nutrition' AND active = 1
      ) LIMIT 1`)
      .bind(builtDecision.id, builtDecision.sourceId, builtDecision.sourceRecordKey, builtDecision.candidateHash)
      .first<{ id: string }>();
    if (conflicting) return "conflict";
  }
  if (
    ingredientCandidate && review.source_id && review.source_record_key && review.source_record_id
    && review.source_content_hash && review.product_id
    && ["verify_ingredients", "reject_ingredients"].includes(decision)
  ) {
    const candidateHash = await ingredientCandidateHash(ingredientCandidate);
    const extractionLink = extractionLinkFromEvidence(review.evidence_json, candidateHash);
    if (extractionLink === null) return "invalid_candidate";
    ingredientEvidenceDecision = {
      id: `evd_${id}`,
      sourceId: review.source_id,
      sourceRecordKey: review.source_record_key,
      sourceRecordId: review.source_record_id,
      sourceContentHash: review.source_content_hash,
      productId: review.product_id,
      candidateHash,
      ...extractionLink,
      fieldFamily: "ingredients",
      decision: decision === "verify_ingredients" ? "verify" : "reject",
      payload: {
        candidate: ingredientCandidate,
        reviewedText: decision === "verify_ingredients" ? reviewedText : null,
        normalizedIngredients: decision === "verify_ingredients" && reviewedText ? parseIngredients(reviewedText) : [],
      },
      evidenceUrl: evidenceUrl ?? ingredientCandidate.imageUrl,
      rationale,
      decidedBy: "local_operator",
      decidedAt,
    };
    if ((await validateIngredientEvidenceDecision(ingredientEvidenceDecision)).length > 0) return "invalid_candidate";
    const conflicting = await db.prepare(`SELECT id FROM evidence_decisions
      WHERE id = ? OR (
        source_id = ? AND source_record_key = ? AND candidate_hash = ?
        AND field_family = 'ingredients' AND active = 1
      ) LIMIT 1`)
      .bind(
        ingredientEvidenceDecision.id,
        ingredientEvidenceDecision.sourceId,
        ingredientEvidenceDecision.sourceRecordKey,
        ingredientEvidenceDecision.candidateHash,
      )
      .first<{ id: string }>();
    if (conflicting) return "conflict";
  }
  const resolvedEvidenceUrl = ingredientEvidenceDecision?.evidenceUrl
    ?? evidenceDecision?.evidenceUrl
    ?? evidenceUrl;
  const redundantTransaction = decision === "redundant_nutrition" && evidenceDecision?.decision === "redundant";
  const guardedNutritionTransaction = evidenceDecision !== null && !redundantTransaction;
  const exactNutritionDecisionGuard = evidenceDecision
    ? `EXISTS (
        SELECT 1 FROM evidence_decisions exact_decision
        WHERE exact_decision.id = ? AND exact_decision.source_id = ?
          AND exact_decision.source_record_key = ? AND exact_decision.source_record_id = ?
          AND exact_decision.source_content_hash = ? AND exact_decision.product_id = ?
          AND exact_decision.candidate_hash = ? AND exact_decision.field_family = 'nutrition'
          AND exact_decision.decision = ? AND exact_decision.payload_json = ?
          AND exact_decision.active = 1
      )`
    : "0 = 1";
  const exactNutritionDecisionBindings = evidenceDecision
    ? [
      evidenceDecision.id,
      evidenceDecision.sourceId,
      evidenceDecision.sourceRecordKey,
      evidenceDecision.sourceRecordId,
      evidenceDecision.sourceContentHash,
      evidenceDecision.productId,
      evidenceDecision.candidateHash,
      evidenceDecision.decision,
      canonicalJson(evidenceDecision.payload),
    ]
    : [];
  let statements: D1PreparedStatement[];
  if (redundantTransaction && evidenceDecision) {
    const { nutrition, basis } = effectiveNutritionProjection(evidenceDecision.payload);
    const exactProjectionBindings = [
      evidenceDecision.productId,
      basis,
      nutrition.calories,
      nutrition.proteinGrams,
      nutrition.carbohydrateGrams,
      nutrition.sugarGrams,
      nutrition.fatGrams,
      nutrition.saturatedFatGrams,
      nutrition.fibreGrams,
      nutrition.sodiumMg,
    ];
    statements = [
      db.prepare(`INSERT INTO evidence_decisions
        (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
          candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
          decided_by, decided_at, active, extraction_attempt_id, label_asset_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'nutrition', 'redundant', ?, ?, ?, ?, ?, 1, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM review_items r
          JOIN source_records s ON s.id = r.source_record_id
          WHERE r.id = ? AND r.status = 'open' AND r.product_id = ? AND r.evidence_json = ?
            AND s.id = ? AND s.source_id = ? AND s.source_record_id = ? AND s.content_hash = ?
        ) AND EXISTS (
          SELECT 1 FROM nutrition_facts nf
          WHERE nf.product_id = ? AND nf.status = 'verified' AND nf.authority = 100 AND nf.basis = ?
            AND nf.calories IS ? AND nf.protein_grams IS ? AND nf.carbohydrate_grams IS ?
            AND nf.sugar_grams IS ? AND nf.fat_grams IS ? AND nf.saturated_fat_grams IS ?
            AND nf.fibre_grams IS ? AND nf.sodium_mg IS ?
        )`)
        .bind(
          evidenceDecision.id, evidenceDecision.sourceId, evidenceDecision.sourceRecordKey,
          evidenceDecision.sourceRecordId, evidenceDecision.sourceContentHash, evidenceDecision.productId,
          evidenceDecision.candidateHash, canonicalJson(evidenceDecision.payload), evidenceDecision.evidenceUrl,
          evidenceDecision.rationale, evidenceDecision.decidedBy, evidenceDecision.decidedAt,
          evidenceDecision.extractionAttemptId ?? null, evidenceDecision.labelAssetId ?? null,
          id, evidenceDecision.productId, review.evidence_json, evidenceDecision.sourceRecordId,
          evidenceDecision.sourceId, evidenceDecision.sourceRecordKey, evidenceDecision.sourceContentHash,
          ...exactProjectionBindings,
        ),
      db.prepare(`UPDATE review_items SET status = 'resolved', decision = 'redundant_nutrition',
        decision_rationale = ?, decision_evidence_url = ?, decided_by = 'local_operator', resolved_at = ?
        WHERE id = ? AND status = 'open' AND EXISTS (
          SELECT 1 FROM evidence_decisions d
          WHERE d.id = ? AND d.source_record_id = ? AND d.candidate_hash = ?
            AND d.field_family = 'nutrition' AND d.decision = 'redundant' AND d.active = 1
        )`)
        .bind(
          rationale, evidenceDecision.evidenceUrl, decidedAt, id,
          evidenceDecision.id, evidenceDecision.sourceRecordId, evidenceDecision.candidateHash,
        ),
    ];
  } else if (evidenceDecision) {
    statements = [
      db.prepare(`INSERT INTO evidence_decisions
        (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
          candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
          decided_by, decided_at, active, extraction_attempt_id, label_asset_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'nutrition', ?, ?, ?, ?, ?, ?, 1, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM review_items r
          JOIN source_records s ON s.id = r.source_record_id
          WHERE r.id = ? AND r.status = 'open' AND r.product_id = ?
            AND r.source_record_id = ? AND r.evidence_json = ?
            AND s.id = ? AND s.source_id = ? AND s.source_record_id = ?
            AND s.content_hash = ? AND s.product_id = ?
        )`)
        .bind(
          evidenceDecision.id, evidenceDecision.sourceId, evidenceDecision.sourceRecordKey,
          evidenceDecision.sourceRecordId, evidenceDecision.sourceContentHash, evidenceDecision.productId,
          evidenceDecision.candidateHash, evidenceDecision.decision, canonicalJson(evidenceDecision.payload),
          evidenceDecision.evidenceUrl, evidenceDecision.rationale, evidenceDecision.decidedBy,
          evidenceDecision.decidedAt, evidenceDecision.extractionAttemptId ?? null,
          evidenceDecision.labelAssetId ?? null,
          id, evidenceDecision.productId, evidenceDecision.sourceRecordId, review.evidence_json,
          evidenceDecision.sourceRecordId, evidenceDecision.sourceId, evidenceDecision.sourceRecordKey,
          evidenceDecision.sourceContentHash, evidenceDecision.productId,
        ),
      db.prepare(`UPDATE review_items SET status = ?, decision = ?, decision_rationale = ?,
        decision_evidence_url = ?, decided_by = 'local_operator', resolved_at = ?
        WHERE id = ? AND status = 'open' AND ${exactNutritionDecisionGuard}`)
        .bind(
          status, decision, rationale, resolvedEvidenceUrl, decidedAt, id,
          ...exactNutritionDecisionBindings,
        ),
    ];
  } else {
    statements = [
      db.prepare("UPDATE review_items SET status = ?, decision = ?, decision_rationale = ?, decision_evidence_url = ?, decided_by = 'local_operator', resolved_at = ? WHERE id = ? AND status = 'open'")
        .bind(status, decision, rationale, resolvedEvidenceUrl, decidedAt, id),
    ];
  }
  if (ingredientEvidenceDecision) {
    statements.push(db.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active, extraction_attempt_id, label_asset_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ingredients', ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(
        ingredientEvidenceDecision.id,
        ingredientEvidenceDecision.sourceId,
        ingredientEvidenceDecision.sourceRecordKey,
        ingredientEvidenceDecision.sourceRecordId,
        ingredientEvidenceDecision.sourceContentHash,
        ingredientEvidenceDecision.productId,
        ingredientEvidenceDecision.candidateHash,
        ingredientEvidenceDecision.decision,
        canonicalJson(ingredientEvidenceDecision.payload),
        ingredientEvidenceDecision.evidenceUrl,
        ingredientEvidenceDecision.rationale,
        ingredientEvidenceDecision.decidedBy,
        ingredientEvidenceDecision.decidedAt,
        ingredientEvidenceDecision.extractionAttemptId ?? null,
        ingredientEvidenceDecision.labelAssetId ?? null,
      ));
  }
  if (review.product_id && review.source_record_id && decision === "verify_nutrition" && candidate) {
    if (!evidenceDecision) return "invalid_candidate";
    const originalCandidate = nutritionDecisionCandidate(evidenceDecision.payload);
    const { nutrition, basis: normalizedBasis } = effectiveNutritionProjection(evidenceDecision.payload);
    statements.push(db.prepare(`INSERT INTO nutrition_facts
      (product_id, source_record_id, status, confidence, authority, basis, preparation_state,
        calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams,
        fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at)
      SELECT ?, ?, 'verified', 'high', 100, ?, 'as_sold', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${exactNutritionDecisionGuard}
      ON CONFLICT(product_id) DO UPDATE SET
        source_record_id = excluded.source_record_id, status = excluded.status, confidence = excluded.confidence,
        authority = excluded.authority, basis = excluded.basis, preparation_state = excluded.preparation_state,
        calories = excluded.calories, protein_grams = excluded.protein_grams,
        carbohydrate_grams = excluded.carbohydrate_grams, sugar_grams = excluded.sugar_grams,
        fat_grams = excluded.fat_grams, saturated_fat_grams = excluded.saturated_fat_grams,
        fibre_grams = excluded.fibre_grams, sodium_mg = excluded.sodium_mg,
        label_verified_at = excluded.label_verified_at, observed_at = excluded.observed_at,
        updated_at = excluded.updated_at`)
      .bind(review.product_id, review.source_record_id, normalizedBasis, nutrition.calories, nutrition.proteinGrams,
        nutrition.carbohydrateGrams, nutrition.sugarGrams, nutrition.fatGrams,
        nutrition.saturatedFatGrams, nutrition.fibreGrams, nutrition.sodiumMg,
        decidedAt, originalCandidate.observedAt, decidedAt,
        ...exactNutritionDecisionBindings));
    statements.push(db.prepare(`UPDATE field_observations SET selected = 0
      WHERE product_id = ? AND field_path LIKE 'nutrition.%' AND ${exactNutritionDecisionGuard}`)
      .bind(review.product_id, ...exactNutritionDecisionBindings));
    statements.push(db.prepare(`DELETE FROM nutrient_values
      WHERE product_id = ?
        AND nutrient_code IN ('calories', 'proteinGrams', 'carbohydrateGrams', 'sugarGrams',
          'fatGrams', 'saturatedFatGrams', 'fibreGrams', 'sodiumMg')
        AND ${exactNutritionDecisionGuard}`)
      .bind(review.product_id, ...exactNutritionDecisionBindings));
    for (const [field, column, unit] of NUTRITION_FIELDS) {
      const value = nutrition[field];
      if (value === null) continue;
      const observationId = `obs_review_${id}_${column}`;
      const valueJson = JSON.stringify(value);
      statements.push(db.prepare(`INSERT INTO field_observations
        (id, product_id, source_record_id, field_path, raw_value_json, normalized_value_json,
          confidence, authority, observed_at, evidence_url, selected, value_hash)
        SELECT ?, ?, ?, ?, ?, ?, 'high', 100, ?, ?, 1, ?
        WHERE ${exactNutritionDecisionGuard}
        ON CONFLICT(source_record_id, field_path, value_hash) DO UPDATE SET
          product_id = excluded.product_id, raw_value_json = excluded.raw_value_json,
          normalized_value_json = excluded.normalized_value_json,
          confidence = excluded.confidence, authority = excluded.authority,
          observed_at = excluded.observed_at, evidence_url = excluded.evidence_url, selected = 1`)
        .bind(observationId, review.product_id, review.source_record_id, `nutrition.${field}`,
          valueJson, valueJson, originalCandidate.observedAt, evidenceDecision.evidenceUrl,
          `review:${id}:${column}:${valueJson}`, ...exactNutritionDecisionBindings));
      statements.push(db.prepare(`INSERT INTO nutrient_values
        (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'as_sold', 'verified', ?
        WHERE ${exactNutritionDecisionGuard}
        ON CONFLICT(source_record_id, nutrient_code, basis, preparation_state) DO UPDATE SET
          product_id = excluded.product_id, quantity = excluded.quantity, unit = excluded.unit,
          status = excluded.status, observed_at = excluded.observed_at`)
        .bind(`ntr_review_${id}_${column}`, review.product_id, review.source_record_id, field, value,
          unit, normalizedBasis, originalCandidate.observedAt, ...exactNutritionDecisionBindings));
    }
    statements.push(db.prepare(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, source_record_id, evidence_url, observed_at, verified_at, decided_by, notes)
      SELECT ?, 'nutrition', 'verified', ?, ?, ?, ?, 'local_operator', ?
      WHERE ${exactNutritionDecisionGuard}
      ON CONFLICT(product_id, field_family) DO UPDATE SET
        outcome = excluded.outcome, source_record_id = excluded.source_record_id,
        evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
        verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes`)
      .bind(review.product_id, review.source_record_id, evidenceDecision.evidenceUrl,
        originalCandidate.observedAt, decidedAt,
        `${rationale} [Robotoff ${originalCandidate.modelName} ${originalCandidate.modelVersion}; prediction ${originalCandidate.predictionId}; image ${originalCandidate.imageId}]`,
        ...exactNutritionDecisionBindings));
    const nutritionReasons: string[] = [];
    if ((nutrition.proteinGrams! / nutrition.calories!) * 100 >= 10) nutritionReasons.push("protein_at_least_10g_per_100kcal");
    if (((nutrition.proteinGrams! * 4) / nutrition.calories!) * 100 >= 20) nutritionReasons.push("protein_at_least_20_percent_calories");
    statements.push(db.prepare(`UPDATE products SET
      nutritionally_protein_dense = CASE WHEN ? = 1 OR (? = 1 AND ? * serving_size_grams / 100.0 >= 10) THEN 1 ELSE 0 END,
      nutrition_reasons_json = CASE WHEN ? = 1 AND ? * serving_size_grams / 100.0 >= 10
        THEN json_insert(?, '$[#]', 'protein_at_least_10g_per_serving') ELSE ? END,
      classifier_version = 'protein-v1', updated_at = ? WHERE id = ?
        AND ${exactNutritionDecisionGuard}`)
      .bind(
        nutritionReasons.length > 0 ? 1 : 0,
        normalizedBasis === "per_100g" ? 1 : 0,
        nutrition.proteinGrams,
        normalizedBasis === "per_100g" ? 1 : 0,
        nutrition.proteinGrams,
        JSON.stringify(nutritionReasons),
        JSON.stringify(nutritionReasons),
        decidedAt,
        review.product_id,
        ...exactNutritionDecisionBindings,
      ));
  } else if (review.product_id && decision === "verify_nutrition") {
    statements.push(db.prepare("UPDATE nutrition_facts SET status = 'verified', confidence = 'high', label_verified_at = ?, updated_at = ? WHERE product_id = ?")
      .bind(decidedAt, decidedAt, review.product_id));
    statements.push(db.prepare(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, source_record_id, evidence_url, observed_at, verified_at, decided_by, notes)
      SELECT ?, 'nutrition', 'verified', ?, ?, observed_at, ?, 'local_operator', ?
      FROM nutrition_facts WHERE product_id = ?
      ON CONFLICT(product_id, field_family) DO UPDATE SET
        outcome = excluded.outcome, source_record_id = excluded.source_record_id,
        evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
        verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes`)
      .bind(review.product_id, review.source_record_id, evidenceUrl, decidedAt, rationale, review.product_id));
  }
  if (review.product_id && decision === "reject_nutrition" && review.source_id !== "open_food_facts_robotoff") {
    statements.push(db.prepare(`UPDATE nutrition_facts SET status = 'missing', confidence = 'low',
      calories = NULL, protein_grams = NULL, carbohydrate_grams = NULL, sugar_grams = NULL,
      fat_grams = NULL, saturated_fat_grams = NULL, fibre_grams = NULL, sodium_mg = NULL,
      label_verified_at = NULL, updated_at = ? WHERE product_id = ?`)
      .bind(decidedAt, review.product_id));
    statements.push(db.prepare("UPDATE field_observations SET selected = 0 WHERE product_id = ? AND field_path LIKE 'nutrition.%'")
      .bind(review.product_id));
    statements.push(db.prepare("UPDATE products SET nutritionally_protein_dense = NULL, nutrition_reasons_json = '[]', updated_at = ? WHERE id = ?")
      .bind(decidedAt, review.product_id));
  }
  if (
    review.product_id
    && review.source_record_id
    && decision === "verify_ingredients"
    && ingredientEvidenceDecision?.payload.reviewedText
    && ingredientCandidate
  ) {
    const reviewedTextValue = ingredientEvidenceDecision.payload.reviewedText;
    const reviewedIngredients = ingredientEvidenceDecision.payload.normalizedIngredients;
    const valueHash = `reviewed:${ingredientEvidenceDecision.candidateHash}:ingredients.raw`;
    statements.push(db.prepare(`INSERT INTO ingredient_statements
      (product_id, source_record_id, raw_text, language, status, confidence, authority, observed_at, updated_at)
      VALUES (?, ?, ?, ?, 'verified', 'high', 100, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        source_record_id = excluded.source_record_id, raw_text = excluded.raw_text,
        language = excluded.language, status = excluded.status, confidence = excluded.confidence,
        authority = excluded.authority, observed_at = excluded.observed_at, updated_at = excluded.updated_at`)
      .bind(
        review.product_id,
        review.source_record_id,
        reviewedTextValue,
        ingredientCandidate.language.code,
        ingredientCandidate.observedAt,
        decidedAt,
      ));
    statements.push(db.prepare("DELETE FROM product_ingredients WHERE product_id = ? AND source_record_id = ?")
      .bind(review.product_id, review.source_record_id));
    for (const row of reviewedIngredientRows(id, reviewedIngredients)) {
      statements.push(db.prepare(`INSERT INTO product_ingredients
        (id, product_id, source_record_id, parent_id, position, raw_text, normalized_name, percentage, resolved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          row.id,
          review.product_id,
          review.source_record_id,
          row.parentId,
          row.ingredient.position,
          row.ingredient.raw,
          row.ingredient.normalizedName,
          row.ingredient.percentage,
          row.ingredient.normalizedName !== null ? 1 : 0,
        ));
    }
    statements.push(db.prepare("UPDATE field_observations SET selected = 0 WHERE product_id = ? AND field_path = 'ingredients.raw'")
      .bind(review.product_id));
    statements.push(db.prepare(`INSERT INTO field_observations
      (id, product_id, source_record_id, field_path, raw_value_json, normalized_value_json,
        confidence, authority, observed_at, evidence_url, selected, value_hash)
      VALUES (?, ?, ?, 'ingredients.raw', ?, ?, 'high', 100, ?, ?, 1, ?)
      ON CONFLICT(source_record_id, field_path, value_hash) DO UPDATE SET
        product_id = excluded.product_id, raw_value_json = excluded.raw_value_json,
        normalized_value_json = excluded.normalized_value_json, confidence = excluded.confidence,
        authority = excluded.authority, observed_at = excluded.observed_at,
        evidence_url = excluded.evidence_url, selected = 1`)
      .bind(
        `obs_review_${id}_ingredients_raw`,
        review.product_id,
        review.source_record_id,
        JSON.stringify(reviewedTextValue),
        JSON.stringify(reviewedIngredients),
        ingredientCandidate.observedAt,
        ingredientEvidenceDecision.evidenceUrl,
        valueHash,
      ));
    statements.push(db.prepare(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, source_record_id, evidence_url, observed_at, verified_at, decided_by, notes)
      VALUES (?, 'ingredients', 'verified', ?, ?, ?, ?, 'local_operator', ?)
      ON CONFLICT(product_id, field_family) DO UPDATE SET
        outcome = excluded.outcome, source_record_id = excluded.source_record_id,
        evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
        verified_at = excluded.verified_at, decided_by = excluded.decided_by,
        notes = excluded.notes`)
      .bind(
        review.product_id,
        review.source_record_id,
        ingredientEvidenceDecision.evidenceUrl,
        ingredientCandidate.observedAt,
        decidedAt,
        `${rationale} [Robotoff ${ingredientCandidate.modelName} ${ingredientCandidate.modelVersion}; prediction ${ingredientCandidate.predictionId}; entity ${ingredientCandidate.entityIndex}; image ${ingredientCandidate.imageId}]`,
      ));
  }
  if (identityReview && decision !== "dismiss" && review.product_id && review.source_record_id && review.source_id && review.source_record_key && review.identity_hash) {
    statements.push(db.prepare(`INSERT INTO identity_decisions
      (id, source_id, source_record_key, source_record_id, identity_hash, decision, target_product_id, rationale, decided_by, decided_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local_operator', ?, 1)
      ON CONFLICT(source_id, source_record_key, identity_hash) DO UPDATE SET
        source_record_id = excluded.source_record_id, decision = excluded.decision,
        target_product_id = excluded.target_product_id, rationale = excluded.rationale,
        decided_by = excluded.decided_by, decided_at = excluded.decided_at, active = 1`)
      .bind(`idn_${id}`, review.source_id, review.source_record_key, review.source_record_id, review.identity_hash, decision, identityTargetProductId, rationale, decidedAt));
    statements.push(db.prepare("UPDATE source_records SET product_id = ?, resolution_rule = ? WHERE id = ?")
      .bind(identityTargetProductId, `manual_${decision}`, review.source_record_id));
    if (decision === "match" && identityTargetProductId) {
      statements.push(db.prepare(`INSERT INTO nutrition_facts
        (product_id, source_record_id, status, confidence, authority, basis, preparation_state,
          calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams,
          fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at)
        SELECT ?, source_record_id, status, confidence, authority, basis, preparation_state,
          calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams,
          fibre_grams, sodium_mg, label_verified_at, observed_at, ?
        FROM nutrition_facts WHERE product_id = ?
        ON CONFLICT(product_id) DO UPDATE SET
          source_record_id = excluded.source_record_id, status = excluded.status, confidence = excluded.confidence,
          authority = excluded.authority, basis = excluded.basis, preparation_state = excluded.preparation_state,
          calories = excluded.calories, protein_grams = excluded.protein_grams,
          carbohydrate_grams = excluded.carbohydrate_grams, sugar_grams = excluded.sugar_grams,
          fat_grams = excluded.fat_grams, saturated_fat_grams = excluded.saturated_fat_grams,
          fibre_grams = excluded.fibre_grams, sodium_mg = excluded.sodium_mg,
          label_verified_at = excluded.label_verified_at, observed_at = excluded.observed_at,
          updated_at = excluded.updated_at
        WHERE excluded.authority > nutrition_facts.authority OR
          (excluded.authority = nutrition_facts.authority AND excluded.observed_at > nutrition_facts.observed_at)`)
        .bind(identityTargetProductId, decidedAt, review.product_id));
      statements.push(db.prepare(`INSERT INTO ingredient_statements
        (product_id, source_record_id, raw_text, language, status, confidence, authority, observed_at, updated_at)
        SELECT ?, source_record_id, raw_text, language, status, confidence, authority, observed_at, ?
        FROM ingredient_statements WHERE product_id = ?
        ON CONFLICT(product_id) DO UPDATE SET
          source_record_id = excluded.source_record_id, raw_text = excluded.raw_text, language = excluded.language,
          status = excluded.status, confidence = excluded.confidence, authority = excluded.authority,
          observed_at = excluded.observed_at, updated_at = excluded.updated_at
        WHERE excluded.authority > ingredient_statements.authority OR
          (excluded.authority = ingredient_statements.authority AND excluded.observed_at > ingredient_statements.observed_at)`)
        .bind(identityTargetProductId, decidedAt, review.product_id));
      for (const table of ["nutrient_values", "product_ingredients", "product_allergens", "product_additives", "field_observations", "offers", "ratings"] as const) {
        statements.push(db.prepare(`UPDATE ${table} SET product_id = ? WHERE source_record_id = ?`).bind(identityTargetProductId, review.source_record_id));
      }
      statements.push(db.prepare("DELETE FROM nutrition_facts WHERE product_id = ?").bind(review.product_id));
      statements.push(db.prepare("DELETE FROM ingredient_statements WHERE product_id = ?").bind(review.product_id));
      statements.push(db.prepare("UPDATE review_items SET product_id = ? WHERE product_id = ? AND id <> ? AND status = 'open'")
        .bind(identityTargetProductId, review.product_id, id));
      statements.push(db.prepare(`UPDATE field_observations SET selected = CASE WHEN id = (
        SELECT chosen.id FROM field_observations chosen
        WHERE chosen.product_id = ? AND chosen.field_path = field_observations.field_path
        ORDER BY chosen.authority DESC, chosen.observed_at DESC, chosen.id LIMIT 1
      ) THEN 1 ELSE 0 END WHERE product_id = ?`).bind(identityTargetProductId, identityTargetProductId));
      statements.push(db.prepare("UPDATE products SET is_active = 1 WHERE id = ?").bind(identityTargetProductId));
      statements.push(db.prepare("UPDATE products SET is_active = 0 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM source_records WHERE product_id = ?)")
        .bind(review.product_id, review.product_id));
    } else if (decision === "create_new") {
      statements.push(db.prepare("UPDATE products SET is_active = 1 WHERE id = ?").bind(review.product_id));
    } else {
      statements.push(db.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(review.product_id));
    }
  }
  if (identityEvidenceDecision && identityEvidenceDisposition) {
    statements.push(...identityEvidenceWriteStatements(
      db,
      identityEvidenceDecision,
      identityEvidenceDisposition,
    ));
  }
  try {
    const results = await db.batch(statements);
    if (redundantTransaction || guardedNutritionTransaction) {
      // D1's meta.changes includes rows written by triggers. The
      // evidence_decisions insert fires density_key_evidence_decision_insert
      // (migration 0022), which updates the product's sort key — a successful
      // insert reports 2, not 1. The statement is a single-row literals SELECT
      // gated by WHERE EXISTS, so 0 still means "no decision was written".
      const inserted = results[0]?.meta.changes ?? 0;
      const resolved = results[1]?.meta.changes ?? 0;
      if (inserted === 0 && resolved === 0) {
        const current = await db.prepare("SELECT status FROM review_items WHERE id = ?")
          .bind(id).first<{ status: string }>();
        return current?.status === "open" ? "invalid_candidate" : "conflict";
      }
      if (inserted < 1 || resolved !== 1) {
        throw new Error(`Evidence transaction invariant failed: inserted=${inserted}, resolved=${resolved}`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed: evidence_decisions")) {
      return "conflict";
    }
    if (error instanceof Error && (
      error.message.includes("identity evidence decision conflict")
      || error.message.includes("UNIQUE constraint failed: identity_evidence_decisions")
    )) return "conflict";
    if (error instanceof Error && (
      error.message.includes("identity evidence current source binding mismatch")
      || error.message.includes("identity evidence decision is malformed")
    )) return "invalid_candidate";
    throw error;
  }
  return "resolved";
}

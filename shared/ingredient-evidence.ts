import { canonicalJson, sha256Hex } from "./evidence-decisions";
import { normalizeGtin } from "./gtin";
import { invalidIngredientPercentages, parseIngredients, parseLegacyIngredients } from "./ingredients";
import type { NormalizedIngredient } from "./types";

export type IngredientJsonValue =
  | null
  | boolean
  | number
  | string
  | IngredientJsonValue[]
  | { [key: string]: IngredientJsonValue };

export interface IngredientCandidate {
  predictionId: string;
  entityIndex: number;
  barcode: string;
  imageId: string;
  imageUrl: string;
  modelName: "ingredient_detection";
  modelVersion: string;
  predictedAt: string;
  observedAt: string;
  entityText: string;
  entityConfidence: number;
  language: {
    code: string;
    confidence: number;
  };
  boundingBox: [number, number, number, number];
  parsedIngredients: IngredientJsonValue[];
  ingredientCount: number;
  knownIngredientCount: number;
  unknownIngredientCount: number;
}

export interface IngredientCandidateValidationOptions {
  expectedGtin?: string | null;
  confidenceThreshold?: number;
}

export interface IngredientCandidateWarning {
  code: "low_language_confidence" | "low_taxonomy_recognition";
  message: string;
}

interface IngredientDecisionPayload {
  candidate: IngredientCandidate;
  reviewedText: string | null;
  normalizedIngredients: NormalizedIngredient[];
}

export interface IngredientEvidenceDecisionInput {
  id: string;
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  sourceContentHash: string;
  productId: string;
  candidateHash: string;
  extractionAttemptId?: string | null;
  labelAssetId?: string | null;
  fieldFamily: "ingredients";
  decision: "verify" | "reject";
  payload: IngredientDecisionPayload;
  evidenceUrl: string;
  rationale: string;
  decidedBy: string;
  decidedAt: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.UTC(2000, 0, 1);
}

function validOfficialImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "images.openfoodfacts.org";
  } catch {
    return false;
  }
}

function validJsonValue(value: unknown): value is IngredientJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validJsonValue);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((item) => item !== undefined && validJsonValue(item));
}

function validCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function validateIngredientCandidate(
  candidate: IngredientCandidate,
  options: IngredientCandidateValidationOptions = {},
): string[] {
  const errors: string[] = [];
  const confidenceThreshold = options.confidenceThreshold ?? 0.85;
  const barcode = normalizeGtin(candidate.barcode);
  const expectedGtin = options.expectedGtin ? normalizeGtin(options.expectedGtin) : null;

  if (!candidate.predictionId.trim()) errors.push("predictionId is required");
  if (!Number.isInteger(candidate.entityIndex) || candidate.entityIndex < 0) errors.push("entityIndex must be a non-negative integer");
  if (!barcode) errors.push("barcode must be a valid GTIN");
  if (options.expectedGtin && !expectedGtin) errors.push("expectedGtin must be a valid GTIN");
  if (barcode && expectedGtin && barcode !== expectedGtin) errors.push("barcode does not match expectedGtin");
  if (!candidate.imageId.trim()) errors.push("imageId is required");
  if (!validOfficialImageUrl(candidate.imageUrl)) errors.push("imageUrl must be an official Open Food Facts HTTPS image");
  if (candidate.modelName !== "ingredient_detection") errors.push("modelName is not supported");
  if (!candidate.modelVersion.startsWith("ingredient-detection-") || candidate.modelVersion.length > 100) {
    errors.push("modelVersion is not supported");
  }
  if (!validTimestamp(candidate.predictedAt)) errors.push("predictedAt must be a valid timestamp");
  if (!validTimestamp(candidate.observedAt)) errors.push("observedAt must be a valid timestamp");
  if (!candidate.entityText.trim() || candidate.entityText.length > 25_000) errors.push("entityText must contain bounded label text");
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    errors.push("confidenceThreshold must be between zero and one");
  } else if (!Number.isFinite(candidate.entityConfidence)
    || candidate.entityConfidence < confidenceThreshold
    || candidate.entityConfidence > 1) {
    errors.push("entityConfidence is outside the admitted range");
  }
  if (!/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(candidate.language.code)) errors.push("language code is invalid");
  if (!Number.isFinite(candidate.language.confidence)
    || candidate.language.confidence < 0
    || candidate.language.confidence > 1) {
    errors.push("language confidence must be between zero and one");
  }
  if (candidate.boundingBox.length !== 4
    || !candidate.boundingBox.every((value) => Number.isFinite(value) && value >= 0)
    || candidate.boundingBox[2] <= candidate.boundingBox[0]
    || candidate.boundingBox[3] <= candidate.boundingBox[1]) {
    errors.push("boundingBox must contain increasing finite non-negative coordinates");
  }
  if (!candidate.parsedIngredients.every(validJsonValue)) errors.push("parsedIngredients must contain canonical JSON values");
  if (!validCount(candidate.ingredientCount)
    || !validCount(candidate.knownIngredientCount)
    || !validCount(candidate.unknownIngredientCount)) {
    errors.push("ingredient counts must be non-negative integers");
  } else if (candidate.ingredientCount !== candidate.knownIngredientCount + candidate.unknownIngredientCount) {
    errors.push("ingredient counts do not reconcile");
  }
  return errors;
}

export function ingredientCandidateFromEvidence(
  evidence: unknown,
  productGtin: string | null,
): IngredientCandidate | null {
  const root = record(evidence);
  if (root?.code !== "robotoff_ingredient_candidate") return null;
  const candidate = record(record(root.details)?.candidate);
  const language = record(candidate?.language);
  if (!candidate || !language) return null;
  const parsedIngredients = Array.isArray(candidate.parsedIngredients)
    ? candidate.parsedIngredients
    : [];
  const boundingBox = Array.isArray(candidate.boundingBox)
    ? candidate.boundingBox.map(numberValue)
    : [];
  const parsed: IngredientCandidate = {
    predictionId: stringValue(candidate.predictionId),
    entityIndex: numberValue(candidate.entityIndex),
    barcode: stringValue(candidate.barcode),
    imageId: stringValue(candidate.imageId),
    imageUrl: stringValue(candidate.imageUrl),
    modelName: stringValue(candidate.modelName) as IngredientCandidate["modelName"],
    modelVersion: stringValue(candidate.modelVersion),
    predictedAt: stringValue(candidate.predictedAt),
    observedAt: stringValue(candidate.observedAt),
    entityText: stringValue(candidate.entityText),
    entityConfidence: numberValue(candidate.entityConfidence),
    language: {
      code: stringValue(language.code),
      confidence: numberValue(language.confidence),
    },
    boundingBox: boundingBox as IngredientCandidate["boundingBox"],
    parsedIngredients: parsedIngredients as IngredientJsonValue[],
    ingredientCount: numberValue(candidate.ingredientCount),
    knownIngredientCount: numberValue(candidate.knownIngredientCount),
    unknownIngredientCount: numberValue(candidate.unknownIngredientCount),
  };
  return validateIngredientCandidate(parsed, { expectedGtin: productGtin }).length === 0
    ? canonicalIngredientCandidate(parsed)
    : null;
}

export function canonicalIngredientCandidate(candidate: IngredientCandidate): IngredientCandidate {
  const barcode = normalizeGtin(candidate.barcode);
  if (!barcode) throw new Error("Cannot canonicalize an ingredient candidate with an invalid GTIN");
  if (!candidate.parsedIngredients.every(validJsonValue)) {
    throw new Error("Cannot canonicalize an ingredient candidate with invalid parsed ingredients");
  }
  return {
    predictionId: candidate.predictionId,
    entityIndex: candidate.entityIndex,
    barcode,
    imageId: candidate.imageId,
    imageUrl: candidate.imageUrl,
    modelName: candidate.modelName,
    modelVersion: candidate.modelVersion,
    predictedAt: new Date(candidate.predictedAt).toISOString(),
    observedAt: new Date(candidate.observedAt).toISOString(),
    entityText: candidate.entityText,
    entityConfidence: candidate.entityConfidence,
    language: {
      code: candidate.language.code.toLowerCase(),
      confidence: candidate.language.confidence,
    },
    boundingBox: [...candidate.boundingBox],
    parsedIngredients: JSON.parse(canonicalJson(candidate.parsedIngredients)) as IngredientJsonValue[],
    ingredientCount: candidate.ingredientCount,
    knownIngredientCount: candidate.knownIngredientCount,
    unknownIngredientCount: candidate.unknownIngredientCount,
  };
}

export async function ingredientCandidateHash(candidate: IngredientCandidate): Promise<string> {
  return sha256Hex(canonicalIngredientCandidate(candidate));
}

export async function validateIngredientEvidenceDecision(
  input: IngredientEvidenceDecisionInput,
): Promise<string[]> {
  const errors: string[] = [];
  for (const [field, value] of [
    ["id", input.id],
    ["sourceId", input.sourceId],
    ["sourceRecordKey", input.sourceRecordKey],
    ["sourceRecordId", input.sourceRecordId],
    ["sourceContentHash", input.sourceContentHash],
    ["productId", input.productId],
    ["rationale", input.rationale],
    ["decidedBy", input.decidedBy],
  ] as const) {
    if (!value.trim()) errors.push(`${field} is required`);
  }
  if (input.fieldFamily !== "ingredients") errors.push("fieldFamily is not supported");
  if (!(input.decision === "verify" || input.decision === "reject")) errors.push("decision is not supported");
  if (!/^[a-f0-9]{64}$/.test(input.candidateHash)) errors.push("candidateHash must be a lowercase SHA-256 digest");
  const extractionAttemptId = input.extractionAttemptId ?? null;
  const labelAssetId = input.labelAssetId ?? null;
  if ((extractionAttemptId === null) !== (labelAssetId === null)) errors.push("extraction linkage must include both attempt and label asset IDs");
  if (extractionAttemptId !== null && !/^xat_[a-f0-9]{24}$/.test(extractionAttemptId)) errors.push("extractionAttemptId is invalid");
  if (labelAssetId !== null && !/^lbl_[a-f0-9]{24}$/.test(labelAssetId)) errors.push("labelAssetId is invalid");
  if (!validHttpsUrl(input.evidenceUrl)) errors.push("evidenceUrl must use HTTPS");
  if (!Number.isFinite(Date.parse(input.decidedAt))) errors.push("decidedAt must be a valid timestamp");
  const candidateErrors = validateIngredientCandidate(input.payload.candidate, {
    expectedGtin: input.payload.candidate.barcode,
  });
  if (candidateErrors.length > 0) {
    errors.push("payload does not contain a valid ingredient candidate");
  } else if (await ingredientCandidateHash(input.payload.candidate) !== input.candidateHash) {
    errors.push("candidateHash does not match payload");
  }
  if (input.evidenceUrl !== input.payload.candidate.imageUrl) {
    errors.push("evidenceUrl must match the candidate label image");
  }
  const reviewedText = input.payload.reviewedText;
  if (input.decision === "verify") {
    if (!reviewedText?.trim() || reviewedText.length > 25_000) {
      errors.push("verify decisions require bounded reviewer-confirmed text");
    } else {
      const normalizedIngredients = parseIngredients(reviewedText);
      const legacyNormalizedIngredients = parseLegacyIngredients(reviewedText);
      if (normalizedIngredients.length === 0) errors.push("reviewedText does not contain parseable ingredients");
      if (invalidIngredientPercentages(reviewedText).length > 0) errors.push("reviewedText contains an invalid ingredient percentage");
      if (
        canonicalJson(normalizedIngredients) !== canonicalJson(input.payload.normalizedIngredients)
        && canonicalJson(legacyNormalizedIngredients) !== canonicalJson(input.payload.normalizedIngredients)
      ) {
        errors.push("normalizedIngredients do not match reviewedText");
      }
      if (reviewedText !== input.payload.candidate.entityText && input.rationale.trim().length < 12) {
        errors.push("OCR corrections require an explicit rationale");
      }
    }
  } else {
    if (reviewedText !== null) errors.push("reject decisions must not contain reviewer-confirmed text");
    if (input.payload.normalizedIngredients.length > 0) errors.push("reject decisions must not contain normalized ingredients");
  }
  return errors;
}

export function ingredientCandidateWarnings(candidate: IngredientCandidate): IngredientCandidateWarning[] {
  const warnings: IngredientCandidateWarning[] = [];
  if (candidate.language.confidence < 0.5) {
    warnings.push({
      code: "low_language_confidence",
      message: "Robotoff has low confidence in the detected ingredient language.",
    });
  }
  const recognizedFraction = candidate.ingredientCount > 0
    ? candidate.knownIngredientCount / candidate.ingredientCount
    : 0;
  if (recognizedFraction < 0.6) {
    warnings.push({
      code: "low_taxonomy_recognition",
      message: "Fewer than sixty percent of parsed ingredients are recognized by the source taxonomy.",
    });
  }
  return warnings;
}

function comparableText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

export function ingredientCandidatesConflict(candidates: IngredientCandidate[]): boolean {
  return new Set(candidates.map(({ entityText }) => comparableText(entityText))).size > 1;
}

const EXTRACTION_FIELD_FAMILIES = ["nutrition", "ingredients"] as const;
const EXTRACTION_OUTCOME_STATUSES = ["candidate", "no_prediction", "rejected", "failed"] as const;
const EXTRACTION_LABEL_ROLES = ["requested", "prediction"] as const;
export const EXTRACTION_RESIDUAL_EXCEPTION_MAX_COUNT = 10;
export const EXTRACTION_RESIDUAL_EXCEPTION_MAX_RATE = 0.0025;
const EXTRACTION_RESIDUAL_EXCEPTION_REASONS = [
  "label_declared_size_exceeded",
  "label_fetch_failed",
  "label_http_error",
  "label_request_timeout",
  "label_stream_chunk_limit_exceeded",
  "label_stream_missing",
  "label_stream_read_failed",
  "label_stream_size_exceeded",
] as const;

export type ExtractionFieldFamily = (typeof EXTRACTION_FIELD_FAMILIES)[number];
export type ExtractionOutcomeStatus = (typeof EXTRACTION_OUTCOME_STATUSES)[number];
type ExtractionLabelRole = (typeof EXTRACTION_LABEL_ROLES)[number];
export type ExtractionResidualExceptionReason = (typeof EXTRACTION_RESIDUAL_EXCEPTION_REASONS)[number];

export interface ExtractionAccountingSummary {
  outcomeAccountingComplete: boolean;
  verificationComplete: boolean;
  residualExceptionCount: number;
  residualExceptionRate: number;
  residualExceptionLimits: {
    maxCount: typeof EXTRACTION_RESIDUAL_EXCEPTION_MAX_COUNT;
    maxRate: typeof EXTRACTION_RESIDUAL_EXCEPTION_MAX_RATE;
  };
}

export function extractionAccountingSummary(
  requestedCount: number,
  accountedCount: number,
  failedCount: number,
): ExtractionAccountingSummary {
  if (!Number.isSafeInteger(requestedCount) || requestedCount <= 0) {
    throw new Error("Extraction accounting requires a positive requested count");
  }
  if (!Number.isSafeInteger(accountedCount) || accountedCount < 0 || !Number.isSafeInteger(failedCount) || failedCount < 0) {
    throw new Error("Extraction accounting counts must be non-negative safe integers");
  }
  return {
    outcomeAccountingComplete: accountedCount === requestedCount,
    verificationComplete: accountedCount === requestedCount && failedCount === 0,
    residualExceptionCount: failedCount,
    residualExceptionRate: failedCount / requestedCount,
    residualExceptionLimits: {
      maxCount: EXTRACTION_RESIDUAL_EXCEPTION_MAX_COUNT,
      maxRate: EXTRACTION_RESIDUAL_EXCEPTION_MAX_RATE,
    },
  };
}

export function residualExceptionBoundsSatisfied(summary: ExtractionAccountingSummary): boolean {
  return summary.outcomeAccountingComplete
    && summary.residualExceptionCount <= EXTRACTION_RESIDUAL_EXCEPTION_MAX_COUNT
    && summary.residualExceptionRate <= EXTRACTION_RESIDUAL_EXCEPTION_MAX_RATE;
}

export function isResidualExceptionReason(value: string): value is ExtractionResidualExceptionReason {
  return (EXTRACTION_RESIDUAL_EXCEPTION_REASONS as readonly string[]).includes(value);
}

export function validateExtractionOutcomePartition(
  requestedSubjects: readonly string[],
  outcomeSubjects: readonly string[],
): string[] {
  const errors: string[] = [];
  const requested = new Set(requestedSubjects);
  const outcomes = new Set(outcomeSubjects);
  if (requested.size !== requestedSubjects.length) errors.push("requested extraction subjects contain duplicates");
  if (outcomes.size !== outcomeSubjects.length) errors.push("extraction outcomes contain duplicate subjects");
  for (const subject of requested) if (!outcomes.has(subject)) errors.push(`extraction outcome is missing for ${subject}`);
  for (const subject of outcomes) if (!requested.has(subject)) errors.push(`extraction outcome is outside the requested set: ${subject}`);
  return errors;
}

export function validateDecisionDriftEvidence(value: unknown, expected: {
  fieldFamily: ExtractionFieldFamily;
  sourceId: string;
  adapterVersion: string;
  inputHash: string | null;
  extractionRunId: string;
  parentSourceRunId: string;
}): string[] {
  const input = record(value);
  const artifact = record(input?.artifact);
  const policy = record(input?.policy);
  const failOn = Array.isArray(policy?.failOn) ? policy.failOn : [];
  const failures = Array.isArray(policy?.failures) ? policy.failures : null;
  const errors: string[] = [];
  if (input?.schemaVersion !== 1) errors.push("decision-drift schema version is not supported");
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (artifact?.[field] !== expectedValue) errors.push(`decision-drift artifact ${field} does not match`);
  }
  if (artifact?.sourceComplete !== true) errors.push("decision-drift artifact is not source complete");
  if (input?.hasHardFailure !== false) errors.push("decision-drift audit has a hard failure");
  if (!failOn.includes("candidate_key_active_state_ambiguous")) errors.push("decision-drift policy omits ambiguous active candidates");
  if (policy?.passed !== true || failures === null || failures.length !== 0) errors.push("decision-drift policy did not pass");
  return errors;
}

export function validateExtractionAccountingSummary(
  value: unknown,
  requestedCount: number,
  accountedCount: number,
  failedCount: number,
): string[] {
  const expected = extractionAccountingSummary(requestedCount, accountedCount, failedCount);
  const input = record(value);
  if (!input) return ["extraction accounting summary must be an object"];
  const limits = record(input.residualExceptionLimits);
  const errors: string[] = [];
  if (input.outcomeAccountingComplete !== expected.outcomeAccountingComplete) errors.push("outcome accounting completeness does not match the exact partition");
  if (input.verificationComplete !== expected.verificationComplete) errors.push("verification completeness does not match the failed outcome count");
  if (input.residualExceptionCount !== expected.residualExceptionCount) errors.push("residual exception count does not match failed outcomes");
  if (input.residualExceptionRate !== expected.residualExceptionRate) errors.push("residual exception rate does not match requested barcodes");
  if (limits?.maxCount !== EXTRACTION_RESIDUAL_EXCEPTION_MAX_COUNT || limits.maxRate !== EXTRACTION_RESIDUAL_EXCEPTION_MAX_RATE) {
    errors.push("residual exception limits differ from the fixed policy");
  }
  if (!expected.outcomeAccountingComplete) errors.push("requested and outcome sets do not form an exact partition");
  if (expected.residualExceptionCount > EXTRACTION_RESIDUAL_EXCEPTION_MAX_COUNT) errors.push("residual exception count exceeds the fixed limit");
  if (expected.residualExceptionRate > EXTRACTION_RESIDUAL_EXCEPTION_MAX_RATE) errors.push("residual exception rate exceeds the fixed limit");
  return errors;
}

export interface ExtractionRun {
  id: string;
  ingestionRunId: string;
  fieldFamily: ExtractionFieldFamily;
  requestSchemaHash: string;
  artifactDigest: string;
  adapterVersion: string;
  modelName: string;
  modelVersion: string;
  parentSourceRunId: string;
  parentSourceInputHash: string;
  repository: string;
  workflow: string;
  branch: string;
  headSha: string;
  sourceComplete: boolean;
  status: "diagnostic" | "accepted";
  startedAt: string;
  completedAt: string | null;
  acceptedAt: string | null;
  manifest: Record<string, unknown>;
}

export interface LabelEvidenceAsset {
  id: string;
  subjectSourceRecordId: string;
  subjectSourceContentHash: string;
  productId: string;
  fieldFamily: ExtractionFieldFamily;
  sourceImageId: string;
  sourceImageRevision: string | null;
  requestedUrl: string;
  effectiveUrl: string;
  contentSha256: string;
  byteLength: number;
  mediaType: string;
  fetchedAt: string;
}

export interface ExtractionAttempt {
  id: string;
  extractionRunId: string;
  subjectSourceRecordId: string;
  subjectSourceRecordKey: string;
  subjectSourceContentHash: string;
  productId: string;
  fieldFamily: ExtractionFieldFamily;
  responseEvidenceHash: string;
  status: ExtractionOutcomeStatus;
  predictionCount: number;
  candidateCount: number;
  rejectionCount: number;
  failureCount: number;
  conflictCount: number;
  reasons: string[];
  attemptedAt: string;
  isCurrent: boolean;
}

export interface ExtractionAttemptLabel {
  id: string;
  attemptId: string;
  labelAssetId: string;
  role: ExtractionLabelRole;
  outcome: ExtractionOutcomeStatus;
  predictionCount: number;
  candidateCount: number;
  rejectionCount: number;
  failureCount: number;
  conflictCount: number;
  candidateHashes: string[];
  reasons: string[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const REASON_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const MEDIA_TYPE_PATTERN = /^image\/[a-z0-9][a-z0-9.+-]*$/;

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function validateShape(value: unknown, allowedKeys: readonly string[], name: string, errors: string[]): Record<string, unknown> | null {
  const parsed = record(value);
  if (!parsed) {
    errors.push(`${name} must be a JSON object`);
    return null;
  }
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.includes(key)) errors.push(`${name}.${key} is not supported`);
  }
  return parsed;
}

function requiredString(value: unknown, field: string, errors: string[]): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    errors.push(`${field} must be a non-empty string of at most 512 characters`);
    return false;
  }
  return true;
}

function sha256(value: unknown, field: string, errors: string[]): value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    errors.push(`${field} must be a lowercase SHA-256 digest`);
    return false;
  }
  return true;
}

function timestamp(value: unknown, field: string, nullable: boolean, errors: string[]): value is string | null {
  if (nullable && value === null) return true;
  if (typeof value !== "string" || !value.includes("T") || !Number.isFinite(Date.parse(value))) {
    errors.push(`${field} must be ${nullable ? "null or " : ""}a valid timestamp`);
    return false;
  }
  return true;
}

function httpsUrl(value: unknown, field: string, errors: string[]): value is string {
  if (typeof value !== "string") {
    errors.push(`${field} must use HTTPS`);
    return false;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) throw new Error();
  } catch {
    errors.push(`${field} must use HTTPS without embedded credentials`);
    return false;
  }
  return true;
}

function nonnegativeInteger(value: unknown, field: string, errors: string[]): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    errors.push(`${field} must be a non-negative safe integer`);
    return false;
  }
  return true;
}

function positiveInteger(value: unknown, field: string, errors: string[]): value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    errors.push(`${field} must be a positive safe integer`);
    return false;
  }
  return true;
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  const parsed = record(value);
  return parsed !== null && Object.values(parsed).every((item) => isJsonValue(item, seen));
}

function reasonCodes(value: unknown, field: string, errors: string[]): value is string[] {
  if (!Array.isArray(value) || value.some((reason) => typeof reason !== "string" || !REASON_PATTERN.test(reason))) {
    errors.push(`${field} must be a JSON array of reason codes`);
    return false;
  }
  if (new Set(value).size !== value.length) errors.push(`${field} must not contain duplicates`);
  return true;
}

function candidateHashes(value: unknown, field: string, errors: string[]): value is string[] {
  if (!Array.isArray(value) || value.some((hash) => typeof hash !== "string" || !SHA256_PATTERN.test(hash))) {
    errors.push(`${field} must be a JSON array of lowercase SHA-256 digests`);
    return false;
  }
  if (new Set(value).size !== value.length) errors.push(`${field} must not contain duplicates`);
  return true;
}

function fieldFamily(value: unknown, field: string, errors: string[]): value is ExtractionFieldFamily {
  if (!(EXTRACTION_FIELD_FAMILIES as readonly unknown[]).includes(value)) {
    errors.push(`${field} is not supported`);
    return false;
  }
  return true;
}

function outcomeStatus(value: unknown, field: string, errors: string[]): value is ExtractionOutcomeStatus {
  if (!(EXTRACTION_OUTCOME_STATUSES as readonly unknown[]).includes(value)) {
    errors.push(`${field} is not supported`);
    return false;
  }
  return true;
}

function validateOutcomeCounts(input: Record<string, unknown>, statusField: "status" | "outcome", errors: string[]): void {
  const status = input[statusField];
  const validCounts = ["predictionCount", "candidateCount", "rejectionCount", "failureCount", "conflictCount"]
    .every((field) => nonnegativeInteger(input[field], field, errors));
  if (!outcomeStatus(status, statusField, errors) || !validCounts) return;
  const candidateCount = input.candidateCount as number;
  const predictionCount = input.predictionCount as number;
  const rejectionCount = input.rejectionCount as number;
  const failureCount = input.failureCount as number;
  const conflictCount = input.conflictCount as number;
  if (rejectionCount > predictionCount) errors.push("rejectionCount cannot exceed predictionCount");
  if (conflictCount > candidateCount) errors.push("conflictCount cannot exceed candidateCount");
  if (status === "candidate" && candidateCount === 0) errors.push("candidate outcomes require candidateCount greater than zero");
  if (status === "no_prediction" && (predictionCount !== 0 || candidateCount !== 0 || rejectionCount !== 0 || failureCount !== 0)) {
    errors.push("no_prediction outcomes require zero prediction, candidate, rejection, and failure counts");
  }
  if (status === "rejected" && (candidateCount !== 0 || rejectionCount === 0)) {
    errors.push("rejected outcomes require no candidates and at least one rejection");
  }
  if (status === "failed" && (candidateCount !== 0 || failureCount === 0)) {
    errors.push("failed outcomes require no candidates and at least one failure");
  }
}

export function validateExtractionRun(value: unknown): string[] {
  const errors: string[] = [];
  const input = validateShape(value, [
    "id", "ingestionRunId", "fieldFamily", "requestSchemaHash", "artifactDigest",
    "adapterVersion", "modelName", "modelVersion", "parentSourceRunId", "parentSourceInputHash",
    "repository", "workflow", "branch", "headSha", "sourceComplete", "status", "startedAt",
    "completedAt", "acceptedAt", "manifest",
  ], "extractionRun", errors);
  if (!input) return errors;
  for (const field of ["id", "ingestionRunId", "adapterVersion", "modelName", "modelVersion", "parentSourceRunId", "repository", "workflow", "branch"] as const) {
    requiredString(input[field], field, errors);
  }
  fieldFamily(input.fieldFamily, "fieldFamily", errors);
  sha256(input.requestSchemaHash, "requestSchemaHash", errors);
  sha256(input.artifactDigest, "artifactDigest", errors);
  sha256(input.parentSourceInputHash, "parentSourceInputHash", errors);
  if (typeof input.headSha !== "string" || !GIT_SHA_PATTERN.test(input.headSha)) errors.push("headSha must be a lowercase 40-character Git SHA");
  if (typeof input.sourceComplete !== "boolean") errors.push("sourceComplete must be boolean");
  if (input.status !== "diagnostic" && input.status !== "accepted") errors.push("status is not supported");
  timestamp(input.startedAt, "startedAt", false, errors);
  timestamp(input.completedAt, "completedAt", true, errors);
  timestamp(input.acceptedAt, "acceptedAt", true, errors);
  if (input.status === "accepted" && (input.sourceComplete !== true || input.completedAt === null || input.acceptedAt === null)) {
    errors.push("accepted runs must be source complete with completedAt and acceptedAt timestamps");
  }
  if (input.status === "diagnostic" && input.acceptedAt !== null) errors.push("diagnostic runs cannot have acceptedAt");
  if (!record(input.manifest) || !isJsonValue(input.manifest)) errors.push("manifest must be a finite, acyclic JSON object");
  return errors;
}

export function validateLabelEvidenceAsset(value: unknown): string[] {
  const errors: string[] = [];
  const input = validateShape(value, [
    "id", "subjectSourceRecordId", "subjectSourceContentHash", "productId", "fieldFamily",
    "sourceImageId", "sourceImageRevision", "requestedUrl", "effectiveUrl", "contentSha256",
    "byteLength", "mediaType", "fetchedAt",
  ], "labelEvidenceAsset", errors);
  if (!input) return errors;
  for (const field of ["id", "subjectSourceRecordId", "productId", "sourceImageId"] as const) requiredString(input[field], field, errors);
  sha256(input.subjectSourceContentHash, "subjectSourceContentHash", errors);
  fieldFamily(input.fieldFamily, "fieldFamily", errors);
  if (input.sourceImageRevision !== null) requiredString(input.sourceImageRevision, "sourceImageRevision", errors);
  httpsUrl(input.requestedUrl, "requestedUrl", errors);
  httpsUrl(input.effectiveUrl, "effectiveUrl", errors);
  sha256(input.contentSha256, "contentSha256", errors);
  positiveInteger(input.byteLength, "byteLength", errors);
  if (typeof input.mediaType !== "string" || !MEDIA_TYPE_PATTERN.test(input.mediaType)) errors.push("mediaType must be a lowercase image media type");
  timestamp(input.fetchedAt, "fetchedAt", false, errors);
  return errors;
}

export function validateExtractionAttempt(value: unknown): string[] {
  const errors: string[] = [];
  const input = validateShape(value, [
    "id", "extractionRunId", "subjectSourceRecordId", "subjectSourceRecordKey",
    "subjectSourceContentHash", "productId", "fieldFamily", "responseEvidenceHash", "status",
    "predictionCount", "candidateCount", "rejectionCount", "failureCount", "conflictCount",
    "reasons", "attemptedAt", "isCurrent",
  ], "extractionAttempt", errors);
  if (!input) return errors;
  for (const field of ["id", "extractionRunId", "subjectSourceRecordId", "subjectSourceRecordKey", "productId"] as const) requiredString(input[field], field, errors);
  sha256(input.subjectSourceContentHash, "subjectSourceContentHash", errors);
  fieldFamily(input.fieldFamily, "fieldFamily", errors);
  sha256(input.responseEvidenceHash, "responseEvidenceHash", errors);
  validateOutcomeCounts(input, "status", errors);
  reasonCodes(input.reasons, "reasons", errors);
  timestamp(input.attemptedAt, "attemptedAt", false, errors);
  if (typeof input.isCurrent !== "boolean") errors.push("isCurrent must be boolean");
  return errors;
}

export function validateExtractionAttemptLabel(value: unknown): string[] {
  const errors: string[] = [];
  const input = validateShape(value, [
    "id", "attemptId", "labelAssetId", "role", "outcome", "predictionCount", "candidateCount",
    "rejectionCount", "failureCount", "conflictCount", "candidateHashes", "reasons",
  ], "extractionAttemptLabel", errors);
  if (!input) return errors;
  for (const field of ["id", "attemptId", "labelAssetId"] as const) requiredString(input[field], field, errors);
  if (!(EXTRACTION_LABEL_ROLES as readonly unknown[]).includes(input.role)) errors.push("role is not supported");
  validateOutcomeCounts(input, "outcome", errors);
  const hashes = input.candidateHashes;
  const hashesAreValid = candidateHashes(hashes, "candidateHashes", errors);
  if (hashesAreValid && nonnegativeInteger(input.candidateCount, "candidateCount", []) && hashes.length !== input.candidateCount) {
    errors.push("candidateHashes must account for every candidate");
  }
  reasonCodes(input.reasons, "reasons", errors);
  if (input.role === "prediction" && input.outcome === "no_prediction") errors.push("prediction labels cannot have no_prediction outcomes");
  return errors;
}

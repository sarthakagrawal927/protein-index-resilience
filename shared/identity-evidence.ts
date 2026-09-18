import { canonicalJson, sha256Hex } from "./evidence-decisions";

const IDENTITY_EVIDENCE_LIMITS = {
  id: 256,
  sourceRecordKey: 512,
  evidenceUrl: 2_048,
  rationale: 2_000,
  decidedBy: 200,
} as const;

export interface IdentityEvidenceBinding {
  productId: string;
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  identityHash: string;
}

export interface IdentityEvidenceDecisionPayload extends IdentityEvidenceBinding {
  evidenceUrl: string;
  sourceObservedAt: string;
  rationale: string;
  decidedBy: string;
}

export interface IdentityEvidenceDecision extends IdentityEvidenceDecisionPayload {
  id: string;
  decidedAt: string;
}

export type IdentityEvidenceDecisionDisposition = "insert" | "idempotent" | "conflict";

const DECISION_KEYS = [
  "id",
  "productId",
  "sourceId",
  "sourceRecordKey",
  "sourceRecordId",
  "identityHash",
  "evidenceUrl",
  "sourceObservedAt",
  "rationale",
  "decidedBy",
  "decidedAt",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalTimestamp(value: string): string | null {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) ? timestamp.toISOString() : null;
}

function canonicalHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function boundedText(
  input: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
  errors: string[],
): string | null {
  const value = input[field];
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return null;
  }
  const canonical = value.trim();
  if (canonical.length < minimum || canonical.length > maximum) {
    errors.push(`${field} must contain between ${minimum} and ${maximum} characters`);
    return null;
  }
  return canonical;
}

function canonicalBinding(binding: IdentityEvidenceBinding): IdentityEvidenceBinding {
  return {
    productId: binding.productId.trim(),
    sourceId: binding.sourceId.trim(),
    sourceRecordKey: binding.sourceRecordKey.trim(),
    sourceRecordId: binding.sourceRecordId.trim(),
    identityHash: binding.identityHash,
  };
}

function canonicalIdentityEvidencePayload(
  decision: IdentityEvidenceDecisionPayload,
): IdentityEvidenceDecisionPayload {
  return {
    ...canonicalBinding(decision),
    evidenceUrl: canonicalHttpsUrl(decision.evidenceUrl) ?? decision.evidenceUrl,
    sourceObservedAt: canonicalTimestamp(decision.sourceObservedAt) ?? decision.sourceObservedAt,
    rationale: decision.rationale.trim(),
    decidedBy: decision.decidedBy.trim(),
  };
}

export function canonicalIdentityEvidenceDecision(
  decision: IdentityEvidenceDecision,
): IdentityEvidenceDecision {
  return {
    id: decision.id.trim(),
    ...canonicalIdentityEvidencePayload(decision),
    decidedAt: canonicalTimestamp(decision.decidedAt) ?? decision.decidedAt,
  };
}

export async function identityEvidenceDecisionId(
  binding: IdentityEvidenceBinding,
): Promise<string> {
  const canonical = canonicalBinding(binding);
  const digest = await sha256Hex({
    productId: canonical.productId,
    sourceId: canonical.sourceId,
    sourceRecordKey: canonical.sourceRecordKey,
    sourceRecordId: canonical.sourceRecordId,
    identityHash: canonical.identityHash,
  });
  return `ied_${digest.slice(0, 24)}`;
}

export function identityEvidenceBindingMatches(
  decision: IdentityEvidenceBinding,
  current: IdentityEvidenceBinding,
): boolean {
  return canonicalJson(canonicalBinding(decision)) === canonicalJson(canonicalBinding(current));
}

export function identityEvidenceDecisionDisposition(
  existing: IdentityEvidenceDecision | null,
  attempted: IdentityEvidenceDecision,
): IdentityEvidenceDecisionDisposition {
  if (existing === null) return "insert";
  const sameBinding = identityEvidenceBindingMatches(existing, attempted);
  if (!sameBinding && existing.id !== attempted.id) return "insert";
  if (!sameBinding) return "conflict";
  const existingAssertion = canonicalIdentityEvidencePayload(existing);
  const attemptedAssertion = canonicalIdentityEvidencePayload(attempted);
  // Observation and decision timestamps describe the first accepted audit row.
  // A retry after a source refresh remains identical while the identity hash
  // and the operator's exact assertion are unchanged.
  return canonicalJson({
    ...canonicalBinding(existingAssertion),
    evidenceUrl: existingAssertion.evidenceUrl,
    rationale: existingAssertion.rationale,
    decidedBy: existingAssertion.decidedBy,
  }) === canonicalJson({
    ...canonicalBinding(attemptedAssertion),
    evidenceUrl: attemptedAssertion.evidenceUrl,
    rationale: attemptedAssertion.rationale,
    decidedBy: attemptedAssertion.decidedBy,
  })
    ? "idempotent"
    : "conflict";
}

export async function validateIdentityEvidenceDecision(value: unknown): Promise<string[]> {
  const errors: string[] = [];
  const input = record(value);
  if (!input) return ["identityEvidenceDecision must be an object"];

  const unexpected = Object.keys(input).filter(
    (key) => !(DECISION_KEYS as readonly string[]).includes(key),
  );
  for (const key of unexpected) errors.push(`identityEvidenceDecision.${key} is not supported`);
  for (const key of DECISION_KEYS) {
    if (!(key in input)) errors.push(`${key} is required`);
  }

  const id = boundedText(input, "id", 1, IDENTITY_EVIDENCE_LIMITS.id, errors);
  const productId = boundedText(input, "productId", 1, IDENTITY_EVIDENCE_LIMITS.id, errors);
  const sourceId = boundedText(input, "sourceId", 1, IDENTITY_EVIDENCE_LIMITS.id, errors);
  const sourceRecordKey = boundedText(
    input,
    "sourceRecordKey",
    1,
    IDENTITY_EVIDENCE_LIMITS.sourceRecordKey,
    errors,
  );
  const sourceRecordId = boundedText(input, "sourceRecordId", 1, IDENTITY_EVIDENCE_LIMITS.id, errors);
  const rationale = boundedText(input, "rationale", 3, IDENTITY_EVIDENCE_LIMITS.rationale, errors);
  const decidedBy = boundedText(input, "decidedBy", 1, IDENTITY_EVIDENCE_LIMITS.decidedBy, errors);

  const identityHash = input.identityHash;
  if (typeof identityHash !== "string" || !/^[a-f0-9]{64}$/.test(identityHash)) {
    errors.push("identityHash must be a lowercase SHA-256 digest");
  }

  const evidenceUrl = input.evidenceUrl;
  if (typeof evidenceUrl !== "string") {
    errors.push("evidenceUrl must be a string");
  } else {
    const canonicalUrl = canonicalHttpsUrl(evidenceUrl);
    if (!canonicalUrl) errors.push("evidenceUrl must use HTTPS without embedded credentials");
    else if (canonicalUrl.length > IDENTITY_EVIDENCE_LIMITS.evidenceUrl) {
      errors.push(`evidenceUrl must contain at most ${IDENTITY_EVIDENCE_LIMITS.evidenceUrl} characters`);
    } else if (canonicalUrl !== evidenceUrl) {
      errors.push("evidenceUrl must be canonical");
    }
  }

  for (const field of ["sourceObservedAt", "decidedAt"] as const) {
    const timestamp = input[field];
    if (typeof timestamp !== "string" || canonicalTimestamp(timestamp) !== timestamp) {
      errors.push(`${field} must be a canonical ISO timestamp`);
    }
  }

  if (
    id && productId && sourceId && sourceRecordKey && sourceRecordId
    && typeof identityHash === "string" && /^[a-f0-9]{64}$/.test(identityHash)
    && typeof input.sourceObservedAt === "string"
  ) {
    const expectedId = await identityEvidenceDecisionId({
      productId,
      sourceId,
      sourceRecordKey,
      sourceRecordId,
      identityHash,
    });
    if (id !== expectedId) errors.push("id does not match the deterministic identity binding");
  }

  if (productId && input.productId !== productId) errors.push("productId must be canonical");
  if (sourceId && input.sourceId !== sourceId) errors.push("sourceId must be canonical");
  if (sourceRecordKey && input.sourceRecordKey !== sourceRecordKey) errors.push("sourceRecordKey must be canonical");
  if (sourceRecordId && input.sourceRecordId !== sourceRecordId) errors.push("sourceRecordId must be canonical");
  if (rationale && input.rationale !== rationale) errors.push("rationale must be canonical");
  if (decidedBy && input.decidedBy !== decidedBy) errors.push("decidedBy must be canonical");

  return errors;
}

const TERMINAL_EVIDENCE_FIELD_FAMILIES = ["nutrition", "ingredients"] as const;
const TERMINAL_UNAVAILABLE_OUTCOMES = ["not_declared", "not_applicable"] as const;
const TERMINAL_EVIDENCE_KINDS = ["source", "label"] as const;
const TERMINAL_EVIDENCE_ERROR_CODES = [
  "validation_error",
  "not_found",
  "stale_evidence",
  "conflict",
  "mutations_disabled",
] as const;

export type TerminalEvidenceFieldFamily = (typeof TERMINAL_EVIDENCE_FIELD_FAMILIES)[number];
export type TerminalUnavailableOutcome = (typeof TERMINAL_UNAVAILABLE_OUTCOMES)[number];
type TerminalEvidenceKind = (typeof TERMINAL_EVIDENCE_KINDS)[number];
export type TerminalEvidenceErrorCode = (typeof TERMINAL_EVIDENCE_ERROR_CODES)[number];

export interface TerminalEvidenceListQuery {
  page: number;
  pageSize: number;
}

export interface TerminalEvidenceErrorDetails {
  evidenceId?: string;
}

export interface TerminalEvidenceErrorResponse {
  error: {
    code: TerminalEvidenceErrorCode;
    message: string;
    details?: TerminalEvidenceErrorDetails;
  };
}

interface TerminalEvidenceBindingBase {
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  sourceContentHash: string;
  productId: string;
  fieldFamily: TerminalEvidenceFieldFamily;
}

export interface TerminalSourceEvidenceBinding extends TerminalEvidenceBindingBase {
  kind: "source";
}

export interface TerminalLabelEvidenceBinding extends TerminalEvidenceBindingBase {
  kind: "label";
  labelAssetId: string;
  labelContentSha256: string;
}

export type TerminalEvidenceBinding = TerminalSourceEvidenceBinding | TerminalLabelEvidenceBinding;

export interface TerminalEvidenceDecisionInput {
  id: string;
  idempotencyKey: string;
  outcome: TerminalUnavailableOutcome;
  evidence: TerminalEvidenceBinding;
  rationale: string;
  decidedBy: string;
  decidedAt: string;
  supersedesDecisionId: string | null;
}

export interface TerminalEvidenceOption {
  evidenceId: string;
  kind: TerminalEvidenceKind;
  sourceId: string;
  sourceName: string;
  sourceRecordId: string;
  sourceRecordKey: string;
  sourceContentHash: string;
  sourceUrl: string;
  observedAt: string;
  authority: number;
  labelAssetId: string | null;
  labelContentSha256: string | null;
  labelUrl: string | null;
  labelFetchedAt: string | null;
}

export interface TerminalEvidenceOptionsResponse {
  productId: string;
  family: TerminalEvidenceFieldFamily;
  items: TerminalEvidenceOption[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
  history: TerminalEvidenceHistoryEntry[];
  historyTruncated: boolean;
  contradiction: TerminalEvidenceContradiction;
}

export interface TerminalEvidenceHistoryEntry {
  decision: TerminalEvidenceDecisionInput;
  current: boolean;
  stale: boolean;
  superseded: boolean;
}

interface TerminalEvidenceContradiction {
  hasConflict: boolean;
  outcomes: TerminalUnavailableOutcome[];
  factStatus: "verified" | "conflict" | null;
  legacyProjection: boolean;
}

export interface RecordTerminalEvidenceInput {
  family: TerminalEvidenceFieldFamily;
  outcome: TerminalUnavailableOutcome;
  evidenceId: string;
  sourceContentHash: string;
  labelContentSha256: string | null;
  idempotencyKey: string;
  rationale: string;
  supersedesDecisionId: string | null;
}

export interface RecordTerminalEvidenceResponse {
  status: "created" | "existing";
  decision: TerminalEvidenceDecisionInput;
}

export function isTerminalEvidenceErrorCode(value: unknown): value is TerminalEvidenceErrorCode {
  return typeof value === "string" && (TERMINAL_EVIDENCE_ERROR_CODES as readonly string[]).includes(value);
}

export type TerminalEvidenceReplayResult = "replay" | "collision" | "distinct";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function exactShape(
  value: unknown,
  allowedKeys: readonly string[],
  name: string,
  errors: string[],
): Record<string, unknown> | null {
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

function requiredString(value: unknown, field: string, maximum: number, errors: string[]): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    errors.push(`${field} must be a non-empty string of at most ${maximum} characters`);
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

function timestamp(value: unknown, field: string, errors: string[]): value is string {
  if (typeof value !== "string" || !value.includes("T") || !Number.isFinite(Date.parse(value))) {
    errors.push(`${field} must be a valid timestamp`);
    return false;
  }
  return true;
}

function validateTerminalEvidenceBinding(value: unknown): string[] {
  const errors: string[] = [];
  const root = record(value);
  const kind = root?.kind;
  const keys = kind === "label"
    ? ["kind", "sourceId", "sourceRecordKey", "sourceRecordId", "sourceContentHash", "productId", "fieldFamily", "labelAssetId", "labelContentSha256"]
    : ["kind", "sourceId", "sourceRecordKey", "sourceRecordId", "sourceContentHash", "productId", "fieldFamily"];
  const input = exactShape(value, keys, "evidence", errors);
  if (!input) return errors;

  if (!(TERMINAL_EVIDENCE_KINDS as readonly unknown[]).includes(input.kind)) {
    errors.push("evidence.kind is not supported");
  }
  for (const field of ["sourceId", "sourceRecordKey", "sourceRecordId", "productId"] as const) {
    requiredString(input[field], `evidence.${field}`, 512, errors);
  }
  sha256(input.sourceContentHash, "evidence.sourceContentHash", errors);
  if (!(TERMINAL_EVIDENCE_FIELD_FAMILIES as readonly unknown[]).includes(input.fieldFamily)) {
    errors.push("evidence.fieldFamily is not supported");
  }
  if (input.kind === "label") {
    requiredString(input.labelAssetId, "evidence.labelAssetId", 512, errors);
    sha256(input.labelContentSha256, "evidence.labelContentSha256", errors);
  }
  return errors;
}

export function validateTerminalEvidenceDecision(value: unknown): string[] {
  const errors: string[] = [];
  const input = exactShape(value, [
    "id", "idempotencyKey", "outcome", "evidence", "rationale", "decidedBy",
    "decidedAt", "supersedesDecisionId",
  ], "terminalEvidenceDecision", errors);
  if (!input) return errors;

  requiredString(input.id, "id", 512, errors);
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    errors.push("idempotencyKey must be 8-200 URL-safe characters");
  }
  if (!(TERMINAL_UNAVAILABLE_OUTCOMES as readonly unknown[]).includes(input.outcome)) {
    errors.push("outcome is not supported");
  }
  errors.push(...validateTerminalEvidenceBinding(input.evidence));
  if (typeof input.rationale !== "string" || input.rationale.trim().length < 3 || input.rationale.length > 2000) {
    errors.push("rationale must be 3-2000 characters");
  }
  requiredString(input.decidedBy, "decidedBy", 512, errors);
  timestamp(input.decidedAt, "decidedAt", errors);
  if (input.supersedesDecisionId !== null) {
    requiredString(input.supersedesDecisionId, "supersedesDecisionId", 512, errors);
    if (input.supersedesDecisionId === input.id) errors.push("a decision cannot supersede itself");
  }
  return errors;
}

function canonicalBinding(binding: TerminalEvidenceBinding): TerminalEvidenceBinding {
  const common = {
    sourceId: binding.sourceId,
    sourceRecordKey: binding.sourceRecordKey,
    sourceRecordId: binding.sourceRecordId,
    sourceContentHash: binding.sourceContentHash,
    productId: binding.productId,
    fieldFamily: binding.fieldFamily,
  };
  return binding.kind === "label"
    ? {
      kind: "label",
      ...common,
      labelAssetId: binding.labelAssetId,
      labelContentSha256: binding.labelContentSha256,
    }
    : { kind: "source", ...common };
}

export function canonicalTerminalEvidenceDecision(
  decision: TerminalEvidenceDecisionInput,
): TerminalEvidenceDecisionInput {
  return {
    id: decision.id,
    idempotencyKey: decision.idempotencyKey,
    outcome: decision.outcome,
    evidence: canonicalBinding(decision.evidence),
    rationale: decision.rationale,
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
    supersedesDecisionId: decision.supersedesDecisionId,
  };
}

function canonicalIntent(decision: TerminalEvidenceDecisionInput): string {
  return JSON.stringify({
    idempotencyKey: decision.idempotencyKey,
    outcome: decision.outcome,
    evidence: canonicalBinding(decision.evidence),
    rationale: decision.rationale,
    decidedBy: decision.decidedBy,
    supersedesDecisionId: decision.supersedesDecisionId,
  });
}

export function compareTerminalEvidenceReplay(
  input: TerminalEvidenceDecisionInput,
  existing: TerminalEvidenceDecisionInput,
): TerminalEvidenceReplayResult {
  if (input.idempotencyKey !== existing.idempotencyKey && input.id !== existing.id) return "distinct";
  return canonicalIntent(input) === canonicalIntent(existing) ? "replay" : "collision";
}

export function terminalEvidenceBindingsShareLineage(
  left: TerminalEvidenceBinding,
  right: TerminalEvidenceBinding,
): boolean {
  if (
    left.kind !== right.kind ||
    left.sourceId !== right.sourceId ||
    left.sourceRecordKey !== right.sourceRecordKey ||
    left.sourceRecordId !== right.sourceRecordId ||
    left.sourceContentHash !== right.sourceContentHash ||
    left.productId !== right.productId ||
    left.fieldFamily !== right.fieldFamily
  ) return false;
  return left.kind === "source" || (
    right.kind === "label" &&
    left.labelAssetId === right.labelAssetId &&
    left.labelContentSha256 === right.labelContentSha256
  );
}

export function validateTerminalEvidenceSupersession(
  next: TerminalEvidenceDecisionInput,
  previous: TerminalEvidenceDecisionInput,
  existingSuccessor: TerminalEvidenceDecisionInput | null = null,
): string[] {
  const errors: string[] = [];
  if (next.supersedesDecisionId !== previous.id) {
    errors.push("supersedesDecisionId must identify the previous decision");
  }
  if (next.id === previous.id) errors.push("a superseding decision must have a new id");
  if (next.idempotencyKey === previous.idempotencyKey) {
    errors.push("a superseding decision must have a new idempotencyKey");
  }
  if (!terminalEvidenceBindingsShareLineage(next.evidence, previous.evidence)) {
    errors.push("a superseding decision must use the same exact evidence lineage");
  }
  if (existingSuccessor && compareTerminalEvidenceReplay(next, existingSuccessor) !== "replay") {
    errors.push("the previous decision already has a competing successor");
  }
  return errors;
}

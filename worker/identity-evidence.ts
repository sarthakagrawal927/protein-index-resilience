import {
  identityEvidenceDecisionDisposition,
  identityEvidenceDecisionId,
  validateIdentityEvidenceDecision,
  type IdentityEvidenceDecision,
  type IdentityEvidenceDecisionDisposition,
} from "../shared/identity-evidence";

interface CurrentIdentitySourceRow {
  product_id: string;
  source_id: string;
  source_record_key: string;
  source_record_id: string;
  identity_hash: string | null;
  source_observed_at: string;
  evidence_url_matches: number;
}

interface IdentityEvidenceDecisionRow {
  id: string;
  product_id: string;
  source_id: string;
  source_record_key: string;
  source_record_id: string;
  identity_hash: string;
  evidence_url: string;
  source_observed_at: string;
  rationale: string;
  decided_by: string;
  decided_at: string;
}

export type VerifyProductIdentityResult =
  | {
    status: "verified";
    productId: string;
    sourceRecordId: string;
    decisionId: string;
    idempotent: boolean;
  }
  | { status: "not_found" }
  | { status: "invalid_binding"; errors?: string[] }
  | { status: "conflict" };

function decisionFromRow(row: IdentityEvidenceDecisionRow): IdentityEvidenceDecision {
  return {
    id: row.id,
    productId: row.product_id,
    sourceId: row.source_id,
    sourceRecordKey: row.source_record_key,
    sourceRecordId: row.source_record_id,
    identityHash: row.identity_hash,
    evidenceUrl: row.evidence_url,
    sourceObservedAt: row.source_observed_at,
    rationale: row.rationale,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

export async function currentIdentityEvidenceDecision(
  db: D1Database,
  decision: IdentityEvidenceDecision,
): Promise<IdentityEvidenceDecision | null> {
  const row = await db.prepare(`SELECT id, product_id, source_id, source_record_key,
    source_record_id, identity_hash, evidence_url, source_observed_at, rationale,
    decided_by, decided_at
    FROM identity_evidence_decisions
    WHERE id = ? OR (
      product_id = ? AND source_record_id = ? AND identity_hash = ?
    )
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
    LIMIT 1`)
    .bind(
      decision.id,
      decision.productId,
      decision.sourceRecordId,
      decision.identityHash,
      decision.id,
    )
    .first<IdentityEvidenceDecisionRow>();
  return row ? decisionFromRow(row) : null;
}

export function identityEvidenceWriteStatements(
  db: D1Database,
  decision: IdentityEvidenceDecision,
  disposition: IdentityEvidenceDecisionDisposition,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (disposition === "insert") {
    statements.push(db.prepare(`INSERT OR IGNORE INTO identity_evidence_decisions
      (id, product_id, source_id, source_record_key, source_record_id, identity_hash,
       evidence_url, source_observed_at, rationale, decided_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        decision.id,
        decision.productId,
        decision.sourceId,
        decision.sourceRecordKey,
        decision.sourceRecordId,
        decision.identityHash,
        decision.evidenceUrl,
        decision.sourceObservedAt,
        decision.rationale,
        decision.decidedBy,
        decision.decidedAt,
      ));
  }
  statements.push(db.prepare(`INSERT INTO evidence_outcomes
    (product_id, field_family, outcome, source_record_id, evidence_url, observed_at,
     verified_at, decided_by, notes)
    SELECT d.product_id, 'identity', 'verified', d.source_record_id, d.evidence_url,
      d.source_observed_at, d.decided_at, d.decided_by, d.rationale
    FROM identity_evidence_decisions d
    JOIN source_records record ON record.id = d.source_record_id
      AND record.source_id = d.source_id
      AND record.source_record_id = d.source_record_key
      AND record.product_id = d.product_id
      AND record.identity_hash = d.identity_hash
      AND (
        record.source_url = d.evidence_url OR
        EXISTS (
          SELECT 1
          FROM current_label_evidence_assets label
          WHERE label.subject_source_record_id = record.id
            AND label.subject_source_content_hash = record.content_hash
            AND d.evidence_url IN (label.requested_url, label.effective_url)
        )
      )
    JOIN products product ON product.id = d.product_id AND product.is_active = 1
    WHERE d.id = ? AND d.product_id = ? AND d.source_id = ?
      AND d.source_record_key = ? AND d.source_record_id = ? AND d.identity_hash = ?
      AND d.evidence_url = ? AND d.rationale = ? AND d.decided_by = ?
    ON CONFLICT(product_id, field_family) DO UPDATE SET
      outcome = excluded.outcome,
      source_record_id = excluded.source_record_id,
      evidence_url = excluded.evidence_url,
      observed_at = excluded.observed_at,
      verified_at = excluded.verified_at,
      decided_by = excluded.decided_by,
      notes = excluded.notes`)
    .bind(
      decision.id,
      decision.productId,
      decision.sourceId,
      decision.sourceRecordKey,
      decision.sourceRecordId,
      decision.identityHash,
      decision.evidenceUrl,
      decision.rationale,
      decision.decidedBy,
    ));
  return statements;
}

export async function buildIdentityEvidenceDecision(input: {
  productId: string;
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  identityHash: string;
  evidenceUrl: string;
  sourceObservedAt: string;
  rationale: string;
  decidedBy?: string;
  decidedAt?: string;
}): Promise<IdentityEvidenceDecision> {
  const binding = {
    productId: input.productId,
    sourceId: input.sourceId,
    sourceRecordKey: input.sourceRecordKey,
    sourceRecordId: input.sourceRecordId,
    identityHash: input.identityHash,
  };
  return {
    id: await identityEvidenceDecisionId(binding),
    ...binding,
    evidenceUrl: input.evidenceUrl,
    sourceObservedAt: input.sourceObservedAt,
    rationale: input.rationale,
    decidedBy: input.decidedBy ?? "local_operator",
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  };
}

export async function verifyProductIdentity(
  db: D1Database,
  productId: string,
  input: { sourceRecordId: string; evidenceUrl: string; rationale: string },
): Promise<VerifyProductIdentityResult> {
  const product = await db.prepare("SELECT id FROM products WHERE id = ? AND is_active = 1")
    .bind(productId).first<{ id: string }>();
  if (!product) return { status: "not_found" };

  const source = await db.prepare(`SELECT record.product_id, record.source_id,
    record.source_record_id AS source_record_key, record.id AS source_record_id,
    record.identity_hash, record.observed_at AS source_observed_at,
    CASE WHEN record.source_url = ? OR EXISTS (
      SELECT 1
      FROM current_label_evidence_assets label
      WHERE label.subject_source_record_id = record.id
        AND label.subject_source_content_hash = record.content_hash
        AND ? IN (label.requested_url, label.effective_url)
    ) THEN 1 ELSE 0 END AS evidence_url_matches
    FROM source_records record
    WHERE record.id = ? AND record.product_id = ?`)
    .bind(input.evidenceUrl, input.evidenceUrl, input.sourceRecordId, productId)
    .first<CurrentIdentitySourceRow>();
  if (!source?.identity_hash || source.evidence_url_matches !== 1) {
    return { status: "invalid_binding", errors: [
      "evidenceUrl must match the current source URL or a retained current-label URL",
    ] };
  }

  const decision = await buildIdentityEvidenceDecision({
    productId,
    sourceId: source.source_id,
    sourceRecordKey: source.source_record_key,
    sourceRecordId: source.source_record_id,
    identityHash: source.identity_hash,
    evidenceUrl: input.evidenceUrl,
    sourceObservedAt: source.source_observed_at,
    rationale: input.rationale,
  });
  const errors = await validateIdentityEvidenceDecision(decision);
  if (errors.length > 0) return { status: "invalid_binding", errors };

  const existing = await currentIdentityEvidenceDecision(db, decision);
  const disposition = identityEvidenceDecisionDisposition(existing, decision);
  if (disposition === "conflict") return { status: "conflict" };
  const acceptedDecision = disposition === "idempotent" && existing ? existing : decision;
  const statements = identityEvidenceWriteStatements(db, acceptedDecision, disposition);
  try {
    const results = await db.batch(statements);
    const projection = results.at(-1)?.meta.changes ?? 0;
    const inserted = disposition === "insert" ? results[0]?.meta.changes ?? 0 : 0;
    if (projection !== 1 || (disposition === "insert" && inserted !== 1)) {
      throw new Error(`Identity evidence transaction invariant failed: inserted=${inserted}, projected=${projection}`);
    }
  } catch (error) {
    if (error instanceof Error && (
      error.message.includes("identity evidence decision conflict")
      || error.message.includes("UNIQUE constraint failed: identity_evidence_decisions")
    )) return { status: "conflict" };
    if (error instanceof Error && error.message.includes("identity evidence current source binding mismatch")) {
      return { status: "invalid_binding" };
    }
    throw error;
  }
  return {
    status: "verified",
    productId,
    sourceRecordId: acceptedDecision.sourceRecordId,
    decisionId: acceptedDecision.id,
    idempotent: disposition === "idempotent",
  };
}

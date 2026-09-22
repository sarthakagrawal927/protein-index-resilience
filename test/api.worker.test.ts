import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CatalogResponse, CompletionLedgerResponse, CoverageResponse, HealthResponse, ProductDetailResponse, ReviewResponse } from "../shared/api";
import { canonicalJson, nutritionCandidateFromEvidence, nutritionCandidateHash } from "../shared/evidence-decisions";
import { ingredientCandidateFromEvidence, ingredientCandidateHash } from "../shared/ingredient-evidence";
import { resolveReview } from "../worker/reviews";

const worker = exports.default;

async function json<T>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json() as Promise<T>;
}

async function replaySeed(): Promise<void> {
  for (let index = 0; index < env.TEST_SEED_QUERIES.length; index += 50) {
    await env.DB.batch(env.TEST_SEED_QUERIES.slice(index, index + 50).map((query) => env.DB.prepare(query)));
  }
}

async function applyQueries(queries: string[]): Promise<void> {
  for (let index = 0; index < queries.length; index += 50) {
    await env.DB.batch(queries.slice(index, index + 50).map((query) => env.DB.prepare(query)));
  }
}

async function identityReview(sourceRecordId: string): Promise<ReviewResponse["items"][number]> {
  const source = await env.DB.prepare("SELECT id FROM source_records WHERE source_record_id = ?")
    .bind(sourceRecordId).first<{ id: string }>();
  if (!source) throw new Error(`Expected source record ${sourceRecordId}`);
  const response = await worker.fetch("http://localhost/api/reviews?status=open");
  const reviews = await json<ReviewResponse>(response);
  const review = reviews.items.find((item) => item.type === "identity" && item.sourceRecordId === source.id);
  if (!review?.productId) throw new Error("Expected an identity review with an incoming product");
  return review;
}

async function retainIdentityLabel(
  sourceRecordId: string,
  evidenceUrl: string,
  suffix: string,
): Promise<void> {
  const source = await env.DB.prepare(`SELECT product_id, content_hash
    FROM source_records WHERE id = ?`)
    .bind(sourceRecordId)
    .first<{ product_id: string; content_hash: string }>();
  if (!source) throw new Error("Expected identity source for retained label evidence");
  await env.DB.prepare(`INSERT OR IGNORE INTO label_evidence_assets
    (id, subject_source_record_id, subject_source_content_hash, product_id,
     field_family, source_image_id, source_image_revision, requested_url,
     effective_url, content_sha256, byte_length, media_type, fetched_at)
    VALUES (?, ?, ?, ?, 'nutrition', ?, '1', ?, ?, ?, 1024, 'image/jpeg',
      '2026-07-17T00:00:00.000Z')`)
    .bind(
      `identity-label-${suffix}`,
      sourceRecordId,
      source.content_hash,
      source.product_id,
      `identity-${suffix}`,
      evidenceUrl,
      evidenceUrl,
      suffix === "match" ? "a".repeat(64) : "b".repeat(64),
    ).run();
}

async function insertRobotoffReview(input: {
  suffix: string;
  evidence: unknown;
}): Promise<{ reviewId: string; productId: string; sourceRecordId: string }> {
  const product = await env.DB.prepare("SELECT id, gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
    .first<{ id: string; gtin: string }>();
  const run = await env.DB.prepare("SELECT id FROM ingestion_runs ORDER BY started_at LIMIT 1").first<{ id: string }>();
  if (!product || !run) throw new Error("Expected seeded product and ingestion run");
  const sourceRecordId = `src_robotoff_${input.suffix}`;
  const reviewId = `rev_robotoff_${input.suffix}`;
  const observedAt = "2026-07-15T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO sources
      (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
        license_url, retention_notes, credential_requirement, created_at)
      VALUES ('open_food_facts_robotoff', 'Open Food Facts Robotoff', 'open_data', 0, 20, 0,
        'https://opendatacommons.org/licenses/odbl/1-0/', 'Review evidence only', NULL, ?)`)
      .bind(observedAt),
    env.DB.prepare(`INSERT INTO source_records
      (id, source_id, source_record_id, product_id, source_url, content_hash, identity_hash,
        observed_at, first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule)
      VALUES (?, 'open_food_facts_robotoff', ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'exact_gtin')`)
      .bind(sourceRecordId, `${product.gtin}:${input.suffix}`, product.id,
        `https://robotoff.openfoodfacts.org/api/v1/image_predictions?barcode=${product.gtin}`,
        `hash_${input.suffix}`, `identity_${input.suffix}`, observedAt, run.id, run.id),
    env.DB.prepare(`INSERT INTO review_items
      (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json,
        evidence_json, created_at)
      VALUES (?, 'nutrition_validation', 50, 'open', ?, ?, '[]', ?, ?)`)
      .bind(reviewId, sourceRecordId, product.id, JSON.stringify(input.evidence), observedAt),
  ]);
  return { reviewId, productId: product.id, sourceRecordId };
}

async function insertIngredientReview(input: {
  suffix: string;
  evidence: unknown;
}): Promise<{ reviewId: string; productId: string; sourceRecordId: string }> {
  const product = await env.DB.prepare("SELECT id, gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
    .first<{ id: string; gtin: string }>();
  const run = await env.DB.prepare("SELECT id FROM ingestion_runs ORDER BY started_at LIMIT 1").first<{ id: string }>();
  if (!product || !run) throw new Error("Expected seeded product and ingestion run");
  const sourceRecordId = `src_robotoff_ingredients_${input.suffix}`;
  const reviewId = `rev_robotoff_ingredients_${input.suffix}`;
  const observedAt = "2026-07-16T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO sources
      (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
        license_url, retention_notes, credential_requirement, created_at)
      VALUES ('open_food_facts_robotoff_ingredients', 'Open Food Facts Robotoff ingredients',
        'open_data', 0, 0, 20, 'https://opendatacommons.org/licenses/odbl/1-0/',
        'Ingredient review evidence only', NULL, ?)`)
      .bind(observedAt),
    env.DB.prepare(`INSERT INTO source_records
      (id, source_id, source_record_id, product_id, source_url, content_hash, identity_hash,
        observed_at, first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule)
      VALUES (?, 'open_food_facts_robotoff_ingredients', ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'exact_gtin')`)
      .bind(
        sourceRecordId,
        `${product.gtin}:ingredient:${input.suffix}`,
        product.id,
        `https://robotoff.openfoodfacts.org/api/v1/image_predictions?barcode=${product.gtin}&type=ner&model_name=ingredient_detection`,
        `ingredient_hash_${input.suffix}`,
        `ingredient_identity_${input.suffix}`,
        observedAt,
        run.id,
        run.id,
      ),
    env.DB.prepare(`INSERT INTO review_items
      (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json,
        evidence_json, created_at)
      VALUES (?, 'ingredient_conflict', 50, 'open', ?, ?, '[]', ?, ?)`)
      .bind(reviewId, sourceRecordId, product.id, JSON.stringify(input.evidence), observedAt),
  ]);
  return { reviewId, productId: product.id, sourceRecordId };
}

function robotoffEvidence(barcode: string, nutritionPer100g: Record<string, number | null>): unknown {
  return {
    code: "robotoff_nutrition_candidate",
    severity: "warning",
    field: "nutrition",
    details: {
      candidate: {
        predictionId: "prediction-1",
        barcode,
        imageId: "image-1",
        imageUrl: "https://images.openfoodfacts.org/images/products/label.jpg",
        modelName: "nutrition_extractor",
        modelVersion: "nutrition_extractor-2.0",
        observedAt: "2026-07-14T00:00:00.000Z",
        basis: "per_100g",
        minimumConfidence: 0.93,
        nutritionPer100g,
      },
    },
  };
}

async function attachExactExtraction(
  review: { reviewId: string; productId: string; sourceRecordId: string },
  evidence: unknown,
  fieldFamily: "nutrition" | "ingredients",
): Promise<{ extractionAttemptId: string; labelAssetId: string }> {
  const context = await env.DB.prepare(`SELECT p.gtin, s.source_id,
    s.content_hash AS candidate_content_hash, s.first_seen_run_id, run.input_hash
    FROM source_records s
    JOIN products p ON p.id = s.product_id
    JOIN ingestion_runs run ON run.id = s.first_seen_run_id
    WHERE s.id = ? AND s.product_id = ?`)
    .bind(review.sourceRecordId, review.productId)
    .first<{
      gtin: string;
      source_id: string;
      candidate_content_hash: string;
      first_seen_run_id: string;
      input_hash: string;
    }>();
  const subject = await env.DB.prepare(`SELECT id, source_record_id, content_hash
    FROM source_records
    WHERE product_id = ? AND id <> ? AND length(content_hash) = 64
    ORDER BY id LIMIT 1`)
    .bind(review.productId, review.sourceRecordId)
    .first<{ id: string; source_record_id: string; content_hash: string }>();
  if (!context?.input_hash || !subject) throw new Error("Expected exact extraction source context");
  let candidateHash: string;
  let candidateMeta: { modelName: string; modelVersion: string; imageId: string; imageUrl: string };
  if (fieldFamily === "nutrition") {
    const candidate = nutritionCandidateFromEvidence(evidence, context.gtin);
    if (!candidate) throw new Error("Expected exact nutrition extraction candidate");
    candidateHash = await nutritionCandidateHash(candidate);
    candidateMeta = candidate;
  } else {
    const candidate = ingredientCandidateFromEvidence(evidence, context.gtin);
    if (!candidate) throw new Error("Expected exact ingredient extraction candidate");
    candidateHash = await ingredientCandidateHash(candidate);
    candidateMeta = candidate;
  }
  const extractionAttemptId = `xat_${candidateHash.slice(0, 24)}`;
  const labelAssetId = `lbl_${candidateHash.slice(24, 48)}`;
  const extractionRunId = `xrun_${candidateHash.slice(0, 24)}`;
  const extractionIngestionRunId = `${extractionRunId}_ingestion`;
  const adapterVersion = fieldFamily === "nutrition" ? "robotoff-api-v8" : "robotoff-ingredients-api-v3";
  const labelContentSha256 = "6".repeat(64);
  const observedAt = "2026-07-17T00:00:00.000Z";
  const details = (structuredClone(evidence) as { details: Record<string, unknown> }).details;
  details.candidateHash = candidateHash;
  details.extractionAttemptId = extractionAttemptId;
  details.labelAssetId = labelAssetId;
  details.labelContentSha256 = labelContentSha256;

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ingestion_runs
      (id, source_id, adapter_version, mode, input_identifier, input_hash,
       records_read, india_records, staged_records, invalid_records, duplicate_records,
       terminal_evidence, source_complete, market_complete, status, started_at, completed_at,
       manifest_json)
      VALUES (?, ?, ?, 'sample', ?, ?, 1, 1, 1, 0, 0,
        'end_of_file', 1, 0, 'completed', ?, ?, '{}')`)
      .bind(
        extractionIngestionRunId,
        context.source_id,
        adapterVersion,
        `exact-extraction:${candidateHash}`,
        candidateHash,
        observedAt,
        observedAt,
      ),
    env.DB.prepare(`INSERT INTO extraction_runs
      (id, ingestion_run_id, field_family, request_schema_hash, artifact_digest,
       adapter_version, model_name, model_version, parent_source_run_id,
       parent_source_input_hash, repository, workflow, branch, head_sha,
       source_complete, status, started_at, completed_at, accepted_at, manifest_json)
      VALUES (?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, 'owner/protein-index', 'extract-robotoff',
        'main', ?, 1, 'accepted', ?, ?, ?, '{}')`)
      .bind(
        extractionRunId,
        extractionIngestionRunId,
        fieldFamily,
        "3".repeat(64),
        candidateHash,
        adapterVersion,
        candidateMeta.modelName,
        candidateMeta.modelVersion,
        context.first_seen_run_id,
        context.input_hash,
        "5".repeat(40),
        observedAt,
        observedAt,
        observedAt,
      ),
    env.DB.prepare(`INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id,
       field_family, source_image_id, source_image_revision, requested_url,
       effective_url, content_sha256, byte_length, media_type, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 4096, 'image/jpeg', ?)`)
      .bind(
        labelAssetId,
        subject.id,
        subject.content_hash,
        review.productId,
        fieldFamily,
        candidateMeta.imageId,
        candidateMeta.imageUrl,
        candidateMeta.imageUrl,
        labelContentSha256,
        observedAt,
      ),
    env.DB.prepare(`INSERT INTO extraction_attempts
      (id, extraction_run_id, subject_source_record_id, subject_source_record_key,
       subject_source_content_hash, product_id, field_family, response_evidence_hash,
       status, prediction_count, candidate_count, rejection_count, failure_count,
       conflict_count, reasons_json, attempted_at, is_current)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, 1, 0, 0, 0, '[]', ?, 1)`)
      .bind(
        extractionAttemptId,
        extractionRunId,
        subject.id,
        subject.source_record_id,
        subject.content_hash,
        review.productId,
        fieldFamily,
        "7".repeat(64),
        observedAt,
      ),
    env.DB.prepare(`INSERT INTO extraction_attempt_labels
      (id, attempt_id, label_asset_id, role, outcome, prediction_count, candidate_count,
       rejection_count, failure_count, conflict_count, candidate_hashes_json, reasons_json)
      VALUES (?, ?, ?, 'prediction', 'candidate', 1, 1, 0, 0, 0, ?, '[]')`)
      .bind(`xal_${candidateHash.slice(0, 24)}`, extractionAttemptId, labelAssetId, JSON.stringify([candidateHash])),
  ]);
  await env.DB.batch([
    env.DB.prepare("UPDATE source_records SET raw_evidence_json = ? WHERE id = ?")
      .bind(JSON.stringify({ candidateHash, extractionAttemptId, labelAssetId, labelContentSha256 }), review.sourceRecordId),
    env.DB.prepare("UPDATE review_items SET evidence_json = ? WHERE id = ?")
      .bind(JSON.stringify({ ...(structuredClone(evidence) as Record<string, unknown>), details }), review.reviewId),
  ]);
  return { extractionAttemptId, labelAssetId };
}

function robotoffVolumeEvidence(barcode: string, nutritionPer100ml: Record<string, number | null>): unknown {
  return {
    code: "robotoff_nutrition_candidate",
    severity: "warning",
    field: "nutrition",
    details: {
      candidate: {
        predictionId: "volume-prediction-1",
        barcode,
        imageId: "volume-image-1",
        imageUrl: "https://images.openfoodfacts.org/images/products/volume-label.jpg",
        modelName: "nutrition_extractor",
        modelVersion: "nutrition_extractor-2.0",
        observedAt: "2026-07-14T00:00:00.000Z",
        basis: "per_100ml",
        minimumConfidence: 0.96,
        nutritionPer100ml,
      },
    },
  };
}

function robotoffIngredientEvidence(barcode: string, suffix: string): {
  evidence: unknown;
  candidate: {
    imageUrl: string;
    entityText: string;
    observedAt: string;
  };
} {
  const candidate = {
    predictionId: `ingredient-prediction-${suffix}`,
    entityIndex: 0,
    barcode,
    imageId: `ingredient-image-${suffix}`,
    imageUrl: `https://images.openfoodfacts.org/images/products/${suffix}.jpg`,
    modelName: "ingredient_detection" as const,
    modelVersion: "ingredient-detection-1.0",
    predictedAt: "2026-07-16T00:00:00.000Z",
    observedAt: "2026-07-15T23:00:00.000Z",
    entityText: "Whey blend 70% (concentrate, isolate), cocoa 8%, flavour",
    entityConfidence: 0.99,
    language: { code: "en", confidence: 0.9 },
    boundingBox: [10, 20, 300, 800] as [number, number, number, number],
    parsedIngredients: [
      { id: "en:whey-protein", text: "Whey blend", in_taxonomy: true },
      { id: "en:cocoa", text: "Cocoa", in_taxonomy: true },
      { id: "en:flavouring", text: "Flavour", in_taxonomy: true },
    ],
    ingredientCount: 5,
    knownIngredientCount: 4,
    unknownIngredientCount: 1,
  };
  return {
    candidate,
    evidence: {
      code: "robotoff_ingredient_candidate",
      severity: "warning",
      field: "ingredients",
      details: { candidate },
    },
  };
}

describe("Worker catalog API", () => {
  it("preserves nutrition decisions while migrating the evidence family discriminator", async () => {
    const source = await env.DB.prepare(`SELECT s.id AS source_record_id, s.source_id,
      s.source_record_id AS source_record_key, s.content_hash, s.product_id
      FROM source_records s WHERE s.product_id IS NOT NULL ORDER BY s.id LIMIT 1`)
      .first<{
        source_record_id: string;
        source_id: string;
        source_record_key: string;
        content_hash: string;
        product_id: string;
      }>();
    if (!source) throw new Error("Expected seeded source evidence");
    const legacyMigration = env.TEST_MIGRATIONS.find(({ name }) => name.startsWith("0005_"));
    const forwardMigration = env.TEST_MIGRATIONS.find(({ name }) => name.startsWith("0006_"));
    if (!legacyMigration || !forwardMigration) throw new Error("Expected evidence decision migrations");
    const tableName = "migration_evidence_decisions";
    await applyQueries(legacyMigration.queries.map((query) => query.replaceAll("evidence_decisions", tableName)));
    await env.DB.prepare(`INSERT INTO ${tableName}
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'nutrition', 'verify', '{}', ?, ?, ?, ?, 1)`)
      .bind(
        "migration_nutrition_decision",
        source.source_id,
        source.source_record_key,
        source.source_record_id,
        source.content_hash,
        source.product_id,
        "0".repeat(64),
        "https://images.openfoodfacts.org/migration-label.jpg",
        "Preserve existing nutrition decision",
        "migration_test",
        "2026-07-16T00:00:00.000Z",
      ).run();
    await applyQueries(forwardMigration.queries.map((query) => query.replaceAll("evidence_decisions", tableName)));
    const preserved = await env.DB.prepare(`SELECT id, field_family, decision, candidate_hash
      FROM ${tableName} WHERE id = 'migration_nutrition_decision'`).first<Record<string, unknown>>();
    expect(preserved).toEqual({
      id: "migration_nutrition_decision",
      field_family: "nutrition",
      decision: "verify",
      candidate_hash: "0".repeat(64),
    });
    await expect(env.DB.prepare(`INSERT INTO ${tableName}
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ingredients', 'reject', '{}', ?, ?, ?, ?, 1)`)
      .bind(
        "migration_ingredient_decision",
        source.source_id,
        `${source.source_record_key}:ingredients`,
        source.source_record_id,
        source.content_hash,
        source.product_id,
        "1".repeat(64),
        "https://images.openfoodfacts.org/migration-ingredients.jpg",
        "Ingredient evidence remains review only",
        "migration_test",
        "2026-07-16T00:01:00.000Z",
      ).run()).resolves.toMatchObject({ success: true });
    await expect(env.DB.prepare(`INSERT INTO ${tableName}
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'identity', 'reject', '{}', ?, ?, ?, ?, 1)`)
      .bind(
        "migration_invalid_decision",
        source.source_id,
        `${source.source_record_key}:identity`,
        source.source_record_id,
        source.content_hash,
        source.product_id,
        "2".repeat(64),
        "https://images.openfoodfacts.org/migration-invalid.jpg",
        "Unsupported evidence family",
        "migration_test",
        "2026-07-16T00:02:00.000Z",
      ).run()).rejects.toThrow();
  });

  it("reports seeded health and configured-source coverage", async () => {
    const healthResponse = await worker.fetch("http://localhost/api/health");
    expect(healthResponse.status).toBe(200);
    expect(await json<HealthResponse>(healthResponse)).toMatchObject({
      status: "ok",
      products: 5,
      runtime: "local",
      sourceComplete: true,
      mutations: "local_only",
    });

    const coverageResponse = await worker.fetch("http://localhost/api/coverage");
    expect(coverageResponse.status).toBe(200);
    const coverage = await json<CoverageResponse>(coverageResponse);
    expect(coverage.claim).toBe("configured_sources_only");
    expect(coverage.catalog).toMatchObject({ products: 5, validGtin: 5, structuredNutrition: 5, nutritionLabelImages: 0, extractionCandidates: 0 });
    expect(coverage.completion).toMatchObject({ status: "incomplete", sourceCoverageComplete: true, outstandingIdentity: 5 });
    expect(coverage.completion.outstandingNutrition).toBeGreaterThan(0);
    expect(coverage.sources[0]).toMatchObject({ id: "label_fixture", sourceComplete: true, marketComplete: false });
    expect(coverage.disconnectedSources).toContain("gs1_india_datakart");
  });

  it("counts Robotoff extraction candidates once per product across review statuses", async () => {
    const product = await env.DB.prepare("SELECT id, gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ id: string; gtin: string }>();
    if (!product) throw new Error("Expected a seeded product");
    await insertRobotoffReview({ suffix: "coverage-first", evidence: robotoffEvidence(product.gtin, { calories: 360, proteinGrams: 25 }) });
    await insertRobotoffReview({ suffix: "coverage-second", evidence: robotoffEvidence(product.gtin, { calories: 365, proteinGrams: 26 }) });
    await env.DB.prepare("UPDATE review_items SET status = 'resolved' WHERE id = 'rev_robotoff_coverage-first'").run();
    await env.DB.prepare("UPDATE review_items SET status = 'dismissed' WHERE id = 'rev_robotoff_coverage-second'").run();

    const response = await worker.fetch("http://localhost/api/coverage");
    expect(response.status).toBe(200);
    const coverage = await json<CoverageResponse>(response);
    expect(coverage.catalog.extractionCandidates).toBe(1);
  });

  it("reports production runtime and rejects anonymous production mutations", async () => {
    const health = await worker.fetch("https://protein-index.example/api/health");
    expect(await json<HealthResponse>(health)).toMatchObject({ runtime: "production", mutations: "local_only" });

    const mutation = await worker.fetch("https://protein-index.example/api/reviews/anything/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "dismiss", rationale: "should remain read only" }),
    });
    expect(mutation.status).toBe(403);
    expect(await json<{ error: { code: string } }>(mutation)).toMatchObject({ error: { code: "mutations_disabled" } });
  });

  it("filters and deterministically paginates the read-only review queue", async () => {
    const insert = env.DB.prepare(`INSERT INTO review_items
      (id, type, priority, status, candidate_product_ids_json, evidence_json, created_at)
      VALUES (?, ?, ?, ?, '[]', '{}', ?)`);
    await env.DB.batch([
      insert.bind("review-c", "invalid_gtin", 80, "open", "2026-07-15T00:00:00.000Z"),
      insert.bind("review-b", "invalid_gtin", 80, "open", "2026-07-15T00:00:00.000Z"),
      insert.bind("review-a", "invalid_gtin", 90, "open", "2026-07-15T00:01:00.000Z"),
      insert.bind("review-d", "invalid_gtin", 70, "open", "2026-07-15T00:02:00.000Z"),
      insert.bind("review-e", "invalid_gtin", 60, "resolved", "2026-07-15T00:03:00.000Z"),
      insert.bind("review-identity", "identity", 100, "open", "2026-07-15T00:04:00.000Z"),
    ]);

    const firstResponse = await worker.fetch(
      "http://localhost/api/reviews?status=open&type=invalid_gtin&page=1&pageSize=2",
    );
    expect(firstResponse.status).toBe(200);
    const first = await json<ReviewResponse>(firstResponse);
    expect(first.items.map(({ id }) => id)).toEqual(["review-a", "review-b"]);
    expect(first.pagination).toEqual({ page: 1, pageSize: 2, total: 4, pages: 2 });
    expect(first.counts).toEqual({ open: 4, resolved: 1, dismissed: 0 });

    const secondResponse = await worker.fetch(
      "http://localhost/api/reviews?status=open&type=invalid_gtin&page=2&pageSize=2",
    );
    const second = await json<ReviewResponse>(secondResponse);
    expect(second.items.map(({ id }) => id)).toEqual(["review-c", "review-d"]);
    expect(second.pagination).toEqual({ page: 2, pageSize: 2, total: 4, pages: 2 });

    const identityResponse = await worker.fetch(
      "http://localhost/api/reviews?status=open&type=identity&page=1&pageSize=10",
    );
    const identity = await json<ReviewResponse>(identityResponse);
    expect(identity.items.every(({ type }) => type === "identity")).toBe(true);
    expect(identity.items.some(({ id }) => id === "review-identity")).toBe(true);
    expect(identity.pagination.total).toBe(identity.items.length);

    for (const query of [
      "status=unknown",
      "type=unknown",
      "page=0",
      "page=1.5",
      "pageSize=0",
      "pageSize=101",
    ]) {
      const invalid = await worker.fetch(`http://localhost/api/reviews?${query}`);
      expect(invalid.status).toBe(400);
      expect(await json<{ error: { code: string } }>(invalid)).toMatchObject({ error: { code: "validation_error" } });
    }

    const publicMutation = await worker.fetch("https://protein-index.example/api/reviews/review-a/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "dismiss", rationale: "must remain read only" }),
    });
    expect(publicMutation.status).toBe(403);
  });

  it("uses evidence-aware protein-density defaults and returns evidence-rich detail", async () => {
    const catalogResponse = await worker.fetch("http://localhost/api/products");
    expect(catalogResponse.status).toBe(200);
    const catalog = await json<CatalogResponse>(catalogResponse);
    expect(catalog.trustedDefault).toBe(false);
    expect(catalog.filters).toMatchObject({ trust: "all", verification: "all", scope: "all", sort: "protein_density" });
    expect(catalog.products.length).toBeGreaterThan(0);
    expect(catalog.products.some((product) => product.nutritionStatus === "unverified")).toBe(true);
    expect(catalog.products.some((product) => product.nutritionStatus === "verified")).toBe(false);
    expect(catalog.products.filter((product) => product.nutritionStatus === "conflict").every((product) => product.metrics.proteinPer100Calories.value === null)).toBe(true);
    const densityValues = catalog.products.map((product) => product.metrics.proteinPer100Calories.value).filter((value): value is number => value !== null);
    expect(densityValues).toEqual([...densityValues].sort((left, right) => right - left));
    const firstUnavailable = catalog.products.findIndex((product) => product.metrics.proteinPer100Calories.value === null);
    if (firstUnavailable >= 0) {
      expect(catalog.products.slice(firstUnavailable).every((product) => product.metrics.proteinPer100Calories.value === null)).toBe(true);
    }
    const first = catalog.products[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("Expected a catalog product");

    const detailResponse = await worker.fetch(`http://localhost/api/products/${first.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = await json<ProductDetailResponse>(detailResponse);
    expect(detail.id).toBe(first.id);
    expect(detail.sourceRecords[0]?.source).toBe("label_fixture");
    expect(detail.ingredientStatement).toBeTruthy();
    expect(detail.ingredients.length).toBeGreaterThan(0);
    expect(detail.nutrients.length).toBeGreaterThan(0);
    expect("offers" in detail).toBe(false);
    expect(detail.ratings[0]?.ratingCount).toBeGreaterThan(0);
    expect(detail.provenance.some((observation) => observation.field.startsWith("nutrition."))).toBe(true);

    await env.DB.prepare("UPDATE nutrition_facts SET status = 'unverified' WHERE product_id = ?").bind(first.id).run();
    const discoveryResponse = await worker.fetch("http://localhost/api/products?verification=all&scope=all&sort=completeness");
    const discovery = await json<CatalogResponse>(discoveryResponse);
    const unverified = discovery.products.find((product) => product.id === first.id);
    expect(unverified).toBeDefined();
    expect(unverified?.metrics.proteinPer100Calories.value).toBeGreaterThan(0);
    const trustedResponse = await worker.fetch("http://localhost/api/products?trust=strict&verification=verified&scope=protein&sort=protein_density");
    const trusted = await json<CatalogResponse>(trustedResponse);
    expect(trusted.trustedDefault).toBe(true);
    expect(trusted.products.some((product) => product.id === first.id)).toBe(false);
    await env.DB.prepare("UPDATE nutrition_facts SET status = 'unverified', calories = 33, protein_grams = 8.59, carbohydrate_grams = 28.1, fat_grams = 1.2 WHERE product_id = ?").bind(first.id).run();
    const invalidNutritionResponse = await worker.fetch("http://localhost/api/products");
    const invalidNutritionCatalog = await json<CatalogResponse>(invalidNutritionResponse);
    const invalidNutrition = invalidNutritionCatalog.products.find((product) => product.id === first.id);
    expect(invalidNutrition?.metrics.proteinPer100Calories).toEqual({ value: null, reason: "nutrition_validation_error" });
    expect(invalidNutritionCatalog.products[0]?.id).not.toBe(first.id);
    await env.DB.prepare("UPDATE nutrition_facts SET status = 'unverified', calories = 115, protein_grams = 29, carbohydrate_grams = NULL, fat_grams = NULL WHERE product_id = ?").bind(first.id).run();
    const roundedConflictResponse = await worker.fetch("http://localhost/api/products");
    const roundedConflictCatalog = await json<CatalogResponse>(roundedConflictResponse);
    const roundedConflict = roundedConflictCatalog.products.find((product) => product.id === first.id);
    expect(roundedConflict?.metrics.proteinPer100Calories).toEqual({ value: null, reason: "protein_energy_exceeds_total" });
    expect(roundedConflict?.metrics.proteinCaloriePercentage).toEqual({ value: null, reason: "protein_energy_exceeds_total" });
    expect(roundedConflictCatalog.products[0]?.id).not.toBe(first.id);
    await env.DB.prepare("UPDATE nutrition_facts SET status = 'verified', calories = ?, protein_grams = ?, carbohydrate_grams = ?, fat_grams = ? WHERE product_id = ?")
      .bind(first.nutrition.calories, first.nutrition.proteinGrams, first.nutrition.carbohydrateGrams, first.nutrition.fatGrams, first.id).run();
  });

  it("finds protein-branded discovery products across brand and category metadata", async () => {
    const product = await env.DB.prepare(`SELECT id, brand, brand_normalized, name, name_normalized,
      category, category_raw, marketed_protein, marketed_reasons_json
      FROM products WHERE is_active = 1 ORDER BY id LIMIT 1`)
      .first<{
        id: string;
        brand: string;
        brand_normalized: string;
        name: string;
        name_normalized: string;
        category: string;
        category_raw: string | null;
        marketed_protein: number;
        marketed_reasons_json: string;
      }>();
    if (!product) throw new Error("Expected a seeded product");
    await env.DB.prepare(`UPDATE products
      SET brand = 'MyProtein', brand_normalized = 'myprotein', name = 'Millet Bites', name_normalized = 'millet bites',
          category = 'other', category_raw = 'Snacks', marketed_protein = 0, marketed_reasons_json = '[]'
      WHERE id = ?`).bind(product.id).run();

    const response = await worker.fetch("http://localhost/api/products?scope=protein_branded&q=protein+snacks&pageSize=100");
    expect(response.status).toBe(200);
    const catalog = await json<CatalogResponse>(response);
    expect(catalog.filters.scope).toBe("protein_branded");
    expect(catalog.products.map(({ id }) => id)).toContain(product.id);
    expect(catalog.products.find(({ id }) => id === product.id)?.marketedProtein).toBe(false);
    await env.DB.prepare(`UPDATE products
      SET brand = ?, brand_normalized = ?, name = ?, name_normalized = ?, category = ?, category_raw = ?,
          marketed_protein = ?, marketed_reasons_json = ?
      WHERE id = ?`).bind(
      product.brand, product.brand_normalized, product.name, product.name_normalized, product.category,
      product.category_raw, product.marketed_protein, product.marketed_reasons_json, product.id,
    ).run();
  });

  it("keeps strict trust separate from discovery and revokes it on identity drift", async () => {
    const observedAt = "2026-07-17T16:00:00.000Z";
    const contentHash = "7".repeat(64);
    const identityHash = "8".repeat(64);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sources
        (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
         retention_notes, created_at)
        VALUES ('strict_brand', 'Strict Brand', 'brand', 100, 100, 100,
          'Strict trust API fixture', ?)`)
        .bind(observedAt),
      env.DB.prepare(`INSERT INTO ingestion_runs
        (id, source_id, adapter_version, mode, input_identifier, input_hash,
         records_read, india_records, staged_records, invalid_records, duplicate_records,
         source_complete, market_complete, status, started_at, completed_at)
        VALUES ('strict_run', 'strict_brand', 'strict-v1', 'sample', 'strict-fixture', ?,
          1, 1, 1, 0, 0, 1, 0, 'completed', ?, ?)`)
        .bind("9".repeat(64), observedAt, observedAt),
      env.DB.prepare(`INSERT INTO products
        (id, gtin, brand, brand_normalized, name, name_normalized, category,
         marketed_protein, marketed_reasons_json, nutritionally_protein_dense,
         nutrition_reasons_json, classifier_version, completeness,
         completeness_missing_json, created_at, updated_at, is_active)
        VALUES ('strict_product', '08900000000995', 'Strict Brand', 'strict brand',
          'Exact Protein', 'exact protein', 'protein_powder', 1, '["protein"]', 1,
          '["protein_at_least_10g_per_100kcal"]', 'protein-v1', 100, '[]', ?, ?, 1)`)
        .bind(observedAt, observedAt),
      env.DB.prepare(`INSERT INTO source_records
        (id, source_id, source_record_id, product_id, source_url, content_hash,
         identity_hash, observed_at, first_seen_run_id, last_seen_run_id,
         raw_evidence_json, resolution_rule)
        VALUES ('strict_record', 'strict_brand', 'strict-key', 'strict_product',
          'https://strict.example/product', ?, ?, ?, 'strict_run', 'strict_run', '{}',
          'exact_gtin')`)
        .bind(contentHash, identityHash, observedAt),
    ]);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO nutrition_facts
        (product_id, source_record_id, status, confidence, authority, basis,
         preparation_state, calories, protein_grams, carbohydrate_grams, fat_grams,
         observed_at, updated_at)
        VALUES ('strict_product', 'strict_record', 'verified', 'high', 100, 'per_100g',
          'as_sold', 360, 52, 20, 8, ?, ?)`)
        .bind(observedAt, observedAt),
      env.DB.prepare(`INSERT INTO ingredient_statements
        (product_id, source_record_id, raw_text, language, status, confidence,
         authority, observed_at, updated_at)
        VALUES ('strict_product', 'strict_record', 'Milk protein, cocoa', 'en',
          'verified', 'high', 100, ?, ?)`)
        .bind(observedAt, observedAt),
      env.DB.prepare(`INSERT INTO nutrient_values
        (id, product_id, source_record_id, nutrient_code, quantity, unit, basis,
         preparation_state, status, observed_at)
        VALUES ('strict_nutrient', 'strict_product', 'strict_record', 'calcium', 120,
          'mg', 'per_100g', 'as_sold', 'verified', ?)`)
        .bind(observedAt),
      env.DB.prepare(`INSERT INTO identity_evidence_decisions
        (id, product_id, source_id, source_record_key, source_record_id, identity_hash,
         evidence_url, source_observed_at, rationale, decided_by, decided_at)
        VALUES ('ied_abcdef0123456789abcdef01', 'strict_product', 'strict_brand',
          'strict-key', 'strict_record', ?, 'https://strict.example/product', ?,
          'Exact product variant reviewed', 'test_reviewer', ?)`)
        .bind(identityHash, observedAt, observedAt),
      env.DB.prepare(`INSERT INTO evidence_outcomes
        (product_id, field_family, outcome, source_record_id, evidence_url,
         observed_at, verified_at, decided_by, notes)
        VALUES ('strict_product', 'identity', 'verified', 'strict_record',
          'https://strict.example/product', ?, ?, 'test_reviewer',
          'Exact product variant reviewed')`)
        .bind(observedAt, observedAt),
    ]);

    const strictResponse = await worker.fetch(
      "http://localhost/api/products?trust=strict&scope=all&sort=protein_density&pageSize=100",
    );
    expect(strictResponse.status).toBe(200);
    const strict = await json<CatalogResponse>(strictResponse);
    expect(strict.trustedDefault).toBe(true);
    expect(strict.products.some(({ id }) => id === "strict_product")).toBe(true);
    const beforeDiscovery = await json<CatalogResponse>(await worker.fetch(
      "http://localhost/api/products?trust=all&scope=all&pageSize=100",
    ));
    expect(beforeDiscovery.products.find(({ id }) => id === "strict_product")).toMatchObject({
      nutritionStatus: "verified",
      ingredientStatus: "verified",
    });
    const beforeDetail = await json<ProductDetailResponse>(await worker.fetch(
      "http://localhost/api/products/strict_product",
    ));
    expect(beforeDetail).toMatchObject({
      nutritionEvidenceUrl: "https://strict.example/product",
      nutritionEvidenceKind: "source",
      ingredientEvidenceUrl: "https://strict.example/product",
      ingredientEvidenceKind: "source",
      ingredientTerminalOutcome: null,
    });
    expect(beforeDetail.nutrients.find(({ code }) => code === "calcium")?.status).toBe("verified");
    const beforeCoverage = await json<CoverageResponse>(await worker.fetch("http://localhost/api/coverage"));
    for (const family of ["identity", "nutrition", "ingredients"] as const) {
      const completion = await json<CompletionLedgerResponse>(await worker.fetch(
        `http://localhost/api/completion-ledger?family=${family}&state=all&q=Exact+Protein&pageSize=100`,
      ));
      expect(completion.items.find(({ product }) => product.id === "strict_product")).toMatchObject({
        state: "verified",
        lane: null,
      });
    }

    await env.DB.prepare(`UPDATE source_records SET observed_at = ? WHERE id = 'strict_record'`)
      .bind("2026-07-17T16:01:00.000Z").run();
    const driftedStrict = await json<CatalogResponse>(await worker.fetch(
      "http://localhost/api/products?trust=strict&scope=all&pageSize=100",
    ));
    expect(driftedStrict.products.some(({ id }) => id === "strict_product")).toBe(false);
    const discovery = await json<CatalogResponse>(await worker.fetch(
      "http://localhost/api/products?trust=all&scope=all&pageSize=100",
    ));
    expect(discovery.products.find(({ id }) => id === "strict_product")).toMatchObject({
      nutritionStatus: "unverified",
      ingredientStatus: "unverified",
    });
    const verified = await json<CatalogResponse>(await worker.fetch(
      "http://localhost/api/products?verification=verified&ingredientVerification=verified&scope=all&pageSize=100",
    ));
    expect(verified.products.some(({ id }) => id === "strict_product")).toBe(false);
    const unverified = await json<CatalogResponse>(await worker.fetch(
      "http://localhost/api/products?verification=unverified&ingredientVerification=unverified&scope=all&pageSize=100",
    ));
    expect(unverified.products.some(({ id }) => id === "strict_product")).toBe(true);
    const driftedDetail = await json<ProductDetailResponse>(await worker.fetch(
      "http://localhost/api/products/strict_product",
    ));
    expect(driftedDetail).toMatchObject({
      nutritionStatus: "unverified",
      ingredientStatus: "unverified",
    });
    expect(driftedDetail.nutrients.find(({ code }) => code === "calcium")?.status).toBe("unverified");
    const driftedCoverage = await json<CoverageResponse>(await worker.fetch("http://localhost/api/coverage"));
    expect(driftedCoverage.catalog.verifiedNutrition).toBe(beforeCoverage.catalog.verifiedNutrition - 1);
    expect(driftedCoverage.catalog.unverifiedNutrition).toBe(beforeCoverage.catalog.unverifiedNutrition + 1);
    expect(driftedCoverage.catalog.verifiedIngredients).toBe(beforeCoverage.catalog.verifiedIngredients - 1);
    expect(driftedCoverage.catalog.unverifiedIngredients).toBe(beforeCoverage.catalog.unverifiedIngredients + 1);
    for (const family of ["identity", "nutrition", "ingredients"] as const) {
      const completion = await json<CompletionLedgerResponse>(await worker.fetch(
        `http://localhost/api/completion-ledger?family=${family}&state=all&q=Exact+Protein&pageSize=100`,
      ));
      expect(completion.items.find(({ product }) => product.id === "strict_product")).toMatchObject({
        state: "outstanding",
        lane: "evidence_inconsistent",
      });
    }
    await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = 'strict_product'").run();
  });

  it("does not filter raw verified rows as verified without current evidence", async () => {
    const response = await worker.fetch(
      "http://localhost/api/products?verification=verified&ingredientVerification=verified&scope=all&sort=name&pageSize=100",
    );
    expect(response.status).toBe(200);
    const catalog = await json<CatalogResponse>(response);
    expect(catalog.products).toHaveLength(0);
    expect(catalog.products.every((product) => (
      product.nutritionStatus === "verified" && product.ingredientStatus === "verified"
    ))).toBe(true);
    expect(catalog.pagination.total).toBe(catalog.products.length);
    expect(catalog.filters).toMatchObject({
      verification: "verified",
      ingredientVerification: "verified",
    });

    const invalid = await worker.fetch("http://localhost/api/products?ingredientVerification=reviewed");
    expect(invalid.status).toBe(400);
    const invalidTrust = await worker.fetch("http://localhost/api/products?trust=implied");
    expect(invalidTrust.status).toBe(400);
    expect(await json<{ error: { message: string } }>(invalid)).toMatchObject({
      error: { message: "Invalid ingredient verification filter" },
    });
  });

  it("deduplicates logical detail values while retaining source-specific evidence", async () => {
    const product = await env.DB.prepare(`SELECT p.id
      FROM products p
      WHERE (SELECT COUNT(*) FROM source_records s WHERE s.product_id = p.id) >= 2
      ORDER BY p.id LIMIT 1`).first<{ id: string }>();
    if (!product) throw new Error("Expected a product with multiple source records");
    const sources = (await env.DB.prepare("SELECT id FROM source_records WHERE product_id = ? ORDER BY id LIMIT 2")
      .bind(product.id).all<{ id: string }>()).results;
    if (sources.length !== 2 || !sources[0] || !sources[1]) throw new Error("Expected two source records");
    const observedAt = "2026-07-16T00:00:00.000Z";
    await env.DB.batch([
      ...sources.map(({ id }) => env.DB.prepare(`INSERT INTO product_allergens
        (product_id, name, declaration, source_record_id) VALUES (?, 'detail-dedup-allergen', 'contains', ?)`)
        .bind(product.id, id)),
      ...sources.map(({ id }) => env.DB.prepare(`INSERT INTO product_additives
        (product_id, identifier, source_record_id, confidence) VALUES (?, 'INS 999', ?, 'medium')`)
        .bind(product.id, id)),
      ...sources.map(({ id }, index) => env.DB.prepare(`INSERT INTO nutrient_values
        (id, product_id, source_record_id, nutrient_code, quantity, unit, basis,
          preparation_state, status, observed_at)
        VALUES (?, ?, ?, 'test-micronutrient', 12, 'mg', 'per_100g', 'as_sold', 'unverified', ?)`)
        .bind(`nutrient_detail_dedup_${index}`, product.id, id, observedAt)),
    ]);

    const response = await worker.fetch(`http://localhost/api/products/${product.id}`);
    expect(response.status).toBe(200);
    const detail = await json<ProductDetailResponse>(response);
    expect(detail.allergens.filter((item) => item.name === "detail-dedup-allergen" && item.declaration === "contains")).toHaveLength(1);
    expect(detail.additives.filter((item) => item === "INS 999")).toHaveLength(1);
    expect(detail.nutrients.filter((item) => item.code === "test-micronutrient")).toHaveLength(1);
    const retained = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM product_allergens WHERE product_id = ? AND name = 'detail-dedup-allergen' AND declaration = 'contains') AS allergens,
      (SELECT COUNT(*) FROM product_additives WHERE product_id = ? AND identifier = 'INS 999') AS additives,
      (SELECT COUNT(*) FROM nutrient_values WHERE product_id = ? AND nutrient_code = 'test-micronutrient') AS nutrients`)
      .bind(product.id, product.id, product.id).first<{ allergens: number; additives: number; nutrients: number }>();
    expect(retained).toEqual({ allergens: 2, additives: 2, nutrients: 2 });
  });

  it("validates bounded search and missing records", async () => {
    const combinedSearch = await worker.fetch("http://localhost/api/products?q=Atlas+Cocoa+Whey");
    expect(combinedSearch.status).toBe(200);
    const combinedCatalog = await json<CatalogResponse>(combinedSearch);
    expect(combinedCatalog.products).toHaveLength(1);
    expect(combinedCatalog.products[0]).toMatchObject({
      brand: "Atlas Test Foods",
      name: "High Protein Whey Blend",
      flavour: "Cocoa",
    });

    const invalid = await worker.fetch("http://localhost/api/products?pageSize=101");
    expect(invalid.status).toBe(400);
    expect(await json<{ error: { code: string } }>(invalid)).toMatchObject({ error: { code: "validation_error" } });

    const oversized = await worker.fetch(`http://localhost/api/products?q=${"term+".repeat(13)}`);
    expect(oversized.status).toBe(400);
    expect(await json<{ error: { message: string } }>(oversized)).toMatchObject({ error: { message: "Search query is too long" } });

    const missing = await worker.fetch("http://localhost/api/products/not-a-product");
    expect(missing.status).toBe(404);
    expect(await json<{ error: { code: string } }>(missing)).toMatchObject({ error: { code: "not_found" } });
  });

  it("resolves a local review once and preserves conflict semantics", async () => {
    const listResponse = await worker.fetch("http://localhost/api/reviews?status=open");
    expect(listResponse.status).toBe(200);
    const reviews = await json<ReviewResponse>(listResponse);
    const review = reviews.items.find((item) => item.type === "coverage_gap");
    expect(review).toBeDefined();
    if (!review) throw new Error("Expected an open review fixture");

    const unsupportedVerification = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "No evidence supplied" }),
    });
    expect(unsupportedVerification.status).toBe(400);
    expect(await json<{ error: { code: string } }>(unsupportedVerification)).toMatchObject({ error: { code: "validation_error" } });

    const resolve = () => worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "Synthetic integration-test decision", evidenceUrl: "https://example.invalid/label-proof" }),
    });
    const resolved = await resolve();
    expect(resolved.status).toBe(200);
    expect(await json<{ status: string }>(resolved)).toMatchObject({ status: "resolved" });

    const conflict = await resolve();
    expect(conflict.status).toBe(409);
    expect(await json<{ error: { code: string } }>(conflict)).toMatchObject({ error: { code: "conflict" } });

    const resolvedList = await worker.fetch("http://localhost/api/reviews?status=resolved");
    const resolvedReviews = await json<ReviewResponse>(resolvedList);
    expect(resolvedReviews.items[0]).toMatchObject({
      id: review.id,
      decision: "verify_nutrition",
      decisionEvidenceUrl: "https://example.invalid/label-proof",
      decidedBy: "local_operator",
    });
  });

  it("applies the exact reviewed Robotoff candidate and records its evidence atomically", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const nutrition = {
      calories: 400,
      proteinGrams: 40,
      carbohydrateGrams: 30,
      sugarGrams: 5,
      fatGrams: 10,
      saturatedFatGrams: 3,
      fibreGrams: 4,
      sodiumMg: 250,
    };
    const review = await insertRobotoffReview({ suffix: "verify", evidence: robotoffEvidence(product.gtin, nutrition) });
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_nutrition",
        rationale: "Reviewed against the current package label",
        evidenceUrl: "https://images.openfoodfacts.org/images/products/label.jpg",
      }),
    });
    expect(response.status).toBe(200);
    const fact = await env.DB.prepare(`SELECT source_record_id, status, confidence, authority, basis,
      preparation_state, calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams,
      saturated_fat_grams, fibre_grams, sodium_mg, label_verified_at, observed_at
      FROM nutrition_facts WHERE product_id = ?`).bind(review.productId).first<Record<string, unknown>>();
    expect(fact).toMatchObject({
      source_record_id: review.sourceRecordId,
      status: "verified",
      confidence: "high",
      authority: 100,
      basis: "per_100g",
      preparation_state: "as_sold",
      calories: 400,
      protein_grams: 40,
      carbohydrate_grams: 30,
      sugar_grams: 5,
      fat_grams: 10,
      saturated_fat_grams: 3,
      fibre_grams: 4,
      sodium_mg: 250,
      observed_at: "2026-07-14T00:00:00.000Z",
    });
    expect(fact?.label_verified_at).toEqual(expect.any(String));
    const outcome = await env.DB.prepare("SELECT outcome, source_record_id, evidence_url, decided_by FROM evidence_outcomes WHERE product_id = ? AND field_family = 'nutrition'")
      .bind(review.productId).first<Record<string, unknown>>();
    expect(outcome).toEqual({
      outcome: "verified",
      source_record_id: review.sourceRecordId,
      evidence_url: "https://images.openfoodfacts.org/images/products/label.jpg",
      decided_by: "local_operator",
    });
    const selected = await env.DB.prepare("SELECT COUNT(*) AS count FROM field_observations WHERE product_id = ? AND field_path LIKE 'nutrition.%' AND selected = 1")
      .bind(review.productId).first<{ count: number }>();
    expect(selected?.count).toBe(8);
    const decision = await env.DB.prepare(`SELECT source_record_id, source_content_hash, product_id,
      candidate_hash, field_family, decision, payload_json, evidence_url, rationale, decided_by, active
      FROM evidence_decisions WHERE id = ?`).bind(`evd_${review.reviewId}`).first<Record<string, unknown>>();
    expect(decision).toMatchObject({
      source_record_id: review.sourceRecordId,
      source_content_hash: "hash_verify",
      product_id: review.productId,
      field_family: "nutrition",
      decision: "verify",
      evidence_url: "https://images.openfoodfacts.org/images/products/label.jpg",
      rationale: "Reviewed against the current package label",
      decided_by: "local_operator",
      active: 1,
    });
    expect(decision?.candidate_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(String(decision?.payload_json))).toMatchObject({ nutritionPer100g: nutrition });
    const history = await json<ReviewResponse>(await worker.fetch(
      `http://localhost/api/reviews?status=resolved&id=${review.reviewId}`,
    ));
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).not.toHaveProperty("reviewedProjection");
    expect(history.items[0]).not.toHaveProperty("nutritionChanges");
  });

  it("publishes a corrected reviewed projection while preserving the immutable model candidate", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const originalNutrition = {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    };
    const evidence = robotoffEvidence(product.gtin, originalNutrition);
    const candidate = nutritionCandidateFromEvidence(evidence, product.gtin);
    if (!candidate) throw new Error("Expected a valid model candidate");
    const reviewedProjection = {
      basis: "per_100ml",
      nutritionPer100ml: {
        calories: 64, proteinGrams: 12, carbohydrateGrams: 2, sugarGrams: null,
        fatGrams: 0.8, saturatedFatGrams: 0.2, fibreGrams: null, sodiumMg: 35,
      },
    };
    const review = await insertRobotoffReview({ suffix: "corrected", evidence });
    const priorSource = await env.DB.prepare("SELECT id FROM source_records WHERE product_id = ? AND id <> ? ORDER BY id LIMIT 1")
      .bind(review.productId, review.sourceRecordId).first<{ id: string }>();
    if (!priorSource) throw new Error("Expected a prior product source");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO nutrient_values
        (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at)
        VALUES ('nut_stale_corrected_sugar', ?, ?, 'sugarGrams', 99, 'g', 'per_serving', 'as_sold', 'verified', '2026-07-01T00:00:00.000Z')`)
        .bind(review.productId, priorSource.id),
      env.DB.prepare(`INSERT INTO nutrient_values
        (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at)
        VALUES ('nut_preserved_corrected_vitamin', ?, ?, 'vitamin-c', 12, 'mg', 'per_serving', 'as_sold', 'verified', '2026-07-01T00:00:00.000Z')`)
        .bind(review.productId, priorSource.id),
    ]);
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_nutrition",
        rationale: "Transcribed from the exact current package label",
        evidenceUrl: candidate.imageUrl,
        reviewedProjection,
      }),
    });
    expect(response.status).toBe(200);

    const fact = await env.DB.prepare(`SELECT basis, calories, protein_grams, carbohydrate_grams,
      sugar_grams, fat_grams, saturated_fat_grams, fibre_grams, sodium_mg, observed_at
      FROM nutrition_facts WHERE product_id = ?`).bind(review.productId).first<Record<string, unknown>>();
    expect(fact).toEqual({
      basis: "per_100ml", calories: 64, protein_grams: 12, carbohydrate_grams: 2,
      sugar_grams: null, fat_grams: 0.8, saturated_fat_grams: 0.2, fibre_grams: null,
      sodium_mg: 35, observed_at: candidate.observedAt,
    });
    const persisted = await env.DB.prepare(`SELECT candidate_hash, payload_json FROM evidence_decisions
      WHERE id = ?`).bind(`evd_${review.reviewId}`).first<{ candidate_hash: string; payload_json: string }>();
    expect(persisted?.candidate_hash).toBe(await nutritionCandidateHash(candidate));
    expect(JSON.parse(persisted?.payload_json ?? "null")).toEqual({ candidate, reviewedProjection });
    const history = await json<ReviewResponse>(await worker.fetch(
      `http://localhost/api/reviews?status=resolved&id=${review.reviewId}`,
    ));
    expect(history.items).toHaveLength(1);
    expect(history.items[0]?.reviewedProjection).toEqual(reviewedProjection);
    expect(history.items[0]?.nutritionChanges).toHaveLength(8);
    expect(history.items[0]?.nutritionChanges).toContainEqual({
      field: "sodiumMg",
      originalValue: 250,
      reviewedValue: 35,
    });
    const detail = await json<ProductDetailResponse>(await worker.fetch(
      `http://localhost/api/products/${review.productId}`,
    ));
    expect(detail.nutrition).toMatchObject({
      basis: "per_100ml",
      calories: 64,
      proteinGrams: 12,
      carbohydrateGrams: 2,
      sugarGrams: null,
      fatGrams: 0.8,
      saturatedFatGrams: 0.2,
      fibreGrams: null,
      sodiumMg: 35,
    });
    expect(detail.metrics.proteinPer100Calories).toEqual({ value: 18.75, reason: null });
    expect(detail.metrics.proteinCaloriePercentage).toEqual({ value: 75, reason: null });
    const artifacts = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM nutrient_values WHERE product_id = ? AND source_record_id = ? AND basis = 'per_100ml') AS nutrients,
      (SELECT COUNT(*) FROM nutrient_values WHERE product_id = ? AND nutrient_code = 'sugarGrams') AS stale_core,
      (SELECT COUNT(*) FROM nutrient_values WHERE product_id = ? AND nutrient_code = 'vitamin-c') AS micronutrients,
      (SELECT COUNT(*) FROM field_observations WHERE product_id = ? AND selected = 1 AND field_path LIKE 'nutrition.%') AS observations,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE product_id = ? AND field_family = 'nutrition' AND observed_at = ?) AS outcomes,
      (SELECT COUNT(*) FROM review_items WHERE id = ? AND status = 'resolved') AS resolved`)
      .bind(review.productId, review.sourceRecordId, review.productId, review.productId,
        review.productId, review.productId, candidate.observedAt, review.reviewId)
      .first<{ nutrients: number; stale_core: number; micronutrients: number; observations: number; outcomes: number; resolved: number }>();
    expect(artifacts).toEqual({
      nutrients: 6, stale_core: 0, micronutrients: 1, observations: 6, outcomes: 1, resolved: 1,
    });

    await env.DB.prepare("UPDATE evidence_decisions SET active = 0 WHERE id = ?")
      .bind(`evd_${review.reviewId}`).run();
    const inactiveHistory = await json<ReviewResponse>(await worker.fetch(
      `http://localhost/api/reviews?status=resolved&id=${review.reviewId}`,
    ));
    expect(inactiveHistory.items[0]).not.toHaveProperty("reviewedProjection");
    expect(inactiveHistory.items[0]).not.toHaveProperty("nutritionChanges");
  });

  it("rejects malformed reviewed nutrition atomically and rejects corrections on non-verify decisions", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const evidence = robotoffEvidence(product.gtin, {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    });
    const candidate = nutritionCandidateFromEvidence(evidence, product.gtin);
    if (!candidate) throw new Error("Expected a valid model candidate");
    const malformed = { basis: "per_100g", nutritionPer100g: { calories: 380, proteinGrams: 42 } };
    const review = await insertRobotoffReview({ suffix: "malformed-correction", evidence });
    for (const body of [
      { decision: "verify_nutrition", rationale: "Incomplete transcription", evidenceUrl: candidate.imageUrl, reviewedProjection: malformed },
      { decision: "reject_nutrition", rationale: "Correction cannot accompany rejection", reviewedProjection: malformed },
    ]) {
      const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const durable = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE id = ?) AS decisions,
      (SELECT COUNT(*) FROM nutrition_facts WHERE source_record_id = ?) AS facts,
      (SELECT COUNT(*) FROM review_items WHERE id = ? AND status = 'open') AS open`)
      .bind(`evd_${review.reviewId}`, review.sourceRecordId, review.reviewId)
      .first<{ decisions: number; facts: number; open: number }>();
    expect(durable).toEqual({ decisions: 0, facts: 0, open: 1 });
  });

  it("fails before every write when source evidence drifts between review read and decision batch", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const evidence = robotoffEvidence(product.gtin, {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    });
    const candidate = nutritionCandidateFromEvidence(evidence, product.gtin);
    if (!candidate) throw new Error("Expected a valid model candidate");
    const review = await insertRobotoffReview({ suffix: "transaction-race", evidence });
    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await target.prepare("UPDATE source_records SET content_hash = ? WHERE id = ?")
                .bind("hash_changed_between_read_and_batch", review.sourceRecordId).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const result = await resolveReview(
      racingDb,
      review.reviewId,
      "verify_nutrition",
      "Exact current label transcription",
      candidate.imageUrl,
      null,
      null,
      {
        basis: "per_100g",
        nutritionPer100g: {
          calories: 390, proteinGrams: 41, carbohydrateGrams: 28, sugarGrams: 4,
          fatGrams: 9, saturatedFatGrams: 2.5, fibreGrams: 5, sodiumMg: 225,
        },
      },
    );

    expect(result).toBe("invalid_candidate");
    expect(raced).toBe(true);
    const durable = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE id = ?) AS decisions,
      (SELECT COUNT(*) FROM nutrition_facts WHERE source_record_id = ?) AS facts,
      (SELECT COUNT(*) FROM nutrient_values WHERE source_record_id = ?) AS nutrients,
      (SELECT COUNT(*) FROM field_observations WHERE source_record_id = ? AND selected = 1) AS observations,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE source_record_id = ?) AS outcomes,
      (SELECT COUNT(*) FROM review_items WHERE id = ? AND status = 'open') AS open`)
      .bind(`evd_${review.reviewId}`, review.sourceRecordId, review.sourceRecordId,
        review.sourceRecordId, review.sourceRecordId, review.reviewId)
      .first<Record<string, number>>();
    expect(durable).toEqual({ decisions: 0, facts: 0, nutrients: 0, observations: 0, outcomes: 0, open: 1 });
  });

  it("records exact duplicate nutrition as redundant without mutating selected facts or verified coverage", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const nutrition = {
      calories: 400,
      proteinGrams: 40,
      carbohydrateGrams: 30,
      sugarGrams: 5,
      fatGrams: 10,
      saturatedFatGrams: 3,
      fibreGrams: 4,
      sodiumMg: 250,
    };
    const review = await insertRobotoffReview({ suffix: "redundant", evidence: robotoffEvidence(product.gtin, nutrition) });
    await env.DB.prepare(`UPDATE nutrition_facts SET status = 'verified', confidence = 'high', authority = 100,
      basis = 'per_100g', calories = ?, protein_grams = ?, carbohydrate_grams = ?, sugar_grams = ?,
      fat_grams = ?, saturated_fat_grams = ?, fibre_grams = ?, sodium_mg = ? WHERE product_id = ?`)
      .bind(
        nutrition.calories, nutrition.proteinGrams, nutrition.carbohydrateGrams, nutrition.sugarGrams,
        nutrition.fatGrams, nutrition.saturatedFatGrams, nutrition.fibreGrams, nutrition.sodiumMg,
        review.productId,
      ).run();

    const evidenceState = async () => {
      const [fact, nutrients, observations, outcomes] = await env.DB.batch([
        env.DB.prepare("SELECT * FROM nutrition_facts WHERE product_id = ?").bind(review.productId),
        env.DB.prepare("SELECT * FROM nutrient_values WHERE product_id = ? ORDER BY id").bind(review.productId),
        env.DB.prepare("SELECT * FROM field_observations WHERE product_id = ? ORDER BY id").bind(review.productId),
        env.DB.prepare("SELECT * FROM evidence_outcomes WHERE product_id = ? ORDER BY field_family").bind(review.productId),
      ]);
      return canonicalJson({
        fact: fact?.results ?? [],
        nutrients: nutrients?.results ?? [],
        observations: observations?.results ?? [],
        outcomes: outcomes?.results ?? [],
      });
    };

    const openResponse = await worker.fetch("http://localhost/api/reviews?status=open&type=nutrition_validation");
    const open = await json<ReviewResponse>(openResponse);
    expect(open.items.find(({ id }) => id === review.reviewId)).toMatchObject({
      redundantEligible: true,
      selectedProjection: {
        productId: review.productId,
        status: "verified",
        authority: 100,
        basis: "per_100g",
        nutrition,
      },
    });
    const beforeState = await evidenceState();
    const beforeCoverage = await json<CoverageResponse>(await worker.fetch("http://localhost/api/coverage"));
    const overriddenEvidence = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "redundant_nutrition",
        rationale: "Attempted with caller-supplied evidence",
        evidenceUrl: "https://example.invalid/not-the-bound-image.jpg",
      }),
    });
    expect(overriddenEvidence.status).toBe(400);
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "redundant_nutrition",
        rationale: "Exact duplicate of the currently selected verified projection",
      }),
    });
    expect(response.status).toBe(200);
    expect(await evidenceState()).toBe(beforeState);
    const afterCoverage = await json<CoverageResponse>(await worker.fetch("http://localhost/api/coverage"));
    expect(afterCoverage.catalog.verifiedNutrition).toBe(beforeCoverage.catalog.verifiedNutrition);
    expect(afterCoverage.catalog.structuredNutrition).toBe(beforeCoverage.catalog.structuredNutrition);

    const decision = await env.DB.prepare(`SELECT source_record_id, source_content_hash, product_id,
      field_family, decision, evidence_url, rationale, decided_by, active
      FROM evidence_decisions WHERE id = ?`).bind(`evd_${review.reviewId}`).first<Record<string, unknown>>();
    expect(decision).toMatchObject({
      source_record_id: review.sourceRecordId,
      source_content_hash: "hash_redundant",
      product_id: review.productId,
      field_family: "nutrition",
      decision: "redundant",
      evidence_url: "https://images.openfoodfacts.org/images/products/label.jpg",
      rationale: "Exact duplicate of the currently selected verified projection",
      decided_by: "local_operator",
      active: 1,
    });
    const history = await json<ReviewResponse>(await worker.fetch("http://localhost/api/reviews?status=resolved&type=nutrition_validation"));
    expect(history.items.find(({ id }) => id === review.reviewId)).toMatchObject({
      decision: "redundant_nutrition",
      redundantEligible: false,
      redundantProjectionMatches: true,
      decisionEvidenceUrl: "https://images.openfoodfacts.org/images/products/label.jpg",
      decidedBy: "local_operator",
      selectedProjection: { nutrition },
    });
  });

  it("rejects a stale redundant action when the selected projection drifts before the atomic write", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const nutrition = {
      calories: 400,
      proteinGrams: 40,
      carbohydrateGrams: 30,
      sugarGrams: 5,
      fatGrams: 10,
      saturatedFatGrams: 3,
      fibreGrams: 4,
      sodiumMg: 250,
    };
    const review = await insertRobotoffReview({ suffix: "redundant-drift", evidence: robotoffEvidence(product.gtin, nutrition) });
    await env.DB.prepare(`UPDATE nutrition_facts SET status = 'verified', authority = 100, basis = 'per_100g',
      calories = ?, protein_grams = ?, carbohydrate_grams = ?, sugar_grams = ?, fat_grams = ?,
      saturated_fat_grams = ?, fibre_grams = ?, sodium_mg = ? WHERE product_id = ?`)
      .bind(
        nutrition.calories, nutrition.proteinGrams, nutrition.carbohydrateGrams, nutrition.sugarGrams,
        nutrition.fatGrams, nutrition.saturatedFatGrams, nutrition.fibreGrams, nutrition.sodiumMg,
        review.productId,
      ).run();
    const eligible = await json<ReviewResponse>(await worker.fetch("http://localhost/api/reviews?status=open&type=nutrition_validation"));
    expect(eligible.items.find(({ id }) => id === review.reviewId)?.redundantEligible).toBe(true);

    await env.DB.prepare("UPDATE nutrition_facts SET sugar_grams = 6 WHERE product_id = ?").bind(review.productId).run();
    const before = await env.DB.batch([
      env.DB.prepare("SELECT * FROM nutrition_facts WHERE product_id = ?").bind(review.productId),
      env.DB.prepare("SELECT * FROM nutrient_values WHERE product_id = ? ORDER BY id").bind(review.productId),
      env.DB.prepare("SELECT * FROM field_observations WHERE product_id = ? ORDER BY id").bind(review.productId),
      env.DB.prepare("SELECT * FROM evidence_outcomes WHERE product_id = ? ORDER BY field_family").bind(review.productId),
    ]);
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "redundant_nutrition",
        rationale: "Attempt after selected nutrition changed",
      }),
    });
    expect(response.status).toBe(400);
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({ error: { code: "validation_error" } });
    const after = await env.DB.batch([
      env.DB.prepare("SELECT * FROM nutrition_facts WHERE product_id = ?").bind(review.productId),
      env.DB.prepare("SELECT * FROM nutrient_values WHERE product_id = ? ORDER BY id").bind(review.productId),
      env.DB.prepare("SELECT * FROM field_observations WHERE product_id = ? ORDER BY id").bind(review.productId),
      env.DB.prepare("SELECT * FROM evidence_outcomes WHERE product_id = ? ORDER BY field_family").bind(review.productId),
    ]);
    expect(canonicalJson(after.map(({ results }) => results))).toBe(canonicalJson(before.map(({ results }) => results)));
    expect(await env.DB.prepare("SELECT status, decision FROM review_items WHERE id = ?").bind(review.reviewId).first())
      .toEqual({ status: "open", decision: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM evidence_decisions WHERE id = ?")
      .bind(`evd_${review.reviewId}`).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("applies exact volume nutrition with per-100-mL facts and basis-safe metrics", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const nutrition = {
      calories: 901,
      proteinGrams: 10,
      carbohydrateGrams: null,
      sugarGrams: null,
      fatGrams: null,
      saturatedFatGrams: null,
      fibreGrams: null,
      sodiumMg: null,
    };
    const review = await insertRobotoffReview({ suffix: "verify-volume", evidence: robotoffVolumeEvidence(product.gtin, nutrition) });
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_nutrition",
        rationale: "Reviewed against exact per-100-mL package label",
        evidenceUrl: "https://images.openfoodfacts.org/images/products/volume-label.jpg",
      }),
    });
    expect(response.status).toBe(200);
    const fact = await env.DB.prepare("SELECT basis, status, authority, calories, protein_grams FROM nutrition_facts WHERE product_id = ?")
      .bind(review.productId).first<Record<string, unknown>>();
    expect(fact).toEqual({ basis: "per_100ml", status: "verified", authority: 100, calories: 901, protein_grams: 10 });
    const nutrients = await env.DB.prepare("SELECT DISTINCT basis FROM nutrient_values WHERE product_id = ? AND status = 'verified'")
      .bind(review.productId).all<{ basis: string }>();
    expect(nutrients.results).toContainEqual({ basis: "per_100ml" });
    const decision = await env.DB.prepare("SELECT payload_json FROM evidence_decisions WHERE id = ?")
      .bind(`evd_${review.reviewId}`).first<{ payload_json: string }>();
    expect(JSON.parse(decision?.payload_json ?? "null")).toMatchObject({ nutritionPer100ml: nutrition });

    const detailResponse = await worker.fetch(`http://localhost/api/products/${review.productId}`);
    const detail = await json<ProductDetailResponse>(detailResponse);
    expect(detail.nutrition.basis).toBe("per_100ml");
    expect(detail.metrics.proteinPer100Calories).toEqual({ value: expect.closeTo(1.11, 2), reason: null });
    expect(detail.metrics.proteinCaloriePercentage).toEqual({ value: expect.closeTo(4.44, 2), reason: null });
  });

  it("rejects price sorting from the macro-first consumer API", async () => {
    const response = await worker.fetch("http://localhost/api/products?sort=cost&pageSize=100");
    expect(response.status).toBe(400);
  });

  it("rejects a Robotoff candidate without clearing independently sourced nutrition", async () => {
    const product = await env.DB.prepare(`SELECT p.gtin, nf.calories, nf.protein_grams
      FROM products p JOIN nutrition_facts nf ON nf.product_id = p.id
      WHERE p.is_active = 1 AND p.gtin IS NOT NULL ORDER BY p.id LIMIT 1`)
      .first<{ gtin: string; calories: number; protein_grams: number }>();
    if (!product) throw new Error("Expected seeded nutrition");
    const review = await insertRobotoffReview({ suffix: "reject", evidence: robotoffEvidence(product.gtin, {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    }) });
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject_nutrition", rationale: "Label values do not match the current pack" }),
    });
    expect(response.status).toBe(200);
    const unchanged = await env.DB.prepare("SELECT calories, protein_grams FROM nutrition_facts WHERE product_id = ?")
      .bind(review.productId).first<{ calories: number; protein_grams: number }>();
    expect(unchanged).toEqual({ calories: product.calories, protein_grams: product.protein_grams });
    const decision = await env.DB.prepare("SELECT decision, evidence_url, active FROM evidence_decisions WHERE id = ?")
      .bind(`evd_${review.reviewId}`).first<{ decision: string; evidence_url: string; active: number }>();
    expect(decision).toEqual({
      decision: "reject",
      evidence_url: "https://images.openfoodfacts.org/images/products/label.jpg",
      active: 1,
    });
  });

  it("applies reviewer-confirmed ingredient text and normalized provenance atomically", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const fixture = robotoffIngredientEvidence(product.gtin, "verify");
    const review = await insertIngredientReview({ suffix: "verify", evidence: fixture.evidence });
    const reviewedText = "Whey blend 70% (concentrate, isolate), cocoa 8%, natural flavour";
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_ingredients",
        rationale: "Corrected the visible OCR wording against the current package label",
        evidenceUrl: fixture.candidate.imageUrl,
        reviewedText,
      }),
    });
    expect(response.status).toBe(200);
    const statement = await env.DB.prepare(`SELECT source_record_id, raw_text, language, status,
      confidence, authority, observed_at FROM ingredient_statements WHERE product_id = ?`)
      .bind(review.productId).first<Record<string, unknown>>();
    expect(statement).toEqual({
      source_record_id: review.sourceRecordId,
      raw_text: reviewedText,
      language: "en",
      status: "verified",
      confidence: "high",
      authority: 100,
      observed_at: fixture.candidate.observedAt,
    });
    const normalized = await env.DB.prepare(`SELECT parent_id, position, raw_text, normalized_name,
      percentage, resolved FROM product_ingredients WHERE product_id = ? AND source_record_id = ?
      ORDER BY parent_id, position`)
      .bind(review.productId, review.sourceRecordId).all<Record<string, unknown>>();
    expect(normalized.results).toHaveLength(5);
    expect(normalized.results).toContainEqual(expect.objectContaining({
      position: 0,
      raw_text: "Whey blend 70% (concentrate, isolate)",
      normalized_name: "whey blend",
      percentage: 70,
      resolved: 1,
    }));
    const observation = await env.DB.prepare(`SELECT raw_value_json, normalized_value_json,
      confidence, authority, evidence_url, selected FROM field_observations
      WHERE product_id = ? AND field_path = 'ingredients.raw' AND selected = 1`)
      .bind(review.productId).first<Record<string, unknown>>();
    expect(observation).toMatchObject({
      raw_value_json: JSON.stringify(reviewedText),
      confidence: "high",
      authority: 100,
      evidence_url: fixture.candidate.imageUrl,
      selected: 1,
    });
    expect(JSON.parse(String(observation?.normalized_value_json))).toHaveLength(3);
    const outcome = await env.DB.prepare(`SELECT outcome, source_record_id, evidence_url, decided_by
      FROM evidence_outcomes WHERE product_id = ? AND field_family = 'ingredients'`)
      .bind(review.productId).first<Record<string, unknown>>();
    expect(outcome).toEqual({
      outcome: "verified",
      source_record_id: review.sourceRecordId,
      evidence_url: fixture.candidate.imageUrl,
      decided_by: "local_operator",
    });
    const decision = await env.DB.prepare(`SELECT field_family, decision, payload_json, evidence_url, active
      FROM evidence_decisions WHERE id = ?`).bind(`evd_${review.reviewId}`).first<Record<string, unknown>>();
    expect(decision).toMatchObject({
      field_family: "ingredients",
      decision: "verify",
      evidence_url: fixture.candidate.imageUrl,
      active: 1,
    });
    expect(JSON.parse(String(decision?.payload_json))).toMatchObject({
      candidate: { entityText: fixture.candidate.entityText },
      reviewedText,
    });
  });

  it("fails closed on incomplete, insecure, oversized, or mismatched ingredient evidence", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const fixture = robotoffIngredientEvidence(product.gtin, "strict");
    const review = await insertIngredientReview({ suffix: "strict", evidence: fixture.evidence });
    const request = (body: Record<string, unknown>) => worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_ingredients",
        rationale: "Reviewed against the current package label",
        reviewedText: fixture.candidate.entityText,
        ...body,
      }),
    });
    expect((await request({})).status).toBe(400);
    expect((await request({ evidenceUrl: "http://images.openfoodfacts.org/insecure.jpg" })).status).toBe(400);
    expect((await request({ evidenceUrl: fixture.candidate.imageUrl, reviewedText: "x".repeat(25_001) })).status).toBe(400);
    expect((await request({ evidenceUrl: "https://images.openfoodfacts.org/images/products/different.jpg" })).status).toBe(400);
    const stillOpen = await env.DB.prepare("SELECT status FROM review_items WHERE id = ?")
      .bind(review.reviewId).first<{ status: string }>();
    expect(stillOpen?.status).toBe("open");
    const durable = await env.DB.prepare("SELECT COUNT(*) AS count FROM evidence_decisions WHERE id = ?")
      .bind(`evd_${review.reviewId}`).first<{ count: number }>();
    expect(durable?.count).toBe(0);
  });

  it("allows only one concurrent decision for the exact ingredient candidate", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const fixture = robotoffIngredientEvidence(product.gtin, "concurrent");
    const review = await insertIngredientReview({ suffix: "concurrent", evidence: fixture.evidence });
    const resolve = () => worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_ingredients",
        rationale: "Concurrent verification against the current package label",
        evidenceUrl: fixture.candidate.imageUrl,
        reviewedText: fixture.candidate.entityText,
      }),
    });
    const responses = await Promise.all([resolve(), resolve()]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const state = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE id = ?) AS decisions,
      (SELECT COUNT(*) FROM ingredient_statements WHERE product_id = ? AND source_record_id = ? AND status = 'verified') AS verified,
      (SELECT COUNT(*) FROM review_items WHERE id = ? AND status = 'resolved') AS resolved`)
      .bind(`evd_${review.reviewId}`, review.productId, review.sourceRecordId, review.reviewId)
      .first<{ decisions: number; verified: number; resolved: number }>();
    expect(state).toEqual({ decisions: 1, verified: 1, resolved: 1 });
  });

  it("rejects only the exact ingredient candidate and preserves community ingredients", async () => {
    const product = await env.DB.prepare(`SELECT p.gtin, i.source_record_id, i.raw_text, i.status, i.authority,
      eo.outcome AS prior_outcome, eo.source_record_id AS prior_outcome_source
      FROM products p JOIN ingredient_statements i ON i.product_id = p.id
      LEFT JOIN evidence_outcomes eo ON eo.product_id = p.id AND eo.field_family = 'ingredients'
      WHERE p.is_active = 1 AND p.gtin IS NOT NULL ORDER BY p.id LIMIT 1`)
      .first<{
        gtin: string;
        source_record_id: string;
        raw_text: string;
        status: string;
        authority: number;
        prior_outcome: string | null;
        prior_outcome_source: string | null;
      }>();
    if (!product) throw new Error("Expected seeded ingredients");
    const fixture = robotoffIngredientEvidence(product.gtin, "reject");
    const review = await insertIngredientReview({ suffix: "reject", evidence: fixture.evidence });
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "reject_ingredients",
        rationale: "Image belongs to an older package variant",
      }),
    });
    expect(response.status).toBe(200);
    const unchanged = await env.DB.prepare(`SELECT source_record_id, raw_text, status, authority
      FROM ingredient_statements WHERE product_id = ?`).bind(review.productId).first<Record<string, unknown>>();
    expect(unchanged).toEqual({
      source_record_id: product.source_record_id,
      raw_text: product.raw_text,
      status: product.status,
      authority: product.authority,
    });
    const decision = await env.DB.prepare(`SELECT field_family, decision, payload_json, evidence_url
      FROM evidence_decisions WHERE id = ?`).bind(`evd_${review.reviewId}`).first<Record<string, unknown>>();
    expect(decision).toMatchObject({
      field_family: "ingredients",
      decision: "reject",
      evidence_url: fixture.candidate.imageUrl,
    });
    expect(JSON.parse(String(decision?.payload_json))).toMatchObject({ reviewedText: null });
    const outcome = await env.DB.prepare(`SELECT outcome, source_record_id FROM evidence_outcomes
      WHERE product_id = ? AND field_family = 'ingredients'`).bind(review.productId).first();
    expect(outcome).toEqual(product.prior_outcome === null ? null : {
      outcome: product.prior_outcome,
      source_record_id: product.prior_outcome_source,
    });
  });

  it("fails atomically when an evidence decision id conflicts", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const evidence = robotoffEvidence(product.gtin, {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    });
    const review = await insertRobotoffReview({ suffix: "decision-id-conflict", evidence });
    await env.DB.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      SELECT ?, source_id, source_record_id, id, content_hash, product_id,
        ?, 'nutrition', 'reject', '{}', ?, ?, 'test_operator', ?, 1
      FROM source_records WHERE id = ?`)
      .bind(`evd_${review.reviewId}`, "0".repeat(64), "https://example.invalid/old-label", "Conflicting historical decision", "2026-07-14T00:00:00.000Z", review.sourceRecordId)
      .run();
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "Current label review", evidenceUrl: "https://images.openfoodfacts.org/images/products/label.jpg" }),
    });
    expect(response.status).toBe(409);
    const row = await env.DB.prepare("SELECT status FROM review_items WHERE id = ?").bind(review.reviewId).first<{ status: string }>();
    expect(row?.status).toBe("open");
  });

  it("refuses to reuse a matching candidate decision after source-content drift", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const evidence = robotoffEvidence(product.gtin, {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    });
    const candidate = nutritionCandidateFromEvidence(evidence, product.gtin);
    if (!candidate) throw new Error("Expected valid candidate evidence");
    const candidateHash = await nutritionCandidateHash(candidate);
    const review = await insertRobotoffReview({ suffix: "source-drift", evidence });
    await env.DB.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      SELECT 'evd_old_source', source_id, source_record_id, id, 'superseded_source_hash', product_id,
        ?, 'nutrition', 'verify', ?, ?, ?, 'test_operator', ?, 1
      FROM source_records WHERE id = ?`)
      .bind(candidateHash, canonicalJson(candidate), candidate.imageUrl, "Reviewed before source changed", "2026-07-14T00:00:00.000Z", review.sourceRecordId)
      .run();
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "Review after source changed", evidenceUrl: candidate.imageUrl }),
    });
    expect(response.status).toBe(409);
    const durable = await env.DB.prepare("SELECT source_content_hash FROM evidence_decisions WHERE id = 'evd_old_source'")
      .first<{ source_content_hash: string }>();
    expect(durable?.source_content_hash).toBe("superseded_source_hash");
    const current = await env.DB.prepare("SELECT COUNT(*) AS count FROM evidence_decisions WHERE id = ?")
      .bind(`evd_${review.reviewId}`).first<{ count: number }>();
    expect(current?.count).toBe(0);
  });

  it("appends a new source-bound decision when reconciliation reopens a review with an inactive legacy decision", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const evidence = robotoffEvidence(product.gtin, {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    });
    const candidate = nutritionCandidateFromEvidence(evidence, product.gtin);
    if (!candidate) throw new Error("Expected valid candidate evidence");
    const review = await insertRobotoffReview({ suffix: "reopened-inactive", evidence });
    const decide = (rationale: string) => worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject_nutrition", rationale }),
    });
    expect((await decide("Initial exact-image rejection")).status).toBe(200);
    const baseDecisionId = `evd_${review.reviewId}`;

    await env.DB.batch([
      env.DB.prepare("UPDATE evidence_decisions SET active = 0 WHERE id = ?").bind(baseDecisionId),
      env.DB.prepare("UPDATE source_records SET content_hash = ? WHERE id = ?").bind("reconciled_source_content_hash", review.sourceRecordId),
      env.DB.prepare(`UPDATE review_items SET status = 'open', decision = NULL, decision_rationale = NULL,
        decision_evidence_url = NULL, decided_by = NULL, resolved_at = NULL WHERE id = ?`).bind(review.reviewId),
    ]);

    const response = await decide("Re-reviewed after exact source reconciliation");
    expect(response.status).toBe(200);
    const decisions = await env.DB.prepare(`SELECT id, source_content_hash, candidate_hash, decision, active
      FROM evidence_decisions WHERE source_record_id = ? ORDER BY decided_at, id`)
      .bind(review.sourceRecordId).all<{
        id: string;
        source_content_hash: string;
        candidate_hash: string;
        decision: string;
        active: number;
      }>();
    expect(decisions.results).toHaveLength(2);
    expect(decisions.results[0]).toMatchObject({ id: baseDecisionId, active: 0 });
    expect(decisions.results[1]).toMatchObject({
      source_content_hash: "reconciled_source_content_hash",
      candidate_hash: await nutritionCandidateHash(candidate),
      decision: "reject",
      active: 1,
    });
    expect(decisions.results[1]?.id).toMatch(new RegExp(`^${baseDecisionId}_[a-f0-9]{16}$`));
    expect(decisions.results.filter(({ active }) => active === 1)).toHaveLength(1);
  });

  it("replays unchanged verify/reject decisions and reopens changed candidate evidence", async () => {
    await applyQueries(env.TEST_ROBOTOFF_REPLAY_QUERIES);
    const reviews = await env.DB.prepare(`SELECT r.id, s.source_record_id
      FROM review_items r JOIN source_records s ON s.id = r.source_record_id
      WHERE s.source_id = 'open_food_facts_robotoff' AND s.source_record_id IN ('8900000000012:901', '8900000000012:902')
      AND r.status = 'open' ORDER BY s.source_record_id`).all<{ id: string; source_record_id: string }>();
    expect(reviews.results).toHaveLength(2);
    const verifyReview = reviews.results.find(({ source_record_id }) => source_record_id.endsWith(":901"));
    const rejectReview = reviews.results.find(({ source_record_id }) => source_record_id.endsWith(":902"));
    if (!verifyReview || !rejectReview) throw new Error("Expected both replay candidate reviews");
    const verifyResponse = await worker.fetch(`http://localhost/api/reviews/${verifyReview.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_nutrition",
        rationale: "Synthetic current-label replay verification",
        evidenceUrl: "https://images.openfoodfacts.org/images/products/890/000/000/0012/901.jpg",
        reviewedProjection: {
          basis: "per_100g",
          nutritionPer100g: {
            calories: 370, proteinGrams: 26, carbohydrateGrams: 45, sugarGrams: null,
            fatGrams: 9, saturatedFatGrams: 2, fibreGrams: 6, sodiumMg: 260,
          },
        },
      }),
    });
    expect(verifyResponse.status).toBe(200);
    const rejectResponse = await worker.fetch(`http://localhost/api/reviews/${rejectReview.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject_nutrition", rationale: "Synthetic candidate rejection" }),
    });
    expect(rejectResponse.status).toBe(200);

    const source = await env.DB.prepare("SELECT product_id FROM source_records WHERE source_record_id = '8900000000012:901'")
      .first<{ product_id: string }>();
    if (!source?.product_id) throw new Error("Expected replay source product");
    const replaySource = await env.DB.prepare("SELECT id FROM source_records WHERE source_record_id = '8900000000012:901'")
      .first<{ id: string }>();
    if (!replaySource) throw new Error("Expected replay source record");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM nutrition_facts WHERE product_id = ?").bind(source.product_id),
      env.DB.prepare("DELETE FROM nutrient_values WHERE product_id = ? AND source_record_id IN (SELECT id FROM source_records WHERE source_id = 'open_food_facts_robotoff')").bind(source.product_id),
      env.DB.prepare("DELETE FROM field_observations WHERE product_id = ? AND field_path LIKE 'nutrition.%'").bind(source.product_id),
      env.DB.prepare("DELETE FROM evidence_outcomes WHERE product_id = ? AND field_family = 'nutrition'").bind(source.product_id),
    ]);
    await env.DB.prepare(`INSERT INTO nutrient_values
      (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at)
      VALUES ('nut_replay_preserved_micronutrient', ?, ?, 'vitamin-c-review-replay', 12, 'mg', 'per_100g',
        'as_sold', 'verified', '2026-07-01T00:00:00.000Z')`)
      .bind(source.product_id, replaySource.id).run();
    await applyQueries(env.TEST_ROBOTOFF_REPLAY_QUERIES);

    const reconstructed = await env.DB.prepare(`SELECT status, confidence, authority, calories, protein_grams,
      carbohydrate_grams, fat_grams, label_verified_at FROM nutrition_facts WHERE product_id = ?`)
      .bind(source.product_id).first<Record<string, unknown>>();
    expect(reconstructed).toMatchObject({
      status: "verified",
      confidence: "high",
      authority: 100,
      calories: 370,
      protein_grams: 26,
      carbohydrate_grams: 45,
      fat_grams: 9,
    });
    expect(reconstructed?.label_verified_at).toEqual(expect.any(String));
    const replayedNutrients = await env.DB.prepare(`SELECT nutrient_code, quantity, basis FROM nutrient_values
      WHERE product_id = ? AND nutrient_code IN ('calories', 'proteinGrams', 'carbohydrateGrams', 'sugarGrams',
        'fatGrams', 'saturatedFatGrams', 'fibreGrams', 'sodiumMg') ORDER BY nutrient_code`)
      .bind(source.product_id).all<{ nutrient_code: string; quantity: number; basis: string }>();
    expect(replayedNutrients.results).toEqual([
      { nutrient_code: "calories", quantity: 370, basis: "per_100g" },
      { nutrient_code: "carbohydrateGrams", quantity: 45, basis: "per_100g" },
      { nutrient_code: "fatGrams", quantity: 9, basis: "per_100g" },
      { nutrient_code: "fibreGrams", quantity: 6, basis: "per_100g" },
      { nutrient_code: "proteinGrams", quantity: 26, basis: "per_100g" },
      { nutrient_code: "saturatedFatGrams", quantity: 2, basis: "per_100g" },
      { nutrient_code: "sodiumMg", quantity: 260, basis: "per_100g" },
    ]);
    const preservedMicronutrient = await env.DB.prepare(`SELECT quantity FROM nutrient_values
      WHERE product_id = ? AND nutrient_code = 'vitamin-c-review-replay'`).bind(source.product_id)
      .first<{ quantity: number }>();
    expect(preservedMicronutrient?.quantity).toBe(12);
    const unresolved = await env.DB.prepare(`SELECT COUNT(*) AS count FROM review_items r
      JOIN source_records s ON s.id = r.source_record_id
      WHERE s.source_record_id IN ('8900000000012:901', '8900000000012:902') AND r.status = 'open'`)
      .first<{ count: number }>();
    expect(unresolved?.count).toBe(0);
    const decisions = await env.DB.prepare(`SELECT decision, COUNT(*) AS count FROM evidence_decisions
      WHERE source_record_key IN ('8900000000012:901', '8900000000012:902') GROUP BY decision ORDER BY decision`)
      .all<{ decision: string; count: number }>();
    expect(decisions.results).toEqual([{ decision: "reject", count: 1 }, { decision: "verify", count: 1 }]);

    await applyQueries(env.TEST_ROBOTOFF_DRIFT_QUERIES);
    const drifted = await env.DB.prepare(`SELECT r.status, r.evidence_json FROM review_items r
      JOIN source_records s ON s.id = r.source_record_id
      WHERE s.source_record_id = '8900000000012:901' AND r.status = 'open' ORDER BY r.created_at DESC LIMIT 1`)
      .first<{ status: string; evidence_json: string }>();
    expect(drifted?.status).toBe("open");
    const driftEvidence = JSON.parse(drifted?.evidence_json ?? "null") as { details?: { candidateHash?: string } };
    const oldHash = await env.DB.prepare("SELECT candidate_hash FROM evidence_decisions WHERE source_record_key = '8900000000012:901'")
      .first<{ candidate_hash: string }>();
    expect(driftEvidence.details?.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(driftEvidence.details?.candidateHash).not.toBe(oldHash?.candidate_hash);
    const staleFact = await env.DB.prepare("SELECT status, label_verified_at FROM nutrition_facts WHERE product_id = ?")
      .bind(source.product_id).first<{ status: string; label_verified_at: string | null }>();
    expect(staleFact).toEqual({ status: "conflict", label_verified_at: null });
    const staleClassification = await env.DB.prepare(`SELECT nutritionally_protein_dense, nutrition_reasons_json
      FROM products WHERE id = ?`).bind(source.product_id).first<Record<string, unknown>>();
    expect(staleClassification).toEqual({ nutritionally_protein_dense: null, nutrition_reasons_json: "[]" });
    const staleOutcome = await env.DB.prepare("SELECT COUNT(*) AS count FROM evidence_outcomes WHERE product_id = ? AND field_family = 'nutrition'")
      .bind(source.product_id).first<{ count: number }>();
    expect(staleOutcome?.count).toBe(0);
  });

  it("reconstructs unchanged ingredient decisions and invalidates drifted evidence", async () => {
    await applyQueries(env.TEST_INGREDIENT_REPLAY_QUERIES);
    const review = await env.DB.prepare(`SELECT r.id, r.evidence_json, r.source_record_id, r.product_id
      FROM review_items r JOIN source_records s ON s.id = r.source_record_id
      WHERE s.source_id = 'open_food_facts_robotoff_ingredients'
        AND s.source_record_id = '08900000000012:1901:0' AND r.status = 'open'`)
      .first<{ id: string; evidence_json: string; source_record_id: string; product_id: string }>();
    if (!review) throw new Error("Expected ingredient replay review");
    const evidence = JSON.parse(review.evidence_json) as { details?: { candidate?: { entityText?: string; imageUrl?: string } } };
    const reviewedText = evidence.details?.candidate?.entityText;
    const evidenceUrl = evidence.details?.candidate?.imageUrl;
    if (!reviewedText || !evidenceUrl) throw new Error("Expected complete ingredient replay evidence");
    const response = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_ingredients",
        rationale: "Synthetic ingredient replay verification against the current package image",
        evidenceUrl,
        reviewedText,
      }),
    });
    expect(response.status).toBe(200);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM ingredient_statements WHERE product_id = ?").bind(review.product_id),
      env.DB.prepare("DELETE FROM product_ingredients WHERE product_id = ? AND source_record_id = ?")
        .bind(review.product_id, review.source_record_id),
      env.DB.prepare("DELETE FROM field_observations WHERE product_id = ? AND source_record_id = ? AND field_path = 'ingredients.raw'")
        .bind(review.product_id, review.source_record_id),
      env.DB.prepare("DELETE FROM evidence_outcomes WHERE product_id = ? AND field_family = 'ingredients'")
        .bind(review.product_id),
    ]);
    await applyQueries(env.TEST_INGREDIENT_REPLAY_QUERIES);

    const reconstructed = await env.DB.prepare(`SELECT raw_text, language, status, confidence, authority
      FROM ingredient_statements WHERE product_id = ?`).bind(review.product_id).first<Record<string, unknown>>();
    expect(reconstructed).toEqual({
      raw_text: reviewedText,
      language: "en",
      status: "verified",
      confidence: "high",
      authority: 100,
    });
    const replayState = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM product_ingredients WHERE product_id = ? AND source_record_id = ?) AS ingredients,
      (SELECT COUNT(*) FROM field_observations WHERE product_id = ? AND source_record_id = ? AND field_path = 'ingredients.raw' AND selected = 1) AS selected,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE product_id = ? AND field_family = 'ingredients' AND outcome = 'verified') AS outcomes,
      (SELECT COUNT(*) FROM review_items WHERE source_record_id = ? AND status = 'open') AS unresolved`)
      .bind(
        review.product_id,
        review.source_record_id,
        review.product_id,
        review.source_record_id,
        review.product_id,
        review.source_record_id,
      ).first<{ ingredients: number; selected: number; outcomes: number; unresolved: number }>();
    expect(replayState).toEqual({ ingredients: 2, selected: 1, outcomes: 1, unresolved: 0 });

    await applyQueries(env.TEST_INGREDIENT_DRIFT_QUERIES);
    const drifted = await env.DB.prepare(`SELECT r.status, r.evidence_json FROM review_items r
      JOIN source_records s ON s.id = r.source_record_id
      WHERE s.source_id = 'open_food_facts_robotoff_ingredients'
        AND s.source_record_id = '08900000000012:1901:0' AND r.status = 'open'
      ORDER BY r.created_at DESC LIMIT 1`).first<{ status: string; evidence_json: string }>();
    expect(drifted?.status).toBe("open");
    const driftEvidence = JSON.parse(drifted?.evidence_json ?? "null") as { details?: { candidateHash?: string } };
    const priorDecision = await env.DB.prepare(`SELECT candidate_hash FROM evidence_decisions
      WHERE source_record_key = '08900000000012:1901:0' AND field_family = 'ingredients'`)
      .first<{ candidate_hash: string }>();
    expect(driftEvidence.details?.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(driftEvidence.details?.candidateHash).not.toBe(priorDecision?.candidate_hash);
    const invalidated = await env.DB.prepare(`SELECT
      (SELECT status FROM ingredient_statements WHERE product_id = ?) AS status,
      (SELECT COUNT(*) FROM field_observations WHERE product_id = ? AND source_record_id = ? AND field_path = 'ingredients.raw' AND selected = 1) AS selected,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE product_id = ? AND field_family = 'ingredients') AS outcomes`)
      .bind(review.product_id, review.product_id, review.source_record_id, review.product_id)
      .first<{ status: string; selected: number; outcomes: number }>();
    expect(invalidated).toEqual({ status: "conflict", selected: 0, outcomes: 0 });
  });

  it("applies a review bundle idempotently and exposes partial-application postcondition failure", async () => {
    await applyQueries(env.TEST_REVIEW_BUNDLE_SOURCE_QUERIES);
    const source = await env.DB.prepare(`SELECT id, product_id FROM source_records
      WHERE source_id = 'open_food_facts_robotoff' AND source_record_id = '8900000000012:903'`)
      .first<{ id: string; product_id: string }>();
    if (!source?.product_id) throw new Error("Expected review bundle source record");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM nutrition_facts WHERE product_id = ?").bind(source.product_id),
      env.DB.prepare("DELETE FROM evidence_outcomes WHERE product_id = ? AND field_family = 'nutrition'").bind(source.product_id),
    ]);
    const applyStatements = env.TEST_REVIEW_BUNDLE_APPLY_QUERIES.filter((query) => !query.startsWith("SELECT "));
    expect(applyStatements.length).toBeGreaterThan(3);
    const first = applyStatements[0];
    if (!first) throw new Error("Expected a decision insert statement");
    await env.DB.prepare(first).run();
    const partial = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE id = 'evd_bundle_fixture') AS decisions,
      (SELECT COUNT(*) FROM nutrition_facts WHERE product_id = ? AND source_record_id = ? AND status = 'verified') AS verified,
      (SELECT COUNT(*) FROM review_items WHERE source_record_id = ? AND status = 'open') AS unresolved`)
      .bind(source.product_id, source.id, source.id).first<{ decisions: number; verified: number; unresolved: number }>();
    expect(partial).toEqual({ decisions: 1, verified: 0, unresolved: 1 });

    await applyQueries(applyStatements);
    const applied = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE id = 'evd_bundle_fixture') AS decisions,
      (SELECT COUNT(*) FROM nutrition_facts WHERE product_id = ? AND source_record_id = ? AND status = 'verified') AS verified,
      (SELECT COUNT(*) FROM review_items WHERE source_record_id = ? AND status = 'open') AS unresolved,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE product_id = ? AND field_family = 'nutrition' AND outcome = 'verified') AS outcomes`)
      .bind(source.product_id, source.id, source.id, source.product_id)
      .first<{ decisions: number; verified: number; unresolved: number; outcomes: number }>();
    expect(applied).toEqual({ decisions: 1, verified: 1, unresolved: 0, outcomes: 1 });
    const fact = await env.DB.prepare("SELECT calories, protein_grams, status, authority FROM nutrition_facts WHERE product_id = ?")
      .bind(source.product_id).first<Record<string, unknown>>();
    expect(fact).toEqual({ calories: 365, protein_grams: 25, status: "verified", authority: 100 });
    const classification = await env.DB.prepare(`SELECT nutritionally_protein_dense, nutrition_reasons_json, classifier_version
      FROM products WHERE id = ?`).bind(source.product_id).first<Record<string, unknown>>();
    expect(classification).toEqual({
      nutritionally_protein_dense: 1,
      nutrition_reasons_json: JSON.stringify(["protein_at_least_20_percent_calories"]),
      classifier_version: "protein-v1",
    });

    await applyQueries(applyStatements);
    const replayed = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE id = 'evd_bundle_fixture') AS decisions,
      (SELECT COUNT(*) FROM field_observations WHERE product_id = ? AND source_record_id = ? AND field_path LIKE 'nutrition.%' AND selected = 1) AS selected,
      (SELECT COUNT(*) FROM nutrient_values WHERE product_id = ? AND source_record_id = ? AND status = 'verified') AS nutrients`)
      .bind(source.product_id, source.id, source.product_id, source.id)
      .first<{ decisions: number; selected: number; nutrients: number }>();
    expect(replayed).toEqual({ decisions: 1, selected: 4, nutrients: 4 });
  });

  it("applies an ingredient review bundle idempotently with exact source-linked facts", async () => {
    await applyQueries(env.TEST_INGREDIENT_BUNDLE_SOURCE_QUERIES);
    const source = await env.DB.prepare(`SELECT id, product_id FROM source_records
      WHERE source_id = 'open_food_facts_robotoff_ingredients'
        AND source_record_id = '08900000000012:1904:0'`)
      .first<{ id: string; product_id: string }>();
    if (!source?.product_id) throw new Error("Expected ingredient review bundle source record");
    const applyStatements = env.TEST_INGREDIENT_BUNDLE_APPLY_QUERIES.filter((query) => !query.startsWith("SELECT "));
    const first = applyStatements[0];
    if (!first) throw new Error("Expected ingredient bundle decision statement");
    await env.DB.prepare(first).run();
    const partial = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE id = 'evd_ingredient_bundle_fixture') AS decisions,
      (SELECT COUNT(*) FROM ingredient_statements WHERE product_id = ? AND source_record_id = ? AND status = 'verified') AS verified,
      (SELECT COUNT(*) FROM review_items WHERE source_record_id = ? AND status = 'open') AS unresolved`)
      .bind(source.product_id, source.id, source.id)
      .first<{ decisions: number; verified: number; unresolved: number }>();
    expect(partial).toEqual({ decisions: 1, verified: 0, unresolved: 1 });

    await applyQueries(applyStatements);
    const applied = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE id = 'evd_ingredient_bundle_fixture') AS decisions,
      (SELECT COUNT(*) FROM ingredient_statements WHERE product_id = ? AND source_record_id = ? AND status = 'verified' AND authority = 100) AS verified,
      (SELECT COUNT(*) FROM product_ingredients WHERE product_id = ? AND source_record_id = ?) AS ingredients,
      (SELECT COUNT(*) FROM field_observations WHERE product_id = ? AND source_record_id = ? AND field_path = 'ingredients.raw' AND selected = 1) AS selected,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE product_id = ? AND field_family = 'ingredients' AND source_record_id = ? AND outcome = 'verified') AS outcomes,
      (SELECT COUNT(*) FROM review_items WHERE source_record_id = ? AND status = 'open') AS unresolved`)
      .bind(
        source.product_id, source.id,
        source.product_id, source.id,
        source.product_id, source.id,
        source.product_id, source.id,
        source.id,
      ).first<{ decisions: number; verified: number; ingredients: number; selected: number; outcomes: number; unresolved: number }>();
    expect(applied).toEqual({ decisions: 1, verified: 1, ingredients: 3, selected: 1, outcomes: 1, unresolved: 0 });
    const statement = await env.DB.prepare("SELECT raw_text, language, observed_at FROM ingredient_statements WHERE product_id = ?")
      .bind(source.product_id).first<Record<string, unknown>>();
    expect(statement).toEqual({
      raw_text: "Defatted soy flour 100%, salt, spices",
      language: "en",
      observed_at: "2026-07-15T09:00:00.000Z",
    });

    await applyQueries(applyStatements);
    const replayed = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE id = 'evd_ingredient_bundle_fixture') AS decisions,
      (SELECT COUNT(*) FROM product_ingredients WHERE product_id = ? AND source_record_id = ?) AS ingredients,
      (SELECT COUNT(*) FROM field_observations WHERE product_id = ? AND source_record_id = ? AND field_path = 'ingredients.raw' AND selected = 1) AS selected`)
      .bind(source.product_id, source.id, source.product_id, source.id)
      .first<{ decisions: number; ingredients: number; selected: number }>();
    expect(replayed).toEqual({ decisions: 1, ingredients: 3, selected: 1 });
  });

  it("fails closed when Robotoff review evidence is incomplete", async () => {
    const review = await insertRobotoffReview({
      suffix: "invalid",
      evidence: { code: "robotoff_nutrition_candidate", details: { candidate: { minimumConfidence: 0.99 } } },
    });
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_nutrition",
        rationale: "Attempted verification",
        evidenceUrl: "https://images.openfoodfacts.org/images/products/label.jpg",
      }),
    });
    expect(response.status).toBe(400);
    const stillOpen = await env.DB.prepare("SELECT status FROM review_items WHERE id = ?").bind(review.reviewId).first<{ status: string }>();
    expect(stillOpen?.status).toBe("open");
  });

  it("persists a manual identity match and reuses it on replay", async () => {
    const review = await identityReview("fixture-ambiguous-whey-listing");
    const evidenceUrl = "https://example.invalid/identity-label.jpg";
    if (!review.sourceRecordId) throw new Error("Expected identity review source record");
    await retainIdentityLabel(review.sourceRecordId, evidenceUrl, "match");
    expect(review.candidates).toHaveLength(1);
    const candidate = review.candidates[0];
    if (!candidate) throw new Error("Expected an identity candidate");
    expect(candidate).toMatchObject({ brand: "Atlas Test Foods", name: "High Protein Whey Blend", netQuantityGrams: 1000 });

    const invalidCandidate = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "match",
        rationale: "Wrong candidate proof",
        candidateProductId: "not-a-candidate",
        evidenceUrl,
      }),
    });
    expect(invalidCandidate.status).toBe(400);

    const resolved = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "match",
        rationale: "Same label identity; missing retailer pack metadata",
        candidateProductId: candidate.id,
        evidenceUrl,
      }),
    });
    expect(resolved.status).toBe(200);

    await replaySeed();

    const source = await env.DB.prepare(`SELECT product_id, resolution_rule FROM source_records
      WHERE source_id = 'label_fixture' AND source_record_id = 'fixture-ambiguous-whey-listing'`).first<{ product_id: string | null; resolution_rule: string }>();
    expect(source).toEqual({ product_id: candidate.id, resolution_rule: "manual_match" });
    const decision = await env.DB.prepare("SELECT decision, target_product_id, active FROM identity_decisions WHERE source_record_key = ?")
      .bind("fixture-ambiguous-whey-listing").first<{ decision: string; target_product_id: string; active: number }>();
    expect(decision).toEqual({ decision: "match", target_product_id: candidate.id, active: 1 });
    const identityEvidence = await env.DB.prepare(`SELECT product_id, source_record_id, evidence_url
      FROM identity_evidence_decisions WHERE product_id = ? AND source_record_id = ?`)
      .bind(candidate.id, review.sourceRecordId)
      .first<{ product_id: string; source_record_id: string; evidence_url: string }>();
    expect(identityEvidence).toEqual({
      product_id: candidate.id,
      source_record_id: review.sourceRecordId,
      evidence_url: evidenceUrl,
    });
    const identityOutcome = await env.DB.prepare(`SELECT outcome, source_record_id, evidence_url
      FROM evidence_outcomes WHERE product_id = ? AND field_family = 'identity'`)
      .bind(candidate.id)
      .first<{ outcome: string; source_record_id: string; evidence_url: string }>();
    expect(identityOutcome).toEqual({
      outcome: "verified",
      source_record_id: review.sourceRecordId,
      evidence_url: evidenceUrl,
    });
    const incoming = await env.DB.prepare("SELECT is_active FROM products WHERE id = ?").bind(review.productId).first<{ is_active: number }>();
    expect(incoming?.is_active).toBe(0);
    const openIdentity = await env.DB.prepare("SELECT COUNT(*) AS count FROM review_items WHERE type = 'identity' AND status = 'open' AND source_record_id = ?")
      .bind(review.sourceRecordId).first<{ count: number }>();
    expect(openIdentity?.count).toBe(0);
    const activeProducts = await env.DB.prepare("SELECT COUNT(*) AS count FROM products WHERE is_active = 1").first<{ count: number }>();
    expect(activeProducts?.count).toBe(5);
    const candidateDetail = await worker.fetch(`http://localhost/api/products/${candidate.id}`);
    const detail = await json<ProductDetailResponse>(candidateDetail);
    expect(detail.sourceRecords.some((record) => record.sourceRecordId === "fixture-ambiguous-whey-listing" && record.resolutionRule === "manual_match")).toBe(true);
    expect(detail.gtin).toBe("08900000000012");
    expect(detail.netQuantityGrams).toBe(1000);
  });

  it("persists a create-new identity decision across replay", async () => {
    const review = await identityReview("fixture-distinct-whey-listing");
    const evidenceUrl = "https://example.invalid/distinct-identity-label.jpg";
    if (!review.sourceRecordId) throw new Error("Expected identity review source record");
    await retainIdentityLabel(review.sourceRecordId, evidenceUrl, "create");
    const missingEvidence = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "create_new", rationale: "Packaging evidence establishes a distinct product" }),
    });
    expect(missingEvidence.status).toBe(400);
    const stillOpen = await env.DB.prepare("SELECT status FROM review_items WHERE id = ?")
      .bind(review.id).first<{ status: string }>();
    expect(stillOpen?.status).toBe("open");
    const resolved = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "create_new",
        rationale: "Packaging evidence establishes a distinct product",
        evidenceUrl,
      }),
    });
    expect(resolved.status).toBe(200);

    await replaySeed();

    const source = await env.DB.prepare("SELECT product_id, resolution_rule FROM source_records WHERE source_record_id = ?")
      .bind("fixture-distinct-whey-listing").first<{ product_id: string; resolution_rule: string }>();
    expect(source).toEqual({ product_id: review.productId, resolution_rule: "manual_create_new" });
    const decision = await env.DB.prepare("SELECT decision, target_product_id FROM identity_decisions WHERE source_record_key = ?")
      .bind("fixture-distinct-whey-listing").first<{ decision: string; target_product_id: string }>();
    expect(decision).toEqual({ decision: "create_new", target_product_id: review.productId });
    const exactEvidence = await env.DB.prepare(`SELECT product_id, source_record_id, evidence_url
      FROM identity_evidence_decisions WHERE product_id = ? AND source_record_id = ?`)
      .bind(review.productId, review.sourceRecordId)
      .first<{ product_id: string; source_record_id: string; evidence_url: string }>();
    expect(exactEvidence).toEqual({
      product_id: review.productId,
      source_record_id: review.sourceRecordId,
      evidence_url: evidenceUrl,
    });
    const incoming = await env.DB.prepare("SELECT is_active FROM products WHERE id = ?").bind(review.productId).first<{ is_active: number }>();
    expect(incoming?.is_active).toBe(1);
  });

  it("persists a keep-unmatched identity decision across replay", async () => {
    const review = await identityReview("fixture-unmatched-whey-listing");
    const resolved = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "no_match", rationale: "Evidence is insufficient to publish or merge this listing" }),
    });
    expect(resolved.status).toBe(200);

    await replaySeed();

    const source = await env.DB.prepare("SELECT product_id, resolution_rule FROM source_records WHERE source_record_id = ?")
      .bind("fixture-unmatched-whey-listing").first<{ product_id: string | null; resolution_rule: string }>();
    expect(source).toEqual({ product_id: null, resolution_rule: "manual_no_match" });
    const decision = await env.DB.prepare("SELECT decision, target_product_id FROM identity_decisions WHERE source_record_key = ?")
      .bind("fixture-unmatched-whey-listing").first<{ decision: string; target_product_id: string | null }>();
    expect(decision).toEqual({ decision: "no_match", target_product_id: null });
    const terminalIdentity = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM identity_evidence_decisions WHERE source_record_id = ?) AS decisions,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE product_id = ? AND field_family = 'identity') AS outcomes`)
      .bind(review.sourceRecordId, review.productId)
      .first<{ decisions: number; outcomes: number }>();
    expect(terminalIdentity).toEqual({ decisions: 0, outcomes: 0 });
    const incoming = await env.DB.prepare("SELECT is_active FROM products WHERE id = ?").bind(review.productId).first<{ is_active: number }>();
    expect(incoming?.is_active).toBe(0);
    const stillLinked = await env.DB.prepare("SELECT COUNT(*) AS count FROM source_records WHERE product_id = ?")
      .bind(review.productId).first<{ count: number }>();
    expect(stillLinked?.count).toBe(0);
  });

  it("persists exact extraction links online while legacy review decisions remain unlinked", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected an active product for extraction-linked review");
    const nutrition = {
      calories: 390,
      proteinGrams: 30,
      carbohydrateGrams: 45,
      sugarGrams: 5,
      fatGrams: 10,
      saturatedFatGrams: 3,
      fibreGrams: 5,
      sodiumMg: 200,
    };

    const legacy = await insertRobotoffReview({
      suffix: "link-legacy",
      evidence: robotoffEvidence(product.gtin, nutrition),
    });
    const legacyResponse = await worker.fetch(`http://localhost/api/reviews/${legacy.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject_nutrition", rationale: "Legacy response-only candidate" }),
    });
    expect(legacyResponse.status).toBe(200);
    expect(await env.DB.prepare(`SELECT extraction_attempt_id, label_asset_id
      FROM evidence_decisions WHERE id = ?`).bind(`evd_${legacy.reviewId}`).first())
      .toEqual({ extraction_attempt_id: null, label_asset_id: null });

    const linkedEvidence = robotoffEvidence(product.gtin, { ...nutrition, calories: 391 });
    const linked = await insertRobotoffReview({ suffix: "link-current", evidence: linkedEvidence });
    const exact = await attachExactExtraction(linked, linkedEvidence, "nutrition");
    const linkedResponse = await worker.fetch(`http://localhost/api/reviews/${linked.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject_nutrition", rationale: "Exact byte-bound candidate rejection" }),
    });
    expect(linkedResponse.status).toBe(200);
    expect(await env.DB.prepare(`SELECT extraction_attempt_id, label_asset_id
      FROM evidence_decisions WHERE id = ?`).bind(`evd_${linked.reviewId}`).first())
      .toEqual({ extraction_attempt_id: exact.extractionAttemptId, label_asset_id: exact.labelAssetId });

    const ingredientFixture = robotoffIngredientEvidence(product.gtin, "link-current");
    const linkedIngredient = await insertIngredientReview({
      suffix: "link-current",
      evidence: ingredientFixture.evidence,
    });
    const exactIngredient = await attachExactExtraction(
      linkedIngredient,
      ingredientFixture.evidence,
      "ingredients",
    );
    const linkedIngredientResponse = await worker.fetch(
      `http://localhost/api/reviews/${linkedIngredient.reviewId}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject_ingredients", rationale: "Exact byte-bound ingredient rejection" }),
      },
    );
    expect(linkedIngredientResponse.status).toBe(200);
    expect(await env.DB.prepare(`SELECT extraction_attempt_id, label_asset_id
      FROM evidence_decisions WHERE id = ?`).bind(`evd_${linkedIngredient.reviewId}`).first())
      .toEqual({
        extraction_attempt_id: exactIngredient.extractionAttemptId,
        label_asset_id: exactIngredient.labelAssetId,
      });
  });

  it("downgrades exact-label verified nutrition when a newer retained label revision replaces it", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected an active product for current-label drift");
    const evidence = robotoffEvidence(product.gtin, {
      calories: 380,
      proteinGrams: 32,
      carbohydrateGrams: 42,
      sugarGrams: 4,
      fatGrams: 9,
      saturatedFatGrams: 2,
      fibreGrams: 5,
      sodiumMg: 190,
    });
    const mutableEvidence = evidence as {
      details: { candidate: { imageId: string; imageUrl: string } };
    };
    mutableEvidence.details.candidate.imageId = "catalog-label-drift-image";
    mutableEvidence.details.candidate.imageUrl = "https://images.openfoodfacts.org/images/products/catalog-label-drift.jpg";
    const candidate = nutritionCandidateFromEvidence(evidence, product.gtin);
    if (!candidate) throw new Error("Expected a current-label nutrition candidate");
    const review = await insertRobotoffReview({ suffix: "catalog-label-drift", evidence });
    await env.DB.prepare(`UPDATE extraction_attempts SET is_current = 0
      WHERE product_id = ? AND field_family = 'nutrition' AND is_current = 1`)
      .bind(review.productId).run();
    const exact = await attachExactExtraction(review, evidence, "nutrition");
    const verifiedResponse = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_nutrition",
        rationale: "Exact current label used to test effective catalog status",
        evidenceUrl: candidate.imageUrl,
      }),
    });
    expect(verifiedResponse.status).toBe(200);

    const currentCatalog = await json<CatalogResponse>(await worker.fetch(
      `http://localhost/api/products?q=${product.gtin}&verification=verified&scope=all&pageSize=100`,
    ));
    expect(currentCatalog.products.find(({ id }) => id === review.productId)).toMatchObject({
      nutritionStatus: "verified",
      nutritionEvidenceUrl: candidate.imageUrl,
      nutritionEvidenceKind: "label",
    });
    const beforeCoverage = await json<CoverageResponse>(await worker.fetch("http://localhost/api/coverage"));
    const label = await env.DB.prepare(`SELECT subject_source_record_id,
      subject_source_content_hash, product_id, field_family, source_image_id,
      source_image_revision, requested_url, effective_url
      FROM label_evidence_assets WHERE id = ?`)
      .bind(exact.labelAssetId)
      .first<{
        subject_source_record_id: string;
        subject_source_content_hash: string;
        product_id: string;
        field_family: string;
        source_image_id: string;
        source_image_revision: string | null;
        requested_url: string;
        effective_url: string;
      }>();
    if (!label) throw new Error("Expected retained exact label evidence");
    await env.DB.prepare(`INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id,
       field_family, source_image_id, source_image_revision, requested_url,
       effective_url, content_sha256, byte_length, media_type, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 4097, 'image/jpeg', ?)`)
      .bind(
        `${exact.labelAssetId}-replacement`,
        label.subject_source_record_id,
        label.subject_source_content_hash,
        label.product_id,
        label.field_family,
        label.source_image_id,
        label.source_image_revision,
        label.requested_url,
        label.effective_url,
        "a".repeat(64),
        "2026-07-18T00:00:00.000Z",
      ).run();

    expect(await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM current_exact_verified_evidence_decisions
      WHERE product_id = ? AND field_family = 'nutrition'`)
      .bind(review.productId).first<{ count: number }>()).toEqual({ count: 0 });
    const verifiedAfterDrift = await json<CatalogResponse>(await worker.fetch(
      `http://localhost/api/products?q=${product.gtin}&verification=verified&scope=all&pageSize=100`,
    ));
    expect(verifiedAfterDrift.products.some(({ id }) => id === review.productId)).toBe(false);
    const unverifiedAfterDrift = await json<CatalogResponse>(await worker.fetch(
      `http://localhost/api/products?q=${product.gtin}&verification=unverified&scope=all&pageSize=100`,
    ));
    expect(unverifiedAfterDrift.products.find(({ id }) => id === review.productId)?.nutritionStatus).toBe("unverified");
    const detail = await json<ProductDetailResponse>(await worker.fetch(
      `http://localhost/api/products/${review.productId}`,
    ));
    expect(detail).toMatchObject({
      nutritionStatus: "unverified",
      nutritionEvidenceUrl: null,
      nutritionEvidenceKind: null,
    });
    expect(detail.nutrients.filter(({ status }) => status === "verified")).toHaveLength(0);
    const afterCoverage = await json<CoverageResponse>(await worker.fetch("http://localhost/api/coverage"));
    expect(afterCoverage.catalog.verifiedNutrition).toBe(beforeCoverage.catalog.verifiedNutrition - 1);
    expect(afterCoverage.catalog.unverifiedNutrition).toBe(beforeCoverage.catalog.unverifiedNutrition + 1);
  });

  it("keeps active product HTML, Markdown, sitemap, and agent catalog in parity", async () => {
    const activeProducts = await env.DB.prepare(
      "SELECT id, name FROM products WHERE is_active = 1 ORDER BY id",
    ).all<{ id: string; name: string }>();
    const active = activeProducts.results[0];
    if (!active) throw new Error("Expected an active product");
    const encodedId = encodeURIComponent(active.id);

    const htmlResponse = await worker.fetch(`http://localhost/products/${encodedId}`);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    const html = await htmlResponse.text();
    expect(html).toContain(active.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    expect(html).toContain(`http://localhost/products/${encodedId}`);
    expect(html).toContain('type="application/ld+json"');
    expect(html).not.toContain("openReviewCount");
    expect(html).not.toContain("sourceRecords");

    const markdownResponse = await worker.fetch(`http://localhost/products/${encodedId}.md`);
    expect(markdownResponse.status).toBe(200);
    expect(markdownResponse.headers.get("content-type")).toContain("text/markdown");
    const markdown = await markdownResponse.text();
    expect(markdown).toContain(`# ${active.name}`);
    expect(markdown).toContain(`Canonical URL: http://localhost/products/${encodedId}`);
    expect(markdown).not.toContain("openReviewCount");

    const compatibilityResponse = await worker.fetch(`http://localhost/api/products/${encodedId}.md`);
    expect(compatibilityResponse.status).toBe(200);
    expect(await compatibilityResponse.text()).toContain(`Canonical URL: http://localhost/products/${encodedId}`);

    const catalogResponse = await worker.fetch("http://localhost/api/ai");
    const catalog = await json<{ surfaces: Array<{ id: string; url: string; md?: string }> }>(catalogResponse);
    const productSurfaces = catalog.surfaces.filter(({ url }) => url.includes("/products/"));
    expect(productSurfaces).toHaveLength(activeProducts.results.length);
    expect(productSurfaces.find(({ id }) => id === active.id)).toMatchObject({
      url: `http://localhost/products/${encodedId}`,
      md: `http://localhost/products/${encodedId}.md`,
    });

    const sitemapResponse = await worker.fetch("http://localhost/sitemap.xml");
    expect(sitemapResponse.status).toBe(200);
    expect(sitemapResponse.headers.get("content-type")).toContain("application/xml");
    const sitemap = await sitemapResponse.text();
    expect(sitemap.match(/<url>/g)).toHaveLength(activeProducts.results.length + 1);
    expect(sitemap).toContain(`http://localhost/products/${encodedId}`);
    expect(sitemap).not.toContain(".md");
    expect(sitemap).not.toContain("/api/");

    const inactive = await env.DB.prepare("SELECT id FROM products WHERE is_active = 0 ORDER BY id LIMIT 1")
      .first<{ id: string }>();
    if (inactive) {
      const inactiveId = encodeURIComponent(inactive.id);
      expect((await worker.fetch(`http://localhost/products/${inactiveId}`)).status).toBe(404);
      expect((await worker.fetch(`http://localhost/products/${inactiveId}.md`)).status).toBe(404);
      expect(sitemap).not.toContain(`/products/${inactiveId}`);
      expect(catalog.surfaces.some(({ id }) => id === inactive.id)).toBe(false);
    }
  });
});

describe("density sort key maintenance", () => {
  it("keeps sort_protein_density equal to the canonical key after evidence writes", async () => {
    const product = await env.DB.prepare(
      "SELECT id FROM products WHERE is_active = 1 ORDER BY id LIMIT 1",
    ).first<{ id: string }>();
    if (!product) throw new Error("Expected a seeded product");

    // Force drift, then fire the nutrition-facts maintenance trigger with a
    // no-op update; the trigger must restore the canonical key.
    await env.DB.prepare("UPDATE products SET sort_protein_density = NULL WHERE id = ?")
      .bind(product.id).run();
    await env.DB.prepare("UPDATE nutrition_facts SET status = status WHERE product_id = ?")
      .bind(product.id).run();

    const row = await env.DB.prepare(
      `SELECT p.sort_protein_density AS stored, k.sort_protein_density AS computed
       FROM products p
       LEFT JOIN product_density_sort_keys k ON k.product_id = p.id
       WHERE p.id = ?`,
    ).bind(product.id).first<{ stored: number | null; computed: number | null }>();
    expect(row?.stored ?? null).toBe(row?.computed ?? null);
  });

  it("has no drifted density keys across the catalog", async () => {
    const drift = await env.DB.prepare(
      `SELECT COUNT(*) AS mismatched
       FROM products p
       LEFT JOIN product_density_sort_keys k ON k.product_id = p.id
       WHERE p.sort_protein_density IS NOT k.sort_protein_density`,
    ).first<{ mismatched: number }>();
    expect(drift?.mismatched).toBe(0);
  });
});

describe("catalog counter maintenance", () => {
  it("tracks active product count through insert, deactivate, and delete", async () => {
    const before = await env.DB.prepare(
      "SELECT value FROM catalog_counters WHERE name = 'active_products'",
    ).first<{ value: number }>();
    const actual = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM products WHERE is_active = 1",
    ).first<{ c: number }>();
    expect(before?.value).toBe(actual?.c);

    const id = `counter-test-${Date.now()}`;
    await env.DB.prepare(
      `INSERT INTO products (id, brand, name, brand_normalized, name_normalized,
        category, classifier_version, is_active, created_at, updated_at)
       VALUES (?, 'B', 'Counter product', 'b', 'counter product', 'other', 'v1', 1, '2026-01-01', '2026-01-01')`,
    ).bind(id).run();
    let row = await env.DB.prepare(
      "SELECT value FROM catalog_counters WHERE name = 'active_products'",
    ).first<{ value: number }>();
    expect(row?.value).toBe((before?.value ?? 0) + 1);

    await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(id).run();
    row = await env.DB.prepare(
      "SELECT value FROM catalog_counters WHERE name = 'active_products'",
    ).first<{ value: number }>();
    expect(row?.value).toBe(before?.value);

    await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
    row = await env.DB.prepare(
      "SELECT value FROM catalog_counters WHERE name = 'active_products'",
    ).first<{ value: number }>();
    expect(row?.value).toBe(before?.value);
  });
});

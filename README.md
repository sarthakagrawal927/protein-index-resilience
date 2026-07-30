# Protein Index

Live dashboard: <https://protein.significanthobbies.com>

A normalized Indian food-product intelligence database with protein discovery,
source-aware nutrition and ingredients, and evidence-first comparisons.

The product record is canonical. Retailer listings are observations attached to
that record, never the source of identity by themselves. Broad imports ingest
all India-tagged foods first and classify protein products afterward.

The dashboard has two explicit evidence boundaries:

- **Trusted** shows protein-relevant products only when exact current identity,
  authority-100 verified nutrition, and terminal ingredient evidence all agree.
- **Discovery** exposes comparison metrics only
  when structured nutrition passes validation, keeps community evidence visibly
  unverified, and withholds missing or conflicting values.

Missing values stay missing. Open Food Facts values are never promoted to
label-verified facts merely because they parse successfully.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the source-data and
service licenses that apply independently of this repository's visibility.

## Local development

Requirements: Node.js 22+ and pnpm 10.

```bash
pnpm install
pnpm data:seed
pnpm dev
```

The seed is intentionally synthetic. It provides verified and conflict states,
plus ambiguous identity records for exercising match, create-new, and
keep-unmatched decisions without presenting test products as real market data.

Run the complete local check with:

```bash
pnpm check
```

## Source staging

Stage a bounded local Open Food Facts sample:

```bash
pnpm data:stage -- \
  --input path/to/open-food-facts-sample.jsonl \
  --output .data/sample \
  --mode sample \
  --limit 100
```

Production mode rejects every record cap. The weekly/manual GitHub workflow
downloads the complete official TSV export, identifies this client, reaches
end-of-file, compares counts and record hashes with the last good run, and
uploads reviewable artifacts. Every India-tagged source row is represented by
either a staged product or an auditable exclusion-ledger entry. The workflow
then fans out richer API and label-evidence jobs from the exact snapshot.

Enrich the exact source-complete barcode set with the richer documented product
response:

```bash
pnpm data:enrich -- \
  --input .data/sample/staged-products.jsonl \
  --manifest .data/sample/manifest.json \
  --output .data/enrichment \
  --mode production
```

Enrichment uses multi-code batches, identifies this client, stays within the
documented search limit, retries transient failures, splits persistently
unavailable batches, and resumes from saved response artifacts. It separately
accounts for enriched, unchanged, not-found, rejected, and failed barcodes. The
weekly enrichment workflow creates a source-complete reviewable artifact.

Extract review-gated nutrition candidates from every available label image:

```bash
pnpm data:extract -- \
  --source robotoff \
  --input .data/sample/staged-products.jsonl \
  --manifest .data/sample/manifest.json \
  --output .data/robotoff \
  --mode production
```

The Robotoff job is resumable per barcode, identifies the client, observes the
documented request limit, and records every eligible barcode exactly once as
candidate, no-prediction, rejected, or failed. Complete outcome accounting is
separate from verification completeness. A checksummed artifact may retain at
most 10 post-response label failures and at most 0.25% of its requested cohort;
both limits must hold. Upstream model/API failures without a retained raw
response, missing or duplicate outcomes, unknown reasons, or larger residual
sets still fail the artifact closed. Model output never becomes verified
nutrition automatically; an operator must review the current label image, and
verification applies that exact candidate with its provenance.
Exact label downloads have a 30-second total deadline plus byte and chunk
limits. A failed workflow pass reuses every validated label hash already written
by that same run, so later passes retry only incomplete evidence instead of
downloading the successful cohort again.

Mass and liquid labels remain dimensionally separate throughout extraction and
review. Direct liquid rows are retained as per 100 mL. A serving-only liquid row
is normalized only when the source explicitly declares its serving volume; the
pipeline never assumes that one millilitre weighs one gram. Protein per 100
calories remains comparable across both bases, while pack-mass and price metrics
stay unavailable without compatible mass evidence.

The GitHub enrichment and label-extraction workflows reuse retained API
responses only when the complete staged-source hash and upstream export hash
exactly match a previously checksummed artifact. The reusable cache key is the
source snapshot plus request schema, not the parser adapter version: parser-only
changes replay the retained raw responses and rebuild all candidates, label
proofs, and attempt ledgers under current code. Legacy zero-failure artifacts
may seed that response cache but can never bypass current artifact validation or
be published as current evidence. A changed source snapshot fetches current
responses; a request-schema mismatch is rejected and fetched again.

A failed extraction diagnostic is never publishable, but its label-byte hashes
may be used as a download cache when the immutable GitHub archive digest, exact
producer workflow and failed step, default-branch ancestry, source snapshot,
request schema, current adapter, complete barcode partition, bounded failure
reasons, canonical asset IDs, and current source subjects all match. The current
adapter still rebuilds every attempt, outcome, candidate, checksum, and decision
audit; any cache mismatch falls back to downloading the label again.

Reviewed-decision drift audits use the checked-in
`review-decisions/active-bundles.json` set. Historical and superseded bundles
remain immutable on disk for audit history, but they cannot be mixed into the
current proof set or create false decision-ID conflicts.

## Manual fresh-evidence publication

Successful producer runs do not start a credentialed publication job. An
operator must explicitly dispatch the serialized production workflow, identify
the exact successful run, and provide its hard confirmation input before any
credential-bearing or D1 step can begin. The path accepts only the exact run
artifact and head commit from its four-workflow allowlist. It verifies portable
checksums, source/cohort accounting, the fixed 20% discovery-drop ceiling, and
every staged record before generating SQL.

The repository's `production` environment remains defense in depth for
credential scoping. The workflow's explicit dispatch confirmation is the
repository-enforced approval gate even when the environment has no required
reviewer. Pending migrations still fail closed; this evidence path cannot apply
them.

Fresh-evidence publication has a deliberately narrower authority boundary than
reviewed catalog publication:

- Open Food Facts values remain unverified community evidence.
- Robotoff records remain review-only candidates with no selected facts.
- Existing verified rows cannot be overwritten by fresh evidence, and
  verified counts cannot increase.
- Pending D1 migrations stop the run; this path cannot apply schema changes.
- DataKart, retailer offers/ratings, review decisions, and Worker deployment are
  excluded.

Every credentialed attempt retains the trigger identity, artifact/manifest
hashes, publication log, exact D1 pre/post state, and live health/catalog checks
for 90 days. If a write or postcondition fails, the workflow makes no success claim.
The same checksummed artifact remains replayable through the protected workflow
after investigation. The scheduled producer cadence remains weekly, but
publication is always a separate explicit action. The workflow may download and
validate the immutable artifact before checking protected credentials, but
missing credentials still fail before any D1 read or write.

## Review decision drift audit

Before preparing any review publication, audit the checked-in active decision
set against one exact, checksum-validated nutrition or ingredient artifact:

```bash
pnpm data:audit-decisions -- \
  --artifact .data/robotoff-nutrition-v8 \
  --bundles review-decisions \
  --bundle-set review-decisions/active-bundles.json \
  --output .data/nutrition-decision-drift.json
```

The audit is read-only and suitable for GitHub Actions. It validates the full
artifact and each review bundle, collapses identical historical copies, fails
closed on conflicting decision identities or inconsistent exact proof, and
reports drift plus current candidates that still need review. A legacy decision
that semantically matches fresh evidence is never upgraded in place: immutable
exact extraction linkage requires a newly reviewed decision. Pass a comma-
separated `--fail-on` list when automation should also reject selected ordinary
finding categories. The command never connects to D1 or changes review ledgers.
Fresh nutrition-v8 and ingredient-v3 producer workflows run this audit before
uploading publishable candidates and retain the report as a separate 30-day
artifact even when a failure prevents candidate publication.

Omitting `--bundle-set` is an explicit forensic all-history mode. It scans
superseded immutable bundles too and is not a publication proof.

## Reviewed catalog publication

Validate and publish an existing source-complete snapshot locally:

```bash
pnpm data:publish -- --input .data/reviewed-snapshot
```

Remote publication is intentionally explicit and requires both flags:

```bash
pnpm data:publish -- \
  --input .data/reviewed-snapshot \
  --remote \
  --confirm-remote
```

Publication verifies portable checksums, production/end-of-file evidence,
India-row reconciliation, continuity limits, and non-empty counts before it
writes. It then applies migrations, performs an idempotent D1 import, and
queries product, run, and source-record counts. The manual `Publish reviewed
catalog` GitHub workflow adds a protected environment gate and pins both the
source workflow run and reviewed input hash. Manual publication remains the
recovery path and is the only catalog path allowed to apply reviewed schema
migrations; exact nutrition/ingredient decisions use their dedicated protected
workflow.

## Cloudflare release

The production topology is one Worker (`protein-index`), one D1 database
(`protein-index`), and one private R2 bucket (`protein-index-labels`). The
public application is read-only until operator authentication exists.

After resources are bound and the reviewed snapshot has been published:

```bash
pnpm release:preflight
pnpm run deploy
```

`pnpm run deploy` runs the fleet deploy guard before tests, build, Worker startup
profiling, Wrangler dry run, and the strict deployment. Roll back Worker code
with Wrangler deployment rollback; catalog corrections are republished as new
evidence-preserving runs instead of deleting the audit trail.

See [docs/product/sources.md](docs/product/sources.md) for trust states, coverage
semantics, and the DataKart integration checklist. The full repository knowledge
system lives under [docs/](docs/index.md).

Implementation work is tracked in `openspec/changes/` and durable product status
lives in `PROJECT_STATUS.md`.

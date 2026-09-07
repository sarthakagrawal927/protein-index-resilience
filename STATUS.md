# Protein Index — STATUS

> Short current-state view. The durable, append-only timeline lives in
> [`PROJECT_STATUS.md`](PROJECT_STATUS.md). Update this file each working
> session; update `PROJECT_STATUS.md` when PR-sized work completes.

Last updated: 2026-09-07

## Current checkpoint — September 7

Fleet retains this project as an inactive reference. Nutrition provenance repairs
are ported into the canonical source, preserving its discovery routes and data
notices. The authorized canonical Worker release and desktop/mobile nutrition
provenance checks passed; [release evidence](docs/operations/release-2026-09-07.md)
records source tag, rollback, original-label comparison and dated-data limits.
No source data or schema changed; the project remains inactive.
See [the source reconciliation and remaining acceptance](README.md#september-7-source-reconciliation).

## Historical objective and work (not current authorization)

## Current objective

Reach strict terminal-evidence completion: every active product has terminal
verified identity, nutrition, and ingredient evidence (or a current
label/authoritative source explicitly establishes a field as not applicable or
not declared), every configured source reconciles without unexplained gaps, and
the rendered dashboard passes desktop/mobile verification.

## Active work

- Public discovery coverage is complete locally: every active product has a
  canonical HTML route and equivalent Markdown representation, while runtime
  sitemap and `/api/ai` output derive from the same active inventory. No data
  was published and no deployment was performed.
- Machine-verified label lane (`automated-label-verification` OpenSpec change):
  complete and published through protected workflow run `29653810942`. Three
  current first-party Protein Chef labels plus four serving-normalized Yoga Bar
  labels are live as `machine_verified` facts; they remain separate from
  human-reviewed Trusted evidence.
- Official brand discovery lane (`official-brand-discovery`,
  `protein-branded-discovery`): no-cost sitemap crawling into discovery
  records. The current catalog has 1,683 marketed-protein products, with 288
  calories-plus-protein comparisons; current source coverage remains incomplete.
- Replacement adapter-v8 (nutrition) and adapter-v3 (ingredient) artifacts
  with byte-hash-complete ledgers.
- Zero-cost local macro refresh is implemented and tested. It creates
  checksummed source-bounded runs plus a bounded local machine-label queue;
  it never publishes or deploys. Independent brand sources now use bounded
  parallelism (default four) without changing each brand's rate limit. A macOS
  launchd template is ready to install once a local data directory is chosen.
- MyFitness and Wellbeing Nutrition are configured first-party high-protein
  sources and scheduled discovery targets. The current 19-source local run
  stages their records but remains source-incomplete because official pages
  intermittently return 503 responses; nothing from it has been published.
- Local validation now merges the complete Open Food Facts snapshot with the
  16 complete first-party brand snapshots: 2,079 active products, 1,607
  protein-branded products, and 255 calories-plus-protein comparisons render
  correctly with default density sorting and product search. Machine-label v13
  is processing the 307 eligible Open Food Facts label images locally; nothing
  from this local work has been published.
- A separate first-party official-label pass has completed locally: four
  benchmarked Qwen v13 nutrition facts were applied to local D1, increasing
  comparable protein-branded foods to 259. Seventy-three model timeouts and
  eleven corroboration rejections remain unpublished; no result is represented
  as human verified or production data.
- Live dashboard audit is complete: the catalog is live, defaults to protein
  per 100 kcal, and no longer displays offers or cost metrics. Guarded release
  `127db2f` is live; coverage now repeatedly returns in 1.6–3.1 seconds and
  the default catalog query remains below one second.

## Blockers

- **DataKart:** official DataKart ingestion requires a commercial agreement
  and private API documentation (`PROJECT_STATUS.md` item 9).
- **Verified completeness from Open Food Facts alone:** impossible; current
  labels, brand-owner feeds, DataKart access, or manual verification are
  required for every remaining product (`PROJECT_STATUS.md` item 12).

## Unresolved questions

- Which historical adapter-v5/v6 runs and artifacts are explicitly denied for
  reuse? Cross-check `PROJECT_STATUS.md` before reusing any historical
  artifact.
- The exact `data:*` script surface grows with each feature; treat
  `package.json` as authoritative.

## Next steps

1. Continue current-label and brand-owner enrichment for the products still
   lacking a usable calories-plus-protein pair or an ingredient statement
   (`PROJECT_STATUS.md` item 11).
2. Run the machine verifier only against current, explicitly identified
   first-party nutrition labels; keep rejected and incomplete labels out of
   rankings.
3. Apply for GS1 India DataKart access and map its commercial/licensing
   constraints (`PROJECT_STATUS.md` item 3).
4. Keep a lightweight live desktop/mobile and accessibility smoke check in the
   release checklist as the catalog grows
5. Install the local launchd template with the chosen local data directory,
   then use the existing guarded publisher for any source-complete evidence
   release selected for the hosted dashboard.
   (`PROJECT_STATUS.md` item 2).

## Deferred

- ONDC offer ingestion until the core catalog and retailer reconciliation are
  stable (`PROJECT_STATUS.md` item 7).
- Expand the generic nutrient/product-kind model into full macros,
  micronutrients, raw foods, foodservice, prepared dishes, and recipes
  (`PROJECT_STATUS.md` item 8).

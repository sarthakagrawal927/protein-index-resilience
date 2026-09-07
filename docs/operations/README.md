---
title: Operations
description: Scheduled jobs, publication gates, deployment, and the runbooks that hold them together.
---

# Operations

Production operations are deliberately manual and gated. Producers run on
schedule or dispatch and never touch D1; publication is always a separate,
explicitly confirmed workflow; deployment is manual after preflight gates.

## Scheduled jobs

Two workflows run on a weekly cron. Everything else is `workflow_run`-triggered
from a successful source-sync, or manual dispatch.

| Cron | Workflow | Purpose |
| --- | --- | --- |
| Mon 02:23 UTC | `source-sync` | Stream official Open Food Facts TSV, stage products, emit exclusion ledger |
| Mon 03:19 UTC | `official-brand-discovery` | Crawl configured official brand sitemaps into discovery records |

The cron schedules live in the workflow files under
[`.github/workflows/`](../../.github/workflows/). Code is authoritative for
schedules; this table is a navigation aid.

## Workflow chain

```
source-sync (cron Mon 02:23 UTC)
   │  workflow_run: completed
   ├──► enrich-open-food-facts
   ├──► extract-robotoff          (nutrition candidates)
   └──► extract-robotoff-ingredients
                                        │
                                        ▼  checksummed artifacts in GitHub Actions storage
                                        │
   publish-catalog               (manual dispatch + confirm)  ◄── reviewed snapshot
   publish-enrichment            (manual dispatch + confirm)
   publish-reviewed-evidence     (manual dispatch + confirm)  ◄── review-decisions/ bundle
   publish-robotoff-candidates   (manual dispatch + confirm)  ◄── candidate artifact
   publish-guarded-reviewed-labels (manual dispatch + confirm) ◄── exact successor bundle
   publish-automatic-evidence    (manual dispatch + confirm)  ◄── successful producer run
   publish-official-brand-discoveries (manual dispatch + confirm) ◄── official-brand-discovery run
   publish-machine-evidence      (manual dispatch + confirm)  ◄── machine-evidence/ release bundle
```

Per-job reference: [jobs/](jobs/README.md).

## Local no-cost macro refresh

The local refresh is the zero-provider-cost producer for a machine that already
has the local Vision and Qwen label tools. It stages the complete Open Food
Facts India export, every configured first-party brand sitemap, and a bounded
queue of current protein-branded label images. It writes checksummed artifacts
under the selected local directory and **never** writes D1, deploys the Worker,
or reads production credentials.

```bash
pnpm data:macro-refresh --root /absolute/local/data/protein-index \
  --phase all --brand-concurrency 4 --label-limit 100 --run-labels
```

The final `runs/<timestamp>/report.json` reports each configured source,
whether the cohort is source-complete, the bounded label queue, and local model
outcomes. `marketComplete` is always false: the result is exhaustive only
within Open Food Facts plus the explicitly configured first-party sources.

`--brand-concurrency` defaults to `4` and may be set from `1` to `16`. It only
runs independent first-party brand jobs in parallel; each brand retains its
configured request interval, retry budget, and page ceiling. Use `1` for
serial diagnostics on a constrained network.

To schedule the job weekly on the local macOS model machine, create the log
directory, substitute both placeholders in
[`ops/com.proteinindex.macro-refresh.plist.template`](../../ops/com.proteinindex.macro-refresh.plist.template), and install it as a user agent:

```bash
mkdir -p /absolute/local/data/protein-index/logs
sed \
  -e "s|__REPOSITORY_ROOT__|$(pwd)|g" \
  -e "s|__LOCAL_DATA_ROOT__|/absolute/local/data/protein-index|g" \
  ops/com.proteinindex.macro-refresh.plist.template \
  > "$HOME/Library/LaunchAgents/com.proteinindex.macro-refresh.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.proteinindex.macro-refresh.plist"
```

The wrapper has an advisory local-directory lock, so overlapping launchd runs
exit safely. To stop it, run:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.proteinindex.macro-refresh.plist"
rm "$HOME/Library/LaunchAgents/com.proteinindex.macro-refresh.plist"
```

The existing guarded publication workflows remain the only paths that can put a
selected evidence bundle on the hosted dashboard.

## Publication gates

Every publication workflow enforces the same gate pattern, with a narrower or
broader authority boundary depending on the path:

1. **Dispatch from `main` only.**
2. **Explicit confirmation input** (type the exact phrase).
3. **Exact run / artifact / SHA / hash pinning** for the upstream producer
   output.
4. **Portable checksum + source/cohort accounting revalidation.**
5. **Pending-migration refusal** (the fresh-evidence path cannot apply
   migrations; only `publish-catalog` can).
6. **Idempotent D1 import** with exact pre/post state and live health/catalog
   checks retained for 90 days.
7. **No success claim on failure.** The same checksummed artifact remains
   replayable after investigation.

The fresh-evidence publication path has a deliberately narrower authority
boundary than reviewed catalog publication:

- Open Food Facts values remain unverified community evidence.
- Robotoff records remain review-only candidates with no selected facts.
- Existing verified rows cannot be overwritten; verified counts cannot
  increase.
- DataKart, retailer offers/ratings, review decisions, and Worker deployment
  are excluded.

See [publication runbook](runbooks/publication.md) for the step-by-step
procedure.

## Deployment

See the [September 7 code-only release](release-2026-09-07.md) for the maintained
guard invocation, exact deployed version and hosted provenance limits.

The production topology is one Worker (`protein-index`), one D1 database
(`protein-index`), and one private R2 bucket (`protein-index-labels`).

```bash
pnpm release:preflight
pnpm run deploy
```

`pnpm run deploy` runs the fleet deploy guard before tests, build, Worker
startup profiling, Wrangler dry run, and the strict deployment. Roll back
Worker code with `wrangler deployments rollback`; catalog corrections are
republished as new evidence-preserving runs instead of deleting the audit
trail.

Deployment is manual. `main` should stay releasable and green, but it is not an
automatic production trigger. See the fleet standard at `../AGENTS.md`.

## Runbooks

- [Publication](runbooks/publication.md) — publish reviewed evidence or a
  reviewed catalog snapshot to production D1.
- [Extraction](runbooks/extraction.md) — recover from a failed or partial
  label extraction run.
- [Drift audit](runbooks/drift-audit.md) — run the read-only reviewed-decision
  drift audit before publication.

## See also

- [Evidence pipeline](../architecture/evidence-pipeline.md) for what each
  workflow produces.
- [Decision log](../architecture/decisions/README.md) ADR-003 for why producer
  and publication are separated.

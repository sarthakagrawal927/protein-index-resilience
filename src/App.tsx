import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CatalogProduct,
  CatalogResponse,
  CompletionFamily,
  CompletionLane,
  CompletionLaneFilter,
  CompletionLedgerItem,
  CompletionLedgerResponse,
  CompletionState,
  CompletionStateFilter,
  CompletionSummary,
  CoverageResponse,
  HealthResponse,
  NutritionEvidenceStatus,
  ProductDetailResponse,
  ReviewDecision,
  ReviewItem,
  ReviewResponse,
  ReviewStatus,
  ReviewType,
} from "../shared/api";
import { NUTRITION_FIELDS } from "../shared/evidence-decisions";
import type { ReviewedNutritionProjection, SelectedNutritionProjection } from "../shared/evidence-decisions";
import type {
  TerminalEvidenceHistoryEntry,
  TerminalEvidenceOption,
  TerminalEvidenceOptionsResponse,
  TerminalUnavailableOutcome as ExactTerminalUnavailableOutcome,
} from "../shared/terminal-evidence";
import { validateNutrition } from "../shared/nutrition";
import type { EvidenceStatus, MetricResult, NormalizedIngredient, NutritionPer100g } from "../shared/types";
import { api, TerminalEvidenceRequestError } from "./api";

type Tab = "catalog" | "reviews" | "coverage";

export const initialFilters = {
  q: "",
  category: "all",
  trust: "all",
  verification: "all",
  ingredientVerification: "all",
  scope: "protein_branded",
  sort: "protein_density",
};

const COMPLETION_FAMILIES: Array<{ value: CompletionFamily; label: string }> = [
  { value: "nutrition", label: "Nutrition" },
  { value: "ingredients", label: "Ingredients" },
  { value: "identity", label: "Identity" },
];

const COMPLETION_STATES: Array<{ value: CompletionState; label: string; help: string }> = [
  { value: "verified", label: "Verified", help: "Current authority-100 evidence" },
  { value: "terminal_unavailable", label: "Evidence-backed unavailable", help: "Not declared or not applicable" },
  { value: "outstanding", label: "Outstanding", help: "Still needs a terminal evidence state" },
];

const COMPLETION_LANES: Array<{ value: CompletionLane; label: string }> = [
  { value: "evidence_inconsistent", label: "Evidence inconsistent" },
  { value: "conflict_resolution", label: "Resolve conflicts" },
  { value: "review_ready", label: "Ready for review" },
  { value: "retry_extraction", label: "Retry extraction" },
  { value: "run_extraction", label: "Run extraction" },
  { value: "manual_label_review", label: "Transcribe label" },
  { value: "structured_evidence_review", label: "Review structured evidence" },
  { value: "source_evidence_needed", label: "Find source evidence" },
];

const initialCompletionFilters = {
  family: "nutrition" as CompletionFamily,
  state: "outstanding" as CompletionStateFilter,
  lane: "all" as CompletionLaneFilter,
  q: "",
  page: 1,
  pageSize: 50,
};
type CompletionUiFilters = typeof initialCompletionFilters;

export function metricEvidenceLabel(status: NutritionEvidenceStatus): string {
  return status === "machine_verified" ? "machine-verified from label" : status === "verified" ? "verified nutrition" : status === "unverified" ? "unverified nutrition" : `${status} nutrition`;
}

export interface ReviewNutritionCandidate {
  predictionId: string;
  imageId: string;
  imageUrl: string;
  modelName: string;
  modelVersion: string;
  observedAt: string;
  basis: "per_100g" | "per_100ml" | "per_serving";
  normalizedBasis: "per_100g" | "per_100ml";
  minimumConfidence: number;
  nutrition: {
    calories: number | null;
    proteinGrams: number | null;
    carbohydrateGrams: number | null;
    sugarGrams: number | null;
    fatGrams: number | null;
    saturatedFatGrams: number | null;
    fibreGrams: number | null;
    sodiumMg: number | null;
  };
}

export interface ReviewIngredientCandidate {
  predictionId: string;
  entityIndex: number;
  imageId: string;
  imageUrl: string;
  modelName: string;
  modelVersion: string;
  predictedAt: string;
  observedAt: string;
  entityText: string;
  entityConfidence: number;
  language: { code: string; confidence: number };
  boundingBox: [number, number, number, number];
  parsedIngredients: unknown[];
  ingredientCount: number;
  knownIngredientCount: number;
  unknownIngredientCount: number;
  candidateHash: string;
  hasConflict: boolean;
  warnings: Array<{ code: string; message: string }>;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function reviewNutritionCandidate(evidence: unknown): ReviewNutritionCandidate | null {
  const root = object(evidence);
  if (root?.code !== "robotoff_nutrition_candidate") return null;
  const candidate = object(object(root.details)?.candidate);
  if (!candidate) return null;
  const massNutrition = object(candidate.nutritionPer100g);
  const volumeNutrition = object(candidate.nutritionPer100ml);
  if ((massNutrition === null) === (volumeNutrition === null)) return null;
  const nutrition = massNutrition ?? volumeNutrition;
  if (!nutrition) return null;
  const calories = nullableNumber(nutrition.calories);
  const proteinGrams = nullableNumber(nutrition.proteinGrams);
  const carbohydrateGrams = nullableNumber(nutrition.carbohydrateGrams);
  const sugarGrams = nullableNumber(nutrition.sugarGrams);
  const fatGrams = nullableNumber(nutrition.fatGrams);
  const saturatedFatGrams = nullableNumber(nutrition.saturatedFatGrams);
  const fibreGrams = nullableNumber(nutrition.fibreGrams);
  const sodiumMg = nullableNumber(nutrition.sodiumMg);
  if (
    calories === undefined || proteinGrams === undefined || carbohydrateGrams === undefined ||
    sugarGrams === undefined || fatGrams === undefined || saturatedFatGrams === undefined ||
    fibreGrams === undefined || sodiumMg === undefined
  ) return null;
  const basis = candidate.basis === "per_100g" || candidate.basis === "per_100ml" || candidate.basis === "per_serving"
    ? candidate.basis
    : null;
  const normalizedBasis = massNutrition ? "per_100g" as const : "per_100ml" as const;
  const compatibleBasis = massNutrition
    ? basis === "per_100g" || basis === "per_serving"
    : basis === "per_100ml" || basis === "per_serving";
  if (
    typeof candidate.predictionId !== "string" || !candidate.predictionId ||
    typeof candidate.imageId !== "string" || !candidate.imageId ||
    typeof candidate.imageUrl !== "string" ||
    typeof candidate.modelName !== "string" || !candidate.modelName ||
    typeof candidate.modelVersion !== "string" || !candidate.modelVersion ||
    typeof candidate.observedAt !== "string" || !Number.isFinite(Date.parse(candidate.observedAt)) ||
    !basis || !compatibleBasis || typeof candidate.minimumConfidence !== "number" ||
    !Number.isFinite(candidate.minimumConfidence) || candidate.minimumConfidence < 0 || candidate.minimumConfidence > 1
  ) return null;
  try {
    if (new URL(candidate.imageUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    predictionId: candidate.predictionId,
    imageId: candidate.imageId,
    imageUrl: candidate.imageUrl,
    modelName: candidate.modelName,
    modelVersion: candidate.modelVersion,
    observedAt: candidate.observedAt,
    basis,
    normalizedBasis,
    minimumConfidence: candidate.minimumConfidence,
    nutrition: { calories, proteinGrams, carbohydrateGrams, sugarGrams, fatGrams, saturatedFatGrams, fibreGrams, sodiumMg },
  };
}

export function reviewIngredientCandidate(evidence: unknown): ReviewIngredientCandidate | null {
  const root = object(evidence);
  if (root?.code !== "robotoff_ingredient_candidate") return null;
  const details = object(root.details);
  const candidate = object(details?.candidate);
  const language = object(candidate?.language);
  const boundingBox = candidate?.boundingBox;
  const parsedIngredients = candidate?.parsedIngredients;
  if (
    !candidate || !language || !Array.isArray(boundingBox) || boundingBox.length !== 4 ||
    !boundingBox.every((value) => typeof value === "number" && Number.isFinite(value)) ||
    !Array.isArray(parsedIngredients) || typeof details?.candidateHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(details.candidateHash) ||
    typeof candidate.predictionId !== "string" || !candidate.predictionId ||
    typeof candidate.entityIndex !== "number" || !Number.isInteger(candidate.entityIndex) || candidate.entityIndex < 0 ||
    typeof candidate.imageId !== "string" || !candidate.imageId ||
    typeof candidate.imageUrl !== "string" ||
    typeof candidate.modelName !== "string" || !candidate.modelName ||
    typeof candidate.modelVersion !== "string" || !candidate.modelVersion ||
    typeof candidate.predictedAt !== "string" || !Number.isFinite(Date.parse(candidate.predictedAt)) ||
    typeof candidate.observedAt !== "string" || !Number.isFinite(Date.parse(candidate.observedAt)) ||
    typeof candidate.entityText !== "string" || !candidate.entityText.trim() ||
    typeof candidate.entityConfidence !== "number" || candidate.entityConfidence < 0 || candidate.entityConfidence > 1 ||
    typeof language.code !== "string" || !language.code ||
    typeof language.confidence !== "number" || language.confidence < 0 || language.confidence > 1 ||
    typeof candidate.ingredientCount !== "number" || !Number.isInteger(candidate.ingredientCount) || candidate.ingredientCount < 0 ||
    typeof candidate.knownIngredientCount !== "number" || !Number.isInteger(candidate.knownIngredientCount) || candidate.knownIngredientCount < 0 ||
    typeof candidate.unknownIngredientCount !== "number" || !Number.isInteger(candidate.unknownIngredientCount) || candidate.unknownIngredientCount < 0
  ) return null;
  try {
    if (new URL(candidate.imageUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }
  const warnings = Array.isArray(details.warnings)
    ? details.warnings.flatMap((warning) => {
      const item = object(warning);
      return typeof item?.code === "string" && typeof item.message === "string"
        ? [{ code: item.code, message: item.message }]
        : [];
    })
    : [];
  return {
    predictionId: candidate.predictionId,
    entityIndex: candidate.entityIndex,
    imageId: candidate.imageId,
    imageUrl: candidate.imageUrl,
    modelName: candidate.modelName,
    modelVersion: candidate.modelVersion,
    predictedAt: candidate.predictedAt,
    observedAt: candidate.observedAt,
    entityText: candidate.entityText,
    entityConfidence: candidate.entityConfidence,
    language: { code: language.code, confidence: language.confidence },
    boundingBox: boundingBox as [number, number, number, number],
    parsedIngredients,
    ingredientCount: candidate.ingredientCount,
    knownIngredientCount: candidate.knownIngredientCount,
    unknownIngredientCount: candidate.unknownIngredientCount,
    candidateHash: details.candidateHash,
    hasConflict: details.hasConflict === true,
    warnings,
  };
}

function formatNumber(value: number | null, digits = 1): string {
  return value === null ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(value);
}

function metric(result: MetricResult, suffix = ""): string {
  return result.value === null ? "—" : `${formatNumber(result.value, 2)}${suffix}`;
}

function nutritionBasisLabel(basis: CatalogProduct["nutrition"]["basis"]): string {
  return basis === "per_100ml" ? "per 100 ml" : basis === "per_serving" ? "per serving" : basis === "per_100g" ? "per 100 g" : "declared basis not stated";
}

export function publicEvidenceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function nutrientDisplayName(code: string): string {
  const label = code.replaceAll("_", " ").replaceAll("-", " ").trim();
  return label ? `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}` : "Nutrient";
}

function MetricValue({ result, prefix = "", suffix = "" }: { result: MetricResult; prefix?: string; suffix?: string }) {
  if (result.value === null) {
    return <span className="metric-unavailable">Unavailable<small>{(result.reason ?? "missing inputs").replaceAll("_", " ")}</small></span>;
  }
  return <>{prefix}{formatNumber(result.value, 2)}{suffix}</>;
}

function StatusBadge({ status }: { status: EvidenceStatus | NutritionEvidenceStatus }) {
  return <span className={`status status-${status}`}><i aria-hidden="true" />{status}</span>;
}

export function lookupDestination(query: string, products: CatalogProduct[]): { kind: "open"; productId: string } | { kind: "catalog"; query: string } {
  return products.length === 1 ? { kind: "open", productId: products[0]!.id } : { kind: "catalog", query: query.trim() };
}

export function HeaderProductLookup({ query, products, loading, error, onQuery, onSelect, onSubmit }: {
  query: string;
  products: CatalogProduct[];
  loading: boolean;
  error: string | null;
  onQuery: (query: string) => void;
  onSelect: (product: CatalogProduct) => void;
  onSubmit: () => void;
}) {
  const active = query.trim().length >= 2;
  return (
    <form className="header-lookup" role="search" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <label htmlFor="header-product-lookup"><span className="sr-only">Quick product lookup</span><input id="header-product-lookup" name="productLookup" type="search" role="combobox" aria-autocomplete="list" aria-expanded={active} aria-controls="header-product-lookup-results" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Check a product, brand, or barcode" /></label>
      <button type="submit" aria-label="Search products">Search</button>
      {active && <div id="header-product-lookup-results" className="header-lookup-results" role="listbox" aria-label="Product matches">
        {loading && <span className="header-lookup-note" role="status">Checking the index…</span>}
        {error && <span className="header-lookup-note header-lookup-error" role="alert">{error}</span>}
        {!loading && !error && products.length === 0 && <span className="header-lookup-note">No exact catalog match yet. Search all results.</span>}
        {!loading && !error && products.map((product) => <button type="button" key={product.id} role="option" aria-selected="false" onClick={() => onSelect(product)}><span><strong>{product.name}</strong><small>{product.brand}{product.flavour ? ` · ${product.flavour}` : ""}</small></span><em>{metricEvidenceLabel(product.nutritionStatus)}</em></button>)}
        {!loading && !error && products.length > 1 && <span className="header-lookup-note">Multiple matches — search all results for the full list.</span>}
      </div>}
    </form>
  );
}

function IngredientStatusBadge({ product }: { product: Pick<CatalogProduct, "ingredientStatus" | "ingredientTerminalOutcome"> }) {
  if (product.ingredientTerminalOutcome) {
    return <span className="status status-verified"><i aria-hidden="true" />{product.ingredientTerminalOutcome.replaceAll("_", " ")}</span>;
  }
  return <StatusBadge status={product.ingredientStatus} />;
}

function ProductVisual({ product, size = "small" }: { product: Pick<CatalogProduct, "imageUrl" | "brand" | "name">; size?: "small" | "large" }) {
  const [failed, setFailed] = useState(false);
  const initials = `${product.brand} ${product.name}`.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase()).join("");
  return (
    <div className={`product-visual product-visual-${size}`} aria-hidden="true">
      {product.imageUrl && !failed
        ? <img src={product.imageUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
        : <span>{initials || "PI"}</span>}
    </div>
  );
}

function ClassificationBadges({ product }: { product: CatalogProduct }) {
  return (
    <div className="badge-row">
      {product.marketedProtein && <span className="tag tag-market">marketed protein</span>}
      {product.nutritionallyProteinDense === true && <span className="tag tag-dense">protein-dense</span>}
    </div>
  );
}

export function CatalogTable({ data, onOpen, onExplore, page, onPage }: {
  data: CatalogResponse;
  onOpen: (id: string) => void;
  onExplore: () => void;
  page: number;
  onPage: (page: number) => void;
}) {
  if (data.products.length === 0) {
    return (
      <div className="empty empty-catalog">
        <span className="empty-mark" aria-hidden="true">0</span>
        <strong>{data.trustedDefault ? "No fully trusted products yet." : "No products match this view."}</strong>
        <span>{data.trustedDefault ? "Trusted comparisons require exact current identity, verified nutrition, and terminal ingredient evidence." : "Try a broader category, scope, or evidence filter."}</span>
        {data.trustedDefault && <button onClick={onExplore}>Explore the discovery catalog</button>}
      </div>
    );
  }
  return (
    <>
      <div className="table-wrap catalog-desktop">
        <table>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Protein / 100 kcal</th>
            <th scope="col">Protein</th>
            <th scope="col">Carbs</th>
            <th scope="col">Fat</th>
            <th scope="col">Fibre</th>
            <th scope="col">Calories</th>
          </tr>
        </thead>
        <tbody>
          {data.products.map((product) => (
            <tr key={product.id}>
              <td className="product-cell">
                <div className="product-identity"><ProductVisual product={product} /><div><button className="product-link" onClick={() => onOpen(product.id)}><strong>{product.name}</strong><span>{product.brand}{product.flavour ? ` · ${product.flavour}` : ""}</span></button><ClassificationBadges product={product} /></div></div>
              </td>
              <td className="metric-primary"><strong>{metric(product.metrics.proteinPer100Calories, " g")}</strong><small>{metricEvidenceLabel(product.nutritionStatus)}</small></td>
              <td><strong>{formatNumber(product.nutrition.proteinGrams)} g</strong><small>{nutritionBasisLabel(product.nutrition.basis)}</small></td>
              <td><strong>{formatNumber(product.nutrition.carbohydrateGrams)} g</strong><small>{nutritionBasisLabel(product.nutrition.basis)}</small></td>
              <td><strong>{formatNumber(product.nutrition.fatGrams)} g</strong><small>{nutritionBasisLabel(product.nutrition.basis)}</small></td>
              <td><strong>{formatNumber(product.nutrition.fibreGrams)} g</strong><small>{nutritionBasisLabel(product.nutrition.basis)}</small></td>
              <td><strong>{product.nutrition.calories === null ? "—" : `${formatNumber(product.nutrition.calories)} kcal`}</strong><small>{nutritionBasisLabel(product.nutrition.basis)}</small></td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      <div className="catalog-mobile" aria-label="Catalog products">
        {data.products.map((product) => (
          <article className="product-card" key={product.id}>
            <button className="product-card-main" onClick={() => onOpen(product.id)}>
              <ProductVisual product={product} />
              <span className="product-card-copy"><small>{product.brand}</small><strong>{product.name}</strong><em>{product.flavour ?? product.category.replaceAll("_", " ")}</em></span>
              <span className="card-arrow" aria-hidden="true">↗</span>
            </button>
            <div className="product-card-metric"><strong>{metric(product.metrics.proteinPer100Calories, " g")}</strong><span>protein / 100 kcal</span><small>{metricEvidenceLabel(product.nutritionStatus)}</small></div>
            <div className="product-card-macros" aria-label={`Macros per ${nutritionBasisLabel(product.nutrition.basis)}`}>
              {[["Protein", product.nutrition.proteinGrams], ["Carbs", product.nutrition.carbohydrateGrams], ["Fat", product.nutrition.fatGrams], ["Fibre", product.nutrition.fibreGrams], ["Calories", product.nutrition.calories]].map(([label, value]) => <span key={String(label)}><small>{label}</small><strong>{formatNumber(value as number | null)}{label === "Calories" ? " kcal" : " g"}</strong></span>)}
            </div>
          </article>
        ))}
      </div>
      {data.pagination.pages > 1 && <nav className="pagination" aria-label="Catalog pages"><button disabled={page <= 1} onClick={() => onPage(page - 1)}>← Previous</button><span>Page <strong>{page}</strong> of {data.pagination.pages.toLocaleString("en-IN")}</span><button disabled={page >= data.pagination.pages} onClick={() => onPage(page + 1)}>Next →</button></nav>}
    </>
  );
}

function IngredientTree({ items }: { items: NormalizedIngredient[] }) {
  if (items.length === 0) return <p className="muted">No normalized ingredients available.</p>;
  return (
    <ol className="ingredients-list">
      {items.map((item) => (
        <li key={`${item.position}-${item.raw}`}>
          <span>{item.normalizedName ?? item.raw}</span>
          {item.percentage !== null && <b>{item.percentage}%</b>}
          {item.children.length > 0 && <IngredientTree items={item.children} />}
        </li>
      ))}
    </ol>
  );
}

export function ProductDrawer({ detail, loading, error, onClose }: {
  detail: ProductDetailResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const evidenceUrl = publicEvidenceUrl(detail?.nutritionEvidenceUrl ?? null);
  const observedAt = detail?.nutrition.observedAt;
  const observedDate = observedAt && Number.isFinite(Date.parse(observedAt)) ? new Date(observedAt).toISOString().slice(0, 10) : null;
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-label="Product evidence detail">
        <button ref={closeRef} className="close" onClick={onClose} aria-label="Close product detail">×</button>
        {loading && <div className="loading" role="status">Loading product evidence…</div>}
        {error && <div className="error-state" role="alert">{error}</div>}
        {detail && (
          <>
            <header className="detail-head">
              <ProductVisual product={detail} size="large" />
              <div><p className="eyebrow">{detail.brand} · {detail.category.replaceAll("_", " ")}</p><h2>{detail.name}</h2><p>{detail.flavour ?? "No flavour declared"} · GTIN {detail.gtin ?? "not recorded"}</p><div className="product-pack-meta"><span><small>Pack size</small><strong>{detail.netQuantityGrams === null ? "Not recorded" : `${formatNumber(detail.netQuantityGrams, 0)} g`}</strong></span><span><small>Serving size</small><strong>{detail.servingSizeGrams === null ? "Not recorded" : `${formatNumber(detail.servingSizeGrams, 1)} g`}</strong></span></div><ClassificationBadges product={detail} /></div>
            </header>

            <section>
              <div className="section-title"><div><h3>Macros · {nutritionBasisLabel(detail.nutrition.basis)}</h3><small>Per declared nutrition basis</small></div></div>
              <div className="nutrition-evidence" aria-label="Nutrition evidence">
                <p><strong>{metricEvidenceLabel(detail.nutritionStatus)}</strong></p>
                <p>{detail.nutritionEvidenceAuthority === "human_reviewed_label" ? "Human-reviewed label." : detail.nutritionEvidenceAuthority === "authoritative_source" ? "Authoritative source record." : detail.nutritionEvidenceAuthority === "machine_verified_label" ? "Machine-checked label; not human reviewed." : detail.nutritionEvidenceAuthority === "first_party_structured_source" ? "Brand-provided structured data; not a human-reviewed label." : detail.nutritionEvidenceAuthority === "community" ? "Community-provided data." : "Evidence authority not recorded."}</p>
                <p>{evidenceUrl ? <a href={evidenceUrl} target="_blank" rel="noreferrer">{detail.nutritionEvidenceKind === "label" ? "View original nutrition label" : "View nutrition source"} ↗</a> : "Original nutrition source link unavailable."}</p>
                <small>{observedDate ? <>Observed <time dateTime={observedAt ?? undefined}>{observedDate}</time></> : "Observation date unavailable."}</small>
              </div>
              <div className="nutrition-grid">
                {[
                  ["Protein", detail.nutrition.proteinGrams, "g"],
                  ["Carbohydrate", detail.nutrition.carbohydrateGrams, "g"],
                  ["Fat", detail.nutrition.fatGrams, "g"],
                  ["Fibre", detail.nutrition.fibreGrams, "g"],
                  ["Calories", detail.nutrition.calories, "kcal"],
                ].map(([label, value, unit]) => <div key={String(label)}><span>{label}</span><strong>{formatNumber(value as number | null)} {unit}</strong></div>)}
              </div>
            </section>

            <section>
              <h3>Protein density</h3>
              <p>Calculated from the macros above; the same evidence status applies.</p>
              <div className="metric-grid">
                <div><span>Protein / 100 kcal</span><strong><MetricValue result={detail.metrics.proteinPer100Calories} suffix=" g" /></strong></div>
              </div>
            </section>

            <section aria-label="Original catalog sources">
              <h3>Original catalog sources</h3>
              <p>Records associated with this product. These links do not verify the macros above.</p>
              {detail.sourceRecords.length === 0 ? <p>No source records available.</p> : <ul>
                {detail.sourceRecords.map((record) => {
                  const url = publicEvidenceUrl(record.sourceUrl);
                  const date = Number.isFinite(Date.parse(record.observedAt)) ? new Date(record.observedAt).toISOString().slice(0, 10) : null;
                  return <li key={record.id}>
                    {url ? <a href={url} target="_blank" rel="noreferrer">{record.source.replaceAll("_", " ")} ↗</a> : <span>{record.source.replaceAll("_", " ")} · source link unavailable</span>}
                    {date ? <> · observed <time dateTime={record.observedAt}>{date}</time></> : " · observation date unavailable"}
                  </li>;
                })}
              </ul>}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

function NutritionCandidateEvidence({ candidate, productName, editor = null }: { candidate: ReviewNutritionCandidate; productName: string | null; editor?: ReactNode }) {
  const rows: Array<[string, number | null, string]> = [
    ["Energy", candidate.nutrition.calories, "kcal"],
    ["Protein", candidate.nutrition.proteinGrams, "g"],
    ["Carbohydrate", candidate.nutrition.carbohydrateGrams, "g"],
    ["Sugar", candidate.nutrition.sugarGrams, "g"],
    ["Fat", candidate.nutrition.fatGrams, "g"],
    ["Saturated fat", candidate.nutrition.saturatedFatGrams, "g"],
    ["Fibre", candidate.nutrition.fibreGrams, "g"],
    ["Sodium", candidate.nutrition.sodiumMg, "mg"],
  ];
  const normalizedLabel = candidate.normalizedBasis === "per_100ml" ? "per 100 mL" : "per 100 g";
  return (
    <section className="nutrition-candidate" aria-label="Extracted nutrition candidate">
      <a className="candidate-label" href={candidate.imageUrl} target="_blank" rel="noreferrer">
        <img src={candidate.imageUrl} alt={`Nutrition label evidence for ${productName ?? "product"}`} loading="lazy" referrerPolicy="no-referrer" />
        <span>Open full label ↗</span>
      </a>
      <div className="candidate-evidence">
        <div className="candidate-evidence-head">
          <div><span className="eyebrow">Review candidate</span><h4>Extracted {normalizedLabel}</h4></div>
          <span className="confidence">{formatNumber(candidate.minimumConfidence * 100, 1)}% min confidence</span>
        </div>
        <div className="candidate-nutrition-grid">
          {rows.map(([label, value, unit]) => <div key={label}><span>{label}</span><strong>{formatNumber(value)} {unit}</strong></div>)}
        </div>
        <dl className="candidate-meta">
          <div><dt>Label observed</dt><dd>{new Date(candidate.observedAt).toLocaleString("en-IN")}</dd></div>
          <div><dt>Normalization</dt><dd>{candidate.basis === "per_serving" ? `Converted from an explicit serving to ${normalizedLabel}` : `Explicit ${normalizedLabel} values`}</dd></div>
          <div><dt>Model evidence</dt><dd>{candidate.modelVersion} · prediction {candidate.predictionId} · image {candidate.imageId}</dd></div>
        </dl>
        <p className="candidate-warning"><strong>Human check required.</strong> Confirm this is the current package and every displayed value matches the label before verification.</p>
        {editor}
      </div>
    </section>
  );
}

type NutritionField = (typeof NUTRITION_FIELDS)[number];
type NutritionDraftValues = Record<NutritionField, string>;

export interface NutritionReviewDraft {
  basis: "per_100g" | "per_100ml";
  values: NutritionDraftValues;
}

export interface NutritionDraftResult {
  projection: ReviewedNutritionProjection | null;
  errors: Partial<Record<NutritionField | "form", string>>;
}

export interface NutritionFieldChange {
  field: NutritionField;
  originalValue: number | null;
  reviewedValue: number | null;
}

const NUTRITION_EDITOR_FIELDS: Array<{ field: NutritionField; label: string; unit: string; required: boolean }> = [
  { field: "calories", label: "Energy", unit: "kcal", required: true },
  { field: "proteinGrams", label: "Protein", unit: "g", required: true },
  { field: "carbohydrateGrams", label: "Carbohydrate", unit: "g", required: false },
  { field: "sugarGrams", label: "Sugar", unit: "g", required: false },
  { field: "fatGrams", label: "Fat", unit: "g", required: false },
  { field: "saturatedFatGrams", label: "Saturated fat", unit: "g", required: false },
  { field: "fibreGrams", label: "Fibre", unit: "g", required: false },
  { field: "sodiumMg", label: "Sodium", unit: "mg", required: false },
];

export function nutritionDraftFromCandidate(candidate: ReviewNutritionCandidate): NutritionReviewDraft {
  return {
    basis: candidate.normalizedBasis,
    values: Object.fromEntries(NUTRITION_FIELDS.map((field) => [
      field,
      candidate.nutrition[field] === null ? "" : String(candidate.nutrition[field]),
    ])) as NutritionDraftValues,
  };
}

export function reviewedProjectionFromDraft(draft: NutritionReviewDraft): NutritionDraftResult {
  const errors: NutritionDraftResult["errors"] = {};
  const nutrition = {} as NutritionPer100g;

  for (const { field, required } of NUTRITION_EDITOR_FIELDS) {
    const raw = draft.values[field].trim();
    if (!raw) {
      nutrition[field] = null;
      if (required) errors[field] = "Required for verified nutrition.";
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      nutrition[field] = null;
      errors[field] = "Enter a finite, non-negative number.";
      continue;
    }
    nutrition[field] = value;
  }

  if (Object.keys(errors).length === 0) {
    for (const issue of validateNutrition(nutrition, draft.basis)) {
      if (issue.severity !== "error") continue;
      const field = NUTRITION_FIELDS.includes(issue.field as NutritionField)
        ? issue.field as NutritionField
        : "form";
      errors[field] = issue.message;
    }
  }

  if (Object.keys(errors).length > 0) return { projection: null, errors };
  return {
    projection: draft.basis === "per_100g"
      ? { basis: "per_100g", nutritionPer100g: nutrition }
      : { basis: "per_100ml", nutritionPer100ml: nutrition },
    errors,
  };
}

function reviewedProjectionValues(projection: ReviewedNutritionProjection): NutritionPer100g {
  return projection.basis === "per_100g" ? projection.nutritionPer100g : projection.nutritionPer100ml;
}

export function nutritionFieldChanges(candidate: ReviewNutritionCandidate, projection: ReviewedNutritionProjection): NutritionFieldChange[] {
  const reviewed = reviewedProjectionValues(projection);
  return NUTRITION_FIELDS.flatMap((field) => candidate.nutrition[field] === reviewed[field]
    ? []
    : [{ field, originalValue: candidate.nutrition[field], reviewedValue: reviewed[field] }]);
}

function nutritionFieldLabel(field: NutritionField): string {
  return NUTRITION_EDITOR_FIELDS.find((entry) => entry.field === field)?.label ?? field;
}

function nutritionFieldValue(value: number | null, field: NutritionField): string {
  if (value === null) return "Not declared";
  return `${formatNumber(value)} ${field === "calories" ? "kcal" : field === "sodiumMg" ? "mg" : "g"}`;
}

export function NutritionCorrectionConfirmation({
  reviewId,
  candidate,
  projection,
  changes,
  working,
  onConfirm,
  onCancel,
}: {
  reviewId: string;
  candidate: ReviewNutritionCandidate;
  projection: ReviewedNutritionProjection;
  changes: NutritionFieldChange[];
  working: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const basisChanged = candidate.normalizedBasis !== projection.basis;
  return (
    <div className="nutrition-correction-confirmation" role="alertdialog" aria-modal="true" aria-labelledby={`nutrition-confirm-${reviewId}`} aria-describedby={`nutrition-confirm-description-${reviewId}`}>
      <strong id={`nutrition-confirm-${reviewId}`}>Confirm corrected label values</strong>
      <p id={`nutrition-confirm-description-${reviewId}`}>This creates verified nutrition from the reviewer-entered values and retains the model output in the audit trail.</p>
      {basisChanged && <p className="basis-change"><b>Basis changed:</b> {candidate.normalizedBasis === "per_100g" ? "per 100 g" : "per 100 mL"} → {projection.basis === "per_100g" ? "per 100 g" : "per 100 mL"}</p>}
      <ul>{changes.map((change) => <li key={change.field}><span>{nutritionFieldLabel(change.field)}</span><del>{nutritionFieldValue(change.originalValue, change.field)}</del><strong>{nutritionFieldValue(change.reviewedValue, change.field)}</strong></li>)}</ul>
      <div><button autoFocus disabled={working} onClick={onConfirm}>Confirm corrected values</button><button className="ghost" disabled={working} onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

export function NutritionCorrectionEditor({
  reviewId,
  candidate,
  rationale,
  working,
  onSubmit,
}: {
  reviewId: string;
  candidate: ReviewNutritionCandidate;
  rationale: string;
  working: boolean;
  onSubmit: (projection: ReviewedNutritionProjection) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<NutritionReviewDraft>(() => nutritionDraftFromCandidate(candidate));
  const [confirming, setConfirming] = useState(false);
  const result = reviewedProjectionFromDraft(draft);
  const changes = result.projection ? nutritionFieldChanges(candidate, result.projection) : [];
  const basisChanged = draft.basis !== candidate.normalizedBasis;
  const hasChanges = basisChanged || changes.length > 0;

  const openConfirmation = () => {
    if (!result.projection || !hasChanges || rationale.trim().length < 3) return;
    setConfirming(true);
  };
  const confirm = async () => {
    if (!result.projection) return;
    if (await onSubmit(result.projection)) setConfirming(false);
  };

  return (
    <section className="nutrition-correction" aria-labelledby={`nutrition-correction-${reviewId}`}>
      <div className="nutrition-correction-head"><div><span className="eyebrow">Correction path</span><h4 id={`nutrition-correction-${reviewId}`}>Transcribe what the label actually says</h4></div><span>{hasChanges ? `${changes.length + (basisChanged ? 1 : 0)} change${changes.length + (basisChanged ? 1 : 0) === 1 ? "" : "s"}` : "No changes"}</span></div>
      <p>Only use this when the model output is wrong. Blank optional fields are stored explicitly as not declared.</p>
      <label className={basisChanged ? "nutrition-edit-changed" : ""} htmlFor={`nutrition-basis-${reviewId}`}>Nutrition basis {basisChanged && <small>Changed</small>}<select id={`nutrition-basis-${reviewId}`} value={draft.basis} onChange={(event) => setDraft((current) => ({ ...current, basis: event.target.value as NutritionReviewDraft["basis"] }))}><option value="per_100g">Per 100 g</option><option value="per_100ml">Per 100 mL</option></select></label>
      <div className="nutrition-editor-grid">
        {NUTRITION_EDITOR_FIELDS.map(({ field, label, unit, required }) => {
          const original = candidate.nutrition[field];
          const raw = draft.values[field].trim();
          const parsed = raw === "" ? null : Number(raw);
          const changed = Number.isFinite(parsed) ? parsed !== original : raw === "" && original !== null;
          const error = result.errors[field];
          const describedBy = `${reviewId}-${field}-${error ? "error" : raw === "" && !required ? "null" : "hint"}`;
          return <label className={changed ? "nutrition-edit-changed" : ""} htmlFor={`${reviewId}-${field}`} key={field}><span>{label}{required ? " *" : ""}<small>{changed ? "Changed" : unit}</small></span><input id={`${reviewId}-${field}`} type="number" inputMode="decimal" min="0" step="any" value={draft.values[field]} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => setDraft((current) => ({ ...current, values: { ...current.values, [field]: event.target.value } }))} />{error ? <em id={describedBy} role="alert">{error}</em> : raw === "" && !required ? <em id={describedBy}>Not declared (explicit null)</em> : <em id={describedBy}>Original: {nutritionFieldValue(original, field)}</em>}</label>;
        })}
      </div>
      {result.errors.form && <div className="nutrition-form-error" role="alert">{result.errors.form}</div>}
      <button className="corrected-verification" disabled={working || !result.projection || !hasChanges || rationale.trim().length < 3} onClick={openConfirmation} aria-haspopup="dialog">Review corrected verification</button>
      {rationale.trim().length < 3 && <small className="nutrition-correction-help">Add a rationale of at least 3 characters before reviewing the correction.</small>}
      {confirming && result.projection && <NutritionCorrectionConfirmation reviewId={reviewId} candidate={candidate} projection={result.projection} changes={changes} working={working} onConfirm={confirm} onCancel={() => setConfirming(false)} />}
    </section>
  );
}

export function ReviewedNutritionHistory({ item }: { item: ReviewItem }) {
  if (!item.reviewedProjection) return null;
  const changes = item.nutritionChanges ?? [];
  const values = reviewedProjectionValues(item.reviewedProjection);
  return (
    <section className="reviewed-nutrition-history" aria-label="Published reviewer-corrected nutrition">
      <div><span className="eyebrow">Published correction</span><strong>{item.reviewedProjection.basis === "per_100g" ? "Per 100 g" : "Per 100 mL"}</strong></div>
      <p>{changes.length > 0 ? `${changes.length} nutrition field${changes.length === 1 ? "" : "s"} changed from the model extraction.` : "Reviewer-corrected values were published from this label."}</p>
      <div>{NUTRITION_EDITOR_FIELDS.map(({ field, label }) => <span key={field}><small>{label}</small><b>{nutritionFieldValue(values[field], field)}</b></span>)}</div>
    </section>
  );
}

function IngredientCandidateEvidence({
  candidate,
  productName,
  reviewedText,
  onReviewedText,
  readOnly,
}: {
  candidate: ReviewIngredientCandidate;
  productName: string | null;
  reviewedText: string;
  onReviewedText: (value: string) => void;
  readOnly: boolean;
}) {
  const recognized = candidate.ingredientCount > 0
    ? candidate.knownIngredientCount / candidate.ingredientCount * 100
    : 0;
  return (
    <section className="ingredient-candidate" aria-label="Extracted ingredient candidate">
      <a className="candidate-label ingredient-label" href={candidate.imageUrl} target="_blank" rel="noreferrer">
        <img src={candidate.imageUrl} alt={`Ingredient label evidence for ${productName ?? "product"}`} loading="lazy" referrerPolicy="no-referrer" />
        <span>Open full label ↗</span>
      </a>
      <div className="candidate-evidence ingredient-evidence">
        <div className="candidate-evidence-head">
          <div><span className="eyebrow">Human transcription gate</span><h4>Image beside extracted text</h4></div>
          <span className={`confidence${candidate.hasConflict ? " confidence-conflict" : ""}`}>
            {candidate.hasConflict ? "conflicting images" : `${formatNumber(candidate.entityConfidence * 100, 2)}% OCR confidence`}
          </span>
        </div>
        <div className="ingredient-text-compare">
          <div>
            <span>Immutable model extraction</span>
            <p>{candidate.entityText}</p>
          </div>
          <label htmlFor={`reviewed-text-${candidate.candidateHash}`}>
            Reviewer-confirmed visible label text
            <textarea
              id={`reviewed-text-${candidate.candidateHash}`}
              name={`reviewedText-${candidate.candidateHash}`}
              value={reviewedText}
              onChange={(event) => onReviewedText(event.target.value)}
              readOnly={readOnly}
              maxLength={25_000}
              rows={6}
              aria-describedby={`ingredient-help-${candidate.candidateHash}`}
            />
          </label>
        </div>
        <p className="candidate-warning" id={`ingredient-help-${candidate.candidateHash}`}>
          <strong>Do not trust confidence alone.</strong> Correct every visible OCR error; reject the candidate if this image is cropped, unreadable, or a different variant.
        </p>
        <div className="ingredient-counts" aria-label="Ingredient extraction counts">
          <div><span>Detected</span><strong>{candidate.ingredientCount}</strong></div>
          <div><span>Known</span><strong>{candidate.knownIngredientCount}</strong></div>
          <div><span>Unknown</span><strong>{candidate.unknownIngredientCount}</strong></div>
          <div><span>Taxonomy match</span><strong>{formatNumber(recognized, 1)}%</strong></div>
        </div>
        {candidate.warnings.length > 0 && <ul className="candidate-warnings">
          {candidate.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><strong>{warning.code.replaceAll("_", " ")}</strong><span>{warning.message}</span></li>)}
        </ul>}
        <details className="parsed-ingredient-tree">
          <summary>Inspect source-parsed ingredient tree</summary>
          <pre>{JSON.stringify(candidate.parsedIngredients, null, 2)}</pre>
        </details>
        <dl className="candidate-meta">
          <div><dt>Label observed</dt><dd>{new Date(candidate.observedAt).toLocaleString("en-IN")}</dd></div>
          <div><dt>Language</dt><dd>{candidate.language.code} · {formatNumber(candidate.language.confidence * 100, 1)}% confidence</dd></div>
          <div><dt>Model evidence</dt><dd>{candidate.modelVersion} · prediction {candidate.predictionId} · entity {candidate.entityIndex} · image {candidate.imageId}</dd></div>
          <div><dt>Candidate hash</dt><dd><code>{candidate.candidateHash}</code></dd></div>
        </dl>
      </div>
    </section>
  );
}

type ReviewTypeFilter = ReviewType | "all";

const REVIEW_TYPE_OPTIONS: Array<{ value: ReviewTypeFilter; label: string }> = [
  { value: "all", label: "All evidence types" },
  { value: "nutrition_validation", label: "Nutrition validation" },
  { value: "nutrition_conflict", label: "Nutrition conflicts" },
  { value: "ingredient_conflict", label: "Ingredient evidence" },
  { value: "coverage_gap", label: "Coverage gaps" },
  { value: "identity", label: "Identity matching" },
  { value: "invalid_gtin", label: "Invalid GTIN" },
];

const REVIEW_STATUS_OPTIONS: Array<{ value: ReviewStatus; label: string }> = [
  { value: "open", label: "Open evidence" },
  { value: "resolved", label: "Decision history" },
  { value: "dismissed", label: "Dismissed evidence" },
];

function SelectedProjection({ projection }: { projection: SelectedNutritionProjection }) {
  const rows: Array<[string, number | null, string]> = [
    ["Energy", projection.nutrition.calories, "kcal"],
    ["Protein", projection.nutrition.proteinGrams, "g"],
    ["Carbohydrate", projection.nutrition.carbohydrateGrams, "g"],
    ["Sugar", projection.nutrition.sugarGrams, "g"],
    ["Fat", projection.nutrition.fatGrams, "g"],
    ["Saturated fat", projection.nutrition.saturatedFatGrams, "g"],
    ["Fibre", projection.nutrition.fibreGrams, "g"],
    ["Sodium", projection.nutrition.sodiumMg, "mg"],
  ];
  return (
    <div className="selected-projection" aria-label="Currently selected nutrition projection">
      <div className="selected-projection-head"><strong>Current selected projection</strong><span>{projection.basis === "per_100ml" ? "per 100 mL" : "per 100 g"} · {projection.status} · authority {projection.authority}</span></div>
      <div className="selected-projection-values">{rows.map(([label, value, unit]) => <span key={label}><small>{label}</small><b>{formatNumber(value)} {unit}</b></span>)}</div>
    </div>
  );
}

export function Reviews({ data, loading, error, onResolve, onOpenProduct, typeFilter, statusFilter, page, onType, onStatus, onPage, readOnly = false }: {
  data: ReviewResponse | null;
  loading: boolean;
  error: string | null;
  onResolve: (item: ReviewItem, decision: ReviewDecision, rationale: string, evidenceUrl: string | null, candidateProductId: string | null, reviewedText: string | null, reviewedProjection: ReviewedNutritionProjection | null) => Promise<void>;
  onOpenProduct: (id: string) => void;
  typeFilter: ReviewTypeFilter;
  statusFilter: ReviewStatus;
  page: number;
  onType: (type: ReviewTypeFilter) => void;
  onStatus: (status: ReviewStatus) => void;
  onPage: (page: number) => void;
  readOnly?: boolean;
}) {
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [reviewedTexts, setReviewedTexts] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [confirmingRedundant, setConfirmingRedundant] = useState<string | null>(null);
  const runAction = async (itemId: string, action: () => Promise<void>): Promise<boolean> => {
    setWorking(itemId);
    setActionErrors((current) => ({ ...current, [itemId]: "" }));
    try {
      await action();
      return true;
    } catch (actionError) {
      setActionErrors((current) => ({ ...current, [itemId]: actionError instanceof Error ? actionError.message : String(actionError) }));
      return false;
    } finally {
      setWorking(null);
    }
  };
  if (loading && !data) return <div className="loading" role="status">Loading review queue…</div>;
  if (error) return <div className="error-state" role="alert">{error}</div>;
  if (!data) return null;
  return (
    <div className="review-layout" aria-busy={loading}>
      {readOnly && <div className="read-only-notice"><strong>Public read-only view</strong><span>Evidence can be inspected here. Decisions stay disabled until operator authentication is configured.</span></div>}
      <div className="queue-tools">
        <label htmlFor="review-status">Queue state<select id="review-status" name="reviewStatus" value={statusFilter} onChange={(event) => onStatus(event.target.value as ReviewStatus)}>
          {REVIEW_STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select></label>
        <label htmlFor="review-type">Evidence type<select id="review-type" name="reviewType" value={typeFilter} onChange={(event) => onType(event.target.value as ReviewTypeFilter)}>
          {REVIEW_TYPE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select></label>
        <span>{data.pagination.total.toLocaleString("en-IN")} matching item{data.pagination.total === 1 ? "" : "s"}</span>
      </div>
      <div className="queue-summary"><strong>{data.counts.open}</strong><span>open</span><strong>{data.counts.resolved}</strong><span>resolved</span></div>
      {data.items.length === 0 ? <div className="empty review-empty"><strong>No matching evidence items.</strong><span>Choose another evidence type or wait for the next source run.</span></div> : data.items.map((item) => {
        const candidate = reviewNutritionCandidate(item.evidence);
        const ingredientCandidate = reviewIngredientCandidate(item.evidence);
        const evidenceUrl = evidenceUrls[item.id] ?? candidate?.imageUrl ?? ingredientCandidate?.imageUrl ?? item.sourceUrl ?? "";
        const rationale = rationales[item.id] ?? "";
        const redundantRationaleReady = rationale.trim().length >= 3;
        const reviewedText = reviewedTexts[item.id] ?? ingredientCandidate?.entityText ?? "";
        return (
        <article className={`review-card${candidate || ingredientCandidate ? " review-card-candidate" : ""}${item.decision === "redundant_nutrition" ? " review-card-redundant" : ""}`} key={item.id}>
          <header><span className="priority">P{item.priority}</span><div><h3>{item.productName ?? "Unmatched source record"}</h3><p>{item.brand ?? item.sourceRecordId} · {item.type.replaceAll("_", " ")}</p></div></header>
          {candidate && <NutritionCandidateEvidence candidate={candidate} productName={item.productName} editor={!readOnly && item.status === "open" ? <NutritionCorrectionEditor reviewId={item.id} candidate={candidate} rationale={rationale} working={working === item.id} onSubmit={(projection) => runAction(item.id, () => onResolve(item, "verify_nutrition", rationale, candidate.imageUrl, null, null, projection))} /> : null} />}
          {(item.redundantEligible || item.decision === "redundant_nutrition") && item.selectedProjection && <section className="redundant-match" aria-label={item.decision === "redundant_nutrition" ? "Recorded redundant nutrition evidence" : "Exact duplicate nutrition evidence available"}>
            <div><span className="redundant-badge">{item.decision === "redundant_nutrition" ? "Redundant evidence" : "Exact duplicate"}</span><h4>{item.decision === "redundant_nutrition" ? (item.redundantProjectionMatches ? "Recorded without changing verified nutrition" : "Recorded projection no longer matches") : "This label matches the selected projection"}</h4><p>{item.decision === "redundant_nutrition" ? (item.redundantProjectionMatches ? "The source-bound label was retained as terminal corroborating evidence. It did not create, replace, or re-verify a nutrition fact." : "The current selected projection has drifted. This historical decision must not be treated as current corroboration and reconciliation should return it to review.") : "All eight supported values and the physical basis match exactly. Recording redundancy will resolve only this evidence item."}</p></div>
            <SelectedProjection projection={item.selectedProjection} />
          </section>}
          {ingredientCandidate && <IngredientCandidateEvidence
            candidate={ingredientCandidate}
            productName={item.productName}
            reviewedText={reviewedText}
            onReviewedText={(value) => setReviewedTexts((current) => ({ ...current, [item.id]: value }))}
            readOnly={readOnly}
          />}
          <details className="raw-evidence"><summary>Inspect raw evidence</summary><pre>{JSON.stringify(item.evidence, null, 2)}</pre></details>
          {item.decision && <section className={`decision-history${item.decision === "redundant_nutrition" ? " decision-history-redundant" : ""}`} aria-label="Recorded review decision">
            <div><span>Recorded decision</span><strong>{item.decision === "redundant_nutrition" ? "Redundant evidence" : item.decision.replaceAll("_", " ")}</strong></div>
            <p>{item.rationale ?? "No rationale recorded."}</p>
            <small>By {item.decidedBy ?? "unknown operator"}{item.decisionEvidenceUrl ? <> · <a href={item.decisionEvidenceUrl} target="_blank" rel="noreferrer">open evidence ↗</a></> : null}</small>
          </section>}
          <ReviewedNutritionHistory item={item} />
          {item.type === "identity" && (
            <div className="identity-review">
              <div className="section-title"><h4>Candidate products</h4>{item.productId && <button className="text-button" onClick={() => onOpenProduct(item.productId!)}>Inspect incoming record</button>}</div>
              {item.candidates.map((candidate) => (
                <div className="candidate-row" key={candidate.id}>
                  <button className="candidate-detail" onClick={() => onOpenProduct(candidate.id)}>
                    <strong>{candidate.name}</strong>
                    <span>{candidate.brand}{candidate.flavour ? ` · ${candidate.flavour}` : ""}</span>
                    <small>GTIN {candidate.gtin ?? "missing"} · {candidate.netQuantityGrams ? `${formatNumber(candidate.netQuantityGrams, 0)} g` : "pack missing"}</small>
                  </button>
                  {!readOnly && <button disabled={working === item.id} onClick={() => void runAction(item.id, () => onResolve(item, "match", rationales[item.id] ?? "", evidenceUrl || null, candidate.id, null, null))}>Match</button>}
                </div>
              ))}
            </div>
          )}
          {!readOnly && item.status === "open" && <><label htmlFor={`review-rationale-${item.id}`}>Decision rationale<textarea id={`review-rationale-${item.id}`} name={`rationale-${item.id}`} value={rationales[item.id] ?? ""} onChange={(event) => setRationales((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="What evidence supports this decision?" /></label>
          <label htmlFor={`review-evidence-${item.id}`}>{item.type === "identity" ? "Current source or retained-label evidence URL" : "Label or authoritative evidence URL"}<input id={`review-evidence-${item.id}`} name={`evidenceUrl-${item.id}`} type="url" value={evidenceUrl} onChange={(event) => setEvidenceUrls((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="https://… current label or official record" /></label>
          {actionErrors[item.id] && <div className="review-action-error" role="alert"><strong>Decision was not saved.</strong><span>{actionErrors[item.id]}</span></div>}
          <div className="review-actions">
            {item.type.includes("nutrition") || item.type === "coverage_gap" ? <><button disabled={working === item.id} onClick={() => void runAction(item.id, () => onResolve(item, "verify_nutrition", rationale, evidenceUrl || null, null, null, null))}>{candidate ? "Verify exact label values" : "Verify nutrition"}</button><button className="secondary" disabled={working === item.id} onClick={() => void runAction(item.id, () => onResolve(item, "reject_nutrition", rationale, evidenceUrl || null, null, null, null))}>Reject candidate</button></> : null}
            {item.status === "open" && item.redundantEligible && confirmingRedundant !== item.id && <button className="redundant" disabled={working === item.id} onClick={() => setConfirmingRedundant(item.id)} aria-haspopup="dialog">Record redundant evidence</button>}
            {ingredientCandidate && <><button disabled={working === item.id} onClick={() => void runAction(item.id, () => onResolve(item, "verify_ingredients", rationale, evidenceUrl || null, null, reviewedText, null))}>Verify reviewed label text</button><button className="secondary" disabled={working === item.id} onClick={() => void runAction(item.id, () => onResolve(item, "reject_ingredients", rationale, evidenceUrl || null, null, null, null))}>Reject this candidate</button></>}
            {item.type === "identity" && <><button disabled={working === item.id} onClick={() => void runAction(item.id, () => onResolve(item, "create_new", rationale, evidenceUrl || null, null, null, null))}>Create distinct product</button><button className="secondary" disabled={working === item.id} onClick={() => void runAction(item.id, () => onResolve(item, "no_match", rationale, null, null, null, null))}>Keep unmatched</button></>}
            <button className="ghost" disabled={working === item.id} onClick={() => void runAction(item.id, () => onResolve(item, "dismiss", rationale, evidenceUrl || null, null, null, null))}>Dismiss</button>
          </div>
          {item.status === "open" && item.redundantEligible && confirmingRedundant === item.id && <div className="redundant-confirmation" role="alertdialog" aria-labelledby={`redundant-confirm-${item.id}`} aria-describedby={`redundant-description-${item.id}`}>
            <strong id={`redundant-confirm-${item.id}`}>Confirm redundant evidence</strong>
            <p id={`redundant-description-${item.id}`}>This will resolve only this source image. The currently verified nutrition and verification counts will not change.{!redundantRationaleReady ? " Add a rationale of at least 3 characters before confirming." : ""}</p>
            <div><button autoFocus className="redundant" disabled={working === item.id || !redundantRationaleReady} onClick={() => void runAction(item.id, () => onResolve(item, "redundant_nutrition", rationale, null, null, null, null)).then((saved) => { if (saved) setConfirmingRedundant(null); })}>Confirm as redundant</button><button className="ghost" disabled={working === item.id} onClick={() => setConfirmingRedundant(null)}>Cancel</button></div>
          </div>}</>}
        </article>
      )})}
      {data.pagination.pages > 1 && <nav className="pagination review-pagination" aria-label="Evidence queue pages"><button disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}>← Previous</button><span>Page <strong>{page}</strong> of {data.pagination.pages.toLocaleString("en-IN")}</span><button disabled={page >= data.pagination.pages || loading} onClick={() => onPage(page + 1)}>Next →</button></nav>}
    </div>
  );
}

function completionFamilyLabel(family: CompletionFamily): string {
  return COMPLETION_FAMILIES.find(({ value }) => value === family)?.label ?? family;
}

function completionStateLabel(state: CompletionState): string {
  return COMPLETION_STATES.find(({ value }) => value === state)?.label ?? state.replaceAll("_", " ");
}

function completionLaneLabel(lane: CompletionLane | null): string {
  if (!lane) return "Terminal evidence recorded";
  return COMPLETION_LANES.find(({ value }) => value === lane)?.label ?? lane.replaceAll("_", " ");
}

function completionEvidenceLabel(item: CompletionLedgerItem): string {
  if (item.terminalOutcome) return item.terminalOutcome.replaceAll("_", " ");
  if (item.fieldStatus) return `${item.fieldStatus} ${item.family}`;
  return "No selected field evidence";
}

function completionEvidenceSourceLabel(item: CompletionLedgerItem): string {
  const observed = item.evidenceObservedAt
    ? ` · ${new Date(item.evidenceObservedAt).toLocaleDateString("en-IN")}`
    : "";
  if (item.sourceId) return `${item.sourceId.replaceAll("_", " ")}${observed}`;
  if (item.sourceUrl) return `Evidence link${observed}`;
  return "No selected source";
}

function CompletionEvidenceLinks({ item }: { item: CompletionLedgerItem }) {
  const labelUrl = publicEvidenceUrl(item.labelUrl);
  const sourceUrl = publicEvidenceUrl(item.sourceUrl);
  const distinctSourceUrl = sourceUrl && sourceUrl !== labelUrl ? sourceUrl : null;
  if (!labelUrl && !distinctSourceUrl) return <span>No public evidence link</span>;
  return (
    <>
      {labelUrl && <a href={labelUrl} target="_blank" rel="noreferrer" aria-label={`Open ${item.family} label evidence for ${item.product.name}`}>Label ↗</a>}
      {distinctSourceUrl && <a href={distinctSourceUrl} target="_blank" rel="noreferrer" aria-label={`Open source evidence for ${item.product.name}`}>Source ↗</a>}
    </>
  );
}

function completionOutcomeLabel(outcome: CompletionLedgerItem["labels"][number]["outcome"]): string {
  if (outcome === "candidate") return "Candidate ready";
  if (outcome === "no_prediction") return "No prediction";
  if (outcome === "rejected") return "Automated result rejected";
  return "Extraction failed";
}

function completionReasonLabel(code: string): string {
  const labels: Record<string, string> = {
    evidence_binding_inconsistent: "Evidence binding is inconsistent",
    evidence_conflict: "Evidence conflict",
    review_candidate_pending: "Candidate awaiting review",
    extraction_failed: "Extraction failed",
    extraction_unattempted: "Extraction not attempted",
    no_prediction: "No prediction",
    automated_result_rejected: "Automated result rejected",
    structured_evidence_unverified: "Structured evidence is unverified",
    authoritative_source_missing: "Authoritative source missing",
    stale_extraction_evidence: "Stale extraction evidence",
  };
  const fallback = code.replaceAll("_", " ").trim();
  return labels[code] ?? (fallback ? `${fallback[0]?.toUpperCase() ?? ""}${fallback.slice(1)}` : code);
}

export function CompletionOutcomeEvidence({ item }: { item: CompletionLedgerItem }) {
  const summary = item.extraction;
  const hasCurrentOutcome = summary.candidate + summary.noPrediction + summary.rejected + summary.failed > 0;
  if (summary.labels === 0 && !hasCurrentOutcome && summary.unattempted === 0 && summary.stale === 0) {
    return <div className="completion-outcomes"><span>No exact label extraction recorded</span>{item.reasonCodes.length > 0 && <p className="completion-reason-codes"><strong>Why outstanding:</strong> {item.reasonCodes.map(completionReasonLabel).join(" · ")}</p>}</div>;
  }
  const residualException = item.state === "outstanding" && summary.failed > 0;
  const residualNextStep = item.lane === "retry_extraction"
    ? "Retry extraction is the current next action."
    : "Retry extraction remains required after the higher-priority action shown for this product.";
  const summaryItems = [
    ["candidate", "candidate", summary.candidate],
    ["no prediction", "no-prediction", summary.noPrediction],
    ["rejected", "rejected", summary.rejected],
    ["failed", "failed", summary.failed],
    ["unattempted", "unattempted", summary.unattempted],
    ["stale", "stale", summary.stale],
  ] as const;
  return (
    <section className="completion-outcomes" aria-label={`Exact ${item.family} extraction outcomes for ${item.product.name}`}>
      {residualException && <p className="completion-reason-codes"><strong>Residual exception:</strong> Extraction remains unresolved. It is neither verified nor evidence-backed unavailable.{summary.labels === 0 ? " No linked per-label outcome is available for the current failed attempt." : ""} {residualNextStep}</p>}
      <dl className="completion-outcome-counts">
        {summaryItems.map(([label, className, count]) => <div key={label} className={`completion-outcome-${className}`}><dt>{label}</dt><dd>{count.toLocaleString("en-IN")}</dd></div>)}
      </dl>
      {item.reasonCodes.length > 0 && <p className="completion-reason-codes"><strong>Why outstanding:</strong> {item.reasonCodes.map(completionReasonLabel).join(" · ")}</p>}
      {item.labels.length > 0 && <ol className="completion-label-list">
        {item.labels.map((label, index) => {
          const url = publicEvidenceUrl(label.labelUrl);
          const observed = Number.isFinite(Date.parse(label.attemptedAt))
            ? new Date(label.attemptedAt).toLocaleDateString("en-IN")
            : "time unavailable";
          return <li key={`${label.attemptId}:${label.labelAssetId}:${label.role}`}><span><strong>{index + 1}. {completionOutcomeLabel(label.outcome)}</strong><small>{label.role} image · {observed} · SHA-256 {label.contentSha256.slice(0, 10)}…</small>{label.reasonCodes.length > 0 && <small>Reasons: {label.reasonCodes.map(completionReasonLabel).join(" · ")}</small>}</span>{url && <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${item.family} label ${index + 1}, ${label.sourceImageId}, for ${item.product.name}`}>Label {index + 1} ↗</a>}</li>;
        })}
      </ol>}
      {item.labelsTruncated && <a className="completion-label-more" href={`/api/completion-ledger/${encodeURIComponent(item.product.id)}/labels?family=${item.family}&page=1&pageSize=25`} target="_blank" rel="noreferrer" aria-label={`View all ${summary.labels} exact ${item.family} label outcomes for ${item.product.name}`}>View all {summary.labels.toLocaleString("en-IN")} exact label outcomes</a>}
    </section>
  );
}

function completionActionLabel(item: CompletionLedgerItem): string {
  if (item.lane === "evidence_inconsistent") return "Repair evidence binding";
  if (item.lane === "conflict_resolution") return "Resolve evidence conflict";
  if (item.lane === "review_ready") return "Review exact candidate";
  if (item.lane === "retry_extraction") return "Retry automated extraction";
  if (item.lane === "run_extraction") return "Run automated extraction";
  if (item.lane === "manual_label_review") return "Transcribe label manually";
  if (item.lane === "structured_evidence_review") return "Review structured evidence";
  if (item.lane === "source_evidence_needed") return "Find authoritative source";
  return "Inspect terminal evidence";
}

export function IdentityEvidenceForm({ item, onVerified, onCancel }: {
  item: CompletionLedgerItem;
  onVerified: () => void;
  onCancel: () => void;
}) {
  const sourceUrl = item.sourceUrl?.startsWith("https://") ? item.sourceUrl : "";
  const [evidenceUrl, setEvidenceUrl] = useState(sourceUrl);
  const [rationale, setRationale] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRecordId = item.sourceRecordId;
  const fieldId = `identity-evidence-${item.product.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

  const submit = async () => {
    setError(null);
    if (!sourceRecordId) {
      setError("This row has no current source record to bind.");
      return;
    }
    if (!evidenceUrl.startsWith("https://")) {
      setError("Use the current HTTPS source or label URL.");
      return;
    }
    if (rationale.trim().length < 3) {
      setError("Add a rationale of at least 3 characters.");
      return;
    }
    if (!confirmed) {
      setError("Confirm that the evidence identifies this exact product variant.");
      return;
    }
    setWorking(true);
    try {
      await api.verifyIdentityEvidence(item.product.id, {
        sourceRecordId,
        evidenceUrl,
        rationale: rationale.trim(),
      });
      onVerified();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  return (
    <form className="completion-decision-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="completion-decision-binding">
        <span>Exact current binding</span>
        <strong>{item.sourceId?.replaceAll("_", " ") ?? "Source unavailable"}</strong>
        <small>Record {sourceRecordId ?? "not available"}</small>
      </div>
      <label htmlFor={`${fieldId}-url`}>Current source or label URL
        <input id={`${fieldId}-url`} type="url" required value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} placeholder="https://…" autoComplete="url" />
      </label>
      <label htmlFor={`${fieldId}-rationale`}>Verification rationale
        <textarea id={`${fieldId}-rationale`} required minLength={3} maxLength={2_000} value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Why does this evidence identify the exact brand, product, flavour, and pack?" />
      </label>
      <label className="completion-decision-confirm" htmlFor={`${fieldId}-confirm`}>
        <input id={`${fieldId}-confirm`} type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>I inspected the evidence and confirm this exact product identity. This creates immutable audit history.</span>
      </label>
      {error && <p className="completion-decision-error" role="alert"><strong>Identity was not verified.</strong><span>{error}</span></p>}
      <div className="completion-decision-buttons">
        <button type="submit" disabled={working}>{working ? "Recording verification…" : "Verify exact identity"}</button>
        <button type="button" className="ghost" disabled={working} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function terminalEvidenceHistoryForOption(
  entry: TerminalEvidenceHistoryEntry,
  option: TerminalEvidenceOption,
): boolean {
  const evidence = entry.decision.evidence;
  return evidence.kind === option.kind
    && evidence.sourceId === option.sourceId
    && evidence.sourceRecordId === option.sourceRecordId
    && evidence.sourceRecordKey === option.sourceRecordKey
    && evidence.sourceContentHash === option.sourceContentHash
    && (evidence.kind === "source" || (
      option.kind === "label"
      && evidence.labelAssetId === option.labelAssetId
      && evidence.labelContentSha256 === option.labelContentSha256
    ));
}

function terminalIdempotencyKey(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `terminal:${suffix}`;
}

function terminalContradictionMessages(
  response: TerminalEvidenceOptionsResponse,
  family: "nutrition" | "ingredients",
): string[] {
  const messages: string[] = [];
  if (response.contradiction.outcomes.length > 1) {
    messages.push(`Current sources disagree: ${response.contradiction.outcomes.join(" versus ")}.`);
  }
  if (response.contradiction.factStatus) {
    messages.push(`A ${response.contradiction.factStatus} ${family} fact conflicts with unavailable evidence.`);
  }
  if (response.contradiction.legacyProjection) {
    messages.push("A legacy unavailable projection has no current immutable evidence decision.");
  }
  return messages;
}

export function TerminalEvidenceForm({ item, onRecorded, onCancel }: {
  item: CompletionLedgerItem;
  onRecorded: () => void;
  onCancel: () => void;
}) {
  const family = item.family === "nutrition" || item.family === "ingredients" ? item.family : null;
  const [options, setOptions] = useState<TerminalEvidenceOptionsResponse | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [outcome, setOutcome] = useState<ExactTerminalUnavailableOutcome>("not_declared");
  const [rationale, setRationale] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(terminalIdempotencyKey);
  const [reloadRequest, setReloadRequest] = useState(0);
  const staleRefreshMessageRef = useRef<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const fieldId = `terminal-evidence-${item.product.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

  useEffect(() => {
    if (!family) return;
    const controller = new AbortController();
    setLoading(true);
    if (!staleRefreshMessageRef.current) setError(null);
    api.terminalEvidence(item.product.id, family, controller.signal)
      .then((result) => {
        setOptions(result);
        setSelectedId((current) => result.items.some(({ evidenceId }) => evidenceId === current) ? current : "");
        if (staleRefreshMessageRef.current) {
          setError(`${staleRefreshMessageRef.current} Current exact evidence is refreshed; reselect it before retrying. Your rationale was preserved.`);
          staleRefreshMessageRef.current = null;
        }
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    return () => controller.abort();
  }, [family, item.product.id, reloadRequest]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const selected = options?.items.find(({ evidenceId }) => evidenceId === selectedId) ?? null;
  const prior = selected && options
    ? options.history.find((entry) => entry.current && terminalEvidenceHistoryForOption(entry, selected)) ?? null
    : null;
  const unchangedCurrent = prior?.decision.outcome === outcome;

  const submit = async () => {
    setError(null);
    if (!family || !selected) {
      setError("Choose exact current source or label evidence.");
      return;
    }
    if (unchangedCurrent) {
      setError("That outcome is already current for this exact evidence. Choose a correction only when the evidence supports it.");
      return;
    }
    if (rationale.trim().length < 3) {
      setError("Add a rationale of at least 3 characters.");
      return;
    }
    if (!confirmed) {
      setError("Confirm that you inspected the complete evidence before recording an unavailable outcome.");
      return;
    }
    setWorking(true);
    try {
      await api.recordTerminalEvidence(item.product.id, {
        family,
        outcome,
        evidenceId: selected.evidenceId,
        sourceContentHash: selected.sourceContentHash,
        labelContentSha256: selected.labelContentSha256,
        idempotencyKey,
        rationale: rationale.trim(),
        supersedesDecisionId: prior?.decision.id ?? null,
      });
      onRecorded();
    } catch (reason) {
      if (reason instanceof TerminalEvidenceRequestError && reason.code === "stale_evidence") {
        staleRefreshMessageRef.current = reason.message;
        setOptions(null);
        setSelectedId("");
        setConfirmed(false);
        setIdempotencyKey(terminalIdempotencyKey());
        setError(`${reason.message} Refreshing current exact evidence… Your rationale is preserved.`);
        setReloadRequest((current) => current + 1);
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setWorking(false);
    }
  };

  if (!family) return null;
  return (
    <form className="completion-decision-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {loading && <div className="loading completion-decision-loading" role="status"><span className="loader" />Loading exact current evidence…</div>}
      {options?.contradiction.hasConflict && <div className="completion-decision-conflict" role="alert"><strong>Evidence currently contradicts itself.</strong>{terminalContradictionMessages(options, family).map((message) => <span key={message}>{message}</span>)}<small>No unavailable outcome becomes terminal until every contradiction is resolved.</small></div>}
      {options && options.items.length === 0 && <div className="completion-decision-error" role="alert"><strong>No eligible exact evidence.</strong><span>Retain a current source record or exact label before recording that {family} is unavailable.</span></div>}
      {options && options.items.length > 0 && <fieldset className="completion-evidence-options"><legend>Select the exact evidence inspected</legend>{options.items.map((option) => {
        const link = publicEvidenceUrl(option.labelUrl ?? option.sourceUrl);
        const optionId = `${fieldId}-option-${option.evidenceId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
        const kindLabel = option.kind === "label" ? "retained label" : "current source record";
        return <div key={option.evidenceId} className={`completion-evidence-option${selectedId === option.evidenceId ? " selected" : ""}`}><label htmlFor={optionId}><input id={optionId} type="radio" name={`${fieldId}-option`} value={option.evidenceId} checked={selectedId === option.evidenceId} onChange={() => setSelectedId(option.evidenceId)} /><span><strong>{option.kind === "label" ? "Retained label bytes" : "Current source record"} · {option.sourceName}</strong><small>Observed {new Date(option.observedAt).toLocaleDateString("en-IN")} · authority {option.authority}/100</small><code>Record {option.sourceRecordKey} · source SHA-256 {option.sourceContentHash.slice(0, 16)}…</code>{option.kind === "label" && <code>Asset {option.labelAssetId} · label SHA-256 {option.labelContentSha256?.slice(0, 16)}…</code>}</span></label>{link && <a href={link} target="_blank" rel="noreferrer" aria-label={`Inspect ${kindLabel} from ${option.sourceName} for ${item.product.name}`}>Inspect evidence ↗</a>}</div>;
      })}</fieldset>}
      <fieldset className="completion-outcome-options"><legend>What does the complete evidence establish?</legend><label className={outcome === "not_declared" ? "selected" : ""}><input type="radio" name={`${fieldId}-outcome`} value="not_declared" checked={outcome === "not_declared"} onChange={() => setOutcome("not_declared")} /><span><strong>Not declared</strong><small>The complete current label or authoritative record does not declare this field.</small></span></label><label className={outcome === "not_applicable" ? "selected" : ""}><input type="radio" name={`${fieldId}-outcome`} value="not_applicable" checked={outcome === "not_applicable"} onChange={() => setOutcome("not_applicable")} /><span><strong>Not applicable</strong><small>This field genuinely does not apply to this exact product—not merely missing or unreadable.</small></span></label></fieldset>
      {prior && <div className="completion-decision-prior"><span>Current decision on selected evidence</span><strong>{prior.decision.outcome.replaceAll("_", " ")}</strong><small>{prior.decision.rationale} · {new Date(prior.decision.decidedAt).toLocaleString("en-IN")}</small>{prior.decision.outcome !== outcome && <em>The new decision will append an explicit supersession; history will not be overwritten.</em>}</div>}
      {options && options.history.length > 0 && <details className="completion-decision-history"><summary>Decision history · {options.history.length}{options.historyTruncated ? "+" : ""}</summary><ol>{options.history.map((entry) => { const evidence = entry.decision.evidence; return <li key={entry.decision.id}><span><strong>{entry.decision.outcome.replaceAll("_", " ")}</strong><small>{entry.current ? "current" : entry.superseded ? "superseded" : entry.stale ? "stale binding" : "historical"} · {new Date(entry.decision.decidedAt).toLocaleString("en-IN")}</small><small>{evidence.kind === "label" ? "retained label" : "source record"} · {evidence.sourceId} · record {evidence.sourceRecordKey}</small><code>Source SHA-256 {evidence.sourceContentHash}</code>{evidence.kind === "label" && <code>Asset {evidence.labelAssetId} · label SHA-256 {evidence.labelContentSha256}</code>}</span><p>{entry.decision.rationale}</p></li>; })}</ol></details>}
      <label htmlFor={`${fieldId}-rationale`}>Decision rationale<textarea id={`${fieldId}-rationale`} required minLength={3} maxLength={2_000} value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder={`What exact evidence establishes that ${family} is ${outcome.replaceAll("_", " ")}?`} /></label>
      <label className="completion-decision-confirm" htmlFor={`${fieldId}-confirm`}><input id={`${fieldId}-confirm`} type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I inspected the complete selected evidence. Missing, cropped, unreadable, or failed extraction is not enough for this decision.</span></label>
      {error && <p ref={errorRef} className="completion-decision-error" role="alert" tabIndex={-1}><strong>Terminal evidence was not recorded.</strong><span>{error}</span></p>}
      <div className="completion-decision-buttons"><button type="submit" disabled={working || loading || !selected || unchangedCurrent}>{working ? "Recording decision…" : prior ? "Record immutable correction" : "Record terminal evidence"}</button><button type="button" className="ghost" disabled={working} onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function canRestoreDialogFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || (element instanceof HTMLButtonElement && element.disabled)) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.inert || current.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

export function CompletionEvidenceDialog({ item, onCommitted, onClose }: {
  item: CompletionLedgerItem;
  onCommitted: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        headingRef.current?.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === headingRef.current || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keepFocusInDialog);
    return () => {
      window.removeEventListener("keydown", keepFocusInDialog);
      const target = canRestoreDialogFocus(previousFocus)
        ? previousFocus
        : document.getElementById("completion-worklist-heading");
      if (canRestoreDialogFocus(target)) target.focus();
    };
  }, []);
  const dialogId = `${item.family}-${item.product.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return (
    <div className="completion-decision-backdrop">
      <section ref={dialogRef} className="completion-decision-dialog" role="dialog" aria-modal="true" aria-labelledby={`completion-decision-heading-${dialogId}`} aria-describedby={`completion-decision-description-${dialogId}`}>
        <header><div><p className="eyebrow">Human evidence decision</p><h2 id={`completion-decision-heading-${dialogId}`} ref={headingRef} tabIndex={-1}>{item.family === "identity" ? "Verify" : `Record ${item.family} for`} {item.product.name}</h2><p id={`completion-decision-description-${dialogId}`}>{item.family === "identity" ? "Identity verification is accepted only while this exact source record and normalized identity hash remain current." : "Unavailable is a terminal evidence decision—not a synonym for missing data, failed extraction, or an unreadable label."}</p></div><button type="button" className="drawer-close" onClick={onClose} aria-label="Close evidence decision">×</button></header>
        {item.family === "identity"
          ? <IdentityEvidenceForm item={item} onVerified={onCommitted} onCancel={onClose} />
          : <TerminalEvidenceForm item={item} onRecorded={onCommitted} onCancel={onClose} />}
      </section>
    </div>
  );
}

export function CompletionPrimaryAction({ item, onOpenProduct, onOpenReview, onRecordEvidence, readOnly = false }: {
  item: CompletionLedgerItem;
  onOpenProduct: (id: string) => void;
  onOpenReview: (item: CompletionLedgerItem) => void;
  onRecordEvidence?: (item: CompletionLedgerItem) => void;
  readOnly?: boolean;
}) {
  const label = completionActionLabel(item);
  if (item.lane === "review_ready" && item.primaryReviewId) {
    return <button onClick={() => onOpenReview(item)} aria-label={`${label} for ${item.product.name}`}>{label}</button>;
  }
  if (!readOnly && item.family === "identity" && item.state === "outstanding" && item.sourceRecordId && onRecordEvidence) {
    return <button onClick={() => onRecordEvidence(item)} aria-label={`Verify exact identity for ${item.product.name}`}>Verify identity</button>;
  }
  if (!readOnly && item.family !== "identity" && item.state === "outstanding" && onRecordEvidence) {
    return <button onClick={() => onRecordEvidence(item)} aria-label={`Record exact ${item.family} unavailable evidence for ${item.product.name}`}>Record unavailable</button>;
  }
  return <button onClick={() => onOpenProduct(item.product.id)} aria-label={`${label} for ${item.product.name}`}>{label}</button>;
}

function CompletionDesktopRows({ items, onOpenProduct, onOpenReview, onRecordEvidence, readOnly }: {
  items: CompletionLedgerItem[];
  onOpenProduct: (id: string) => void;
  onOpenReview: (item: CompletionLedgerItem) => void;
  onRecordEvidence: (item: CompletionLedgerItem) => void;
  readOnly: boolean;
}) {
  return (
    <div className="completion-desktop">
      <table>
        <thead><tr><th scope="col">Product</th><th scope="col">Completion state</th><th scope="col">Evidence state</th><th scope="col">Exact label outcomes</th><th scope="col">Provenance</th><th scope="col">Action</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.product.id}>
          <td className="completion-product"><button onClick={() => onOpenProduct(item.product.id)}><ProductVisual product={item.product} /><span><strong>{item.product.name}</strong><span>{item.product.brand}</span><small>GTIN {item.product.gtin ?? "not recorded"} · {item.product.category.replaceAll("_", " ")}</small></span></button></td>
          <td className="completion-status"><span className={`completion-state completion-state-${item.state}`}>{completionStateLabel(item.state)}</span><strong className="completion-lane">{completionLaneLabel(item.lane)}</strong></td>
          <td className="completion-status"><strong>{completionEvidenceLabel(item)}</strong><small>{completionEvidenceSourceLabel(item)}</small><small>{item.openReviewCount.toLocaleString("en-IN")} open review{item.openReviewCount === 1 ? "" : "s"}</small></td>
          <td><CompletionOutcomeEvidence item={item} /></td>
          <td className="completion-evidence"><CompletionEvidenceLinks item={item} /></td>
          <td><div className="completion-actions"><CompletionPrimaryAction item={item} onOpenProduct={onOpenProduct} onOpenReview={onOpenReview} onRecordEvidence={onRecordEvidence} readOnly={readOnly} /><button className="ghost" onClick={() => onOpenProduct(item.product.id)} aria-label={`Inspect product details for ${item.product.name}`}>Inspect product</button></div></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function CompletionMobileRows({ items, onOpenProduct, onOpenReview, onRecordEvidence, readOnly }: {
  items: CompletionLedgerItem[];
  onOpenProduct: (id: string) => void;
  onOpenReview: (item: CompletionLedgerItem) => void;
  onRecordEvidence: (item: CompletionLedgerItem) => void;
  readOnly: boolean;
}) {
  return (
    <div className="completion-mobile" role="list" aria-label="Completion worklist products">
      {items.map((item) => <article className="completion-card" role="listitem" key={item.product.id}>
        <div className="completion-card-head"><button className="completion-card-product" onClick={() => onOpenProduct(item.product.id)}><strong>{item.product.name}</strong><span>{item.product.brand}</span><small>GTIN {item.product.gtin ?? "not recorded"} · {item.product.category.replaceAll("_", " ")}</small></button><span className={`completion-state completion-state-${item.state}`}>{completionStateLabel(item.state)}</span></div>
        <div className="completion-card-body"><div className="completion-status"><strong className="completion-lane">{completionLaneLabel(item.lane)}</strong><small>{completionEvidenceLabel(item)}</small><small>{item.openReviewCount} open review{item.openReviewCount === 1 ? "" : "s"}</small></div><CompletionOutcomeEvidence item={item} /><div className="completion-evidence"><CompletionEvidenceLinks item={item} /></div><div className="completion-actions"><CompletionPrimaryAction item={item} onOpenProduct={onOpenProduct} onOpenReview={onOpenReview} onRecordEvidence={onRecordEvidence} readOnly={readOnly} /><button className="ghost" onClick={() => onOpenProduct(item.product.id)} aria-label={`Inspect product details for ${item.product.name}`}>Inspect product</button></div></div>
      </article>)}
    </div>
  );
}

export function CompletionWorklist({ data, fallbackSummary, fallbackSnapshotAt, loading, error, filters, focusRequest, onFamily, onState, onLane, onQuery, onPage, onRetry, onOpenProduct, onOpenReview, onEvidenceCommitted, readOnly }: {
  data: CompletionLedgerResponse | null;
  fallbackSummary: CompletionSummary;
  fallbackSnapshotAt: string | null;
  loading: boolean;
  error: string | null;
  filters: CompletionUiFilters;
  focusRequest: number;
  onFamily: (family: CompletionFamily) => void;
  onState: (state: CompletionState) => void;
  onLane: (lane: CompletionLaneFilter) => void;
  onQuery: (query: string) => void;
  onPage: (page: number) => void;
  onRetry: () => void;
  onOpenProduct: (id: string) => void;
  onOpenReview: (item: CompletionLedgerItem) => void;
  onEvidenceCommitted: () => Promise<void>;
  readOnly: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const commitNoticeRef = useRef<HTMLDivElement>(null);
  const [decisionItem, setDecisionItem] = useState<CompletionLedgerItem | null>(null);
  const [commitNotice, setCommitNotice] = useState<{ kind: "refreshing" | "success" | "refresh_failed"; message: string } | null>(null);
  useEffect(() => {
    if (focusRequest > 0) headingRef.current?.focus();
  }, [focusRequest]);
  useEffect(() => {
    if (commitNotice && commitNotice.kind !== "refreshing") commitNoticeRef.current?.focus();
  }, [commitNotice]);
  const summary = data?.summary ?? fallbackSummary;
  const familyLabel = completionFamilyLabel(filters.family);
  const snapshotAt = data?.snapshotAt ?? fallbackSnapshotAt;
  const snapshotLabel = snapshotAt && Number.isFinite(Date.parse(snapshotAt))
    ? new Date(snapshotAt).toLocaleString("en-IN")
    : "No completed source run recorded";
  const commitEvidence = async () => {
    if (!decisionItem) return;
    const subject = decisionItem.family === "identity" ? "Identity verification" : `${completionFamilyLabel(decisionItem.family)} evidence decision`;
    const productName = decisionItem.product.name;
    setDecisionItem(null);
    setCommitNotice({ kind: "refreshing", message: `${subject} saved for ${productName}. Refreshing coverage and the worklist…` });
    try {
      await onEvidenceCommitted();
      setCommitNotice({ kind: "success", message: `${subject} saved for ${productName}. Coverage and the worklist are current.` });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setCommitNotice({ kind: "refresh_failed", message: `${subject} was saved for ${productName}, but the dashboard refresh failed. ${message}` });
    }
  };
  return (
    <section className="completion-worklist" aria-labelledby="completion-worklist-heading" aria-busy={loading}>
      <div className="completion-head">
        <div><p className="eyebrow">Product-by-product completion</p><h2 id="completion-worklist-heading" ref={headingRef} tabIndex={-1}>{familyLabel} evidence worklist</h2><p>Every active product appears in exactly one completion state. Outstanding rows are routed by the strongest current next action without inferring facts from missing data.</p></div>
        <div className="completion-snapshot"><span>Latest completed source run</span><strong>{snapshotLabel}</strong></div>
      </div>

      <div className="completion-controls">
        <fieldset className="completion-control-group"><legend>Evidence family</legend><div className="completion-segments" role="group" aria-label="Evidence family">
          {COMPLETION_FAMILIES.map(({ value, label }) => <button key={value} aria-pressed={filters.family === value} onClick={() => onFamily(value)}>{label}</button>)}
        </div></fieldset>
      </div>

      <>
        <div className="completion-equation" aria-label={`${familyLabel} completion accounting`}>
          {COMPLETION_STATES.map(({ value, label, help }) => {
            const count = value === "verified" ? summary.verified : value === "terminal_unavailable" ? summary.terminalUnavailable : summary.outstanding;
            return <button key={value} aria-pressed={filters.state === value} onClick={() => onState(value)}><span>{label}</span><strong>{count.toLocaleString("en-IN")}</strong><small>{help}</small></button>;
          })}
          <div className="completion-equation-total"><span>Active products</span><strong>{summary.activeProducts.toLocaleString("en-IN")}</strong><small>One {familyLabel.toLowerCase()} state each</small></div>
        </div>
        <p className={`completion-invariant${summary.invariantHolds && summary.contradictions === 0 ? "" : " completion-invariant-invalid"}`}><strong>{summary.verified.toLocaleString("en-IN")} verified + {summary.terminalUnavailable.toLocaleString("en-IN")} unavailable + {summary.outstanding.toLocaleString("en-IN")} outstanding = {summary.accounted.toLocaleString("en-IN")} accounted</strong><span>{summary.invariantHolds && summary.contradictions === 0 ? "Exact active-catalog partition" : `${summary.contradictions.toLocaleString("en-IN")} evidence contradiction${summary.contradictions === 1 ? "" : "s"}; completion remains failed closed`}</span></p>
      </>

      {filters.state === "outstanding" && <fieldset className="completion-control-group"><legend>Next-action lane</legend><div className="completion-segments" role="group" aria-label="Next-action lane">
        <button aria-pressed={filters.lane === "all"} onClick={() => onLane("all")}>All lanes · {summary.outstanding.toLocaleString("en-IN")}</button>
        {COMPLETION_LANES.map(({ value, label }) => <button key={value} aria-pressed={filters.lane === value} disabled={summary.lanes[value] === 0 && filters.lane !== value} onClick={() => onLane(value)}>{label} · {summary.lanes[value].toLocaleString("en-IN")}</button>)}
      </div></fieldset>}

      <div className="completion-toolbar">
        <label htmlFor="completion-search">Search this evidence family<input id="completion-search" name="completionSearch" type="search" value={filters.q} onChange={(event) => onQuery(event.target.value)} placeholder="Brand, product, or GTIN" /></label>
        <div className="completion-toolbar-meta" aria-live="polite">{data ? <><strong>{data.pagination.total.toLocaleString("en-IN")}</strong> matching product{data.pagination.total === 1 ? "" : "s"}</> : "Waiting for ledger totals"}</div>
      </div>

      {commitNotice && <div ref={commitNoticeRef} tabIndex={-1} className={`completion-commit-notice completion-commit-notice-${commitNotice.kind}`} role={commitNotice.kind === "refresh_failed" ? "alert" : "status"} aria-live={commitNotice.kind === "refresh_failed" ? "assertive" : "polite"}><strong>{commitNotice.kind === "refresh_failed" ? "Verification saved; refresh needed" : commitNotice.kind === "success" ? "Verification complete" : "Verification saved"}</strong><span>{commitNotice.message}</span></div>}
      {error && <div className="error-state" role="alert"><strong>Completion ledger unavailable</strong><span>{error}</span><button onClick={onRetry}>Try again</button></div>}
      {!data && loading && <div className="loading completion-loading" role="status"><span className="loader" />Building the exact {familyLabel.toLowerCase()} worklist…</div>}
      {data && <div className="completion-results">
        {data.items.length === 0 && !error ? <div className="empty completion-empty"><span className="empty-mark" aria-hidden="true">0</span><strong>No products match this ledger view.</strong><span>Choose another state, action lane, or search term. A zero count does not erase products from the family equation.</span></div> : <><CompletionDesktopRows items={data.items} onOpenProduct={onOpenProduct} onOpenReview={onOpenReview} onRecordEvidence={setDecisionItem} readOnly={readOnly} /><CompletionMobileRows items={data.items} onOpenProduct={onOpenProduct} onOpenReview={onOpenReview} onRecordEvidence={setDecisionItem} readOnly={readOnly} /></>}
        {data.pagination.pages > 1 && <nav className="pagination" aria-label="Completion worklist pages"><button disabled={data.pagination.page <= 1 || loading} onClick={() => onPage(data.pagination.page - 1)}>← Previous</button><span>Page <strong>{data.pagination.page}</strong> of {data.pagination.pages.toLocaleString("en-IN")}</span><button disabled={data.pagination.page >= data.pagination.pages || loading} onClick={() => onPage(data.pagination.page + 1)}>Next →</button></nav>}
      </div>}
      {decisionItem && <CompletionEvidenceDialog key={`${decisionItem.family}:${decisionItem.product.id}`} item={decisionItem} onClose={() => setDecisionItem(null)} onCommitted={() => { void commitEvidence(); }} />}
    </section>
  );
}

function Coverage({ data, loading, error, completion, completionLoading, completionError, completionFilters, completionFocusRequest, onCompletionFamily, onCompletionState, onCompletionLane, onCompletionQuery, onCompletionPage, onCompletionRetry, onCompletionDrillDown, onOpenProduct, onOpenReview, onEvidenceCommitted, readOnly }: {
  data: CoverageResponse | null;
  loading: boolean;
  error: string | null;
  completion: CompletionLedgerResponse | null;
  completionLoading: boolean;
  completionError: string | null;
  completionFilters: CompletionUiFilters;
  completionFocusRequest: number;
  onCompletionFamily: (family: CompletionFamily) => void;
  onCompletionState: (state: CompletionState) => void;
  onCompletionLane: (lane: CompletionLaneFilter) => void;
  onCompletionQuery: (query: string) => void;
  onCompletionPage: (page: number) => void;
  onCompletionRetry: () => void;
  onCompletionDrillDown: (family: CompletionFamily, state: CompletionState, lane?: CompletionLaneFilter) => void;
  onOpenProduct: (id: string) => void;
  onOpenReview: (item: CompletionLedgerItem) => void;
  onEvidenceCommitted: () => Promise<void>;
  readOnly: boolean;
}) {
  if (loading) return <div className="loading" role="status">Reconciling coverage…</div>;
  if (error) return <div className="error-state" role="alert">{error}</div>;
  if (!data) return null;
  const cards = [
    { label: "Catalog products", value: data.catalog.products },
    { label: "Valid GTIN", value: data.catalog.validGtin },
    { label: "Structured nutrition", value: data.catalog.structuredNutrition },
    { label: "Nutrition label images", value: data.catalog.nutritionLabelImages },
    { label: "Review-ready nutrition", value: data.completion.families.nutrition.lanes.review_ready, action: () => onCompletionDrillDown("nutrition", "outstanding", "review_ready") },
    { label: "Verified nutrition", value: data.completion.families.nutrition.verified, action: () => onCompletionDrillDown("nutrition", "verified") },
    { label: "Verified ingredients", value: data.completion.families.ingredients.verified, action: () => onCompletionDrillDown("ingredients", "verified") },
    { label: "Outstanding identity", value: data.completion.outstandingIdentity, action: () => onCompletionDrillDown("identity", "outstanding") },
    { label: "Outstanding nutrition", value: data.completion.outstandingNutrition, action: () => onCompletionDrillDown("nutrition", "outstanding") },
    { label: "Outstanding ingredients", value: data.completion.outstandingIngredients, action: () => onCompletionDrillDown("ingredients", "outstanding") },
  ];
  return (
    <div className="coverage-page">
      <div className={`coverage-gate coverage-gate-${data.completion.status}`}><div><span>Data completion gate</span><strong>{data.completion.status}</strong></div><p>{data.completion.status === "complete" ? "Every active product has terminal verified evidence." : `${data.completion.outstandingNutrition.toLocaleString("en-IN")} nutrition, ${data.completion.outstandingIngredients.toLocaleString("en-IN")} ingredient, and ${data.completion.outstandingIdentity.toLocaleString("en-IN")} identity records still need terminal evidence.`}</p></div>
      <div className="coverage-warning"><strong>Coverage claim: configured sources only.</strong><span>Source exhaustion and verified product completeness are separate gates.</span></div>
      <div className="coverage-grid">{cards.map(({ label, value, action }) => action ? <button key={label} onClick={action}><span>{label}</span><strong>{value.toLocaleString("en-IN")}</strong><small>View product worklist →</small></button> : <div key={label}><span>{label}</span><strong>{value.toLocaleString("en-IN")}</strong></div>)}</div>
      <CompletionWorklist data={completion} fallbackSummary={data.completion.families[completionFilters.family]} fallbackSnapshotAt={data.completion.snapshotAt} loading={completionLoading} error={completionError} filters={completionFilters} focusRequest={completionFocusRequest} onFamily={onCompletionFamily} onState={onCompletionState} onLane={onCompletionLane} onQuery={onCompletionQuery} onPage={onCompletionPage} onRetry={onCompletionRetry} onOpenProduct={onOpenProduct} onOpenReview={onOpenReview} onEvidenceCommitted={onEvidenceCommitted} readOnly={readOnly} />
      <section className="panel"><h2>Source ledger</h2>{data.sources.map((source) => <div className="source-row" key={source.id}><div><strong>{source.name}</strong><span>{source.kind}</span></div><span className="tag">{source.sourceComplete ? "source complete" : "source incomplete"}</span><div><strong>{source.indiaRecords?.toLocaleString("en-IN") ?? "—"}</strong><span>India records</span></div><div><strong>{source.latestRunStatus ?? "never"}</strong><span>{source.latestRunAt ? new Date(source.latestRunAt).toLocaleString("en-IN") : "no completed run"}</span></div></div>)}</section>
      <section className="panel"><h2>Disconnected discovery sources</h2><div className="badge-row">{data.disconnectedSources.map((source) => <span className="tag" key={source}>{source.replaceAll("_", " ")}</span>)}</div></section>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("catalog");
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(1);
  const deferredQuery = useDeferredValue(filters.q);
  const [lookupQuery, setLookupQuery] = useState("");
  const deferredLookupQuery = useDeferredValue(lookupQuery);
  const [lookupProducts, setLookupProducts] = useState<CatalogProduct[]>([]);
  const [lookupState, setLookupState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogState, setCatalogState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [reviews, setReviews] = useState<ReviewResponse | null>(null);
  const [reviewState, setReviewState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [reviewType, setReviewType] = useState<ReviewTypeFilter>("all");
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("open");
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [coverageState, setCoverageState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [completion, setCompletion] = useState<CompletionLedgerResponse | null>(null);
  const [completionFilters, setCompletionFilters] = useState<CompletionUiFilters>(initialCompletionFilters);
  const [completionState, setCompletionState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [completionFocusRequest, setCompletionFocusRequest] = useState(0);
  const deferredCompletionQuery = useDeferredValue(completionFilters.q);
  const isPublic = typeof window !== "undefined" && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

  const params = useMemo(() => {
    const value = new URLSearchParams({ ...filters, q: deferredQuery, page: String(page), pageSize: "50" });
    return value;
  }, [filters, deferredQuery, page]);

  const reviewParams = useMemo(() => {
    const value = new URLSearchParams({
      status: reviewStatus,
      type: reviewType,
      page: String(reviewPage),
      pageSize: "50",
    });
    if (reviewId) value.set("id", reviewId);
    return value;
  }, [reviewStatus, reviewType, reviewPage, reviewId]);

  const completionParams = useMemo(() => new URLSearchParams({
    family: completionFilters.family,
    state: completionFilters.state,
    lane: completionFilters.state === "outstanding" ? completionFilters.lane : "all",
    q: deferredCompletionQuery,
    page: String(completionFilters.page),
    pageSize: String(completionFilters.pageSize),
  }), [completionFilters.family, completionFilters.state, completionFilters.lane, completionFilters.page, completionFilters.pageSize, deferredCompletionQuery]);

  const updateFilters = (next: Partial<typeof initialFilters>) => {
    setPage(1);
    setFilters((current) => ({ ...current, ...next }));
  };

  useEffect(() => {
    const query = deferredLookupQuery.trim();
    if (query.length < 2) {
      setLookupProducts([]);
      setLookupState({ loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setLookupState({ loading: true, error: null });
      const params = new URLSearchParams({ q: query, scope: "all", trust: "all", verification: "all", ingredientVerification: "all", page: "1", pageSize: "6" });
      api.catalog(params, controller.signal)
        .then((result) => { setLookupProducts(result.products); setLookupState({ loading: false, error: null }); })
        .catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setLookupProducts([]); setLookupState({ loading: false, error: error instanceof Error ? error.message : String(error) }); });
    }, 180);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [deferredLookupQuery]);

  const selectLookupProduct = (product: CatalogProduct) => {
    setLookupQuery("");
    setLookupProducts([]);
    setSelectedId(product.id);
  };
  const submitLookup = () => {
    const destination = lookupDestination(lookupQuery, lookupProducts);
    if (destination.kind === "open") { selectLookupProduct(lookupProducts[0]!); return; }
    if (!destination.query) return;
    setTab("catalog");
    updateFilters({ q: destination.query, trust: "all", verification: "all", ingredientVerification: "all", scope: "all", sort: "protein_density" });
  };

  const showTrusted = () => updateFilters({ trust: "strict", verification: "verified", ingredientVerification: "all", scope: "protein", sort: "protein_density" });
  const showDiscovery = () => updateFilters({ trust: "all", verification: "all", ingredientVerification: "all", scope: "all", sort: "protein_density" });

  const loadCatalog = () => {
    const controller = new AbortController();
    setCatalogState({ loading: true, error: null });
    api.catalog(params, controller.signal)
      .then((result) => { setCatalog(result); setCatalogState({ loading: false, error: null }); })
      .catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setCatalogState({ loading: false, error: error instanceof Error ? error.message : String(error) }); });
    return controller;
  };

  useEffect(() => {
    const controller = loadCatalog();
    return () => controller.abort();
  }, [params]);

  const loadCoverage = () => {
    setCoverageState({ loading: true, error: null });
    api.coverage().then((result) => { setCoverage(result); setCoverageState({ loading: false, error: null }); }).catch((error: unknown) => setCoverageState({ loading: false, error: error instanceof Error ? error.message : String(error) }));
  };

  useEffect(() => {
    loadCoverage();
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const loadCompletion = () => {
    const controller = new AbortController();
    setCompletionState({ loading: true, error: null });
    api.completionLedger(completionParams, controller.signal)
      .then((result) => { setCompletion(result); setCompletionState({ loading: false, error: null }); })
      .catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setCompletion(null); setCompletionState({ loading: false, error: error instanceof Error ? error.message : String(error) }); });
    return controller;
  };

  useEffect(() => {
    if (tab !== "coverage") return;
    const controller = loadCompletion();
    return () => controller.abort();
  }, [tab, completionParams]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    setDetailState({ loading: true, error: null });
    api.product(selectedId, controller.signal).then((result) => { setDetail(result); setDetailState({ loading: false, error: null }); }).catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setDetailState({ loading: false, error: error instanceof Error ? error.message : String(error) }); });
    return () => controller.abort();
  }, [selectedId]);

  const loadReviews = () => {
    const controller = new AbortController();
    setReviewState({ loading: true, error: null });
    api.reviews(reviewParams, controller.signal)
      .then((result) => { setReviews(result); setReviewState({ loading: false, error: null }); })
      .catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setReviewState({ loading: false, error: error instanceof Error ? error.message : String(error) }); });
    return controller;
  };

  useEffect(() => {
    if (tab !== "reviews") return;
    const controller = loadReviews();
    return () => controller.abort();
  }, [tab, reviewParams]);

  const resolve = async (item: ReviewItem, decision: ReviewDecision, rationale: string, evidenceUrl: string | null, candidateProductId: string | null, reviewedText: string | null, reviewedProjection: ReviewedNutritionProjection | null) => {
    if (rationale.trim().length < 3) throw new Error("Add a rationale of at least 3 characters.");
    if (["verify_nutrition", "verify_ingredients"].includes(decision) && !evidenceUrl) throw new Error("Verification requires a current label or authoritative-source URL.");
    if (decision === "verify_ingredients" && !reviewedText?.trim()) throw new Error("Ingredient verification requires the reviewer-confirmed visible label text.");
    await api.resolveReview(item.id, decision, rationale, evidenceUrl, candidateProductId, reviewedText, reviewedProjection);
    loadReviews();
    loadCatalog();
    loadCoverage();
    if (selectedId === item.productId && selectedId) api.product(selectedId).then(setDetail);
  };

  const changeCompletionFamily = (family: CompletionFamily) => {
    setCompletion(null);
    setCompletionFilters((current) => ({ ...current, family, lane: "all", page: 1 }));
  };
  const changeCompletionState = (state: CompletionState) => {
    setCompletion(null);
    setCompletionFilters((current) => ({ ...current, state, lane: "all", page: 1 }));
  };
  const changeCompletionLane = (lane: CompletionLaneFilter) => {
    setCompletion(null);
    setCompletionFilters((current) => ({ ...current, state: "outstanding", lane, page: 1 }));
  };
  const changeCompletionQuery = (q: string) => {
    setCompletionFilters((current) => ({ ...current, q, page: 1 }));
  };
  const changeCompletionPage = (completionPage: number) => {
    setCompletion(null);
    setCompletionFilters((current) => ({ ...current, page: completionPage }));
    setCompletionFocusRequest((current) => current + 1);
  };
  const drillIntoCompletion = (family: CompletionFamily, state: CompletionState, lane: CompletionLaneFilter = "all") => {
    setCompletion(null);
    setCompletionFilters((current) => ({ ...current, family, state, lane: state === "outstanding" ? lane : "all", q: "", page: 1 }));
    setCompletionFocusRequest((current) => current + 1);
  };
  const openCompletionReview = (item: CompletionLedgerItem) => {
    setReviewStatus("open");
    setReviewType("all");
    setReviewPage(1);
    setReviewId(item.primaryReviewId);
    setTab("reviews");
  };
  const refreshAfterEvidenceDecision = async () => {
    setCompletionState({ loading: true, error: null });
    setCoverageState({ loading: true, error: null });
    setCatalogState({ loading: true, error: null });
    const [nextCompletion, nextCoverage, nextCatalog] = await Promise.allSettled([
      api.completionLedger(completionParams),
      api.coverage(),
      api.catalog(params),
    ]);
    const failures: string[] = [];
    if (nextCompletion.status === "fulfilled") {
      setCompletion(nextCompletion.value);
      setCompletionState({ loading: false, error: null });
    } else {
      const message = nextCompletion.reason instanceof Error ? nextCompletion.reason.message : String(nextCompletion.reason);
      setCompletionState({ loading: false, error: message });
      failures.push(`Completion worklist: ${message}`);
    }
    if (nextCoverage.status === "fulfilled") {
      setCoverage(nextCoverage.value);
      setCoverageState({ loading: false, error: null });
    } else {
      const message = nextCoverage.reason instanceof Error ? nextCoverage.reason.message : String(nextCoverage.reason);
      setCoverageState({ loading: false, error: message });
      failures.push(`Coverage: ${message}`);
    }
    if (nextCatalog.status === "fulfilled") {
      setCatalog(nextCatalog.value);
      setCatalogState({ loading: false, error: null });
    } else {
      const message = nextCatalog.reason instanceof Error ? nextCatalog.reason.message : String(nextCatalog.reason);
      setCatalogState({ loading: false, error: message });
      failures.push(`Catalog: ${message}`);
    }
    if (failures.length > 0) throw new Error(failures.join(" "));
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to catalog content</a>
      <header className="topbar">
        <button className="brand-home" onClick={() => setTab("catalog")}><span className="brand-mark">PI</span><span><small>Indian food evidence</small><strong>Protein Index</strong></span></button>
        <nav aria-label="Primary navigation">
          {(["catalog", "coverage", "reviews"] as const).map((item) => <button key={item} aria-pressed={tab === item} className={tab === item ? "active" : ""} onClick={() => { if (item === "reviews") setReviewId(null); setTab(item); }}>{item === "catalog" ? "Catalog" : item === "coverage" ? "Coverage" : "Evidence queue"}{item === "reviews" && reviews?.counts.open ? <b>{reviews.counts.open}</b> : null}</button>)}
        </nav>
        <HeaderProductLookup query={lookupQuery} products={lookupProducts} loading={lookupState.loading} error={lookupState.error} onQuery={setLookupQuery} onSelect={selectLookupProduct} onSubmit={submitLookup} />
        <div className="source-pill"><i />{health?.latestPublishedAt ? `Evidence updated ${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(health.latestPublishedAt))}` : "Evidence catalog"}</div>
      </header>

      <main id="main-content">
        {tab === "catalog" && (
          <>
            <section className="hero-row">
              <div><p className="eyebrow">A living index of Indian food labels</p><h1>What’s in the pack<br /><em>before</em> the promise.</h1><p>Search canonical products, inspect where each value came from, and compare protein with the evidence state attached.</p></div>
              <div className="hero-orbit" aria-hidden="true"><span>{coverage?.catalog.products.toLocaleString("en-IN") ?? "—"}</span><small>foods indexed</small><i /></div>
            </section>
            <section className="catalog-overview" aria-label="Catalog overview">
              <div><span>Catalog</span><strong>{coverage?.catalog.products.toLocaleString("en-IN") ?? "—"}</strong><small>canonical food records</small></div>
              <div><span>Protein discovery</span><strong>{coverage?.catalog.marketedProtein.toLocaleString("en-IN") ?? "—"}</strong><small>marketed protein products</small></div>
              <div><span>Protein-branded</span><strong>{coverage?.catalog.proteinBranded.toLocaleString("en-IN") ?? "—"}</strong><small>default discovery set</small></div>
              <div><span>Comparable macros</span><strong>{coverage?.catalog.proteinBrandedWithUsableNutrition.toLocaleString("en-IN") ?? "—"}</strong><small>protein-branded with calories + protein</small></div>
              <div><span>Machine labels</span><strong>{coverage?.catalog.machineVerifiedNutrition.toLocaleString("en-IN") ?? "—"}</strong><small>machine-verified nutrition</small></div>
              <div><span>Nutrition evidence</span><strong>{coverage ? (coverage.catalog.verifiedNutrition + coverage.catalog.unverifiedNutrition).toLocaleString("en-IN") : "—"}</strong><small>{coverage?.catalog.verifiedNutrition.toLocaleString("en-IN") ?? "—"} label verified</small></div>
              <div><span>Ingredients</span><strong>{coverage ? (coverage.catalog.verifiedIngredients + coverage.catalog.unverifiedIngredients).toLocaleString("en-IN") : "—"}</strong><small>statements captured</small></div>
              <button onClick={() => setTab("coverage")}><span>Source state</span><strong>{coverage?.completion.sourceCoverageComplete ? "Source-complete" : "Checking"}</strong><small>loaded free sources →</small></button>
            </section>
            <section className="trust-switch" aria-label="Comparison trust mode">
              <div><p className="eyebrow">Choose your evidence boundary</p><strong>{catalog?.trustedDefault ? "Trusted comparisons" : "Discovery catalog"}</strong><span>{catalog?.trustedDefault ? "Exact current identity, verified nutrition, and terminal ingredient evidence are required." : "Validation-passing community values can rank here with an unverified label; use Scope to explore every retained food."}</span></div>
              <div role="group" aria-label="Evidence boundary"><button className={catalog?.trustedDefault ? "active" : ""} aria-pressed={catalog?.trustedDefault ?? false} onClick={showTrusted}>Trusted</button><button className={catalog && !catalog.trustedDefault ? "active" : ""} aria-pressed={catalog ? !catalog.trustedDefault : false} onClick={showDiscovery}>Discovery</button></div>
            </section>
            <section className="filters" aria-label="Catalog filters">
              <label className="search-field" htmlFor="catalog-search"><span>Search the index</span><input id="catalog-search" name="catalogSearch" type="search" value={filters.q} onChange={(event) => updateFilters({ q: event.target.value })} placeholder="Try Amul, whey, paneer, or a GTIN" /></label>
              <label htmlFor="catalog-category">Category<select id="catalog-category" name="category" value={filters.category} onChange={(event) => updateFilters({ category: event.target.value })}><option value="all">All categories</option><option value="protein_powder">Protein powder</option><option value="protein_bar">Protein bars</option><option value="protein_snack">Protein snacks</option><option value="soy_product">Soy products</option><option value="dairy">Dairy</option><option value="ready_to_drink">Ready to drink</option><option value="breakfast">Breakfast</option><option value="spread">Spreads</option><option value="other">Other food</option></select></label>
              <label htmlFor="catalog-evidence">Evidence<select id="catalog-evidence" name="evidence" value={filters.verification} onChange={(event) => updateFilters({ trust: "all", verification: event.target.value })}><option value="verified">Verified nutrition</option><option value="machine_verified">Machine-verified label</option><option value="unverified">Unverified</option><option value="conflict">Conflicts</option><option value="missing">Missing</option><option value="all">All evidence</option></select></label>
              <label htmlFor="catalog-ingredients">Ingredients<select id="catalog-ingredients" name="ingredientEvidence" value={filters.ingredientVerification} onChange={(event) => updateFilters({ trust: "all", ingredientVerification: event.target.value })}><option value="verified">Verified ingredients</option><option value="unverified">Unverified</option><option value="conflict">Conflicts</option><option value="missing">Missing</option><option value="all">All evidence</option></select></label>
              <label htmlFor="catalog-scope">Scope<select id="catalog-scope" name="scope" value={filters.scope} onChange={(event) => updateFilters({ scope: event.target.value })}><option value="protein_branded">Protein-branded discovery</option><option value="protein">Protein cohorts</option><option value="all">All ingested foods</option></select></label>
              <label htmlFor="catalog-sort">Sort<select id="catalog-sort" name="sort" value={filters.sort} onChange={(event) => updateFilters({ sort: event.target.value })}><option value="protein_density">Protein / 100 kcal</option><option value="completeness">Field coverage</option><option value="name">Name</option></select></label>
            </section>
            <div className="result-meta" aria-live="polite"><span>{catalog?.pagination.total.toLocaleString("en-IN") ?? "—"} results</span><small>Missing values stay missing. Unverified values never enter trusted metrics.</small></div>
            {catalogState.loading && <div className="loading" role="status"><span className="loader" />Querying canonical catalog…</div>}
            {catalogState.error && <div className="error-state" role="alert"><strong>Catalog unavailable</strong><span>{catalogState.error}</span><button onClick={loadCatalog}>Try again</button></div>}
            {catalog && !catalogState.loading && !catalogState.error && <CatalogTable data={catalog} onOpen={setSelectedId} onExplore={showDiscovery} page={page} onPage={setPage} />}
          </>
        )}
        {tab === "reviews" && <><section className="page-head"><p className="eyebrow">Human verification gate</p><h1>Evidence review queue</h1><p>{isPublic ? "Inspect unresolved evidence and decision history. Production decisions remain read-only until operator authentication is in place." : "Resolve conflicts without discarding the original source record."}</p></section>{reviewId && <div className="read-only-notice"><strong>Focused review</strong><span>Showing the exact ledger-linked evidence item.</span><button className="ghost" onClick={() => setReviewId(null)}>Return to full queue</button></div>}<Reviews data={reviews} loading={reviewState.loading} error={reviewState.error} onResolve={resolve} onOpenProduct={setSelectedId} typeFilter={reviewType} statusFilter={reviewStatus} page={reviewPage} onType={(type) => { setReviewId(null); setReviewPage(1); setReviewType(type); }} onStatus={(status) => { setReviewId(null); setReviewPage(1); setReviewStatus(status); }} onPage={setReviewPage} readOnly={isPublic} /></>}
        {tab === "coverage" && <><section className="page-head"><p className="eyebrow">No fake completeness claims</p><h1>Coverage ledger</h1><p>Completeness is proved per configured free source, never presented as the whole Indian market.</p></section><Coverage data={coverage} loading={coverageState.loading} error={coverageState.error} completion={completion} completionLoading={completionState.loading} completionError={completionState.error} completionFilters={completionFilters} completionFocusRequest={completionFocusRequest} onCompletionFamily={changeCompletionFamily} onCompletionState={changeCompletionState} onCompletionLane={changeCompletionLane} onCompletionQuery={changeCompletionQuery} onCompletionPage={changeCompletionPage} onCompletionRetry={loadCompletion} onCompletionDrillDown={drillIntoCompletion} onOpenProduct={setSelectedId} onOpenReview={openCompletionReview} onEvidenceCommitted={refreshAfterEvidenceDecision} readOnly={isPublic} /></>}
      </main>
      <footer><span>Protein Index</span><p>Evidence before rankings. Configured-source coverage, never a claim of the whole Indian market.</p><button onClick={() => setTab("coverage")}>Read the coverage ledger</button></footer>
      {selectedId && <ProductDrawer detail={detail} loading={detailState.loading} error={detailState.error} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

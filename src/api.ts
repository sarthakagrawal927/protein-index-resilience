import type {
  CatalogResponse,
  CompletionLedgerResponse,
  CoverageResponse,
  HealthResponse,
  IdentityEvidenceDecisionRequest,
  IdentityEvidenceDecisionResponse,
  ProductDetailResponse,
  ReviewResponse,
} from "../shared/api";
import type { ReviewedNutritionProjection } from "../shared/evidence-decisions";
import type {
  RecordTerminalEvidenceInput,
  RecordTerminalEvidenceResponse,
  TerminalEvidenceErrorCode,
  TerminalEvidenceErrorDetails,
  TerminalEvidenceFieldFamily,
  TerminalEvidenceListQuery,
  TerminalEvidenceOptionsResponse,
} from "../shared/terminal-evidence";
import { isTerminalEvidenceErrorCode } from "../shared/terminal-evidence";

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export class TerminalEvidenceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: TerminalEvidenceErrorCode,
    readonly details: TerminalEvidenceErrorDetails | null,
  ) {
    super(message);
    this.name = "TerminalEvidenceRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { error?: { code?: string; message?: string; details?: unknown } }).error
      : null;
    throw new ApiRequestError(
      error?.message ?? `Request failed (${response.status})`,
      response.status,
      error?.code ?? "request_failed",
      typeof error?.details === "object" && error.details !== null && !Array.isArray(error.details)
        ? error.details as Record<string, unknown>
        : null,
    );
  }
  return body as T;
}

async function terminalEvidenceRequest<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (reason) {
    if (reason instanceof ApiRequestError && isTerminalEvidenceErrorCode(reason.code)) {
      throw new TerminalEvidenceRequestError(
        reason.message,
        reason.status,
        reason.code,
        reason.details && typeof reason.details.evidenceId === "string"
          ? { evidenceId: reason.details.evidenceId }
          : null,
      );
    }
    throw reason;
  }
}

async function allTerminalEvidence(
  productId: string,
  family: TerminalEvidenceFieldFamily,
  signal?: AbortSignal,
): Promise<TerminalEvidenceOptionsResponse> {
  const query: TerminalEvidenceListQuery = { page: 1, pageSize: 100 };
  const path = (page: number) => `/api/products/${encodeURIComponent(productId)}/terminal-evidence?family=${family}&page=${page}&pageSize=${query.pageSize}`;
  const first = await terminalEvidenceRequest<TerminalEvidenceOptionsResponse>(path(query.page), { signal });
  const maximumPages = 20;
  const maximumOptions = maximumPages * query.pageSize;
  if (
    !Number.isInteger(first.pagination.pages)
    || first.pagination.pages < 0
    || !Number.isInteger(first.pagination.total)
    || first.pagination.total < 0
    || first.pagination.page !== 1
    || first.pagination.pageSize !== query.pageSize
    || first.pagination.pages !== Math.ceil(first.pagination.total / query.pageSize)
    || first.pagination.pages > maximumPages
    || first.pagination.total > maximumOptions
  ) {
    throw new Error(`Terminal evidence exceeds the bounded ${maximumOptions}-option review limit`);
  }
  if (first.pagination.pages <= 1) {
    if (first.items.length !== first.pagination.total
      || new Set(first.items.map(({ evidenceId }) => evidenceId)).size !== first.items.length) {
      throw new Error("Terminal evidence pagination changed while the options were loading");
    }
    return first;
  }
  const remaining = await Promise.all(
    Array.from({ length: first.pagination.pages - 1 }, (_, index) => index + 2)
      .map((page) => terminalEvidenceRequest<TerminalEvidenceOptionsResponse>(path(page), { signal })),
  );
  if (remaining.some((response, index) => (
    response.productId !== first.productId
    || response.family !== first.family
    || response.pagination.page !== index + 2
    || response.pagination.pages !== first.pagination.pages
    || response.pagination.total !== first.pagination.total
  ))) {
    throw new Error("Terminal evidence pagination changed while the options were loading");
  }
  const items = [first, ...remaining].flatMap((response) => response.items);
  if (items.length !== first.pagination.total || new Set(items.map(({ evidenceId }) => evidenceId)).size !== items.length) {
    throw new Error("Terminal evidence pagination changed while the options were loading");
  }
  return { ...first, items };
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  catalog: (params: URLSearchParams, signal?: AbortSignal) =>
    request<CatalogResponse>(`/api/products?${params}`, { signal }),
  product: (id: string, signal?: AbortSignal) =>
    request<ProductDetailResponse>(`/api/products/${encodeURIComponent(id)}`, { signal }),
  reviews: (params = new URLSearchParams({ status: "open", type: "all", page: "1", pageSize: "50" }), signal?: AbortSignal) =>
    request<ReviewResponse>(`/api/reviews?${params}`, { signal }),
  coverage: () => request<CoverageResponse>("/api/coverage"),
  completionLedger: (params: URLSearchParams, signal?: AbortSignal) =>
    request<CompletionLedgerResponse>(`/api/completion-ledger?${params}`, { signal }),
  verifyIdentityEvidence: (productId: string, input: IdentityEvidenceDecisionRequest) =>
    request<IdentityEvidenceDecisionResponse>(`/api/products/${encodeURIComponent(productId)}/identity-evidence`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  terminalEvidence: (productId: string, family: TerminalEvidenceFieldFamily, signal?: AbortSignal) =>
    allTerminalEvidence(productId, family, signal),
  recordTerminalEvidence: (productId: string, input: RecordTerminalEvidenceInput) =>
    terminalEvidenceRequest<RecordTerminalEvidenceResponse>(`/api/products/${encodeURIComponent(productId)}/terminal-evidence`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  resolveReview: (id: string, decision: string, rationale: string, evidenceUrl: string | null, candidateProductId: string | null, reviewedText: string | null, reviewedProjection: ReviewedNutritionProjection | null = null) =>
    request<{ status: string }>(`/api/reviews/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        rationale,
        evidenceUrl,
        candidateProductId,
        reviewedText,
        ...(reviewedProjection ? { reviewedProjection } : {}),
      }),
    }),
};

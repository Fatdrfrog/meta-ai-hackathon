import {
  isConversationStatus,
  type ConversationStatus,
} from "@icecore/shared/types/conversation";

const REQUESTS_INSIGHT_FILTERS = [
  "slaBreached",
  "csatLow",
  "bestPractice",
] as const;

type RequestsInsightFilter = (typeof REQUESTS_INSIGHT_FILTERS)[number];

type RequestsListQuery = {
  status: ConversationStatus | null;
  filter: RequestsInsightFilter | null;
};

type RequestsListQueryInput =
  | Pick<URLSearchParams, "get">
  | Record<string, string | string[] | undefined>;

const INSIGHT_FILTER_SET = new Set<string>(REQUESTS_INSIGHT_FILTERS);

function readQueryValue(
  input: RequestsListQueryInput,
  key: string
): string | null {
  if (typeof (input as Pick<URLSearchParams, "get">).get === "function") {
    const value = (input as Pick<URLSearchParams, "get">).get(key);
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  const raw = (input as Record<string, string | string[] | undefined>)[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseRequestsListQuery(
  input: RequestsListQueryInput
): RequestsListQuery {
  const statusRaw = readQueryValue(input, "status");
  const filterRaw = readQueryValue(input, "filter");

  return {
    status:
      statusRaw && isConversationStatus(statusRaw) ? statusRaw : null,
    filter:
      filterRaw && INSIGHT_FILTER_SET.has(filterRaw)
        ? (filterRaw as RequestsInsightFilter)
        : null,
  };
}

export function hasRequestsListQuery(query: RequestsListQuery): boolean {
  return query.status !== null || query.filter !== null;
}

export function requestsListQuerySignature(query: RequestsListQuery): string {
  return `status:${query.status ?? ""}|filter:${query.filter ?? ""}`;
}

export function clearRequestsListQueryParams(params: URLSearchParams): void {
  params.delete("filter");
  params.delete("status");
}

/** Fields needed to enforce URL list filters on already-loaded rows. */
type RequestsListQueryRow = {
  status?: string | null;
  customerSatisfactionScore?: number | null;
};

/**
 * Client-side enforcement of URL list filters.
 * Keeps the inbox truthful even when SSR/realtime data is broader than the query.
 * Complex filters (SLA age, best-practice flag) still rely on the server fetch.
 */
export function requestMatchesListQuery(
  row: RequestsListQueryRow,
  query: RequestsListQuery
): boolean {
  if (query.status && row.status !== query.status) {
    return false;
  }

  if (query.filter === "csatLow") {
    const score = row.customerSatisfactionScore;
    if (score == null || score > 3) {
      return false;
    }
  }

  if (query.filter === "slaBreached" && row.status === "closed") {
    return false;
  }

  return true;
}

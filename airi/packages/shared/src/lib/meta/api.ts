import { buildGraphApiUrl, META_GRAPH_ORIGIN } from "./graph-version";

export { buildGraphApiUrl } from "./graph-version";

export async function parseGraphResponse<T = unknown>(
  response: Response,
  parseAs: "json" | "text" | "auto" = "auto",
): Promise<T> {
  if (parseAs === "text") {
    return (await response.text()) as T;
  }

  if (parseAs === "json") {
    return (await response.json()) as T;
  }

  const parsed = await parseResponsePayload(response);
  return parsed.details as T;
}

export interface MetaGraphAPIError {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
  fbtrace_id?: string;
  error_user_title?: string;
  error_user_msg?: string;
  error_data?: {
    details?: string;
  };
}

export function formatMetaGraphAPIError(error: MetaGraphAPIError): {
  message: string;
  actionable: string | null;
  requiresReconnect: boolean;
} {
  const { message, code, error_subcode, type } = error;

  if (code === 100) {
    if (error_subcode === 33) {
      return {
        message: `Object does not exist or missing permissions: ${message}`,
        actionable:
          "The WABA or phone number may not exist, or the access token doesn't have permissions. Check if the account has a valid payment method and try reconnecting.",
        requiresReconnect: true,
      };
    }

    return {
      message: `Invalid parameter: ${message}`,
      actionable: "Check that the WABA ID and phone number ID are correct.",
      requiresReconnect: false,
    };
  }

  if (code === 200) {
    return {
      message: `Permissions error: ${message}`,
      actionable:
        "The access token doesn't have the required permissions. Reconnect WhatsApp integration to get a fresh token with proper permissions.",
      requiresReconnect: true,
    };
  }

  if (code === 190) {
    return {
      message: `Invalid access token: ${message}`,
      actionable:
        "The access token is invalid or expired. Reconnect WhatsApp integration.",
      requiresReconnect: true,
    };
  }

  return {
    message: `${type || "Error"} (${code}${error_subcode ? `, subcode ${error_subcode}` : ""}): ${message}`,
    actionable: null,
    requiresReconnect: code === 190 || code === 200,
  };
}

type QueryPrimitive = string | number | boolean;
type QueryValue = QueryPrimitive | QueryPrimitive[] | null | undefined;

export type GraphQuery = Record<string, QueryValue>;

interface GraphRequestBaseOptions {
  token?: string;
  query?: GraphQuery;
  headers?: HeadersInit;
  method?: string;
  body?: unknown;
  parseAs?: "json" | "text" | "auto";
}

export interface GraphRequestOptions
  extends Omit<RequestInit, "method" | "body" | "headers">,
    GraphRequestBaseOptions {}

export class MetaGraphRequestError extends Error {
  status: number;
  statusText: string;
  url: string;
  details: unknown;
  metaError?: MetaGraphAPIError;
  formattedError?: ReturnType<typeof formatMetaGraphAPIError>;

  constructor(params: {
    message: string;
    status: number;
    statusText: string;
    url: string;
    details: unknown;
    metaError?: MetaGraphAPIError;
    formattedError?: ReturnType<typeof formatMetaGraphAPIError>;
  }) {
    super(params.message);
    this.name = "MetaGraphRequestError";
    this.status = params.status;
    this.statusText = params.statusText;
    this.url = params.url;
    this.details = params.details;
    this.metaError = params.metaError;
    this.formattedError = params.formattedError;
  }
}

export type MetaGraphPaginationErrorReason = "page_limit" | "cycle";

export class MetaGraphPaginationError extends Error {
  readonly code = "META_GRAPH_PAGINATION_ERROR";
  readonly reason: MetaGraphPaginationErrorReason;

  constructor(reason: MetaGraphPaginationErrorReason) {
    super(
      reason === "page_limit"
        ? "Meta Graph page limit exceeded"
        : "Meta Graph pagination cycle detected",
    );
    this.name = "MetaGraphPaginationError";
    this.reason = reason;
  }
}

/**
 * Identifies provider throttling without relying on localized error text.
 * Callers can use this to stop request fan-out and apply a shared cooldown.
 */
export type MetaGraphRateLimitMetadata = {
  status?: number;
  code?: number;
};

const META_GRAPH_RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80008]);

export function getMetaGraphRateLimitMetadata(
  error: unknown,
): MetaGraphRateLimitMetadata | null {
  if (typeof error !== "object" || error === null) return null;

  const candidate = error as {
    status?: unknown;
    metaError?: unknown;
  };
  const status =
    typeof candidate.status === "number" ? candidate.status : undefined;
  const metaError =
    typeof candidate.metaError === "object" && candidate.metaError !== null
      ? (candidate.metaError as { code?: unknown })
      : undefined;
  const code = typeof metaError?.code === "number" ? metaError.code : undefined;

  return status === 429 ||
    (code !== undefined && META_GRAPH_RATE_LIMIT_CODES.has(code))
    ? { status, code }
    : null;
}

export function isMetaGraphRateLimitError(error: unknown): boolean {
  return getMetaGraphRateLimitMetadata(error) !== null;
}

/**
 * Identifies failures that require the customer to reconnect or re-authorize
 * the Meta integration. Generic parameter errors (including code 100 without
 * the missing-object subcode) are deliberately excluded.
 */
export type MetaGraphAuthorizationMetadata = {
  status?: number;
  code?: number;
  subcode?: number;
  requiresReconnect: true;
};

export function getMetaGraphAuthorizationMetadata(
  error: unknown,
): MetaGraphAuthorizationMetadata | null {
  if (typeof error !== "object" || error === null) return null;

  const candidate = error as {
    status?: unknown;
    metaError?: unknown;
    formattedError?: unknown;
  };
  const status =
    typeof candidate.status === "number" ? candidate.status : undefined;
  const metaError =
    typeof candidate.metaError === "object" && candidate.metaError !== null
      ? (candidate.metaError as {
          code?: unknown;
          error_subcode?: unknown;
        })
      : undefined;
  const code = typeof metaError?.code === "number" ? metaError.code : undefined;
  const subcode =
    typeof metaError?.error_subcode === "number"
      ? metaError.error_subcode
      : undefined;
  const formattedError =
    typeof candidate.formattedError === "object" &&
    candidate.formattedError !== null
      ? (candidate.formattedError as { requiresReconnect?: unknown })
      : undefined;
  const requiresReconnect = formattedError?.requiresReconnect === true;

  if (
    status !== 401 &&
    status !== 403 &&
    code !== 10 &&
    code !== 190 &&
    code !== 200 &&
    !(code === 100 && subcode === 33) &&
    !requiresReconnect
  ) {
    return null;
  }

  return {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(subcode !== undefined ? { subcode } : {}),
    requiresReconnect: true,
  };
}

export function isMetaGraphAuthorizationError(error: unknown): boolean {
  return getMetaGraphAuthorizationMetadata(error) !== null;
}

function isAbsoluteUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

function appendQuery(url: URL, query?: GraphQuery): void {
  if (!query) return;
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null) continue;

    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }

    url.searchParams.set(key, String(rawValue));
  }
}

function parseBody(body: unknown): {
  body: BodyInit | null | undefined;
  isJson: boolean;
} {
  if (body === undefined) {
    return {
      body: undefined,
      isJson: false,
    };
  }

  if (body === null) {
    return {
      body: null,
      isJson: false,
    };
  }

  if (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof ReadableStream
  ) {
    return {
      body: body as BodyInit,
      isJson: false,
    };
  }

  return {
    body: JSON.stringify(body),
    isJson: true,
  };
}

async function parseResponsePayload(response: Response): Promise<{
  details: unknown;
  text: string;
}> {
  const text = await response.text();

  if (!text) {
    return {
      details: null,
      text: "",
    };
  }

  try {
    return {
      details: JSON.parse(text),
      text,
    };
  } catch {
    return {
      details: text,
      text,
    };
  }
}

export interface WhatsAppGraphClient {
  request(path: string, options?: GraphRequestOptions): Promise<Response>;
  getJson<T = unknown>(
    path: string,
    options: Omit<GraphRequestOptions, "method" | "body"> & {
      token: string;
    },
  ): Promise<T>;
  postJson<T = unknown>(
    path: string,
    options: Omit<GraphRequestOptions, "method"> & {
      token: string;
    },
  ): Promise<T>;
}

const META_GRAPH_HOST = new URL(META_GRAPH_ORIGIN).host;

function redactUrlQueryValues(rawUrl: string): string {
  if (!rawUrl) return "";

  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    const queryIndex = rawUrl.indexOf("?");
    return queryIndex >= 0
      ? `${rawUrl.slice(0, queryIndex)}?[REDACTED]`
      : rawUrl;
  }
}

function redactDiagnosticQueryValues(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[REDACTED]";
  if (typeof value === "string") {
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, (match) =>
      redactUrlQueryValues(match),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticQueryValues(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactDiagnosticQueryValues(item, depth + 1),
      ]),
    );
  }
  return value;
}

export function sanitizeMetaGraphErrorPayload<T>(value: T): T {
  return (
    parseMetaGraphAPIError(value) ? redactDiagnosticQueryValues(value) : value
  ) as T;
}

export function normalizeMetaGraphPagingNextUrl(rawNext: string): string {
  const authorityMatch = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(rawNext);
  if (!authorityMatch || authorityMatch[1]?.toLowerCase() !== META_GRAPH_HOST) {
    throw new Error("Rejected unsafe Meta Graph paging URL");
  }

  let url: URL;
  try {
    url = new URL(rawNext);
  } catch {
    throw new Error("Rejected unsafe Meta Graph paging URL");
  }

  if (
    url.protocol !== "https:" ||
    url.origin !== META_GRAPH_ORIGIN ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error("Rejected unsafe Meta Graph paging URL");
  }

  for (const key of Array.from(url.searchParams.keys())) {
    if (key.toLowerCase() === "access_token") {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

export type MetaGraphPageBoundary = {
  pageNumber: number;
  collectedItems: number;
};

export async function collectMetaGraphEdge<T>(params: {
  client: WhatsAppGraphClient;
  accessToken: string;
  path: string;
  initialQuery?: Readonly<Record<string, string | number | boolean>>;
  maxPages: number;
  maxItems: number;
  beforePage?: (boundary: MetaGraphPageBoundary) => void | Promise<void>;
  createRequestSignal?: () => AbortSignal;
  normalizePage: (payload: unknown) => {
    data: readonly T[];
    next?: string;
  };
}): Promise<T[]> {
  if (!Number.isInteger(params.maxPages) || params.maxPages < 1) {
    throw new Error("Meta Graph page limit must be a positive integer");
  }
  if (!Number.isInteger(params.maxItems) || params.maxItems < 0) {
    throw new Error("Meta Graph item limit must be a non-negative integer");
  }
  if (params.maxItems === 0) return [];

  const items: T[] = [];
  const seenNextUrls = new Set<string>();
  let nextPath = params.path;
  let pageCount = 0;
  let firstPage = true;

  while (items.length < params.maxItems) {
    pageCount += 1;
    await params.beforePage?.({
      pageNumber: pageCount,
      collectedItems: items.length,
    });
    const signal = params.createRequestSignal?.();
    const requestedLimit = Number(params.initialQuery?.limit);
    const initialLimit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.floor(requestedLimit)
        : params.maxItems;
    const payload = await params.client.getJson<unknown>(
      nextPath,
      firstPage
        ? {
            token: params.accessToken,
            query: {
              ...(params.initialQuery || {}),
              limit: Math.min(params.maxItems, initialLimit),
            },
            ...(signal ? { signal } : {}),
          }
        : {
            token: params.accessToken,
            ...(signal ? { signal } : {}),
          },
    );
    const page = params.normalizePage(payload);
    const remaining = params.maxItems - items.length;
    items.push(...page.data.slice(0, remaining));

    const rawNext = page.next?.trim();
    if (!rawNext || items.length >= params.maxItems) return items;

    const safeNext = normalizeMetaGraphPagingNextUrl(rawNext);
    if (seenNextUrls.has(safeNext)) {
      throw new MetaGraphPaginationError("cycle");
    }
    seenNextUrls.add(safeNext);

    if (pageCount >= params.maxPages) {
      throw new MetaGraphPaginationError("page_limit");
    }

    nextPath = safeNext;
    firstPage = false;
  }

  return items;
}

class WhatsAppGraphClientImpl implements WhatsAppGraphClient {
  async request(
    path: string,
    options: GraphRequestOptions = {},
  ): Promise<Response> {
    const {
      token,
      query,
      headers,
      method,
      body,
      parseAs: _parseAs,
      ...init
    } = options;
    void _parseAs;
    const url = new URL(isAbsoluteUrl(path) ? path : buildGraphApiUrl(path));
    appendQuery(url, query);

    const parsedBody = parseBody(body);
    const requestHeaders = new Headers(headers || {});
    if (token && !requestHeaders.has("Authorization")) {
      requestHeaders.set("Authorization", `Bearer ${token}`);
    }
    if (
      parsedBody.isJson &&
      parsedBody.body !== undefined &&
      !requestHeaders.has("Content-Type")
    ) {
      requestHeaders.set("Content-Type", "application/json");
    }

    return fetch(url.toString(), {
      ...init,
      method: method || (body !== undefined ? "POST" : "GET"),
      headers: requestHeaders,
      body: parsedBody.body,
    });
  }

  async getJson<T = unknown>(
    path: string,
    options: Omit<GraphRequestOptions, "method" | "body"> & {
      token: string;
    },
  ): Promise<T> {
    return this.requestJson<T>(path, {
      ...options,
      method: "GET",
    });
  }

  async postJson<T = unknown>(
    path: string,
    options: Omit<GraphRequestOptions, "method"> & {
      token: string;
    },
  ): Promise<T> {
    return this.requestJson<T>(path, {
      ...options,
      method: "POST",
    });
  }

  private async requestJson<T = unknown>(
    path: string,
    options: GraphRequestOptions,
  ): Promise<T> {
    const response = await this.request(path, {
      ...options,
      parseAs: "json",
    });

    let parsed: Awaited<ReturnType<typeof parseResponsePayload>>;
    try {
      parsed = await parseResponsePayload(response);
    } catch {
      throw new MetaGraphRequestError({
        message: "Meta Graph API response body could not be read",
        status: response.status,
        statusText: response.statusText,
        url: redactUrlQueryValues(response.url),
        details: { reason: "response_body_unavailable" },
      });
    }
    const responseDetails = response.ok
      ? sanitizeMetaGraphErrorPayload(parsed.details)
      : redactDiagnosticQueryValues(parsed.details);
    if (!response.ok) {
      const metaError = parseMetaGraphAPIError(responseDetails);
      const formattedError = metaError
        ? formatMetaGraphAPIError(metaError)
        : undefined;
      throw new MetaGraphRequestError({
        message:
          formattedError?.message ||
          `Meta Graph API request failed: HTTP ${response.status}`,
        status: response.status,
        statusText: response.statusText,
        url: redactUrlQueryValues(response.url),
        details: responseDetails,
        metaError: metaError || undefined,
        formattedError,
      });
    }

    if (responseDetails === null || responseDetails === undefined) {
      return {} as T;
    }

    if (typeof responseDetails === "string") {
      throw new MetaGraphRequestError({
        message: "Expected JSON response from Meta Graph API",
        status: response.status,
        statusText: response.statusText,
        url: redactUrlQueryValues(response.url),
        details: redactDiagnosticQueryValues(responseDetails),
      });
    }

    return responseDetails as T;
  }
}

let graphClientSingleton: WhatsAppGraphClient | null = null;

export function getWhatsAppGraphClient(): WhatsAppGraphClient {
  if (!graphClientSingleton) {
    graphClientSingleton = new WhatsAppGraphClientImpl();
  }
  return graphClientSingleton;
}

export const WHATSAPP_BUSINESS_PLATFORM_NUMBER_NOT_ELIGIBLE_ERROR_CODE = 3441045;

export function parseMetaGraphAPIError(
  errorData: unknown,
): MetaGraphAPIError | null {
  try {
    if (typeof errorData === "string") {
      const parsed = JSON.parse(errorData);
      if (parsed.error) {
        return parsed.error as MetaGraphAPIError;
      }
      return null;
    }

    if (typeof errorData === "object" && errorData !== null) {
      const obj = errorData as Record<string, unknown>;
      if (obj.error) {
        return obj.error as MetaGraphAPIError;
      }

      if (obj.message && obj.code) {
        return obj as unknown as MetaGraphAPIError;
      }
    }

    return null;
  } catch {
    return null;
  }
}

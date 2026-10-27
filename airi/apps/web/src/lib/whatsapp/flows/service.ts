import {
  collectMetaGraphEdge,
  formatMetaGraphAPIError,
  getWhatsAppGraphClient,
  MetaGraphPaginationError,
  MetaGraphRequestError,
  normalizeMetaGraphPagingNextUrl,
  parseGraphResponse,
  parseMetaGraphAPIError,
  sanitizeMetaGraphErrorPayload,
  type WhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import { computeWhatsAppFlowPublicKeyFingerprint } from "@/lib/whatsapp/flows/endpoint-crypto";
import { invalidateTemplateFlowFacts } from "@/lib/whatsapp/flows/template-flow-facts-cache";
import {
  normalizeWhatsAppFlowCategories,
  WHATSAPP_FLOW_DETAIL_FIELDS,
} from "@icecore/shared/types/whatsapp-flows";
import {
  hasExactKeys,
  readNonEmptyString,
} from "@icecore/shared/lib/value-utils";

export type MetaWhatsAppFlow = Record<string, unknown> & {
  id?: string;
  validation_errors?: unknown[];
  whatsapp_business_account?: unknown;
};

type GraphResponse<T = Record<string, unknown>> = T & {
  error?: {
    message?: string;
    error_user_msg?: string;
    error_data?: {
      details?: string;
    };
  };
};

type GraphPaging = {
  next?: string;
};

export type WhatsAppFlowServiceResult = {
  ok: boolean;
  status: number;
  flow?: MetaWhatsAppFlow | null;
  providerFlowId?: string;
  providerCode?: number;
  providerSubcode?: number;
  error?: string;
  validation_errors?: unknown[];
};

export type WhatsAppFlowListServiceResult = {
  ok: boolean;
  status: number;
  flows?: MetaWhatsAppFlow[];
  paging?: GraphPaging;
  error?: string;
};

export type WhatsAppFlowDetailsServiceResult = WhatsAppFlowServiceResult & {
  flowJson?: unknown;
  flowJsonError?: string | null;
};

type WithClient = {
  client?: WhatsAppGraphClient;
};

export class WhatsAppBusinessEncryptionProviderError extends Error {
  readonly code = "WHATSAPP_BUSINESS_ENCRYPTION_PROVIDER_ERROR";

  constructor() {
    super("WhatsApp business encryption provider request failed");
    this.name = "WhatsAppBusinessEncryptionProviderError";
  }
}

export type WhatsAppBusinessEncryptionStatus =
  | { configured: false }
  | {
      configured: true;
      businessPublicKey: string;
      signatureStatus: "VALID" | "INVALID";
    };

const BUSINESS_ENCRYPTION_STATUS_KEYS = [
  "business_public_key",
  "business_public_key_signature_status",
] as const;
const PUBLIC_KEY_PEM_BEGIN = "-----BEGIN PUBLIC KEY-----";
const PUBLIC_KEY_PEM_END = "-----END PUBLIC KEY-----";

function normalizeBusinessPublicKey(value: unknown): string {
  const businessPublicKey = readNonEmptyString(value);
  if (
    !businessPublicKey ||
    !businessPublicKey.startsWith(PUBLIC_KEY_PEM_BEGIN) ||
    !businessPublicKey.endsWith(PUBLIC_KEY_PEM_END) ||
    businessPublicKey.indexOf(
      PUBLIC_KEY_PEM_BEGIN,
      PUBLIC_KEY_PEM_BEGIN.length
    ) !== -1 ||
    businessPublicKey.indexOf(PUBLIC_KEY_PEM_END) !==
      businessPublicKey.lastIndexOf(PUBLIC_KEY_PEM_END)
  ) {
    throw new WhatsAppBusinessEncryptionProviderError();
  }
  try {
    computeWhatsAppFlowPublicKeyFingerprint(businessPublicKey);
  } catch {
    throw new WhatsAppBusinessEncryptionProviderError();
  }
  return businessPublicKey;
}

function normalizeWhatsAppBusinessEncryptionRecord(
  value: unknown
): WhatsAppBusinessEncryptionStatus {
  const record = asRecord(value);
  if (!record || !hasExactKeys(record, BUSINESS_ENCRYPTION_STATUS_KEYS)) {
    throw new WhatsAppBusinessEncryptionProviderError();
  }
  const businessPublicKey = normalizeBusinessPublicKey(
    record.business_public_key
  );
  const rawSignatureStatus = record?.business_public_key_signature_status;
  if (rawSignatureStatus !== "VALID" && rawSignatureStatus !== "MISMATCH") {
    throw new WhatsAppBusinessEncryptionProviderError();
  }
  return {
    configured: true,
    businessPublicKey,
    signatureStatus: rawSignatureStatus === "VALID" ? "VALID" : "INVALID",
  };
}

export async function getWhatsAppBusinessEncryptionStatus(
  params: WithClient & {
    phoneNumberId: string;
    accessToken: string;
    signal?: AbortSignal;
  }
): Promise<WhatsAppBusinessEncryptionStatus> {
  const client = params.client ?? getWhatsAppGraphClient();
  let response: unknown;
  try {
    response = await client.getJson<unknown>(
      `${params.phoneNumberId}/whatsapp_business_encryption`,
      {
        token: params.accessToken,
        ...(params.signal ? { signal: params.signal } : {}),
      }
    );
  } catch {
    throw new WhatsAppBusinessEncryptionProviderError();
  }
  const envelope = asRecord(response);
  if (envelope && Object.hasOwn(envelope, "data")) {
    if (!hasExactKeys(envelope, ["data"]) || !Array.isArray(envelope.data)) {
      throw new WhatsAppBusinessEncryptionProviderError();
    }
    if (envelope.data.length === 0) return { configured: false };
    if (envelope.data.length !== 1) {
      throw new WhatsAppBusinessEncryptionProviderError();
    }
    return normalizeWhatsAppBusinessEncryptionRecord(envelope.data[0]);
  }
  return normalizeWhatsAppBusinessEncryptionRecord(response);
}

export async function uploadWhatsAppBusinessEncryptionPublicKey(
  params: WithClient & {
    phoneNumberId: string;
    businessPublicKey: string;
    accessToken: string;
    signal?: AbortSignal;
  }
): Promise<void> {
  const client = params.client ?? getWhatsAppGraphClient();
  const businessPublicKey = normalizeBusinessPublicKey(
    params.businessPublicKey
  );
  const body = new URLSearchParams();
  body.set("business_public_key", businessPublicKey);
  let response: unknown;
  try {
    response = await client.postJson(
      `${params.phoneNumberId}/whatsapp_business_encryption`,
      {
        token: params.accessToken,
        body,
        ...(params.signal ? { signal: params.signal } : {}),
      }
    );
  } catch {
    throw new WhatsAppBusinessEncryptionProviderError();
  }
  const acknowledgement = asRecord(response);
  if (
    !acknowledgement ||
    Object.keys(acknowledgement).length !== 1 ||
    acknowledgement.success !== true
  ) {
    throw new WhatsAppBusinessEncryptionProviderError();
  }
}

type CreateMetaWhatsAppFlowParams = WithClient & {
  accessToken: string;
  wabaId: string;
  name: string;
  categories?: string[];
  cloneFlowId?: string;
  endpointUri?: string;
  flowJson?: string;
  publish?: boolean;
};

type UpdateMetaWhatsAppFlowParams = WithClient & {
  accessToken: string;
  flowId: string;
  operation: "publish" | "deprecate" | "update" | "update_json";
  name?: string;
  categories?: string[];
  endpointUri?: string;
  applicationId?: string;
  flowJson?: string;
};

const WHATSAPP_FLOW_ASSET_FIELDS =
  "asset_type,download_url,created_at,updated_time";

function buildWhatsAppFlowFields(phoneNumberId?: string | null): string {
  const healthStatusField = phoneNumberId
    ? `health_status.phone_number(${phoneNumberId})`
    : "health_status";
  return [
    ...WHATSAPP_FLOW_DETAIL_FIELDS.filter(field => field !== "health_status"),
    healthStatusField,
  ].join(",");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asGraphId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readNonEmptyString(value);
}

function toMillis(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getWhatsAppFlowGraphErrorMessage(
  response: unknown,
  fallback: string
): string {
  const metaError = parseMetaGraphAPIError(response);
  if (metaError) {
    const formatted = formatMetaGraphAPIError(metaError);
    const parts = [
      formatted.message,
      metaError.error_user_title,
      metaError.error_user_msg,
      metaError.error_data?.details,
      formatted.actionable,
      metaError.fbtrace_id ? `fbtrace_id: ${metaError.fbtrace_id}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .filter((part, index, all) => all.indexOf(part) === index);

    return parts.length > 0 ? parts.join(" - ") : fallback;
  }

  const graphResponse = asRecord(response) as GraphResponse<unknown> | null;
  const parts = [
    graphResponse?.error?.message,
    graphResponse?.error?.error_user_msg,
    graphResponse?.error?.error_data?.details,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" - ") : fallback;
}

function collectValidationErrors(response: unknown): unknown[] {
  const validationErrors = asRecord(response)?.validation_errors;
  return Array.isArray(validationErrors) ? validationErrors : [];
}

function hasGraphError(response: unknown): boolean {
  return Boolean(asRecord(response)?.error);
}

function graphFailure(params: {
  response: unknown;
  responseStatus: number;
  fallback: string;
  validationErrors?: unknown[];
}): WhatsAppFlowServiceResult {
  const response = sanitizeMetaGraphErrorPayload(params.response);
  const metaError = parseMetaGraphAPIError(response);
  const validationErrors =
    params.validationErrors ?? collectValidationErrors(response);
  return {
    ok: false,
    status: validationErrors.length > 0 ? 400 : params.responseStatus || 500,
    error: getWhatsAppFlowGraphErrorMessage(response, params.fallback),
    validation_errors: validationErrors,
    flow: asRecord(response) as MetaWhatsAppFlow | null,
    ...(Number.isSafeInteger(metaError?.code)
      ? { providerCode: Number(metaError?.code) }
      : {}),
    ...(Number.isSafeInteger(metaError?.error_subcode)
      ? { providerSubcode: Number(metaError?.error_subcode) }
      : {}),
  };
}

function exceptionFailure(
  error: unknown,
  fallback: string
): WhatsAppFlowServiceResult {
  if (error instanceof MetaGraphRequestError) {
    return graphFailure({
      response: error.details,
      responseStatus: error.status,
      fallback,
    });
  }

  return {
    ok: false,
    status: 500,
    error: error instanceof Error ? error.message : fallback,
    validation_errors: [],
    flow: null,
  };
}

async function readMetaWhatsAppFlow(params: {
  accessToken: string;
  flowId: string;
  phoneNumberId?: string | null;
  client: WhatsAppGraphClient;
  signal?: AbortSignal;
}): Promise<MetaWhatsAppFlow> {
  return params.client.getJson<MetaWhatsAppFlow>(params.flowId, {
    token: params.accessToken,
    query: {
      fields: buildWhatsAppFlowFields(params.phoneNumberId),
    },
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

async function providerConfirmedReadback(params: {
  accessToken: string;
  flowId: string;
  client: WhatsAppGraphClient;
  expectedStatus?: "DRAFT" | "PUBLISHED" | "DEPRECATED";
}): Promise<WhatsAppFlowServiceResult> {
  try {
    const flow = await readMetaWhatsAppFlow(params);
    if (hasGraphError(flow)) {
      return graphFailure({
        response: flow,
        responseStatus: 502,
        fallback: "Failed to read back flow",
      });
    }
    if (
      params.expectedStatus &&
      readNonEmptyString(flow.status) !== params.expectedStatus
    ) {
      return {
        ok: false,
        status: 409,
        error: `Meta did not confirm the Flow as ${params.expectedStatus}`,
        validation_errors: collectValidationErrors(flow),
        flow,
      };
    }
    return {
      ok: true,
      status: 200,
      flow,
    };
  } catch (error) {
    return exceptionFailure(error, "Failed to read back flow");
  }
}

export function isMetaWhatsAppFlowOwnedByWaba(
  flow: unknown,
  wabaId: string
): boolean {
  const expected = asGraphId(wabaId);
  if (!expected) return false;
  const owner = asRecord(flow)?.whatsapp_business_account;
  if (typeof owner === "string" || typeof owner === "number") {
    return asGraphId(owner) === expected;
  }
  return asGraphId(asRecord(owner)?.id) === expected;
}

export async function listMetaWhatsAppFlows(
  params: WithClient & {
    accessToken: string;
    wabaId: string;
    limit?: number;
  }
): Promise<WhatsAppFlowListServiceResult> {
  const client = params.client ?? getWhatsAppGraphClient();
  try {
    const response = await client.getJson<
      GraphResponse<{
        data?: MetaWhatsAppFlow[];
        paging?: GraphPaging;
      }>
    >(`${params.wabaId}/flows`, {
      token: params.accessToken,
      query: {
        fields: buildWhatsAppFlowFields(),
        ...(params.limit ? { limit: params.limit } : {}),
      },
    });
    if (hasGraphError(response)) {
      const failure = graphFailure({
        response,
        responseStatus: 502,
        fallback: "Failed to fetch flows",
      });
      return {
        ok: false,
        status: failure.status,
        error: failure.error,
      };
    }

    let paging: GraphPaging | undefined;
    if (response.paging?.next) {
      try {
        paging = {
          next: normalizeMetaGraphPagingNextUrl(response.paging.next),
        };
      } catch {
        return {
          ok: false,
          status: 502,
          error: "Invalid Meta Graph paging response",
        };
      }
    }

    return {
      ok: true,
      status: 200,
      flows: Array.isArray(response.data) ? response.data : [],
      ...(paging ? { paging } : {}),
    };
  } catch (error) {
    const failure = exceptionFailure(error, "Failed to fetch flows");
    return {
      ok: false,
      status: failure.status,
      error: failure.error,
    };
  }
}

export async function getMetaWhatsAppFlow(
  params: WithClient & {
    accessToken: string;
    flowId: string;
    phoneNumberId?: string | null;
    includeJson?: boolean;
    expectedWabaId?: string;
    /** Aborts every Graph request of this read, including the JSON download. */
    signal?: AbortSignal;
  }
): Promise<WhatsAppFlowDetailsServiceResult> {
  const client = params.client ?? getWhatsAppGraphClient();
  const signalOption = params.signal ? { signal: params.signal } : {};
  let flow: MetaWhatsAppFlow;
  try {
    flow = await readMetaWhatsAppFlow({
      accessToken: params.accessToken,
      flowId: params.flowId,
      phoneNumberId: params.phoneNumberId,
      client,
      ...signalOption,
    });
    if (hasGraphError(flow)) {
      return graphFailure({
        response: flow,
        responseStatus: 502,
        fallback: "Failed to fetch flow details",
      }) as WhatsAppFlowDetailsServiceResult;
    }
  } catch (error) {
    return exceptionFailure(
      error,
      "Failed to fetch flow details"
    ) as WhatsAppFlowDetailsServiceResult;
  }

  if (
    params.expectedWabaId &&
    !isMetaWhatsAppFlowOwnedByWaba(flow, params.expectedWabaId)
  ) {
    return {
      ok: false,
      status: 404,
      error: "Flow not found for this WhatsApp Business Account",
      validation_errors: [],
      flow: null,
    };
  }

  if (!params.includeJson) {
    return {
      ok: true,
      status: 200,
      flow,
    };
  }

  let flowJson: unknown = null;
  let flowJsonError: string | null = null;

  try {
    const assetsResponse = await client.getJson<
      GraphResponse<{
        data?: Array<Record<string, unknown>>;
      }>
    >(`${params.flowId}/assets`, {
      token: params.accessToken,
      query: {
        fields: WHATSAPP_FLOW_ASSET_FIELDS,
      },
      ...signalOption,
    });
    if (hasGraphError(assetsResponse)) {
      flowJsonError = graphFailure({
        response: assetsResponse,
        responseStatus: 502,
        fallback: "Failed to fetch flow assets",
      }).error!;
      return {
        ok: true,
        status: 200,
        flow,
        flowJson,
        flowJsonError,
      };
    }
    const latestFlowJsonAsset =
      (Array.isArray(assetsResponse.data) ? assetsResponse.data : [])
        .flatMap(asset => {
          if (readNonEmptyString(asset.asset_type) !== "FLOW_JSON") return [];
          const downloadUrl = readNonEmptyString(asset.download_url);
          if (!downloadUrl) return [];
          return [
            {
              downloadUrl,
              createdAt:
                readNonEmptyString(asset.updated_time) ??
                readNonEmptyString(asset.created_at),
            },
          ];
        })
        .sort(
          (a, b) =>
            toMillis(b.createdAt ?? null) - toMillis(a.createdAt ?? null)
        )[0] ?? null;

    if (!latestFlowJsonAsset) {
      flowJsonError = "Flow JSON asset not found";
    } else {
      const downloadResponse = await client.request(
        latestFlowJsonAsset.downloadUrl,
        {
          method: "GET",
          token: params.accessToken,
          ...signalOption,
        }
      );
      if (!downloadResponse.ok) {
        flowJsonError = `Failed to download flow JSON (status ${downloadResponse.status})`;
      } else {
        const jsonText = await downloadResponse.text();
        if (!jsonText.trim()) {
          flowJsonError = "Flow JSON asset is empty";
        } else {
          try {
            flowJson = JSON.parse(jsonText);
          } catch {
            flowJsonError = "Flow JSON asset is not valid JSON";
          }
        }
      }
    }
  } catch (error) {
    flowJsonError = exceptionFailure(
      error,
      "Failed to fetch flow assets"
    ).error!;
  }

  return {
    ok: true,
    status: 200,
    flow,
    flowJson,
    flowJsonError,
  };
}

const WHATSAPP_FLOW_RECONCILIATION_MAX_PAGES = 100;
const WHATSAPP_FLOW_RECONCILIATION_MAX_ITEMS = 10_000;
const WHATSAPP_FLOW_RECONCILIATION_PAGE_SIZE = 100;

class WhatsAppFlowReconciliationItemLimitError extends Error {}

function normalizeWhatsAppFlowReconciliationPage(payload: unknown): {
  data: readonly MetaWhatsAppFlow[];
  next?: string;
} {
  const response = asRecord(payload);
  if (!response || Array.isArray(payload) || !Array.isArray(response.data)) {
    throw new Error("Invalid provider Flow list response");
  }
  if (
    !response.data.every(item => {
      const flow = asRecord(item);
      return (
        flow !== null &&
        !Array.isArray(item) &&
        asGraphId(flow.id) !== null &&
        typeof flow.name === "string"
      );
    })
  ) {
    throw new Error("Invalid provider Flow list response");
  }

  const paging = response.paging;
  if (
    paging !== undefined &&
    (asRecord(paging) === null || Array.isArray(paging))
  ) {
    throw new Error("Invalid provider Flow list response");
  }
  const next = asRecord(paging)?.next;
  if (next !== undefined && typeof next !== "string") {
    throw new Error("Invalid provider Flow list response");
  }

  return {
    data: response.data as MetaWhatsAppFlow[],
    ...(typeof next === "string" ? { next } : {}),
  };
}

async function collectWabaFlowsForReconciliation(params: {
  accessToken: string;
  wabaId: string;
  client: WhatsAppGraphClient;
}): Promise<MetaWhatsAppFlow[]> {
  const flows = await collectMetaGraphEdge<MetaWhatsAppFlow>({
    client: params.client,
    accessToken: params.accessToken,
    path: `${params.wabaId}/flows`,
    initialQuery: {
      fields: buildWhatsAppFlowFields(),
      limit: WHATSAPP_FLOW_RECONCILIATION_PAGE_SIZE,
    },
    maxPages: WHATSAPP_FLOW_RECONCILIATION_MAX_PAGES,
    maxItems: WHATSAPP_FLOW_RECONCILIATION_MAX_ITEMS + 1,
    normalizePage: normalizeWhatsAppFlowReconciliationPage,
  });
  if (flows.length > WHATSAPP_FLOW_RECONCILIATION_MAX_ITEMS) {
    throw new WhatsAppFlowReconciliationItemLimitError();
  }
  return flows;
}

function reconciliationLookupFailure(
  error: unknown
): WhatsAppFlowServiceResult {
  if (
    error instanceof WhatsAppFlowReconciliationItemLimitError ||
    error instanceof MetaGraphPaginationError
  ) {
    return {
      ok: false,
      status: 502,
      error: "Provider Flow reconciliation exceeded safe pagination bounds",
      validation_errors: [],
      flow: null,
    };
  }

  const failure = exceptionFailure(error, "Failed to reconcile provider Flows");
  return {
    ...failure,
    status: failure.status === 500 ? 502 : failure.status,
  };
}

/**
 * Exhaustively reconciles a provider Flow created with a deterministic internal
 * name. The extra collected item lets us distinguish a complete result set from
 * one truncated at the item safety bound; ambiguity and truncation fail closed.
 */
export async function findMetaWhatsAppFlowByExactName(
  params: WithClient & {
    accessToken: string;
    wabaId: string;
    name: string;
  }
): Promise<WhatsAppFlowServiceResult> {
  const exactName = readNonEmptyString(params.name);
  if (!exactName) {
    return {
      ok: false,
      status: 400,
      error: "Invalid provider Flow reconciliation input",
      validation_errors: [],
      flow: null,
    };
  }

  const client = params.client ?? getWhatsAppGraphClient();
  try {
    const flows = await collectWabaFlowsForReconciliation({
      accessToken: params.accessToken,
      wabaId: params.wabaId,
      client,
    });
    const matches = flows.filter(flow => flow.name === exactName);
    if (matches.length > 1) {
      return {
        ok: false,
        status: 409,
        error: "Multiple provider Flows use the exact reconciliation name",
        validation_errors: [],
        flow: null,
      };
    }
    return {
      ok: true,
      status: 200,
      flow: matches[0] ?? null,
    };
  } catch (error) {
    return reconciliationLookupFailure(error);
  }
}

export async function findMetaWhatsAppFlowByIdOnWaba(
  params: WithClient & {
    accessToken: string;
    wabaId: string;
    flowId: string;
  }
): Promise<WhatsAppFlowServiceResult> {
  const flowId = asGraphId(params.flowId);
  const wabaId = asGraphId(params.wabaId);
  if (!flowId || !wabaId) {
    return {
      ok: false,
      status: 400,
      error: "Invalid provider Flow reconciliation input",
      validation_errors: [],
      flow: null,
    };
  }

  const client = params.client ?? getWhatsAppGraphClient();
  try {
    const flows = await collectWabaFlowsForReconciliation({
      accessToken: params.accessToken,
      wabaId,
      client,
    });
    const matches = flows.filter(flow => asGraphId(flow.id) === flowId);
    if (matches.length > 1) {
      return {
        ok: false,
        status: 409,
        error: "Multiple provider Flows use the same id on this WABA",
        validation_errors: [],
        flow: null,
      };
    }
    return {
      ok: true,
      status: 200,
      flow: matches[0] ?? null,
    };
  } catch (error) {
    return reconciliationLookupFailure(error);
  }
}

export async function createMetaWhatsAppFlow(
  params: CreateMetaWhatsAppFlowParams
): Promise<WhatsAppFlowServiceResult> {
  const client = params.client ?? getWhatsAppGraphClient();
  const createPayload: Record<string, unknown> = {
    name: params.name,
    categories: normalizeWhatsAppFlowCategories(params.categories),
  };

  if (params.cloneFlowId) createPayload.clone_flow_id = params.cloneFlowId;
  if (params.endpointUri) createPayload.endpoint_uri = params.endpointUri;
  if (params.flowJson) createPayload.flow_json = params.flowJson;
  if (params.publish === true) createPayload.publish = true;

  try {
    const createResponse = await client.postJson<MetaWhatsAppFlow>(
      `${params.wabaId}/flows`,
      {
        token: params.accessToken,
        body: createPayload,
      }
    );
    const validationErrors = collectValidationErrors(createResponse);
    if (hasGraphError(createResponse) || validationErrors.length > 0) {
      return graphFailure({
        response: createResponse,
        responseStatus: hasGraphError(createResponse) ? 502 : 200,
        fallback: "Flow JSON validation failed",
        validationErrors,
      });
    }

    const flowId = asGraphId(createResponse.id);
    if (!flowId) {
      return graphFailure({
        response: createResponse,
        responseStatus: 502,
        fallback: "Flow create response did not include an id",
      });
    }

    const readback = await providerConfirmedReadback({
      accessToken: params.accessToken,
      flowId,
      client,
      expectedStatus: params.publish === true ? "PUBLISHED" : "DRAFT",
    });
    return readback.ok ? readback : { ...readback, providerFlowId: flowId };
  } catch (error) {
    return exceptionFailure(error, "Failed to create flow");
  }
}

export async function updateMetaWhatsAppFlow(
  params: UpdateMetaWhatsAppFlowParams
): Promise<WhatsAppFlowServiceResult> {
  const client = params.client ?? getWhatsAppGraphClient();
  let path: string;
  let body: Record<string, unknown> | FormData | undefined;
  let validationFallback = `Failed to ${params.operation} flow`;

  if (params.operation === "update_json") {
    if (!params.flowJson) {
      return {
        ok: false,
        status: 400,
        error: "flowJson is required for update_json operation",
        validation_errors: [],
      };
    }

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([params.flowJson], { type: "application/json" }),
      "flow.json"
    );
    formData.append("name", "flow.json");
    formData.append("asset_type", "FLOW_JSON");
    path = `${params.flowId}/assets`;
    body = formData;
    validationFallback = "Flow JSON validation failed";
  } else if (params.operation === "publish") {
    path = `${params.flowId}/publish`;
  } else if (params.operation === "deprecate") {
    path = `${params.flowId}/deprecate`;
  } else {
    path = params.flowId;
    const payload: Record<string, unknown> = {};
    if (params.name) payload.name = params.name;
    if (Array.isArray(params.categories) && params.categories.length > 0) {
      payload.categories = params.categories;
    }
    if (params.endpointUri) payload.endpoint_uri = params.endpointUri;
    if (params.applicationId) payload.application_id = params.applicationId;
    if (Object.keys(payload).length === 0) {
      return {
        ok: false,
        status: 400,
        error:
          "For update operation, provide at least one of: name, categories, endpointUri, applicationId",
        validation_errors: [],
      };
    }
    body = payload;
  }

  try {
    const updateResponse = await client.postJson<MetaWhatsAppFlow>(path, {
      token: params.accessToken,
      ...(body ? { body } : {}),
    });
    const validationErrors = collectValidationErrors(updateResponse);
    if (hasGraphError(updateResponse) || validationErrors.length > 0) {
      return graphFailure({
        response: updateResponse,
        responseStatus: hasGraphError(updateResponse) ? 502 : 200,
        fallback: validationFallback,
        validationErrors,
      });
    }

    const readback = await providerConfirmedReadback({
      accessToken: params.accessToken,
      flowId: params.flowId,
      client,
      ...(params.operation === "publish"
        ? { expectedStatus: "PUBLISHED" as const }
        : params.operation === "deprecate"
          ? { expectedStatus: "DEPRECATED" as const }
          : params.operation === "update_json"
            ? { expectedStatus: "DRAFT" as const }
            : {}),
    });
    if (
      params.operation === "update_json" &&
      readback.ok &&
      collectValidationErrors(readback.flow).length > 0
    ) {
      return graphFailure({
        response: readback.flow,
        responseStatus: 200,
        fallback: "Flow JSON validation failed",
      });
    }
    return readback;
  } catch (error) {
    return exceptionFailure(error, `Failed to ${params.operation} flow`);
  } finally {
    // Even a failed publish may have changed the Flow; template checks re-read.
    await invalidateTemplateFlowFacts(params.flowId);
  }
}

export async function deleteMetaWhatsAppFlow(
  params: WithClient & {
    accessToken: string;
    flowId: string;
  }
): Promise<WhatsAppFlowServiceResult> {
  const client = params.client ?? getWhatsAppGraphClient();
  try {
    const response = await client.request(params.flowId, {
      method: "DELETE",
      token: params.accessToken,
    });
    const payload = await parseGraphResponse<GraphResponse>(response);
    if (!response.ok || payload.error) {
      return graphFailure({
        response: payload,
        responseStatus: response.ok && payload.error ? 502 : response.status,
        fallback: "Failed to delete flow",
      });
    }

    return {
      ok: true,
      status: response.status || 200,
      flow: payload,
    };
  } catch (error) {
    return exceptionFailure(error, "Failed to delete flow");
  } finally {
    await invalidateTemplateFlowFacts(params.flowId);
  }
}

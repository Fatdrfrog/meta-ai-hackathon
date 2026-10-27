import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import type { SafeEndpointPhoneSecurityState } from "./endpoint-security-contract";
import type {
  AttachWhatsAppFlowProviderReferenceRequest,
  WhatsAppFlowProviderReferenceResult,
} from "./provider-reference-contract";
import {
  WHATSAPP_FLOW_PROVISIONING_FAILURE_CODES,
  WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES,
  WHATSAPP_FLOW_PROVISIONING_STAGES,
  WHATSAPP_FLOW_PROVISIONING_STATUSES,
  type WhatsAppFlowProvisioningFailureCode,
  type ProvisionWhatsAppFlowRequest,
  type WhatsAppFlowProvisioningResult,
} from "./provisioning-contract";
import {
  isTemplateFlowFacts,
  isTemplateFlowFactsDefinitive,
  isWhatsAppFlowGraphId,
  TEMPLATE_FLOW_CHECK_MAX_FLOWS,
  type TemplateFlowFacts,
} from "./template-flow-health";

type FetchWhatsAppFlowsListParams = {
  workspaceId: string;
  sourceId?: string;
  limit?: number;
  force?: boolean;
  signal?: AbortSignal;
};

type FetchWhatsAppFlowDetailsParams = {
  workspaceId: string;
  sourceId?: string;
  flowId: string;
  includeJson?: boolean;
  signal?: AbortSignal;
};

type WhatsAppFlowStatus =
  | "DRAFT"
  | "PUBLISHED"
  | "DEPRECATED"
  | "BLOCKED"
  | "THROTTLED"
  | string;

export type WhatsAppFlowReadiness = {
  hasWabaId: boolean;
  hasPhoneNumberId: boolean;
  hasAccessToken?: boolean;
};

type WhatsAppFlowPreview = {
  preview_url?: string;
  expires_at?: string;
};

export type WhatsAppFlowSummary = {
  id: string;
  name?: string;
  status?: WhatsAppFlowStatus;
  categories?: string[];
  validation_errors?: unknown[];
  json_version?: string;
  data_api_version?: string;
  endpoint_uri?: string;
  preview?: WhatsAppFlowPreview;
  preview_url?: string;
  whatsapp_business_account?: unknown;
  application?: unknown;
  health_status?: unknown;
  created_at?: string;
  updated_at?: string;
  updated_time?: string;
  providerUnavailable?: boolean;
  managedArtifact?: {
    operationId: string;
    scenarioId?: string;
    ledgerStatus:
      | "RUNNING"
      | "FAILED"
      | "COMPLETED"
      | "SUPERSEDED"
      | "MANUALLY_RESOLVED";
    stage: string;
    cleanupEligibility:
      | "ELIGIBLE"
      | "NOT_TERMINAL"
      | "REPLACEMENT_PENDING"
      | "BUSY"
      | "RESOLVED"
      | "STATUS_UNVERIFIED";
    suggestedResolutionKind?: "published_deprecated" | "draft_deleted";
    resolutionKind?: "published_deprecated" | "draft_deleted";
    resolutionOutcome?: "deprecated" | "missing";
  };
};

type WhatsAppFlowsListResponse = {
  flows?: WhatsAppFlowSummary[];
  paging?: unknown;
  sourceId?: string;
  readiness?: WhatsAppFlowReadiness;
  error?: string;
};

export type WhatsAppFlowDetailsResponse = {
  flow?: WhatsAppFlowSummary;
  flowJson?: unknown;
  flowJsonError?: string | null;
  sourceId?: string;
  readiness?: WhatsAppFlowReadiness;
  error?: string;
  validation_errors?: unknown[];
};

type WhatsAppFlowOperation = "publish" | "deprecate" | "update" | "update_json";

type WhatsAppFlowMutationResponse = {
  success?: boolean;
  operation?: WhatsAppFlowOperation;
  flow?: (Partial<WhatsAppFlowSummary> & Record<string, unknown>) | null;
  flowId?: string;
  messageId?: string;
  recipientPhone?: string;
  error?: string;
  validation_errors?: unknown[];
};

type WhatsAppFlowApiResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
};

type ProvisionWhatsAppFlowClientParams = ProvisionWhatsAppFlowRequest;

type CreateWhatsAppFlowParams = {
  workspaceId: string;
  sourceId: string;
  name: string;
  categories?: string[];
  cloneFlowId?: string;
};

type UpdateWhatsAppFlowParams = {
  workspaceId: string;
  sourceId: string;
  flowId: string;
} & (
  | {
      operation: "publish" | "update";
      name?: string;
      categories?: string[];
      acknowledgePreviouslySentMessagesWillStopOpening?: never;
    }
  | {
      operation: "deprecate";
      name?: string;
      categories?: string[];
      acknowledgePreviouslySentMessagesWillStopOpening: true;
    }
  | {
      operation: "update_json";
      flowJson: string;
      acknowledgePreviouslySentMessagesWillStopOpening?: never;
    }
);

type SendWhatsAppFlowTestParams = {
  workspaceId: string;
  sourceId: string;
  recipientPhone: string;
  flowId: string;
  mode?: "draft" | "published";
  flowToken: string;
  flowActionType?: "navigate" | "data_exchange";
  flowActionPayload?: Record<string, unknown>;
  headerText?: string;
  bodyText?: string;
  footerText?: string;
  flowCta?: string;
};

type CachedResult = WhatsAppFlowApiResult<WhatsAppFlowsListResponse>;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const FLOW_LIST_CACHE_TTL_MS = 30_000;
const flowListCache = new Map<
  string,
  { expiresAt: number; value: CachedResult }
>();
const flowListInFlight = new Map<string, Promise<CachedResult>>();
let flowListCacheGeneration = 0;
// The server caches Meta reads for 10 minutes; this only spares re-renders
// and remounts from repeating the request.
const TEMPLATE_FLOW_FACTS_CACHE_TTL_MS = 60_000;
const templateFlowFactsCache = new Map<
  string,
  { expiresAt: number; facts: TemplateFlowFacts }
>();
const templateFlowFactsInFlight = new Map<string, Promise<TemplateFlowFacts>>();
let templateFlowFactsCacheGeneration = 0;
const PROVISIONING_STAGE_SET = new Set<string>([
  "VALIDATING",
  ...WHATSAPP_FLOW_PROVISIONING_STAGES,
]);
const PROVISIONING_STATUS_SET = new Set<string>(
  WHATSAPP_FLOW_PROVISIONING_STATUSES
);
const PROVISIONING_FAILURE_CODE_SET = new Set<string>(
  WHATSAPP_FLOW_PROVISIONING_FAILURE_CODES
);
const WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUS_SET = new Set<string>(
  WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES
);
const PHONE_SECURITY_STAGE_SET = new Set<
  SafeEndpointPhoneSecurityState["stage"]
>(["DISCOVERED", "UPLOADING", "VERIFYING", "READY", "FAILED"]);
const PHONE_SIGNATURE_STATUS_SET = new Set<
  SafeEndpointPhoneSecurityState["signatureStatus"]
>(["UNKNOWN", "VALID", "INVALID"]);

function provisioningFallbackCode(
  status: number
): WhatsAppFlowProvisioningFailureCode {
  if (status === 400) return "WHATSAPP_FLOW_PROVISIONING_INVALID_INPUT";
  if (status === 401 || status === 403) {
    return "WHATSAPP_FLOW_PROVISIONING_ACCESS_DENIED";
  }
  if (status >= 500 || status === 0) {
    return "WHATSAPP_FLOW_PROVISIONING_FAILED";
  }
  return "WHATSAPP_FLOW_PROVISIONING_INVALID_RESPONSE";
}

function normalizeProvisioningPhones(
  value: unknown
): SafeEndpointPhoneSecurityState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const phone = asNullableRecord(item);
    if (
      !phone ||
      typeof phone.phoneNumberId !== "string" ||
      !phone.phoneNumberId.trim() ||
      typeof phone.stage !== "string" ||
      !PHONE_SECURITY_STAGE_SET.has(
        phone.stage as SafeEndpointPhoneSecurityState["stage"]
      ) ||
      typeof phone.signatureStatus !== "string" ||
      !PHONE_SIGNATURE_STATUS_SET.has(
        phone.signatureStatus as SafeEndpointPhoneSecurityState["signatureStatus"]
      ) ||
      typeof phone.updatedAt !== "string"
    ) {
      return [];
    }
    return [
      {
        phoneNumberId: phone.phoneNumberId,
        stage: phone.stage as SafeEndpointPhoneSecurityState["stage"],
        signatureStatus:
          phone.signatureStatus as SafeEndpointPhoneSecurityState["signatureStatus"],
        updatedAt: phone.updatedAt,
        ...(typeof phone.generationId === "string"
          ? { generationId: phone.generationId }
          : {}),
        ...(typeof phone.publicKeyFingerprint === "string"
          ? { publicKeyFingerprint: phone.publicKeyFingerprint }
          : {}),
        ...(typeof phone.verifiedAt === "string"
          ? { verifiedAt: phone.verifiedAt }
          : {}),
      },
    ];
  });
}

function normalizeWhatsAppFlowProvisioningResult(
  value: unknown,
  params: { httpOk: boolean; status: number; networkMessage?: string }
): WhatsAppFlowProvisioningResult {
  const record = asNullableRecord(value);
  const projection = asNullableRecord(record?.projection);
  const scenarioRevision = asNullableRecord(record?.scenarioRevision);
  const phones = normalizeProvisioningPhones(record?.phones);
  if (
    params.httpOk &&
    record?.ok === true &&
    typeof record.operationId === "string" &&
    record.status === "COMPLETED" &&
    record.stage === "COMPLETED" &&
    projection?.providerStatus === "PUBLISHED" &&
    projection.operationId === record.operationId &&
    typeof projection.sourceId === "string" &&
    typeof projection.wabaId === "string" &&
    Number.isSafeInteger(projection.contentRevision) &&
    typeof projection.contentDigest === "string" &&
    typeof projection.flowId === "string" &&
    typeof scenarioRevision?.finalUpdatedAt === "string" &&
    Array.isArray(record.phones) &&
    phones.length === record.phones.length &&
    Array.isArray(record.validationErrors) &&
    record.validationErrors.length === 0
  ) {
    return {
      ok: true,
      operationId: record.operationId,
      status: "COMPLETED",
      stage: "COMPLETED",
      projection: projection as unknown as Extract<
        WhatsAppFlowProvisioningResult,
        { ok: true }
      >["projection"],
      scenarioRevision: {
        finalUpdatedAt: scenarioRevision.finalUpdatedAt,
      },
      phones,
      validationErrors: [],
    };
  }

  const error = asNullableRecord(record?.error);
  const rawCode = typeof error?.code === "string" ? error.code : "";
  const code = PROVISIONING_FAILURE_CODE_SET.has(rawCode)
    ? (rawCode as WhatsAppFlowProvisioningFailureCode)
    : provisioningFallbackCode(params.status);
  const message =
    params.networkMessage?.trim() ||
    (typeof error?.message === "string" && error.message.trim()) ||
    (typeof record?.error === "string" && record.error.trim()) ||
    "WhatsApp Flow provisioning failed";
  const stage =
    typeof record?.stage === "string" &&
    PROVISIONING_STAGE_SET.has(record.stage)
      ? (record.stage as WhatsAppFlowProvisioningResult["stage"])
      : "VALIDATING";
  const status =
    typeof record?.status === "string" &&
    PROVISIONING_STATUS_SET.has(record.status)
      ? (record.status as NonNullable<WhatsAppFlowProvisioningResult["status"]>)
      : undefined;
  const validationErrors = Array.isArray(record?.validationErrors)
    ? record.validationErrors.flatMap(item => {
        const entry = asNullableRecord(item);
        return typeof entry?.message === "string" && entry.message.trim()
          ? [
              {
                message: entry.message.trim(),
                ...(typeof entry.path === "string" && entry.path.trim()
                  ? { path: entry.path.trim() }
                  : {}),
              },
            ]
          : [];
      })
    : [];
  const persistedProjection =
    projection &&
    typeof projection.operationId === "string" &&
    typeof projection.sourceId === "string" &&
    typeof projection.wabaId === "string" &&
    typeof projection.contentRevision === "number" &&
    typeof projection.contentDigest === "string" &&
    typeof projection.providerStatus === "string" &&
    WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUS_SET.has(
      projection.providerStatus
    ) &&
    typeof scenarioRevision?.finalUpdatedAt === "string"
      ? {
          projection: projection as unknown as NonNullable<
            Extract<WhatsAppFlowProvisioningResult, { ok: false }>["projection"]
          >,
          scenarioRevision: {
            finalUpdatedAt: scenarioRevision.finalUpdatedAt,
          },
        }
      : null;

  const failure = {
    ok: false,
    ...(typeof record?.operationId === "string"
      ? { operationId: record.operationId }
      : {}),
    ...(status ? { status } : {}),
    stage,
    phones,
    validationErrors,
    error: {
      code,
      message,
      retryable:
        typeof error?.retryable === "boolean"
          ? error.retryable
          : params.status === 0 || params.status >= 500,
      ...(Number.isSafeInteger(error?.providerCode)
        ? { providerCode: Number(error?.providerCode) }
        : {}),
      ...(Number.isSafeInteger(error?.providerSubcode)
        ? { providerSubcode: Number(error?.providerSubcode) }
        : {}),
    },
  } as const;
  return persistedProjection ? { ...failure, ...persistedProjection } : failure;
}

function makeCacheKey(
  workspaceId: string,
  sourceId: string | undefined,
  limit: number
): string {
  return `${workspaceId}::${sourceId ?? ""}::${limit}`;
}

function buildFlowsUrl(params: {
  workspaceId: string;
  sourceId?: string;
  limit?: number;
  flowId?: string;
  includeJson?: boolean;
}): string {
  const query = new URLSearchParams({
    workspaceId: params.workspaceId,
  });

  if (typeof params.limit === "number") {
    query.set("limit", String(params.limit));
  }
  if (params.sourceId) {
    query.set("sourceId", params.sourceId);
  }
  if (params.flowId) {
    query.set("flowId", params.flowId);
  }
  if (typeof params.includeJson === "boolean") {
    query.set("includeJson", String(params.includeJson));
  }

  return `/api/whatsapp/flows?${query.toString()}`;
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<WhatsAppFlowApiResult<T>> {
  const response = await fetch(input, init);
  const data = (await response.json().catch(() => null)) as T | null;

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

function invalidateTemplateFlowFactsCache(workspaceId?: string): void {
  templateFlowFactsCacheGeneration += 1;
  const prefix = workspaceId ? `${workspaceId}::` : "";
  for (const key of Array.from(templateFlowFactsCache.keys())) {
    if (key.startsWith(prefix)) templateFlowFactsCache.delete(key);
  }
  for (const key of Array.from(templateFlowFactsInFlight.keys())) {
    if (key.startsWith(prefix)) templateFlowFactsInFlight.delete(key);
  }
}

function invalidateWhatsAppFlowsListCache(
  workspaceId?: string,
  sourceId?: string
): void {
  flowListCacheGeneration += 1;
  // A changed Flow can change whether template buttons open it.
  invalidateTemplateFlowFactsCache(workspaceId);

  if (!workspaceId) {
    flowListCache.clear();
    flowListInFlight.clear();
    return;
  }

  const prefix = sourceId
    ? `${workspaceId}::${sourceId}::`
    : `${workspaceId}::`;
  for (const key of Array.from(flowListCache.keys())) {
    if (key.startsWith(prefix)) flowListCache.delete(key);
  }
  for (const key of Array.from(flowListInFlight.keys())) {
    if (key.startsWith(prefix)) flowListInFlight.delete(key);
  }
}

export function getWhatsAppFlowPreviewUrl(
  flow: Pick<WhatsAppFlowSummary, "preview" | "preview_url"> | null | undefined
): string | null {
  if (!flow) return null;

  if (typeof flow.preview_url === "string" && flow.preview_url.length > 0) {
    return flow.preview_url;
  }

  if (flow.preview && typeof flow.preview.preview_url === "string") {
    return flow.preview.preview_url;
  }

  return null;
}

export function getWhatsAppFlowStatusVariant(
  status: WhatsAppFlowStatus
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "PUBLISHED") return "default";
  if (status === "DRAFT") return "secondary";
  if (status === "BLOCKED") return "destructive";
  return "outline";
}

export function generateWhatsAppFlowToken(flowId?: string): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  return `${flowId || "flow"}_${randomPart}`;
}

export function parseWhatsAppFlowActionPayload(
  rawPayload: string
): Record<string, unknown> | null {
  const raw = rawPayload.trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

export async function fetchWhatsAppFlowsList({
  workspaceId,
  sourceId,
  limit = 200,
  force = false,
  signal,
}: FetchWhatsAppFlowsListParams): Promise<CachedResult> {
  const key = makeCacheKey(workspaceId, sourceId, limit);
  const now = Date.now();

  if (!force) {
    const cached = flowListCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const inFlight = flowListInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const requestPromise: Promise<CachedResult> = (async () => {
    const cacheGeneration = flowListCacheGeneration;
    const result = await requestJson<WhatsAppFlowsListResponse>(
      buildFlowsUrl({ workspaceId, sourceId, limit }),
      {
        signal,
        cache: "no-store",
      }
    );

    if (result.ok && cacheGeneration === flowListCacheGeneration) {
      flowListCache.set(key, {
        value: result,
        expiresAt: Date.now() + FLOW_LIST_CACHE_TTL_MS,
      });
    }

    return result;
  })().finally(() => {
    flowListInFlight.delete(key);
  });

  flowListInFlight.set(key, requestPromise);
  return requestPromise;
}

export async function fetchWhatsAppFlowDetails({
  workspaceId,
  sourceId,
  flowId,
  includeJson = false,
  signal,
}: FetchWhatsAppFlowDetailsParams): Promise<
  WhatsAppFlowApiResult<WhatsAppFlowDetailsResponse>
> {
  return requestJson<WhatsAppFlowDetailsResponse>(
    buildFlowsUrl({ workspaceId, sourceId, flowId, includeJson }),
    {
      signal,
      cache: "no-store",
    }
  );
}

function templateFlowFactsKey(
  workspaceId: string,
  sourceId: string | undefined,
  flowId: string
): string {
  return `${workspaceId}::${sourceId ?? ""}::${flowId}`;
}

async function requestTemplateFlowFacts(params: {
  workspaceId: string;
  sourceId?: string;
  flowIds: string[];
  refresh: boolean;
}): Promise<Map<string, TemplateFlowFacts>> {
  const query = new URLSearchParams({
    workspaceId: params.workspaceId,
    flowIds: params.flowIds.join(","),
  });
  if (params.sourceId) query.set("sourceId", params.sourceId);
  if (params.refresh) query.set("refresh", "1");
  try {
    const result = await requestJson<{ facts?: unknown }>(
      `/api/whatsapp/flows/template-health?${query.toString()}`,
      { cache: "no-store" }
    );
    const facts =
      result.ok && Array.isArray(result.data?.facts)
        ? result.data.facts.filter(isTemplateFlowFacts)
        : [];
    return new Map(facts.map(entry => [entry.flowId, entry]));
  } catch {
    return new Map();
  }
}

/**
 * Status and screens of the Flows that template buttons open. Flows the
 * server couldn't answer for come back "unavailable" and are asked again on
 * the next call; `force` re-reads Meta instead of the server cache.
 */
export async function fetchTemplateFlowFacts(params: {
  workspaceId: string;
  sourceId?: string;
  flowIds: readonly string[];
  force?: boolean;
}): Promise<Record<string, TemplateFlowFacts>> {
  const flowIds = Array.from(
    new Set(params.flowIds.filter(isWhatsAppFlowGraphId))
  );
  const factsByFlowId: Record<string, TemplateFlowFacts> = {};
  const pending: Array<Promise<void>> = [];
  const toRequest: string[] = [];
  const now = Date.now();

  for (const flowId of flowIds) {
    const key = templateFlowFactsKey(
      params.workspaceId,
      params.sourceId,
      flowId
    );
    if (!params.force) {
      const cached = templateFlowFactsCache.get(key);
      if (cached && cached.expiresAt > now) {
        factsByFlowId[flowId] = cached.facts;
        continue;
      }
      const inFlight = templateFlowFactsInFlight.get(key);
      if (inFlight) {
        pending.push(
          inFlight.then(facts => {
            factsByFlowId[flowId] = facts;
          })
        );
        continue;
      }
    }
    toRequest.push(flowId);
  }

  for (
    let start = 0;
    start < toRequest.length;
    start += TEMPLATE_FLOW_CHECK_MAX_FLOWS
  ) {
    const chunk = toRequest.slice(start, start + TEMPLATE_FLOW_CHECK_MAX_FLOWS);
    const generation = templateFlowFactsCacheGeneration;
    const request = requestTemplateFlowFacts({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
      flowIds: chunk,
      refresh: Boolean(params.force),
    });
    for (const flowId of chunk) {
      const key = templateFlowFactsKey(
        params.workspaceId,
        params.sourceId,
        flowId
      );
      const perFlow = request.then(
        (answers): TemplateFlowFacts =>
          answers.get(flowId) ?? {
            flowId,
            state: "unavailable",
            checkedAt: new Date().toISOString(),
          }
      );
      templateFlowFactsInFlight.set(key, perFlow);
      pending.push(
        perFlow
          .then(facts => {
            factsByFlowId[flowId] = facts;
            if (
              isTemplateFlowFactsDefinitive(facts) &&
              generation === templateFlowFactsCacheGeneration
            ) {
              templateFlowFactsCache.set(key, {
                facts,
                expiresAt: Date.now() + TEMPLATE_FLOW_FACTS_CACHE_TTL_MS,
              });
            }
          })
          .finally(() => {
            if (templateFlowFactsInFlight.get(key) === perFlow) {
              templateFlowFactsInFlight.delete(key);
            }
          })
      );
    }
  }

  await Promise.all(pending);
  return factsByFlowId;
}

export async function provisionWhatsAppFlow(
  params: ProvisionWhatsAppFlowClientParams
): Promise<WhatsAppFlowApiResult<WhatsAppFlowProvisioningResult>> {
  let rawResult: WhatsAppFlowApiResult<unknown>;
  try {
    rawResult = await requestJson<unknown>("/api/whatsapp/flows/provision", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(params),
    });
  } catch (error) {
    rawResult = {
      ok: false,
      status: 0,
      data: {
        error:
          error instanceof Error
            ? error.message
            : "WhatsApp Flow provisioning request failed",
      },
    };
  }
  const data = normalizeWhatsAppFlowProvisioningResult(rawResult.data, {
    httpOk: rawResult.ok,
    status: rawResult.status,
    ...(rawResult.status === 0 && asNullableRecord(rawResult.data)?.error
      ? { networkMessage: String(asNullableRecord(rawResult.data)?.error) }
      : {}),
  });
  const result = { ...rawResult, data };
  if (data.operationId) {
    invalidateWhatsAppFlowsListCache(params.workspaceId, params.sourceId);
  }
  return result;
}

export async function attachWhatsAppFlowProviderReference(
  params: AttachWhatsAppFlowProviderReferenceRequest
): Promise<WhatsAppFlowApiResult<WhatsAppFlowProviderReferenceResult>> {
  return requestJson<WhatsAppFlowProviderReferenceResult>(
    "/api/whatsapp/flows/reference",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(params),
    }
  );
}

export async function createWhatsAppFlow(
  params: CreateWhatsAppFlowParams
): Promise<WhatsAppFlowApiResult<WhatsAppFlowMutationResponse>> {
  const result = await requestJson<WhatsAppFlowMutationResponse>(
    "/api/whatsapp/flows",
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(params),
    }
  );

  if (result.ok) {
    invalidateWhatsAppFlowsListCache(params.workspaceId, params.sourceId);
  }
  return result;
}

export async function updateWhatsAppFlow(
  params: UpdateWhatsAppFlowParams
): Promise<WhatsAppFlowApiResult<WhatsAppFlowMutationResponse>> {
  const result = await requestJson<WhatsAppFlowMutationResponse>(
    "/api/whatsapp/flows",
    {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(params),
    }
  );

  if (result.ok || params.operation === "update_json") {
    invalidateWhatsAppFlowsListCache(params.workspaceId, params.sourceId);
  }
  return result;
}

export async function deleteWhatsAppFlow(params: {
  workspaceId: string;
  sourceId: string;
  flowId: string;
  acknowledgeDraftDeletion: true;
}): Promise<WhatsAppFlowApiResult<WhatsAppFlowMutationResponse>> {
  const result = await requestJson<WhatsAppFlowMutationResponse>(
    "/api/whatsapp/flows",
    {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify(params),
    }
  );

  if (result.ok) {
    invalidateWhatsAppFlowsListCache(params.workspaceId, params.sourceId);
  }
  return result;
}

export async function sendWhatsAppFlowTest(
  params: SendWhatsAppFlowTestParams
): Promise<WhatsAppFlowApiResult<WhatsAppFlowMutationResponse>> {
  return requestJson<WhatsAppFlowMutationResponse>("/api/whatsapp/flows", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(params),
  });
}

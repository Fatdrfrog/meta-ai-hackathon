/**
 * WhatsApp Template Service
 * Singleton service for managing WhatsApp Business API templates
 */

import { connectDB } from "@/lib/mongoose";
import { createServerLogger } from "@/lib/observability/server-logs";
import { CrawlSsrfError, safeCrawlFetch } from "@/lib/crawler/url-safety";
import {
  JsonBodyTooLargeError,
  readBodyBytesWithinLimit,
} from "@/lib/api/json-body";
import pLimit from "p-limit";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { createClient } from "@/lib/supabase/server";
import {
  getCachedWhatsAppMetaReadCooldownUntil,
  selectLaterActiveWhatsAppMetaReadCooldownUntil,
} from "@/lib/whatsapp/meta-read-policy";
import {
  MetaGraphRequestError,
  getMetaGraphRateLimitMetadata,
} from "@icecore/shared/lib/meta/api";
import {
  beginWhatsAppTemplateCatalogMutation,
  finishWhatsAppTemplateCatalogMutation,
  patchWhatsAppTemplateCatalog,
  readWhatsAppTemplateCatalogGeneration,
  protectWhatsAppTemplateRateLimit,
  readWhatsAppTemplateAccountDiscovery,
  readWhatsAppTemplateCatalog,
} from "./catalog-cache";
import {
  WhatsAppTemplateCatalogError,
  type WhatsAppTemplateCatalogResult,
} from "./catalog-contracts";
import type { WhatsAppTemplateCatalogPatch } from "./catalog-cache";
import {
  getWhatsAppAccountCandidates,
  getWhatsAppAccountCredentials,
  isWhatsAppAccountAccessError,
  resolveWhatsAppAccountContext,
  type WhatsAppAccountCandidate,
  type WhatsAppAccountContext,
  type WhatsAppSourceReader,
} from "@/lib/whatsapp/account/resolution";
import {
  WHATSAPP_TEMPLATE_HEADER_DEFAULT_FILE_EXTENSIONS,
  WHATSAPP_TEMPLATE_HEADER_FORMAT_MEDIA_TYPES,
  getWhatsAppOfficialMediaMaxBytes,
  getWhatsAppOfficialMediaType,
  resolveWhatsAppUploadMimeType,
  type WhatsAppTemplateHeaderMediaFormat,
} from "@/lib/whatsapp/media-types";
import {
  getWhatsAppTemplateComponentsErrorMessage,
  parseWhatsAppTemplateSubmissionComponents,
} from "@/lib/whatsapp/templates/component-schemas";
import {
  formatGraphApiError,
  parseGraphResponse,
} from "@/lib/whatsapp/templates/graph-response";
import { getWhatsAppTemplateHeaderMediaValidationIssue } from "@/lib/whatsapp/templates/header-media-constraints";
import { getWhatsAppTemplateParameterFormat } from "@/lib/whatsapp/templates/parameter-format";
import {
  fetchWhatsAppTemplateById,
  mirrorWhatsAppTemplatesToUnifiedRows,
  readWhatsAppTemplateSnapshotId,
  upsertTemplateSnapshot,
  WHATSAPP_TEMPLATE_GRAPH_FIELDS,
} from "@/lib/whatsapp/templates/template-mirror";
import {
  WhatsAppTemplateAuditLog,
  WhatsAppTemplateModel,
} from "@/models/whatsapp-template";
import { normalizeWhatsAppTemplateLanguageCode } from "@icecore/shared/constants/whatsapp-templates";
import { buildGraphApiUrl } from "@icecore/shared/lib/meta/graph-version";
import type {
  CreateWhatsAppTemplatePayload,
  GraphApiErrorBody,
  UpdateWhatsAppTemplatePayload,
  WhatsAppComponent,
  WhatsAppTemplate,
  WhatsAppTemplateStatus,
} from "@icecore/shared/types/whatsapp";

const templateServiceLogger = createServerLogger("whatsapp.template-service");
const OPTIMIZATION_SPEC_ALLOWLIST_PATTERN =
  /optimization_spec[\s\S]*(allow\s*list|allowlist)|(allow\s*list|allowlist)[\s\S]*optimization_spec/i;
const OPTIMIZATION_SPEC_DROPPED_WARNING =
  "Template was saved without Marketing Messages max price because Meta has not enabled optimization_spec for this WhatsApp Business Account.";

async function persistTemplateReadPolicy(input: {
  workspaceId: string;
  sourceId: string;
  expectedWabaId: string;
  buildCredentials: (
    current: Readonly<Record<string, unknown>>
  ) => Record<string, unknown>;
}) {
  try {
    const updated = await updateCurrentWhatsAppSourceCredentials(input);
    return updated.credentials;
  } catch (error) {
    templateServiceLogger.error(
      "Failed persisting template Meta read policy",
      error,
      { workspaceId: input.workspaceId, sourceId: input.sourceId }
    );
  }
}

function catalogAccountIdentity(
  account:
    | WhatsAppAccountContext
    | Awaited<ReturnType<typeof getWhatsAppAccountCredentials>>
) {
  return {
    sourceId: account.sourceId,
    wabaId:
      "wabaId" in account
        ? account.wabaId
        : (account.primaryCandidates[0]?.id ??
          account.fallbackCandidates[0]?.id),
  };
}

/** Server-only context for a caller that has verified workspace/source ownership. */
export type WhatsAppTemplateAccountOptions = {
  accountContext?: WhatsAppAccountContext & {
    workspaceId: string;
    sourceId: string;
  };
};

interface DeleteTemplateOptions {
  templateName: string;
  templateId?: string;
  language?: string;
}

type GraphTemplateMutationResponse = {
  id?: string;
  status?: WhatsAppTemplateStatus;
  success?: boolean;
  error?: GraphApiErrorBody;
};

type GraphUploadSessionResponse = {
  id?: string;
  error?: GraphApiErrorBody;
};

type GraphUploadHandleResponse = {
  h?: string;
  error?: GraphApiErrorBody;
};

type GraphListResponse<T> = {
  data?: T[];
  paging?: { next?: string };
  error?: GraphApiErrorBody;
};

function isOptimizationSpecAllowlistError(
  error: GraphApiErrorBody | undefined
): boolean {
  return OPTIMIZATION_SPEC_ALLOWLIST_PATTERN.test(
    formatGraphApiError(error, "")
  );
}

function validateTemplateComponents(
  components:
    | CreateWhatsAppTemplatePayload["components"]
    | UpdateWhatsAppTemplatePayload["components"],
  category?: CreateWhatsAppTemplatePayload["category"]
) {
  const parsed = parseWhatsAppTemplateSubmissionComponents(
    components,
    category
  );
  if (!parsed.success) {
    throw new Error(getWhatsAppTemplateComponentsErrorMessage(parsed.error));
  }
  return parsed.data;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getFileNameFromUrl(
  value: string,
  format: WhatsAppTemplateHeaderMediaFormat
): string {
  try {
    const url = new URL(value);
    const lastSegment = decodeURIComponent(
      url.pathname.split("/").filter(Boolean).at(-1) || ""
    );
    if (lastSegment) return lastSegment;
  } catch {
    // URL validity is checked before this helper is called.
  }
  return `template-header.${WHATSAPP_TEMPLATE_HEADER_DEFAULT_FILE_EXTENSIONS[format]}`;
}

function formatBytesAsMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb}MB` : `${mb.toFixed(1)}MB`;
}

function getHeaderMediaValidationErrorMessage(
  issue: ReturnType<typeof getWhatsAppTemplateHeaderMediaValidationIssue>
): string {
  if (issue === "templateVideoTooLarge") {
    return "Template videos must be 16MB or smaller.";
  }
  if (issue === "templateVideoUnsupported") {
    return "Template videos must be MP4 or 3GP. MOV is not supported for WhatsApp templates.";
  }
  return "Template header media is not valid for WhatsApp.";
}

const TEMPLATE_HEADER_MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;
const TEMPLATE_HEADER_MEDIA_USER_AGENT =
  "Airi.chat WhatsApp Template Media/1.0 (https://airi.chat; support@airi.chat)";
const TEMPLATE_HEADER_MEDIA_URL_NOT_ALLOWED =
  "Header media URL is not allowed. Use a public http(s) URL or upload the file.";
const TEMPLATE_HEADER_MEDIA_URL_ERRORS: Record<
  CrawlSsrfError["reason"],
  string
> = {
  protocol: TEMPLATE_HEADER_MEDIA_URL_NOT_ALLOWED,
  disallowed_host: TEMPLATE_HEADER_MEDIA_URL_NOT_ALLOWED,
  private_ip: TEMPLATE_HEADER_MEDIA_URL_NOT_ALLOWED,
  dns_failed: "Header media URL host could not be resolved.",
  too_many_redirects: "Header media URL redirected too many times.",
};

// Shown in the template editor; the original error (kept only as the cause)
// can name an internal IP the URL resolved to.
function getTemplateHeaderMediaDownloadError(
  error: unknown,
  deadline: AbortSignal
): Error {
  let message = "Failed to download WhatsApp template header media.";
  if (error instanceof CrawlSsrfError) {
    message = TEMPLATE_HEADER_MEDIA_URL_ERRORS[error.reason];
  } else if (
    deadline.aborted ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    message = "Timed out downloading header media from the URL.";
  }
  return new Error(message, { cause: error });
}

async function downloadTemplateHeaderMedia(params: {
  format: WhatsAppTemplateHeaderMediaFormat;
  value: string;
}): Promise<{
  bytes: Buffer;
  fileName: string;
  mimeType: string;
}> {
  const expectedMediaType =
    WHATSAPP_TEMPLATE_HEADER_FORMAT_MEDIA_TYPES[params.format];
  const maxBytes = getWhatsAppOfficialMediaMaxBytes(expectedMediaType);
  // One deadline for the whole download: safeCrawlFetch's own timeout ends
  // when headers arrive, so this signal is what bounds the body read.
  const deadline = new AbortController();
  const timeoutId = setTimeout(
    () => deadline.abort(),
    TEMPLATE_HEADER_MEDIA_DOWNLOAD_TIMEOUT_MS
  );

  try {
    let res: Response;
    try {
      res = await safeCrawlFetch(params.value, {
        timeoutMs: TEMPLATE_HEADER_MEDIA_DOWNLOAD_TIMEOUT_MS,
        userAgent: TEMPLATE_HEADER_MEDIA_USER_AGENT,
        signal: deadline.signal,
      });
    } catch (error) {
      throw getTemplateHeaderMediaDownloadError(error, deadline.signal);
    }
    if (!res.ok) {
      throw new Error(
        `Failed to download WhatsApp template header media: ${res.status}`
      );
    }

    const fileName = getFileNameFromUrl(params.value, params.format);
    const mime = resolveWhatsAppUploadMimeType({
      fileName,
      mimeType: res.headers.get("content-type"),
    });
    const actualMediaType = getWhatsAppOfficialMediaType(mime.mimeType);

    if (actualMediaType !== expectedMediaType) {
      throw new Error(
        `${params.format} template headers require ${expectedMediaType} media. Got ${mime.mimeType}.`
      );
    }

    let bytes: Buffer;
    try {
      const body = await readBodyBytesWithinLimit(res, maxBytes, {
        signal: deadline.signal,
      });
      bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    } catch (error) {
      if (error instanceof JsonBodyTooLargeError) {
        throw new Error(
          `${params.format} template header media must be ${formatBytesAsMb(maxBytes)} or smaller.`
        );
      }
      throw getTemplateHeaderMediaDownloadError(error, deadline.signal);
    }

    const validationIssue = getWhatsAppTemplateHeaderMediaValidationIssue({
      format: params.format,
      fileName,
      mimeType: mime.mimeType,
      size: bytes.byteLength,
    });
    if (validationIssue) {
      throw new Error(getHeaderMediaValidationErrorMessage(validationIssue));
    }

    return {
      bytes,
      fileName,
      mimeType: mime.mimeType,
    };
  } finally {
    clearTimeout(timeoutId);
    // A no-op after a complete read; on an early exit it releases the
    // connection of a body that was never read.
    deadline.abort();
  }
}

async function createMetaUploadSession(params: {
  accessToken: string;
  appId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}): Promise<string> {
  const query = new URLSearchParams({
    file_name: params.fileName,
    file_length: String(params.fileSize),
    file_type: params.mimeType,
  });
  const res = await fetch(
    buildGraphApiUrl(`${params.appId}/uploads?${query.toString()}`),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
      },
    }
  );
  const response = await parseGraphResponse<GraphUploadSessionResponse>(res);

  if (!res.ok || response?.error || !response.id) {
    throw new Error(
      formatGraphApiError(
        response?.error,
        `Failed to create Meta media upload session: ${res.status}`
      )
    );
  }

  return response.id;
}

async function uploadMetaHeaderMediaHandle(params: {
  accessToken: string;
  uploadSessionId: string;
  bytes: Buffer;
}): Promise<string> {
  const body = new Blob([new Uint8Array(params.bytes)], {
    type: "application/octet-stream",
  });
  const res = await fetch(buildGraphApiUrl(params.uploadSessionId), {
    method: "POST",
    headers: {
      Authorization: `OAuth ${params.accessToken}`,
      file_offset: "0",
    },
    body,
  });
  const response = await parseGraphResponse<GraphUploadHandleResponse>(res);

  if (!res.ok || response?.error || !response.h) {
    throw new Error(
      formatGraphApiError(
        response?.error,
        `Failed to upload WhatsApp template header media to Meta: ${res.status}`
      )
    );
  }

  return response.h;
}

async function resolveTemplateHeaderMediaHandle(params: {
  accessToken: string;
  format: WhatsAppTemplateHeaderMediaFormat;
  value: string;
}): Promise<string> {
  if (!isHttpUrl(params.value)) {
    return params.value;
  }

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;

  if (!appId) {
    throw new Error(
      "Meta App ID is required to upload WhatsApp template header media. Set NEXT_PUBLIC_META_APP_ID or META_APP_ID."
    );
  }

  const media = await downloadTemplateHeaderMedia({
    format: params.format,
    value: params.value,
  });
  const uploadSessionId = await createMetaUploadSession({
    accessToken: params.accessToken,
    appId,
    fileName: media.fileName,
    fileSize: media.bytes.byteLength,
    mimeType: media.mimeType,
  });
  return uploadMetaHeaderMediaHandle({
    accessToken: params.accessToken,
    uploadSessionId,
    bytes: media.bytes,
  });
}

async function prepareHeaderLikeComponent<
  T extends {
    type: string;
    format?: string;
    example?: { header_handle?: string[] };
  },
>(component: T, accessToken: string): Promise<T> {
  if (
    component.type !== "HEADER" ||
    component.format === "TEXT" ||
    !component.example?.header_handle?.length
  ) {
    return component;
  }

  const format = component.format;
  if (format !== "IMAGE" && format !== "VIDEO" && format !== "DOCUMENT") {
    return component;
  }

  const currentHandle = component.example.header_handle[0]?.trim();
  if (!currentHandle) return component;

  const headerHandle = await resolveTemplateHeaderMediaHandle({
    accessToken,
    format,
    value: currentHandle,
  });

  if (headerHandle === currentHandle) {
    return component;
  }

  return {
    ...component,
    example: {
      ...component.example,
      header_handle: [headerHandle],
    },
  };
}

const TEMPLATE_CAROUSEL_HEADER_UPLOAD_CONCURRENCY = 4;

async function prepareTemplateComponentsForMetaSubmission(
  components: WhatsAppComponent[],
  accessToken: string
): Promise<WhatsAppComponent[]> {
  const prepared: WhatsAppComponent[] = [];
  const headerUploadLimit = pLimit(TEMPLATE_CAROUSEL_HEADER_UPLOAD_CONCURRENCY);
  for (const component of components) {
    if (component.type === "CAROUSEL") {
      const cards = await Promise.all(
        component.cards.map(async card => ({
          ...card,
          components: await Promise.all(
            card.components.map(cardComponent =>
              cardComponent.type === "HEADER"
                ? headerUploadLimit(() =>
                    prepareHeaderLikeComponent(cardComponent, accessToken)
                  )
                : Promise.resolve(cardComponent)
            )
          ),
        }))
      );
      prepared.push({
        ...component,
        cards,
      });
      continue;
    }

    prepared.push(await prepareHeaderLikeComponent(component, accessToken));
  }
  return prepared;
}

function omitOptimizationSpec(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const retryPayload = { ...payload };
  delete retryPayload.optimization_spec;
  return retryPayload;
}

async function postTemplateMutation(
  url: string,
  accessToken: string,
  graphPayload: Record<string, unknown>
): Promise<{ res: Response; response: GraphTemplateMutationResponse }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(graphPayload),
    signal: AbortSignal.timeout(10_000),
  });

  return {
    res,
    response: await parseGraphResponse<GraphTemplateMutationResponse>(res),
  };
}

export async function resolveTemplateAccountContext(
  workspaceId: string,
  options: WhatsAppTemplateAccountOptions = {}
): Promise<NonNullable<WhatsAppTemplateAccountOptions["accountContext"]>> {
  const context = options.accountContext;
  if (context !== undefined) {
    if (
      !context ||
      context.workspaceId !== workspaceId ||
      [context.sourceId, context.wabaId, context.accessToken].some(
        value => typeof value !== "string" || !value.trim()
      )
    ) {
      throw new Error("Invalid WhatsApp template account context");
    }
    return context;
  }
  const resolved = await resolveWhatsAppAccountContext({
    workspaceId,
    probeEdge: "message_templates",
    logScope: "templates",
    failureMessage:
      "Cannot access WhatsApp message templates for this connection. Reconnect WhatsApp or grant whatsapp_business_management access to the selected WhatsApp Business Account in Meta Business Manager.",
  });
  if (!resolved.sourceId?.trim())
    throw new Error("WhatsApp source ID not found");
  return { ...resolved, workspaceId, sourceId: resolved.sourceId };
}

/**
 * List templates from Graph API
 */
export async function listTemplates(
  workspaceId: string,
  options?: {
    status?: WhatsAppTemplateStatus;
    limit?: number;
    sourceId?: string;
    force?: boolean;
    /** Server-only source reader for callers without a user session. */
    supabase?: WhatsAppSourceReader;
  }
): Promise<WhatsAppTemplateCatalogResult> {
  // This lookup remains per-call: a cache hit never bypasses source access.
  const credentials = await getWhatsAppAccountCredentials(workspaceId, {
    sourceId: options?.sourceId,
    supabase: options?.supabase,
  });
  if (!credentials.sourceId) throw new Error("WhatsApp source ID not found");
  const sourceId = credentials.sourceId;
  const rawCredentials = credentials.rawCredentials;
  const persistCredentials = async (
    buildCredentials: (
      current: Readonly<Record<string, unknown>>
    ) => Record<string, unknown>
  ) => {
    return persistTemplateReadPolicy({
      workspaceId,
      sourceId,
      expectedWabaId: normalizeWhatsAppCredentials(rawCredentials).wabaId ?? "",
      buildCredentials,
    });
  };
  const persistRateLimit = (wabaId?: string) => async (error: unknown) => {
    return protectWhatsAppTemplateRateLimit({
      wabaId,
      credentials: rawCredentials,
      error,
      persistPatch: persistCredentials,
    });
  };
  const recoverable = (error: unknown) =>
    !!getMetaGraphRateLimitMetadata(error) ||
    error instanceof WhatsAppTemplateCatalogError ||
    !(error instanceof MetaGraphRequestError) ||
    error.status >= 500;
  const discovery = () =>
    readWhatsAppTemplateAccountDiscovery<WhatsAppAccountCandidate>({
      workspaceId,
      sourceId,
      credentials: rawCredentials,
      bindingKey: JSON.stringify([
        credentials.businessId,
        ...credentials.primaryCandidates.map(candidate => candidate.id),
        ...credentials.fallbackCandidates.map(candidate => candidate.id),
      ]),
      force: options?.force,
      persistRateLimit: persistRateLimit(),
      recoverable,
      load: () =>
        getWhatsAppAccountCandidates(workspaceId, credentials, {
          includeDiscovery: true,
          throwOnDiscoveryError: true,
        }),
    });
  let candidates = await getWhatsAppAccountCandidates(workspaceId, credentials);
  let discovered = false;
  const triedIds = new Set<string>();
  if (!candidates.length) {
    discovered = true;
    candidates = await discovery();
  }
  while (candidates.length) {
    for (const candidate of candidates) {
      triedIds.add(candidate.id);
      try {
        const result = await readWhatsAppTemplateCatalog({
          workspaceId,
          sourceId,
          wabaId: candidate.id,
          credentials: rawCredentials,
          force: options?.force,
          persistRateLimit: persistRateLimit(candidate.id),
          recoverable,
          success: async () => {
            if (
              !rawCredentials.meta_diagnostics_consecutive_rate_limits &&
              !rawCredentials.meta_diagnostics_last_error_code
            )
              return;
            await persistCredentials(current => {
              if (
                typeof current.meta_diagnostics_cooldown_until === "string" &&
                Date.parse(current.meta_diagnostics_cooldown_until) > Date.now()
              )
                return { ...current };
              return {
                ...current,
                meta_diagnostics_consecutive_rate_limits: 0,
                meta_diagnostics_last_error_code: null,
              };
            });
          },
          load: async () => {
            const query = new URLSearchParams({
              fields: WHATSAPP_TEMPLATE_GRAPH_FIELDS,
              limit: "100",
            });
            let nextUrl: string | undefined = buildGraphApiUrl(
              candidate.id + "/message_templates?" + query
            );
            const visited = new Set<string>();
            const templates: WhatsAppTemplate[] = [];
            while (nextUrl) {
              if (visited.has(nextUrl) || visited.size >= 50) {
                throw new WhatsAppTemplateCatalogError({
                  code: "WHATSAPP_TEMPLATES_INCOMPLETE",
                  message:
                    "Meta returned an incomplete template catalog. Try refreshing later.",
                });
              }
              visited.add(nextUrl);
              const res: Response = await fetch(nextUrl, {
                headers: {
                  Authorization: "Bearer " + credentials.accessToken,
                  "Content-Type": "application/json",
                },
                signal: AbortSignal.timeout(10_000),
              });
              const response =
                await parseGraphResponse<GraphListResponse<WhatsAppTemplate>>(
                  res
                );
              if (!res.ok || response?.error) {
                throw new MetaGraphRequestError({
                  message: formatGraphApiError(
                    response?.error,
                    "Failed to fetch templates: " + res.status
                  ),
                  status: res.status,
                  statusText: res.statusText,
                  url: nextUrl,
                  details: response,
                  metaError: response?.error
                    ? {
                        ...response.error,
                        message:
                          response.error.message ?? "Failed to fetch templates",
                        type: response.error.type ?? "GraphAPIError",
                        code: Number.isFinite(Number(response.error.code))
                          ? Number(response.error.code)
                          : 0,
                      }
                    : undefined,
                });
              }
              if (
                !Array.isArray(response.data) ||
                response.data.some(
                  template =>
                    !template ||
                    typeof template.id !== "string" ||
                    typeof template.name !== "string" ||
                    typeof template.language !== "string" ||
                    typeof template.status !== "string"
                ) ||
                (response.paging !== undefined &&
                  (!response.paging ||
                    typeof response.paging !== "object" ||
                    Array.isArray(response.paging))) ||
                (response.paging?.next !== undefined &&
                  (typeof response.paging.next !== "string" ||
                    !response.paging.next.trim()))
              ) {
                throw new WhatsAppTemplateCatalogError({
                  code: "WHATSAPP_TEMPLATES_INCOMPLETE",
                  message:
                    "Meta returned an invalid template catalog. Try refreshing later.",
                });
              }
              templates.push(...response.data);
              nextUrl = response.paging?.next;
            }
            return templates;
          },
        });
        const filtered = options?.status
          ? result.templates.filter(
              template => template.status === options.status
            )
          : result.templates;
        const limit =
          typeof options?.limit === "number" && Number.isFinite(options.limit)
            ? Math.max(1, Math.floor(options.limit))
            : undefined;
        return {
          ...result,
          templates: limit === undefined ? filtered : filtered.slice(0, limit),
        };
      } catch (error) {
        if (
          !(error instanceof MetaGraphRequestError) ||
          !isWhatsAppAccountAccessError(error.metaError, error.status)
        )
          throw error;
        templateServiceLogger.warn(
          "WhatsApp template account candidate failed",
          {
            workspaceId,
            sourceId,
            candidateSource: candidate.source,
            candidateId: candidate.id,
            status: error.status,
            graphCode: error.metaError?.code,
            graphType: error.metaError?.type,
          }
        );
      }
    }
    if (discovered) break;
    discovered = true;
    candidates = (await discovery()).filter(
      candidate => !triedIds.has(candidate.id)
    );
  }
  throw new Error(
    "Cannot access WhatsApp message templates for this connection. Reconnect WhatsApp or grant whatsapp_business_management access to the selected WhatsApp Business Account in Meta Business Manager."
  );
}

/**
 * Create a new template
 */
export async function createTemplate(
  workspaceId: string,
  payload: CreateWhatsAppTemplatePayload,
  options: WhatsAppTemplateAccountOptions = {}
): Promise<{ id: string; status: string; warning?: string }> {
  const language = normalizeWhatsAppTemplateLanguageCode(payload.language);
  if (!language) {
    throw new Error(
      `Unsupported WhatsApp template language code: ${payload.language}`
    );
  }
  const components = validateTemplateComponents(
    payload.components,
    payload.category
  );

  const { wabaId, accessToken, sourceId } = await resolveTemplateAccountContext(
    workspaceId,
    options
  );
  const metaComponents = await prepareTemplateComponentsForMetaSubmission(
    components,
    accessToken
  );

  const url = buildGraphApiUrl(`${wabaId}/message_templates`);

  const graphPayload: Record<string, unknown> = {
    name: payload.name,
    language,
    category: payload.category,
    components: metaComponents,
  };

  if (getWhatsAppTemplateParameterFormat(components) === "NAMED") {
    graphPayload.parameter_format = "NAMED";
  }
  if (payload.allow_category_change !== undefined) {
    graphPayload.allow_category_change = payload.allow_category_change;
  }
  if (payload.optimization_spec !== undefined) {
    graphPayload.optimization_spec = payload.optimization_spec;
  }

  const catalogMutation = await beginWhatsAppTemplateCatalogMutation({
    workspaceId,
    sourceId,
    wabaId,
  });
  let catalogPatch: WhatsAppTemplateCatalogPatch | undefined;
  try {
    let { res, response } = await postTemplateMutation(
      url,
      accessToken,
      graphPayload
    );
    let optimizationSpecDropped = false;

    if (
      (!res.ok || response?.error) &&
      graphPayload.optimization_spec !== undefined &&
      isOptimizationSpecAllowlistError(response?.error)
    ) {
      templateServiceLogger.warn(
        "Retrying WhatsApp template create without optimization_spec",
        {
          workspaceId,
          templateName: payload.name,
        }
      );
      const retryResult = await postTemplateMutation(
        url,
        accessToken,
        omitOptimizationSpec(graphPayload)
      );
      res = retryResult.res;
      response = retryResult.response;
      optimizationSpecDropped = true;
    }

    if (!res.ok || response?.error) {
      throw new Error(
        formatGraphApiError(
          response?.error,
          `Failed to create template: ${res.status}`
        )
      );
    }

    if (!response.id) {
      throw new Error("Meta template create response missing template id");
    }

    catalogPatch = {
      type: "upsert",
      template: {
        id: response.id,
        name: payload.name,
        language,
        category: payload.category,
        status: response.status ?? "PENDING",
        components,
      },
    };

    return {
      id: response.id,
      status: response.status || "PENDING",
      ...(optimizationSpecDropped
        ? { warning: OPTIMIZATION_SPEC_DROPPED_WARNING }
        : {}),
    };
  } finally {
    await finishWhatsAppTemplateCatalogMutation(catalogMutation, catalogPatch);
  }
}

/**
 * Update an existing template
 * Note: Meta API uses POST to update templates by ID
 */
export async function updateTemplate(
  workspaceId: string,
  templateId: string,
  payload: UpdateWhatsAppTemplatePayload,
  options: WhatsAppTemplateAccountOptions = {}
): Promise<{ success: boolean; warning?: string }> {
  const components =
    payload.components !== undefined
      ? validateTemplateComponents(payload.components, payload.category)
      : undefined;
  const account = await resolveTemplateAccountContext(workspaceId, options);
  const { accessToken } = account;
  const metaComponents =
    components !== undefined
      ? await prepareTemplateComponentsForMetaSubmission(
          components,
          accessToken
        )
      : undefined;

  const url = buildGraphApiUrl(`${templateId}`);

  const graphPayload: Record<string, unknown> = {};

  if (payload.category !== undefined) {
    graphPayload.category = payload.category;
  }
  if (metaComponents !== undefined) {
    graphPayload.components = metaComponents;
    // An edit can be what turns {{1}} into {{name}}, so say it on update too.
    if (getWhatsAppTemplateParameterFormat(metaComponents) === "NAMED") {
      graphPayload.parameter_format = "NAMED";
    }
  }
  if (payload.allow_category_change !== undefined) {
    graphPayload.allow_category_change = payload.allow_category_change;
  }
  if (payload.optimization_spec !== undefined) {
    graphPayload.optimization_spec = payload.optimization_spec;
  }

  if (Object.keys(graphPayload).length === 0) {
    return { success: true };
  }

  const catalogMutation = await beginWhatsAppTemplateCatalogMutation({
    workspaceId,
    ...catalogAccountIdentity(account),
  });
  let catalogPatch: WhatsAppTemplateCatalogPatch | undefined;
  try {
    let { res, response } = await postTemplateMutation(
      url,
      accessToken,
      graphPayload
    );
    let optimizationSpecDropped = false;

    if (
      (!res.ok || response?.error) &&
      graphPayload.optimization_spec !== undefined &&
      isOptimizationSpecAllowlistError(response?.error)
    ) {
      templateServiceLogger.warn(
        "Retrying WhatsApp template update without optimization_spec",
        {
          workspaceId,
          templateId,
        }
      );
      const retryResult = await postTemplateMutation(
        url,
        accessToken,
        omitOptimizationSpec(graphPayload)
      );
      res = retryResult.res;
      response = retryResult.response;
      optimizationSpecDropped = true;
    }

    if (!res.ok || response?.error) {
      throw new Error(
        formatGraphApiError(
          response?.error,
          `Failed to update template: ${res.status}`
        )
      );
    }

    if (response.success !== false)
      catalogPatch = { type: "remove", templateId };
    return {
      success: response.success !== false,
      ...(optimizationSpecDropped
        ? { warning: OPTIMIZATION_SPEC_DROPPED_WARNING }
        : {}),
    };
  } finally {
    // The old approved row is uncertain after an edit until the canonical
    // mutation service reads Meta's new template and getTemplate patches it.
    await finishWhatsAppTemplateCatalogMutation(catalogMutation, catalogPatch);
  }
}

/**
 * Delete a template.
 * Uses ID-based delete when templateId is provided.
 * Falls back to name-based delete if ID is unavailable.
 */
export async function deleteTemplate(
  workspaceId: string,
  input: string | DeleteTemplateOptions
): Promise<{
  success: boolean;
  deletedBy: "id" | "name";
  templateId?: string;
}> {
  const { wabaId, accessToken, sourceId } =
    await resolveTemplateAccountContext(workspaceId);

  const options: DeleteTemplateOptions =
    typeof input === "string" ? { templateName: input } : input;
  const templateName = options.templateName?.trim();
  if (!templateName) {
    throw new Error("templateName is required");
  }

  let templateId = options.templateId?.trim();
  if (!templateId && options.language?.trim()) {
    const language = normalizeWhatsAppTemplateLanguageCode(options.language);
    if (!language) {
      throw new Error(
        `Unsupported WhatsApp template language code: ${options.language}`
      );
    }
    try {
      const { templates } = await listTemplates(workspaceId);
      const match = templates.find(
        template =>
          template.name === templateName &&
          normalizeWhatsAppTemplateLanguageCode(template.language) === language
      );
      templateId = match?.id;
    } catch (resolveError) {
      templateServiceLogger.error(
        "Failed resolving WhatsApp template ID",
        resolveError,
        {
          workspaceId,
          templateName,
          language,
        }
      );
    }
  }

  const params = new URLSearchParams({ name: templateName });
  if (templateId) {
    params.set("hsm_id", templateId);
  }

  const url = buildGraphApiUrl(
    `${wabaId}/message_templates?${params.toString()}`
  );

  const catalogMutation = await beginWhatsAppTemplateCatalogMutation({
    workspaceId,
    sourceId,
    wabaId,
  });
  let catalogPatch: WhatsAppTemplateCatalogPatch | undefined;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const response =
      await parseGraphResponse<GraphTemplateMutationResponse>(res);

    if (!res.ok || response?.error) {
      throw new Error(
        response?.error?.message || `Failed to delete template: ${res.status}`
      );
    }

    if (response.success !== false)
      catalogPatch = { type: "remove", templateId, templateName };
    return {
      success: response.success !== false,
      deletedBy: templateId ? "id" : "name",
      templateId,
    };
  } finally {
    await finishWhatsAppTemplateCatalogMutation(catalogMutation, catalogPatch);
  }
}

/**
 * One template as Meta has it now.
 */
export async function getTemplate(
  workspaceId: string,
  templateId: string,
  options: WhatsAppTemplateAccountOptions = {}
): Promise<WhatsAppTemplate> {
  const account =
    options.accountContext !== undefined
      ? await resolveTemplateAccountContext(workspaceId, options)
      : await getWhatsAppAccountCredentials(workspaceId);
  // A direct ID read does not prove which candidate WABA owns that template.
  // Only a caller's verified context may update a WABA catalog or cooldown.
  const identity = {
    sourceId: account.sourceId,
    wabaId:
      options.accountContext !== undefined
        ? catalogAccountIdentity(account).wabaId
        : undefined,
  };
  const rawCredentials = account.rawCredentials ?? {};
  const cooldown = selectLaterActiveWhatsAppMetaReadCooldownUntil([
    typeof rawCredentials.meta_diagnostics_cooldown_until === "string"
      ? rawCredentials.meta_diagnostics_cooldown_until
      : null,
    identity.wabaId
      ? await getCachedWhatsAppMetaReadCooldownUntil(identity.wabaId)
      : null,
  ]);
  if (cooldown)
    throw new WhatsAppTemplateCatalogError({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      message:
        "Meta temporarily limited WhatsApp template requests. Try again after the cooldown.",
      retryAt: cooldown,
      providerCode:
        Number.isFinite(
          Number(rawCredentials.meta_diagnostics_last_error_code)
        ) && Number(rawCredentials.meta_diagnostics_last_error_code) > 0
          ? Number(rawCredentials.meta_diagnostics_last_error_code)
          : undefined,
    });
  const capturedGeneration =
    identity.sourceId && identity.wabaId
      ? await readWhatsAppTemplateCatalogGeneration({
          workspaceId,
          sourceId: identity.sourceId,
          wabaId: identity.wabaId,
        })
      : undefined;
  let template: WhatsAppTemplate;
  try {
    // Explicit mutation readback is one intentional read, independent of the
    // catalog's 60s spacing. It still obeys the WABA cooldown above.
    template = await fetchWhatsAppTemplateById({
      templateId,
      accessToken: account.accessToken,
    });
  } catch (error) {
    const rate = getMetaGraphRateLimitMetadata(error);
    if (!rate) throw error;
    const retryAt = await protectWhatsAppTemplateRateLimit({
      wabaId: identity.wabaId,
      credentials: rawCredentials,
      error,
      persistPatch: buildCredentials =>
        identity.sourceId
          ? persistTemplateReadPolicy({
              workspaceId,
              sourceId: identity.sourceId,
              expectedWabaId:
                normalizeWhatsAppCredentials(rawCredentials).wabaId ??
                identity.wabaId ??
                "",
              buildCredentials,
            })
          : Promise.resolve(),
    });
    throw new WhatsAppTemplateCatalogError({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      message:
        error instanceof Error
          ? error.message
          : "Meta temporarily limited WhatsApp template requests.",
      retryAt,
      providerCode: rate.code,
      providerStatus: rate.status,
    });
  }
  if (
    template.id !== templateId ||
    typeof template.status !== "string" ||
    typeof template.language !== "string"
  ) {
    throw new WhatsAppTemplateCatalogError({
      code: "WHATSAPP_TEMPLATES_INCOMPLETE",
      message: "Meta returned an incomplete template readback.",
    });
  }
  if (
    identity.sourceId &&
    identity.wabaId &&
    capturedGeneration !== undefined
  ) {
    try {
      await patchWhatsAppTemplateCatalog({
        workspaceId,
        sourceId: identity.sourceId,
        wabaId: identity.wabaId,
        patch: { type: "upsert", template },
        expectedGeneration: capturedGeneration,
      });
    } catch {
      templateServiceLogger.warn("Verified template readback was not cached", {
        workspaceId,
        sourceId: identity.sourceId,
        templateId,
      });
    }
  }
  return template;
}

/**
 * Sync templates from Graph API to the MongoDB cache and the stored
 * `message_templates` rows.
 */
export async function syncTemplatesToMongo(
  workspaceId: string,
  userId: string
): Promise<
  {
    synced: number;
    errors: number;
    wabaId: string;
  } & WhatsAppTemplateCatalogResult
> {
  const { templates, catalog } = await listTemplates(workspaceId, {
    force: true,
  });
  const result = { templates, catalog, wabaId: catalog.wabaId };
  // A blocked refresh is useful for display, but cannot authorize pruning or
  // overwriting stored rows. Only a complete verified catalog is mirrored.
  if (
    catalog.stale ||
    !["succeeded", "fresh", "minimum_interval"].includes(catalog.refreshOutcome)
  ) {
    return { synced: 0, errors: 0, ...result };
  }
  await connectDB();
  const activeTemplateIds = new Set(
    templates.map(readWhatsAppTemplateSnapshotId)
  );

  let synced = 0;
  let errors = 0;

  for (const template of templates) {
    try {
      await upsertTemplateSnapshot(workspaceId, template);

      synced++;
    } catch (error) {
      console.error(`Failed to sync template ${template.name}:`, error);
      errors++;

      // Log error to audit
      await WhatsAppTemplateAuditLog.create({
        workspaceId,
        templateId: template.id,
        templateName: template.name,
        action: "SYNC",
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Legacy snapshots have workspace identity only. Prune only an unambiguous
  // workspace with one source bound to this verified WABA.
  const sourceClient = await createClient();
  const { data: sources, error: sourceReadError } = await sourceClient
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp");
  const canPrune =
    !sourceReadError &&
    Array.isArray(sources) &&
    sources.length === 1 &&
    normalizeWhatsAppCredentials(sources[0].credentials).wabaId ===
      catalog.wabaId;
  if (canPrune && activeTemplateIds.size > 0) {
    await WhatsAppTemplateModel.deleteMany({
      workspaceId,
      templateId: { $nin: Array.from(activeTemplateIds) },
    });
  } else if (canPrune) {
    await WhatsAppTemplateModel.deleteMany({ workspaceId });
  }

  try {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    await mirrorWhatsAppTemplatesToUnifiedRows({
      supabase: supabaseAdmin,
      workspaceId,
      templates,
    });
  } catch (error) {
    templateServiceLogger.error(
      "Failed to sync stored WhatsApp templates",
      error,
      { workspaceId }
    );
    errors++;
  }

  return { synced, errors, ...result };
}

/**
 * Log template action to audit collection
 */
export async function logTemplateAction(
  workspaceId: string,
  userId: string,
  action: "CREATE" | "UPDATE" | "DELETE" | "SYNC",
  templateName: string,
  options?: {
    templateId?: string;
    changes?: Record<string, unknown>;
    error?: string;
  }
): Promise<void> {
  await connectDB();

  await WhatsAppTemplateAuditLog.create({
    workspaceId,
    templateId: options?.templateId,
    templateName,
    action,
    userId,
    changes: options?.changes,
    error: options?.error,
  });
}

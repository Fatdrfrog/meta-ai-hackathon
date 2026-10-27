import type {
  ScenarioAudienceOptions,
  ScenarioContextItem,
  ScenarioContextOption,
  ScenarioWhatsAppFlowOption,
  ScenarioWhatsAppTemplate,
} from "@icecore/scenario-contracts";
import {
  fetchWhatsAppFlowDetails as fetchWhatsAppFlowDetailsRequest,
  fetchWhatsAppFlowsList,
  type WhatsAppFlowDetailsResponse,
} from "@/lib/whatsapp/flows/client";
import {
  fetchWhatsAppTemplateCatalog,
  invalidateWhatsAppTemplateCatalog,
} from "@/lib/whatsapp/templates/catalog-client";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  asArray,
  errorMessageOrFallback,
  fetchListIfOk,
  fetchListResult,
  JSON_HEADERS,
  NO_STORE_OPTIONS,
  readResponseJson,
  sortByLocale2,
} from "./http";
import { createWorkspaceOptionsCache } from "./workspace-options-cache";
import type { WhatsAppTemplateCatalogMetadata } from "@/lib/whatsapp/templates/catalog-contracts";

type ScenarioWhatsAppFlowDetails = Pick<
  WhatsAppFlowDetailsResponse,
  "flow" | "flowJson" | "flowJsonError"
>;

export type UpdateScenarioWhatsAppTemplateInput = {
  workspaceId: string;
  templateId: string;
  category?: string;
  components?: WhatsAppComponent[];
  allowCategoryChange?: boolean;
};

export type UpdateScenarioWhatsAppTemplateResult =
  | {
      ok: true;
      message?: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

function normalizeAudienceOptions(
  options: Partial<ScenarioAudienceOptions> | undefined
): ScenarioAudienceOptions {
  return {
    channels: asArray<string>(options?.channels),
    classificationCategories: asArray<string>(
      options?.classificationCategories
    ),
    funnelStages: asArray<string>(options?.funnelStages),
    internalLabels: asArray<string>(options?.internalLabels),
    customers: asArray<ScenarioAudienceOptions["customers"][number]>(
      options?.customers
    ),
    metaReferralAds: asArray<
      ScenarioAudienceOptions["metaReferralAds"][number]
    >(options?.metaReferralAds),
    metaReferralCampaigns: asArray<
      ScenarioAudienceOptions["metaReferralCampaigns"][number]
    >(options?.metaReferralCampaigns),
    metaReferralAdSets: asArray<
      ScenarioAudienceOptions["metaReferralAdSets"][number]
    >(options?.metaReferralAdSets),
    metaCampaignLabels: asArray<
      ScenarioAudienceOptions["metaCampaignLabels"][number]
    >(options?.metaCampaignLabels),
    ...(options?.metaAdsDataStatus
      ? { metaAdsDataStatus: options.metaAdsDataStatus }
      : {}),
  };
}

function normalizeScenarioWhatsAppTemplates(
  value: unknown
): ScenarioWhatsAppTemplate[] {
  if (!Array.isArray(value)) return [];
  const rows = value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const language =
      typeof raw.language === "string" ? raw.language.trim() : "";
    if (!name || !language) return [];
    return [
      {
        id: typeof raw.id === "string" ? raw.id : undefined,
        name,
        language,
        category: typeof raw.category === "string" ? raw.category : undefined,
        status: typeof raw.status === "string" ? raw.status : undefined,
        components: Array.isArray(raw.components)
          ? (raw.components as ScenarioWhatsAppTemplate["components"])
          : undefined,
      } satisfies ScenarioWhatsAppTemplate,
    ];
  });
  return sortByLocale2(
    rows,
    t => t.name,
    t => t.language
  );
}

function normalizeScenarioWhatsAppFlows(
  value: unknown,
  sourceId?: string
): ScenarioWhatsAppFlowOption[] {
  if (!Array.isArray(value)) return [];
  const normalizedSourceId = sourceId?.trim() || "";
  const rows = value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) return [];
    const name =
      typeof raw.name === "string" && raw.name.trim().length > 0
        ? raw.name.trim()
        : id;
    return [
      {
        id,
        name,
        ...(normalizedSourceId ? { sourceId: normalizedSourceId } : {}),
        status: typeof raw.status === "string" ? raw.status.trim() : undefined,
      } satisfies ScenarioWhatsAppFlowOption,
    ];
  });
  return sortByLocale2(
    rows,
    f => f.name,
    f => f.id
  );
}

async function requestScenarioContextOptions(
  workspaceId: string
): Promise<{ ok: boolean; value: ScenarioContextOption[] }> {
  const result = await fetchListResult<ScenarioContextOption>(
    `/api/workspaces/${workspaceId}/scenarios/context-options`,
    "options"
  );
  return { ok: result.ok, value: result.items };
}

const scenarioContextOptionsCache = createWorkspaceOptionsCache(
  requestScenarioContextOptions
);

/** Context options, shown from this tab's last answer while asking again. */
export const loadScenarioContextOptions = scenarioContextOptionsCache.load;
export const readCachedScenarioContextOptions =
  scenarioContextOptionsCache.read;

export async function fetchScenarioContextItems(params: {
  workspaceId: string;
  contextOptionId: string;
}): Promise<ScenarioContextItem[]> {
  return fetchListIfOk<ScenarioContextItem>(
    `/api/workspaces/${params.workspaceId}/scenarios/context-items?contextOptionId=${encodeURIComponent(params.contextOptionId)}`,
    "items"
  );
}

export async function createScenarioAnswerSnippet(params: {
  workspaceId: string;
  question: string;
  answer: string;
}): Promise<{ id?: string; upserted: number }> {
  const response = await fetch("/api/answer-snippets", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      workspaceId: params.workspaceId,
      items: [
        {
          question: params.question,
          answer: params.answer,
        },
      ],
    }),
  });

  const data = (await readResponseJson(response)) as {
    error?: string;
    items?: Array<{ id?: string }>;
    upserted?: number;
  } | null;
  if (!response.ok) {
    throw new Error(
      errorMessageOrFallback(data, "Failed to create answer snippet")
    );
  }
  // Context options count the workspace's answer snippets.
  scenarioContextOptionsCache.forget(params.workspaceId);

  const firstItem = Array.isArray(data?.items) ? data.items[0] : undefined;

  return {
    id: firstItem?.id,
    upserted: typeof data?.upserted === "number" ? data.upserted || 0 : 0,
  };
}

async function requestScenarioAudienceOptions(
  workspaceId: string
): Promise<{ ok: boolean; value: ScenarioAudienceOptions }> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/scenarios/audience-options`,
    NO_STORE_OPTIONS
  );
  if (!response.ok) {
    return { ok: false, value: normalizeAudienceOptions(undefined) };
  }
  const data = (await readResponseJson(response)) as {
    options?: Partial<ScenarioAudienceOptions>;
  } | null;
  return { ok: true, value: normalizeAudienceOptions(data?.options) };
}

export async function fetchScenarioAudienceOptions(
  workspaceId: string
): Promise<ScenarioAudienceOptions> {
  return (await requestScenarioAudienceOptions(workspaceId)).value;
}

const scenarioAudienceOptionsCache = createWorkspaceOptionsCache(
  requestScenarioAudienceOptions
);

/** Audience options, shown from this tab's last answer while asking again. */
export const loadScenarioAudienceOptions = scenarioAudienceOptionsCache.load;
export const readCachedScenarioAudienceOptions =
  scenarioAudienceOptionsCache.read;

export async function fetchScenarioWhatsAppTemplates(
  workspaceId: string,
  options?: {
    force?: boolean;
    sourceId?: string;
    throwOnError?: boolean;
    onCatalogLoaded?: (catalog?: WhatsAppTemplateCatalogMetadata) => void;
  }
): Promise<ScenarioWhatsAppTemplate[]> {
  try {
    const result = await fetchWhatsAppTemplateCatalog({
      workspaceId,
      sourceId: options?.sourceId,
      status: "APPROVED",
      limit: 300,
      force: options?.force,
      includeUnified: false,
    });
    options?.onCatalogLoaded?.(result.catalog);
    return normalizeScenarioWhatsAppTemplates(result.selectionItems);
  } catch (error) {
    if (options?.throwOnError) throw error;
    return [];
  }
}

export async function updateScenarioWhatsAppTemplate(
  input: UpdateScenarioWhatsAppTemplateInput
): Promise<UpdateScenarioWhatsAppTemplateResult> {
  const response = await fetch("/api/whatsapp/templates", {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      templateId: input.templateId,
      category: input.category,
      components: input.components,
      allow_category_change: input.allowCategoryChange,
    }),
  });
  const data = (await readResponseJson(response)) as {
    success?: boolean;
    message?: string;
    error?: string;
  } | null;

  if (!response.ok || data?.success === false) {
    return {
      ok: false,
      status: response.status,
      error: errorMessageOrFallback(data, "Failed to update WhatsApp template"),
    };
  }

  invalidateWhatsAppTemplateCatalog(input.workspaceId);

  return {
    ok: true,
    message: typeof data?.message === "string" ? data.message : undefined,
  };
}

export async function fetchScenarioWhatsAppFlows(
  workspaceId: string,
  options?: { force?: boolean; sourceIds?: readonly string[] }
): Promise<ScenarioWhatsAppFlowOption[]> {
  const sourceIds = Array.from(
    new Set(
      (options?.sourceIds ?? [])
        .map(sourceId => sourceId.trim())
        .filter(Boolean)
    )
  );
  const requestedSources: Array<string | undefined> =
    sourceIds.length > 0 ? sourceIds : [undefined];
  const results = await Promise.all(
    requestedSources.map(sourceId =>
      fetchWhatsAppFlowsList({
        workspaceId,
        ...(sourceId ? { sourceId } : {}),
        limit: 200,
        force: options?.force,
      })
    )
  );

  return results.flatMap(result => {
    if (!result.ok) return [];
    return normalizeScenarioWhatsAppFlows(
      result.data?.flows,
      result.data?.sourceId
    );
  });
}

export async function fetchScenarioWhatsAppFlowDetails(params: {
  workspaceId: string;
  sourceId?: string;
  flowId: string;
}): Promise<ScenarioWhatsAppFlowDetails> {
  const result = await fetchWhatsAppFlowDetailsRequest({
    workspaceId: params.workspaceId,
    ...(params.sourceId ? { sourceId: params.sourceId } : {}),
    flowId: params.flowId,
    includeJson: true,
  });
  const data = result.data;

  if (!result.ok) {
    throw new Error(data?.error || "Failed to load WhatsApp flow");
  }

  return {
    flow: data?.flow && typeof data.flow === "object" ? data.flow : undefined,
    flowJson: data?.flowJson,
    flowJsonError:
      typeof data?.flowJsonError === "string" || data?.flowJsonError === null
        ? data.flowJsonError
        : null,
  };
}

export type WhatsAppServiceSignupLink = {
  id: string;
  metaSignupId: string;
  deepLinkUrl: string;
  displayName: string | null;
  status: "ACTIVE" | "DISABLED";
};

export type WhatsAppServiceCatalog = {
  id: string;
  name?: string;
};

export type WhatsAppServiceCatalogProduct = {
  id?: string;
  catalog_id?: string;
  retailer_id?: string;
  name?: string;
};

export type WhatsAppServiceMessageResources = {
  signupLinks: WhatsAppServiceSignupLink[];
  catalogs: WhatsAppServiceCatalog[];
  products: WhatsAppServiceCatalogProduct[];
  callingReady: boolean;
};

async function fetchJsonRecord(
  url: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const response = await fetch(url, signal ? { signal } : undefined);
  const value = (await response.json().catch(() => null)) as unknown;
  if (!response.ok || !value || typeof value !== "object") {
    throw new Error(
      `Request failed with ${response.status}${url ? ` for ${url}` : ""}`
    );
  }
  return value as Record<string, unknown>;
}

export async function fetchWhatsAppServiceMessageResources(params: {
  workspaceId: string;
  loadSignupLinks: boolean;
  loadCalling: boolean;
  loadCatalog: boolean;
  catalogId?: string;
  signal?: AbortSignal;
  onRequestError?: (details: { url: string; error: unknown }) => void;
}): Promise<WhatsAppServiceMessageResources> {
  const empty: Record<string, unknown> = {};
  const fetchJson = (url: string): Promise<Record<string, unknown>> =>
    fetchJsonRecord(url, params.signal).catch(error => {
      if (params.signal?.aborted) return empty;
      params.onRequestError?.({ url, error });
      return empty;
    });

  const [signupBody, onboardingBody, catalogBody] = await Promise.all([
    params.loadSignupLinks
      ? fetchJson(
          `/api/whatsapp/signups?${new URLSearchParams({
            workspaceId: params.workspaceId,
          })}`
        )
      : Promise.resolve(empty),
    params.loadCalling
      ? fetchJson(
          `/api/whatsapp/onboarding?${new URLSearchParams({
            workspaceId: params.workspaceId,
          })}`
        )
      : Promise.resolve(empty),
    params.loadCatalog
      ? fetchJson(
          `/api/whatsapp/catalog?${new URLSearchParams({
            workspaceId: params.workspaceId,
            limit: "200",
            ...(params.catalogId ? { catalogId: params.catalogId } : {}),
          })}`
        )
      : Promise.resolve(empty),
  ]);

  const status =
    onboardingBody.status && typeof onboardingBody.status === "object"
      ? (onboardingBody.status as Record<string, unknown>)
      : {};
  const readiness =
    status.calls_operational_readiness &&
    typeof status.calls_operational_readiness === "object"
      ? (status.calls_operational_readiness as Record<string, unknown>)
      : {};
  const selectedCatalog =
    catalogBody.selectedCatalog &&
    typeof catalogBody.selectedCatalog === "object"
      ? (catalogBody.selectedCatalog as WhatsAppServiceCatalog)
      : null;
  const requestedCatalogId = params.catalogId?.trim() || "";
  const catalogMatches =
    !requestedCatalogId || selectedCatalog?.id === requestedCatalogId;

  return {
    signupLinks: Array.isArray(signupBody.links)
      ? (signupBody.links as WhatsAppServiceSignupLink[]).filter(
          link => link.status === "ACTIVE"
        )
      : [],
    catalogs: Array.isArray(catalogBody.catalogs)
      ? (catalogBody.catalogs as WhatsAppServiceCatalog[])
      : [],
    products:
      catalogMatches && Array.isArray(catalogBody.products)
        ? (catalogBody.products as WhatsAppServiceCatalogProduct[])
        : [],
    callingReady: readiness.ready === true,
  };
}

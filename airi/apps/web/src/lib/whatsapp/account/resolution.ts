import { createServerLogger } from "@/lib/observability/server-logs";
import { createClient } from "@/lib/supabase/server";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { asWhatsAppRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import { buildGraphApiUrl } from "@icecore/shared/lib/meta/graph-version";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import {
  readFirstNonEmptyStringField,
  readNonEmptyStringOrUndefined,
  readStringArray,
} from "@icecore/shared/lib/value-utils";
import type { GraphApiErrorBody } from "@icecore/shared/types/whatsapp";

const accountResolutionLogger = createServerLogger(
  "whatsapp.account-resolution"
);

type WhatsAppAccountCandidateSource =
  | "credentials.waba_id"
  | "credentials.waba_ids"
  | "business.owned_whatsapp_business_accounts"
  | "business.client_whatsapp_business_accounts"
  | "credentials.messaging_account_id";

export type WhatsAppAccountCandidate = {
  id: string;
  source: WhatsAppAccountCandidateSource;
  name?: string;
};

type WhatsAppAccountCredentials = {
  accessToken: string;
  businessId?: string;
  fallbackCandidates: WhatsAppAccountCandidate[];
  primaryCandidates: WhatsAppAccountCandidate[];
  sourceId?: string;
  /** Server-only original metadata, including persisted Meta cooldown. */
  rawCredentials: Readonly<Record<string, unknown>>;
};

export type WhatsAppAccountContext = {
  accessToken: string;
  candidateSource: WhatsAppAccountCandidateSource;
  sourceId?: string;
  wabaId: string;
  /** Server-only source metadata; never include account contexts in public responses. */
  rawCredentials?: Readonly<Record<string, unknown>>;
};

type GraphListResponse<T> = {
  data?: T[];
  paging?: { next?: string };
  error?: GraphApiErrorBody;
};

const ACCOUNT_UNSUPPORTED_PATTERN =
  /Unsupported\s+(get|post|delete)\s+request|does\s+not\s+exist|cannot\s+be\s+loaded|missing\s+permissions|does\s+not\s+support\s+this\s+operation/i;

const ACCOUNT_DISCOVERY_EDGES: Array<{
  edge: string;
  source: WhatsAppAccountCandidateSource;
}> = [
  {
    edge: "owned_whatsapp_business_accounts",
    source: "business.owned_whatsapp_business_accounts",
  },
  {
    edge: "client_whatsapp_business_accounts",
    source: "business.client_whatsapp_business_accounts",
  },
];

export const WHATSAPP_ACCOUNT_ACCESS_ERROR =
  "Cannot access the WhatsApp Business Account for this connection. Reconnect WhatsApp or grant whatsapp_business_management access to the selected WhatsApp Business Account in Meta Business Manager.";

async function parseGraphResponse<T = unknown>(res: Response): Promise<T> {
  const raw = await res.text();
  if (!raw) {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

export function formatWhatsAppGraphApiError(
  error: GraphApiErrorBody | undefined,
  fallback: string
): string {
  const errorParts: string[] = [];
  if (error?.message?.trim()) {
    errorParts.push(error.message.trim());
  }
  if (error?.error_user_msg?.trim()) {
    errorParts.push(error.error_user_msg.trim());
  }
  if (error?.error_data?.details?.trim()) {
    errorParts.push(error.error_data.details.trim());
  }

  return errorParts.length > 0 ? errorParts.join(" - ") : fallback;
}

export function isWhatsAppAccountAccessError(
  error: GraphApiErrorBody | undefined,
  status: number
): boolean {
  if (![400, 403, 404].includes(status)) {
    return false;
  }
  return ACCOUNT_UNSUPPORTED_PATTERN.test(
    formatWhatsAppGraphApiError(error, "")
  );
}

function addAccountCandidate(
  candidates: WhatsAppAccountCandidate[],
  seen: Set<string>,
  candidate: WhatsAppAccountCandidate | undefined
) {
  if (!candidate?.id || seen.has(candidate.id)) return;
  seen.add(candidate.id);
  candidates.push(candidate);
}

function buildCredentialAccountCandidates(
  credentials: Record<string, unknown>
): Pick<
  WhatsAppAccountCredentials,
  "fallbackCandidates" | "primaryCandidates"
> {
  const normalized = normalizeWhatsAppCredentials(credentials);
  const primaryCandidates: WhatsAppAccountCandidate[] = [];
  const fallbackCandidates: WhatsAppAccountCandidate[] = [];
  const primarySeen = new Set<string>();
  const fallbackSeen = new Set<string>();
  const explicitWabaId = readFirstNonEmptyStringField(credentials, [
    "waba_id",
    "wabaId",
  ]);
  const embeddedWabaIds = [
    ...readStringArray(credentials.waba_ids, { splitCommaSeparated: true }),
    ...readStringArray(credentials.wabaIds, { splitCommaSeparated: true }),
  ];

  addAccountCandidate(primaryCandidates, primarySeen, {
    id: explicitWabaId || "",
    source: "credentials.waba_id",
  });
  for (const wabaId of embeddedWabaIds) {
    addAccountCandidate(primaryCandidates, primarySeen, {
      id: wabaId,
      source: "credentials.waba_ids",
    });
  }

  const messagingAccountId = normalized.messagingAccountId;
  if (messagingAccountId) {
    addAccountCandidate(fallbackCandidates, fallbackSeen, {
      id: messagingAccountId,
      source: "credentials.messaging_account_id",
    });
  }

  return {
    primaryCandidates,
    fallbackCandidates,
  };
}

/**
 * Reads the workspace's WhatsApp source. Request handlers keep the default
 * session client, so RLS scopes the read to the signed-in member. Runtime
 * callers without a user session (AIRI replies in the worker, webhooks) pass
 * the server-only admin client for a workspace they already trust.
 */
export type WhatsAppSourceReader = Pick<
  Awaited<ReturnType<typeof createClient>>,
  "from"
>;

export async function getWhatsAppAccountCredentials(
  workspaceId: string,
  options?: { sourceId?: string; supabase?: WhatsAppSourceReader }
): Promise<WhatsAppAccountCredentials> {
  const supabase = options?.supabase ?? (await createClient());
  let query = supabase
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp");
  if (options?.sourceId !== undefined) {
    query = query.eq("id", options.sourceId);
  }
  const { data: source } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!source?.credentials) {
    throw new Error("WhatsApp credentials not found");
  }

  const credentials = asWhatsAppRecord(source.credentials);
  const normalized = normalizeWhatsAppCredentials(credentials);

  if (!normalized.accessToken) {
    throw new Error("WhatsApp access token not found or invalid");
  }
  const candidateGroups = buildCredentialAccountCandidates(credentials);

  if (
    !candidateGroups.primaryCandidates.length &&
    !candidateGroups.fallbackCandidates.length &&
    !normalized.businessId
  ) {
    throw new Error("WhatsApp Business Account ID not found");
  }

  return {
    accessToken: normalized.accessToken,
    businessId: normalized.businessId,
    fallbackCandidates: candidateGroups.fallbackCandidates,
    primaryCandidates: candidateGroups.primaryCandidates,
    sourceId: typeof source.id === "string" ? source.id : undefined,
    rawCredentials: credentials,
  };
}

async function discoverBusinessAccountCandidates(
  workspaceId: string,
  credentials: WhatsAppAccountCredentials,
  throwOnError = false
): Promise<WhatsAppAccountCandidate[]> {
  if (!credentials.businessId) return [];

  const candidates: WhatsAppAccountCandidate[] = [];
  const seen = new Set<string>();

  for (const discovery of ACCOUNT_DISCOVERY_EDGES) {
    const query = new URLSearchParams({
      fields: "id,name",
      limit: "100",
    });
    const url = buildGraphApiUrl(
      `${credentials.businessId}/${discovery.edge}?${query.toString()}`
    );
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
      },
    });
    const response =
      await parseGraphResponse<
        GraphListResponse<{ id?: string; name?: string }>
      >(res);

    if (!res.ok || response?.error) {
      if (throwOnError) {
        throw new MetaGraphRequestError({
          message: formatWhatsAppGraphApiError(
            response?.error,
            `WhatsApp account discovery failed: ${res.status}`
          ),
          status: res.status,
          statusText: res.statusText,
          url,
          details: response,
          metaError: response?.error
            ? {
                ...response.error,
                message:
                  response.error.message ?? "WhatsApp account discovery failed",
                type: response.error.type ?? "GraphAPIError",
                code: Number.isFinite(Number(response.error.code))
                  ? Number(response.error.code)
                  : 0,
              }
            : undefined,
        });
      }
      accountResolutionLogger.warn(
        "WhatsApp business account discovery failed",
        {
          workspaceId,
          sourceId: credentials.sourceId,
          edge: discovery.edge,
          status: res.status,
          graphCode: response?.error?.code,
          graphType: response?.error?.type,
        }
      );
      continue;
    }

    for (const item of response.data || []) {
      addAccountCandidate(candidates, seen, {
        id: readNonEmptyStringOrUndefined(item.id) || "",
        name: readNonEmptyStringOrUndefined(item.name),
        source: discovery.source,
      });
    }
  }

  return candidates;
}

function mergeAccountCandidates(
  ...candidateGroups: WhatsAppAccountCandidate[][]
): WhatsAppAccountCandidate[] {
  const candidates: WhatsAppAccountCandidate[] = [];
  const seen = new Set<string>();
  for (const group of candidateGroups) {
    for (const candidate of group) {
      addAccountCandidate(candidates, seen, candidate);
    }
  }
  return candidates;
}

export async function getWhatsAppAccountCandidates(
  workspaceId: string,
  credentials: WhatsAppAccountCredentials,
  options?: { includeDiscovery?: boolean; throwOnDiscoveryError?: boolean }
): Promise<WhatsAppAccountCandidate[]> {
  const discovered =
    options?.includeDiscovery === true
      ? await discoverBusinessAccountCandidates(
          workspaceId,
          credentials,
          options.throwOnDiscoveryError
        )
      : [];

  return mergeAccountCandidates(
    credentials.primaryCandidates,
    discovered,
    options?.includeDiscovery === true ? credentials.fallbackCandidates : []
  );
}

export async function resolveWhatsAppAccountContext(params: {
  workspaceId: string;
  sourceId?: string;
  probeEdge: string;
  probeFields?: string;
  logScope: string;
  failureMessage?: string;
}): Promise<WhatsAppAccountContext> {
  const credentials = await getWhatsAppAccountCredentials(params.workspaceId, {
    sourceId: params.sourceId,
  });
  let candidates = await getWhatsAppAccountCandidates(
    params.workspaceId,
    credentials
  );
  let discovered = false;
  const triedIds = new Set<string>();
  if (candidates.length === 0) {
    discovered = true;
    candidates = await getWhatsAppAccountCandidates(
      params.workspaceId,
      credentials,
      { includeDiscovery: true }
    );
  }

  while (candidates.length > 0) {
    for (const candidate of candidates) {
      triedIds.add(candidate.id);
      const query = new URLSearchParams({
        fields: params.probeFields || "id",
        limit: "1",
      });
      const res = await fetch(
        buildGraphApiUrl(`${candidate.id}/${params.probeEdge}?${query}`),
        {
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      const response =
        await parseGraphResponse<GraphListResponse<unknown>>(res);

      if (res.ok && !response?.error) {
        return {
          accessToken: credentials.accessToken,
          candidateSource: candidate.source,
          sourceId: credentials.sourceId,
          wabaId: candidate.id,
          rawCredentials: credentials.rawCredentials,
        };
      }

      if (!isWhatsAppAccountAccessError(response?.error, res.status)) {
        throw new Error(
          formatWhatsAppGraphApiError(
            response?.error,
            `Failed to access WhatsApp ${params.logScope}: ${res.status}`
          )
        );
      }

      accountResolutionLogger.warn("WhatsApp account candidate failed", {
        workspaceId: params.workspaceId,
        sourceId: credentials.sourceId,
        logScope: params.logScope,
        candidateSource: candidate.source,
        candidateId: candidate.id,
        status: res.status,
        graphCode: response?.error?.code,
        graphType: response?.error?.type,
      });
    }

    if (discovered) break;
    discovered = true;
    candidates = (
      await getWhatsAppAccountCandidates(params.workspaceId, credentials, {
        includeDiscovery: true,
      })
    ).filter(candidate => !triedIds.has(candidate.id));
  }

  throw new Error(params.failureMessage || WHATSAPP_ACCOUNT_ACCESS_ERROR);
}

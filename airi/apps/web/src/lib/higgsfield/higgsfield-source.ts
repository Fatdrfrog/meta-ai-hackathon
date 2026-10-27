import "server-only";

import type { createClient } from "@/lib/supabase/server";
import {
  asRecord,
  readTrimmedString as cleanString,
  firstOrSelf,
} from "@icecore/shared/lib/value-utils";
import { getHiggsfieldKey } from "./higgsfield-client";

const DEFAULT_AIRI_CHAT_COMPANY_ID = "d81123b4-b2fa-49d3-86af-25b4482b8269";
const DEFAULT_AIRI_CHAT_WORKSPACE_ID = "41b51d55-697c-4455-875a-9a7238bdf272";

type SupabaseSourceClient = Pick<
  Awaited<ReturnType<typeof createClient>>,
  "from"
>;

export type HiggsfieldCredentialSource = "workspace_source" | "platform";
export type HiggsfieldDisabledReason =
  | "source_required"
  | "server_unconfigured";

export type HiggsfieldGenerationAccess = {
  available: boolean;
  reason: HiggsfieldDisabledReason | null;
  sourceId: string | null;
  credentialSource: HiggsfieldCredentialSource | null;
};

type SourceRow = {
  id?: string | null;
  credentials?: unknown;
};

type WorkspaceCompanyRow = {
  id?: string | null;
  company_id?: string | null;
  companies?: { id?: string | null } | Array<{ id?: string | null }> | null;
};

function parseIdAllowlist(
  value: string | undefined,
  fallback: string
): Set<string> {
  return new Set(
    (value || fallback)
      .split(",")
      .map(id => id.trim())
      .filter(Boolean)
  );
}

function getAiriChatHiggsfieldCompanyIds(): Set<string> {
  return parseIdAllowlist(
    process.env.AIRI_CHAT_HIGGSFIELD_COMPANY_IDS,
    DEFAULT_AIRI_CHAT_COMPANY_ID
  );
}

function getAiriChatHiggsfieldWorkspaceIds(): Set<string> {
  return parseIdAllowlist(
    process.env.AIRI_CHAT_HIGGSFIELD_WORKSPACE_IDS,
    DEFAULT_AIRI_CHAT_WORKSPACE_ID
  );
}

export function buildHiggsfieldAuthKeyFromCredentials(
  credentials: unknown
): string {
  const raw = asRecord(credentials);
  const singleKey = cleanString(raw.key) || cleanString(raw.higgsfield_key);
  if (singleKey) return singleKey;

  const apiKey = cleanString(raw.api_key) || cleanString(raw.apiKey);
  const apiSecret = cleanString(raw.api_secret) || cleanString(raw.apiSecret);
  if (apiKey && apiSecret) return `${apiKey}:${apiSecret}`;
  if (apiKey.includes(":")) return apiKey;
  return "";
}

export function isAiriChatHiggsfieldPlatformWorkspace(params: {
  workspaceId: string | null | undefined;
  workspaceCompanyId: string | null | undefined;
  joinedCompanyId: string | null | undefined;
}): boolean {
  const allowedWorkspaceIds = getAiriChatHiggsfieldWorkspaceIds();
  const allowedCompanyIds = getAiriChatHiggsfieldCompanyIds();
  const workspaceId = cleanString(params.workspaceId);
  const workspaceCompanyId = cleanString(params.workspaceCompanyId);
  const joinedCompanyId = cleanString(params.joinedCompanyId);

  return (
    Boolean(workspaceId && allowedWorkspaceIds.has(workspaceId)) ||
    Boolean(workspaceCompanyId && allowedCompanyIds.has(workspaceCompanyId)) ||
    Boolean(joinedCompanyId && allowedCompanyIds.has(joinedCompanyId))
  );
}

async function loadWorkspaceCompany(params: {
  supabase: SupabaseSourceClient;
  workspaceId: string;
}): Promise<WorkspaceCompanyRow | null> {
  const { data, error } = await params.supabase
    .from("workspaces")
    .select("id, company_id, companies!workspaces_company_id_fkey(id)")
    .eq("id", params.workspaceId)
    .maybeSingle();

  if (error || !data) return null;
  return data as WorkspaceCompanyRow;
}

async function loadHiggsfieldSource(params: {
  supabase: SupabaseSourceClient;
  workspaceId: string;
  sourceId?: string | null;
}): Promise<{ id: string; authKey: string } | null> {
  let query = params.supabase
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", params.workspaceId)
    .eq("type", "higgsfield");

  if (params.sourceId) {
    query = query.eq("id", params.sourceId);
  } else {
    query = query.order("created_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;

  const source = data as SourceRow;
  const sourceId = cleanString(source.id);
  const authKey = buildHiggsfieldAuthKeyFromCredentials(source.credentials);
  if (!sourceId || !authKey) return null;
  return { id: sourceId, authKey };
}

export async function resolveWorkspaceHiggsfieldGenerationAccess(params: {
  supabase: SupabaseSourceClient;
  workspaceId: string;
}): Promise<HiggsfieldGenerationAccess> {
  const source = await loadHiggsfieldSource(params);
  if (source) {
    return {
      available: true,
      reason: null,
      sourceId: source.id,
      credentialSource: "workspace_source",
    };
  }

  const workspace = await loadWorkspaceCompany(params);
  const company = firstOrSelf(workspace?.companies);
  const platformAllowed = isAiriChatHiggsfieldPlatformWorkspace({
    workspaceId: workspace?.id || params.workspaceId,
    workspaceCompanyId: workspace?.company_id || null,
    joinedCompanyId: company?.id || null,
  });

  if (!platformAllowed) {
    return {
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    };
  }

  if (!getHiggsfieldKey()) {
    return {
      available: false,
      reason: "server_unconfigured",
      sourceId: null,
      credentialSource: null,
    };
  }

  return {
    available: true,
    reason: null,
    sourceId: null,
    credentialSource: "platform",
  };
}

export async function resolveHiggsfieldAuthKeyForWorkspace(params: {
  supabase: SupabaseSourceClient;
  workspaceId: string;
  sourceId?: string | null;
}): Promise<{
  authKey: string;
  sourceId: string | null;
  credentialSource: HiggsfieldCredentialSource;
}> {
  const source = await loadHiggsfieldSource(params);
  if (source) {
    return {
      authKey: source.authKey,
      sourceId: source.id,
      credentialSource: "workspace_source",
    };
  }

  if (params.sourceId) {
    throw new Error(
      "The connected Higgsfield source is unavailable. Reconnect it in Settings > Integrations."
    );
  }

  const workspace = await loadWorkspaceCompany(params);
  const company = firstOrSelf(workspace?.companies);
  const platformAllowed = isAiriChatHiggsfieldPlatformWorkspace({
    workspaceId: workspace?.id || params.workspaceId,
    workspaceCompanyId: workspace?.company_id || null,
    joinedCompanyId: company?.id || null,
  });
  if (!platformAllowed) {
    throw new Error(
      "Connect a Higgsfield source in Settings > Integrations to generate assets."
    );
  }

  const platformKey = getHiggsfieldKey();
  if (!platformKey) {
    throw new Error(
      "Higgsfield credentials are not configured. Connect a Higgsfield source in Settings > Integrations."
    );
  }

  return {
    authKey: platformKey,
    sourceId: null,
    credentialSource: "platform",
  };
}

export function toPublicHiggsfieldCredentials(
  credentials: unknown
): Record<string, unknown> {
  const raw = asRecord(credentials);
  const apiKey = cleanString(raw.api_key) || cleanString(raw.apiKey);
  const apiSecret = cleanString(raw.api_secret) || cleanString(raw.apiSecret);
  const singleKey = cleanString(raw.key) || cleanString(raw.higgsfield_key);
  const visibleKey = apiKey || singleKey;
  const suffix = visibleKey ? visibleKey.slice(-4) : "";

  return {
    has_api_key: Boolean(apiKey || singleKey),
    has_api_secret: Boolean(apiSecret || singleKey.includes(":")),
    key_label: suffix ? `••••${suffix}` : null,
    connected_at: cleanString(raw.connected_at) || null,
  };
}

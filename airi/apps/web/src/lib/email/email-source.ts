import {
  getWorkspaceEmailProviderConfig,
  getWorkspaceEmailProviderConfigResult,
  getWorkspaceEmailProviderRow,
  getWorkspaceEmailProviderStatusFromConfig,
  isManagedEmailProviderPending,
  type WorkspaceEmailProviderConfig,
  type WorkspaceEmailProviderRow,
  type WorkspaceEmailProviderStatus,
} from "@/lib/email/provider-config";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  EmailCredentials,
  EmailSource,
  EmailSourceVerificationStatus,
  Source,
} from "@icecore/shared/types/sources";
import { isEmailSource } from "@icecore/shared/types/sources";
import {
  asNullableRecord,
  readStringField,
} from "@icecore/shared/lib/value-utils";
import { normalizeCampaignEmail } from "@/lib/campaign/campaign-recipient-utils";

export type WorkspaceEmailSourceLookupResult =
  | {
      ok: true;
      source: EmailSource | null;
    }
  | {
      ok: false;
      error: unknown;
    };

export type EmailProviderForWorkspaceSourceLookupResult =
  | {
      ok: true;
      providerConfig: WorkspaceEmailProviderConfig | null;
    }
  | {
      ok: false;
      error: unknown;
    };

function credentialString(
  credentials: EmailCredentials | Record<string, unknown> | null | undefined,
  key: keyof EmailCredentials
): string {
  return readStringField(asNullableRecord(credentials), key, { trim: true });
}

function readAddressIds(
  credentials: EmailCredentials | Record<string, unknown> | null | undefined
): string[] {
  if (!credentials || typeof credentials !== "object") return [];
  const value = credentials.address_ids;
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || "").trim())
    .filter(item => item.length > 0);
}

export function parseEmailSourceCredentials(
  credentials: Source["credentials"] | null | undefined
): EmailCredentials | null {
  if (!credentials || typeof credentials !== "object") return null;
  return credentials as EmailCredentials;
}

export function buildEmailSourceCredentials(params: {
  emailAddress: string;
  providerId?: string | null;
  providerStatus?: "active" | "inactive";
  verificationStatus?: EmailSourceVerificationStatus;
  status?: "active" | "inactive";
  addressIds?: string[];
  postmarkStreamOutbound?: string;
  connectedAt?: string;
}): EmailCredentials {
  return {
    email_address: normalizeCampaignEmail(params.emailAddress),
    provider: "postmark",
    provider_id: String(params.providerId || "").trim(),
    provider_status: params.providerStatus || "inactive",
    verification_status: params.verificationStatus || "disconnected",
    status: params.status || "inactive",
    address_ids: params.addressIds || [],
    postmark_stream_outbound: params.postmarkStreamOutbound || "outbound",
    connected_at: params.connectedAt || new Date().toISOString(),
  };
}

export function isEmailSourceConfigured(
  source: Source | null | undefined
): boolean {
  if (!source || !isEmailSource(source)) return false;
  const credentials = parseEmailSourceCredentials(source.credentials);
  if (!credentials) return false;
  if (credentials.status !== "active") return false;
  if (!normalizeCampaignEmail(credentials.email_address)) return false;
  return (
    credentials.verification_status === "connected" ||
    Boolean(credentials.provider_id)
  );
}

export async function getWorkspaceEmailSourceResult(
  workspaceId: string
): Promise<WorkspaceEmailSourceLookupResult> {
  try {
    const { data, error } = await supabaseAdmin
      .from("sources")
      .select(
        "id, company_id, workspace_id, type, name, credentials, created_at, updated_at"
      )
      .eq("workspace_id", workspaceId)
      .eq("type", "email")
      .maybeSingle();

    if (error) {
      return { ok: false, error };
    }

    return {
      ok: true,
      source: data ? (data as EmailSource) : null,
    };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function getWorkspaceEmailSource(
  workspaceId: string
): Promise<EmailSource | null> {
  const result = await getWorkspaceEmailSourceResult(workspaceId);
  return result.ok ? result.source : null;
}

async function getWorkspaceCompanyId(
  workspaceId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .maybeSingle();

  if (error || !data?.company_id) {
    return null;
  }

  return String(data.company_id);
}

async function listActiveWorkspaceEmailAddressIds(
  workspaceId: string
): Promise<{ ids: string[]; primaryAddress: string }> {
  const { data, error } = await supabaseAdmin
    .from("workspace_email_addresses")
    .select("id, full_address")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (error || !data?.length) {
    return { ids: [], primaryAddress: "" };
  }

  return {
    ids: data.map(row => String(row.id)),
    primaryAddress: normalizeCampaignEmail(data[0]?.full_address),
  };
}

function deriveVerificationStatusFromProvider(
  providerRow: WorkspaceEmailProviderRow | null,
  providerConfig: WorkspaceEmailProviderConfig | null
): EmailSourceVerificationStatus {
  if (!providerRow || !providerConfig) return "disconnected";
  const providerStatus =
    getWorkspaceEmailProviderStatusFromConfig(providerConfig);
  if (providerStatus === "connected") return "connected";
  if (providerStatus === "pending_dns") return "pending_dns";
  return "disconnected";
}

function deriveSourceStatus(params: {
  providerStatus?: "active" | "inactive";
  addressCount: number;
}): "active" | "inactive" {
  if (params.providerStatus === "active") return "active";
  if (params.addressCount > 0) return "active";
  return "inactive";
}

export async function upsertWorkspaceEmailSourceFromProvider(
  workspaceId: string,
  providerRow?: WorkspaceEmailProviderRow | null,
  providerConfig?: WorkspaceEmailProviderConfig | null
): Promise<EmailSource | null> {
  const [resolvedProviderRow, resolvedProviderConfig, companyId, addresses] =
    await Promise.all([
      providerRow
        ? Promise.resolve(providerRow)
        : getWorkspaceEmailProviderRow(workspaceId, true),
      providerConfig
        ? Promise.resolve(providerConfig)
        : getWorkspaceEmailProviderConfig(workspaceId, true),
      getWorkspaceCompanyId(workspaceId),
      listActiveWorkspaceEmailAddressIds(workspaceId),
    ]);

  if (!companyId) {
    return null;
  }

  const existing = await getWorkspaceEmailSource(workspaceId);
  const emailAddress =
    normalizeCampaignEmail(resolvedProviderRow?.default_from_address) ||
    addresses.primaryAddress ||
    credentialString(existing?.credentials, "email_address");

  if (!emailAddress && !resolvedProviderRow && addresses.ids.length === 0) {
    return existing;
  }

  const credentials = buildEmailSourceCredentials({
    emailAddress,
    providerId: resolvedProviderRow?.id,
    providerStatus: resolvedProviderRow?.status || "inactive",
    verificationStatus: deriveVerificationStatusFromProvider(
      resolvedProviderRow,
      resolvedProviderConfig
    ),
    status: deriveSourceStatus({
      providerStatus: resolvedProviderRow?.status,
      addressCount: addresses.ids.length,
    }),
    addressIds: addresses.ids,
    postmarkStreamOutbound:
      resolvedProviderRow?.transactional_stream || "outbound",
    connectedAt:
      existing?.credentials?.connected_at || new Date().toISOString(),
  });

  const payload = {
    company_id: companyId,
    workspace_id: workspaceId,
    type: "email" as const,
    name: "Email",
    credentials,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("sources")
      .update(payload)
      .eq("id", existing.id)
      .select(
        "id, company_id, workspace_id, type, name, credentials, created_at, updated_at"
      )
      .single();

    if (error || !data) {
      return null;
    }

    return data as EmailSource;
  }

  const { data, error } = await supabaseAdmin
    .from("sources")
    .insert({
      ...payload,
      created_at: new Date().toISOString(),
    })
    .select(
      "id, company_id, workspace_id, type, name, credentials, created_at, updated_at"
    )
    .single();

  if (error || !data) {
    return null;
  }

  return data as EmailSource;
}

export async function syncWorkspaceEmailSourceAddresses(
  workspaceId: string
): Promise<EmailSource | null> {
  const [existing, providerRow, providerConfig, addresses] = await Promise.all([
    getWorkspaceEmailSource(workspaceId),
    getWorkspaceEmailProviderRow(workspaceId, true),
    getWorkspaceEmailProviderConfig(workspaceId, true),
    listActiveWorkspaceEmailAddressIds(workspaceId),
  ]);

  if (!existing && !providerRow && addresses.ids.length === 0) {
    return null;
  }

  return upsertWorkspaceEmailSourceFromProvider(
    workspaceId,
    providerRow,
    providerConfig
  );
}

export async function resolveEmailProviderForWorkspaceSource(
  source: EmailSource | null | undefined
): Promise<WorkspaceEmailProviderConfig | null> {
  if (!source || !isEmailSource(source)) return null;

  const credentials = parseEmailSourceCredentials(source.credentials);
  const providerId = credentialString(credentials, "provider_id");
  if (providerId) {
    const providerConfig = await getWorkspaceEmailProviderConfig(
      source.workspace_id || "",
      true
    );
    if (providerConfig?.id === providerId) {
      return providerConfig;
    }
  }

  return getWorkspaceEmailProviderConfig(source.workspace_id || "", true);
}

export async function resolveEmailProviderForWorkspaceSourceResult(
  source: EmailSource | null | undefined
): Promise<EmailProviderForWorkspaceSourceLookupResult> {
  if (!source || !isEmailSource(source)) {
    return { ok: true, providerConfig: null };
  }

  const result = await getWorkspaceEmailProviderConfigResult(
    source.workspace_id || "",
    true
  );
  return result;
}

export async function isWorkspaceEmailSourceEnabled(
  workspaceId: string
): Promise<boolean> {
  const source = await getWorkspaceEmailSource(workspaceId);
  if (!isEmailSourceConfigured(source)) {
    const providerConfig = await getWorkspaceEmailProviderConfig(
      workspaceId,
      true
    );
    return providerConfig?.status === "active";
  }

  const providerConfig = await resolveEmailProviderForWorkspaceSource(source);
  if (!providerConfig) return false;
  if (providerConfig.status !== "active") return false;
  if (isManagedEmailProviderPending(providerConfig)) return false;
  return true;
}

export function getEmailSourceConnectionStatus(
  source: EmailSource | null | undefined,
  providerStatus: WorkspaceEmailProviderStatus
): {
  connected: boolean;
  verificationStatus: EmailSourceVerificationStatus;
  activeAddressCount: number;
} {
  const credentials = parseEmailSourceCredentials(source?.credentials);
  const verificationStatus =
    credentials?.verification_status ||
    (providerStatus === "connected"
      ? "connected"
      : providerStatus === "pending_dns"
        ? "pending_dns"
        : "disconnected");

  return {
    connected:
      isEmailSourceConfigured(source) && providerStatus === "connected",
    verificationStatus,
    activeAddressCount: readAddressIds(credentials).length,
  };
}

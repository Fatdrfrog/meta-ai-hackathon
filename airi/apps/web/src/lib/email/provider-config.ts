import { decryptMaybeString, encryptString } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { randomBytes } from "crypto";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import { normalizeCampaignEmail } from "@/lib/campaign/campaign-recipient-utils";

export type EmailProviderKind = "postmark";
export type EmailProviderMode = "manual" | "platform_managed";
export type EmailProviderVerificationStatus =
  | "disconnected"
  | "pending_dns"
  | "verified"
  | "error";
export type WorkspaceEmailProviderStatus =
  | "disconnected"
  | "pending_dns"
  | "connected";

export type PostmarkManagedDnsState = {
  dkimHost: string;
  dkimValue: string;
  returnPathHost: string;
  returnPathValue: string;
  spfHost?: string;
  spfValue?: string;
};

export type PostmarkManagedState = {
  serverId: number;
  serverName: string;
  domainId: number;
  domain: string;
  dkimVerified: boolean;
  returnPathVerified: boolean;
  verificationStatus: "pending_dns" | "verified" | "error";
  dns: PostmarkManagedDnsState;
  webhookId?: number;
  lastCheckedAt?: string;
  lastError?: string;
};

export type WorkspaceEmailProviderRow = {
  id: string;
  workspace_id: string;
  provider: EmailProviderKind;
  postmark_server_token: unknown;
  transactional_stream: string;
  broadcast_stream: string;
  default_from_address: string;
  webhook_token: string;
  postmark_managed_state?: unknown;
  status: "active" | "inactive";
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type WorkspaceEmailProviderConfig = {
  id: string;
  workspaceId: string;
  provider: EmailProviderKind;
  postmarkServerToken: string;
  transactionalStream: string;
  broadcastStream: string;
  defaultFromAddress: string;
  webhookToken: string;
  mode: EmailProviderMode;
  verificationStatus: EmailProviderVerificationStatus;
  managedState: PostmarkManagedState | null;
  status: "active" | "inactive";
};

export type WorkspaceEmailProviderRowLookupResult =
  | {
      ok: true;
      row: WorkspaceEmailProviderRow | null;
    }
  | {
      ok: false;
      error: unknown;
    };

export type WorkspaceEmailProviderConfigLookupResult =
  | {
      ok: true;
      providerConfig: WorkspaceEmailProviderConfig | null;
    }
  | {
      ok: false;
      error: unknown;
    };

type UpsertProviderResult =
  | { ok: true; config: WorkspaceEmailProviderConfig }
  | { ok: false; error: string };

type UpsertProviderBaseParams = {
  workspaceId: string;
  createdBy: string;
  postmarkServerToken?: string;
  transactionalStream?: string;
  broadcastStream?: string;
  defaultFromAddress: string;
  webhookToken?: string;
  status?: WorkspaceEmailProviderRow["status"];
  mode?: EmailProviderMode;
  postmarkManagedState?: PostmarkManagedState | null;
};

function normalizeStream(input: string | null | undefined, fallback: string) {
  const raw = String(input || "").trim();
  return raw.length > 0 ? raw : fallback;
}

function asString(value: unknown): string | null {
  const text = String(value || "").trim();
  return text.length > 0 ? text : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return fallback;
}

function normalizeManagedVerificationStatus(
  value: unknown
): PostmarkManagedState["verificationStatus"] {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (raw === "verified") return "verified";
  if (raw === "error") return "error";
  return "pending_dns";
}

function parsePostmarkManagedState(
  value: unknown
): PostmarkManagedState | null {
  const root = asNullableRecord(value);
  if (!root) return null;

  const serverId = asNumber(root.serverId);
  const serverName = asString(root.serverName);
  const domainId = asNumber(root.domainId);
  const domain = asString(root.domain);
  const dns = asNullableRecord(root.dns);

  if (!serverId || !serverName || !domainId || !domain || !dns) {
    return null;
  }

  const dkimHost = asString(dns.dkimHost);
  const dkimValue = asString(dns.dkimValue);
  const returnPathHost = asString(dns.returnPathHost);
  const returnPathValue = asString(dns.returnPathValue);

  if (!dkimHost || !dkimValue || !returnPathHost || !returnPathValue) {
    return null;
  }

  const spfHost = asString(dns.spfHost) || undefined;
  const spfValue = asString(dns.spfValue) || undefined;
  const webhookId = asNumber(root.webhookId) || undefined;
  const lastCheckedAt = asString(root.lastCheckedAt) || undefined;
  const lastError = asString(root.lastError) || undefined;

  return {
    serverId,
    serverName,
    domainId,
    domain: domain.toLowerCase(),
    dkimVerified: asBoolean(root.dkimVerified),
    returnPathVerified: asBoolean(root.returnPathVerified),
    verificationStatus: normalizeManagedVerificationStatus(
      root.verificationStatus
    ),
    dns: {
      dkimHost,
      dkimValue,
      returnPathHost,
      returnPathValue,
      ...(spfHost ? { spfHost } : {}),
      ...(spfValue ? { spfValue } : {}),
    },
    ...(webhookId ? { webhookId } : {}),
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function resolveVerificationStatus(params: {
  mode: EmailProviderMode;
  rowStatus: WorkspaceEmailProviderRow["status"];
  managedState: PostmarkManagedState | null;
}): EmailProviderVerificationStatus {
  if (params.mode === "platform_managed") {
    if (!params.managedState) return "pending_dns";
    return params.managedState.verificationStatus;
  }
  return params.rowStatus === "active" ? "verified" : "disconnected";
}

function mapRowToConfig(
  row: WorkspaceEmailProviderRow
): WorkspaceEmailProviderConfig {
  const managedState = parsePostmarkManagedState(row.postmark_managed_state);
  const mode: EmailProviderMode = managedState ? "platform_managed" : "manual";

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    postmarkServerToken: decryptMaybeString(row.postmark_server_token),
    transactionalStream: normalizeStream(row.transactional_stream, "outbound"),
    broadcastStream: normalizeStream(row.broadcast_stream, "broadcast"),
    defaultFromAddress: normalizeCampaignEmail(row.default_from_address),
    webhookToken: String(row.webhook_token || ""),
    mode,
    managedState,
    verificationStatus: resolveVerificationStatus({
      mode,
      rowStatus: row.status,
      managedState,
    }),
    status: row.status,
  };
}

export async function getWorkspaceEmailProviderRowResult(
  workspaceId: string,
  includeInactive = false
): Promise<WorkspaceEmailProviderRowLookupResult> {
  try {
    let query = supabaseAdmin
      .from("workspace_email_providers")
      .select(
        "id, workspace_id, provider, postmark_server_token, transactional_stream, broadcast_stream, default_from_address, webhook_token, postmark_managed_state, status, created_by, created_at, updated_at"
      )
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (!includeInactive) {
      query = query.eq("status", "active");
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      return { ok: false, error };
    }

    return {
      ok: true,
      row: data ? (data as WorkspaceEmailProviderRow) : null,
    };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function getWorkspaceEmailProviderRow(
  workspaceId: string,
  includeInactive = false
): Promise<WorkspaceEmailProviderRow | null> {
  const result = await getWorkspaceEmailProviderRowResult(
    workspaceId,
    includeInactive
  );
  return result.ok ? result.row : null;
}

export async function getWorkspaceEmailProviderConfigResult(
  workspaceId: string,
  includeInactive = false
): Promise<WorkspaceEmailProviderConfigLookupResult> {
  const rowResult = await getWorkspaceEmailProviderRowResult(
    workspaceId,
    includeInactive
  );
  if (!rowResult.ok) return rowResult;
  if (!rowResult.row) {
    return { ok: true, providerConfig: null };
  }
  const config = mapRowToConfig(rowResult.row);
  return {
    ok: true,
    providerConfig: config.postmarkServerToken ? config : null,
  };
}

export async function getWorkspaceEmailProviderConfig(
  workspaceId: string,
  includeInactive = false
): Promise<WorkspaceEmailProviderConfig | null> {
  const result = await getWorkspaceEmailProviderConfigResult(
    workspaceId,
    includeInactive
  );
  return result.ok ? result.providerConfig : null;
}

export function getWorkspaceEmailProviderStatusFromConfig(
  config: WorkspaceEmailProviderConfig | null
): WorkspaceEmailProviderStatus {
  if (!config) return "disconnected";
  if (config.mode === "platform_managed") {
    return config.status === "active" ? "connected" : "pending_dns";
  }
  return config.status === "active" ? "connected" : "disconnected";
}

export async function getWorkspaceEmailProviderStatus(
  workspaceId: string
): Promise<WorkspaceEmailProviderStatus> {
  const config = await getWorkspaceEmailProviderConfig(workspaceId, true);
  return getWorkspaceEmailProviderStatusFromConfig(config);
}

export function isManagedEmailProviderPending(
  config: WorkspaceEmailProviderConfig | null
): boolean {
  if (!config) return false;
  return config.mode === "platform_managed" && config.status !== "active";
}

export function generateWebhookToken(): string {
  return randomBytes(18).toString("base64url");
}

async function upsertWorkspaceEmailProviderInternal(
  params: UpsertProviderBaseParams
): Promise<UpsertProviderResult> {
  const token = String(params.postmarkServerToken || "").trim();
  const defaultFromAddress = normalizeCampaignEmail(params.defaultFromAddress);

  if (!defaultFromAddress) {
    return { ok: false, error: "defaultFromAddress is required" };
  }

  const existingRow = await getWorkspaceEmailProviderRow(
    params.workspaceId,
    true
  );

  const broadcastStream =
    params.broadcastStream !== undefined
      ? normalizeStream(params.broadcastStream, "broadcast")
      : existingRow
        ? normalizeStream(existingRow.broadcast_stream, "broadcast")
        : "broadcast";

  const transactionalStream =
    params.transactionalStream !== undefined
      ? normalizeStream(params.transactionalStream, "outbound")
      : existingRow
        ? normalizeStream(existingRow.transactional_stream, "outbound")
        : "outbound";

  const webhookToken =
    params.webhookToken !== undefined && params.webhookToken.trim()
      ? String(params.webhookToken).trim()
      : existingRow?.webhook_token
        ? String(existingRow.webhook_token)
        : generateWebhookToken();

  const status: WorkspaceEmailProviderRow["status"] = params.status || "active";

  let managedStatePayload: unknown =
    existingRow?.postmark_managed_state ?? null;
  if (params.mode === "manual") {
    managedStatePayload = null;
  } else if (params.postmarkManagedState !== undefined) {
    managedStatePayload = params.postmarkManagedState;
  }

  let tokenPayload: unknown;
  if (token) {
    tokenPayload = encryptString(token);
  } else if (existingRow?.postmark_server_token) {
    tokenPayload = existingRow.postmark_server_token;
  } else {
    return { ok: false, error: "postmarkServerToken is required" };
  }

  const { data, error } = await supabaseAdmin
    .from("workspace_email_providers")
    .upsert(
      {
        workspace_id: params.workspaceId,
        provider: "postmark",
        postmark_server_token: tokenPayload,
        transactional_stream: transactionalStream,
        broadcast_stream: broadcastStream,
        default_from_address: defaultFromAddress,
        webhook_token: webhookToken,
        postmark_managed_state: managedStatePayload,
        status,
        created_by: params.createdBy,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "workspace_id",
      }
    )
    .select(
      "id, workspace_id, provider, postmark_server_token, transactional_stream, broadcast_stream, default_from_address, webhook_token, postmark_managed_state, status, created_by, created_at, updated_at"
    )
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: error?.message || "Failed to upsert workspace email provider",
    };
  }

  const config = mapRowToConfig(data as WorkspaceEmailProviderRow);
  if (!config.postmarkServerToken) {
    return {
      ok: false,
      error: "Stored provider token could not be decrypted",
    };
  }

  return { ok: true, config };
}

export async function upsertWorkspaceEmailProviderConfig(
  params: Omit<UpsertProviderBaseParams, "status" | "postmarkManagedState"> & {
    mode?: "manual";
  }
): Promise<UpsertProviderResult> {
  return upsertWorkspaceEmailProviderInternal({
    ...params,
    mode: "manual",
    status: "active",
    postmarkManagedState: null,
  });
}

export async function upsertWorkspaceManagedEmailProviderConfig(
  params: Omit<UpsertProviderBaseParams, "mode"> & {
    postmarkManagedState: PostmarkManagedState;
  }
): Promise<UpsertProviderResult> {
  return upsertWorkspaceEmailProviderInternal({
    ...params,
    mode: "platform_managed",
  });
}

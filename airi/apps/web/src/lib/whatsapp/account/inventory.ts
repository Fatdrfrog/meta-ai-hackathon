import { supabaseAdmin } from "@/lib/supabase/admin";
import { compactWhatsAppAccountString } from "@icecore/shared/lib/whatsapp/account-identifiers";
import "server-only";
import {
  asRecord,
  readUniqueStringArray as uniqueStrings,
} from "@icecore/shared/lib/value-utils";

type SupabaseMaybeError = {
  code?: string;
  message?: string;
};

export type WhatsAppPhoneOwner = {
  phoneNumberId: string;
  sourceId: string;
  workspaceId: string;
  workspaceName?: string;
  companyId?: string | null;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  observedAt?: string | null;
};

export type WhatsAppPhoneOwnershipStatus =
  | "available"
  | "current_workspace"
  | "other_workspace";

export type WhatsAppPhoneOwnership = {
  status: WhatsAppPhoneOwnershipStatus;
  source_id?: string;
  workspace_id?: string;
  workspace_name?: string;
};

function isMissingAccountTableError(error: unknown): boolean {
  const code = (error as SupabaseMaybeError | null)?.code;
  const message = (error as SupabaseMaybeError | null)?.message || "";
  return code === "42P01" || message.includes("whatsapp_accounts");
}

async function hydrateWorkspaceNames(
  owners: WhatsAppPhoneOwner[]
): Promise<WhatsAppPhoneOwner[]> {
  const workspaceIds = uniqueStrings(owners.map(owner => owner.workspaceId));
  if (workspaceIds.length === 0) return owners;

  const { data, error } = await supabaseAdmin
    .from("workspaces")
    .select("id, name")
    .in("id", workspaceIds);

  if (error || !Array.isArray(data)) return owners;

  const names = new Map<string, string>();
  for (const row of data as Array<{ id?: unknown; name?: unknown }>) {
    const id = compactWhatsAppAccountString(row.id);
    const name = compactWhatsAppAccountString(row.name);
    if (id && name) names.set(id, name);
  }

  return owners.map(owner => ({
    ...owner,
    workspaceName: names.get(owner.workspaceId) || owner.workspaceName,
  }));
}

async function listOwnersFromAccountTable(params: {
  companyId: string;
  phoneNumberIds: string[];
}): Promise<WhatsAppPhoneOwner[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_accounts")
      .select(
        "source_id, workspace_id, company_id, phone_number_id, display_phone_number, verified_name, last_observed_at"
      )
      .eq("company_id", params.companyId)
      .eq("connection_status", "active")
      .in("phone_number_id", params.phoneNumberIds)
      .order("last_observed_at", { ascending: false });

    if (error) {
      if (isMissingAccountTableError(error)) return [];
      return [];
    }

    return (Array.isArray(data) ? data : [])
      .map((row): WhatsAppPhoneOwner | null => {
        const record = asRecord(row);
        const phoneNumberId = compactWhatsAppAccountString(
          record.phone_number_id
        );
        const sourceId = compactWhatsAppAccountString(record.source_id);
        const workspaceId = compactWhatsAppAccountString(record.workspace_id);
        if (!phoneNumberId || !sourceId || !workspaceId) return null;

        return {
          phoneNumberId,
          sourceId,
          workspaceId,
          companyId: compactWhatsAppAccountString(record.company_id) || null,
          displayPhoneNumber:
            compactWhatsAppAccountString(record.display_phone_number) || null,
          verifiedName:
            compactWhatsAppAccountString(record.verified_name) || null,
          observedAt:
            compactWhatsAppAccountString(record.last_observed_at) || null,
        };
      })
      .filter((owner): owner is WhatsAppPhoneOwner => Boolean(owner));
  } catch (error) {
    if (isMissingAccountTableError(error)) return [];
    return [];
  }
}

async function listOwnersFromSources(params: {
  companyId: string;
  phoneNumberIds: string[];
}): Promise<WhatsAppPhoneOwner[]> {
  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("id, workspace_id, company_id, credentials, name")
    .eq("type", "whatsapp")
    .eq("company_id", params.companyId);

  if (error || !Array.isArray(data)) return [];

  const phoneSet = new Set(params.phoneNumberIds);
  return data
    .map((row): WhatsAppPhoneOwner | null => {
      const record = asRecord(row);
      const credentials = asRecord(record.credentials);
      const phoneNumberId = compactWhatsAppAccountString(
        credentials.phone_number_id
      );
      const sourceId = compactWhatsAppAccountString(record.id);
      const workspaceId = compactWhatsAppAccountString(record.workspace_id);
      if (!phoneNumberId || !phoneSet.has(phoneNumberId)) return null;
      if (!sourceId || !workspaceId) return null;

      return {
        phoneNumberId,
        sourceId,
        workspaceId,
        companyId: compactWhatsAppAccountString(record.company_id) || null,
        displayPhoneNumber:
          compactWhatsAppAccountString(credentials.display_phone_number) ||
          null,
        verifiedName:
          compactWhatsAppAccountString(credentials.verified_name) || null,
      };
    })
    .filter((owner): owner is WhatsAppPhoneOwner => Boolean(owner));
}

export async function listWhatsAppPhoneOwnersForCompany(params: {
  companyId: string;
  phoneNumberIds: string[];
}): Promise<Map<string, WhatsAppPhoneOwner[]>> {
  const companyId = compactWhatsAppAccountString(params.companyId);
  const phoneNumberIds = uniqueStrings(params.phoneNumberIds);
  const ownersByPhone = new Map<string, WhatsAppPhoneOwner[]>();
  if (!companyId || phoneNumberIds.length === 0) return ownersByPhone;

  const [accountOwners, sourceOwners] = await Promise.all([
    listOwnersFromAccountTable({ companyId, phoneNumberIds }),
    listOwnersFromSources({ companyId, phoneNumberIds }),
  ]);

  const seen = new Set<string>();
  const owners = await hydrateWorkspaceNames([
    ...accountOwners,
    ...sourceOwners,
  ]);
  for (const owner of owners) {
    const signature = `${owner.phoneNumberId}:${owner.sourceId}:${owner.workspaceId}`;
    if (seen.has(signature)) continue;
    seen.add(signature);

    const current = ownersByPhone.get(owner.phoneNumberId) || [];
    current.push(owner);
    ownersByPhone.set(owner.phoneNumberId, current);
  }

  return ownersByPhone;
}

export async function findWhatsAppPhoneOwner(params: {
  companyId: string;
  phoneNumberId: string;
  currentWorkspaceId?: string | null;
  currentSourceId?: string | null;
}): Promise<WhatsAppPhoneOwner | null> {
  const phoneNumberId = compactWhatsAppAccountString(params.phoneNumberId);
  if (!phoneNumberId) return null;

  const owners = await listWhatsAppPhoneOwnersForCompany({
    companyId: params.companyId,
    phoneNumberIds: [phoneNumberId],
  });
  const phoneOwners = owners.get(phoneNumberId) || [];
  const currentWorkspaceId = compactWhatsAppAccountString(
    params.currentWorkspaceId
  );
  const currentSourceId = compactWhatsAppAccountString(params.currentSourceId);

  return (
    phoneOwners.find(owner => {
      if (currentSourceId && owner.sourceId === currentSourceId) return false;
      if (currentWorkspaceId && owner.workspaceId === currentWorkspaceId) {
        return false;
      }
      return true;
    }) || null
  );
}

export function buildWhatsAppPhoneOwnership(params: {
  owner?: WhatsAppPhoneOwner | null;
  currentWorkspaceId?: string | null;
}): WhatsAppPhoneOwnership {
  const owner = params.owner;
  if (!owner) return { status: "available" };

  const currentWorkspaceId = compactWhatsAppAccountString(
    params.currentWorkspaceId
  );
  const status =
    currentWorkspaceId && owner.workspaceId === currentWorkspaceId
      ? "current_workspace"
      : "other_workspace";

  return {
    status,
    source_id: owner.sourceId,
    workspace_id: owner.workspaceId,
    workspace_name: owner.workspaceName,
  };
}

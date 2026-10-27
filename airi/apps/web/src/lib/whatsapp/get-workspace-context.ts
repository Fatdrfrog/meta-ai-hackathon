import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import {
  normalizeWhatsAppCredentials,
  type NormalizedWhatsAppCredentials,
} from "@/lib/whatsapp/credentials";

import { NextResponse } from "next/server";

/** Authorization messages for template changes. */
export const WHATSAPP_TEMPLATE_MANAGER_ONLY = {
  create: "Only managers and admins can create templates",
  update: "Only managers and admins can update templates",
  delete: "Only managers and admins can delete templates",
} as const;

type AuthenticatedUser = {
  id: string;
};

type WorkspaceMembership = {
  role?: string | null;
};

export type WhatsAppWorkspaceContextOptions = {
  managerErrorMessage?: string;
  sourceId?: string;
  requireCredentials?: boolean;
  requireManager?: boolean;
  requirePhoneNumber?: boolean;
};

export type WhatsAppWorkspaceContext = {
  accessToken?: string;
  credentials: NormalizedWhatsAppCredentials;
  membership: WorkspaceMembership;
  phoneNumberId?: string;
  rawCredentials?: unknown;
  sourceId?: string;
  user: AuthenticatedUser;
  wabaId?: string;
};

export type WhatsAppFlowReadiness = {
  accessToken?: string;
  error?: NextResponse;
  phoneNumberId?: string;
  sourceId?: string;
  readiness?: {
    hasWabaId: boolean;
    hasMessagingAccountId: boolean;
    hasWaacId: boolean;
    hasPhoneNumberId: boolean;
    hasCsId: boolean;
    hasAccessToken: boolean;
    legacyOnlyAccountIds: boolean;
  };
  wabaId?: string;
};

export async function getWhatsAppWorkspaceContext(
  workspaceId: string,
  options: WhatsAppWorkspaceContextOptions = {}
): Promise<
  | { context: WhatsAppWorkspaceContext; error?: undefined }
  | { context?: undefined; error: NextResponse }
> {
  const access = await getAuthenticatedWorkspaceMembership(workspaceId);
  if (access.error) return { error: access.error };

  if (
    options.requireManager &&
    !isWorkspaceManagerRole(access.membership.role)
  ) {
    return {
      error: NextResponse.json(
        {
          error:
            options.managerErrorMessage ||
            "Only managers and admins can perform this action",
        },
        { status: 403 }
      ),
    };
  }

  let sourceQuery = access.supabase
    .from("sources")
    .select("id, workspace_id, type, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp");
  sourceQuery = options.sourceId
    ? sourceQuery.eq("id", options.sourceId)
    : sourceQuery.order("created_at", { ascending: false }).limit(1);

  const { data: source, error: sourceError } = await sourceQuery.maybeSingle();
  if (sourceError) {
    return {
      error: NextResponse.json(
        { error: "Failed to query WhatsApp source" },
        { status: 500 }
      ),
    };
  }

  const sourceRecord = source as {
    id?: unknown;
    workspace_id?: unknown;
    type?: unknown;
    credentials?: unknown;
  } | null;
  if (
    sourceRecord &&
    typeof sourceRecord.workspace_id === "string" &&
    sourceRecord.workspace_id !== workspaceId
  ) {
    return {
      error: NextResponse.json(
        { error: "WhatsApp source does not belong to this workspace" },
        { status: 403 }
      ),
    };
  }
  if (
    sourceRecord &&
    (sourceRecord.type !== "whatsapp" ||
      (options.sourceId && sourceRecord.id !== options.sourceId))
  ) {
    return {
      error: NextResponse.json(
        { error: "WhatsApp source not found" },
        { status: 404 }
      ),
    };
  }

  const requireCredentials = options.requireCredentials !== false;
  if (
    (!sourceRecord || !sourceRecord.credentials) &&
    (options.sourceId || requireCredentials)
  ) {
    return {
      error: NextResponse.json(
        { error: "WhatsApp credentials not found" },
        { status: 404 }
      ),
    };
  }

  const credentials = normalizeWhatsAppCredentials(sourceRecord?.credentials);
  if (requireCredentials && (!credentials.wabaId || !credentials.accessToken)) {
    return {
      error: NextResponse.json(
        { error: "WhatsApp credentials incomplete" },
        { status: 500 }
      ),
    };
  }

  if (options.requirePhoneNumber && !credentials.phoneNumberId) {
    return {
      error: NextResponse.json(
        { error: "WhatsApp phone number ID is missing" },
        { status: 500 }
      ),
    };
  }

  return {
    context: {
      accessToken: credentials.accessToken,
      credentials,
      membership: access.membership,
      phoneNumberId: credentials.phoneNumberId,
      rawCredentials: sourceRecord?.credentials,
      sourceId:
        typeof sourceRecord?.id === "string" ? sourceRecord.id : undefined,
      user: access.user,
      wabaId: credentials.wabaId,
    },
  };
}

export async function getWhatsAppWorkspaceReadiness(
  workspaceId: string,
  options: { sourceId?: string } = {}
): Promise<WhatsAppFlowReadiness> {
  const result = await getWhatsAppWorkspaceContext(workspaceId, {
    requireCredentials: false,
    sourceId: options.sourceId,
  });
  if (result.error) return { error: result.error };

  const { credentials } = result.context;
  return {
    accessToken: credentials.accessToken,
    phoneNumberId: credentials.phoneNumberId,
    sourceId: result.context.sourceId,
    readiness: {
      hasWabaId: Boolean(credentials.wabaId),
      hasMessagingAccountId: Boolean(credentials.messagingAccountId),
      hasWaacId: Boolean(credentials.waacId),
      hasPhoneNumberId: Boolean(credentials.phoneNumberId),
      hasCsId: Boolean(credentials.csId),
      hasAccessToken: Boolean(credentials.accessToken),
      legacyOnlyAccountIds: Boolean(
        credentials.wabaId && !credentials.waacId && !credentials.csId
      ),
    },
    wabaId: credentials.wabaId,
  };
}

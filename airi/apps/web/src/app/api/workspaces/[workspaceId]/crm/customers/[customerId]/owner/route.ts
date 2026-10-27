import { assignCustomerOwner } from "@/lib/crm/board";
import { logger } from "@/lib/logger";
import { getCompanyUserMembershipByUserWorkspace } from "@/lib/supabase/company-users";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

type Params = Promise<{ workspaceId: string; customerId: string }>;

type CrmOwnerUpdateRequest = {
  ownerUserId?: string | null;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId, customerId } = await params;

  try {
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const { supabase } = access;

    const flags = await getWorkspaceFeatureFlags(workspaceId, [
      "customer_identity",
    ]);
    if (!flags.customer_identity) {
      return NextResponse.json({ error: "Feature disabled" }, { status: 404 });
    }

    const body = (await request
      .json()
      .catch(() => ({}))) as CrmOwnerUpdateRequest | null;

    const nextOwnerUserId =
      typeof body?.ownerUserId === "string" ? body.ownerUserId.trim() : null;
    if (nextOwnerUserId) {
      const membership = await getCompanyUserMembershipByUserWorkspace(
        supabase,
        {
          user_id: nextOwnerUserId,
          workspace_id: workspaceId,
        }
      );
      if (membership.error) {
        return NextResponse.json(
          { error: "Failed to verify workspace membership" },
          { status: 500 }
        );
      }
      if (!membership.data?.id) {
        return NextResponse.json(
          { error: "Owner must be a workspace member" },
          { status: 400 }
        );
      }
    }

    const result = await assignCustomerOwner({
      workspaceId,
      customerId,
      ownerUserId: nextOwnerUserId,
      actor: {
        type: "manager",
        userId: access.userId,
        label: "crm_board",
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "CRM_OWNER_VALIDATION") {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid CRM owner update",
        },
        { status: 400 }
      );
    }

    logger.error("[CRM Customer Owner API] PATCH failed", error, {
      event: "crm.customer_owner.patch_failed",
      workspaceId,
      customerId,
    });
    return NextResponse.json(
      { error: "Failed to update customer owner" },
      { status: 500 }
    );
  }
}

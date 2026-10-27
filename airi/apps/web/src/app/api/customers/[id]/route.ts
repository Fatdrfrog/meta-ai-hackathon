import { getCustomerById } from "@/lib/customers/service";
import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { listWorkspaceMemberLabels } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { Conversation } from "@/models/conversation";
import Customer from "@/models/customer";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ id: string }>;

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await connectDB();

    const customer = await Customer.findById(id).select("workspaceId").lean<{
      workspaceId?: string;
    } | null>();

    if (!customer?.workspaceId) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404 }
      );
    }

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      customer.workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const flags = await getWorkspaceFeatureFlags(customer.workspaceId, [
      "customer_identity",
      "customer_behavioral_profile",
      "customer_timeline",
    ]);
    if (!flags.customer_identity) {
      return NextResponse.json({ error: "Feature disabled" }, { status: 404 });
    }

    const parsedLinkedLimit = Number.parseInt(
      request.nextUrl.searchParams.get("linkedLimit") || "12",
      10
    );
    const linkedLimit =
      Number.isFinite(parsedLinkedLimit) && parsedLinkedLimit > 0
        ? Math.min(parsedLinkedLimit, 50)
        : 12;

    const rawCustomer = (await getCustomerById({
      customerId: id,
      refreshBehavioralProfile: false,
    })) as {
      _id?: unknown;
      displayName?: string | null;
      status?: string;
      currentFunnelStage?: string | null;
      ownerUserId?: string | null;
      lastInteractionAt?: Date | null;
      profileSummary?: Record<string, unknown> | null;
      behavioralProfile?: Record<string, unknown> | null;
      conversationIds?: unknown[];
    } | null;

    if (!rawCustomer) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404 }
      );
    }

    const conversationIds = Array.isArray(rawCustomer.conversationIds)
      ? rawCustomer.conversationIds
      : [];
    const ownerUserId =
      typeof rawCustomer.ownerUserId === "string" &&
      rawCustomer.ownerUserId.trim()
        ? rawCustomer.ownerUserId.trim()
        : null;
    const members = await listWorkspaceMemberLabels(
      supabase,
      customer.workspaceId
    ).catch(() => []);
    const ownerLabel = ownerUserId
      ? members.find(member => member.userId === ownerUserId)?.label || null
      : null;
    const fullCustomer = {
      _id: String(rawCustomer._id || id),
      displayName: rawCustomer.displayName ?? null,
      status: rawCustomer.status ?? "active",
      currentFunnelStage: rawCustomer.currentFunnelStage ?? null,
      ownerUserId,
      ownerLabel,
      lastInteractionAt: rawCustomer.lastInteractionAt ?? null,
      profileSummary: rawCustomer.profileSummary ?? null,
      behavioralProfile: flags.customer_behavioral_profile
        ? (rawCustomer.behavioralProfile ?? null)
        : null,
    };
    const linkedConversations =
      conversationIds.length > 0
        ? await Conversation.find({
            _id: { $in: conversationIds },
          })
            .select(
              [
                "_id",
                "channel",
                "rename",
                "sourceId",
                "visitor_id",
                "page_url",
                "lastMessageAt",
                "createdAt",
                "updatedAt",
                "preferred_language",
                "status",
                "message_count",
                "classification",
                "internal_labels",
                "churn_risk_level",
                "estimated_customer_ltv",
                "history_summary",
                "airi_context_memory",
                "key_moments",
                "extracted_entities",
                "last_inbound_at",
                "last_outbound_at",
              ].join(" ")
            )
            .sort({ lastMessageAt: -1, updatedAt: -1 })
            .limit(linkedLimit)
            .lean()
        : [];

    return NextResponse.json({
      customer: fullCustomer,
      members,
      viewerUserId: user.id,
      linkedConversations,
      linkedConversationsTotal: conversationIds.length,
      flags,
    });
  } catch (error) {
    console.error("[Customers API] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load customer" },
      { status: 500 }
    );
  }
}

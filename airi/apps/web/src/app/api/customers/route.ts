import connectDB from "@/lib/mongoose";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { listWorkspaceMemberLabels } from "@/lib/supabase/company-users";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import Customer from "@/models/customer";
import { type FilterQuery, type SortOrder } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

const ALLOWED_SORT_FIELDS = [
  "lastInteractionAt",
  "displayName",
  "createdAt",
] as const;

type SortField = (typeof ALLOWED_SORT_FIELDS)[number];

function isSortField(value: string): value is SortField {
  return (ALLOWED_SORT_FIELDS as readonly string[]).includes(value);
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const workspaceId = searchParams.get("workspaceId");

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await connectDB();

    const flags = await getWorkspaceFeatureFlags(workspaceId, [
      "customer_identity",
    ]);
    if (!flags.customer_identity) {
      return NextResponse.json({ error: "Feature disabled" }, { status: 404 });
    }

    const search = searchParams.get("search") || "";
    const rawPage = parseInt(searchParams.get("page") || "1", 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const rawLimit = parseInt(searchParams.get("limit") || "50", 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
    const sortParam = searchParams.get("sort") || "lastInteractionAt";
    const sortField: SortField = isSortField(sortParam)
      ? sortParam
      : "lastInteractionAt";
    const order: SortOrder = searchParams.get("order") === "asc" ? 1 : -1;
    const statusParam = searchParams.get("status") || "active";
    const funnelStage = searchParams.get("funnelStage") || null;
    const ownerParam = searchParams.get("owner") || "";
    const ownerUserId =
      ownerParam === "me"
        ? user.id
        : ownerParam.trim() || null;

    const filter: FilterQuery<typeof Customer> = { workspaceId };

    if (statusParam !== "all") {
      filter.status = statusParam === "archived" ? "archived" : "active";
    }

    if (ownerUserId) {
      filter.ownerUserId = ownerUserId;
    }

    if (funnelStage) {
      filter.currentFunnelStage = funnelStage;
    }

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      filter.$or = [
        { displayName: { $regex: regex } },
        { "profileSummary.contactPoints.emails": { $regex: regex } },
        { "profileSummary.contactPoints.phones": { $regex: regex } },
        { "profileSummary.contactPoints.usernames": { $regex: regex } },
      ];
    }

    const skip = (page - 1) * limit;

    const [customers, totalCount, funnelStages, members] = await Promise.all([
      Customer.find(filter)
        .select(
          "_id displayName status currentFunnelStage ownerUserId lastInteractionAt createdAt profileSummary behavioralProfile"
        )
        .sort({ [sortField]: order })
        .skip(skip)
        .limit(limit)
        .lean(),
      Customer.countDocuments(filter),
      Customer.distinct("currentFunnelStage", {
        workspaceId,
        currentFunnelStage: { $ne: null },
      }),
      listWorkspaceMemberLabels(supabase, workspaceId).catch(
        () => [] as { userId: string; label: string }[]
      ),
    ]);

    const ownerLabels = new Map(
      members.map(member => [member.userId, member.label])
    );
    const totalPages = Math.ceil(totalCount / limit);

    return NextResponse.json({
      customers: customers.map((c: Record<string, unknown>) => {
        const ownerUserIdValue =
          typeof c.ownerUserId === "string" && c.ownerUserId.trim()
            ? c.ownerUserId.trim()
            : null;
        return {
          _id: String(c._id),
          displayName: c.displayName ?? null,
          status: c.status ?? "active",
          currentFunnelStage: c.currentFunnelStage ?? null,
          ownerUserId: ownerUserIdValue,
          ownerLabel: ownerUserIdValue
            ? ownerLabels.get(ownerUserIdValue) || null
            : null,
          lastInteractionAt: c.lastInteractionAt ?? null,
          createdAt: c.createdAt ?? null,
          profileSummary: c.profileSummary ?? null,
          behavioralProfile: c.behavioralProfile
            ? {
                status:
                  (c.behavioralProfile as Record<string, unknown>).status ??
                  null,
                summary:
                  (c.behavioralProfile as Record<string, unknown>).summary ??
                  null,
                communicationStyle:
                  (c.behavioralProfile as Record<string, unknown>)
                    .communicationStyle ?? null,
              }
            : null,
        };
      }),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      availableFunnelStages: funnelStages.filter(Boolean) as string[],
    });
  } catch (error) {
    logger.error("[Customers List API] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load customers" },
      { status: 500 }
    );
  }
}

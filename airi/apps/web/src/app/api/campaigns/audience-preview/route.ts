import { validateOptionalConversationChannelParam } from "@/lib/api/conversation-channel-query";
import connectDB from "@/lib/mongoose";
import { buildBirthdayAudiencePreview } from "@/lib/campaign/campaign-birthday-audience";
import { buildCampaignAudienceQueryWithFollowUpPrediction } from "@/lib/campaign/campaign-audience-follow-up";
import {
  buildCampaignAudienceQueryDefinition,
  collectCampaignIncomingNodeIdsFromSearchParams,
  collectCampaignSelectedConversationIdsFromSearchParams,
  FOLLOW_UP_AUDIENCE_CACHE_TTL_SECONDS,
  FOLLOW_UP_CAMPAIGN_AUDIENCE_ID_CAP,
  parseCampaignAudienceFilterParam,
  resolveFollowUpStatusesForBulkCampaign,
} from "@/lib/campaign/campaign-audience";
import {
  getIncomingCampaignNodeIds,
  type CampaignEdgeRecord,
} from "@/lib/campaign/campaign-runtime-utils";
import { createClient } from "@/lib/supabase/server";
import { Conversation } from "@/models/conversation";
import { Scenario } from "@/models/scenario";
import { NextResponse } from "next/server";
import { CAMPAIGN_BIRTHDAY_CONFIG_VERSION } from "@icecore/scenario-contracts";
import { Types } from "mongoose";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";
import { normalizeCampaignEmail } from "@/lib/campaign/campaign-recipient-utils";

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const category = searchParams.get("category");
    const internalLabel = searchParams.get("internalLabel");
    const channelParamCheck = validateOptionalConversationChannelParam(
      searchParams.get("channel")
    );
    if (!channelParamCheck.ok) {
      return channelParamCheck.response;
    }
    const channelParam = channelParamCheck.value ?? null;
    const templateCategory = searchParams.get("templateCategory");
    const targetingMode = searchParams.get("targetingMode");
    const scheduleType = searchParams.get("scheduleType");
    const delayDays = searchParams.get("delayDays");
    const timezone = searchParams.get("timezone") || "UTC";
    const scheduledForParam =
      searchParams.get("scheduledFor") || searchParams.get("previewDate");
    const recipientPhones = searchParams
      .get("recipientPhones")
      ?.split(",")
      .map(value => value.trim())
      .filter(Boolean);
    const recipientChatIds = searchParams
      .get("recipientChatIds")
      ?.split(",")
      .map(value => value.trim())
      .filter(Boolean);
    const telegramSourceId = searchParams.get("sourceId")?.trim() || null;
    const scenarioIdParam = searchParams.get("scenarioId");
    const scheduleIdParam = searchParams.get("scheduleId");
    const nodeId = searchParams.get("nodeId");
    const audienceFilter = parseCampaignAudienceFilterParam(
      searchParams.get("audienceFilter")
    );
    const followUpIncludeWaitingTimeout =
      searchParams.get("followUpIncludeWaitingTimeout") === "1" ||
      searchParams.get("followUpIncludeWaitingTimeout") === "true";
    const refreshFollowUpAudience =
      searchParams.get("refreshFollowUpAudience") === "1" ||
      searchParams.get("refreshFollowUpAudience") === "true";
    const page = Math.max(1, Number(searchParams.get("page") || 1));
    const limit = Math.min(
      50,
      Math.max(1, Number(searchParams.get("limit") || 20))
    );

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await connectDB();

    if (audienceFilter === "birthday") {
      if (
        channelParam &&
        channelParam !== "whatsapp" &&
        channelParam !== "telegram"
      ) {
        return NextResponse.json(
          { error: "Birthday campaigns support WhatsApp and Telegram only" },
          { status: 400 }
        );
      }
      const birthdayChannel =
        channelParam === "telegram" ? "telegram" : "whatsapp";
      if (birthdayChannel === "telegram" && !telegramSourceId) {
        return NextResponse.json(
          { error: "sourceId is required for Telegram birthday campaigns" },
          { status: 400 }
        );
      }

      const parsedScheduledFor = scheduledForParam
        ? new Date(scheduledForParam)
        : null;
      const scheduledFor =
        parsedScheduledFor && Number.isFinite(parsedScheduledFor.getTime())
          ? parsedScheduledFor
          : new Date();
      const preview = await buildBirthdayAudiencePreview({
        workspaceId,
        channel: birthdayChannel,
        scheduledFor,
        timezone,
        birthdayConfig: {
          version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
          leapDayPolicy: "feb_28",
        },
        templateCategory,
        recipientPhones,
        recipientChatIds,
        telegramSourceId,
        page,
        limit,
      });

      return NextResponse.json({
        ...preview,
        excludedAlreadySent: 0,
      });
    }

    const scenarioId =
      scenarioIdParam && Types.ObjectId.isValid(scenarioIdParam)
        ? new Types.ObjectId(scenarioIdParam)
        : null;
    const scheduleId =
      !scenarioId && scheduleIdParam && Types.ObjectId.isValid(scheduleIdParam)
        ? new Types.ObjectId(scheduleIdParam)
        : null;
    const graphScenarioId = scenarioId || scheduleId;
    let incomingNodeIds =
      collectCampaignIncomingNodeIdsFromSearchParams(searchParams);

    if (
      incomingNodeIds.length === 0 &&
      graphScenarioId &&
      typeof nodeId === "string" &&
      nodeId.trim()
    ) {
      const graphScenario = (await Scenario.findOne({
        _id: graphScenarioId,
        workspaceId,
        mode: "bulk_campaign",
      })
        .select("edges")
        .lean()) as { edges?: CampaignEdgeRecord[] } | null;
      incomingNodeIds = getIncomingCampaignNodeIds(
        Array.isArray(graphScenario?.edges) ? graphScenario.edges : [],
        nodeId
      );
    }
    const targetingModeNorm = String(targetingMode || "")
      .trim()
      .toLowerCase();
    const useFollowUpAudience =
      audienceFilter === "follow_up_prediction" &&
      targetingModeNorm === "dynamic";

    const audienceDefinition = useFollowUpAudience
      ? await buildCampaignAudienceQueryWithFollowUpPrediction({
          workspaceId,
          channel: channelParam,
          templateCategory,
          scheduleType,
          delayDays,
          incomingNodeIds,
          scenarioId,
          scheduleId,
          nodeId,
          followUpStatuses: resolveFollowUpStatusesForBulkCampaign({
            includeWaitingTimeout: followUpIncludeWaitingTimeout,
          }),
          bypassFollowUpCache: refreshFollowUpAudience,
        })
      : buildCampaignAudienceQueryDefinition({
          workspaceId,
          channel: channelParam,
          targetingMode,
          selectedConversationIds:
            collectCampaignSelectedConversationIdsFromSearchParams(
              searchParams
            ),
          category,
          internalLabel,
          templateCategory,
          scheduleType,
          delayDays,
          incomingNodeIds,
          scenarioId,
          scheduleId,
          nodeId,
        });
    const channel =
      typeof audienceDefinition.baseQuery.channel === "string"
        ? audienceDefinition.baseQuery.channel
        : channelParam === "email"
          ? "email"
          : "whatsapp";

    if (audienceDefinition.skipReason) {
      return NextResponse.json({
        total: 0,
        eligibleTotal: 0,
        excludedAlreadySent: 0,
        page,
        limit,
        items: [],
      });
    }

    const selectProjection =
      channel === "whatsapp"
        ? "chat lastMessageAt history_summary internal_labels classification.category classification.summary participants"
        : "participants lastMessageAt history_summary internal_labels classification.category classification.summary";

    const [total, optedInTotal, excludedAlreadySent, eligibleTotal, rawItems] =
      await Promise.all([
        Conversation.countDocuments(audienceDefinition.baseQuery),
        audienceDefinition.marketingOptInConsentQuery
          ? Conversation.countDocuments(
              audienceDefinition.marketingOptInConsentQuery
            )
          : Promise.resolve<number | null>(null),
        audienceDefinition.alreadySentQuery
          ? Conversation.countDocuments(audienceDefinition.alreadySentQuery)
          : Promise.resolve<number | undefined>(undefined),
        Conversation.countDocuments(audienceDefinition.eligibleQuery),
        Conversation.find(audienceDefinition.eligibleQuery)
          .sort({ lastMessageAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select(selectProjection)
          .lean(),
      ]);

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
    const resolveEmailRecipient = (participants?: {
      from?: unknown[];
      to?: unknown[];
    }): string | null => {
      const from = Array.isArray(participants?.from) ? participants?.from : [];
      const to = Array.isArray(participants?.to) ? participants?.to : [];
      const candidates = [...from, ...to];
      for (const candidate of candidates) {
        const email = normalizeCampaignEmail(candidate);
        if (emailRegex.test(email)) return email;
      }
      return null;
    };

    type AudiencePreviewRawItem = Record<string, unknown> & {
      chat?: unknown;
      participants?: unknown;
    };
    const items = ((rawItems || []) as AudiencePreviewRawItem[]).map(item => {
      const participants =
        item.participants &&
        typeof item.participants === "object" &&
        !Array.isArray(item.participants)
          ? (item.participants as { from?: unknown[]; to?: unknown[] })
          : undefined;
      const recipient =
        channel === "whatsapp"
          ? item?.chat !== undefined && item?.chat !== null
            ? String(item.chat)
            : null
          : resolveEmailRecipient(participants);
      return {
        ...item,
        recipient,
      };
    });

    const marketingOptInWarningCount =
      templateCategory === "MARKETING" && typeof optedInTotal === "number"
        ? Math.max(0, total - optedInTotal)
        : undefined;
    const excludedOptIn = templateCategory === "MARKETING" ? 0 : undefined;

    const followUpCapped =
      useFollowUpAudience &&
      audienceDefinition.selectedConversationIds.length >=
        FOLLOW_UP_CAMPAIGN_AUDIENCE_ID_CAP;

    return NextResponse.json({
      total,
      eligibleTotal,
      ...(excludedOptIn !== undefined ? { excludedOptIn } : {}),
      ...(marketingOptInWarningCount !== undefined
        ? { marketingOptInWarningCount }
        : {}),
      ...(excludedAlreadySent !== undefined ? { excludedAlreadySent } : {}),
      page,
      limit,
      items,
      ...(useFollowUpAudience
        ? {
            followUpAudience: {
              cacheTtlSeconds: FOLLOW_UP_AUDIENCE_CACHE_TTL_SECONDS,
              idCap: FOLLOW_UP_CAMPAIGN_AUDIENCE_ID_CAP,
              capped: followUpCapped,
              refreshed: refreshFollowUpAudience,
            },
          }
        : {}),
    });
  } catch (error) {
    console.error("Audience preview error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

import type { FollowUpAudienceStatus } from "@/lib/campaign/follow-up-audience-status";
import { normalizeString } from "@/lib/scenarios/task-utils";
import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";
import { Types } from "mongoose";

import {
  normalizeCampaignScheduleType,
  resolveCampaignNodeChannel,
} from "./campaign-runtime-utils";

export type CampaignAudienceSource = "explicit" | "dynamic" | "birthday";

type CampaignHistoryIdentityParams = {
  scenarioId?: Types.ObjectId | null;
  scheduleId?: Types.ObjectId | null;
};

export type CampaignAudienceQueryDefinition = {
  audienceSource: CampaignAudienceSource;
  selectedConversationIds: Types.ObjectId[];
  baseQuery: Record<string, unknown>;
  deliveryBaseQuery: Record<string, unknown>;
  eligibleQuery: Record<string, unknown>;
  marketingOptInConsentQuery: Record<string, unknown> | null;
  alreadySentQuery: Record<string, unknown> | null;
  historyElemMatch: Record<string, unknown> | null;
  skipReason?: string;
};

export function parseCampaignSelectedConversationIds(
  values: Array<unknown>
): Types.ObjectId[] {
  return values
    .map(value => normalizeString(value))
    .filter(value => Types.ObjectId.isValid(value))
    .map(value => new Types.ObjectId(value));
}

export function resolveCampaignAudienceSource(params: {
  targetingMode?: unknown;
  selectedConversationIds?: Types.ObjectId[];
}): CampaignAudienceSource {
  const targetingMode = normalizeString(params.targetingMode).toLowerCase();
  if (
    targetingMode === "explicit" ||
    (!targetingMode &&
      Array.isArray(params.selectedConversationIds) &&
      params.selectedConversationIds.length > 0)
  ) {
    return "explicit";
  }
  return "dynamic";
}

function buildCampaignHistoryIdentityClause(
  params: CampaignHistoryIdentityParams
) {
  if (params.scenarioId) {
    return {
      $or: [
        { scenarioId: params.scenarioId },
        { scheduleId: params.scenarioId },
      ],
    };
  }
  if (params.scheduleId) {
    return {
      scheduleId: params.scheduleId,
    };
  }
  return null;
}

export function buildCampaignHistoryElemMatch(params: {
  scenarioId?: Types.ObjectId | null;
  scheduleId?: Types.ObjectId | null;
  nodeId?: unknown;
}) {
  const nodeId = normalizeString(params.nodeId);
  const identityClause = buildCampaignHistoryIdentityClause(params);
  if (!nodeId || !identityClause) return null;
  return {
    nodeId,
    ...identityClause,
  };
}

export function buildCampaignAudienceQueryDefinition(params: {
  workspaceId: string;
  channel?: unknown;
  targetingMode?: unknown;
  selectedConversationIds?: Array<unknown>;
  category?: unknown;
  internalLabel?: unknown;
  templateCategory?: unknown;
  scheduleType?: unknown;
  delayDays?: unknown;
  now?: Date;
  incomingNodeIds?: string[];
  scenarioId?: Types.ObjectId | null;
  scheduleId?: Types.ObjectId | null;
  nodeId?: unknown;
}): CampaignAudienceQueryDefinition {
  const workspaceId = normalizeString(params.workspaceId);
  const channel = resolveCampaignNodeChannel(params.channel);
  const selectedConversationIds = parseCampaignSelectedConversationIds(
    Array.isArray(params.selectedConversationIds)
      ? params.selectedConversationIds
      : []
  );
  const audienceSource = resolveCampaignAudienceSource({
    targetingMode: params.targetingMode,
    selectedConversationIds,
  });
  const baseQuery: Record<string, unknown> = {
    workspaceId,
    channel,
  };

  if (audienceSource === "explicit") {
    if (selectedConversationIds.length === 0) {
      return {
        audienceSource,
        selectedConversationIds,
        baseQuery,
        deliveryBaseQuery: baseQuery,
        eligibleQuery: {
          ...baseQuery,
          _id: { $in: [] },
        },
        marketingOptInConsentQuery: null,
        alreadySentQuery: null,
        historyElemMatch: null,
        skipReason: "explicit_targeting_without_recipients",
      };
    }

    baseQuery._id = { $in: selectedConversationIds };
  } else {
    const category = normalizeString(params.category);
    const internalLabel = normalizeString(params.internalLabel);

    if (category) {
      baseQuery["classification.category"] = category;
      Object.assign(baseQuery, buildCurrentConversationClassificationFilter());
    }
    if (internalLabel && internalLabel !== "none") {
      baseQuery.internal_labels = internalLabel;
    }
  }

  const isWhatsappMarketing =
    channel === "whatsapp" &&
    normalizeString(params.templateCategory).toUpperCase() === "MARKETING";
  const deliveryBaseQuery = { ...baseQuery };
  const marketingOptInConsentQuery = isWhatsappMarketing
    ? {
        ...baseQuery,
        "whatsapp_opt_in.status": true,
      }
    : null;

  const historyElemMatch = buildCampaignHistoryElemMatch({
    scenarioId: params.scenarioId,
    scheduleId: params.scheduleId,
    nodeId: params.nodeId,
  });
  const alreadySentQuery = historyElemMatch
    ? {
        ...deliveryBaseQuery,
        bulk_campaign_history: {
          $elemMatch: historyElemMatch,
        },
      }
    : null;

  const excludeAlreadySent = historyElemMatch
    ? {
        bulk_campaign_history: {
          $not: {
            $elemMatch: historyElemMatch,
          },
        },
      }
    : {};

  let eligibleQuery: Record<string, unknown> = {
    ...deliveryBaseQuery,
    ...excludeAlreadySent,
  };

  const scheduleType = normalizeCampaignScheduleType(params.scheduleType);
  if (scheduleType === "relative") {
    const delayDays = Math.max(
      0,
      Number.parseInt(String(params.delayDays ?? "0"), 10) || 0
    );
    const cutoffDate = new Date(
      (params.now || new Date()).getTime() - delayDays * 24 * 60 * 60 * 1000
    );
    const incomingNodeIds = Array.isArray(params.incomingNodeIds)
      ? params.incomingNodeIds.map(id => normalizeString(id)).filter(Boolean)
      : [];
    const historyIdentityClause = buildCampaignHistoryIdentityClause({
      scenarioId: params.scenarioId,
      scheduleId: params.scheduleId,
    });

    if (incomingNodeIds.length > 0 && historyIdentityClause) {
      eligibleQuery = {
        ...deliveryBaseQuery,
        $and: [
          {
            bulk_campaign_history: {
              $elemMatch: {
                nodeId: { $in: incomingNodeIds },
                sentAt: { $lte: cutoffDate },
                ...historyIdentityClause,
              },
            },
          },
          excludeAlreadySent,
        ],
      };
    } else {
      eligibleQuery = {
        ...deliveryBaseQuery,
        createdAt: { $lte: cutoffDate },
        ...excludeAlreadySent,
      };
    }
  }

  return {
    audienceSource,
    selectedConversationIds,
    baseQuery,
    deliveryBaseQuery,
    eligibleQuery,
    marketingOptInConsentQuery,
    alreadySentQuery,
    historyElemMatch,
  };
}

export function collectCampaignSelectedConversationIdsFromSearchParams(
  searchParams: URLSearchParams
) {
  return [
    ...searchParams.getAll("selectedConversationIds"),
    ...searchParams.getAll("selectedConversationIds[]"),
  ];
}

export function collectCampaignIncomingNodeIdsFromSearchParams(
  searchParams: URLSearchParams
) {
  return [
    ...searchParams.getAll("incomingNodeIds"),
    ...searchParams.getAll("incomingNodeIds[]"),
  ]
    .map(value => normalizeString(value))
    .filter(Boolean);
}

/** Max conversation ObjectIds from follow-up analysis merged into a single $in (BSON safety). */
export const FOLLOW_UP_CAMPAIGN_AUDIENCE_ID_CAP = 12_000;

/** Server-side TTL of follow-up workspace snapshot (see follow-up-audience.ts). */
export const FOLLOW_UP_AUDIENCE_CACHE_TTL_SECONDS = 480;

export function parseCampaignAudienceFilterParam(
  value: string | null | undefined
): "legacy_dynamic" | "follow_up_prediction" | "birthday" {
  const normalized = normalizeString(value || "")
    .replace(/-/g, "_")
    .toLowerCase();
  if (normalized === "birthday") return "birthday";
  return normalized === "follow_up_prediction"
    ? "follow_up_prediction"
    : "legacy_dynamic";
}

export function resolveFollowUpStatusesForBulkCampaign(params: {
  includeWaitingTimeout: boolean;
}): FollowUpAudienceStatus[] {
  if (params.includeWaitingTimeout) {
    return ["ready_now", "waiting_timeout"];
  }
  return ["ready_now"];
}

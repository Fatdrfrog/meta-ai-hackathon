import { getFollowUpAudienceWorkspaceState } from "@/lib/analytics/follow-up-audience";
import {
  buildCampaignAudienceQueryDefinition,
  FOLLOW_UP_CAMPAIGN_AUDIENCE_ID_CAP,
  type CampaignAudienceQueryDefinition,
} from "@/lib/campaign/campaign-audience";
import type { FollowUpAudienceStatus } from "@/lib/campaign/follow-up-audience-status";
import { normalizeString } from "@/lib/scenarios/task-utils";
import { Types } from "mongoose";

import { resolveCampaignNodeChannel } from "./campaign-runtime-utils";

export async function buildCampaignAudienceQueryWithFollowUpPrediction(params: {
  workspaceId: string;
  channel?: unknown;
  templateCategory?: unknown;
  scheduleType?: unknown;
  delayDays?: unknown;
  now?: Date;
  incomingNodeIds?: string[];
  scenarioId?: Types.ObjectId | null;
  scheduleId?: Types.ObjectId | null;
  nodeId?: unknown;
  followUpStatuses: FollowUpAudienceStatus[];
  bypassFollowUpCache?: boolean;
}): Promise<CampaignAudienceQueryDefinition> {
  const channel = resolveCampaignNodeChannel(params.channel);
  const statusSet = new Set(params.followUpStatuses);

  const state = await getFollowUpAudienceWorkspaceState(params.workspaceId, {
    bypassCache: params.bypassFollowUpCache === true,
  });
  const ids: Types.ObjectId[] = [];

  for (const row of state.rows) {
    if (!statusSet.has(row.status)) continue;
    const rowCh = normalizeString(row.channel).toLowerCase();
    if (channel === "whatsapp" && rowCh !== "whatsapp") continue;
    if (channel === "email" && rowCh !== "email") continue;
    if (channel === "telegram" && rowCh !== "telegram") continue;
    if (!Types.ObjectId.isValid(row.conversationId)) continue;
    ids.push(new Types.ObjectId(row.conversationId));
    if (ids.length >= FOLLOW_UP_CAMPAIGN_AUDIENCE_ID_CAP) {
      break;
    }
  }

  return buildCampaignAudienceQueryDefinition({
    workspaceId: params.workspaceId,
    channel,
    targetingMode: "explicit",
    selectedConversationIds: ids,
    templateCategory: params.templateCategory,
    scheduleType: params.scheduleType,
    delayDays: params.delayDays,
    now: params.now,
    incomingNodeIds: params.incomingNodeIds,
    scenarioId: params.scenarioId,
    scheduleId: params.scheduleId,
    nodeId: params.nodeId,
  });
}

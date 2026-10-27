import {
  buildBirthdayRecipientPlan,
  type BirthdayRecipientPlan,
} from "@/lib/campaign/campaign-birthday-recipient-plan";
import { parseCampaignAudienceFilterParam } from "@/lib/campaign/campaign-audience";
import {
  isSchedulableBuilderBirthdayRoot,
  resolveScheduledCampaignNode,
  resolveScheduledCampaignNodeChannel,
  type CampaignEdgeRecord,
  type CampaignNodeRecord,
} from "@/lib/campaign/campaign-runtime-utils";
import { normalizeCampaignTimezone } from "@/lib/campaign/campaign-schedule-config";
import { Scenario } from "@/models/scenario";
import type { ScenarioCampaignRecipient } from "@icecore/scenario-contracts";

import {
  BIRTHDAY_SCHEDULE_SCENARIO_FILTER,
  scenarioHasBirthdayBulkSchedule,
} from "./campaign-birthday-scenario-guards";

type BirthdayScenarioRecord = {
  _id?: unknown;
  name?: string | null;
  workspaceId?: string;
  mode?: string;
  status?: string;
  timezone?: string;
  nodes?: CampaignNodeRecord[];
  edges?: CampaignEdgeRecord[];
};

export type BirthdayProtectionSummary = {
  active: boolean;
  scenarioId?: string;
  scenarioName?: string | null;
  protectedTodayCount: number;
  availableRecipientLimit: number | null;
  dailyLimit: number | null;
  plan?: BirthdayRecipientPlan;
};

function normalizePositiveLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function resolveBirthdayScenarioPlan(params: {
  scenario: BirthdayScenarioRecord;
  dailyLimit?: number | null;
  now?: Date;
}): BirthdayRecipientPlan | null {
  const nodes = Array.isArray(params.scenario.nodes)
    ? params.scenario.nodes
    : [];
  const edges = Array.isArray(params.scenario.edges)
    ? params.scenario.edges
    : [];
  const isLegacyScenario =
    String(params.scenario.mode || "").trim() === "bulk_campaign";

  for (const node of nodes) {
    // Read the same builder root that the guard and the schedule use.
    if (!isLegacyScenario && !isSchedulableBuilderBirthdayRoot(node)) continue;
    const scheduledNode = resolveScheduledCampaignNode({
      node,
      nodes,
      edges,
    });
    if (!scheduledNode) continue;
    if (
      parseCampaignAudienceFilterParam(
        String(scheduledNode.data?.audienceFilter || "")
      ) !== "birthday"
    ) {
      continue;
    }
    if (
      resolveScheduledCampaignNodeChannel(scheduledNode.data?.channel) !==
      "whatsapp"
    ) {
      continue;
    }

    const recipients = Array.isArray(scheduledNode.data?.uploadedRecipients)
      ? (scheduledNode.data.uploadedRecipients as ScenarioCampaignRecipient[])
      : [];
    const scheduleConfig =
      scheduledNode.data?.scheduleConfig &&
      typeof scheduledNode.data.scheduleConfig === "object" &&
      !Array.isArray(scheduledNode.data.scheduleConfig)
        ? (scheduledNode.data.scheduleConfig as { timezone?: unknown })
        : null;
    const timezone = normalizeCampaignTimezone(
      scheduleConfig?.timezone || params.scenario.timezone
    );

    return buildBirthdayRecipientPlan({
      recipients,
      dailyLimit: params.dailyLimit,
      timezone,
      now: params.now,
    });
  }

  return null;
}

export async function getBirthdayProtectionSummary(params: {
  workspaceId: string;
  dailyLimit?: number | null;
  now?: Date;
}): Promise<BirthdayProtectionSummary> {
  const dailyLimit = normalizePositiveLimit(params.dailyLimit);
  const activeBulkScenarios = (await Scenario.find({
    workspaceId: params.workspaceId,
    ...BIRTHDAY_SCHEDULE_SCENARIO_FILTER,
    status: "active",
    deletedAt: null,
  })
    .select("_id name mode status timezone nodes edges")
    .lean()) as BirthdayScenarioRecord[];

  const birthdayScenario = activeBulkScenarios.find(scenario =>
    scenarioHasBirthdayBulkSchedule(scenario, { channel: "whatsapp" })
  );
  if (!birthdayScenario) {
    return {
      active: false,
      protectedTodayCount: 0,
      availableRecipientLimit: dailyLimit,
      dailyLimit,
    };
  }

  const plan = resolveBirthdayScenarioPlan({
    scenario: birthdayScenario,
    dailyLimit,
    now: params.now,
  });
  const todayCount = plan?.todayBirthdayCount || 0;
  const protectedTodayCount = dailyLimit
    ? Math.min(todayCount, dailyLimit)
    : todayCount;

  return {
    active: true,
    scenarioId: birthdayScenario._id ? String(birthdayScenario._id) : undefined,
    scenarioName:
      typeof birthdayScenario.name === "string" ? birthdayScenario.name : null,
    protectedTodayCount,
    availableRecipientLimit: dailyLimit
      ? Math.max(0, dailyLimit - protectedTodayCount)
      : null,
    dailyLimit,
    ...(plan ? { plan } : {}),
  };
}

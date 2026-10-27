import { parseCampaignAudienceFilterParam } from "@/lib/campaign/campaign-audience";
import {
  isSchedulableBuilderBirthdayRoot,
  resolveScheduledCampaignNode,
  resolveScheduledCampaignNodeChannel,
  type CampaignEdgeRecord,
  type CampaignNodeRecord,
} from "@/lib/campaign/campaign-runtime-utils";
import { Scenario } from "@/models/scenario";
import { withBirthdayWorkspaceTransaction } from "@/lib/customers/customer-birthday-transaction";
import { SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE } from "@icecore/scenario-contracts";
import type { ClientSession } from "mongoose";
import { readArray } from "@icecore/shared/lib/value-utils";

/**
 * Scenarios that may hold a birthday schedule: legacy bulk_campaign ones and
 * builder scenarios with a birthday bulk-campaign root.
 */
export const BIRTHDAY_SCHEDULE_SCENARIO_FILTER = {
  $or: [
    { mode: "bulk_campaign" },
    {
      nodes: {
        $elemMatch: {
          "data.kind": "bulk",
          "data.bulkRootConfig.workflowKind": "bulk_campaign",
          "data.bulkRootConfig.recipientAudienceSource":
            SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
        },
      },
    },
  ],
};

type ScenarioLike = {
  _id?: unknown;
  workspaceId?: unknown;
  name?: unknown;
  mode?: unknown;
  status?: unknown;
  nodes?: unknown;
  edges?: unknown;
};

type BirthdayScenarioConflict = { scenarioId: string; name?: string | null };

export class BirthdayScenarioConflictError extends Error {
  constructor(readonly conflict: BirthdayScenarioConflict) {
    super("Another active Scenario owns this birthday audience.");
    this.name = "BirthdayScenarioConflictError";
  }
}

/**
 * Reuses the same Mongo write-fence pattern as QR activation and linked
 * conditions: guard and Scenario commit share a transaction, and touching one
 * workspace owner forces concurrent activations to retry with a fresh snapshot.
 */
export async function withBirthdayScenarioWriteFence<T>(params: {
  workspaceId: string;
  scenarioId: string;
  scenario: ScenarioLike;
  commit: (session: ClientSession | undefined) => Promise<T>;
}): Promise<T> {
  if (
    params.scenario.status !== "active" ||
    !scenarioHasBirthdayBulkSchedule(params.scenario)
  ) {
    return params.commit(undefined);
  }

  return withBirthdayWorkspaceTransaction(params.workspaceId, async session => {
    const conflict = await findActiveBirthdayScenarioConflict({
      workspaceId: params.workspaceId,
      scenarioId: params.scenarioId,
      scenario: params.scenario,
      session,
    });
    if (conflict) throw new BirthdayScenarioConflictError(conflict);
    return params.commit(session);
  });
}

const asNodes = readArray<CampaignNodeRecord>;
const asEdges = readArray<CampaignEdgeRecord>;

type BirthdayScheduleScope = {
  channel: "whatsapp" | "telegram";
  telegramSourceId: string | null;
};

function isLegacyBulkCampaignScenario(
  scenario: ScenarioLike | null | undefined
): boolean {
  return String(scenario?.mode || "").trim() === "bulk_campaign";
}

function getBirthdayScheduleScopes(
  scenario: ScenarioLike | null | undefined
): BirthdayScheduleScope[] {
  const isLegacyScenario = isLegacyBulkCampaignScenario(scenario);
  const nodes = asNodes(scenario?.nodes);
  const edges = asEdges(scenario?.edges);
  return nodes.flatMap(node => {
    // Builder scenarios keep Scenario.mode "conversation" and schedule only
    // daily birthday roots, so only those scopes are checked.
    if (!isLegacyScenario && !isSchedulableBuilderBirthdayRoot(node)) {
      return [];
    }
    const scheduledNode = resolveScheduledCampaignNode({ node, nodes, edges });
    if (
      parseCampaignAudienceFilterParam(
        String(scheduledNode?.data?.audienceFilter || "")
      ) !== "birthday"
    ) {
      return [];
    }
    const channel = resolveScheduledCampaignNodeChannel(
      scheduledNode?.data?.channel
    );
    if (channel !== "whatsapp" && channel !== "telegram") return [];
    if (
      !isLegacyScenario &&
      channel === "telegram" &&
      !String(scheduledNode?.data?.telegramSourceId || "").trim()
    )
      return [];
    return [
      {
        channel,
        telegramSourceId:
          channel === "telegram"
            ? String(scheduledNode?.data?.telegramSourceId || "").trim() || null
            : null,
      },
    ];
  });
}

function birthdayScopesConflict(
  left: BirthdayScheduleScope,
  right: BirthdayScheduleScope
): boolean {
  if (left.channel !== right.channel) return false;
  if (left.channel === "whatsapp") return true;
  return (
    !left.telegramSourceId ||
    !right.telegramSourceId ||
    left.telegramSourceId === right.telegramSourceId
  );
}

export function scenarioHasBirthdayBulkSchedule(
  scenario: ScenarioLike | null | undefined,
  options?: { channel?: "whatsapp" | "telegram" }
): boolean {
  return getBirthdayScheduleScopes(scenario).some(
    scope => !options?.channel || scope.channel === options.channel
  );
}

export async function findActiveBirthdayScenarioConflict(params: {
  workspaceId: string;
  scenarioId: string;
  scenario: ScenarioLike;
  session?: ClientSession;
}): Promise<BirthdayScenarioConflict | null> {
  if (
    String(params.scenario.status || "").trim() !== "active" ||
    !scenarioHasBirthdayBulkSchedule(params.scenario)
  ) {
    return null;
  }

  const requestedScopes = getBirthdayScheduleScopes(params.scenario);
  // Multiple roots for the same channel and bot would each send a daily
  // birthday message, so the scenario conflicts with itself.
  if (
    !isLegacyBulkCampaignScenario(params.scenario) &&
    requestedScopes.some((scope, index) =>
      requestedScopes
        .slice(index + 1)
        .some(other => birthdayScopesConflict(scope, other))
    )
  ) {
    return {
      scenarioId: params.scenarioId,
      name:
        typeof params.scenario.name === "string" ? params.scenario.name : null,
    };
  }

  const query = Scenario.find({
    workspaceId: params.workspaceId,
    ...BIRTHDAY_SCHEDULE_SCENARIO_FILTER,
    status: "active",
    deletedAt: null,
    _id: { $ne: params.scenarioId },
  }).select("_id name mode status nodes edges");
  if (params.session) query.session(params.session);
  const activeBulkScenarios = (await query.lean()) as ScenarioLike[];

  const conflict = activeBulkScenarios.find(scenario => {
    const existingScopes = getBirthdayScheduleScopes(scenario);
    return requestedScopes.some(requestedScope =>
      existingScopes.some(existingScope =>
        birthdayScopesConflict(requestedScope, existingScope)
      )
    );
  });
  if (!conflict?._id) return null;

  return {
    scenarioId: String(conflict._id),
    name: typeof conflict.name === "string" ? conflict.name : null,
  };
}

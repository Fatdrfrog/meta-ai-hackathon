import type { ScenarioDetailResponseWarning } from "@icecore/scenario-contracts";
import connectDB from "@/lib/mongoose";
import { serializeScenario } from "@/lib/scenarios/scenario-serialization";
import { loadLinkedConditionParentCountByNodeId } from "@/lib/scenarios/linked-conditions";
import { attachLinkedParentScenarioIds } from "@/lib/scenarios/linked-parent-summaries";
import {
  enrichScenarioNodesMediaDisplayUrls,
  enrichScenarioNodesMediaDisplayUrlsWithinBudget,
} from "@/lib/scenarios/scenario-asset-media-enrichment";
import {
  listOutstandingTimerReplanIngressForScenario,
  type OutstandingTimerReplanIngress,
} from "@/lib/airi/scenario/timer-recovery/ingress";
import { Scenario } from "@/models/scenario";

/**
 * How long a `deferred` read waits for media signing. Media signed later
 * stays durable in the response, which then says so in its metadata.
 */
export const SCENARIO_DETAIL_MEDIA_SIGNING_BUDGET_MS = 1_500;

/**
 * `complete` (the default) waits for every signed URL. `deferred` is only for
 * readers that ask again when `metadata.mediaDisplayUrlsPending` is set,
 * because a durable `gcs://` ref cannot be shown as an image.
 */
export type ScenarioDetailMediaSigning = "complete" | "deferred";

/** Query value GET /api/scenarios/:id takes as `?mediaSigning=deferred`. */
export function readScenarioDetailMediaSigning(
  value: string | null
): ScenarioDetailMediaSigning {
  return value === "deferred" ? "deferred" : "complete";
}

type ScenarioDetailScope = {
  workspaceId: string;
  scenarioId: string;
};

/** The live scenario document a detail read serializes, or null. */
export async function findScenarioDetailDocument(scope: ScenarioDetailScope) {
  await connectDB();
  return Scenario.findOne({
    _id: scope.scenarioId,
    workspaceId: scope.workspaceId,
    deletedAt: null,
  }).lean<Record<string, unknown> | null>({ defaults: false });
}

/** The detail a scenario open returns. */
export function serializeOpenedScenarioDetail(params: {
  workspaceId: string;
  scenario: Record<string, unknown>;
  mediaSigning?: ScenarioDetailMediaSigning;
}) {
  return serializeScenarioDetail({
    workspaceId: params.workspaceId,
    scenario: params.scenario,
    ...(params.mediaSigning === "deferred"
      ? { mediaSigningBudgetMs: SCENARIO_DETAIL_MEDIA_SIGNING_BUDGET_MS }
      : {}),
  });
}

export async function loadScenarioDetail(
  scope: ScenarioDetailScope & { mediaSigning?: ScenarioDetailMediaSigning }
) {
  const scenario = await findScenarioDetailDocument(scope);
  return scenario
    ? serializeOpenedScenarioDetail({
        workspaceId: scope.workspaceId,
        scenario,
        mediaSigning: scope.mediaSigning,
      })
    : null;
}

/** Creation historically returns linked metadata without media/timer enrichment. */
export async function serializeCreatedScenarioDetail(params: {
  workspaceId: string;
  scenario: Record<string, unknown>;
}) {
  const linkedConditionParentCountByNodeId =
    await loadLinkedConditionParentCountByNodeId({
      nodes: params.scenario.nodes,
    });
  return {
    scenario: await attachLinkedParentScenarioIds(
      serializeScenario(params.scenario),
      params.workspaceId
    ),
    metadata: { linkedConditionParentCountByNodeId },
  };
}
async function enrichDetailNodesMedia(params: {
  workspaceId: string;
  nodes: unknown;
  mediaSigningBudgetMs?: number;
}): Promise<{ nodes: unknown; pending: boolean }> {
  if (params.mediaSigningBudgetMs === undefined) {
    return {
      nodes: await enrichScenarioNodesMediaDisplayUrls({
        workspaceId: params.workspaceId,
        nodes: params.nodes,
      }),
      pending: false,
    };
  }
  return enrichScenarioNodesMediaDisplayUrlsWithinBudget({
    workspaceId: params.workspaceId,
    nodes: params.nodes,
    budgetMs: params.mediaSigningBudgetMs,
  });
}

function loadTimerRecovery(
  workspaceId: string,
  scenarioId: string
): Promise<OutstandingTimerReplanIngress> {
  return scenarioId
    ? listOutstandingTimerReplanIngressForScenario({
        workspaceId,
        scenarioId,
        limit: 50,
      })
    : Promise.resolve({
        status: null,
        affectedConversationIds: [],
        hasMore: false,
      });
}

function reconcileTimerReplanWarning(
  inputWarnings: ScenarioDetailResponseWarning[],
  recovery: OutstandingTimerReplanIngress
): ScenarioDetailResponseWarning[] {
  const timerWarningCode = "legacy_action_routing_timer_replan_failed";
  const firstTimerWarningIndex = inputWarnings.findIndex(
    warning => warning.code === timerWarningCode
  );
  const warnings = inputWarnings.filter(
    warning => warning.code !== timerWarningCode
  );
  if (!recovery.status) return warnings;

  const count = recovery.affectedConversationIds.length;
  const countLabel = recovery.hasMore ? `at least ${count}` : String(count);
  const persistedWarning: ScenarioDetailResponseWarning = {
    code: timerWarningCode,
    message:
      recovery.status === "pending"
        ? `Timer recovery is queued for ${countLabel} conversation${count === 1 ? "" : "s"}. Automatic retries continue in the background.`
        : `Timer recovery still needs attention for ${countLabel} conversation${count === 1 ? "" : "s"}. Retry it after checking Temporal availability.`,
    affectedConversationIds: recovery.affectedConversationIds,
    recoveryStatus: recovery.status,
    retryable: recovery.status === "failed",
  };
  const insertionIndex =
    firstTimerWarningIndex < 0
      ? warnings.length
      : Math.min(firstTimerWarningIndex, warnings.length);
  warnings.splice(insertionIndex, 0, persistedWarning);
  return warnings;
}

export async function serializeScenarioDetail(params: {
  workspaceId: string;
  scenario: Parameters<typeof serializeScenario>[0];
  warnings?: ScenarioDetailResponseWarning[];
  /** Set on `deferred` reads only: the rest wait for every signed URL. */
  mediaSigningBudgetMs?: number;
}) {
  const scenarioId = String(
    (params.scenario as { _id?: unknown })._id || ""
  ).trim();
  const serialized = serializeScenario(params.scenario);
  // Linked parents need only the id, so they load alongside the rest.
  const [media, linkedScenario, linkedConditionParentCountByNodeId, recovery] =
    await Promise.all([
      enrichDetailNodesMedia({
        workspaceId: params.workspaceId,
        nodes: serialized.nodes,
        mediaSigningBudgetMs: params.mediaSigningBudgetMs,
      }),
      attachLinkedParentScenarioIds(serialized, params.workspaceId),
      loadLinkedConditionParentCountByNodeId({
        nodes: params.scenario.nodes,
      }),
      loadTimerRecovery(params.workspaceId, scenarioId),
    ]);
  const warnings = reconcileTimerReplanWarning(
    [...(params.warnings ?? [])],
    recovery
  );

  return {
    scenario: { ...linkedScenario, nodes: media.nodes },
    metadata: {
      linkedConditionParentCountByNodeId,
      ...(warnings.length ? { warnings } : {}),
      ...(media.pending ? { mediaDisplayUrlsPending: true } : {}),
    },
  };
}

export async function serializeCommittedScenarioDetail(params: {
  workspaceId: string;
  scenario: Parameters<typeof serializeScenario>[0];
  warnings?: ScenarioDetailResponseWarning[];
}) {
  try {
    return await serializeScenarioDetail(params);
  } catch (error) {
    console.error(
      "[Scenarios API] Scenario committed but detail enrichment failed:",
      error
    );
    const warning: ScenarioDetailResponseWarning = {
      code: "scenario_detail_enrichment_failed",
      message:
        "The scenario was saved, but some media, linked-scenario, or timer-recovery details could not be refreshed. Reload to try again.",
    };
    let reconciledWarnings = [...(params.warnings ?? [])];
    const scenarioId = String(
      (params.scenario as { _id?: unknown })._id || ""
    ).trim();
    if (scenarioId) {
      const recovery = await listOutstandingTimerReplanIngressForScenario({
        workspaceId: params.workspaceId,
        scenarioId,
        limit: 50,
      }).catch(() => null);
      if (recovery) {
        reconciledWarnings = reconcileTimerReplanWarning(
          reconciledWarnings,
          recovery
        );
      }
    }
    const warnings = reconciledWarnings.filter(
      item => item.code !== warning.code
    );
    return {
      scenario: serializeScenario(params.scenario),
      metadata: {
        linkedConditionParentCountByNodeId: {},
        warnings: [...warnings, warning],
      },
    };
  }
}

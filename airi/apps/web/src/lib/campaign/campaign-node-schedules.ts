import { createHash } from "crypto";

import {
  CAMPAIGN_SCHEDULE_ACTION_WORKFLOW,
  CAMPAIGN_SCHEDULE_ACTION_WORKFLOW_CONTRACT_VERSION,
  buildCampaignScheduleActionWorkflowId,
} from "@icecore/temporal";
import type {
  CampaignNodeScheduleReconcileResult,
  CampaignScenarioScheduleReconcileSummary,
  CampaignScheduleConfig,
} from "@icecore/scenario-contracts";

import {
  getTemporalWebClientConfig,
  isTemporalConfigured,
} from "@/lib/temporal/client";
import { getTemporalScheduleClient } from "@/lib/temporal/campaign-node-run-client";
import type { TemporalScheduleSpec } from "@/lib/temporal/sdk-types";
import { normalizeString, readEntityId } from "@/lib/scenarios/task-utils";
import CampaignNodeSchedule from "@/models/campaign-node-schedule";
import { isBulkCampaignRootNode } from "@icecore/scenario-contracts";
import { isRecord } from "@icecore/shared/lib/value-utils";

import {
  buildCampaignScheduleSummary,
  compileCampaignScheduleSpec,
  normalizeCampaignScheduleConfig,
  parseCampaignScheduleConfigV2,
} from "./campaign-schedule-config";
import {
  isSchedulableBuilderBirthdayRoot,
  resolveScheduledCampaignNode,
  type CampaignNodeLike,
  type CampaignEdgeRecord,
  type CampaignNodeRecord,
} from "./campaign-runtime-utils";

type CampaignScenarioLike = {
  _id?: unknown;
  workspaceId?: unknown;
  mode?: unknown;
  status?: unknown;
  timezone?: unknown;
  nodes?: CampaignNodeRecord[];
  edges?: CampaignEdgeRecord[];
} | null;

type CampaignNodeScheduleRecord = {
  nodeId?: string | null;
  scheduleId?: string | null;
  configHash?: string | null;
  status?: string | null;
};

type CampaignNodeScheduleQuery<T> = {
  lean: () => Promise<T>;
};

type CampaignNodeScheduleModel = {
  findOne: (
    filter: Record<string, unknown>
  ) => CampaignNodeScheduleQuery<CampaignNodeScheduleRecord | null>;
  find?: (
    filter: Record<string, unknown>
  ) => CampaignNodeScheduleQuery<CampaignNodeScheduleRecord[]>;
  findOneAndUpdate: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>
  ) => CampaignNodeScheduleQuery<CampaignNodeScheduleRecord | null>;
};

type CampaignNodeScheduleDesiredState =
  | {
      action: "delete";
      workspaceId: string;
      scenarioId: string;
      nodeId: string;
      scheduleId: string;
    }
  | {
      action: "pause" | "upsert";
      workspaceId: string;
      scenarioId: string;
      nodeId: string;
      scheduleType: "once" | "recurring" | "weekly" | "relative";
      timezone: string;
      scheduleConfig: CampaignScheduleConfig;
      scheduleSpec: TemporalScheduleSpec;
      scheduleSummary: string;
      scheduleId: string;
      configHash: string;
    };

export type {
  CampaignNodeScheduleReconcileResult,
  CampaignScenarioScheduleReconcileSummary,
};

function assertScheduleReconciliationSucceeded(
  results: CampaignNodeScheduleReconcileResult[]
): void {
  const errors = results
    .filter(result => !result.ok)
    .map(
      result =>
        new Error(
          [result.scheduleId, result.errorMessage || result.action]
            .filter(Boolean)
            .join(": ")
        )
    );
  if (errors.length > 0) {
    throw new AggregateError(errors, "Campaign schedule reconciliation failed");
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([keyA], [keyB]) => keyA.localeCompare(keyB)
    );
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(entryValue)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeTimezone(value: unknown): string {
  const normalized = normalizeString(value);
  return normalized || "UTC";
}

export function buildCampaignNodeScheduleId(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
}) {
  return `campaign-node:${params.workspaceId}:${params.scenarioId}:${params.nodeId}`;
}

async function getTemporalScheduleHandle(scheduleId: string) {
  const scheduleClient = getTemporalScheduleClient();
  const handle = scheduleClient.getHandle(scheduleId);
  try {
    const description = await handle.describe();
    return { handle, description };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error || "Unknown error");
    if (
      errorMessage.toLowerCase().includes("not found") ||
      errorMessage.toLowerCase().includes("unknown schedule")
    ) {
      return null;
    }
    throw error;
  }
}

function buildTemporalScheduleOptions(
  desired: Exclude<CampaignNodeScheduleDesiredState, { action: "delete" }>
) {
  return {
    scheduleId: desired.scheduleId,
    spec: desired.scheduleSpec,
    action: {
      type: "startWorkflow" as const,
      workflowType: CAMPAIGN_SCHEDULE_ACTION_WORKFLOW,
      taskQueue: getTemporalWebClientConfig().taskQueue,
      workflowId: buildCampaignScheduleActionWorkflowId({
        scheduleId: desired.scheduleId,
      }),
      args: [
        {
          contractVersion: CAMPAIGN_SCHEDULE_ACTION_WORKFLOW_CONTRACT_VERSION,
          workspaceId: desired.workspaceId,
          scenarioId: desired.scenarioId,
          nodeId: desired.nodeId,
          scheduleId: desired.scheduleId,
        },
      ],
      workflowRunTimeout: 60 * 60 * 1000,
      workflowExecutionTimeout: 60 * 60 * 1000,
    },
    policies: {
      overlap: "BUFFER_ALL" as const,
      catchupWindow: 24 * 60 * 60 * 1000,
      pauseOnFailure: true,
    },
    state: {
      paused: desired.action === "pause",
      note:
        desired.action === "pause"
          ? "Paused because scenario is inactive"
          : undefined,
    },
  };
}

export const buildTemporalScheduleOptionsForTest = buildTemporalScheduleOptions;

async function upsertTemporalSchedule(
  desired: Exclude<CampaignNodeScheduleDesiredState, { action: "delete" }>
) {
  const existing = await getTemporalScheduleHandle(desired.scheduleId);
  const options = buildTemporalScheduleOptions(desired);

  if (!existing) {
    await getTemporalScheduleClient().create(options);
    return { existed: false, wasPaused: false };
  }

  const wasPaused = Boolean(existing.description.state.paused);
  await existing.handle.update(() => ({
    spec: options.spec,
    action: options.action,
    policies: options.policies,
    state: {
      paused: options.state.paused,
      note: options.state.note,
    },
  }));
  return { existed: true, wasPaused };
}

async function deleteTemporalSchedule(scheduleId: string) {
  const existing = await getTemporalScheduleHandle(scheduleId);
  if (!existing) {
    return false;
  }
  await existing.handle.delete();
  return true;
}

export function resolveCampaignNodeScheduleDefinition(
  node: CampaignNodeLike,
  scenario: CampaignScenarioLike
): CampaignNodeScheduleDesiredState | null {
  const workspaceId = normalizeString(scenario?.workspaceId);
  const scenarioId = readEntityId(scenario?._id);
  const nodeId = normalizeString(node?.id);

  if (!workspaceId || !scenarioId || !nodeId) {
    return null;
  }

  const scheduleId = buildCampaignNodeScheduleId({
    workspaceId,
    scenarioId,
    nodeId,
  });
  const isLegacyScenario = normalizeString(scenario?.mode) === "bulk_campaign";

  // Builder scenarios schedule only daily birthday roots; other nodes and
  // non-birthday roots keep no schedule.
  if (!isLegacyScenario && !isSchedulableBuilderBirthdayRoot(node)) {
    return {
      action: "delete",
      workspaceId,
      scenarioId,
      nodeId,
      scheduleId,
    };
  }

  const scheduledNode = resolveScheduledCampaignNode({
    node,
    nodes: Array.isArray(scenario?.nodes) ? scenario.nodes : [],
    edges: Array.isArray(scenario?.edges) ? scenario.edges : [],
  });
  const scheduledNodeData = scheduledNode?.data || null;
  const rootConfig = isRecord(node?.data?.bulkRootConfig)
    ? node.data.bulkRootConfig
    : null;

  if (
    !scheduledNode ||
    (!isLegacyScenario &&
      ((scheduledNodeData?.channel !== "whatsapp" &&
        scheduledNodeData?.channel !== "telegram") ||
        (scheduledNodeData?.channel === "telegram" &&
          !normalizeString(scheduledNodeData.telegramSourceId)) ||
        !Array.isArray(rootConfig?.channels) ||
        !rootConfig.channels.includes(scheduledNodeData.channel)))
  ) {
    return {
      action: "delete",
      workspaceId,
      scenarioId,
      nodeId,
      scheduleId,
    };
  }

  const timezone = normalizeTimezone(scenario?.timezone);
  const scheduleConfig = isLegacyScenario
    ? normalizeCampaignScheduleConfig({
        config: scheduledNodeData?.scheduleConfig,
        timezone,
        legacy: {
          scheduleType: scheduledNodeData?.scheduleType,
          day: scheduledNodeData?.day,
          time: scheduledNodeData?.time,
          delayDays: scheduledNodeData?.delayDays,
        },
      })
    : parseCampaignScheduleConfigV2(
        scheduledNodeData?.scheduleConfig,
        timezone
      );
  if (scheduleConfig?.mode !== "recurring") {
    return {
      action: "delete",
      workspaceId,
      scenarioId,
      nodeId,
      scheduleId,
    };
  }
  const scheduleSpec = compileCampaignScheduleSpec(scheduleConfig);
  const scheduleSummary = buildCampaignScheduleSummary(scheduleConfig);

  const configHash = createHash("sha256")
    .update(
      stableSerialize({
        workspaceId,
        scenarioId,
        nodeId,
        scheduleConfig,
        scheduleSpec,
        scheduledNodeSourceNodeId: scheduledNode?.sourceNodeId,
        scheduledNodeTemplateName: scheduledNodeData?.templateName,
        scheduledNodeTemplateLanguage: scheduledNodeData?.templateLanguage,
        scheduledNodeTemplateCategory: scheduledNodeData?.templateCategory,
        scheduledNodeMessageText: scheduledNodeData?.messageText,
        scheduledNodeTelegramSourceId: scheduledNodeData?.telegramSourceId,
        timezone,
        workflowType: CAMPAIGN_SCHEDULE_ACTION_WORKFLOW,
        workflowId: buildCampaignScheduleActionWorkflowId({ scheduleId }),
      })
    )
    .digest("hex");

  return {
    action: normalizeString(scenario?.status) === "active" ? "upsert" : "pause",
    workspaceId,
    scenarioId,
    nodeId,
    scheduleType: scheduleConfig.mode,
    timezone,
    scheduleConfig,
    scheduleSpec,
    scheduleSummary,
    scheduleId,
    configHash,
  };
}

async function persistScheduleRecord(params: {
  model: CampaignNodeScheduleModel;
  desired: CampaignNodeScheduleDesiredState;
  now: Date;
  status: "active" | "paused" | "deleted" | "error";
  lastError?: string | null;
}) {
  if (params.desired.action === "delete") {
    await params.model
      .findOneAndUpdate(
        {
          workspaceId: params.desired.workspaceId,
          scenarioId: params.desired.scenarioId,
          nodeId: params.desired.nodeId,
        },
        {
          $set: {
            status: params.status,
            lastReconciledAt: params.now,
            lastErrorAt: params.lastError ? params.now : null,
            lastError: params.lastError || null,
          },
        },
        { new: true, upsert: false }
      )
      .lean();
    return;
  }

  await params.model
    .findOneAndUpdate(
      {
        workspaceId: params.desired.workspaceId,
        scenarioId: params.desired.scenarioId,
        nodeId: params.desired.nodeId,
      },
      {
        $set: {
          workspaceId: params.desired.workspaceId,
          scenarioId: params.desired.scenarioId,
          nodeId: params.desired.nodeId,
          scheduleType: params.desired.scheduleType,
          timezone: params.desired.timezone,
          cronExpression: null,
          scheduleConfig: params.desired.scheduleConfig,
          scheduleSpec: params.desired.scheduleSpec,
          scheduleSummary: params.desired.scheduleSummary,
          scheduleId: params.desired.scheduleId,
          configHash: params.desired.configHash,
          status: params.status,
          lastReconciledAt: params.now,
          lastErrorAt: params.lastError ? params.now : null,
          lastError: params.lastError || null,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    )
    .lean();
}

export async function reconcileCampaignNodeSchedule(
  node: CampaignNodeLike,
  scenario: CampaignScenarioLike,
  options?: {
    now?: Date;
    model?: CampaignNodeScheduleModel;
  }
): Promise<CampaignNodeScheduleReconcileResult> {
  const desired = resolveCampaignNodeScheduleDefinition(node, scenario);
  if (!desired) {
    return {
      ok: false,
      action: "invalid",
      errorMessage: "Missing workspaceId, scenarioId, or nodeId",
    };
  }

  const now = options?.now || new Date();
  const model = options?.model || CampaignNodeSchedule;
  const existing = (await model
    .findOne({
      workspaceId: desired.workspaceId,
      scenarioId: desired.scenarioId,
      nodeId: desired.nodeId,
    })
    .lean()) as CampaignNodeScheduleRecord | null;

  if (!isTemporalConfigured()) {
    await persistScheduleRecord({
      model,
      desired,
      now,
      status: "error",
      lastError: "Temporal is not configured for campaign schedules",
    });
    return {
      ok: false,
      action: "not_configured",
      scheduleId: desired.scheduleId,
      errorMessage: "Temporal is not configured for campaign schedules",
    };
  }

  try {
    if (desired.action === "delete") {
      const deleted = await deleteTemporalSchedule(desired.scheduleId);
      await persistScheduleRecord({
        model,
        desired,
        now,
        status: "deleted",
        lastError: null,
      });
      return {
        ok: true,
        action: deleted || existing ? "deleted" : "noop",
        scheduleId: desired.scheduleId,
      };
    }

    const upsertResult = await upsertTemporalSchedule(desired);
    const nextStatus = desired.action === "pause" ? "paused" : "active";
    await persistScheduleRecord({
      model,
      desired,
      now,
      status: nextStatus,
      lastError: null,
    });

    const previousStatus = normalizeString(existing?.status);
    let action: CampaignNodeScheduleReconcileResult["action"];
    if (!upsertResult.existed) {
      action = desired.action === "pause" ? "paused" : "created";
    } else if (desired.action === "pause") {
      action = previousStatus === "paused" ? "noop" : "paused";
    } else if (upsertResult.wasPaused || previousStatus === "paused") {
      action = "resumed";
    } else if (normalizeString(existing?.configHash) !== desired.configHash) {
      action = "updated";
    } else {
      action = "noop";
    }

    return {
      ok: true,
      action,
      scheduleId: desired.scheduleId,
      configHash: desired.configHash,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error || "Unknown error");
    await persistScheduleRecord({
      model,
      desired,
      now,
      status: "error",
      lastError: errorMessage,
    });
    return {
      ok: false,
      action: "error",
      scheduleId: desired.scheduleId,
      configHash: desired.action === "delete" ? undefined : desired.configHash,
      errorMessage,
    };
  }
}

export async function reconcileCampaignScenarioSchedules(
  scenario:
    | (CampaignScenarioLike & {
        nodes?: CampaignNodeRecord[];
        edges?: CampaignEdgeRecord[];
      })
    | null,
  options?: {
    now?: Date;
    model?: CampaignNodeScheduleModel;
  }
): Promise<CampaignScenarioScheduleReconcileSummary> {
  const model = options?.model || CampaignNodeSchedule;
  const workspaceId = normalizeString(scenario?.workspaceId);
  const scenarioId = readEntityId(scenario?._id);
  const nodes = Array.isArray(scenario?.nodes) ? scenario.nodes : [];
  const results: CampaignNodeScheduleReconcileResult[] = [];
  const activeNodeIds = new Set<string>();
  // Builder graphs schedule only bulk roots, so other nodes cost no Temporal
  // lookup; a stale record for one is removed as an orphan below.
  const scheduleCandidates =
    normalizeString(scenario?.mode) === "bulk_campaign"
      ? nodes
      : nodes.filter(isBulkCampaignRootNode);

  for (const node of scheduleCandidates) {
    const nodeId = normalizeString(node?.id);
    if (!nodeId) continue;
    activeNodeIds.add(nodeId);
    results.push(await reconcileCampaignNodeSchedule(node, scenario, options));
  }

  if (!workspaceId || !scenarioId || typeof model.find !== "function") {
    assertScheduleReconciliationSucceeded(results);
    return {
      reconciled: results,
      orphanedDeletes: [],
    };
  }

  const existingRecords = (await model
    .find({
      workspaceId,
      scenarioId,
      status: { $ne: "deleted" },
    })
    .lean()) as CampaignNodeScheduleRecord[];
  const orphanedDeletes: CampaignNodeScheduleReconcileResult[] = [];

  for (const record of existingRecords) {
    const recordNodeId = normalizeString(record.nodeId);
    if (!recordNodeId || activeNodeIds.has(recordNodeId)) {
      continue;
    }

    orphanedDeletes.push(
      await reconcileCampaignNodeSchedule(
        { id: recordNodeId, data: {} },
        {
          _id: scenarioId,
          workspaceId,
          mode: "other",
          status: "draft",
          timezone: scenario?.timezone,
        },
        options
      )
    );
  }

  assertScheduleReconciliationSucceeded([...results, ...orphanedDeletes]);
  return { reconciled: results, orphanedDeletes };
}

export async function retireCampaignScenarioSchedules(params: {
  workspaceId: string;
  scenarioId: string;
  nodes?: CampaignNodeRecord[];
  timezone?: string;
  now?: Date;
  model?: CampaignNodeScheduleModel;
}): Promise<CampaignNodeScheduleReconcileResult[]> {
  const workspaceId = normalizeString(params.workspaceId);
  const scenarioId = normalizeString(params.scenarioId);
  if (!workspaceId || !scenarioId) {
    return [
      {
        ok: false,
        action: "invalid",
        errorMessage: "Missing workspaceId or scenarioId",
      },
    ];
  }

  const model = params.model || CampaignNodeSchedule;
  const nodeIds = new Set<string>();
  const providedNodes = Array.isArray(params.nodes) ? params.nodes : [];

  for (const node of providedNodes) {
    const nodeId = normalizeString(node?.id);
    if (nodeId) {
      nodeIds.add(nodeId);
    }
  }

  if (typeof model.find === "function") {
    const existingRecords = (await model
      .find({
        workspaceId,
        scenarioId,
        status: { $ne: "deleted" },
      })
      .lean()) as CampaignNodeScheduleRecord[];

    for (const record of existingRecords) {
      const nodeId = normalizeString(record.nodeId);
      if (nodeId) {
        nodeIds.add(nodeId);
      }
    }
  }

  const results: CampaignNodeScheduleReconcileResult[] = [];
  for (const nodeId of nodeIds) {
    results.push(
      await reconcileCampaignNodeSchedule(
        { id: nodeId, data: {} },
        {
          _id: scenarioId,
          workspaceId,
          mode: "conversation",
          status: "draft",
          timezone: params.timezone,
        },
        {
          now: params.now,
          model,
        }
      )
    );
  }

  assertScheduleReconciliationSucceeded(results);
  return results;
}

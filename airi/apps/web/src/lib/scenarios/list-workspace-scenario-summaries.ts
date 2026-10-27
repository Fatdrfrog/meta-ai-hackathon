import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { parsePositiveInt } from "@/lib/api/query-params";
import {
  applyLookedUpLinkedParentScenarioIds,
  attachLinkedParentScenarioIds,
  buildLinkedParentScenarioIdsLookupStage,
} from "@/lib/scenarios/linked-parent-summaries";
import { serializeScenarioSummary } from "@/lib/scenarios/scenario-summary-serialization";
import { Scenario } from "@/models/scenario";
import {
  normalizeScenarioMode,
  type ScenarioMode,
  type ScenarioSummaryDTO,
} from "@icecore/scenario-contracts";
import { Types, type PipelineStage } from "mongoose";

export const SCENARIO_LIST_DEFAULT_LIMIT = 60;
export const SCENARIO_LIST_MAX_LIMIT = 200;
const SCENARIO_LIST_MAX_PAGES = 20;

type ScenarioListCursor = {
  /** Stored priority (0–1000); higher = first in list */
  priority: number;
  id: string;
};

/** "inactive" is every stored status other than active (drafts and legacy). */
export type ScenarioListStatusFilter = "active" | "inactive" | "all";

export type ListWorkspaceScenarioSummariesParams = {
  workspaceId: string;
  mode?: ScenarioMode | "all" | null;
  status?: ScenarioListStatusFilter | null;
  limit?: number;
  cursor?: string | null;
  /** Server-side time limit for the list query; omitted means none. */
  maxTimeMS?: number;
};

export type WorkspaceScenarioSummaryPage = {
  items: ScenarioSummaryDTO[];
  nextCursor: string | null;
  hasMore: boolean;
};

function encodeScenarioListCursor(cursor: ScenarioListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeScenarioListCursor(
  raw: string | null | undefined
): ScenarioListCursor | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    ) as Partial<ScenarioListCursor>;
    if (
      !decoded ||
      typeof decoded.id !== "string" ||
      typeof decoded.priority !== "number" ||
      !Number.isFinite(decoded.priority)
    ) {
      return null;
    }
    if (!Types.ObjectId.isValid(decoded.id)) return null;
    return {
      priority: decoded.priority,
      id: decoded.id,
    };
  } catch {
    return null;
  }
}

function buildScenarioModeFilter(
  mode: ScenarioMode | null
): Record<string, unknown> | null {
  if (!mode) return null;
  if (mode === "conversation") {
    // Backwards compatibility: treat any non-bulk mode (including missing/legacy values)
    // as conversation so older WhatsApp-flow scenario documents still load.
    return { mode: { $ne: "bulk_campaign" } };
  }
  return { mode };
}

function resolveListMode(
  mode: ListWorkspaceScenarioSummariesParams["mode"]
): ScenarioMode | null {
  if (mode === "all" || mode === null) return null;
  if (mode === undefined) return normalizeScenarioMode(undefined);
  return normalizeScenarioMode(mode);
}

function buildScenarioStatusFilter(
  status: ScenarioListStatusFilter | null | undefined
): Record<string, unknown> | null {
  if (status === "active") return { status: "active" };
  if (status === "inactive") return { status: { $ne: "active" } };
  return null;
}

function buildScenarioListMatch(params: {
  workspaceId: string;
  mode: ScenarioMode | null;
  status?: ScenarioListStatusFilter | null;
  cursor: ScenarioListCursor | null;
}): Record<string, unknown> {
  const queryFilters: Record<string, unknown>[] = [
    { workspaceId: params.workspaceId },
    { deletedAt: null },
  ];
  const modeFilter = buildScenarioModeFilter(params.mode);
  if (modeFilter) {
    queryFilters.push(modeFilter);
  }
  const statusFilter = buildScenarioStatusFilter(params.status);
  if (statusFilter) {
    queryFilters.push(statusFilter);
  }
  if (params.cursor) {
    const cursorId = new Types.ObjectId(params.cursor.id);
    queryFilters.push({
      $or: [
        { priority: { $lt: params.cursor.priority } },
        {
          priority: params.cursor.priority,
          _id: { $gt: cursorId },
        },
      ],
    });
  }
  return { $and: queryFilters };
}

function buildScenarioListPipeline(params: {
  workspaceId: string;
  match: Record<string, unknown>;
  limit: number;
}): PipelineStage[] {
  return [
    { $match: params.match },
    { $sort: { priority: -1, _id: 1 } },
    { $limit: params.limit + 1 },
    {
      $project: {
        name: 1,
        description: 1,
        status: 1,
        mode: 1,
        timezone: 1,
        priority: 1,
        presetId: 1,
        presetVersion: 1,
        segmentKey: 1,
        matchingRole: 1,
        entryPolicy: 1,
        createdAt: 1,
        updatedAt: 1,
        nodeCount: {
          $cond: [{ $isArray: "$nodes" }, { $size: "$nodes" }, 0],
        },
        edgeCount: {
          $cond: [{ $isArray: "$edges" }, { $size: "$edges" }, 0],
        },
        nodes: {
          $map: {
            input: {
              $cond: [{ $isArray: "$nodes" }, "$nodes", []],
            },
            as: "node",
            in: {
              id: "$$node.id",
              data: {
                kind: "$$node.data.kind",
                triggerType: "$$node.data.triggerType",
                triggerConfig: "$$node.data.triggerConfig",
                actionType: "$$node.data.actionType",
                source: "$$node.data.source",
                // Builder campaigns are told apart by their bulk root alone.
                bulkRootConfig: {
                  $cond: [
                    { $eq: ["$$node.data.kind", "bulk"] },
                    {
                      workflowKind: "$$node.data.bulkRootConfig.workflowKind",
                    },
                    "$$REMOVE",
                  ],
                },
                actionWhatsAppServiceMessage: {
                  $cond: [
                    {
                      $ne: [
                        {
                          $type: "$$node.data.actionWhatsAppServiceMessage",
                        },
                        "missing",
                      ],
                    },
                    true,
                    "$$REMOVE",
                  ],
                },
              },
            },
          },
        },
      },
    },
    // Linked parents ride along, so the list is one round trip.
    buildLinkedParentScenarioIdsLookupStage(params.workspaceId),
  ];
}

async function loadScenarioListRows(params: {
  workspaceId: string;
  match: Record<string, unknown>;
  limit: number;
  maxTimeMS?: number;
}): Promise<{
  rows: Record<string, unknown>[];
  linkedParentsLookedUp: boolean;
}> {
  const queryOptions =
    params.maxTimeMS === undefined
      ? undefined
      : { maxTimeMS: params.maxTimeMS };
  try {
    const rows = (await Scenario.aggregate(
      buildScenarioListPipeline(params),
      queryOptions
    )) as Record<string, unknown>[];
    return { rows, linkedParentsLookedUp: true };
  } catch (error) {
    logger.error("scenarios.list_aggregate_failed", error, {
      workspaceId: params.workspaceId,
    });
    const rows = await Scenario.find(params.match, undefined, queryOptions)
      .select(
        "name description status mode timezone priority presetId presetVersion segmentKey matchingRole entryPolicy createdAt updatedAt nodes.id nodes.data.kind nodes.data.triggerType nodes.data.triggerConfig nodes.data.actionType nodes.data.source nodes.data.actionWhatsAppServiceMessage nodes.data.bulkRootConfig.workflowKind edges.id"
      )
      .sort({ priority: -1, _id: 1 })
      .limit(params.limit + 1)
      .lean<Record<string, unknown>[]>({ defaults: false });
    return { rows, linkedParentsLookedUp: false };
  }
}

export async function listWorkspaceScenarioSummaries(
  params: ListWorkspaceScenarioSummariesParams
): Promise<WorkspaceScenarioSummaryPage> {
  const limit = parsePositiveInt(
    params.limit,
    SCENARIO_LIST_DEFAULT_LIMIT,
    1,
    SCENARIO_LIST_MAX_LIMIT
  );
  const mode = resolveListMode(params.mode);
  const cursor = decodeScenarioListCursor(params.cursor);
  const match = buildScenarioListMatch({
    workspaceId: params.workspaceId,
    mode,
    status: params.status,
    cursor,
  });

  await connectDB();
  const { rows, linkedParentsLookedUp } = await loadScenarioListRows({
    workspaceId: params.workspaceId,
    match,
    limit,
    maxTimeMS: params.maxTimeMS,
  });
  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const items = linkedParentsLookedUp
    ? sliced.map(row =>
        serializeScenarioSummary(applyLookedUpLinkedParentScenarioIds(row))
      )
    : await attachLinkedParentScenarioIds(
        sliced.map(serializeScenarioSummary),
        params.workspaceId
      );

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = sliced[sliced.length - 1];
    const lastId = String(last?._id || "");
    const rawPriority = last?.priority;
    const lastPriority =
      typeof rawPriority === "number" && Number.isFinite(rawPriority)
        ? rawPriority
        : 0;
    if (lastId && Types.ObjectId.isValid(lastId)) {
      nextCursor = encodeScenarioListCursor({
        id: lastId,
        priority: lastPriority,
      });
    }
  }

  return {
    items,
    nextCursor,
    hasMore,
  };
}

export async function listAllWorkspaceScenarioSummaries(
  workspaceId: string
): Promise<ScenarioSummaryDTO[] | null> {
  try {
    const items: ScenarioSummaryDTO[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < SCENARIO_LIST_MAX_PAGES; page += 1) {
      const result = await listWorkspaceScenarioSummaries({
        workspaceId,
        mode: "all",
        limit: SCENARIO_LIST_MAX_LIMIT,
        cursor,
      });
      items.push(...result.items);
      if (!result.hasMore || !result.nextCursor) {
        return items;
      }
      cursor = result.nextCursor;
    }

    return items;
  } catch (error) {
    logger.error("scenarios.list_failed", error, { workspaceId });
    return null;
  }
}

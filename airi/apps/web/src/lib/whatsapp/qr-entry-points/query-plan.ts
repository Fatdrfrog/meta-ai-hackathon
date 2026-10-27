import connectDB from "@/lib/mongoose";
import { WhatsAppQrEntryPoint } from "@/models/whatsapp-qr-entry-point";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import {
  normalizeWhatsAppQrPlacementNameSearch,
  unicodePrefixSuccessor,
} from "./normalization";

export type WhatsAppQrManagerFacet =
  | { kind: "source"; value: string }
  | { kind: "status"; value: "DRAFT" | "ACTIVE" | "DETACHED" }
  | { kind: "assignment"; value: "assigned" | "unassigned" };

export type WhatsAppQrManagerCursorTuple =
  | {
      mode: "list";
      updatedAt: string;
      entryPointId: string;
    }
  | {
      mode: "search";
      placementNameSearch: string;
      entryPointId: string;
    };

export type WhatsAppQrManagerQueryShape = {
  mode: "list" | "search";
  filter: Record<string, unknown>;
  sort:
    | { updatedAt: -1; entryPointId: 1 }
    | { placementNameSearch: 1; entryPointId: 1 };
  hint: string;
  collation: { locale: "simple" };
  limit: number;
};

const INDEX_NAMES = {
  list: {
    base: "whatsapp_qr_manager_list_base_v1",
    source: "whatsapp_qr_manager_list_source_v1",
    status: "whatsapp_qr_manager_list_status_v1",
    assignment: "whatsapp_qr_manager_list_assignment_v1",
  },
  search: {
    base: "whatsapp_qr_manager_search_base_v1",
    source: "whatsapp_qr_manager_search_source_v1",
    status: "whatsapp_qr_manager_search_status_v1",
    assignment: "whatsapp_qr_manager_search_assignment_v1",
  },
} as const;

function requiredString(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error("INVALID_INPUT");
  return normalized;
}

function facetFilter(
  facet: WhatsAppQrManagerFacet | undefined
): Record<string, string> {
  if (!facet) return {};
  const value = requiredString(facet.value);
  switch (facet.kind) {
    case "source":
      return { sourceId: value };
    case "status":
      if (!(["DRAFT", "ACTIVE", "DETACHED"] as const).includes(facet.value)) {
        throw new Error("INVALID_INPUT");
      }
      return { status: value };
    case "assignment":
      if (facet.value !== "assigned" && facet.value !== "unassigned") {
        throw new Error("INVALID_INPUT");
      }
      return { assignmentState: value };
    default: {
      const _exhaustive: never = facet;
      return _exhaustive;
    }
  }
}

export function buildWhatsAppQrManagerQueryShape(params: {
  workspaceId: string;
  query?: string;
  facets: readonly WhatsAppQrManagerFacet[];
  after?: WhatsAppQrManagerCursorTuple;
  limit: number;
}): WhatsAppQrManagerQueryShape {
  const workspaceId = requiredString(params.workspaceId);
  if (
    params.facets.length > 1 ||
    !Number.isSafeInteger(params.limit) ||
    params.limit < 1 ||
    params.limit > 51
  ) {
    throw new Error("INVALID_INPUT");
  }
  const facet = params.facets[0];
  const facetKind = facet?.kind ?? "base";
  const fixedFilter = {
    workspaceId,
    ...facetFilter(facet),
  };
  const query =
    params.query === undefined || params.query.trim() === ""
      ? ""
      : normalizeWhatsAppQrPlacementNameSearch(params.query);

  if (!query) {
    if (params.query !== undefined && params.query.trim()) {
      throw new Error("INVALID_INPUT");
    }
    if (params.after && params.after.mode !== "list") {
      throw new Error("INVALID_INPUT");
    }
    const filter: Record<string, unknown> = { ...fixedFilter };
    if (params.after) {
      const updatedAt = new Date(params.after.updatedAt);
      if (Number.isNaN(updatedAt.getTime())) throw new Error("INVALID_INPUT");
      filter.$or = [
        { updatedAt: { $lt: updatedAt } },
        {
          updatedAt,
          entryPointId: { $gt: requiredString(params.after.entryPointId) },
        },
      ];
    }
    return {
      mode: "list",
      filter,
      sort: { updatedAt: -1, entryPointId: 1 },
      hint: INDEX_NAMES.list[facetKind],
      collation: { locale: "simple" },
      limit: params.limit,
    };
  }

  const upperBound = unicodePrefixSuccessor(query);
  if (!upperBound) throw new Error("INVALID_INPUT");
  if (params.after && params.after.mode !== "search") {
    throw new Error("INVALID_INPUT");
  }
  const prefixRange = {
    placementNameSearch: { $gte: query, $lt: upperBound },
  };
  const filter: Record<string, unknown> = {
    ...fixedFilter,
    ...prefixRange,
  };
  if (params.after) {
    const placementNameSearch = requiredString(
      params.after.placementNameSearch
    );
    filter.$and = [
      prefixRange,
      {
        $or: [
          {
            placementNameSearch: {
              $gt: placementNameSearch,
              $lt: upperBound,
            },
          },
          {
            placementNameSearch,
            entryPointId: { $gt: requiredString(params.after.entryPointId) },
          },
        ],
      },
    ];
    delete filter.placementNameSearch;
  }
  return {
    mode: "search",
    filter,
    sort: { placementNameSearch: 1, entryPointId: 1 },
    hint: INDEX_NAMES.search[facetKind],
    collation: { locale: "simple" },
    limit: params.limit,
  };
}

function walkPlan(
  value: unknown,
  visit: (record: Record<string, unknown>) => void
) {
  if (Array.isArray(value)) {
    for (const item of value) walkPlan(item, visit);
    return;
  }
  const record = asNullableRecord(value);
  if (!record) return;
  visit(record);
  for (const child of Object.values(record)) walkPlan(child, visit);
}

export function assertWhatsAppQrManagerExplainPlan(params: {
  explain: unknown;
  expectedIndexName: string;
  limit: number;
}): void {
  const explain = asNullableRecord(params.explain);
  const planner = asNullableRecord(explain?.queryPlanner);
  const winningPlan = planner?.winningPlan;
  const executionStats = asNullableRecord(explain?.executionStats);
  let expectedIndexSeen = false;
  let invalidStage = false;
  let postFilter = false;
  walkPlan(winningPlan, node => {
    if (node.stage === "COLLSCAN" || node.stage === "SORT") invalidStage = true;
    if (node.indexName === params.expectedIndexName) expectedIndexSeen = true;
    if (node.filter !== undefined && node.filter !== null) postFilter = true;
  });
  walkPlan(executionStats?.executionStages, node => {
    if (node.stage === "COLLSCAN" || node.stage === "SORT") invalidStage = true;
    if (node.filter !== undefined && node.filter !== null) postFilter = true;
  });
  const docs = executionStats?.totalDocsExamined;
  const keys = executionStats?.totalKeysExamined;
  const bounded =
    typeof docs === "number" &&
    typeof keys === "number" &&
    docs <= params.limit &&
    keys <= params.limit + 1;
  if (
    !winningPlan ||
    invalidStage ||
    postFilter ||
    !expectedIndexSeen ||
    !bounded
  ) {
    throw new Error("WHATSAPP_QR_MANAGER_QUERY_PLAN_INVALID");
  }
}

export type WhatsAppQrManagerQueryPlanEvidence = {
  mode: "list" | "search";
  facet: "base" | WhatsAppQrManagerFacet["kind"];
  indexName: string;
  nReturned: number;
  totalDocsExamined: number;
  totalKeysExamined: number;
};

export async function verifyWhatsAppQrManagerQueryPlans(params: {
  workspaceId: string;
  sourceId: string;
  limit?: number;
  emit?: (line: string) => void;
}): Promise<WhatsAppQrManagerQueryPlanEvidence[]> {
  await connectDB();
  const limit = params.limit ?? 50;
  const facets: Array<WhatsAppQrManagerFacet | undefined> = [
    undefined,
    { kind: "source", value: requiredString(params.sourceId) },
    { kind: "status", value: "ACTIVE" },
    { kind: "assignment", value: "assigned" },
  ];
  const evidence: WhatsAppQrManagerQueryPlanEvidence[] = [];
  for (const query of [undefined, "a"] as const) {
    for (const facet of facets) {
      const shape = buildWhatsAppQrManagerQueryShape({
        workspaceId: params.workspaceId,
        ...(query ? { query } : {}),
        facets: facet ? [facet] : [],
        limit,
      });
      const explain = (await WhatsAppQrEntryPoint.find(shape.filter)
        .sort(shape.sort)
        .hint(shape.hint)
        .collation(shape.collation)
        .limit(shape.limit)
        .explain("executionStats")) as unknown;
      assertWhatsAppQrManagerExplainPlan({
        explain,
        expectedIndexName: shape.hint,
        limit,
      });
      const stats = asNullableRecord(
        asNullableRecord(explain)?.executionStats
      )!;
      const row: WhatsAppQrManagerQueryPlanEvidence = {
        mode: shape.mode,
        facet: facet?.kind ?? "base",
        indexName: shape.hint,
        nReturned: Number(stats.nReturned),
        totalDocsExamined: Number(stats.totalDocsExamined),
        totalKeysExamined: Number(stats.totalKeysExamined),
      };
      evidence.push(row);
      params.emit?.(JSON.stringify(row));
    }
  }
  return evidence;
}

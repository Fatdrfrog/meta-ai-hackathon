import {
  normalizeScenarioMatchingRole,
  normalizeScenarioMode,
  normalizeScenarioPriority,
  normalizeScenarioStatus,
  normalizeScenarioTimezone,
  type ScenarioNodeData,
  type ScenarioSummaryDTO,
} from "@icecore/scenario-contracts";
import { resolveScenarioEntryPolicy } from "@/lib/airi/scenario/scenario-entry-policy";
import { resolveScenarioBuilderSummaryFromNodes } from "@/lib/scenarios/builder-summary";
import { readNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";

type ScenarioDoc = Record<string, unknown>;

type SerializedScenarioCoreFields = Pick<
  ScenarioSummaryDTO,
  | "_id"
  | "name"
  | "description"
  | "status"
  | "mode"
  | "timezone"
  | "priority"
  | "presetId"
  | "presetVersion"
  | "segmentKey"
  | "matchingRole"
  | "entryPolicy"
  | "linkedParentScenarioIds"
  | "builderSummary"
  | "createdAt"
  | "updatedAt"
>;

export function normalizeLinkedParentScenarioIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0
  );
}

function serializeTimestamp(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

function serializeScenarioCoreFields(
  doc: ScenarioDoc,
  rawNodes: unknown[]
): SerializedScenarioCoreFields {
  return {
    _id: String(doc._id ?? ""),
    name: typeof doc.name === "string" ? doc.name : "Untitled scenario",
    description: typeof doc.description === "string" ? doc.description : "",
    status: normalizeScenarioStatus(doc.status),
    mode: normalizeScenarioMode(doc.mode),
    timezone: normalizeScenarioTimezone(doc.timezone),
    priority: normalizeScenarioPriority(doc.priority),
    presetId: normalizeOptionalString(doc.presetId),
    presetVersion: normalizeOptionalString(doc.presetVersion),
    segmentKey: normalizeOptionalString(doc.segmentKey),
    matchingRole: normalizeScenarioMatchingRole(doc.matchingRole),
    entryPolicy: resolveScenarioEntryPolicy(doc),
    linkedParentScenarioIds: normalizeLinkedParentScenarioIds(
      doc.linkedParentScenarioIds
    ),
    builderSummary: resolveScenarioBuilderSummaryFromNodes(
      rawNodes as Array<{ data?: ScenarioNodeData | null }>
    ),
    createdAt: serializeTimestamp(doc.createdAt),
    updatedAt: serializeTimestamp(doc.updatedAt),
  };
}

function readCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

export function toScenarioSummary(doc: ScenarioDoc): ScenarioSummaryDTO {
  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : [];

  return {
    ...serializeScenarioCoreFields(doc, rawNodes),
    nodeCount: readCount(doc.nodeCount, rawNodes.length),
    edgeCount: readCount(
      doc.edgeCount,
      Array.isArray(doc.edges) ? doc.edges.length : 0
    ),
  };
}

export function serializeScenarioSummary(doc: ScenarioDoc): ScenarioSummaryDTO {
  return toScenarioSummary(doc);
}

export function serializeScenarioCoreFieldsForDocument(
  doc: ScenarioDoc,
  rawNodes: unknown[]
): SerializedScenarioCoreFields {
  return serializeScenarioCoreFields(doc, rawNodes);
}

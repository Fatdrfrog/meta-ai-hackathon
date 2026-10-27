import "server-only";

import { createHash } from "node:crypto";
import { WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH } from "@icecore/scenario-contracts";
import connectDB from "@/lib/mongoose";
import { WhatsAppQrCode } from "@/models/whatsapp-qr-code";
import {
  WhatsAppQrEntryPoint,
  type WhatsAppQrEntryPointRecord,
} from "@/models/whatsapp-qr-entry-point";
import { WhatsAppQrOperation } from "@/models/whatsapp-qr-operation";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import type { WhatsAppQrManagerListItem, WhatsAppQrManagerPage } from "./dto";
import { loadWhatsAppQrAssignmentSummaries } from "./assignment-summary";
import { assertWhatsAppQrUnassignedWritesEnabled } from "./indexes";
import {
  normalizeWhatsAppQrEntryPointUuid,
  normalizeWhatsAppQrPlacementNameSearch,
  unicodePrefixSuccessor,
} from "./normalization";
import {
  buildWhatsAppQrManagerQueryShape,
  type WhatsAppQrManagerCursorTuple,
  type WhatsAppQrManagerFacet,
} from "./query-plan";
import { resolveWhatsAppQrReadiness } from "./readiness";

export type WhatsAppQrManagerErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VERSION_CONFLICT";

export class WhatsAppQrManagerError extends Error {
  constructor(
    readonly code: WhatsAppQrManagerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WhatsAppQrManagerError";
  }
}

type ManagerCursor = {
  v: 1;
  mode: "list" | "search";
  facet: { kind: WhatsAppQrManagerFacet["kind"]; value: string } | null;
  filterDigest: string;
  sort: WhatsAppQrManagerCursorTuple;
};

type CurrentCodeProjection = {
  codeId: string;
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  providerCode?: string;
  deepLink?: string;
  placementBindingState: string;
  routingState: string;
  providerState: string;
};

type OperationProjection = {
  workspaceId: string;
  entryPointId: string;
};

function invalid(message = "Invalid request"): never {
  throw new WhatsAppQrManagerError("INVALID_INPUT", message);
}

function requiredString(value: unknown, label: string, max = 256): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) invalid(`${label} is invalid`);
  return normalized;
}

function normalizePlacementName(value: unknown): string {
  return requiredString(value, "Placement name", 120);
}

function normalizeDesiredMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH
  ) {
    invalid("Desired message is invalid");
  }
  return value;
}

function buildFacets(params: {
  sourceId?: string;
  status?: "DRAFT" | "ACTIVE" | "DETACHED";
  assignment?: "assigned" | "unassigned";
}): WhatsAppQrManagerFacet[] {
  const facets: WhatsAppQrManagerFacet[] = [];
  if (params.sourceId !== undefined) {
    facets.push({
      kind: "source",
      value: requiredString(params.sourceId, "Source id"),
    });
  }
  if (params.status !== undefined) {
    if (!(["DRAFT", "ACTIVE", "DETACHED"] as const).includes(params.status)) {
      invalid("Status is invalid");
    }
    facets.push({ kind: "status", value: params.status });
  }
  if (params.assignment !== undefined) {
    if (
      params.assignment !== "assigned" &&
      params.assignment !== "unassigned"
    ) {
      invalid("Assignment is invalid");
    }
    facets.push({ kind: "assignment", value: params.assignment });
  }
  if (facets.length > 1) invalid("Only one facet is supported");
  return facets;
}

function filterDigest(params: {
  workspaceId: string;
  query?: string;
  facet?: WhatsAppQrManagerFacet;
}): string {
  const query =
    params.query === undefined || params.query.trim() === ""
      ? ""
      : normalizeWhatsAppQrPlacementNameSearch(params.query);
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: params.workspaceId,
        query,
        facet: params.facet ?? null,
      })
    )
    .digest("hex");
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(record).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function decodeCursor(
  value: string,
  expected: {
    mode: "list" | "search";
    facet?: WhatsAppQrManagerFacet;
    filterDigest: string;
    searchPrefix?: string;
  }
): WhatsAppQrManagerCursorTuple {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid("Cursor is invalid");
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    );
    if (
      !decoded ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      !exactKeys(decoded, ["v", "mode", "facet", "filterDigest", "sort"]) ||
      decoded.v !== 1 ||
      decoded.mode !== expected.mode ||
      decoded.filterDigest !== expected.filterDigest ||
      JSON.stringify(decoded.facet) !== JSON.stringify(expected.facet ?? null)
    ) {
      invalid("Cursor is invalid");
    }
    const sort = decoded.sort;
    if (!sort || typeof sort !== "object" || Array.isArray(sort)) {
      invalid("Cursor is invalid");
    }
    if (
      expected.mode === "list" &&
      exactKeys(sort, ["mode", "updatedAt", "entryPointId"]) &&
      sort.mode === "list" &&
      typeof sort.updatedAt === "string" &&
      new Date(sort.updatedAt).toISOString() === sort.updatedAt &&
      typeof sort.entryPointId === "string" &&
      normalizeWhatsAppQrEntryPointUuid(sort.entryPointId) === sort.entryPointId
    ) {
      return sort as WhatsAppQrManagerCursorTuple;
    }
    const searchUpperBound = expected.searchPrefix
      ? unicodePrefixSuccessor(expected.searchPrefix)
      : undefined;
    if (
      expected.mode === "search" &&
      exactKeys(sort, ["mode", "placementNameSearch", "entryPointId"]) &&
      sort.mode === "search" &&
      typeof sort.placementNameSearch === "string" &&
      sort.placementNameSearch.length > 0 &&
      normalizeWhatsAppQrPlacementNameSearch(sort.placementNameSearch) ===
        sort.placementNameSearch &&
      typeof expected.searchPrefix === "string" &&
      typeof searchUpperBound === "string" &&
      sort.placementNameSearch >= expected.searchPrefix &&
      sort.placementNameSearch < searchUpperBound &&
      typeof sort.entryPointId === "string" &&
      normalizeWhatsAppQrEntryPointUuid(sort.entryPointId) === sort.entryPointId
    ) {
      return sort as WhatsAppQrManagerCursorTuple;
    }
  } catch (error) {
    if (error instanceof WhatsAppQrManagerError) throw error;
  }
  invalid("Cursor is invalid");
}

function encodeCursor(params: {
  mode: "list" | "search";
  facet?: WhatsAppQrManagerFacet;
  filterDigest: string;
  sort: WhatsAppQrManagerCursorTuple;
}): string {
  const cursor: ManagerCursor = {
    v: 1,
    mode: params.mode,
    facet: params.facet ?? null,
    filterDigest: params.filterDigest,
    sort: params.sort,
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function isoDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) invalid("Persisted date is invalid");
  return date.toISOString();
}

export async function listWhatsAppQrEntryPoints(params: {
  workspaceId: string;
  query?: string;
  sourceId?: string;
  status?: "DRAFT" | "ACTIVE" | "DETACHED";
  assignment?: "assigned" | "unassigned";
  cursor?: string;
  limit?: number;
}): Promise<WhatsAppQrManagerPage> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const limit = params.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    invalid("Limit is invalid");
  }
  const facets = buildFacets(params);
  const query = params.query;
  const normalizedQuery =
    query === undefined || query.trim() === ""
      ? ""
      : normalizeWhatsAppQrPlacementNameSearch(query);
  if (query !== undefined && query.trim() && !normalizedQuery) {
    invalid("Query is invalid");
  }
  const mode = normalizedQuery ? "search" : "list";
  const digest = filterDigest({ workspaceId, query, facet: facets[0] });
  const after = params.cursor
    ? decodeCursor(params.cursor, {
        mode,
        facet: facets[0],
        filterDigest: digest,
        ...(normalizedQuery ? { searchPrefix: normalizedQuery } : {}),
      })
    : undefined;
  const shape = buildWhatsAppQrManagerQueryShape({
    workspaceId,
    ...(query !== undefined ? { query } : {}),
    facets,
    ...(after ? { after } : {}),
    limit: limit + 1,
  });

  await connectDB();
  const window = await WhatsAppQrEntryPoint.find(shape.filter)
    .sort(shape.sort)
    .hint(shape.hint)
    .collation(shape.collation)
    .limit(shape.limit)
    .lean<WhatsAppQrEntryPointRecord[]>();
  const pageRows = window.slice(0, limit);
  const entryPointIds = pageRows.map(row => row.entryPointId);
  const currentCodeIds = Array.from(
    new Set(
      pageRows
        .map(row => row.currentCodeId)
        .filter((value): value is string => Boolean(value))
    )
  );
  const [codes, operations, assignmentsByEntryPointId] = await Promise.all([
    currentCodeIds.length
      ? WhatsAppQrCode.find({
          workspaceId,
          codeId: { $in: currentCodeIds },
        })
          .select({
            _id: 0,
            codeId: 1,
            workspaceId: 1,
            entryPointId: 1,
            sourceId: 1,
            wabaId: 1,
            phoneNumberId: 1,
            providerCode: 1,
            deepLink: 1,
            placementBindingState: 1,
            routingState: 1,
            providerState: 1,
          })
          .lean<CurrentCodeProjection[]>()
      : Promise.resolve([]),
    entryPointIds.length
      ? WhatsAppQrOperation.find({
          workspaceId,
          entryPointId: { $in: entryPointIds },
          status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
        })
          .select({ _id: 0, workspaceId: 1, entryPointId: 1 })
          .lean<OperationProjection[]>()
      : Promise.resolve([]),
    loadWhatsAppQrAssignmentSummaries({
      workspaceId,
      assignments: pageRows,
    }),
  ]);
  const codeById = new Map(
    codes
      .filter(code => code.workspaceId === workspaceId)
      .map(code => [code.codeId, code])
  );
  const pending = new Set(
    operations
      .filter(operation => operation.workspaceId === workspaceId)
      .map(operation => operation.entryPointId)
  );
  const items = pageRows.map(entryPoint => {
    const candidateCode = entryPoint.currentCodeId
      ? codeById.get(entryPoint.currentCodeId)
      : undefined;
    const code =
      candidateCode?.entryPointId === entryPoint.entryPointId
        ? candidateCode
        : undefined;
    const reconcilePending = pending.has(entryPoint.entryPointId);
    const assignment =
      assignmentsByEntryPointId.get(entryPoint.entryPointId) ?? null;
    return {
      entryPointId: entryPoint.entryPointId,
      placementName: entryPoint.placementName,
      ...(entryPoint.desiredMessage !== undefined
        ? { desiredMessage: entryPoint.desiredMessage }
        : {}),
      ...(entryPoint.sourceId ? { sourceId: entryPoint.sourceId } : {}),
      status: entryPoint.status,
      version: entryPoint.version,
      updatedAt: isoDate(entryPoint.updatedAt),
      readiness: resolveWhatsAppQrReadiness({
        entryPoint,
        currentCode: code,
        reconcilePending,
      }),
      ...(code
        ? {
            currentCode: {
              codeId: code.codeId,
              ...(code.deepLink ? { deepLink: code.deepLink } : {}),
              placementBindingState: code.placementBindingState,
              routingState: code.routingState,
              providerState: code.providerState,
            },
          }
        : {}),
      reconcilePending,
      assignment,
    } satisfies WhatsAppQrManagerListItem;
  });
  const last = pageRows.at(-1);
  const nextCursor =
    window.length > limit && last
      ? encodeCursor({
          mode,
          facet: facets[0],
          filterDigest: digest,
          sort:
            mode === "search"
              ? {
                  mode: "search",
                  placementNameSearch: requiredString(
                    last.placementNameSearch,
                    "Placement search name"
                  ),
                  entryPointId: last.entryPointId,
                }
              : {
                  mode: "list",
                  updatedAt: isoDate(last.updatedAt),
                  entryPointId: last.entryPointId,
                },
        })
      : null;
  return { items, nextCursor };
}

export async function createUnassignedWhatsAppQrDraftEntryPoint(params: {
  workspaceId: string;
  entryPointId: string;
  placementName: string;
  desiredMessage?: string;
}): Promise<WhatsAppQrEntryPointRecord> {
  await assertWhatsAppQrUnassignedWritesEnabled();
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = normalizeWhatsAppQrEntryPointUuid(params.entryPointId);
  if (!entryPointId) invalid("Entry point id is invalid");
  const placementName = normalizePlacementName(params.placementName);
  const desiredMessage = normalizeDesiredMessage(params.desiredMessage);
  const values = {
    entryPointId,
    workspaceId,
    assignmentState: "unassigned" as const,
    placementName,
    placementNameSearch: normalizeWhatsAppQrPlacementNameSearch(placementName),
    ...(desiredMessage !== undefined ? { desiredMessage } : {}),
    status: "DRAFT" as const,
    version: 0,
  };
  try {
    return (await new WhatsAppQrEntryPoint(
      values
    ).save()) as WhatsAppQrEntryPointRecord;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    const existing = await WhatsAppQrEntryPoint.findOne({
      entryPointId,
    }).lean<WhatsAppQrEntryPointRecord | null>();
    if (
      existing &&
      existing.workspaceId === workspaceId &&
      existing.placementName === placementName &&
      existing.desiredMessage === desiredMessage &&
      !existing.scenarioId &&
      !existing.nodeId &&
      existing.assignmentState === "unassigned" &&
      existing.status === "DRAFT" &&
      existing.version === 0
    ) {
      return existing;
    }
    throw new WhatsAppQrManagerError(
      "CONFLICT",
      "Entry point replay conflicts"
    );
  }
}

export async function patchManagedWhatsAppQrEntryPoint(params: {
  workspaceId: string;
  entryPointId: string;
  expectedVersion: number;
  placementName?: string;
  /** Null clears the draft field; omission leaves it unchanged. */
  desiredMessage?: string | null;
}): Promise<WhatsAppQrEntryPointRecord> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = normalizeWhatsAppQrEntryPointUuid(params.entryPointId);
  if (!entryPointId) invalid("Entry point id is invalid");
  if (
    !Number.isSafeInteger(params.expectedVersion) ||
    params.expectedVersion < 0 ||
    (params.placementName === undefined && params.desiredMessage === undefined)
  ) {
    invalid("Patch is invalid");
  }
  await connectDB();
  const [existing, activeOperation] = await Promise.all([
    WhatsAppQrEntryPoint.findOne({
      workspaceId,
      entryPointId,
    }).lean<WhatsAppQrEntryPointRecord | null>(),
    WhatsAppQrOperation.exists({
      workspaceId,
      entryPointId,
      status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
    }),
  ]);
  if (!existing) throw new WhatsAppQrManagerError("NOT_FOUND", "Not found");
  if (activeOperation) {
    throw new WhatsAppQrManagerError(
      "CONFLICT",
      "Finish the active QR operation before editing this entry point"
    );
  }
  if (params.desiredMessage !== undefined && existing.status !== "DRAFT") {
    invalid("Active desiredMessage changes require apply_message");
  }
  try {
    const $set: Record<string, string> = {};
    const $unset: Record<string, 1> = {};
    if (params.placementName !== undefined) {
      const placementName = normalizePlacementName(params.placementName);
      $set.placementName = placementName;
      $set.placementNameSearch =
        normalizeWhatsAppQrPlacementNameSearch(placementName);
    }
    if (params.desiredMessage !== undefined) {
      if (params.desiredMessage === null) {
        $unset.desiredMessage = 1;
      } else {
        $set.desiredMessage = normalizeDesiredMessage(params.desiredMessage)!;
      }
    }
    const update = {
      ...(Object.keys($set).length ? { $set } : {}),
      ...(Object.keys($unset).length ? { $unset } : {}),
      $inc: { version: 1 },
    };
    const updated = await WhatsAppQrEntryPoint.findOneAndUpdate(
      {
        workspaceId,
        entryPointId,
        version: params.expectedVersion,
        status:
          params.desiredMessage !== undefined
            ? "DRAFT"
            : { $in: ["DRAFT", "ACTIVE"] },
      },
      update,
      { new: true, runValidators: true }
    ).lean<WhatsAppQrEntryPointRecord | null>();
    if (!updated) {
      throw new Error("ENTRY_POINT_VERSION_CONFLICT");
    }
    return updated;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "ENTRY_POINT_VERSION_CONFLICT"
    ) {
      throw new WhatsAppQrManagerError("VERSION_CONFLICT", "Version conflict");
    }
    if (error instanceof Error && /invalid|required/i.test(error.message)) {
      invalid("Patch is invalid");
    }
    throw error;
  }
}

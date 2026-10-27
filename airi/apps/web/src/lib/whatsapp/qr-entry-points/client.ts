/**
 * Browser-safe WhatsApp QR entry-point API client.
 * No server-only imports. Does not auto-fetch on import.
 */

import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import type {
  WhatsAppQrAssignmentSummary,
  WhatsAppQrEntryPointDetail,
  WhatsAppQrManagerPage,
  WhatsAppQrProviderCodesResponse,
  WhatsAppQrScenarioSummary,
} from "./dto";
import type {
  AssignWhatsAppQrEntryPointInput,
  RecoverDetachedWhatsAppQrEntryPointInput,
  UnassignWhatsAppQrEntryPointInput,
  WhatsAppQrAssignmentResult,
} from "./assignment";

export type {
  AssignWhatsAppQrEntryPointInput,
  RecoverDetachedWhatsAppQrEntryPointInput,
  UnassignWhatsAppQrEntryPointInput,
  WhatsAppQrAssignmentResult,
} from "./assignment";

export type {
  WhatsAppQrAssignmentSummary,
  WhatsAppQrCodeDetail,
  WhatsAppQrEntryPointDetail,
  WhatsAppQrManagerListItem,
  WhatsAppQrManagerPage,
  WhatsAppQrProviderCodeOption,
  WhatsAppQrProviderCodesResponse,
  WhatsAppQrScenarioSummary,
} from "./dto";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export type WhatsAppQrClientResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      error: string;
      code?: string;
      operationId?: string;
      currentAssignment?: WhatsAppQrAssignmentSummary | null;
    };

export type WhatsAppQrScenarioSummariesResponse = {
  summaries: Record<string, WhatsAppQrScenarioSummary>;
};

export type WhatsAppQrInspectResponse = {
  intent?: unknown;
  image?: unknown;
};

export type WhatsAppQrArtworkDownload = {
  blob: Blob;
  objectUrl: string;
  contentType: string;
  format: "png" | "svg";
};

export type WhatsAppQrCommandBody = {
  command: string;
  workspaceId: string;
  sourceId: string;
  entryPointId: string;
  [key: string]: unknown;
};

function errorFromBody(
  data: unknown,
  fallback: string
): {
  error: string;
  code?: string;
  currentAssignment?: WhatsAppQrAssignmentSummary | null;
} {
  const record = asNullableRecord(data);
  const error =
    (typeof record?.error === "string" && record.error.trim()) || fallback;
  return {
    error,
    ...(typeof record?.code === "string" && record.code.trim()
      ? { code: record.code.trim() }
      : {}),
    ...(record &&
    Object.prototype.hasOwnProperty.call(record, "currentAssignment")
      ? {
          currentAssignment:
            record.currentAssignment === null ||
            (typeof record.currentAssignment === "object" &&
              !Array.isArray(record.currentAssignment))
              ? (record.currentAssignment as WhatsAppQrAssignmentSummary | null)
              : undefined,
        }
      : {}),
  };
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<WhatsAppQrClientResult<T>> {
  try {
    const response = await fetch(input, init);
    const data = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const parsed = errorFromBody(data, "Request failed");
      return {
        ok: false,
        status: response.status,
        error: parsed.error,
        ...(parsed.code ? { code: parsed.code } : {}),
        ...(parsed.currentAssignment !== undefined
          ? { currentAssignment: parsed.currentAssignment }
          : {}),
      };
    }
    return { ok: true, data: data as T };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Network request failed",
    };
  }
}

function managerDetailPath(entryPointId: string): string {
  return `/api/whatsapp/qr-entry-points/entries/${encodeURIComponent(entryPointId)}`;
}

export function fetchWhatsAppQrEntryPoints(params: {
  workspaceId: string;
  query?: string;
  facet?:
    | { kind: "source"; sourceId: string }
    | { kind: "status"; status: "DRAFT" | "ACTIVE" | "DETACHED" }
    | { kind: "assignment"; assignment: "assigned" | "unassigned" };
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<WhatsAppQrClientResult<WhatsAppQrManagerPage>> {
  const query = new URLSearchParams({ workspaceId: params.workspaceId });
  if (params.query !== undefined) query.set("query", params.query);
  if (params.facet) {
    query.set("facet", params.facet.kind);
    query.set(
      "value",
      params.facet.kind === "source"
        ? params.facet.sourceId
        : params.facet.kind === "status"
          ? params.facet.status
          : params.facet.assignment
    );
  }
  if (params.cursor !== undefined) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  return requestJson<WhatsAppQrManagerPage>(
    `/api/whatsapp/qr-entry-points?${query.toString()}`,
    { signal: params.signal, cache: "no-store" }
  );
}

export function createWhatsAppQrDraft(params: {
  workspaceId: string;
  entryPointId: string;
  placementName: string;
  desiredMessage?: string;
  signal?: AbortSignal;
}): Promise<WhatsAppQrClientResult<WhatsAppQrEntryPointDetail>> {
  return requestJson<WhatsAppQrEntryPointDetail>(
    "/api/whatsapp/qr-entry-points",
    {
      method: "POST",
      headers: JSON_HEADERS,
      signal: params.signal,
      body: JSON.stringify({
        workspaceId: params.workspaceId,
        entryPointId: params.entryPointId,
        placementName: params.placementName,
        ...(params.desiredMessage !== undefined
          ? { desiredMessage: params.desiredMessage }
          : {}),
      }),
    }
  );
}

export function fetchWhatsAppQrEntryPoint(params: {
  workspaceId: string;
  entryPointId: string;
  signal?: AbortSignal;
}): Promise<WhatsAppQrClientResult<WhatsAppQrEntryPointDetail>> {
  const query = new URLSearchParams({ workspaceId: params.workspaceId });
  return requestJson<WhatsAppQrEntryPointDetail>(
    `${managerDetailPath(params.entryPointId)}?${query.toString()}`,
    { signal: params.signal, cache: "no-store" }
  );
}

export function patchWhatsAppQrEntryPoint(params: {
  workspaceId: string;
  entryPointId: string;
  expectedVersion: number;
  placementName?: string;
  /** Null clears a draft message; omission leaves it unchanged. */
  desiredMessage?: string | null;
  signal?: AbortSignal;
}): Promise<WhatsAppQrClientResult<WhatsAppQrEntryPointDetail>> {
  return requestJson<WhatsAppQrEntryPointDetail>(
    managerDetailPath(params.entryPointId),
    {
      method: "PATCH",
      headers: JSON_HEADERS,
      signal: params.signal,
      body: JSON.stringify({
        workspaceId: params.workspaceId,
        expectedVersion: params.expectedVersion,
        ...(params.placementName !== undefined
          ? { placementName: params.placementName }
          : {}),
        ...(params.desiredMessage !== undefined
          ? { desiredMessage: params.desiredMessage }
          : {}),
      }),
    }
  );
}

export async function fetchWhatsAppQrScenarioSummaries(params: {
  workspaceId: string;
  scenarioId: string;
  signal?: AbortSignal;
}): Promise<WhatsAppQrClientResult<WhatsAppQrScenarioSummariesResponse>> {
  const query = new URLSearchParams({ workspaceId: params.workspaceId });
  return requestJson<WhatsAppQrScenarioSummariesResponse>(
    `/api/scenarios/${encodeURIComponent(params.scenarioId)}/whatsapp-qr/summary?${query.toString()}`,
    { signal: params.signal, cache: "no-store" }
  );
}

export async function postWhatsAppQrCommand(params: {
  body: WhatsAppQrCommandBody;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<WhatsAppQrClientResult<unknown>> {
  const key = params.idempotencyKey.trim();
  if (!key) {
    return {
      ok: false,
      status: 400,
      error: "Idempotency-Key is required",
      code: "INVALID_INPUT",
    };
  }
  const result = await requestJson<{
    status?: string;
    operationId?: string;
  }>("/api/whatsapp/qr-entry-points/commands", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      "Idempotency-Key": key,
    },
    signal: params.signal,
    body: JSON.stringify(params.body),
  });
  if (result.ok && result.data?.status === "reconcile_required") {
    const operationId =
      typeof result.data.operationId === "string"
        ? result.data.operationId.trim()
        : "";
    return {
      ok: false,
      status: 202,
      error: "WhatsApp QR provider state requires reconciliation",
      code: "RECONCILE_REQUIRED",
      ...(operationId ? { operationId } : {}),
    };
  }
  return result;
}

export function postWhatsAppQrAssignmentCommand(params: {
  body:
    | ({ command: "assign" } & AssignWhatsAppQrEntryPointInput)
    | ({ command: "unassign" } & UnassignWhatsAppQrEntryPointInput)
    | ({ command: "recover" } & RecoverDetachedWhatsAppQrEntryPointInput);
  signal?: AbortSignal;
}): Promise<WhatsAppQrClientResult<WhatsAppQrAssignmentResult>> {
  return requestJson<WhatsAppQrAssignmentResult>(
    "/api/whatsapp/qr-entry-points/assignments",
    {
      method: "POST",
      headers: JSON_HEADERS,
      ...(params.signal ? { signal: params.signal } : {}),
      body: JSON.stringify(params.body),
    }
  );
}

export async function fetchWhatsAppQrProviderCodes(params: {
  workspaceId: string;
  sourceId: string;
  limit: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<WhatsAppQrClientResult<WhatsAppQrProviderCodesResponse>> {
  const query = new URLSearchParams({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    limit: String(params.limit),
  });
  if (params.cursor) query.set("cursor", params.cursor);
  return requestJson<WhatsAppQrProviderCodesResponse>(
    `/api/whatsapp/qr-entry-points/provider-codes?${query.toString()}`,
    { signal: params.signal, cache: "no-store" }
  );
}

export async function inspectWhatsAppQrImport(
  params: {
    workspaceId: string;
    sourceId: string;
    signal?: AbortSignal;
  } & ({ url: string; file?: never } | { file: File; url?: never })
): Promise<WhatsAppQrClientResult<WhatsAppQrInspectResponse>> {
  if ("file" in params && params.file) {
    const formData = new FormData();
    formData.set("image", params.file);
    const query = new URLSearchParams({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
    });
    return requestJson<WhatsAppQrInspectResponse>(
      `/api/whatsapp/qr-entry-points/inspect?${query.toString()}`,
      {
        method: "POST",
        signal: params.signal,
        body: formData,
      }
    );
  }

  return requestJson<WhatsAppQrInspectResponse>(
    "/api/whatsapp/qr-entry-points/inspect",
    {
      method: "POST",
      headers: JSON_HEADERS,
      signal: params.signal,
      body: JSON.stringify({
        workspaceId: params.workspaceId,
        sourceId: params.sourceId,
        url: params.url,
      }),
    }
  );
}

export async function downloadWhatsAppQrArtwork(params: {
  workspaceId: string;
  codeId: string;
  format: "png" | "svg";
  signal?: AbortSignal;
}): Promise<WhatsAppQrClientResult<WhatsAppQrArtworkDownload>> {
  const query = new URLSearchParams({
    workspaceId: params.workspaceId,
    format: params.format,
  });
  try {
    const response = await fetch(
      `/api/whatsapp/qr-entry-points/${encodeURIComponent(params.codeId)}/artwork?${query.toString()}`,
      { signal: params.signal, cache: "no-store" }
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as unknown;
      const parsed = errorFromBody(data, "Failed to download artwork");
      return {
        ok: false,
        status: response.status,
        error: parsed.error,
        ...(parsed.code ? { code: parsed.code } : {}),
      };
    }
    const blob = await response.blob();
    const contentType =
      response.headers.get("Content-Type") ||
      (params.format === "png" ? "image/png" : "image/svg+xml");
    return {
      ok: true,
      data: {
        blob,
        objectUrl: URL.createObjectURL(blob),
        contentType,
        format: params.format,
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Network request failed",
    };
  }
}

export class WhatsAppQrClientError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code?: string,
    readonly operationId?: string,
    readonly currentAssignment?: WhatsAppQrAssignmentSummary | null
  ) {
    super(message);
    this.name = "WhatsAppQrClientError";
  }
}

export type WhatsAppQrInspectIntent = {
  kind: "provider" | "direct" | string;
  providerCode?: string;
  deepLink?: string;
  displayPhoneNumber?: string;
  desiredMessage?: string;
};

export function newWhatsAppQrIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function unwrapWhatsAppQrClientResult<T>(
  result: WhatsAppQrClientResult<T>
): T {
  if (!result.ok) {
    throw new WhatsAppQrClientError(
      result.error,
      result.status,
      result.code,
      result.operationId,
      result.currentAssignment
    );
  }
  return result.data;
}

export async function inspectWhatsAppQrUrl(params: {
  workspaceId: string;
  sourceId: string;
  url: string;
  signal?: AbortSignal;
}): Promise<{ intent: WhatsAppQrInspectIntent }> {
  const data = unwrapWhatsAppQrClientResult(
    await inspectWhatsAppQrImport({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
      url: params.url,
      signal: params.signal,
    })
  );
  const intent = data.intent;
  if (!intent || typeof intent !== "object") {
    throw new WhatsAppQrClientError("Invalid inspect response", 502);
  }
  return { intent: intent as WhatsAppQrInspectIntent };
}

export async function inspectWhatsAppQrImage(params: {
  workspaceId: string;
  sourceId: string;
  file: File;
  signal?: AbortSignal;
}): Promise<{ intent: WhatsAppQrInspectIntent }> {
  const data = unwrapWhatsAppQrClientResult(
    await inspectWhatsAppQrImport({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
      file: params.file,
      signal: params.signal,
    })
  );
  const intent = data.intent;
  if (!intent || typeof intent !== "object") {
    throw new WhatsAppQrClientError("Invalid inspect response", 502);
  }
  return { intent: intent as WhatsAppQrInspectIntent };
}

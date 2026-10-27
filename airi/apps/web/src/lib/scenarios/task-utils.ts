import type { Channel } from "@/types/models";
import { Types } from "mongoose";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ScenarioConversationBase = {
  _id?: unknown;
  workspaceId?: string;
  channel?: Channel | string;
  sourceId?: string;
  business_connection_id?: string;
  chat?: unknown;
  user?: unknown;
  external_thread?: {
    provider?: string;
    type?: string;
    threadId?: string;
  };
};

/**
 * Minimal Mongoose model interface for task status mutations.
 * The timeout task model satisfies this.
 */
export type TaskModel = {
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>
  ): Promise<{ modifiedCount?: number }>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

export function normalizeString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value).trim();
  return "";
}

export function readEntityId(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj._id !== null && obj._id !== undefined) {
      return String(obj._id).trim();
    }
    if (typeof (obj as { toString?: unknown }).toString === "function") {
      const asString = String(value).trim();
      if (asString && asString !== "[object Object]") return asString;
    }
  }
  return "";
}

export function readEntityIdRaw(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj._id !== null && obj._id !== undefined) {
    return obj._id;
  }
  return value;
}

export function isMongoObjectIdString(value: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(value);
}

export function joinNameParts(
  first?: string | null,
  last?: string | null
): string {
  const values = [first, last]
    .map(part => normalizeString(part))
    .filter(Boolean);
  return values.join(" ").trim();
}

export function sanitizeInstructionSnippet(
  value: string,
  maxChars = 280
): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 3)}...`;
}

// ---------------------------------------------------------------------------
// Lease management for proactive timeout processors
// ---------------------------------------------------------------------------

export function createProcessingLeaseId(): string {
  return new Types.ObjectId().toHexString();
}

// ---------------------------------------------------------------------------
// Task status mutations shared across timeout workers
// ---------------------------------------------------------------------------

export async function markTaskCompleted(
  model: TaskModel,
  taskId: string,
  leaseId: string
): Promise<boolean> {
  const result = await model.updateOne(
    { _id: taskId, status: "processing", processingLeaseId: leaseId },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        skipReason: null,
        lastError: null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
      },
    }
  );
  return (result.modifiedCount || 0) > 0;
}

export async function markTaskSkipped(
  model: TaskModel,
  taskId: string,
  leaseId: string,
  reason: string,
  errorMessage?: string
): Promise<boolean> {
  const result = await model.updateOne(
    { _id: taskId, status: "processing", processingLeaseId: leaseId },
    {
      $set: {
        status: "skipped",
        completedAt: new Date(),
        skipReason: reason,
        lastError: errorMessage || null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
      },
    }
  );
  return (result.modifiedCount || 0) > 0;
}

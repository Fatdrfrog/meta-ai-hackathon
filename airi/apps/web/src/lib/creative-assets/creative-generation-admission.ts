import "server-only";

import { randomUUID } from "node:crypto";

import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import { CreativeGenerationAdmissionLease } from "@/models/creative-generation-admission-lease";

// This lease reduces hot-workspace contention only. Durable quota callers must
// fence admission with their own atomic write because a process can pause beyond
// any finite lease duration and resume after a successor acquires it.
const LEASE_DURATION_MS = 2 * 60_000;
const DEFAULT_RETRY_DELAYS_MS = [0, 25, 50, 100, 200, 400, 800, 1_600];

type LeaseIdentity = {
  workspaceId: string;
  ownerToken: string;
  fencingToken: number;
};

export type CreativeGenerationAdmissionFence = LeaseIdentity;

export type CreativeGenerationAdmissionDependencies = {
  newOwnerToken(): string;
  now(): Date;
  tryAcquire(
    identity: Omit<LeaseIdentity, "fencingToken"> & {
      now: Date;
      expiresAt: Date;
    }
  ): Promise<number | null>;
  release(identity: LeaseIdentity): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  retryDelaysMs: readonly number[];
};

export class CreativeGenerationAdmissionBusyError extends Error {
  constructor() {
    super("Creative generation admission is busy; retry the request");
    this.name = "CreativeGenerationAdmissionBusyError";
  }
}

const defaultDependencies: CreativeGenerationAdmissionDependencies = {
  newOwnerToken: randomUUID,
  now: () => new Date(),
  async tryAcquire({ workspaceId, ownerToken, now, expiresAt }) {
    await connectDB();
    try {
      const lease = await CreativeGenerationAdmissionLease.findOneAndUpdate(
        {
          _id: workspaceId,
          $or: [{ expiresAt: { $lte: now } }, { ownerToken }],
        },
        {
          $set: { ownerToken, expiresAt },
          $inc: { fencingToken: 1 },
        },
        { upsert: true, new: true, setDefaultsOnInsert: false }
      ).lean<{ ownerToken: string | null; fencingToken: number }>();
      return lease?.ownerToken === ownerToken &&
        Number.isSafeInteger(lease.fencingToken) &&
        lease.fencingToken > 0
        ? lease.fencingToken
        : null;
    } catch (error) {
      if (isMongoDuplicateKeyError(error)) return null;
      throw error;
    }
  },
  async release({ workspaceId, ownerToken, fencingToken }) {
    await CreativeGenerationAdmissionLease.updateOne(
      { _id: workspaceId, ownerToken, fencingToken },
      { $set: { ownerToken: null, expiresAt: new Date(0) } }
    );
  },
  sleep: milliseconds =>
    new Promise(resolve => {
      setTimeout(resolve, milliseconds);
    }),
  retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
};

export async function withWorkspaceCreativeGenerationAdmission<T>(
  workspaceId: string,
  run: (fence: CreativeGenerationAdmissionFence) => Promise<T>,
  dependencies: CreativeGenerationAdmissionDependencies = defaultDependencies
): Promise<T> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new Error(
      "Workspace id is required for creative generation admission"
    );
  }
  const ownerToken = dependencies.newOwnerToken();
  let fencingToken: number | null = null;

  for (const [attempt, delayMs] of dependencies.retryDelaysMs.entries()) {
    if (attempt > 0) await dependencies.sleep(delayMs);
    const now = dependencies.now();
    fencingToken = await dependencies.tryAcquire({
      workspaceId: normalizedWorkspaceId,
      ownerToken,
      now,
      expiresAt: new Date(now.getTime() + LEASE_DURATION_MS),
    });
    if (fencingToken !== null) break;
  }

  if (fencingToken === null) throw new CreativeGenerationAdmissionBusyError();

  try {
    return await run({
      workspaceId: normalizedWorkspaceId,
      ownerToken,
      fencingToken,
    });
  } finally {
    await dependencies
      .release({
        workspaceId: normalizedWorkspaceId,
        ownerToken,
        fencingToken,
      })
      .catch(() => undefined);
  }
}

import "server-only";

import { createHash } from "node:crypto";

import {
  CreativeGenerationAdmissionBusyError,
  withWorkspaceCreativeGenerationAdmission,
  type CreativeGenerationAdmissionFence,
} from "@/lib/creative-assets/creative-generation-admission";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import { CreativeAsset } from "@/models/creative-asset";
import {
  ensurePlatformCreativeGenerationQuotaIndexes,
  PlatformCreativeGenerationQuotaClaim,
  type PlatformCreativeGenerationQuotaControlReservation,
} from "@/models/platform-creative-generation-quota-claim";
import { requireNonEmptyString as requiredString } from "@icecore/shared/lib/value-utils";

const MAX_PLATFORM_CREATIVE_GENERATION_LIMIT = 1000;
// Bump this when intentionally increasing the configured quota. Within one
// revision the lowest limit wins, so an older rolling-deployment instance
// cannot restore a superseded higher ceiling.
export const PLATFORM_CREATIVE_GENERATION_QUOTA_POLICY_REVISION = 1;
const MAX_CONTROL_MUTATION_ATTEMPTS = 8;
const LEGACY_RECONCILIATION_STABLE_PASSES = 2;
const MAX_LEGACY_RECONCILIATION_PASSES = 4;
const COUNTED_ASSET_STATUSES = [
  "queued",
  "in_progress",
  "complete",
  "nsfw",
] as const;

export const PLATFORM_CREATIVE_GENERATION_COUNTED_ASSET_FILTER = {
  $or: [
    {
      provider: "google",
      $or: [
        { providerSourceId: null },
        { providerSourceId: "" },
        { providerSourceId: { $exists: false } },
      ],
    },
    {
      provider: "elevenlabs",
      $or: [
        { providerSourceId: null },
        { providerSourceId: "" },
        { providerSourceId: { $exists: false } },
      ],
    },
  ],
  status: { $in: [...COUNTED_ASSET_STATUSES] },
  // Mongo equality-to-null also includes legacy documents where this is absent.
  "generation.recoveryMode": null,
};

export type PlatformCreativeGenerationQuotaClaim =
  PlatformCreativeGenerationQuotaControlReservation;

type PlatformCreativeGenerationQuotaReconciliationClaim = Omit<
  PlatformCreativeGenerationQuotaClaim,
  "quotaSlot"
> & {
  quotaSlot: number | null;
};

type PlatformCreativeGenerationQuota = {
  limit: number;
  used: number;
  remaining: number;
};

export type PlatformCreativeGenerationQuotaAdmissionResult<T> =
  | {
      accepted: true;
      replay: boolean;
      value: T;
      quota: PlatformCreativeGenerationQuota;
    }
  | {
      accepted: false;
      quota: PlatformCreativeGenerationQuota;
    };

type ControlMutationResult =
  | {
      status: "reserved";
      claim: PlatformCreativeGenerationQuotaClaim;
      replay: boolean;
    }
  | { status: "full" }
  | { status: "stale" };

export type PlatformCreativeGenerationQuotaLedgerDependencies = {
  ensureIndexes(): Promise<void>;
  listCountedAssetIds(workspaceId: string, limit: number): Promise<string[]>;
  listStoredClaims(
    workspaceId: string,
    limit: number
  ): Promise<PlatformCreativeGenerationQuotaClaim[]>;
  activatePolicy(input: {
    workspaceId: string;
    fencingToken: number;
    policyRevision: number;
    limit: number;
  }): Promise<boolean>;
  reconcileClaims(input: {
    workspaceId: string;
    fencingToken: number;
    limit: number;
    claims: PlatformCreativeGenerationQuotaReconciliationClaim[];
  }): Promise<"active" | "stale">;
  reserveClaim(input: {
    workspaceId: string;
    fencingToken: number;
    limit: number;
    claim: Omit<PlatformCreativeGenerationQuotaClaim, "quotaSlot">;
  }): Promise<ControlMutationResult>;
  getUsage(input: {
    workspaceId: string;
    fencingToken: number;
    limit: number;
  }): Promise<number | null>;
  withWorkspaceAdmission<T>(
    workspaceId: string,
    run: (fence: CreativeGenerationAdmissionFence) => Promise<T>
  ): Promise<T>;
};

type QuotaControl = {
  policyRevision: number;
  policyFencingToken: number;
  policyLimit: number;
  reservations: PlatformCreativeGenerationQuotaClaim[];
};

function normalizedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.max(
    0,
    Math.min(MAX_PLATFORM_CREATIVE_GENERATION_LIMIT, Math.trunc(limit))
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function claimId(workspaceId: string, claimKey: string): string {
  return digest(`${workspaceId}\0claim\0${claimKey}`);
}

function bootstrapClaimId(workspaceId: string, assetId: string): string {
  return claimId(workspaceId, `asset:${assetId}`);
}

function recordId(workspaceId: string, value: string): string {
  return `pcgq:${digest(`${workspaceId}\0${value}`)}`;
}

function controlRecordId(workspaceId: string): string {
  return recordId(workspaceId, "bootstrap");
}

const STORED_CLAIM_PROJECTION = {
  claimId: 1,
  assetId: 1,
  source: 1,
  claimedAt: 1,
  quotaSlot: 1,
} as const;

async function loadControl(workspaceId: string): Promise<QuotaControl | null> {
  const control = await PlatformCreativeGenerationQuotaClaim.findOne({
    _id: controlRecordId(workspaceId),
    workspaceId,
    recordType: "bootstrap",
  })
    .select({
      policyRevision: 1,
      policyFencingToken: 1,
      policyLimit: 1,
      reservations: 1,
    })
    .lean<QuotaControl | null>();
  return control || null;
}

async function findStoredClaim(
  workspaceId: string,
  targetClaimId: string,
  assetId: string
): Promise<PlatformCreativeGenerationQuotaClaim | null> {
  const byId = await PlatformCreativeGenerationQuotaClaim.findOne({
    _id: recordId(workspaceId, targetClaimId),
    workspaceId,
    recordType: "claim",
  })
    .select(STORED_CLAIM_PROJECTION)
    .lean<PlatformCreativeGenerationQuotaClaim | null>();
  if (byId) return byId;

  const byAsset = await PlatformCreativeGenerationQuotaClaim.findOne({
    workspaceId,
    recordType: "claim",
    assetId,
  })
    .select(STORED_CLAIM_PROJECTION)
    .lean<PlatformCreativeGenerationQuotaClaim | null>();
  return byAsset || null;
}

async function persistClaim(
  workspaceId: string,
  claim: PlatformCreativeGenerationQuotaClaim
): Promise<void> {
  try {
    await PlatformCreativeGenerationQuotaClaim.findOneAndUpdate(
      { _id: recordId(workspaceId, claim.claimId) },
      {
        $setOnInsert: {
          _id: recordId(workspaceId, claim.claimId),
          workspaceId,
          recordType: "claim",
          ...claim,
          bootstrappedLimit: null,
          policyRevision: null,
          policyFencingToken: null,
          policyLimit: null,
          reservations: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: false }
    ).lean();
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    const existing = await findStoredClaim(
      workspaceId,
      claim.claimId,
      claim.assetId
    );
    if (!existing) throw error;
  }
}

async function activateQuotaPolicy(input: {
  workspaceId: string;
  fencingToken: number;
  policyRevision: number;
  limit: number;
}): Promise<boolean> {
  // Upgrade the earlier bootstrap marker in place. Initializing the bounded
  // reservation array is benign even when attempted by an expired owner.
  await PlatformCreativeGenerationQuotaClaim.updateOne(
    {
      _id: controlRecordId(input.workspaceId),
      recordType: "bootstrap",
      reservations: { $exists: false },
    },
    { $set: { reservations: [] } }
  );

  try {
    const control = await PlatformCreativeGenerationQuotaClaim.findOneAndUpdate(
      {
        _id: controlRecordId(input.workspaceId),
        $and: [
          {
            $or: [
              { policyFencingToken: null },
              { policyFencingToken: { $lte: input.fencingToken } },
            ],
          },
          {
            $or: [
              { policyRevision: null },
              { policyRevision: { $lt: input.policyRevision } },
              {
                policyRevision: input.policyRevision,
                policyLimit: { $gte: input.limit },
              },
            ],
          },
        ],
      },
      {
        $setOnInsert: {
          _id: controlRecordId(input.workspaceId),
          workspaceId: input.workspaceId,
          recordType: "bootstrap",
          claimId: null,
          assetId: null,
          source: null,
          claimedAt: null,
          quotaSlot: null,
          bootstrappedLimit: 0,
          reservations: [],
        },
        $set: {
          policyRevision: input.policyRevision,
          policyFencingToken: input.fencingToken,
          policyLimit: input.limit,
        },
        $max: { bootstrappedLimit: input.limit },
      },
      { upsert: true, new: true, setDefaultsOnInsert: false }
    )
      .select({ policyRevision: 1, policyFencingToken: 1, policyLimit: 1 })
      .lean<{
        policyRevision: number;
        policyFencingToken: number;
        policyLimit: number;
      } | null>();
    return (
      control?.policyRevision === input.policyRevision &&
      control.policyFencingToken === input.fencingToken &&
      control.policyLimit === input.limit
    );
  } catch (error) {
    // A stale filtered upsert collides with the deterministic control id.
    if (isMongoDuplicateKeyError(error)) return false;
    throw error;
  }
}

function controlClaim(
  reservations: PlatformCreativeGenerationQuotaClaim[],
  targetClaimId: string,
  assetId: string
): PlatformCreativeGenerationQuotaClaim | null {
  return (
    reservations.find(claim => claim.claimId === targetClaimId) ||
    reservations.find(claim => claim.assetId === assetId) ||
    null
  );
}

async function appendControlClaim(input: {
  workspaceId: string;
  fencingToken: number;
  limit: number;
  claim: Omit<PlatformCreativeGenerationQuotaClaim, "quotaSlot"> & {
    preferredQuotaSlot?: number | null;
  };
}): Promise<ControlMutationResult> {
  for (let attempt = 0; attempt < MAX_CONTROL_MUTATION_ATTEMPTS; attempt += 1) {
    const control = await loadControl(input.workspaceId);
    if (
      !control ||
      control.policyFencingToken !== input.fencingToken ||
      control.policyLimit !== input.limit
    ) {
      return { status: "stale" };
    }

    const existing = controlClaim(
      control.reservations,
      input.claim.claimId,
      input.claim.assetId
    );
    if (existing) {
      await persistClaim(input.workspaceId, existing);
      return { status: "reserved", claim: existing, replay: true };
    }
    if (control.reservations.length >= input.limit) {
      return { status: "full" };
    }

    const occupiedSlots = new Set(
      control.reservations.map(claim => claim.quotaSlot)
    );
    const preferred = input.claim.preferredQuotaSlot;
    const quotaSlot =
      typeof preferred === "number" &&
      preferred >= 0 &&
      preferred < input.limit &&
      !occupiedSlots.has(preferred)
        ? preferred
        : Array.from({ length: input.limit }, (_, slot) => slot).find(
            slot => !occupiedSlots.has(slot)
          );
    if (quotaSlot === undefined) return { status: "full" };

    const claim: PlatformCreativeGenerationQuotaClaim = {
      claimId: input.claim.claimId,
      assetId: input.claim.assetId,
      source: input.claim.source,
      claimedAt: input.claim.claimedAt,
      quotaSlot,
    };
    const updated = await PlatformCreativeGenerationQuotaClaim.findOneAndUpdate(
      {
        _id: controlRecordId(input.workspaceId),
        workspaceId: input.workspaceId,
        recordType: "bootstrap",
        policyFencingToken: input.fencingToken,
        policyLimit: input.limit,
        "reservations.claimId": { $ne: claim.claimId },
        "reservations.assetId": { $ne: claim.assetId },
        "reservations.quotaSlot": { $ne: quotaSlot },
        $expr: {
          $lt: [{ $size: { $ifNull: ["$reservations", []] } }, input.limit],
        },
      },
      { $push: { reservations: claim } },
      { new: true }
    )
      .select({ _id: 1 })
      .lean<{ _id: string } | null>();
    if (!updated) continue;

    // The control append is the atomic capacity decision. If this materialized
    // claim write fails, the slot stays consumed and a replay repairs it.
    await persistClaim(input.workspaceId, claim);
    return { status: "reserved", claim, replay: false };
  }

  throw new Error("Creative generation quota control did not converge");
}

const defaultDependencies: PlatformCreativeGenerationQuotaLedgerDependencies = {
  async ensureIndexes() {
    await connectDB();
    await ensurePlatformCreativeGenerationQuotaIndexes();
  },
  async listCountedAssetIds(workspaceId, limit) {
    if (limit <= 0) return [];
    const assets = await CreativeAsset.find({
      workspaceId,
      ...PLATFORM_CREATIVE_GENERATION_COUNTED_ASSET_FILTER,
    })
      .select({ _id: 1 })
      .limit(limit)
      .lean<Array<{ _id: unknown }>>();
    return assets.map(asset => String(asset._id));
  },
  async listStoredClaims(workspaceId, limit) {
    if (limit <= 0) return [];
    return PlatformCreativeGenerationQuotaClaim.find({
      workspaceId,
      recordType: "claim",
    })
      .select(STORED_CLAIM_PROJECTION)
      .limit(limit)
      .lean<PlatformCreativeGenerationQuotaClaim[]>();
  },
  activatePolicy: activateQuotaPolicy,
  async reconcileClaims(input) {
    for (const claim of input.claims) {
      const result = await appendControlClaim({
        ...input,
        claim: {
          claimId: claim.claimId,
          assetId: claim.assetId,
          source: claim.source,
          claimedAt: claim.claimedAt,
          preferredQuotaSlot: claim.quotaSlot,
        },
      });
      if (result.status === "stale") return "stale";
      if (result.status === "full") return "active";
    }
    return "active";
  },
  async reserveClaim(input) {
    return appendControlClaim(input);
  },
  async getUsage(input) {
    const control = await loadControl(input.workspaceId);
    if (
      !control ||
      control.policyFencingToken !== input.fencingToken ||
      control.policyLimit !== input.limit
    ) {
      return null;
    }
    return Math.min(control.reservations.length, input.limit);
  },
  withWorkspaceAdmission: withWorkspaceCreativeGenerationAdmission,
};

function reconciliationSignature(
  storedClaims: PlatformCreativeGenerationQuotaClaim[],
  assetIds: string[]
): string {
  return [
    ...new Set([
      ...storedClaims.map(claim => `claim:${claim.claimId}:${claim.assetId}`),
      ...assetIds.map(assetId => `asset:${assetId}`),
    ]),
  ]
    .sort()
    .join("\0");
}

async function reconcileLegacyUsage(
  workspaceId: string,
  fencingToken: number,
  limit: number,
  dependencies: PlatformCreativeGenerationQuotaLedgerDependencies
): Promise<void> {
  if (limit <= 0) return;

  let previousSignature: string | null = null;
  let stablePasses = 0;

  for (let pass = 0; pass < MAX_LEGACY_RECONCILIATION_PASSES; pass += 1) {
    const [storedClaims, assetIds] = await Promise.all([
      dependencies.listStoredClaims(workspaceId, limit),
      dependencies.listCountedAssetIds(workspaceId, limit),
    ]);
    const byAsset = new Map(
      storedClaims.map(claim => [claim.assetId, claim] as const)
    );
    const claimedAt = new Date();
    const claims = [
      ...storedClaims,
      ...assetIds
        .filter(assetId => !byAsset.has(assetId))
        .map(assetId => ({
          claimId: bootstrapClaimId(workspaceId, assetId),
          assetId,
          source: "bootstrap" as const,
          claimedAt,
          quotaSlot: null,
        })),
    ];
    const state = await dependencies.reconcileClaims({
      workspaceId,
      fencingToken,
      limit,
      claims,
    });
    if (state === "stale") {
      throw new CreativeGenerationAdmissionBusyError();
    }

    const signature = reconciliationSignature(storedClaims, assetIds);
    if (signature === previousSignature) {
      stablePasses += 1;
      if (stablePasses >= LEGACY_RECONCILIATION_STABLE_PASSES - 1) return;
    } else {
      previousSignature = signature;
      stablePasses = 0;
    }
  }

  // Active pre-ledger writers kept changing the counted set. Do not reserve
  // new work until a retry observes a stable reconciled snapshot.
  throw new CreativeGenerationAdmissionBusyError();
}

async function activateAndReconcile(
  workspaceId: string,
  fencingToken: number,
  limit: number,
  dependencies: PlatformCreativeGenerationQuotaLedgerDependencies
): Promise<void> {
  const active = await dependencies.activatePolicy({
    workspaceId,
    fencingToken,
    policyRevision: PLATFORM_CREATIVE_GENERATION_QUOTA_POLICY_REVISION,
    limit,
  });
  if (!active) throw new CreativeGenerationAdmissionBusyError();
  await reconcileLegacyUsage(workspaceId, fencingToken, limit, dependencies);
}

export async function getWorkspacePlatformCreativeGenerationUsage(
  workspaceId: string,
  requestedLimit: number,
  dependencies: PlatformCreativeGenerationQuotaLedgerDependencies = defaultDependencies
): Promise<number> {
  const normalizedWorkspaceId = requiredString(workspaceId, "Workspace id");
  const limit = normalizedLimit(requestedLimit);
  await dependencies.ensureIndexes();
  return dependencies.withWorkspaceAdmission(
    normalizedWorkspaceId,
    async fence => {
      await activateAndReconcile(
        normalizedWorkspaceId,
        fence.fencingToken,
        limit,
        dependencies
      );
      const used = await dependencies.getUsage({
        workspaceId: normalizedWorkspaceId,
        fencingToken: fence.fencingToken,
        limit,
      });
      if (used === null) throw new CreativeGenerationAdmissionBusyError();
      return used;
    }
  );
}

export async function withWorkspacePlatformCreativeGenerationQuotaAdmission<T>(
  input: {
    workspaceId: string;
    limit: number;
    claimKey: string;
    assetId: string;
  },
  run: (reservation: { assetId: string; replay: boolean }) => Promise<T>,
  dependencies: PlatformCreativeGenerationQuotaLedgerDependencies = defaultDependencies
): Promise<PlatformCreativeGenerationQuotaAdmissionResult<T>> {
  const workspaceId = requiredString(input.workspaceId, "Workspace id");
  const key = requiredString(input.claimKey, "Claim key");
  const requestedAssetId = requiredString(input.assetId, "Asset id");
  const limit = normalizedLimit(input.limit);

  await dependencies.ensureIndexes();
  return dependencies.withWorkspaceAdmission(workspaceId, async fence => {
    await activateAndReconcile(
      workspaceId,
      fence.fencingToken,
      limit,
      dependencies
    );
    const reservation = await dependencies.reserveClaim({
      workspaceId,
      fencingToken: fence.fencingToken,
      limit,
      claim: {
        claimId: claimId(workspaceId, key),
        assetId: requestedAssetId,
        source: "reservation",
        claimedAt: new Date(),
      },
    });
    if (reservation.status === "stale") {
      throw new CreativeGenerationAdmissionBusyError();
    }
    const used = await dependencies.getUsage({
      workspaceId,
      fencingToken: fence.fencingToken,
      limit,
    });
    if (used === null) throw new CreativeGenerationAdmissionBusyError();
    if (reservation.status === "full") {
      return {
        accepted: false,
        quota: { limit, used, remaining: 0 },
      };
    }

    const value = await run({
      assetId: reservation.claim.assetId,
      replay: reservation.replay,
    });
    return {
      accepted: true,
      replay: reservation.replay,
      value,
      quota: {
        limit,
        used,
        remaining: Math.max(0, limit - used),
      },
    };
  });
}

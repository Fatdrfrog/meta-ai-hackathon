import mongoose, { type Model } from "mongoose";

export const PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_COUNT_INDEX = {
  key: { workspaceId: 1, recordType: 1 } as const,
  options: {
    name: "workspace_platform_creative_generation_claim_count",
    partialFilterExpression: { recordType: "claim" },
  },
};

export const PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_ASSET_INDEX = {
  key: { workspaceId: 1, assetId: 1 } as const,
  options: {
    name: "workspace_platform_creative_generation_claim_asset",
    unique: true,
    partialFilterExpression: {
      recordType: "claim",
      assetId: { $type: "string" },
    },
  },
};

export const PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_SLOT_INDEX = {
  key: { workspaceId: 1, quotaSlot: 1 } as const,
  options: {
    name: "workspace_platform_creative_generation_claim_slot",
    unique: true,
    partialFilterExpression: {
      recordType: "claim",
      quotaSlot: { $type: "number" },
    },
  },
};

export type PlatformCreativeGenerationQuotaControlReservation = {
  claimId: string;
  assetId: string;
  source: "bootstrap" | "reservation";
  claimedAt: Date;
  quotaSlot: number;
};

export type PlatformCreativeGenerationQuotaClaimRecord = {
  _id: string;
  workspaceId: string;
  recordType: "claim";
  claimId: string;
  assetId: string;
  source: "bootstrap" | "reservation";
  claimedAt: Date;
  quotaSlot: number;
  bootstrappedLimit: null;
  policyRevision: null;
  policyFencingToken: null;
  policyLimit: null;
  reservations: null;
  createdAt: Date;
  updatedAt: Date;
};

export type PlatformCreativeGenerationQuotaBootstrapRecord = {
  _id: string;
  workspaceId: string;
  recordType: "bootstrap";
  claimId: null;
  assetId: null;
  source: null;
  claimedAt: null;
  quotaSlot: null;
  bootstrappedLimit: number;
  policyRevision: number;
  policyFencingToken: number;
  policyLimit: number;
  reservations: PlatformCreativeGenerationQuotaControlReservation[];
  createdAt: Date;
  updatedAt: Date;
};

export type PlatformCreativeGenerationQuotaRecord =
  | PlatformCreativeGenerationQuotaClaimRecord
  | PlatformCreativeGenerationQuotaBootstrapRecord;

const PlatformCreativeGenerationQuotaClaimSchema =
  new mongoose.Schema<PlatformCreativeGenerationQuotaRecord>(
    {
      _id: { type: String, required: true },
      workspaceId: { type: String, required: true },
      recordType: {
        type: String,
        enum: ["claim", "bootstrap"],
        required: true,
      },
      claimId: { type: String, default: null, maxlength: 64 },
      assetId: { type: String, default: null, maxlength: 128 },
      source: {
        type: String,
        enum: ["bootstrap", "reservation", null],
        default: null,
      },
      claimedAt: { type: Date, default: null },
      quotaSlot: {
        type: Number,
        min: 0,
        max: 999,
        default: null,
      },
      bootstrappedLimit: {
        type: Number,
        min: 0,
        max: 1000,
        default: null,
      },
      policyFencingToken: {
        type: Number,
        min: 0,
        default: null,
      },
      policyRevision: {
        type: Number,
        min: 1,
        default: null,
      },
      policyLimit: {
        type: Number,
        min: 0,
        max: 1000,
        default: null,
      },
      reservations: {
        type: [
          new mongoose.Schema<PlatformCreativeGenerationQuotaControlReservation>(
            {
              claimId: { type: String, required: true, maxlength: 64 },
              assetId: { type: String, required: true, maxlength: 128 },
              source: {
                type: String,
                enum: ["bootstrap", "reservation"],
                required: true,
              },
              claimedAt: { type: Date, required: true },
              quotaSlot: {
                type: Number,
                required: true,
                min: 0,
                max: 999,
              },
            },
            { _id: false, versionKey: false }
          ),
        ],
        default: undefined,
        validate: {
          validator: (reservations: unknown[]) => reservations.length <= 1000,
          message: "Quota control reservations cannot exceed 1000",
        },
      },
    },
    {
      collection: "platform_creative_generation_quota_claims",
      timestamps: true,
      versionKey: false,
    }
  );

PlatformCreativeGenerationQuotaClaimSchema.index(
  PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_COUNT_INDEX.key,
  PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_COUNT_INDEX.options
);
PlatformCreativeGenerationQuotaClaimSchema.index(
  PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_ASSET_INDEX.key,
  PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_ASSET_INDEX.options
);
PlatformCreativeGenerationQuotaClaimSchema.index(
  PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_SLOT_INDEX.key,
  PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_SLOT_INDEX.options
);

export const PlatformCreativeGenerationQuotaClaim =
  (mongoose.models
    .PlatformCreativeGenerationQuotaClaim as Model<PlatformCreativeGenerationQuotaRecord>) ||
  mongoose.model<PlatformCreativeGenerationQuotaRecord>(
    "PlatformCreativeGenerationQuotaClaim",
    PlatformCreativeGenerationQuotaClaimSchema
  );

type PlatformQuotaIndexCache = {
  promise: Promise<void> | null;
  ready: boolean;
};

const globalForPlatformQuotaIndexes = globalThis as typeof globalThis & {
  __platformCreativeGenerationQuotaIndexCache?: PlatformQuotaIndexCache;
};
const platformQuotaIndexCache =
  globalForPlatformQuotaIndexes.__platformCreativeGenerationQuotaIndexCache ?? {
    promise: null,
    ready: false,
  };
globalForPlatformQuotaIndexes.__platformCreativeGenerationQuotaIndexCache =
  platformQuotaIndexCache;

export async function ensurePlatformCreativeGenerationQuotaIndexes(): Promise<void> {
  if (platformQuotaIndexCache.ready) return;
  if (platformQuotaIndexCache.promise) return platformQuotaIndexCache.promise;

  platformQuotaIndexCache.promise = Promise.all([
    PlatformCreativeGenerationQuotaClaim.collection.createIndex(
      PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_COUNT_INDEX.key,
      {
        background: true,
        ...PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_COUNT_INDEX.options,
      }
    ),
    PlatformCreativeGenerationQuotaClaim.collection.createIndex(
      PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_ASSET_INDEX.key,
      {
        background: true,
        ...PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_ASSET_INDEX.options,
      }
    ),
    PlatformCreativeGenerationQuotaClaim.collection.createIndex(
      PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_SLOT_INDEX.key,
      {
        background: true,
        ...PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_SLOT_INDEX.options,
      }
    ),
  ])
    .then(() => {
      platformQuotaIndexCache.ready = true;
    })
    .catch(error => {
      platformQuotaIndexCache.promise = null;
      throw error;
    })
    .finally(() => {
      if (platformQuotaIndexCache.ready) {
        platformQuotaIndexCache.promise = null;
      }
    });

  return platformQuotaIndexCache.promise;
}

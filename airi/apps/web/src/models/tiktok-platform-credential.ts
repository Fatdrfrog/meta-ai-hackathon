import mongoose, { type Model } from "mongoose";

import type { EncryptedString } from "@/lib/crypto";
import {
  TIKTOK_SAFE_ERROR_CODES,
  type TikTokSafeErrorCode,
} from "@/lib/tiktok-discovery/safe-errors";
import { EncryptedStringSchema } from "@/models/encrypted-string-schema";

export type TikTokPlatformCredentialRecord = {
  key: "primary";
  generation: string;
  encryptedAccessToken: EncryptedString;
  selectedAdvertiserId: string;
  authorizedAdvertiserCount: number;
  grantedScopes: string[];
  connectedByUserId: string;
  connectedAt: Date;
  lastValidatedAt: Date | null;
  status: "connected" | "reconnect_required";
  lastErrorCode: TikTokSafeErrorCode | null;
  createdAt: Date;
  updatedAt: Date;
};

const TikTokPlatformCredentialSchema =
  new mongoose.Schema<TikTokPlatformCredentialRecord>(
    {
      key: {
        type: String,
        enum: ["primary"],
        required: true,
      },
      generation: {
        type: String,
        required: true,
        match: /^[a-f0-9]{32}$/,
      },
      encryptedAccessToken: {
        type: EncryptedStringSchema,
        required: true,
      },
      selectedAdvertiserId: {
        type: String,
        required: true,
        maxlength: 128,
        match: /^[0-9]+$/,
      },
      authorizedAdvertiserCount: {
        type: Number,
        required: true,
        min: 1,
        max: 500,
        validate: {
          validator: Number.isInteger,
          message: "Authorized advertiser count must be an integer",
        },
      },
      grantedScopes: {
        type: [
          {
            type: String,
            required: true,
            maxlength: 128,
          },
        ],
        required: true,
        validate: {
          validator: (scopes: string[]) => scopes.length <= 100,
          message: "Granted scopes cannot exceed 100",
        },
      },
      connectedByUserId: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 128,
      },
      connectedAt: { type: Date, required: true },
      lastValidatedAt: { type: Date, default: null },
      status: {
        type: String,
        enum: ["connected", "reconnect_required"],
        required: true,
      },
      lastErrorCode: {
        type: String,
        enum: TIKTOK_SAFE_ERROR_CODES,
        default: null,
      },
    },
    {
      collection: "tiktok_platform_credentials",
      timestamps: true,
      strict: "throw",
      versionKey: false,
    }
  );

TikTokPlatformCredentialSchema.index(
  { key: 1 },
  {
    unique: true,
    name: "tiktok_platform_credential_key_unique",
  }
);

export const TikTokPlatformCredential =
  (mongoose.models
    .TikTokPlatformCredential as Model<TikTokPlatformCredentialRecord>) ||
  mongoose.model<TikTokPlatformCredentialRecord>(
    "TikTokPlatformCredential",
    TikTokPlatformCredentialSchema
  );

type TikTokPlatformCredentialIndexCache = {
  promise: Promise<void> | null;
  ready: boolean;
};

const globalForTikTokPlatformCredentialIndexes =
  globalThis as typeof globalThis & {
    __tiktokPlatformCredentialIndexCache?: TikTokPlatformCredentialIndexCache;
  };
const tiktokPlatformCredentialIndexCache =
  globalForTikTokPlatformCredentialIndexes.__tiktokPlatformCredentialIndexCache ?? {
    promise: null,
    ready: false,
  };
globalForTikTokPlatformCredentialIndexes.__tiktokPlatformCredentialIndexCache =
  tiktokPlatformCredentialIndexCache;

export async function ensureTikTokPlatformCredentialIndexes(): Promise<void> {
  if (tiktokPlatformCredentialIndexCache.ready) return;
  if (tiktokPlatformCredentialIndexCache.promise) {
    return tiktokPlatformCredentialIndexCache.promise;
  }

  tiktokPlatformCredentialIndexCache.promise =
    TikTokPlatformCredential.collection
      .createIndex(
        { key: 1 },
        {
          background: true,
          unique: true,
          name: "tiktok_platform_credential_key_unique",
        }
      )
      .then(() => {
        tiktokPlatformCredentialIndexCache.ready = true;
      })
      .catch(error => {
        tiktokPlatformCredentialIndexCache.promise = null;
        throw error;
      })
      .finally(() => {
        if (tiktokPlatformCredentialIndexCache.ready) {
          tiktokPlatformCredentialIndexCache.promise = null;
        }
      });

  return tiktokPlatformCredentialIndexCache.promise;
}

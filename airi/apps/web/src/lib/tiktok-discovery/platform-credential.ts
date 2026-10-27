import "server-only";

import { randomBytes } from "node:crypto";

import { decryptString, encryptString } from "@/lib/crypto";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import type { TikTokSafeErrorCode } from "@/lib/tiktok-discovery/safe-errors";
import {
  TikTokPlatformCredential,
  type TikTokPlatformCredentialRecord,
} from "@/models/tiktok-platform-credential";

const PRIMARY_CREDENTIAL_KEY = "primary" as const;

export type TikTokPlatformCredentialSafeRecord = {
  generation: string;
  advertiserId: string;
  authorizedAdvertiserCount: number;
  grantedScopes: string[];
  connectedByUserId: string;
  connectedAt: Date;
  lastValidatedAt: Date | null;
  status: "connected" | "reconnect_required";
  lastErrorCode: TikTokSafeErrorCode | null;
};

type PersistedCredential = Pick<
  TikTokPlatformCredentialRecord,
  | "generation"
  | "encryptedAccessToken"
  | "selectedAdvertiserId"
  | "authorizedAdvertiserCount"
  | "grantedScopes"
  | "connectedByUserId"
  | "connectedAt"
  | "lastValidatedAt"
  | "status"
  | "lastErrorCode"
>;

function toSafeRecord(
  record: PersistedCredential
): TikTokPlatformCredentialSafeRecord {
  return {
    generation: record.generation,
    advertiserId: record.selectedAdvertiserId,
    authorizedAdvertiserCount: record.authorizedAdvertiserCount,
    grantedScopes: [...record.grantedScopes],
    connectedByUserId: record.connectedByUserId,
    connectedAt: record.connectedAt,
    lastValidatedAt: record.lastValidatedAt,
    status: record.status,
    lastErrorCode: record.lastErrorCode,
  };
}

export async function replaceTikTokPlatformCredential(input: {
  accessToken: string;
  selectedAdvertiserId: string;
  authorizedAdvertiserCount: number;
  grantedScopes: string[];
  connectedByUserId: string;
  now?: Date;
}): Promise<TikTokPlatformCredentialSafeRecord> {
  await connectDB();

  const now = input.now ?? new Date();
  const replacement = {
    generation: randomBytes(16).toString("hex"),
    encryptedAccessToken: encryptString(input.accessToken),
    selectedAdvertiserId: input.selectedAdvertiserId,
    authorizedAdvertiserCount: input.authorizedAdvertiserCount,
    grantedScopes: [...input.grantedScopes],
    connectedByUserId: input.connectedByUserId,
    connectedAt: now,
    lastValidatedAt: null,
    status: "connected" as const,
    lastErrorCode: null,
  };

  let record;
  try {
    record = await TikTokPlatformCredential.findOneAndUpdate(
      { key: PRIMARY_CREDENTIAL_KEY },
      {
        $set: replacement,
        $setOnInsert: { key: PRIMARY_CREDENTIAL_KEY },
      },
      {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true,
      }
    );
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    record = await TikTokPlatformCredential.findOneAndUpdate(
      { key: PRIMARY_CREDENTIAL_KEY },
      { $set: replacement },
      {
        new: true,
        runValidators: true,
        upsert: false,
      }
    );
  }

  if (!record) {
    throw new Error("TikTok platform credential replacement did not persist");
  }
  return toSafeRecord(record.toObject());
}

export async function readTikTokPlatformCredentialStatus(): Promise<TikTokPlatformCredentialSafeRecord | null> {
  await connectDB();
  const record = await TikTokPlatformCredential.findOne({
    key: PRIMARY_CREDENTIAL_KEY,
  });
  return record ? toSafeRecord(record.toObject()) : null;
}

export async function loadTikTokPlatformCredentialForGeneration(input: {
  generation: string;
}): Promise<
  | {
      status: "ready";
      generation: string;
      advertiserId: string;
      accessToken: string;
    }
  | {
      status:
        | "changed"
        | "unavailable"
        | "reconnect_required"
        | "infrastructure_unavailable";
    }
> {
  let record;
  try {
    await connectDB();
    record = await TikTokPlatformCredential.findOne({
      key: PRIMARY_CREDENTIAL_KEY,
    });
  } catch {
    return { status: "infrastructure_unavailable" };
  }

  if (!record) return { status: "unavailable" };
  const persisted = record.toObject();
  if (persisted.generation !== input.generation) return { status: "changed" };
  if (persisted.status === "reconnect_required") {
    return { status: "reconnect_required" };
  }

  try {
    return {
      status: "ready",
      generation: persisted.generation,
      advertiserId: persisted.selectedAdvertiserId,
      accessToken: decryptString(persisted.encryptedAccessToken),
    };
  } catch {
    return { status: "unavailable" };
  }
}

export async function markTikTokPlatformCredentialValidated(input: {
  generation: string;
  validatedAt: Date;
}): Promise<boolean> {
  await connectDB();
  const result = await TikTokPlatformCredential.updateOne(
    { key: PRIMARY_CREDENTIAL_KEY, generation: input.generation },
    {
      $set: {
        lastValidatedAt: input.validatedAt,
        status: "connected",
        lastErrorCode: null,
      },
    },
    { runValidators: true }
  );
  return result.matchedCount > 0;
}

export async function markTikTokPlatformCredentialFailure(input: {
  generation: string;
  status: "connected" | "reconnect_required";
  errorCode: TikTokSafeErrorCode;
}): Promise<boolean> {
  await connectDB();
  const result = await TikTokPlatformCredential.updateOne(
    { key: PRIMARY_CREDENTIAL_KEY, generation: input.generation },
    {
      $set: {
        status: input.status,
        lastErrorCode: input.errorCode,
      },
    },
    { runValidators: true }
  );
  return result.matchedCount > 0;
}

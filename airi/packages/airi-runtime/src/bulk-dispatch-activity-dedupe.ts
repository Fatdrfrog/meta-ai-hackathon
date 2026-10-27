import type { BulkCampaignDispatchChannel } from "@icecore/temporal";
import { randomUUID } from "node:crypto";
import { isMongoDuplicateKeyError } from "@icecore/shared/lib/mongo-errors";

import { createWebRequire, readDefaultExport } from "./internal/module-interop";

export type BulkDispatchActivityDedupeRecord = {
  messageId: string;
  recipient: string;
  channel: BulkCampaignDispatchChannel;
};

type BulkDispatchActivityDedupeDoc = {
  workspaceId?: string;
  messageId?: string;
  recipient?: string;
  channel?: BulkCampaignDispatchChannel;
  state?: "attempted" | "accepted";
  intentToken?: string;
} | null;

type BulkDispatchActivityIdentity = {
  key: string;
  workspaceId: string;
  channel: BulkCampaignDispatchChannel;
  recipient: string;
};

type BulkDispatchActivityIntent = Omit<BulkDispatchActivityIdentity, "key"> & {
  intentToken: string;
};

/** Acceptance witness and send intent of one dispatch key, from one read. */
export type BulkDispatchActivityState = {
  accepted: BulkDispatchActivityDedupeRecord | null;
  /** Throws for a malformed intent, so callers validate it only where they consult it. */
  readIntent: () => BulkDispatchActivityIntent | null;
};

function parseAcceptedRecord(
  doc: BulkDispatchActivityDedupeDoc,
): BulkDispatchActivityDedupeRecord | null {
  if (!doc?.messageId || !doc.recipient || !doc.channel) {
    return null;
  }

  return {
    messageId: doc.messageId,
    recipient: doc.recipient,
    channel: doc.channel,
  };
}

function parseSendIntent(
  doc: BulkDispatchActivityDedupeDoc,
): BulkDispatchActivityIntent | null {
  if (!doc || doc.messageId) return null;
  if (
    doc.state !== "attempted" ||
    !doc.intentToken ||
    !doc.workspaceId ||
    !doc.recipient ||
    !doc.channel
  ) {
    throw new Error("Bulk dispatch send intent is malformed");
  }
  return {
    workspaceId: doc.workspaceId,
    channel: doc.channel,
    recipient: doc.recipient,
    intentToken: doc.intentToken,
  };
}

type BulkDispatchActivityDedupeFindQuery = {
  select: (fields: string) => {
    lean: <T>() => Promise<T>;
  };
};

export type BulkDispatchActivityDedupeModel = {
  findOne: (filter: { key: string }) => BulkDispatchActivityDedupeFindQuery;
  create: (params: {
    key: string;
    workspaceId: string;
    channel: BulkCampaignDispatchChannel;
    messageId: string;
    recipient: string;
  }) => Promise<unknown>;
  updateOne: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: {
      upsert?: boolean;
      timestamps?: boolean;
      writeConcern?: { w: "majority" };
    },
  ) => Promise<{
    upsertedCount?: number;
    matchedCount?: number;
    modifiedCount?: number;
  }>;
  deleteOne: (
    filter: Record<string, unknown>,
    options?: { writeConcern?: { w: "majority" } },
  ) => Promise<{ deletedCount?: number }>;
};

export type BulkDispatchActivityDedupeStore = {
  find: (key: string) => Promise<BulkDispatchActivityDedupeRecord | null>;
  findState: (key: string) => Promise<BulkDispatchActivityState>;
  record: (params: {
    key: string;
    workspaceId: string;
    channel: BulkCampaignDispatchChannel;
    messageId: string;
    recipient: string;
  }) => Promise<void>;
  findIntent: (key: string) => Promise<BulkDispatchActivityIntent | null>;
  claimIntent: (params: BulkDispatchActivityIdentity) => Promise<string | null>;
  clearIntent: (params: { key: string; intentToken: string }) => Promise<void>;
};

export function createBulkDispatchActivityDedupeStore(
  model: BulkDispatchActivityDedupeModel,
): BulkDispatchActivityDedupeStore {
  return {
    async find(key: string): Promise<BulkDispatchActivityDedupeRecord | null> {
      const doc = await model
        .findOne({ key })
        .select("messageId recipient channel")
        .lean<BulkDispatchActivityDedupeDoc>();
      return parseAcceptedRecord(doc);
    },

    async findState(key: string): Promise<BulkDispatchActivityState> {
      const doc = await model
        .findOne({ key })
        .select("workspaceId messageId recipient channel state intentToken")
        .lean<BulkDispatchActivityDedupeDoc>();
      return {
        accepted: parseAcceptedRecord(doc),
        readIntent: () => parseSendIntent(doc),
      };
    },

    async record(params: {
      key: string;
      workspaceId: string;
      channel: BulkCampaignDispatchChannel;
      messageId: string;
      recipient: string;
    }): Promise<void> {
      try {
        const now = new Date();
        const { messageId, ...identity } = params;
        const result = await model.updateOne(
          { ...identity, messageId: { $exists: false } },
          {
            $set: {
              messageId,
              state: "accepted",
              createdAt: now,
              updatedAt: now,
            },
            $unset: { intentToken: "" },
          },
          { upsert: true, timestamps: false, writeConcern: { w: "majority" } },
        );
        if (result.upsertedCount !== 1 && result.matchedCount !== 1) {
          throw new Error("Bulk dispatch acceptance write was not confirmed");
        }
      } catch (error: unknown) {
        if (isMongoDuplicateKeyError(error)) {
          const existing = await model
            .findOne({ key: params.key })
            .select("workspaceId messageId recipient channel")
            .lean<BulkDispatchActivityDedupeDoc>();
          if (
            !existing ||
            existing.workspaceId !== params.workspaceId ||
            existing.channel !== params.channel ||
            existing.recipient !== params.recipient ||
            existing.messageId !== params.messageId
          ) {
            throw new Error("Bulk dispatch acceptance identity conflict");
          }
          return;
        }
        throw error;
      }
    },

    async findIntent(key) {
      const doc = await model
        .findOne({ key })
        .select("workspaceId messageId recipient channel state intentToken")
        .lean<BulkDispatchActivityDedupeDoc>();
      return parseSendIntent(doc);
    },

    async claimIntent(params) {
      const intentToken = randomUUID();
      try {
        const result = await model.updateOne(
          { key: params.key },
          {
            $setOnInsert: {
              ...params,
              state: "attempted",
              intentToken,
              providerAttemptStartedAt: new Date(),
              // The existing createdAt TTL must never erase an unresolved send.
              createdAt: null,
            },
          },
          { upsert: true, timestamps: false, writeConcern: { w: "majority" } },
        );
        if (result.upsertedCount === 1) return intentToken;
        if (result.matchedCount === 1) return null;
        throw new Error("Bulk dispatch send intent write was not confirmed");
      } catch (error) {
        if (isMongoDuplicateKeyError(error)) return null;
        throw error;
      }
    },

    async clearIntent(params) {
      const result = await model.deleteOne(
        { ...params, state: "attempted", messageId: { $exists: false } },
        { writeConcern: { w: "majority" } },
      );
      if (result.deletedCount !== 1) {
        throw new Error(
          "Bulk dispatch send intent ownership changed before rejection was recorded",
        );
      }
    },
  };
}

const requireWeb = createWebRequire(import.meta.url);
const BulkDispatchActivityDedupe =
  readDefaultExport<BulkDispatchActivityDedupeModel>(
    requireWeb("../../../apps/web/src/models/bulk-dispatch-activity-dedupe"),
  );
const defaultStore = createBulkDispatchActivityDedupeStore(
  BulkDispatchActivityDedupe,
);

export async function findBulkDispatchActivityDedupe(
  key: string,
): Promise<BulkDispatchActivityDedupeRecord | null> {
  return defaultStore.find(key);
}

export async function recordBulkDispatchActivityDedupe(params: {
  key: string;
  workspaceId: string;
  channel: BulkCampaignDispatchChannel;
  messageId: string;
  recipient: string;
}): Promise<void> {
  return defaultStore.record(params);
}

export const findBulkDispatchActivityState = defaultStore.findState;
export const findBulkDispatchActivityIntent = defaultStore.findIntent;
export const claimBulkDispatchActivityIntent = defaultStore.claimIntent;
export const clearBulkDispatchActivityIntent = defaultStore.clearIntent;

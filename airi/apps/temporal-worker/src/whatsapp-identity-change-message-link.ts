import * as MongoErrors from "@/lib/mongo-errors";
import { readRuntimeExport } from "@icecore/airi-runtime/module-interop";
import { persistOrRecoverAndLink } from "@icecore/shared/lib/persist-recover-link";
import type { Types } from "mongoose";

const isMongoDuplicateKeyError = readRuntimeExport<
  typeof MongoErrors.isMongoDuplicateKeyError
>(MongoErrors, "isMongoDuplicateKeyError");

type MongoId = string | Types.ObjectId;
type IdentityMessageRecord = { _id: MongoId };

type IdentityMessageModel = {
  findOne: (filter: Record<string, unknown>) => {
    select: (fields: string) => {
      exec: () => Promise<IdentityMessageRecord | null>;
    };
  };
  create: (document: Record<string, unknown>) => Promise<IdentityMessageRecord>;
};

type IdentityAppendResult = { appended: boolean } & Record<string, unknown>;

export async function persistIdentityChangeMessageAndLink(
  params: {
    messageModel: unknown;
    identityFilter: Record<string, unknown>;
    messageDocument: Record<string, unknown>;
    conversationId: MongoId;
    eventAt: Date;
  },
  dependencies: {
    appendMessage: (
      conversationId: MongoId,
      messageId: MongoId,
      options: {
        lastMessageAt: Date;
        direction: "inbound";
      },
    ) => Promise<IdentityAppendResult>;
  },
) {
  const messageModel = params.messageModel as IdentityMessageModel;

  return persistOrRecoverAndLink({
    findExisting: () =>
      messageModel.findOne(params.identityFilter).select("_id").exec(),
    persist: () => messageModel.create(params.messageDocument),
    isDuplicateError: isMongoDuplicateKeyError,
    link: (message) =>
      dependencies.appendMessage(params.conversationId, message._id, {
        lastMessageAt: params.eventAt,
        direction: "inbound",
      }),
  });
}

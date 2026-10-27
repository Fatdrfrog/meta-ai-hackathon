import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import {
  buildWhatsAppStoredReplyMeta,
  extractWhatsAppWamidFingerprint,
  findWhatsAppContextMessage,
} from "@icecore/shared/lib/whatsapp/message-id";

type RepairArgs = {
  apply: boolean;
  force: boolean;
  conversationIds: string[];
  limit: number;
};

type ParentPreview = {
  messageId?: string | null;
  text?: string | null;
  mediaType?: string | null;
};

type MessageCandidate = {
  _id: mongoose.Types.ObjectId;
  conversation: mongoose.Types.ObjectId;
  messageId?: string | null;
  text?: string | null;
  whatsappMeta?: {
    replyToWhatsAppMessageId?: string | null;
    replyToTextPreview?: string | null;
  } | null;
  rawSourcePayload?: {
    provider?: string | null;
    payload?: unknown;
  } | null;
};

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}

function loadMongoEnv() {
  const appRoot = process.cwd();
  const repoRoot = path.resolve(appRoot, "..", "..");

  for (const filePath of [
    path.join(appRoot, ".env.local"),
    path.join(appRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env"),
  ]) {
    loadEnvFile(filePath);
  }
}

function parseArgs(argv: string[]): RepairArgs {
  const args: RepairArgs = {
    apply: false,
    force: false,
    conversationIds: [],
    limit: 500,
  };

  for (const arg of argv) {
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg.startsWith("--conversation-id=")) {
      const id = arg.slice("--conversation-id=".length).trim();
      if (id) args.conversationIds.push(id);
    } else if (arg.startsWith("--limit=")) {
      const limit = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(limit) && limit > 0) args.limit = limit;
    }
  }

  return args;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function getWhatsAppMessagesFromValue(value: unknown): unknown[] {
  const valueRecord = asRecord(value);
  if (!valueRecord) return [];

  for (const key of ["messages", "message_echoes", "smb_message_echoes"]) {
    const messages = asArray(valueRecord[key]).filter(item => asRecord(item));
    if (messages.length > 0) return messages;
  }

  return [];
}

function extractWhatsAppWebhookMessages(payload: unknown): unknown[] {
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) return [];

  const directMessages = getWhatsAppMessagesFromValue(payloadRecord);
  if (directMessages.length > 0) return directMessages;

  for (const entry of asArray(payloadRecord.entry)) {
    const entryRecord = asRecord(entry);
    if (!entryRecord) continue;

    for (const change of asArray(entryRecord.changes)) {
      const changeRecord = asRecord(change);
      const messages = getWhatsAppMessagesFromValue(changeRecord?.value);
      if (messages.length > 0) return messages;
    }
  }

  return [];
}

function extractReplyContext(rawSourcePayload: MessageCandidate["rawSourcePayload"]): {
  contextMessageId: string | null;
  hasReferredProduct: boolean;
} {
  if (!rawSourcePayload || rawSourcePayload.provider !== "whatsapp") {
    return { contextMessageId: null, hasReferredProduct: false };
  }

  const messages = extractWhatsAppWebhookMessages(rawSourcePayload.payload);
  for (const message of messages) {
    const context = asRecord(asRecord(message)?.context);
    if (!context) continue;

    const id = typeof context.id === "string" ? context.id.trim() : "";
    if (!id) continue;

    return {
      contextMessageId: id,
      hasReferredProduct: Boolean(asRecord(context.referred_product)),
    };
  }

  return { contextMessageId: null, hasReferredProduct: false };
}

async function backfillWamidFingerprints(params: {
  conversationId: mongoose.Types.ObjectId;
  apply: boolean;
}): Promise<{ scanned: number; updated: number }> {
  const { default: Message } = await import("../src/models/message");

  const rows = await Message.find({
    conversation: params.conversationId,
    channel: "whatsapp",
    $or: [
      { whatsappWamidFingerprint: { $exists: false } },
      { whatsappWamidFingerprint: null },
      { whatsappWamidFingerprint: "" },
    ],
  })
    .select("_id messageId")
    .lean<Array<{ _id: mongoose.Types.ObjectId; messageId?: string | null }>>();

  let updated = 0;
  for (const row of rows) {
    const fingerprint = extractWhatsAppWamidFingerprint(row.messageId);
    if (!fingerprint) continue;
    if (!params.apply) {
      updated += 1;
      continue;
    }
    await Message.updateOne(
      { _id: row._id },
      { $set: { whatsappWamidFingerprint: fingerprint } }
    );
    updated += 1;
  }

  return { scanned: rows.length, updated };
}

async function findParentMessage(params: {
  conversationId: mongoose.Types.ObjectId;
  contextMessageId: string;
}): Promise<ParentPreview | null> {
  const { default: Message } = await import("../src/models/message");
  return findWhatsAppContextMessage<ParentPreview>({
    Message,
    conversationId: params.conversationId,
    contextMessageId: params.contextMessageId,
    select: "messageId text mediaType",
  });
}

async function main() {
  loadMongoEnv();
  const args = parseArgs(process.argv.slice(2));

  if (args.conversationIds.length === 0) {
    throw new Error(
      "Pass at least one --conversation-id=<id>. Add --apply to write."
    );
  }

  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI (or MONGO_URI) is required");
  }

  await mongoose.connect(mongoUri);
  const { default: Message } = await import("../src/models/message");

  console.log(
    JSON.stringify({
      mode: args.apply ? "apply" : "dry_run",
      conversationIds: args.conversationIds,
      limit: args.limit,
    })
  );

  for (const conversationId of args.conversationIds) {
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      console.log(
        JSON.stringify({
          conversationId,
          error: "invalid_object_id",
        })
      );
      continue;
    }

    const conversationObjectId = new mongoose.Types.ObjectId(conversationId);
    const fingerprintBackfill = await backfillWamidFingerprints({
      conversationId: conversationObjectId,
      apply: args.apply,
    });
    console.log(
      JSON.stringify({
        conversationId,
        fingerprintBackfill,
      })
    );

    const query: Record<string, unknown> = {
      conversation: conversationObjectId,
      channel: "whatsapp",
    };
    if (!args.force) {
      query.$or = [
        { "whatsappMeta.replyToWhatsAppMessageId": { $exists: false } },
        { "whatsappMeta.replyToWhatsAppMessageId": null },
        { "whatsappMeta.replyToWhatsAppMessageId": "" },
        { "whatsappMeta.replyToTextPreview": null },
        { "whatsappMeta.replyToTextPreview": "" },
      ];
    }

    const candidates = await Message.find(query)
      .select("_id conversation messageId text whatsappMeta rawSourcePayload")
      .sort({ date: -1 })
      .limit(args.limit)
      .lean<MessageCandidate[]>();

    let scanned = 0;
    let matched = 0;
    let updated = 0;
    let skippedProduct = 0;
    let missingParent = 0;

    for (const message of candidates) {
      scanned += 1;
      const { contextMessageId, hasReferredProduct } = extractReplyContext(
        message.rawSourcePayload
      );
      if (!contextMessageId) continue;
      if (hasReferredProduct) {
        skippedProduct += 1;
        continue;
      }

      matched += 1;
      const parent = await findParentMessage({
        conversationId: message.conversation,
        contextMessageId,
      });
      if (!parent) missingParent += 1;

      const whatsappMeta = buildWhatsAppStoredReplyMeta({
        replyToMessageId: parent?.messageId || contextMessageId,
        parent,
      });

      console.log(
        JSON.stringify({
          conversationId,
          messageId: message.messageId,
          text: message.text,
          contextMessageId,
          parentFound: Boolean(parent),
          whatsappMeta,
        })
      );

      if (!args.apply) continue;

      await Message.updateOne(
        { _id: message._id },
        { $set: { whatsappMeta } }
      );
      updated += 1;
    }

    console.log(
      JSON.stringify({
        conversationId,
        scanned,
        matched,
        updated,
        skippedProduct,
        missingParent,
      })
    );
  }
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });

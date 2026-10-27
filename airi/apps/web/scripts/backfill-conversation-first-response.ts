import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import {
  buildConversationFirstResponseUpdate,
  toConversationMessageDate,
  type ConversationFirstResponseUpdate,
} from "../src/lib/conversation-message-denorm";

type BackfillArgs = {
  limit: number;
  workspaceId: string | null;
  dryRun: boolean;
};

type ConversationCandidate = {
  _id: unknown;
  workspaceId?: string | null;
  first_inbound_at?: Date | string | null;
};

type MessageCandidate = {
  _id: unknown;
  workspaceId?: string | null;
  conversation?: unknown;
  direction?: string | null;
  date?: Date | string | null;
  author?: unknown;
  origin?: {
    kind?: string | null;
    sentByUserId?: string | null;
  } | null;
};

type UserMeta = {
  isBot?: boolean | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
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

function parseArgs(argv: string[]): BackfillArgs {
  const args: BackfillArgs = {
    limit: 500,
    workspaceId: null,
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg.startsWith("--limit=")) {
      const limit = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(limit) && limit > 0) {
        args.limit = limit;
      }
    } else if (arg.startsWith("--workspace-id=")) {
      const workspaceId = arg.slice("--workspace-id=".length).trim();
      args.workspaceId = workspaceId || null;
    }
  }

  return args;
}

function formatUserName(user: UserMeta | null): string | null {
  if (!user) return null;
  const fullName = [user.firstName, user.lastName]
    .map(value => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(" ");
  return fullName || user.username?.trim() || null;
}

async function loadUserMeta(author: unknown): Promise<UserMeta | null> {
  if (author === null || author === undefined) return null;
  const authorId = String(author).trim();
  if (!authorId || authorId === "0") return null;

  const { default: User } = await import("../src/models/user");
  return User.findById(author)
    .select("isBot firstName lastName username")
    .lean<UserMeta | null>();
}

async function buildFirstResponseUpdateForMessage(message: MessageCandidate) {
  const immediateUpdate = buildConversationFirstResponseUpdate(message);
  const userMeta = await loadUserMeta(message.author).catch(() => null);

  return (
    buildConversationFirstResponseUpdate(message, {
      authorIsHuman: userMeta?.isBot === false,
      managerName: formatUserName(userMeta),
    }) || immediateUpdate
  );
}

async function findFirstResponseUpdate(
  conversation: ConversationCandidate
): Promise<ConversationFirstResponseUpdate | null> {
  const firstInboundAt = toConversationMessageDate(
    conversation.first_inbound_at
  );
  if (!firstInboundAt || !conversation.workspaceId) return null;

  const { default: Message } = await import("../src/models/message");
  const candidates = await Message.find({
    workspaceId: conversation.workspaceId,
    conversation: conversation._id,
    direction: "outbound",
    date: { $gte: firstInboundAt },
    $or: [
      { "origin.kind": "manager" },
      {
        "origin.kind": { $exists: false },
        author: { $exists: true, $nin: [null, 0, "0"] },
      },
      {
        "origin.kind": null,
        author: { $exists: true, $nin: [null, 0, "0"] },
      },
    ],
  })
    .select("_id workspaceId conversation direction date author origin")
    .sort({ date: 1, _id: 1 })
    .limit(25)
    .lean<MessageCandidate[]>();

  for (const message of candidates) {
    const update = await buildFirstResponseUpdateForMessage(message);
    if (update) return update;
  }

  return null;
}

async function main() {
  loadMongoEnv();

  const args = parseArgs(process.argv.slice(2));
  const [{ default: connectDB }, { Conversation }, { ensureIndexes }] =
    await Promise.all([
      import("../src/lib/mongoose"),
      import("../src/models/conversation"),
      import("../src/lib/mongo"),
    ]);

  await connectDB();
  await ensureIndexes();

  const filter: Record<string, unknown> = {
    first_response_at: null,
    first_inbound_at: { $type: "date" },
  };
  if (args.workspaceId) {
    filter.workspaceId = args.workspaceId;
  }

  const conversations = await Conversation.find(filter)
    .select("_id workspaceId first_inbound_at")
    .sort({ first_inbound_at: 1, _id: 1 })
    .limit(args.limit)
    .lean<ConversationCandidate[]>();

  let matched = 0;
  let updated = 0;

  for (const conversation of conversations) {
    const update = await findFirstResponseUpdate(conversation);
    if (!update) continue;

    matched += 1;
    if (args.dryRun) continue;

    const result = await Conversation.updateOne(
      update.filter,
      update.update
    ).exec();
    updated += result.modifiedCount || 0;
  }

  console.log(
    JSON.stringify(
      {
        scanned: conversations.length,
        matched,
        updated,
        dryRun: args.dryRun,
        limit: args.limit,
        workspaceId: args.workspaceId,
      },
      null,
      2
    )
  );
}

main()
  .catch(error => {
    console.error(
      error instanceof Error
        ? error.message
        : "Failed to backfill conversation first response."
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });

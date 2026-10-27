import mongoose from "mongoose";

/**
 * Brings Instagram rows saved by older webhook code in line with what it
 * stores now:
 * - inbound media still on Meta's CDN is copied into our storage and typed by
 *   its bytes (an `unsupported_type` clip becomes a video);
 * - a shared reel stored as a "video" of its instagram.com page becomes its
 *   label and link;
 * - a reply typed in the Instagram app, saved as Airi's, becomes the business
 *   account's (`lib/instagram/business-author`), with a manager origin.
 * Meta's links expire within days, so older media fails to copy and is left
 * as it is. A row changes only while it still holds the old value. Airi usage
 * already counted for app replies is not given back.
 *
 * Dry run by default: it lists what it would do, without downloading.
 *   pnpm backfill:instagram-messages --workspace-id=<id>
 *   pnpm backfill:instagram-messages --apply --workspace-id=<id>
 * Output is counts and message ids, never media links or message text.
 */

type Outcome =
  | "wouldCopy"
  | "wouldRelink"
  | "wouldReattribute"
  | "copied"
  | "relinked"
  | "reattributed"
  | "notCopied"
  | "changedConcurrently";

type InstagramEchoRow = {
  _id: mongoose.Types.ObjectId;
  conversation: unknown;
  rawSourcePayload?: { payload?: { sender?: { id?: unknown } } } | null;
};

type InstagramRow = {
  _id: mongoose.Types.ObjectId;
  messageId?: string | null;
  conversation: unknown;
  text?: string | null;
  imageUrl: string;
  rawSourcePayload?: { payload?: { message?: unknown } } | null;
};

function parseArgs(argv: string[]) {
  let workspaceId: string | null = null;
  let dryRun = true;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--apply") {
      dryRun = false;
    } else if (arg.startsWith("--workspace-id=")) {
      workspaceId = arg.slice("--workspace-id=".length).trim() || null;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!workspaceId) throw new Error("--workspace-id is required");
  return { workspaceId, dryRun };
}

async function main() {
  const { workspaceId, dryRun } = parseArgs(process.argv.slice(2));
  const [
    { default: connectDB },
    { default: Message },
    { Conversation },
    display,
    { handleInstagramMedia },
    { isMediaPlaceholderText },
    businessAuthor,
  ] = await Promise.all([
    import("../src/lib/mongoose"),
    import("../src/models/message"),
    import("../src/models/conversation"),
    import("../src/lib/provider-message-display"),
    import("../src/lib/media/handler"),
    import("../src/lib/media/message-media-utils"),
    import("../src/lib/instagram/business-author"),
  ]);

  await connectDB();

  const rows = await Message.find({
    workspaceId,
    channel: "instagram",
    direction: "inbound",
    imageUrl: { $type: "string" },
  })
    .select("_id messageId conversation text imageUrl rawSourcePayload")
    .sort({ _id: 1 })
    .lean<InstagramRow[]>();

  const counts: Partial<Record<Outcome, number>> = {};
  const messageIds: Partial<Record<Outcome, string[]>> = {};
  const notCopiedReasons: Record<string, number> = {};
  let scannedEchoes = 0;
  const record = (outcome: Outcome, id: string) => {
    counts[outcome] = (counts[outcome] || 0) + 1;
    (messageIds[outcome] ??= []).push(id);
  };

  try {
    for (const row of rows) {
      const id = String(row._id);
      const unchanged = { _id: row._id, imageUrl: row.imageUrl };

      if (display.isInstagramCdnMediaUrl(row.imageUrl)) {
        if (dryRun) {
          record("wouldCopy", id);
          continue;
        }
        let media: Awaited<ReturnType<typeof handleInstagramMedia>>;
        try {
          media = await handleInstagramMedia(
            row.imageUrl,
            workspaceId,
            String(row.conversation),
            row.messageId || id
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : "unknown";
          notCopiedReasons[reason] = (notCopiedReasons[reason] || 0) + 1;
          record("notCopied", id);
          continue;
        }
        const result = await Message.updateOne(unchanged, {
          $set: {
            imageUrl: media.publicUrl,
            mediaType: media.mediaType,
            mimeType: media.contentType,
            fileSize: media.size,
            ...(isMediaPlaceholderText(row.text)
              ? { text: `[${media.mediaType} attachment]` }
              : {}),
          },
        });
        record(result.matchedCount ? "copied" : "changedConcurrently", id);
        continue;
      }

      const content = display.resolveInstagramMessageContent(
        row.rawSourcePayload?.payload?.message
      );
      if (
        content.providerEventKind !== "instagram_reel_share" ||
        content.imageUrl
      ) {
        continue;
      }
      if (dryRun) {
        record("wouldRelink", id);
        continue;
      }
      const result = await Message.updateOne(unchanged, {
        $set: { text: content.text, imageUrl: null, mediaType: null },
      });
      record(result.matchedCount ? "relinked" : "changedConcurrently", id);
    }

    // Echoes not matched to one of our sends were typed in the Instagram app.
    const echoes = await Message.find({
      workspaceId,
      channel: "instagram",
      direction: "outbound",
      "rawSourcePayload.eventType": "message_echo",
      author: { $in: [0, "0"] },
      "origin.kind": null,
    })
      .select("_id conversation rawSourcePayload.payload.sender")
      .sort({ _id: 1 })
      .lean<InstagramEchoRow[]>();
    scannedEchoes = echoes.length;
    const sourceIds = new Map<string, string | null>();
    for (const echo of echoes) {
      const id = String(echo._id);
      const businessAccountId = String(
        echo.rawSourcePayload?.payload?.sender?.id || ""
      );
      if (!businessAccountId) continue;
      if (dryRun) {
        record("wouldReattribute", id);
        continue;
      }
      const conversationId = String(echo.conversation);
      if (!sourceIds.has(conversationId)) {
        const conversation = await Conversation.findById(conversationId)
          .select("sourceId")
          .lean<{ sourceId?: string | null } | null>();
        sourceIds.set(conversationId, conversation?.sourceId || null);
      }
      const author =
        await businessAuthor.upsertInstagramBusinessAuthor(businessAccountId);
      const result = await Message.updateOne(
        { _id: echo._id, author: { $in: [0, "0"] }, "origin.kind": null },
        {
          $set: {
            author: author._id,
            origin: {
              kind: "manager",
              sourceId: sourceIds.get(conversationId),
              sentByUserId:
                businessAuthor.instagramBusinessAuthorId(businessAccountId),
            },
          },
        }
      );
      record(result.matchedCount ? "reattributed" : "changedConcurrently", id);
    }
  } finally {
    await mongoose.disconnect();
  }

  console.log(
    JSON.stringify(
      {
        workspaceId,
        dryRun,
        scanned: rows.length,
        scannedEchoes,
        counts,
        notCopiedReasons,
        messageIds,
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

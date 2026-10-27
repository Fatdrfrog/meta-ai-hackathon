import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import mongoose from "mongoose";
import { buildHistoryRetentionPreview } from "../src/lib/history-retention-preview";

async function main() {
  const { values } = parseArgs({
    options: {
      "company-id": { type: "string" },
      "workspace-id": { type: "string" },
      "retention-days": { type: "string" },
      after: { type: "string" },
      limit: { type: "string", default: "50" },
      output: { type: "string" },
    },
    strict: true,
  });
  const companyId = values["company-id"];
  const workspaceId = values["workspace-id"];
  const retentionDays = Number(values["retention-days"]);
  const limit = Number(values.limit);
  if (
    !companyId ||
    !workspaceId ||
    !values.output ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (values.after && !mongoose.isValidObjectId(values.after))
  ) {
    throw new Error(
      "Use --company-id, --workspace-id, --retention-days, --output and optional --after/--limit (1-100)."
    );
  }
  buildHistoryRetentionPreview({
    companyId,
    workspaceId,
    retentionDays,
    now: new Date(),
    conversations: [],
  });
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { data, error } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error || !data)
    throw new Error("Workspace ownership could not be verified.");
  await mongoose.connect(process.env.MONGODB_URI!, { autoIndex: false });
  const db = mongoose.connection.db!;
  const rows = await db
    .collection("conversations")
    .find(
      {
        workspaceId,
        ...(values.after
          ? { _id: { $gt: new mongoose.Types.ObjectId(values.after) } }
          : {}),
      },
      {
        projection: {
          _id: 1,
          workspaceId: 1,
          status: 1,
          lastMessageAt: 1,
          updatedAt: 1,
          service_closed_at: 1,
          "classification_state.status": 1,
          "airi_scenario_state.lockedScenarioId": 1,
          "airi_pending_generative_execution.executionId": 1,
        },
        sort: { _id: 1 },
        hint: { workspaceId: 1, _id: 1 },
        limit: limit + 1,
        maxTimeMS: 5000,
      }
    )
    .toArray();
  const conversations = [];
  for (const conversation of rows.slice(0, limit)) {
    const messages = await db
      .collection("messages")
      .find(
        { workspaceId, conversation: conversation._id },
        {
          projection: {
            _id: 1,
            workspaceId: 1,
            conversation: 1,
            date: 1,
            fileSize: 1,
            "mediaAnalysis.status": 1,
            "temporalDispatch.state": 1,
            "rawSourcePayload.payload.type": 1,
            "rawSourcePayload.payload.message.type": 1,
            "rawSourcePayload.payload.messages.type": 1,
            "rawSourcePayload.payload.entry.changes.value.messages.type": 1,
          },
          sort: { date: 1 },
          hint: { workspaceId: 1, conversation: 1, date: 1 },
          limit: 1001,
          maxTimeMS: 5000,
        }
      )
      .toArray();
    conversations.push({
      conversation,
      messages: messages.slice(0, 1000),
      messagesComplete: messages.length <= 1000,
    });
  }
  const result = buildHistoryRetentionPreview({
    companyId,
    workspaceId,
    retentionDays,
    now: new Date(),
    conversations,
  });
  await writeFile(
    values.output,
    JSON.stringify(
      {
        ...result,
        nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null,
        exportManifest: result.candidates.map(candidate => ({
          conversationId: candidate.conversationId,
          messageIds: candidate.messageIds,
        })),
        exclusions: [
          "open or recently updated conversations",
          "scenario state",
          "pending analysis and media recovery",
          "incomplete message pages",
          "all operational recovery and deduplication collections",
        ],
      },
      null,
      2
    ) + "\n",
    { flag: "wx" }
  );
  process.stdout.write(
    `Wrote preview for ${conversations.length} conversations. No data was changed.\n`
  );
}

main()
  .catch(() => {
    process.stderr.write(
      "History retention preview failed. Check arguments, ownership, indexes and database access.\n"
    );
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

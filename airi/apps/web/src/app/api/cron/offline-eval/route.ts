import { verifyCronAuth } from "@/lib/cron-auth";
import connectDB from "@/lib/mongoose";
import { withAnalyticsQueryBudget } from "@/lib/analytics/analytics-query-service";
import { throwIfCancelled } from "@/lib/ai/cancellation";
import {
  buildOfflineEvaluationPipeline,
  summarizeOfflineEvaluation,
  type OfflineEvaluationPair,
} from "@/lib/classifier/offline-evaluation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  Conversation,
  CONVERSATION_OFFLINE_EVAL_INDEX,
} from "@/models/conversation";
import { NextResponse } from "next/server";

const SNAPSHOT_BATCH_SIZE = 100;

export async function GET(request: Request) {
  const denied = verifyCronAuth(request);
  if (denied) return denied;

  try {
    const until = new Date();
    const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
    const results = await withAnalyticsQueryBudget({
      signal: request.signal,
      run: async ({ signal, remainingMs }) => {
        await connectDB();
        const pairs = await Conversation.aggregate<OfflineEvaluationPair>(
          buildOfflineEvaluationPipeline(since, until)
        )
          .option({
            hint: CONVERSATION_OFFLINE_EVAL_INDEX.options.name,
            allowDiskUse: false,
            maxTimeMS: remainingMs(),
            signal,
          })
          .exec();
        remainingMs();
        const summaries = summarizeOfflineEvaluation(pairs);
        for (
          let offset = 0;
          offset < summaries.length;
          offset += SNAPSHOT_BATCH_SIZE
        ) {
          remainingMs();
          // Snapshot storage remains best effort, but cannot outlive the run.
          try {
            await supabaseAdmin
              .from("classification_eval_snapshots")
              .insert(
                summaries
                  .slice(offset, offset + SNAPSHOT_BATCH_SIZE)
                  .map(summary => ({
                    workspace_key: summary.workspace_key,
                    snapshot: summary,
                  }))
              )
              .abortSignal(signal);
          } catch (error) {
            throwIfCancelled(signal, error);
          }
          remainingMs();
        }
        return summaries;
      },
    });

    return NextResponse.json({ status: "ok", groups: results.length, results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

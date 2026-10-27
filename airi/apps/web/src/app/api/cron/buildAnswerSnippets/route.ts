import { resolveSnippetEmbedding } from "@/lib/airi/snippet-embedding";
import { detectLanguage } from "@/lib/airi/language-detector-server";
import { verifyCronAuth } from "@/lib/cron-auth";
import connectDB from "@/lib/mongoose";
import AnswerSnippet, {
  buildAnswerSnippetQuestionKey,
  buildLegacyAnswerSnippetQuestionRegex,
  ensureAnswerSnippetIndexes,
} from "@/models/answer-snippet";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { NextRequest, NextResponse } from "next/server";
import { toMongoTextLanguage } from "@/lib/mongo-text-language";

function isAck(text: string) {
  const t = (text || "").toLowerCase();
  return /(thanks|thank you|solved|great|ok|спасибо|рахмет|решено|ок|отлично)/i.test(
    t
  );
}

export async function POST(request: NextRequest) {
  const denied = verifyCronAuth(request);
  if (denied) return denied;
  try {
    await connectDB();
    await ensureAnswerSnippetIndexes();
    const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 14); // last 14 days
    const convos = await Conversation.find({ updatedAt: { $gte: since } })
      .select("_id workspaceId messages")
      .limit(500)
      .lean();

    let inserted = 0;
    for (const c of convos) {
      const msgs = await Message.find({ conversation: c._id })
        .sort({ date: 1 })
        .select("_id text direction date")
        .lean();
      if (msgs.length < 2) continue;
      // Heuristic: last inbound is an acknowledgement after an agent outbound
      const last = msgs[msgs.length - 1];
      const prev = msgs[msgs.length - 2];
      if (
        last.direction === "inbound" &&
        prev.direction === "outbound" &&
        isAck(last.text || "")
      ) {
        // Find the closest inbound question before the outbound answer
        let question = "";
        for (let i = msgs.length - 3; i >= 0; i--) {
          if (msgs[i].direction === "inbound" && (msgs[i].text || "").trim()) {
            question = msgs[i].text || "";
            break;
          }
        }
        const answer = (prev.text || "").replace(/^Airi:\s*/, "");
        if (!question || !answer) continue;
        const questionKey = buildAnswerSnippetQuestionKey(question);
        let existing = await AnswerSnippet.findOne({
          workspaceId: c.workspaceId,
          questionKey,
        })
          .sort({ updatedAt: -1 })
          .select(
            "_id question answer embedding embeddingFallback embeddingUpdatedAt embeddingProvider embeddingModel embeddingTaskType embeddingDimensions"
          )
          .lean<{
            _id?: unknown;
            question?: string;
            answer?: string;
            embedding?: number[];
            embeddingFallback?: boolean;
            embeddingProvider?: "vertex" | "openai";
            embeddingModel?: string;
            embeddingTaskType?: "RETRIEVAL_DOCUMENT";
            embeddingDimensions?: number;
            embeddingUpdatedAt?: Date | null;
          } | null>();

        if (!existing) {
          const legacyQuestionRegex =
            buildLegacyAnswerSnippetQuestionRegex(question);
          if (legacyQuestionRegex) {
            existing = await AnswerSnippet.findOne({
              workspaceId: c.workspaceId,
              question: legacyQuestionRegex,
            })
              .sort({ updatedAt: -1 })
              .select(
                "_id question answer embedding embeddingFallback embeddingUpdatedAt embeddingProvider embeddingModel embeddingTaskType embeddingDimensions"
              )
              .lean<{
                _id?: unknown;
                question?: string;
                answer?: string;
                embedding?: number[];
                embeddingFallback?: boolean;
                embeddingProvider?: "vertex" | "openai";
                embeddingModel?: string;
                embeddingTaskType?: "RETRIEVAL_DOCUMENT";
                embeddingDimensions?: number;
                embeddingUpdatedAt?: Date | null;
              } | null>();
          }
        }
        const embeddingResolution = await resolveSnippetEmbedding({
          workspaceId: String(c.workspaceId || ""),
          question,
          answer,
          existingEmbedding: existing?.embedding,
          existingEmbeddingFallback: existing?.embeddingFallback,
          existingMetadata: existing,
          existingContent: existing ?? undefined,
          context: "cron/buildAnswerSnippets",
        });
        // Detect language from question and answer text
        const detectedLanguage = await detectLanguage(`${question} ${answer}`);
        const mongoLanguage = toMongoTextLanguage(detectedLanguage);
        const updateFilter = existing?._id
          ? { _id: existing._id, workspaceId: c.workspaceId }
          : { workspaceId: c.workspaceId, questionKey };
        const shouldUpsert = !Boolean(existing?._id);
        await AnswerSnippet.findOneAndUpdate(
          updateFilter,
          {
            workspaceId: c.workspaceId,
            question,
            questionKey,
            answer,
            embedding: embeddingResolution.embedding,
            embeddingFallback: embeddingResolution.usedFallback,
            embeddingSource: embeddingResolution.source,
            embeddingProvider: embeddingResolution.metadata.embeddingProvider,
            embeddingModel: embeddingResolution.metadata.embeddingModel,
            embeddingTaskType: embeddingResolution.metadata.embeddingTaskType,
            embeddingDimensions:
              embeddingResolution.metadata.embeddingDimensions,
            embeddingUpdatedAt:
              embeddingResolution.source === "vertex" ||
              embeddingResolution.source === "openai"
                ? new Date()
                : existing?.embeddingUpdatedAt || null,
            language: detectedLanguage,
            mongoLanguage,
            safe: true,
            sourceMessageIds: [String(prev._id), String(last._id)],
          },
          { upsert: shouldUpsert, new: true }
        );
        inserted++;
      }
    }

    return NextResponse.json({ ok: true, inserted });
  } catch {
    return new NextResponse(JSON.stringify({ error: "Internal error" }), {
      status: 500,
    });
  }
}

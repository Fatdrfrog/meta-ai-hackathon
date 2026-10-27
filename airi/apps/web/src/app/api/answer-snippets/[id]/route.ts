import { detectLanguage } from "@/lib/airi/language-detector-server";
import { enqueueKnowledgeCanonicalSync } from "@/lib/airi/rag/knowledge/canonical-sync/enqueue-knowledge-canonical-sync";
import { resolveSnippetEmbedding } from "@/lib/airi/snippet-embedding";
import {
  DEFAULT_TAXONOMY,
  normalizeTaxonomyLabels,
} from "@/lib/classifier/taxonomy";
import { toMongoTextLanguage } from "@/lib/mongo-text-language";
import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { buildAnswerSnippetQuestionKey } from "@/models/answer-snippet";
import AnswerSnippet from "@/models/answer-snippet";
import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

type Params = Promise<{ id: string }>;

type PatchBody = {
  workspaceId?: string;
  question?: string;
  answer?: string;
  category?: string;
  tags?: string[];
};

export const runtime = "nodejs";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as PatchBody | null;
    const workspaceId =
      typeof body?.workspaceId === "string" ? body.workspaceId : "";
    const question =
      typeof body?.question === "string" ? body.question.trim() : "";
    const answer = typeof body?.answer === "string" ? body.answer.trim() : "";

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!question || !answer) {
      return NextResponse.json(
        { error: "question and answer are required" },
        { status: 400 }
      );
    }

    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { error: "Invalid snippet id" },
        { status: 400 }
      );
    }

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json(
        { error: "Access denied to this workspace" },
        { status: 403 }
      );
    }

    const [taxonomyResult, internalLabelsResult] = await Promise.all([
      supabase
        .from("taxonomies")
        .select("labels")
        .eq("workspace_id", workspaceId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("internal_labels")
        .select("name")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true)
        .order("name", { ascending: true }),
    ]);

    if (taxonomyResult.error) {
      console.warn("[answer-snippets/:id] Failed to load taxonomy labels", {
        workspaceId,
        error: taxonomyResult.error.message,
      });
    }

    if (internalLabelsResult.error) {
      console.warn("[answer-snippets/:id] Failed to load internal labels", {
        workspaceId,
        error: internalLabelsResult.error.message,
      });
    }

    const detectedLanguage = await detectLanguage(`${question} ${answer}`);
    const mongoLanguage = toMongoTextLanguage(detectedLanguage);
    const rawTaxonomyLabels = Array.isArray(taxonomyResult.data?.labels)
      ? taxonomyResult.data.labels
      : DEFAULT_TAXONOMY.labels;
    const allowedCategories = new Set(
      normalizeTaxonomyLabels(rawTaxonomyLabels).map(label => label.trim())
    );
    const allowedTags = new Set(
      (internalLabelsResult.data || [])
        .map(label => String(label.name || "").trim())
        .filter(Boolean)
    );

    const normalizedTags = Array.isArray(body?.tags)
      ? Array.from(
          new Set(
            body.tags
              .flatMap(item => (typeof item === "string" ? [item.trim()] : []))
              .filter(Boolean)
          )
        )
      : undefined;
    if (normalizedTags) {
      const invalidTags = normalizedTags.filter(tag => !allowedTags.has(tag));
      if (invalidTags.length > 0) {
        return NextResponse.json(
          { error: `Label '${invalidTags[0]}' is not in workspace labels` },
          { status: 400 }
        );
      }
    }

    const normalizedCategory =
      typeof body?.category === "string" && body.category.trim().length > 0
        ? body.category.trim()
        : undefined;
    if (normalizedCategory && !allowedCategories.has(normalizedCategory)) {
      return NextResponse.json(
        {
          error: `Category '${normalizedCategory}' is not in workspace taxonomy classifications`,
        },
        { status: 400 }
      );
    }

    await connectDB();
    const existing = await AnswerSnippet.findOne({ _id: id, workspaceId })
      .select(
        "question answer embedding embeddingFallback embeddingUpdatedAt embeddingProvider embeddingModel embeddingTaskType embeddingDimensions"
      )
      .lean<{
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
      return NextResponse.json({ error: "Snippet not found" }, { status: 404 });
    }
    const embeddingResolution = await resolveSnippetEmbedding({
      workspaceId,
      question,
      answer,
      existingEmbedding: existing.embedding,
      existingEmbeddingFallback: existing.embeddingFallback,
      existingMetadata: existing,
      existingContent: existing ?? undefined,
      context: `api/answer-snippets/[id]:id=${id}`,
    });

    const updated = await AnswerSnippet.findOneAndUpdate(
      { _id: id, workspaceId },
      {
        $set: {
          question,
          questionKey: buildAnswerSnippetQuestionKey(question),
          answer,
          embedding: embeddingResolution.embedding,
          embeddingFallback: embeddingResolution.usedFallback,
          embeddingSource: embeddingResolution.source,
          embeddingProvider: embeddingResolution.metadata.embeddingProvider,
          embeddingModel: embeddingResolution.metadata.embeddingModel,
          embeddingTaskType: embeddingResolution.metadata.embeddingTaskType,
          embeddingDimensions: embeddingResolution.metadata.embeddingDimensions,
          embeddingUpdatedAt:
            embeddingResolution.source === "vertex" ||
            embeddingResolution.source === "openai"
              ? new Date()
              : existing.embeddingUpdatedAt || null,
          language: detectedLanguage,
          mongoLanguage,
          safe: true,
          ...(normalizedCategory !== undefined && {
            category: normalizedCategory,
          }),
          ...(normalizedTags !== undefined && { tags: normalizedTags }),
        },
      },
      { new: true }
    ).lean<{
      _id: mongoose.Types.ObjectId;
      question: string;
      answer: string;
      category?: string;
      tags?: string[];
      updatedAt?: Date;
    } | null>();

    if (!updated) {
      return NextResponse.json({ error: "Snippet not found" }, { status: 404 });
    }

    enqueueKnowledgeCanonicalSync({
      context: "answer_snippet_patch",
      workspaceId,
      sourceKinds: ["curated_snippet"],
      executionId: `snippet-patch-${workspaceId}-${id}-${Date.now()}`,
    });

    return NextResponse.json({
      ok: true,
      item: {
        id: String(updated._id),
        question: updated.question,
        answer: updated.answer,
        category: updated.category || null,
        tags: updated.tags || [],
        updatedAt: updated.updatedAt || null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update snippet";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

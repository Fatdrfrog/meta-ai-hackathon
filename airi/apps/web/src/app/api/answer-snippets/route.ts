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
import AnswerSnippet, {
  buildAnswerSnippetQuestionKey,
  buildLegacyAnswerSnippetQuestionRegex,
  ensureAnswerSnippetIndexes,
} from "@/models/answer-snippet";
import { NextRequest, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");
  if (!workspaceId) {
    return new NextResponse(
      JSON.stringify({ error: "workspaceId is required" }),
      { status: 400 }
    );
  }

  // Verify user has access to this workspace
  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
    return new NextResponse(
      JSON.stringify({ error: "Access denied to this workspace" }),
      { status: 403 }
    );
  }

  await connectDB();
  await ensureAnswerSnippetIndexes();
  const docs = await AnswerSnippet.find({ workspaceId })
    .select("_id question answer category tags updatedAt")
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean();
  return NextResponse.json({
    items: docs.map(d => ({
      id: String(d._id),
      question: d.question,
      answer: d.answer,
      category: d.category || null,
      tags: d.tags || [],
      updatedAt: d.updatedAt,
    })),
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const body = (await request.json()) as {
    items: {
      question: string;
      answer: string;
      category?: string;
      tags?: string[];
    }[];
    workspaceId: string;
  };
  const items = Array.isArray(body.items) ? body.items : [];
  const workspaceId = body.workspaceId;

  if (!workspaceId) {
    return new NextResponse(
      JSON.stringify({ error: "workspaceId is required" }),
      { status: 400 }
    );
  }
  if (items.length === 0)
    return new NextResponse(JSON.stringify({ error: "No items" }), {
      status: 400,
    });

  // Verify user has access to this workspace
  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
    return new NextResponse(
      JSON.stringify({ error: "Access denied to this workspace" }),
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
    console.warn("[answer-snippets] Failed to load taxonomy labels", {
      workspaceId,
      error: taxonomyResult.error.message,
    });
  }

  if (internalLabelsResult.error) {
    console.warn("[answer-snippets] Failed to load internal labels", {
      workspaceId,
      error: internalLabelsResult.error.message,
    });
  }

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

  await connectDB();
  await ensureAnswerSnippetIndexes();
  const results: { id: string }[] = [];
  let fallbackCount = 0;
  for (const it of items) {
    const q = (it.question || "").trim();
    const a = (it.answer || "").trim();
    if (!q || !a) continue;
    const normalizedCategory =
      typeof it.category === "string" ? it.category.trim() : "";
    if (normalizedCategory && !allowedCategories.has(normalizedCategory)) {
      return new NextResponse(
        JSON.stringify({
          error: `Category '${normalizedCategory}' is not in workspace taxonomy classifications`,
        }),
        { status: 400 }
      );
    }

    const normalizedTags = Array.isArray(it.tags)
      ? Array.from(
          new Set(
            it.tags
              .flatMap(tag => (typeof tag === "string" ? [tag.trim()] : []))
              .filter(Boolean)
          )
        )
      : [];
    const invalidTags = normalizedTags.filter(tag => !allowedTags.has(tag));
    if (invalidTags.length > 0) {
      return new NextResponse(
        JSON.stringify({
          error: `Label '${invalidTags[0]}' is not in workspace labels`,
        }),
        { status: 400 }
      );
    }

    const questionKey = buildAnswerSnippetQuestionKey(q);
    let existing = await AnswerSnippet.findOne({
      workspaceId,
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
      const legacyQuestionRegex = buildLegacyAnswerSnippetQuestionRegex(q);
      if (legacyQuestionRegex) {
        existing = await AnswerSnippet.findOne({
          workspaceId,
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
      workspaceId,
      question: q,
      answer: a,
      existingEmbedding: existing?.embedding,
      existingEmbeddingFallback: existing?.embeddingFallback,
      existingMetadata: existing,
      existingContent: existing ?? undefined,
      context: `api/answer-snippets:workspace=${workspaceId}`,
    });
    if (embeddingResolution.usedFallback) {
      fallbackCount += 1;
    }
    // Detect language from question and answer text
    const detectedLanguage = await detectLanguage(`${q} ${a}`);
    const mongoLanguage = toMongoTextLanguage(detectedLanguage);
    const updateFilter = existing?._id
      ? { _id: existing._id, workspaceId }
      : { workspaceId, questionKey };
    const shouldUpsert = !Boolean(existing?._id);
    const doc = await AnswerSnippet.findOneAndUpdate(
      updateFilter,
      {
        workspaceId,
        question: q,
        questionKey,
        answer: a,
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
            : existing?.embeddingUpdatedAt || null,
        language: detectedLanguage,
        mongoLanguage,
        category: normalizedCategory || undefined,
        tags: normalizedTags,
        safe: true,
      },
      { upsert: shouldUpsert, new: true }
    );
    if (!doc) {
      throw new Error("Failed to upsert answer snippet");
    }
    results.push({ id: String(doc._id) });
  }

  enqueueKnowledgeCanonicalSync({
    context: "answer_snippet_upsert",
    workspaceId,
    sourceKinds: ["curated_snippet"],
    executionId: `snippet-upsert-${workspaceId}-${Date.now()}`,
  });

  return NextResponse.json({
    ok: true,
    upserted: results.length,
    fallbackUsed: fallbackCount > 0,
    fallbackCount,
    items: results,
  });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const workspaceId = searchParams.get("workspaceId");

  if (!id)
    return new NextResponse(JSON.stringify({ error: "Missing id" }), {
      status: 400,
    });
  if (!workspaceId) {
    return new NextResponse(
      JSON.stringify({ error: "workspaceId is required" }),
      { status: 400 }
    );
  }

  // Verify user has access to this workspace
  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
    return new NextResponse(
      JSON.stringify({ error: "Access denied to this workspace" }),
      { status: 403 }
    );
  }

  await connectDB();
  await AnswerSnippet.deleteOne({ _id: id, workspaceId });
  enqueueKnowledgeCanonicalSync({
    context: "answer_snippet_delete",
    workspaceId,
    sourceKinds: ["curated_snippet"],
    executionId: `snippet-delete-${workspaceId}-${id}-${Date.now()}`,
  });
  return NextResponse.json({ ok: true });
}

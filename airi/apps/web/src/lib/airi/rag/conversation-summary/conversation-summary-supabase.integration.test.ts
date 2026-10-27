import { randomUUID } from "crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import mongoose from "mongoose";

// Production's project refs (current, and the one it moved from on
// 2026-10-26) and its custom domain (docs/infrastructure/supabase-eu-move.md).
const PRODUCTION_PROJECT_REFS = [
  "eufcprvswhmkgzkmwxxs",
  "wnycyavumykzejnjelfb",
];
const PRODUCTION_CUSTOM_DOMAIN = "api.airi.chat";
const branchUrl = process.env.CLASSIFICATION_SUPABASE_TEST_URL;
const branchKey = process.env.CLASSIFICATION_SUPABASE_TEST_SERVICE_ROLE_KEY;
const mongoUri = process.env.CLASSIFICATION_CONTRACT_TEST_MONGODB_URI;

if (branchUrl) {
  const hostname = new URL(branchUrl).hostname;
  if (
    PRODUCTION_PROJECT_REFS.some(ref => hostname.includes(ref)) ||
    hostname === PRODUCTION_CUSTOM_DOMAIN
  ) {
    throw new Error(
      "Conversation summary integration refuses production Supabase"
    );
  }
}

jest.mock("@/lib/ai", () => ({
  getDocumentEmbeddingResultsBatch: jest.fn(async (texts: string[]) =>
    texts.map(() => ({
      embedding: Array.from({ length: 1536 }, (_, index) =>
        index === 0 ? 1 : 0
      ),
      provider: "vertex",
      model: "gemini-embedding-001",
      dimensions: 1536,
      taskType: "RETRIEVAL_DOCUMENT",
    }))
  ),
  getQueryEmbeddingWithCache: jest.fn(() => {
    throw new Error("Integration test must inject its query embedding");
  }),
  cosineSimilarity: (left: number[], right: number[]) => {
    const dot = left.reduce(
      (sum, value, index) => sum + value * right[index],
      0
    );
    const leftMagnitude = Math.sqrt(
      left.reduce((sum, value) => sum + value * value, 0)
    );
    const rightMagnitude = Math.sqrt(
      right.reduce((sum, value) => sum + value * value, 0)
    );
    return dot / (leftMagnitude * rightMagnitude);
  },
}));

jest.mock("@/lib/supabase/admin", () => {
  const { createClient } = jest.requireActual(
    "@supabase/supabase-js"
  ) as typeof import("@supabase/supabase-js");
  const configuredUrl =
    process.env.CLASSIFICATION_SUPABASE_TEST_URL ??
    "https://not-configured.supabase.co";
  const configuredKey =
    process.env.CLASSIFICATION_SUPABASE_TEST_SERVICE_ROLE_KEY ??
    "not-configured";
  const configuredHost = new URL(configuredUrl).hostname;
  if (
    configuredHost.includes("eufcprvswhmkgzkmwxxs") ||
    configuredHost.includes("wnycyavumykzejnjelfb") ||
    configuredHost === "api.airi.chat"
  ) {
    throw new Error(
      "Conversation summary integration refuses production Supabase"
    );
  }

  const rawClient = createClient(configuredUrl, configuredKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const controls = {
    requests: [] as Array<{
      method: string;
      url: string;
      status: number;
      errorCode: string | null;
    }>,
    injectDuplicateOnce: false,
    duplicateInjected: false,
    observeMainForConversationId: null as string | null,
    mainWriteObservations: [] as Array<{
      conversationId: string;
      existingMainCount: number;
      chunkIndexes: number[];
    }>,
  };

  const instrumentedFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    const requestUrl = new URL(request.url);
    const isSummaryRequest = requestUrl.pathname.endsWith(
      "/rest/v1/conversation_summaries"
    );
    let body: unknown = null;
    if (isSummaryRequest && ["POST", "PATCH"].includes(method)) {
      const rawBody = await request.clone().text();
      body = rawBody.length > 0 ? (JSON.parse(rawBody) as unknown) : null;
    }
    const bodyRow = Array.isArray(body) ? body[0] : body;
    const bodyRecord =
      bodyRow && typeof bodyRow === "object"
        ? (bodyRow as Record<string, unknown>)
        : null;

    if (
      isSummaryRequest &&
      method === "POST" &&
      controls.injectDuplicateOnce &&
      !controls.duplicateInjected &&
      bodyRecord
    ) {
      controls.duplicateInjected = true;
      const { error } = await rawClient
        .from("conversation_summaries")
        .insert(bodyRecord);
      if (error) throw error;
    }

    if (
      isSummaryRequest &&
      ["POST", "PATCH"].includes(method) &&
      bodyRecord?.conversation_id === controls.observeMainForConversationId &&
      bodyRecord.chunk_index === null
    ) {
      const conversationId = String(bodyRecord.conversation_id);
      const workspaceId = String(bodyRecord.workspace_id);
      const { data, error } = await rawClient
        .from("conversation_summaries")
        .select("chunk_index")
        .eq("workspace_id", workspaceId)
        .eq("conversation_id", conversationId);
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      controls.mainWriteObservations.push({
        conversationId,
        existingMainCount: rows.filter(row => row.chunk_index === null).length,
        chunkIndexes: rows
          .map(row => row.chunk_index)
          .filter((value): value is number => Number.isSafeInteger(value))
          .sort((left, right) => left - right),
      });
    }

    const response = await globalThis.fetch(request);
    let errorCode: string | null = null;
    if (!response.ok) {
      try {
        const payload = (await response.clone().json()) as unknown;
        if (
          payload &&
          typeof payload === "object" &&
          "code" in payload &&
          typeof payload.code === "string"
        ) {
          errorCode = payload.code;
        }
      } catch {
        errorCode = null;
      }
    }
    controls.requests.push({
      method,
      url: request.url,
      status: response.status,
      errorCode,
    });
    return response;
  };

  const supabaseAdmin = createClient(configuredUrl, configuredKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: instrumentedFetch },
  });
  return {
    supabaseAdmin,
    __conversationSummaryBranchHarness: { rawClient, controls },
  };
});

import { getDocumentEmbeddingResultsBatch } from "@/lib/ai";
import { retrieveConversationSummaries } from "@/lib/airi/rag/conversation-summary/conversation-summary-retrieval";
import { persistConversationSummaryRevision } from "@/lib/airi/rag/conversation-summary/conversation-summary-storage";
import {
  buildConversationSummarySlotId,
  buildConversationSummarySourceRevisionSortKey,
  isDenseFiniteNumberVector,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-versioning";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Conversation } from "@/models/conversation";

type BranchHarness = {
  rawClient: SupabaseClient;
  controls: {
    requests: Array<{
      method: string;
      url: string;
      status: number;
      errorCode: string | null;
    }>;
    injectDuplicateOnce: boolean;
    duplicateInjected: boolean;
    observeMainForConversationId: string | null;
    mainWriteObservations: Array<{
      conversationId: string;
      existingMainCount: number;
      chunkIndexes: number[];
    }>;
  };
};

const { __conversationSummaryBranchHarness: branchHarness } = jest.requireMock(
  "@/lib/supabase/admin"
) as { __conversationSummaryBranchHarness: BranchHarness };
const describeBranch =
  branchUrl && branchKey && mongoUri ? describe : describe.skip;
const fixedVector = (): number[] =>
  Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

function revisionInput(conversationId: string, sourceRevision: number) {
  return {
    workspaceId: testWorkspaceId,
    conversationId,
    analysisRevisionId: `${conversationId}:${sourceRevision}`,
    sourceRevision,
    completedAt: new Date(
      `2026-08-10T06:06:${String(sourceRevision).padStart(2, "0")}.000Z`
    ),
    ragSummary: {
      mode: "replace" as const,
      language: "en" as const,
      summary: `Main revision ${sourceRevision} for ${conversationId}`,
      chunks: [
        `Chunk zero revision ${sourceRevision} for ${conversationId}`,
        `Chunk one revision ${sourceRevision} for ${conversationId}`,
      ],
      metadata: {
        wordCount: 120 + sourceRevision,
        messageCount: 12 + sourceRevision,
        chunkCount: 2,
        generationTimeMs: 40 + sourceRevision,
      },
    },
  };
}

function versionMetadata(
  conversationId: string,
  sourceRevision: number,
  chunkIndex: number | null
): Record<string, unknown> {
  return {
    analysis_revision_id: `${conversationId}:${sourceRevision}`,
    source_revision: sourceRevision,
    source_revision_sort_key:
      buildConversationSummarySourceRevisionSortKey(sourceRevision),
    analysis_completed_at: `2026-08-10T06:06:${String(sourceRevision).padStart(2, "0")}.000Z`,
    language: "en",
    word_count: 120 + sourceRevision,
    message_count: 12 + sourceRevision,
    chunk_count: 2,
    generation_time_ms: 40 + sourceRevision,
    embedding_provider: "vertex",
    embedding_model: "gemini-embedding-001",
    embedding_task_type: "RETRIEVAL_DOCUMENT",
    embedding_dimensions: 1536,
    ...(chunkIndex === null ? {} : { chunk_index: chunkIndex }),
  };
}

const runId = randomUUID();
const testCompanyId = randomUUID();
const testWorkspaceId = randomUUID();
const mainLastConversationId = new mongoose.Types.ObjectId().toHexString();
const concurrentConversationId = new mongoose.Types.ObjectId().toHexString();
const sentinelConversationId = new mongoose.Types.ObjectId().toHexString();
const allConversationIds = [
  mainLastConversationId,
  concurrentConversationId,
  sentinelConversationId,
];

jest.setTimeout(120_000);

describeBranch("conversation summary real Supabase branch contract", () => {
  beforeAll(async () => {
    await mongoose.connect(mongoUri as string, {
      serverSelectionTimeoutMS: 5_000,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it("proves deterministic CAS, main-last visibility, current retrieval, and exact cleanup", async () => {
    try {
      const { error: companyError } = await supabaseAdmin
        .from("companies")
        .insert({
          id: testCompanyId,
          name: `Classification RAG ${runId}`,
          slug: `classification-rag-${runId}`,
          subscription_type: "free",
        });
      expect(companyError).toBeNull();
      const { error: workspaceError } = await supabaseAdmin
        .from("workspaces")
        .insert({
          id: testWorkspaceId,
          company_id: testCompanyId,
          name: `Classification RAG ${runId}`,
        });
      expect(workspaceError).toBeNull();

      branchHarness.controls.injectDuplicateOnce = true;
      branchHarness.controls.observeMainForConversationId =
        mainLastConversationId;
      await expect(
        persistConversationSummaryRevision(
          revisionInput(mainLastConversationId, 1)
        )
      ).resolves.toEqual({ status: "completed" });
      expect(branchHarness.controls.duplicateInjected).toBe(true);
      expect(
        branchHarness.controls.requests.some(
          request => request.errorCode === "23505"
        )
      ).toBe(true);
      expect(branchHarness.controls.mainWriteObservations).toEqual([
        {
          conversationId: mainLastConversationId,
          existingMainCount: 0,
          chunkIndexes: [0, 1],
        },
      ]);

      branchHarness.controls.observeMainForConversationId = null;
      await expect(
        persistConversationSummaryRevision(
          revisionInput(mainLastConversationId, 2)
        )
      ).resolves.toEqual({ status: "completed" });
      expect(
        branchHarness.controls.requests.some(request => {
          if (request.method !== "PATCH") return false;
          const requestUrl = new URL(request.url);
          return (
            requestUrl.searchParams.get("metadata->>analysis_revision_id") ===
            `eq.${mainLastConversationId}:1`
          );
        })
      ).toBe(true);

      const mainSlotId = buildConversationSummarySlotId({
        workspaceId: testWorkspaceId,
        conversationId: mainLastConversationId,
        chunkIndex: null,
      });
      const { data: persistedVectorRow, error: persistedVectorError } =
        await supabaseAdmin
          .from("conversation_summaries")
          .select("embedding")
          .eq("id", mainSlotId)
          .single();
      expect(persistedVectorError).toBeNull();
      const persistedVector =
        typeof persistedVectorRow?.embedding === "string"
          ? (JSON.parse(persistedVectorRow.embedding) as unknown)
          : persistedVectorRow?.embedding;
      expect(isDenseFiniteNumberVector(persistedVector, 1536)).toBe(true);
      const { error: wrongVectorError } = await branchHarness.rawClient
        .from("conversation_summaries")
        .insert({
          id: randomUUID(),
          workspace_id: testWorkspaceId,
          conversation_id: mainLastConversationId,
          summary_text: "Wrong vector shape must fail",
          chunk_index: null,
          embedding: fixedVector().slice(0, 1535),
          metadata: {},
        });
      expect(wrongVectorError?.message).toMatch(/dimension|1536/iu);

      const concurrentResults = await Promise.all([
        persistConversationSummaryRevision(
          revisionInput(concurrentConversationId, 1)
        ),
        persistConversationSummaryRevision(
          revisionInput(concurrentConversationId, 2)
        ),
      ]);
      expect(concurrentResults[1]).toEqual({ status: "completed" });
      expect(
        concurrentResults.every(result =>
          ["completed", "superseded"].includes(result.status)
        )
      ).toBe(true);
      const { data: concurrentRows, error: concurrentRowsError } =
        await supabaseAdmin
          .from("conversation_summaries")
          .select("id, summary_text, chunk_index, metadata")
          .eq("workspace_id", testWorkspaceId)
          .eq("conversation_id", concurrentConversationId);
      expect(concurrentRowsError).toBeNull();
      expect(concurrentRows).toHaveLength(3);
      expect(
        concurrentRows?.every(
          row =>
            row.metadata?.source_revision === 2 &&
            row.metadata?.analysis_revision_id ===
              `${concurrentConversationId}:2` &&
            String(row.summary_text).includes("revision 2")
        )
      ).toBe(true);

      await Conversation.collection.insertOne({
        _id: new mongoose.Types.ObjectId(concurrentConversationId),
        workspaceId: testWorkspaceId,
        channel: "whatsapp",
        messages: [],
        is_classified: true,
        classification_revision: 2,
        classification_state: {
          contractVersion: 2,
          status: "ready",
          requestedRevision: 2,
          appliedRevision: 2,
        },
        classification_meta: {
          provenance_kind: "v2",
          source_revision: 2,
          analysis_revision_id: `${concurrentConversationId}:2`,
        },
        createdAt: new Date("2026-08-10T06:00:00.000Z"),
        updatedAt: new Date("2026-08-10T06:06:02.000Z"),
      });
      const forgedRowId = randomUUID();
      const { error: forgedError } = await supabaseAdmin
        .from("conversation_summaries")
        .insert({
          id: forgedRowId,
          workspace_id: testWorkspaceId,
          conversation_id: concurrentConversationId,
          summary_text: "Forged RPC metadata-only candidate",
          chunk_index: null,
          embedding: fixedVector(),
          metadata: versionMetadata(concurrentConversationId, 2, null),
        });
      expect(forgedError).toBeNull();
      const retrieved = await retrieveConversationSummaries(
        testWorkspaceId,
        "query",
        { limit: 8, threshold: 0.8, queryEmbedding: fixedVector() }
      );
      expect(retrieved).toHaveLength(3);
      expect(
        retrieved.every(
          result =>
            result.conversationId === concurrentConversationId &&
            result.summaryText !== "Forged RPC metadata-only candidate"
        )
      ).toBe(true);

      const sentinelId = randomUUID();
      const exactLegacyId = randomUUID();
      const { error: extraRowsError } = await supabaseAdmin
        .from("conversation_summaries")
        .insert([
          {
            id: exactLegacyId,
            workspace_id: testWorkspaceId,
            conversation_id: concurrentConversationId,
            summary_text: "Exact legacy cleanup target",
            chunk_index: null,
            embedding: fixedVector(),
            metadata: { message_count: 1 },
          },
          {
            id: sentinelId,
            workspace_id: testWorkspaceId,
            conversation_id: sentinelConversationId,
            summary_text: "Other conversation sentinel",
            chunk_index: null,
            embedding: fixedVector(),
            metadata: { message_count: 1 },
          },
        ]);
      expect(extraRowsError).toBeNull();
      const deleteRequestStart = branchHarness.controls.requests.length;
      const embeddingCallsBeforeAbsence = (
        getDocumentEmbeddingResultsBatch as jest.Mock
      ).mock.calls.length;
      await expect(
        persistConversationSummaryRevision({
          ...revisionInput(concurrentConversationId, 2),
          ragSummary: null,
        })
      ).resolves.toEqual({ status: "completed" });
      expect(
        (getDocumentEmbeddingResultsBatch as jest.Mock).mock.calls.length
      ).toBe(embeddingCallsBeforeAbsence);
      const exactDeletes = branchHarness.controls.requests
        .slice(deleteRequestStart)
        .filter(request => request.method === "DELETE");
      expect(exactDeletes.length).toBeGreaterThanOrEqual(5);
      expect(
        exactDeletes.every(request => {
          const requestUrl = new URL(request.url);
          return (
            requestUrl.searchParams.get("id")?.startsWith("eq.") === true &&
            requestUrl.searchParams.get("workspace_id") ===
              `eq.${testWorkspaceId}` &&
            requestUrl.searchParams.get("conversation_id") ===
              `eq.${concurrentConversationId}`
          );
        })
      ).toBe(true);
      const { data: deletedConversationRows, error: deletedConversationError } =
        await supabaseAdmin
          .from("conversation_summaries")
          .select("id")
          .eq("workspace_id", testWorkspaceId)
          .eq("conversation_id", concurrentConversationId);
      expect(deletedConversationError).toBeNull();
      expect(deletedConversationRows).toEqual([]);
      const { data: sentinelRows, error: sentinelError } = await supabaseAdmin
        .from("conversation_summaries")
        .select("id")
        .eq("id", sentinelId);
      expect(sentinelError).toBeNull();
      expect(sentinelRows).toHaveLength(1);
    } finally {
      const { error: summaryCleanupError } = await branchHarness.rawClient
        .from("conversation_summaries")
        .delete()
        .eq("workspace_id", testWorkspaceId)
        .in("conversation_id", allConversationIds);
      const { error: companyCleanupError } = await branchHarness.rawClient
        .from("companies")
        .delete()
        .eq("id", testCompanyId);
      const { data: remainingRows, error: cleanupVerificationError } =
        await branchHarness.rawClient
          .from("conversation_summaries")
          .select("id")
          .eq("workspace_id", testWorkspaceId)
          .limit(1);
      await Conversation.collection.deleteMany({
        _id: {
          $in: allConversationIds.map(id => new mongoose.Types.ObjectId(id)),
        },
      });
      expect(summaryCleanupError).toBeNull();
      expect(companyCleanupError).toBeNull();
      expect(cleanupVerificationError).toBeNull();
      expect(remainingRows).toEqual([]);
    }
  });
});

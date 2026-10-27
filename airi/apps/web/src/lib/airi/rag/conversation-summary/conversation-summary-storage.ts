import pLimit from "p-limit";

import {
  getDocumentEmbeddingResultsBatch,
  isEmbeddingMetadataCurrent,
} from "@/lib/ai";
import type { GeneratedEmbedding } from "@/lib/ai/embedding-types";
import { parseStoredEmbedding } from "@/lib/ai/embedding-storage";
import {
  areConversationSummaryVersionMetadataEqual,
  assertConversationSummaryStoredRowIdentity,
  buildConversationSummarySlotId,
  buildConversationSummarySourceRevisionSortKey,
  compareConversationSummaryVersionIdentities,
  isDenseFiniteNumberVector,
  parseConversationSummaryVersionMetadata,
  type ConversationSummaryStoredRow,
  type ConversationSummaryVersionMetadata,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-versioning";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ConversationClassificationEffectInputs } from "@/models/conversation-analysis-revision";
import { isRecord } from "@icecore/shared/lib/value-utils";

const SLOT_CAS_ATTEMPTS = 8;
const SLOT_WRITE_CONCURRENCY = 8;
const CLEANUP_PAGE_SIZE = 100;
const CLEANUP_OBSERVATION_LIMIT = 512;
const ROW_SELECT =
  "id, workspace_id, conversation_id, summary_text, chunk_index, metadata, embedding, created_at, updated_at";
const CLEANUP_ROW_SELECT =
  "id, workspace_id, conversation_id, summary_text, chunk_index, metadata, created_at, updated_at";

type PersistConversationSummaryRevisionInput = {
  workspaceId: string;
  conversationId: string;
  analysisRevisionId: string;
  sourceRevision: number;
  completedAt: Date;
  ragSummary: ConversationClassificationEffectInputs["ragSummary"];
  existingEmbedding?: { text: string; result: GeneratedEmbedding };
};

type PersistConversationSummaryRevisionResult = {
  status: "completed" | "superseded";
};

type SlotTarget = {
  row: ConversationSummaryStoredRow & { embedding: number[] };
  metadata: ConversationSummaryVersionMetadata;
};

function asError(error: unknown, fallback: string): Error {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return new Error(error.message);
  }
  return new Error(fallback);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  );
}

function normalizeStoredRow(value: unknown): ConversationSummaryStoredRow {
  if (!isRecord(value)) {
    throw new Error("Conversation summary row is invalid");
  }
  const chunkIndex = value.chunk_index;
  if (
    typeof value.id !== "string" ||
    typeof value.workspace_id !== "string" ||
    typeof value.conversation_id !== "string" ||
    typeof value.summary_text !== "string" ||
    (chunkIndex !== null && !Number.isSafeInteger(chunkIndex))
  ) {
    throw new Error("Conversation summary row is invalid");
  }
  return {
    id: value.id,
    workspace_id: value.workspace_id,
    conversation_id: value.conversation_id,
    summary_text: value.summary_text,
    chunk_index: chunkIndex as number | null,
    metadata: value.metadata,
    ...(Object.prototype.hasOwnProperty.call(value, "embedding")
      ? { embedding: value.embedding }
      : {}),
    ...(typeof value.created_at === "string" || value.created_at === null
      ? { created_at: value.created_at }
      : {}),
    ...(typeof value.updated_at === "string" || value.updated_at === null
      ? { updated_at: value.updated_at }
      : {}),
  };
}

function assertCanonicalInput(
  input: PersistConversationSummaryRevisionInput
): void {
  buildConversationSummarySlotId({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    chunkIndex: null,
  });
  if (
    typeof input.analysisRevisionId !== "string" ||
    input.analysisRevisionId.length === 0 ||
    input.analysisRevisionId !== input.analysisRevisionId.trim()
  ) {
    throw new Error("analysisRevisionId is invalid");
  }
  buildConversationSummarySourceRevisionSortKey(input.sourceRevision);
  if (
    !(input.completedAt instanceof Date) ||
    !Number.isFinite(input.completedAt.getTime())
  ) {
    throw new Error("completedAt is invalid");
  }
  if (input.ragSummary === null) return;
  const { ragSummary } = input;
  if (
    typeof ragSummary.summary !== "string" ||
    ragSummary.summary.trim().length === 0 ||
    !Array.isArray(ragSummary.chunks) ||
    ragSummary.chunks.some(
      chunk => typeof chunk !== "string" || chunk.trim().length === 0
    ) ||
    ragSummary.metadata.chunkCount !== ragSummary.chunks.length
  ) {
    throw new Error("ragSummary is invalid");
  }
}

function validateEmbeddingBatch(
  results: (GeneratedEmbedding | null)[],
  expectedCount: number
): GeneratedEmbedding[] {
  if (!Array.isArray(results) || results.length !== expectedCount) {
    throw new Error("Conversation summary embedding batch is invalid");
  }
  const first = results[0];
  if (!first) {
    throw new Error("Conversation summary embedding batch is invalid");
  }
  for (const result of results) {
    if (
      !result ||
      !isDenseFiniteNumberVector(result.embedding, 1536) ||
      result.taskType !== "RETRIEVAL_DOCUMENT" ||
      result.dimensions !== 1536 ||
      typeof result.provider !== "string" ||
      result.provider.trim().length === 0 ||
      typeof result.model !== "string" ||
      result.model.trim().length === 0 ||
      result.provider !== first.provider ||
      result.model !== first.model ||
      result.taskType !== first.taskType ||
      result.dimensions !== first.dimensions
    ) {
      throw new Error("Conversation summary embedding batch is invalid");
    }
  }
  return results as GeneratedEmbedding[];
}

function buildVersionMetadata(input: {
  request: PersistConversationSummaryRevisionInput;
  embedding: GeneratedEmbedding;
  chunkIndex: number | null;
}): Record<string, unknown> {
  const ragSummary = input.request.ragSummary;
  if (!ragSummary) throw new Error("ragSummary is required");
  return {
    analysis_revision_id: input.request.analysisRevisionId,
    source_revision: input.request.sourceRevision,
    source_revision_sort_key: buildConversationSummarySourceRevisionSortKey(
      input.request.sourceRevision
    ),
    analysis_completed_at: input.request.completedAt.toISOString(),
    language: ragSummary.language,
    word_count: ragSummary.metadata.wordCount,
    message_count: ragSummary.metadata.messageCount,
    chunk_count: ragSummary.metadata.chunkCount,
    generation_time_ms: ragSummary.metadata.generationTimeMs,
    embedding_provider: input.embedding.provider,
    embedding_model: input.embedding.model,
    embedding_task_type: input.embedding.taskType,
    embedding_dimensions: input.embedding.dimensions,
    ...(input.chunkIndex === null ? {} : { chunk_index: input.chunkIndex }),
  };
}

function buildTargets(
  input: PersistConversationSummaryRevisionInput,
  embeddings: GeneratedEmbedding[]
): { main: SlotTarget; chunks: SlotTarget[] } {
  const ragSummary = input.ragSummary;
  if (!ragSummary) throw new Error("ragSummary is required");
  const buildTarget = (
    summaryText: string,
    chunkIndex: number | null,
    embedding: GeneratedEmbedding
  ): SlotTarget => {
    const metadataValue = buildVersionMetadata({
      request: input,
      embedding,
      chunkIndex,
    });
    const parsedMetadata = parseConversationSummaryVersionMetadata(
      metadataValue,
      { chunkIndex }
    );
    if (!parsedMetadata) {
      throw new Error("Conversation summary version metadata is invalid");
    }
    return {
      row: {
        id: buildConversationSummarySlotId({
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          chunkIndex,
        }),
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        summary_text: summaryText,
        chunk_index: chunkIndex,
        embedding: [...embedding.embedding],
        metadata: metadataValue,
      },
      metadata: parsedMetadata,
    };
  };

  return {
    main: buildTarget(ragSummary.summary, null, embeddings[0]),
    chunks: ragSummary.chunks.map((chunk, index) =>
      buildTarget(chunk, index, embeddings[index + 1])
    ),
  };
}

async function readSlot(
  id: string
): Promise<ConversationSummaryStoredRow | null> {
  const { data, error } = await supabaseAdmin
    .from("conversation_summaries")
    .select(ROW_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw asError(error, "Conversation summary slot read failed");
  return data === null ? null : normalizeStoredRow(data);
}

function hasPersistedEmbedding(value: unknown): boolean {
  if (Array.isArray(value)) {
    return isDenseFiniteNumberVector(value, 1536);
  }
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isDenseFiniteNumberVector(parsed, 1536);
  } catch {
    return false;
  }
}

function assertSameSlotPayload(
  stored: ConversationSummaryStoredRow,
  target: SlotTarget
): void {
  try {
    assertConversationSummaryStoredRowIdentity(stored, {
      workspaceId: target.row.workspace_id,
      conversationId: target.row.conversation_id,
      chunkIndex: target.row.chunk_index,
    });
  } catch {
    throw new Error("Conversation summary immutable revision conflict");
  }
  const metadata = parseConversationSummaryVersionMetadata(stored.metadata, {
    chunkIndex: stored.chunk_index,
  });
  if (
    !metadata ||
    stored.id !== target.row.id ||
    stored.workspace_id !== target.row.workspace_id ||
    stored.conversation_id !== target.row.conversation_id ||
    stored.summary_text !== target.row.summary_text ||
    stored.chunk_index !== target.row.chunk_index ||
    !hasPersistedEmbedding(stored.embedding) ||
    !areConversationSummaryVersionMetadataEqual(metadata, target.metadata, {
      includeChunkIndex: true,
    })
  ) {
    throw new Error("Conversation summary immutable revision conflict");
  }
}

async function insertSlot(target: SlotTarget): Promise<"inserted" | "race"> {
  const { data, error } = await supabaseAdmin
    .from("conversation_summaries")
    .insert(target.row)
    .select(ROW_SELECT)
    .single();
  if (error) {
    if (isUniqueViolation(error)) return "race";
    throw asError(error, "Conversation summary slot insert failed");
  }
  assertSameSlotPayload(normalizeStoredRow(data), target);
  return "inserted";
}

async function updateObservedSlot(input: {
  target: SlotTarget;
  observedAnalysisRevisionId: string;
}): Promise<boolean> {
  const payload = {
    workspace_id: input.target.row.workspace_id,
    conversation_id: input.target.row.conversation_id,
    summary_text: input.target.row.summary_text,
    chunk_index: input.target.row.chunk_index,
    embedding: input.target.row.embedding,
    metadata: input.target.row.metadata,
  };
  const { data, error } = await supabaseAdmin
    .from("conversation_summaries")
    .update(payload)
    .eq("id", input.target.row.id)
    .eq("workspace_id", input.target.row.workspace_id)
    .eq("conversation_id", input.target.row.conversation_id)
    .eq("metadata->>analysis_revision_id", input.observedAnalysisRevisionId)
    .select("id")
    .maybeSingle();
  if (error) throw asError(error, "Conversation summary slot update failed");
  return data !== null;
}

async function writeSlot(
  target: SlotTarget
): Promise<"completed" | "superseded"> {
  for (let attempt = 0; attempt < SLOT_CAS_ATTEMPTS; attempt += 1) {
    const stored = await readSlot(target.row.id);
    if (!stored) {
      if ((await insertSlot(target)) === "inserted") return "completed";
      continue;
    }
    assertObservedTargetSlotIdentity(stored, target);
    const storedMetadata = parseConversationSummaryVersionMetadata(
      stored.metadata,
      { chunkIndex: stored.chunk_index }
    );
    if (!storedMetadata) {
      throw new Error("Conversation summary immutable revision conflict");
    }
    const comparison = compareConversationSummaryVersionIdentities(
      storedMetadata,
      target.metadata
    );
    if (comparison === "newer") return "superseded";
    if (comparison === "conflict") {
      throw new Error("Conversation summary immutable revision conflict");
    }
    if (comparison === "same") {
      assertSameSlotPayload(stored, target);
      return "completed";
    }
    if (
      await updateObservedSlot({
        target,
        observedAnalysisRevisionId: storedMetadata.analysisRevisionId,
      })
    ) {
      const updated = await readSlot(target.row.id);
      if (!updated)
        throw new Error("Conversation summary slot update vanished");
      assertObservedTargetSlotIdentity(updated, target);
      const updatedMetadata = parseConversationSummaryVersionMetadata(
        updated.metadata,
        { chunkIndex: updated.chunk_index }
      );
      if (!updatedMetadata) {
        throw new Error("Conversation summary immutable revision conflict");
      }
      const updatedComparison = compareConversationSummaryVersionIdentities(
        updatedMetadata,
        target.metadata
      );
      if (updatedComparison === "newer") return "superseded";
      if (updatedComparison === "conflict") {
        throw new Error("Conversation summary immutable revision conflict");
      }
      if (updatedComparison === "same") {
        assertSameSlotPayload(updated, target);
        return "completed";
      }
    }
  }
  throw new Error("Conversation summary slot CAS exhausted");
}

function assertObservedTargetSlotIdentity(
  stored: ConversationSummaryStoredRow,
  target: SlotTarget
): void {
  try {
    assertConversationSummaryStoredRowIdentity(stored, {
      workspaceId: target.row.workspace_id,
      conversationId: target.row.conversation_id,
      chunkIndex: target.row.chunk_index,
    });
  } catch {
    throw new Error("Conversation summary immutable revision conflict");
  }
}

async function listConversationRows(input: {
  workspaceId: string;
  conversationId: string;
}): Promise<ConversationSummaryStoredRow[]> {
  const rows: ConversationSummaryStoredRow[] = [];
  let afterId: string | null = null;
  while (true) {
    let query = supabaseAdmin
      .from("conversation_summaries")
      .select(CLEANUP_ROW_SELECT)
      .eq("workspace_id", input.workspaceId)
      .eq("conversation_id", input.conversationId)
      .order("id", { ascending: true })
      .limit(CLEANUP_PAGE_SIZE);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw asError(error, "Conversation summary cleanup read failed");
    if (!Array.isArray(data)) {
      throw new Error("Conversation summary cleanup rows are invalid");
    }
    const page = data.map(normalizeStoredRow);
    rows.push(...page);
    if (rows.length > CLEANUP_OBSERVATION_LIMIT) {
      throw new Error(
        "Conversation summary cleanup observation limit exceeded"
      );
    }
    if (page.length < CLEANUP_PAGE_SIZE) return rows;
    afterId = page[page.length - 1].id;
  }
}

function parseObservedVersion(
  row: ConversationSummaryStoredRow
): ConversationSummaryVersionMetadata | null {
  return parseConversationSummaryVersionMetadata(row.metadata, {
    chunkIndex: row.chunk_index,
  });
}

async function deleteObservedRow(input: {
  row: ConversationSummaryStoredRow;
  metadata: ConversationSummaryVersionMetadata | null;
  request: PersistConversationSummaryRevisionInput;
}): Promise<"deleted" | "superseded"> {
  for (let attempt = 0; attempt < SLOT_CAS_ATTEMPTS; attempt += 1) {
    let query = supabaseAdmin
      .from("conversation_summaries")
      .delete()
      .eq("id", input.row.id)
      .eq("workspace_id", input.request.workspaceId)
      .eq("conversation_id", input.request.conversationId);
    if (input.metadata) {
      query = query.eq(
        "metadata->>analysis_revision_id",
        input.metadata.analysisRevisionId
      );
    }
    const { data, error } = await query.select("id").maybeSingle();
    if (error)
      throw asError(error, "Conversation summary cleanup delete failed");
    if (data !== null) return "deleted";

    const current = await readSlot(input.row.id);
    if (!current) return "deleted";
    const currentMetadata = parseObservedVersion(current);
    if (currentMetadata) {
      const comparison = compareConversationSummaryVersionIdentities(
        currentMetadata,
        input.request
      );
      if (comparison === "newer") return "superseded";
      if (comparison === "conflict") {
        throw new Error("Conversation summary immutable revision conflict");
      }
      input = { ...input, row: current, metadata: currentMetadata };
    } else {
      input = { ...input, row: current, metadata: null };
    }
  }
  throw new Error("Conversation summary cleanup CAS exhausted");
}

async function cleanupConversationRows(input: {
  request: PersistConversationSummaryRevisionInput;
  targets: Map<string, SlotTarget>;
}): Promise<"completed" | "superseded"> {
  const observedIdentities = new Set<string>();
  const cleanupLimit = pLimit(SLOT_WRITE_CONCURRENCY);
  for (let cycle = 0; cycle < SLOT_CAS_ATTEMPTS; cycle += 1) {
    const rows = await listConversationRows(input.request);
    let retryCycle = false;
    const unwanted: Array<{
      row: ConversationSummaryStoredRow;
      metadata: ConversationSummaryVersionMetadata | null;
    }> = [];
    for (const row of rows) {
      const metadata = parseObservedVersion(row);
      const identity = `${row.id}:${metadata?.analysisRevisionId ?? "legacy"}`;
      observedIdentities.add(identity);
      if (observedIdentities.size > CLEANUP_OBSERVATION_LIMIT) {
        throw new Error(
          "Conversation summary cleanup observation limit exceeded"
        );
      }
      const target = input.targets.get(row.id);
      if (target) {
        assertObservedTargetSlotIdentity(row, target);
        if (!metadata) {
          throw new Error("Conversation summary immutable revision conflict");
        }
        const comparison = compareConversationSummaryVersionIdentities(
          metadata,
          input.request
        );
        if (comparison === "newer") return "superseded";
        if (comparison !== "same") {
          throw new Error("Conversation summary immutable revision conflict");
        }
        const exact = await readSlot(row.id);
        if (!exact) {
          throw new Error("Conversation summary committed slot disappeared");
        }
        assertObservedTargetSlotIdentity(exact, target);
        const exactMetadata = parseObservedVersion(exact);
        if (!exactMetadata) {
          throw new Error("Conversation summary immutable revision conflict");
        }
        const exactComparison = compareConversationSummaryVersionIdentities(
          exactMetadata,
          input.request
        );
        if (exactComparison === "newer") return "superseded";
        if (exactComparison === "conflict") {
          throw new Error("Conversation summary immutable revision conflict");
        }
        if (exactComparison === "older") {
          retryCycle = true;
          break;
        }
        assertSameSlotPayload(exact, target);
        continue;
      }
      if (metadata) {
        const comparison = compareConversationSummaryVersionIdentities(
          metadata,
          input.request
        );
        if (comparison === "newer") return "superseded";
        if (comparison === "conflict") {
          throw new Error("Conversation summary immutable revision conflict");
        }
      }
      unwanted.push({ row, metadata });
    }
    if (retryCycle) continue;
    if (unwanted.length === 0) return "completed";
    const results = await Promise.all(
      unwanted.map(row =>
        cleanupLimit(() =>
          deleteObservedRow({ ...row, request: input.request })
        )
      )
    );
    if (results.includes("superseded")) return "superseded";
  }
  throw new Error("Conversation summary cleanup CAS exhausted");
}

export async function persistConversationSummaryRevision(
  input: PersistConversationSummaryRevisionInput
): Promise<PersistConversationSummaryRevisionResult> {
  assertCanonicalInput(input);

  if (input.ragSummary === null) {
    const cleanup = await cleanupConversationRows({
      request: input,
      targets: new Map(),
    });
    return { status: cleanup };
  }

  const texts = [input.ragSummary.summary, ...input.ragSummary.chunks];
  const slotIds = texts.map((_, index) =>
    buildConversationSummarySlotId({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      chunkIndex: index === 0 ? null : index - 1,
    })
  );
  const { data: storedRows, error: storedRowsError } = await supabaseAdmin
    .from("conversation_summaries")
    .select(ROW_SELECT)
    .in("id", slotIds);
  if (storedRowsError)
    throw asError(storedRowsError, "Conversation summary slots read failed");
  const storedById = new Map(
    (storedRows ?? []).map(row => {
      const stored = normalizeStoredRow(row);
      return [stored.id, stored];
    })
  );
  const storedSlots = slotIds.map(id => storedById.get(id) ?? null);
  const reused: Array<GeneratedEmbedding | null> = [];
  for (const [index, stored] of storedSlots.entries()) {
    if (!stored) {
      reused.push(null);
      continue;
    }
    const chunkIndex = index === 0 ? null : index - 1;
    try {
      assertConversationSummaryStoredRowIdentity(stored, {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        chunkIndex,
      });
    } catch {
      throw new Error("Conversation summary immutable revision conflict");
    }
    const metadata = parseObservedVersion(stored);
    if (!metadata)
      throw new Error("Conversation summary immutable revision conflict");
    const comparison = compareConversationSummaryVersionIdentities(
      metadata,
      input
    );
    if (comparison === "newer") return { status: "superseded" };
    if (comparison === "conflict")
      throw new Error("Conversation summary immutable revision conflict");
    if (comparison !== "same") {
      reused.push(null);
      continue;
    }
    const embedding = parseStoredEmbedding(stored.embedding);
    if (!embedding)
      throw new Error("Conversation summary immutable revision conflict");
    const result: GeneratedEmbedding = {
      embedding,
      provider: metadata.embeddingProvider as GeneratedEmbedding["provider"],
      model: metadata.embeddingModel,
      taskType: metadata.embeddingTaskType,
      dimensions: metadata.embeddingDimensions,
    };
    const expectedMetadata = parseConversationSummaryVersionMetadata(
      buildVersionMetadata({ request: input, embedding: result, chunkIndex }),
      { chunkIndex }
    );
    if (
      stored.summary_text !== texts[index] ||
      !expectedMetadata ||
      !areConversationSummaryVersionMetadataEqual(metadata, expectedMetadata, {
        includeChunkIndex: true,
      })
    ) {
      throw new Error("Conversation summary immutable revision conflict");
    }
    reused.push(result);
  }
  const previousEmbedding = input.existingEmbedding;
  if (
    previousEmbedding &&
    parseStoredEmbedding(previousEmbedding.result.embedding) &&
    isEmbeddingMetadataCurrent(
      {
        embeddingProvider: previousEmbedding.result.provider,
        embeddingModel: previousEmbedding.result.model,
        embeddingTaskType: previousEmbedding.result.taskType,
        embeddingDimensions: previousEmbedding.result.dimensions,
      },
      "RETRIEVAL_DOCUMENT"
    )
  ) {
    for (const [index, text] of texts.entries()) {
      if (!reused[index] && text === previousEmbedding.text)
        reused[index] = previousEmbedding.result;
    }
  }
  const embeddingByText = new Map<string, GeneratedEmbedding>();
  for (const [index, result] of reused.entries()) {
    if (result) embeddingByText.set(texts[index], result);
  }
  const missingTexts = [
    ...new Set(texts.filter(text => !embeddingByText.has(text))),
  ];
  const generated =
    missingTexts.length > 0
      ? validateEmbeddingBatch(
          await getDocumentEmbeddingResultsBatch(missingTexts, {
            workspaceId: input.workspaceId,
            actionId: `classification:${input.conversationId}:${input.sourceRevision}`,
            sponsorship: "platform",
          }),
          missingTexts.length
        )
      : [];
  for (const [index, text] of missingTexts.entries())
    embeddingByText.set(text, generated[index]);
  const embeddings = validateEmbeddingBatch(
    texts.map(
      (text, index) => reused[index] ?? embeddingByText.get(text) ?? null
    ),
    texts.length
  );
  const targets = buildTargets(input, embeddings);

  const existingMain = await readSlot(targets.main.row.id);
  if (existingMain) {
    assertObservedTargetSlotIdentity(existingMain, targets.main);
    const existingMetadata = parseObservedVersion(existingMain);
    if (!existingMetadata) {
      throw new Error("Conversation summary immutable revision conflict");
    }
    const comparison = compareConversationSummaryVersionIdentities(
      existingMetadata,
      input
    );
    if (comparison === "newer") return { status: "superseded" };
    if (comparison === "conflict") {
      throw new Error("Conversation summary immutable revision conflict");
    }
    if (comparison === "same") {
      assertSameSlotPayload(existingMain, targets.main);
    }
  }

  const limit = pLimit(SLOT_WRITE_CONCURRENCY);
  const chunkResults = await Promise.allSettled(
    targets.chunks.map(target => limit(() => writeSlot(target)))
  );
  const firstFailure = chunkResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (firstFailure) throw firstFailure.reason;
  if (
    chunkResults.some(
      result => result.status === "fulfilled" && result.value === "superseded"
    )
  ) {
    return { status: "superseded" };
  }

  if ((await writeSlot(targets.main)) === "superseded") {
    return { status: "superseded" };
  }

  const targetMap = new Map(
    [targets.main, ...targets.chunks].map(target => [target.row.id, target])
  );
  const cleanup = await cleanupConversationRows({
    request: input,
    targets: targetMap,
  });
  return { status: cleanup };
}

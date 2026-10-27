import "server-only";

import { generateConversationSummary } from "@/lib/ai";
import {
  buildConversationSummarySlotId,
  parseConversationSummaryVersionMetadata,
  selectCommittedConversationSummaryVersion,
  type ConversationSummaryStoredRow,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-versioning";
import {
  MESSAGE_COUNT_THRESHOLD,
  WORD_COUNT_THRESHOLD,
} from "@/lib/classifier/conversation-analysis-constants";
import type { ConversationClassificationSummaryProposal } from "@/lib/classifier/conversation-analysis-types";
import { createConversationClassificationError } from "@/lib/classifier/conversation-classification-errors";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS } from "@/models/conversation-analysis-revision";
import { isRecord } from "@icecore/shared/lib/value-utils";

const SUMMARY_REGENERATION_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const LEGACY_SUMMARY_ROW_READ_LIMIT =
  CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragChunkCount + 2;
const SUMMARY_ROW_SELECT =
  "id, workspace_id, conversation_id, summary_text, chunk_index, metadata, created_at, updated_at";

type SummaryMessage = { text?: string; date?: Date | string };
type LegacySummaryMetadata = {
  word_count?: unknown;
  message_count?: unknown;
  chunk_count?: unknown;
  generation_time_ms?: unknown;
};
type SummaryRow = ConversationSummaryStoredRow;

function wordCount(messages: SummaryMessage[]): number {
  return messages
    .map(message => message.text || "")
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function assertRagText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim().length < 1
  ) {
    throw new Error("Summary text is outside the classification contract");
  }
  return value;
}

function optionalSafeCount(
  metadata: LegacySummaryMetadata,
  key: keyof LegacySummaryMetadata,
  fallback: number,
  maximum = CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.count
): number {
  const value = metadata[key];
  if (value === undefined || value === null) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new Error(`Summary metadata ${key} is invalid`);
  }
  return value as number;
}

function normalizeSummaryRow(value: unknown): SummaryRow {
  if (!isRecord(value)) throw new Error("Summary row is invalid");
  const chunkIndex = value.chunk_index;
  if (
    typeof value.id !== "string" ||
    typeof value.workspace_id !== "string" ||
    typeof value.conversation_id !== "string" ||
    typeof value.summary_text !== "string" ||
    (chunkIndex !== null && !Number.isSafeInteger(chunkIndex))
  ) {
    throw new Error("Summary row is invalid");
  }
  return {
    id: value.id,
    workspace_id: value.workspace_id,
    conversation_id: value.conversation_id,
    summary_text: value.summary_text,
    chunk_index: chunkIndex as number | null,
    metadata: value.metadata,
    ...(typeof value.created_at === "string" || value.created_at === null
      ? { created_at: value.created_at }
      : {}),
    ...(typeof value.updated_at === "string" || value.updated_at === null
      ? { updated_at: value.updated_at }
      : {}),
  };
}

async function generateReplaceProposal(input: {
  messages: SummaryMessage[];
  language: ConversationClassificationSummaryProposal["language"];
  currentWordCount: number;
}): Promise<ConversationClassificationSummaryProposal> {
  try {
    const generated = await generateConversationSummary(input.messages, {
      language: input.language,
      generateChunks: true,
    });
    const summary = assertRagText(
      generated.summary,
      CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragSummaryLength
    );
    if (
      !Array.isArray(generated.chunks) ||
      generated.chunks.length >
        CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragChunkCount
    ) {
      throw new Error("Generated summary chunks are invalid");
    }
    const chunks = generated.chunks.map(chunk =>
      assertRagText(
        chunk,
        CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragChunkLength
      )
    );
    const generationTimeMs = optionalSafeCount(
      { generation_time_ms: generated.metadata?.generationTimeMs },
      "generation_time_ms",
      0,
      CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragGenerationTimeMs
    );
    return {
      mode: "replace",
      language: input.language,
      summary,
      chunks,
      metadata: {
        wordCount: input.currentWordCount,
        messageCount: input.messages.length,
        chunkCount: chunks.length,
        generationTimeMs,
      },
    };
  } catch (error) {
    throw createConversationClassificationError(
      "summary_generation_failed",
      error
    );
  }
}

function summaryInputReadError(error: unknown): Error {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "summary_input_read_failed"
  ) {
    return error;
  }
  return createConversationClassificationError(
    "summary_input_read_failed",
    error
  );
}

async function readDeterministicMainStrict(input: {
  conversationId: string;
  workspaceId: string;
}): Promise<SummaryRow | null> {
  try {
    const id = buildConversationSummarySlotId({ ...input, chunkIndex: null });
    const { data, error } = await supabaseAdmin
      .from("conversation_summaries")
      .select(SUMMARY_ROW_SELECT)
      .eq("id", id)
      .eq("workspace_id", input.workspaceId)
      .eq("conversation_id", input.conversationId)
      .maybeSingle();
    if (error) throw error;
    return data === null ? null : normalizeSummaryRow(data);
  } catch (error) {
    throw summaryInputReadError(error);
  }
}

async function readVersionedChunksStrict(input: {
  conversationId: string;
  workspaceId: string;
  chunkCount: number;
}): Promise<SummaryRow[]> {
  if (input.chunkCount === 0) return [];
  try {
    const ids = Array.from({ length: input.chunkCount }, (_, chunkIndex) =>
      buildConversationSummarySlotId({ ...input, chunkIndex })
    );
    const { data, error } = await supabaseAdmin
      .from("conversation_summaries")
      .select(SUMMARY_ROW_SELECT)
      .eq("workspace_id", input.workspaceId)
      .eq("conversation_id", input.conversationId)
      .in("id", ids);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error("Summary rows are not an array");
    return data.map(normalizeSummaryRow);
  } catch (error) {
    throw summaryInputReadError(error);
  }
}

async function readLegacySummaryRowsStrict(input: {
  conversationId: string;
  workspaceId: string;
}): Promise<SummaryRow[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("conversation_summaries")
      .select(SUMMARY_ROW_SELECT)
      .eq("conversation_id", input.conversationId)
      .eq("workspace_id", input.workspaceId)
      .order("chunk_index", { ascending: true, nullsFirst: true })
      .limit(LEGACY_SUMMARY_ROW_READ_LIMIT);
    if (error) throw error;
    if (data === null || data === undefined) return [];
    if (!Array.isArray(data)) throw new Error("Summary rows are not an array");
    if (data.length >= LEGACY_SUMMARY_ROW_READ_LIMIT) {
      throw new Error("Conversation summary row count exceeds the contract");
    }
    return data.map(normalizeSummaryRow).filter(row => {
      const version = parseConversationSummaryVersionMetadata(row.metadata, {
        chunkIndex: row.chunk_index,
      });
      return version === null;
    });
  } catch (error) {
    throw summaryInputReadError(error);
  }
}

function shouldRegenerate(input: {
  previousMessageCount: number;
  currentMessageCount: number;
  completedAt: string | Date | null | undefined;
}): boolean {
  const completedAt =
    typeof input.completedAt === "string" || input.completedAt instanceof Date
      ? new Date(input.completedAt)
      : new Date(Number.NaN);
  if (Number.isNaN(completedAt.getTime())) {
    throw new Error("Summary completion time is invalid");
  }
  return (
    (input.previousMessageCount > 0 &&
      input.currentMessageCount >= input.previousMessageCount * 1.5) ||
    Date.now() - completedAt.getTime() > SUMMARY_REGENERATION_AGE_MS
  );
}

function buildVersionedPromoteProposal(input: {
  rows: SummaryRow[];
  conversationId: string;
  workspaceId: string;
  messages: SummaryMessage[];
  language: ConversationClassificationSummaryProposal["language"];
}): {
  proposal: ConversationClassificationSummaryProposal | null;
  shouldRegenerate: boolean;
} {
  try {
    const selected = selectCommittedConversationSummaryVersion({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      rows: input.rows,
    });
    if (!selected) throw new Error("Deterministic summary main disappeared");
    if (
      shouldRegenerate({
        previousMessageCount: selected.metadata.messageCount,
        currentMessageCount: input.messages.length,
        completedAt: selected.metadata.analysisCompletedAt,
      })
    ) {
      return { proposal: null, shouldRegenerate: true };
    }
    const summary = assertRagText(
      selected.main.summary_text,
      CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragSummaryLength
    );
    const chunks = selected.chunks.map(row =>
      assertRagText(
        row.summary_text,
        CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragChunkLength
      )
    );
    return {
      shouldRegenerate: false,
      proposal: {
        mode: "promote",
        language: input.language,
        summary,
        chunks,
        metadata: {
          wordCount: selected.metadata.wordCount,
          messageCount: selected.metadata.messageCount,
          chunkCount: chunks.length,
          generationTimeMs: selected.metadata.generationTimeMs,
        },
      },
    };
  } catch (error) {
    throw summaryInputReadError(error);
  }
}

function buildLegacyPromoteProposal(input: {
  rows: SummaryRow[];
  messages: SummaryMessage[];
  language: ConversationClassificationSummaryProposal["language"];
  currentWordCount: number;
}): {
  proposal: ConversationClassificationSummaryProposal | null;
  shouldRegenerate: boolean;
} {
  const mainRows = input.rows.filter(row => row.chunk_index === null);
  if (mainRows.length > 1) {
    throw summaryInputReadError(
      new Error("Multiple main conversation summary rows exist")
    );
  }
  const main = mainRows[0];
  if (!main) return { proposal: null, shouldRegenerate: true };

  try {
    const summary = assertRagText(
      main.summary_text,
      CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragSummaryLength
    );
    const chunksByIndex = input.rows
      .filter(row => row.chunk_index !== null)
      .map(row => {
        if (
          !Number.isSafeInteger(row.chunk_index) ||
          (row.chunk_index as number) < 0 ||
          (row.chunk_index as number) >=
            CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragChunkCount
        ) {
          throw new Error("Summary chunk index is invalid");
        }
        return {
          index: row.chunk_index as number,
          text: assertRagText(
            row.summary_text,
            CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragChunkLength
          ),
        };
      })
      .sort((left, right) => left.index - right.index);
    if (
      chunksByIndex.some(
        (chunk, expectedIndex) => chunk.index !== expectedIndex
      )
    ) {
      throw new Error("Summary chunk indexes are not contiguous");
    }
    const metadata = isRecord(main.metadata)
      ? (main.metadata as LegacySummaryMetadata)
      : {};
    const previousMessageCount = optionalSafeCount(
      metadata,
      "message_count",
      input.messages.length
    );
    if (
      shouldRegenerate({
        previousMessageCount,
        currentMessageCount: input.messages.length,
        completedAt: main.created_at,
      })
    ) {
      return { proposal: null, shouldRegenerate: true };
    }
    const chunks = chunksByIndex.map(chunk => chunk.text);
    return {
      shouldRegenerate: false,
      proposal: {
        mode: "promote",
        language: input.language,
        summary,
        chunks,
        metadata: {
          wordCount: optionalSafeCount(
            metadata,
            "word_count",
            input.currentWordCount
          ),
          messageCount: previousMessageCount,
          chunkCount: chunks.length,
          generationTimeMs: optionalSafeCount(
            metadata,
            "generation_time_ms",
            0,
            CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS.ragGenerationTimeMs
          ),
        },
      },
    };
  } catch (error) {
    throw summaryInputReadError(error);
  }
}

export async function resolveConversationClassificationSummaryProposal(input: {
  conversationId: string;
  workspaceId: string;
  messages: SummaryMessage[];
  historySummary?: string | null;
  language: ConversationClassificationSummaryProposal["language"];
}): Promise<ConversationClassificationSummaryProposal | null> {
  const currentWordCount = wordCount(input.messages);
  const hasHistorySummary =
    typeof input.historySummary === "string" &&
    input.historySummary.trim().length > 0;
  if (!hasHistorySummary) {
    if (
      currentWordCount < WORD_COUNT_THRESHOLD &&
      input.messages.length < MESSAGE_COUNT_THRESHOLD
    ) {
      return null;
    }
    return generateReplaceProposal({
      messages: input.messages,
      language: input.language,
      currentWordCount,
    });
  }

  const deterministicMain = await readDeterministicMainStrict(input);
  let proposalResult: {
    proposal: ConversationClassificationSummaryProposal | null;
    shouldRegenerate: boolean;
  };
  if (deterministicMain) {
    let metadata;
    try {
      metadata = parseConversationSummaryVersionMetadata(
        deterministicMain.metadata,
        { chunkIndex: null }
      );
      if (!metadata)
        throw new Error("Deterministic summary metadata is absent");
    } catch (error) {
      throw summaryInputReadError(error);
    }
    const chunks = await readVersionedChunksStrict({
      ...input,
      chunkCount: metadata.chunkCount,
    });
    proposalResult = buildVersionedPromoteProposal({
      rows: [deterministicMain, ...chunks],
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      messages: input.messages,
      language: input.language,
    });
  } else {
    const rows = await readLegacySummaryRowsStrict(input);
    proposalResult = buildLegacyPromoteProposal({
      rows,
      messages: input.messages,
      language: input.language,
      currentWordCount,
    });
  }
  if (!proposalResult.shouldRegenerate && proposalResult.proposal) {
    return proposalResult.proposal;
  }
  return generateReplaceProposal({
    messages: input.messages,
    language: input.language,
    currentWordCount,
  });
}

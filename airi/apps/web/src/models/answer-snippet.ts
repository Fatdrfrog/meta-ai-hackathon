import { createHash } from "crypto";
import mongoose, { Schema, model, models } from "mongoose";
import { escapeRegExp } from "@/lib/regex-utils";

type AnswerSnippetDoc = mongoose.Document & {
  workspaceId: string;
  question: string;
  questionKey?: string;
  answer: string;
  embedding: number[];
  embeddingFallback?: boolean;
  embeddingSource?: "vertex" | "openai" | "existing" | "placeholder";
  embeddingProvider?: "vertex" | "openai";
  embeddingModel?: string;
  embeddingTaskType?: "RETRIEVAL_DOCUMENT";
  embeddingDimensions?: number;
  embeddingUpdatedAt?: Date | null;
  language?: string;
  mongoLanguage?: string;
  category?: string;
  tags?: string[];
  safe?: boolean;
  sourceMessageIds?: string[];
  updatedAt?: Date;
  createdAt?: Date;
};

const ANSWER_SNIPPET_TEXT_INDEX_NAME = "answer_snippet_text_search";
const ANSWER_SNIPPET_TEXT_INDEX_KEYS = {
  workspaceId: 1,
  question: "text",
  answer: "text",
} as const;
const ANSWER_SNIPPET_TEXT_INDEX_OPTIONS = {
  name: ANSWER_SNIPPET_TEXT_INDEX_NAME,
  default_language: "none",
  language_override: "mongoLanguage",
} as const;
const ANSWER_SNIPPET_SUPPORTING_INDEXES = [
  {
    name: "answer_snippet_workspace_updated_at_desc",
    key: { workspaceId: 1, updatedAt: -1 },
  },
  {
    name: "answer_snippet_workspace_question_key_updated_at_desc",
    key: { workspaceId: 1, questionKey: 1, updatedAt: -1 },
  },
] as const;

const AnswerSnippetSchema = new Schema<AnswerSnippetDoc>(
  {
    workspaceId: { type: String, index: true, required: true },
    question: { type: String, required: true },
    questionKey: { type: String },
    answer: { type: String, required: true },
    embedding: { type: [Number], required: true },
    embeddingFallback: { type: Boolean, default: false, index: true },
    embeddingSource: {
      type: String,
      enum: ["vertex", "openai", "existing", "placeholder"],
      default: "vertex",
    },
    embeddingProvider: {
      type: String,
      enum: ["vertex", "openai"],
    },
    embeddingModel: { type: String },
    embeddingTaskType: {
      type: String,
      enum: ["RETRIEVAL_DOCUMENT"],
    },
    embeddingDimensions: { type: Number },
    embeddingUpdatedAt: { type: Date, default: null },
    language: { type: String },
    mongoLanguage: { type: String },
    category: { type: String, index: true },
    tags: { type: [String], index: true },
    safe: { type: Boolean, default: true },
    sourceMessageIds: { type: [String], default: [] },
  },
  { timestamps: true }
);

// Text index for full-text search (FTS fallback)
// Used when vector search misses brand names or specific terminology
// Important: language_override must NOT point to `language` because app language
// uses codes like "kz"/"uz" that MongoDB text index does not support.
// Prefixing the index with workspaceId keeps keyword search tenant-scoped.
AnswerSnippetSchema.index(
  ANSWER_SNIPPET_TEXT_INDEX_KEYS,
  ANSWER_SNIPPET_TEXT_INDEX_OPTIONS
);

function isIndexNotFoundError(error: unknown): boolean {
  const err = error as { code?: number; message?: string };
  const message = String(err?.message || error);
  return err?.code === 27 || /index not found/i.test(message);
}

function isIndexOptionsConflictError(error: unknown): boolean {
  const err = error as { code?: number; message?: string };
  const message = String(err?.message || error);
  return err?.code === 85 || /IndexOptionsConflict/i.test(message);
}

type MongoIndex = {
  key?: Record<string, unknown>;
  name?: string;
  weights?: Record<string, number>;
  default_language?: string;
  language_override?: string;
};

function getAnswerSnippetModel(): mongoose.Model<AnswerSnippetDoc> {
  return (models.AnswerSnippet ||
    model<AnswerSnippetDoc>(
      "AnswerSnippet",
      AnswerSnippetSchema
    )) as mongoose.Model<AnswerSnippetDoc>;
}

function normalizeQuestionForKey(question: string): string {
  return String(question || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function buildAnswerSnippetQuestionKey(question: string): string {
  const normalized = normalizeQuestionForKey(question);
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex");
}

export function buildLegacyAnswerSnippetQuestionRegex(
  question: string
): RegExp | null {
  const prefix = String(question || "")
    .trim()
    .slice(0, 80);
  if (!prefix) return null;
  return new RegExp(escapeRegExp(prefix), "i");
}

function isAnswerSnippetTextIndex(index: MongoIndex): boolean {
  const key = index.key || {};
  const weights = index.weights || {};
  const hasMongoTextKey = key._fts === "text" && key._ftsx === 1;
  const hasExpectedWeights = weights.question === 1 && weights.answer === 1;
  return hasMongoTextKey && hasExpectedWeights;
}

function isExpectedAnswerSnippetTextIndex(index: MongoIndex): boolean {
  return (
    isAnswerSnippetTextIndex(index) &&
    index.key?.workspaceId === 1 &&
    index.default_language ===
      ANSWER_SNIPPET_TEXT_INDEX_OPTIONS.default_language &&
    index.language_override ===
      ANSWER_SNIPPET_TEXT_INDEX_OPTIONS.language_override
  );
}

async function hasExpectedTextIndex(
  snippetModel: mongoose.Model<AnswerSnippetDoc>
): Promise<boolean> {
  const indexes = (await snippetModel.collection.indexes()) as MongoIndex[];
  return indexes.some(index => isExpectedAnswerSnippetTextIndex(index));
}

async function dropConflictingAnswerSnippetTextIndexes(
  snippetModel: mongoose.Model<AnswerSnippetDoc>
): Promise<void> {
  const indexes = (await snippetModel.collection.indexes()) as MongoIndex[];
  const conflictingIndexes = indexes.filter(index => {
    if (!isAnswerSnippetTextIndex(index)) return false;
    return !isExpectedAnswerSnippetTextIndex(index);
  });

  for (const index of conflictingIndexes) {
    if (!index.name) continue;
    try {
      await snippetModel.collection.dropIndex(index.name);
    } catch (error) {
      if (!isIndexNotFoundError(error)) throw error;
    }
  }
}

async function ensureAnswerSnippetSupportingIndexes(
  snippetModel: mongoose.Model<AnswerSnippetDoc>
): Promise<void> {
  for (const index of ANSWER_SNIPPET_SUPPORTING_INDEXES) {
    await snippetModel.collection.createIndex(index.key, { name: index.name });
  }
}

let ensureIndexesPromise: Promise<void> | null = null;
let areIndexesReady = false;

export async function ensureAnswerSnippetIndexes(): Promise<void> {
  if (areIndexesReady) return;
  if (ensureIndexesPromise) return ensureIndexesPromise;

  ensureIndexesPromise = (async () => {
    const snippetModel = getAnswerSnippetModel();
    await ensureAnswerSnippetSupportingIndexes(snippetModel);

    if (!(await hasExpectedTextIndex(snippetModel))) {
      await dropConflictingAnswerSnippetTextIndexes(snippetModel);

      try {
        await snippetModel.collection.createIndex(
          ANSWER_SNIPPET_TEXT_INDEX_KEYS,
          ANSWER_SNIPPET_TEXT_INDEX_OPTIONS
        );
      } catch (error) {
        if (isIndexOptionsConflictError(error)) {
          await dropConflictingAnswerSnippetTextIndexes(snippetModel);
          try {
            await snippetModel.collection.createIndex(
              ANSWER_SNIPPET_TEXT_INDEX_KEYS,
              ANSWER_SNIPPET_TEXT_INDEX_OPTIONS
            );
          } catch (retryError) {
            if (!(await hasExpectedTextIndex(snippetModel))) {
              throw retryError;
            }
          }
        }

        if (!(await hasExpectedTextIndex(snippetModel))) {
          throw error;
        }
      }
    }

    areIndexesReady = true;
  })();

  try {
    await ensureIndexesPromise;
    areIndexesReady = true;
  } finally {
    ensureIndexesPromise = null;
  }
}

export default getAnswerSnippetModel();

import { isRecord } from "@icecore/shared/lib/value-utils";

/**
 * Structured output of Airi's draft generators (WhatsApp template, Flow,
 * opportunity scan, campaign package). Each draft module declares the
 * responseSchema its generator sends, next to the validator that accepts the
 * draft; the chat facade turns that Gemini-shaped schema into Claude
 * structured outputs (output_config json_schema). This module holds the
 * shared pieces: the schema shape and builders, the request options, the
 * strict parse of a model answer, and the merge that keeps what the model
 * cannot express when it edits an open draft.
 *
 * Structured outputs reject free-form objects (every object needs its
 * properties and additionalProperties: false), so these schemas only use
 * objects with declared properties. Length and count limits are not
 * enforceable there; they are stated in descriptions and checked by the
 * draft validators after parsing.
 */

/** The Gemini/OpenAPI schema subset the chat facade translates per provider. */
export type AiriDraftResponseSchema = {
  type: "OBJECT" | "ARRAY" | "STRING" | "BOOLEAN";
  description?: string;
  format?: "enum";
  enum?: readonly string[];
  properties?: Record<string, AiriDraftResponseSchema>;
  required?: readonly string[];
  propertyOrdering?: readonly string[];
  items?: AiriDraftResponseSchema;
};

export function draftString(description?: string): AiriDraftResponseSchema {
  return description ? { type: "STRING", description } : { type: "STRING" };
}

export function draftEnum(
  values: readonly string[],
  description?: string
): AiriDraftResponseSchema {
  return {
    type: "STRING",
    format: "enum",
    enum: [...values],
    ...(description ? { description } : {}),
  };
}

export function draftArray(
  items: AiriDraftResponseSchema,
  description?: string
): AiriDraftResponseSchema {
  return { type: "ARRAY", items, ...(description ? { description } : {}) };
}

/**
 * An object with declared properties. Every property is required unless
 * named in `optional`; structured outputs cap optional properties per
 * request, so keep that list short.
 */
export function draftObject(
  properties: Record<string, AiriDraftResponseSchema>,
  optional: readonly string[] = []
): AiriDraftResponseSchema {
  const keys = Object.keys(properties);
  return {
    type: "OBJECT",
    properties,
    required: keys.filter(key => !optional.includes(key)),
    propertyOrdering: keys,
  };
}

/**
 * Request options of a draft call: JSON mode plus the schema. The facade
 * adds the structured-JSON thinking level per model, sends the schema to
 * Claude as output_config.format and to Gemini as responseSchema.
 */
export function buildAiriDraftStructuredOutputOptions(
  schema: AiriDraftResponseSchema
): {
  responseFormat: { type: "json_object" };
  generationConfig: { responseSchema: AiriDraftResponseSchema };
} {
  return {
    responseFormat: { type: "json_object" },
    generationConfig: { responseSchema: schema },
  };
}

/** Why a model answer did not become a draft. */
export type AiriDraftOutputFailureReason =
  /** The model stopped at its output limit: the JSON is partial. */
  | "truncated"
  /** No JSON object could be read from the answer. */
  | "unparseable"
  /** The JSON did not pass the draft's validator. */
  | "invalid";

export type AiriDraftJsonParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: Exclude<AiriDraftOutputFailureReason, "invalid"> };

// Claude reports max_tokens, Gemini MAX_TOKENS, OpenAI-style callers length.
const TRUNCATED_FINISH_REASONS = new Set(["max_tokens", "length"]);

/**
 * Reads the draft object from a model answer. A truncated answer is never
 * repaired into a partial draft. Structured outputs return bare JSON; the
 * fence and prose stripping covers the Gemini fallback.
 */
export function parseAiriDraftJson(response: {
  content?: string | null;
  finishReason?: string | null;
}): AiriDraftJsonParseResult {
  const finishReason = String(response.finishReason || "")
    .trim()
    .toLowerCase();
  if (TRUNCATED_FINISH_REASONS.has(finishReason)) {
    return { ok: false, reason: "truncated" };
  }
  const withoutFence = String(response.content || "")
    .replace(/^﻿/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, reason: "unparseable" };
  try {
    const value: unknown = JSON.parse(withoutFence.slice(start, end + 1));
    return isRecord(value)
      ? { ok: true, value }
      : { ok: false, reason: "unparseable" };
  } catch {
    return { ok: false, reason: "unparseable" };
  }
}

function matchById(
  items: unknown[],
  id: unknown
): Record<string, unknown> | undefined {
  if (typeof id !== "string" || !id.trim()) return undefined;
  const wanted = id.trim();
  return items.find(
    (item): item is Record<string, unknown> =>
      isRecord(item) && typeof item.id === "string" && item.id.trim() === wanted
  );
}

/**
 * Merges a generated draft over the open draft it edits. The model owns the
 * keys its schema declares (an owned key it left out is removed); every
 * other key of the open draft is kept, so provider links, routes and layout
 * the schema cannot express survive an edit. Array items are matched by id.
 */
export function mergeAiriDraftOverActive(
  schema: AiriDraftResponseSchema,
  active: unknown,
  generated: unknown
): unknown {
  if (schema.type === "ARRAY" && schema.items?.type === "OBJECT") {
    if (!Array.isArray(generated)) return generated;
    const activeItems = Array.isArray(active) ? active : [];
    return generated.map(item =>
      isRecord(item)
        ? mergeAiriDraftOverActive(
            schema.items as AiriDraftResponseSchema,
            matchById(activeItems, item.id),
            item
          )
        : item
    );
  }
  if (schema.type !== "OBJECT" || !isRecord(generated) || !isRecord(active)) {
    return generated;
  }
  const owned = schema.properties ?? {};
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(active)) {
    if (!Object.prototype.hasOwnProperty.call(owned, key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(generated)) {
    const childSchema = owned[key];
    merged[key] = childSchema
      ? mergeAiriDraftOverActive(childSchema, active[key], value)
      : value;
  }
  return merged;
}

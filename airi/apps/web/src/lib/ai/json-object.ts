import { asNullableRecord, isRecord } from "@icecore/shared/lib/value-utils";

function tryParseObject(candidate: string): Record<string, unknown> | null {
  let parsed: unknown = candidate;

  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof parsed !== "string") {
      return asNullableRecord(parsed);
    }

    try {
      parsed = JSON.parse(parsed.trim());
    } catch {
      return null;
    }

    if (isRecord(parsed)) {
      return parsed;
    }
  }

  return asNullableRecord(parsed);
}

function collectBalancedObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  const source = text || "";

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
        continue;
      }
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(source.slice(start, index + 1).trim());
          break;
        }
      }
    }
  }

  return candidates;
}

/**
 * Last-resort attempt to repair truncated JSON produced when the model hits
 * the token limit mid-output.  Strategy:
 *  1. Find the first `{` in the text.
 *  2. Trim any trailing partial value (e.g., unterminated string).
 *  3. Close any open strings, arrays, and objects to make it parseable.
 */
function tryRepairTruncatedObject(
  text: string
): Record<string, unknown> | null {
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) return null;

  let json = text.slice(firstBrace);

  // Truncated LLM JSON often ends mid-object inside an array (e.g. rerank results).
  // Drop the incomplete trailing element so braces/brackets can be closed cleanly.
  json = json.replace(/,\s*\{[^}]*$/, "");

  // Strip trailing partial token (e.g., unterminated string after last comma)
  // Walk backwards to find the last structurally sound position.
  json = json.replace(/,\s*"[^"]*$/, ""); // trailing `,"unterminated...`
  json = json.replace(/,\s*$/, ""); // trailing comma
  json = json.replace(/:\s*"[^"]*$/, ': ""'); // trailing `:"unterminated...`

  // Close any open strings
  const quoteCount = (json.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    json += '"';
  }

  // Count open braces/brackets and close them
  let openBraces = 0;
  let openBrackets = 0;
  let inStr = false;
  let esc = false;

  for (const ch of json) {
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") openBraces++;
    else if (ch === "}") openBraces--;
    else if (ch === "[") openBrackets++;
    else if (ch === "]") openBrackets--;
  }

  // Append missing closing tokens
  for (let i = 0; i < openBrackets; i++) json += "]";
  for (let i = 0; i < openBraces; i++) json += "}";

  return tryParseObject(json);
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = (text || "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new Error("Empty model response");
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const directCandidate = fencedMatch?.[1]?.trim() || trimmed;

  const directParsed = tryParseObject(directCandidate);
  if (directParsed) {
    return directParsed;
  }

  for (const candidate of collectBalancedObjectCandidates(directCandidate)) {
    const parsed = tryParseObject(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const repaired = tryRepairTruncatedObject(directCandidate);
  if (repaired) {
    return repaired;
  }

  throw new Error("Failed to parse model response as JSON object");
}

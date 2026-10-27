import {
  INVALID_CONVERSATION_CHANNEL_QUERY,
  isConversationChannel,
  type ConversationChannel,
} from "@icecore/shared/types/sources";
import { NextResponse } from "next/server";

type ValidSingle =
  | { ok: true; value: ConversationChannel | undefined }
  | { ok: false; response: NextResponse };

type ValidList =
  | { ok: true; values: ConversationChannel[] }
  | { ok: false; response: NextResponse };

/**
 * Optional single `channel` query param: missing/blank → undefined; invalid → 400.
 */
export function validateOptionalConversationChannelParam(
  raw: string | null
): ValidSingle {
  const t = raw?.trim();
  if (!t) return { ok: true, value: undefined };
  if (!isConversationChannel(t)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: INVALID_CONVERSATION_CHANNEL_QUERY },
        { status: 400 }
      ),
    };
  }
  return { ok: true, value: t };
}

/**
 * Repeated `channels` query params: empty list → []; any invalid token → 400.
 */
export function validateConversationChannelListParams(
  rawList: string[]
): ValidList {
  const out: ConversationChannel[] = [];
  for (const raw of rawList) {
    const t = raw.trim();
    if (!t) continue;
    if (!isConversationChannel(t)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: INVALID_CONVERSATION_CHANNEL_QUERY },
          { status: 400 }
        ),
      };
    }
    out.push(t);
  }
  return { ok: true, values: out };
}

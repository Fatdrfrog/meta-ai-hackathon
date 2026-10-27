import "server-only";

import type { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import connectDB from "@/lib/mongoose";
import { scheduleAiriChatAfterResponse } from "@/lib/airi-chats/after-response";
import {
  describeAiriChatRequestFailure,
  isAiriChatReplyFailed,
  shouldLogAiriChatRequestFailure,
} from "@/lib/airi-chats/errors";
import {
  buildCompanyStudioChatLimitExceededResponse,
  ensureCompanyStudioChatCapacity,
  recordCreativeStudioChat,
} from "@/lib/limits/company-limits";
import { logger, type LogContext } from "@/lib/logger";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
  type SupabaseRouteAuthContext,
} from "@/lib/supabase/route-auth";
import { zodErrorResponse } from "@/lib/api/json-body";

type Denied = { ok: false; response: NextResponse };

function deny(error: "Unauthorized" | "Forbidden"): Denied {
  return {
    ok: false,
    response: NextResponse.json(
      { error },
      { status: error === "Unauthorized" ? 401 : 403 }
    ),
  };
}

/** Sign-in and workspace membership, shared by the Airi chat routes. */
export async function resolveAiriChatRouteContext(
  request: NextRequest,
  workspaceId: string
): Promise<Denied | ({ ok: true } & SupabaseRouteAuthContext)> {
  const auth = await getSupabaseRouteAuth(request);
  if (isSupabaseRouteAuthError(auth)) return deny("Unauthorized");
  const hasAccess = await verifyWorkspaceAccess(
    auth.supabase,
    auth.user.id,
    workspaceId
  );
  if (!hasAccess) return deny("Forbidden");
  return { ok: true, ...auth };
}

/** JSON error for a failed Airi chat request: a stable code, never raw internals. */
export function airiChatRequestFailureResponse(
  error: unknown,
  context?: LogContext,
  fallbackMessage?: string,
  /** The request's signal: only its abort is reported as a cancellation. */
  signal?: AbortSignal
): NextResponse {
  const failure = describeAiriChatRequestFailure(
    error,
    fallbackMessage,
    signal
  );
  if (shouldLogAiriChatRequestFailure(failure)) {
    logger.error("airi_chat.request_failed", error, {
      ...context,
      code: failure.code,
    });
  }
  return NextResponse.json(
    { error: failure.message, code: failure.code },
    { status: failure.status }
  );
}

/**
 * Admission for the four Airi chat message routes (JSON and stream, new and
 * existing chat), before any turn work starts:
 * 401 sign-in, then 403 membership, 400 body, 404 chat, 402 studio capacity.
 *
 * The body is validated before any database work; the Mongo connection, the
 * owned-chat read and the capacity check then run alongside the membership
 * check. Nothing is answered before membership has passed.
 */
export async function admitAiriChatMessageRequest<
  TBody,
  TThread = null,
>(params: {
  request: NextRequest;
  workspaceId: string;
  schema: z.ZodType<TBody>;
  /** Existing chat: the caller's owned thread, or null when it is not theirs. */
  loadThread?: (userId: string) => Promise<TThread | null>;
}): Promise<
  | Denied
  | {
      ok: true;
      auth: SupabaseRouteAuthContext;
      body: TBody;
      thread: TThread;
    }
> {
  const auth = await getSupabaseRouteAuth(params.request);
  if (isSupabaseRouteAuthError(auth)) return deny("Unauthorized");

  const accessPromise = verifyWorkspaceAccess(
    auth.supabase,
    auth.user.id,
    params.workspaceId
  );
  // Awaited below; never an unhandled rejection while the body is read.
  accessPromise.catch(() => undefined);

  const parsed = params.schema.safeParse(
    await params.request.json().catch(() => ({}))
  );
  if (!parsed.success) {
    if (!(await accessPromise)) return deny("Forbidden");
    return {
      ok: false,
      response: zodErrorResponse(parsed.error, { code: "invalid_request" }),
    };
  }

  const loadThread = params.loadThread;
  const threadPromise = connectDB().then(() =>
    loadThread ? loadThread(auth.user.id) : null
  );
  const capacityPromise = ensureCompanyStudioChatCapacity(
    auth.supabase,
    params.workspaceId
  );
  // Observed after the access check; never an unhandled rejection before it.
  void Promise.allSettled([threadPromise, capacityPromise]);

  if (!(await accessPromise)) return deny("Forbidden");
  const thread = await threadPromise;
  if (loadThread && !thread) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Chat not found", code: "thread_not_found" },
        { status: 404 }
      ),
    };
  }
  const capacity = await capacityPromise;
  if (!capacity.allowed) {
    return {
      ok: false,
      response: buildCompanyStudioChatLimitExceededResponse(capacity.limit),
    };
  }
  // A loaded thread is non-null here; without loadThread it is null.
  return { ok: true, auth, body: parsed.data, thread: thread as TThread };
}

/**
 * The studio-chat quota for a saved answer, after the response: failed and
 * busy replies did not answer the user and do not count.
 */
export function scheduleAiriChatStudioChatQuota(
  workspaceId: string,
  turn: {
    assistantMessage: { metadata: Record<string, unknown> | null };
    thread: { id: string };
  }
): void {
  if (isAiriChatReplyFailed(turn.assistantMessage.metadata)) return;
  scheduleAiriChatAfterResponse(
    "studio_chat_quota",
    () => recordCreativeStudioChat(workspaceId, "airi_chat"),
    { workspaceId, threadId: turn.thread.id }
  );
}

/** One active run per thread: a second send while it runs. */
export function airiChatRunActiveResponse(runId: string | null): NextResponse {
  return NextResponse.json(
    {
      error: "Airi is still answering in this chat. Wait for it or stop it.",
      code: "airi_run_active",
      runId,
    },
    { status: 409 }
  );
}

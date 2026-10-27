import "server-only";

import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { readTelegramBotToken } from "@/lib/telegram/telegram-source";
import { isTelegramSource } from "@icecore/shared/types/sources";

export type TelegramSendContext = {
  sourceId: string;
  botToken: string;
};

export type TelegramSendContextResolution =
  | {
      ok: true;
      context: TelegramSendContext;
    }
  | {
      ok: false;
      kind: "unavailable";
      reason:
        | "lookup_scope_missing"
        | "source_not_found"
        | "source_identity_mismatch"
        | "workspace_mismatch"
        | "credentials_missing";
    }
  | {
      ok: false;
      kind: "query_error";
      error: unknown;
    };

export async function resolveTelegramSendContextResult(params: {
  workspaceId: string;
  sourceId?: string | null;
}): Promise<TelegramSendContextResolution> {
  const workspaceId = params.workspaceId.trim();
  const sourceId = params.sourceId?.trim() || "";
  if (!workspaceId || !sourceId) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "lookup_scope_missing",
    };
  }

  const sourceResult = await fetchSourceWithCredentialsResult(
    sourceId,
    "telegram"
  );
  if (!sourceResult.ok) {
    return {
      ok: false,
      kind: "query_error",
      error: sourceResult.error,
    };
  }
  const source = sourceResult.source;
  if (!source) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "source_not_found",
    };
  }
  if (!isTelegramSource(source) || source.id !== sourceId) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "source_identity_mismatch",
    };
  }
  if (source.workspace_id !== workspaceId) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "workspace_mismatch",
    };
  }

  const botToken = readTelegramBotToken(source.credentials);
  if (!botToken) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "credentials_missing",
    };
  }

  return {
    ok: true,
    context: { sourceId: source.id, botToken },
  };
}

export async function resolveTelegramSendContext(params: {
  workspaceId: string;
  sourceId?: string | null;
}): Promise<TelegramSendContext | null> {
  const result = await resolveTelegramSendContextResult(params);
  return result.ok ? result.context : null;
}

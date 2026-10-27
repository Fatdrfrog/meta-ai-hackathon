import { supabaseAdmin } from "@/lib/supabase/admin";
import * as telegramApi from "@/lib/telegram";
import { normalizeBusinessConnectionId } from "@/lib/telegram-business-connection";
import Chat from "@/models/chat";
import { TelegramBotBusinessConnection } from "@/types/telegram";
import { SourceRow, getTelegramChatId, safeParseChatId } from "./helpers";

interface BusinessConnectionRow {
  business_connection_id?: string | null;
  workspace_id?: string | null;
  source_id?: string | null;
  user_chat_id?: number | null;
  can_reply?: boolean | null;
  is_enabled?: boolean | null;
  connected_at?: string | null;
  last_update_at?: string | null;
}

function getBusinessReplyPermission(
  businessConnection: TelegramBotBusinessConnection
): boolean {
  if (typeof businessConnection.rights?.can_reply === "boolean") {
    return businessConnection.rights.can_reply;
  }
  if (typeof businessConnection.can_reply === "boolean") {
    return businessConnection.can_reply;
  }
  return false;
}

function getBusinessConnectionEnabled(
  businessConnection: TelegramBotBusinessConnection
): boolean {
  if (typeof businessConnection.is_enabled === "boolean") {
    return businessConnection.is_enabled;
  }
  if (typeof businessConnection.disabled === "boolean") {
    return !businessConnection.disabled;
  }
  return true;
}

async function resolveTelegramSourceContext(sourceId: string): Promise<{
  sourceId?: string;
  workspaceId?: string;
}> {
  if (!sourceId || sourceId === "legacy") {
    return {};
  }

  try {
    const { data: source, error } = await supabaseAdmin
      .from("sources")
      .select("id, workspace_id, type")
      .eq("id", sourceId)
      .eq("type", "telegram")
      .maybeSingle<{
        id: string;
        workspace_id: string | null;
        type: string;
      }>();

    if (error || !source || !source.workspace_id) {
      return {};
    }

    return {
      sourceId: source.id,
      workspaceId: source.workspace_id,
    };
  } catch {
    return {};
  }
}

export async function handleBusinessConnectionUpdate(
  business_connection: TelegramBotBusinessConnection,
  sourceId: string,
  botToken?: string
) {
  const { id, user_id, user_chat_id } = business_connection;
  const normalizedId = normalizeBusinessConnectionId(id);
  const chatNumericId = safeParseChatId(user_chat_id ?? null);
  const telegramUserId =
    user_id ?? business_connection.user?.id ?? chatNumericId ?? undefined;
  const canReply = getBusinessReplyPermission(business_connection);
  const isEnabled = getBusinessConnectionEnabled(business_connection);

  if (!normalizedId || !telegramUserId) {
    return;
  }

  try {
    const sourceContext = await resolveTelegramSourceContext(sourceId);
    const nowIso = new Date().toISOString();
    const timestamps = {
      last_update_at: nowIso,
    } as { connected_at?: string; last_update_at: string };

    if (business_connection.date) {
      const connectedDate = new Date(
        business_connection.date * 1000
      ).toISOString();
      Object.assign(timestamps, { connected_at: connectedDate });
    }

    let deleteQuery = supabaseAdmin
      .from("telegram_business_connections")
      .delete()
      .eq("telegram_user_id", telegramUserId)
      .neq("business_connection_id", normalizedId);

    if (sourceContext.sourceId) {
      deleteQuery = deleteQuery.eq("source_id", sourceContext.sourceId);
    }

    await deleteQuery;

    const upsertPayload: {
      business_connection_id: string;
      telegram_user_id: number;
      user_chat_id: number | null;
      can_reply: boolean;
      is_enabled: boolean;
      connected_at?: string;
      last_update_at: string;
      workspace_id?: string;
      source_id?: string;
    } = {
      business_connection_id: normalizedId,
      telegram_user_id: telegramUserId,
      user_chat_id: chatNumericId,
      can_reply: canReply,
      is_enabled: isEnabled,
      ...timestamps,
    };

    if (sourceContext.workspaceId) {
      upsertPayload.workspace_id = sourceContext.workspaceId;
      upsertPayload.source_id = sourceContext.sourceId;
    }

    await supabaseAdmin
      .from("telegram_business_connections")
      .upsert(upsertPayload, { onConflict: "business_connection_id" });

    if (chatNumericId !== null) {
      try {
        const baseMessage = sourceContext.workspaceId
          ? "Bot connected to your Telegram Business account. This connection was linked to your workspace automatically."
          : "Bot connected to your Telegram Business account. To finish setup, send /start <source-key> in this chat.";
        const permissionHint = canReply
          ? ""
          : "\n\nWarning: 'Can reply to messages' is disabled in Telegram Business settings. Enable it so Airi can respond.";

        await telegramApi.sendTelegramMessage(
          String(chatNumericId),
          `${baseMessage}${permissionHint}`,
          { botToken }
        );
      } catch {}
    }

    if (chatNumericId !== null) {
      const effectiveSourceId = sourceContext.sourceId || sourceId;
      const compositeId = getTelegramChatId(chatNumericId, effectiveSourceId);
      const chatUpdate: {
        businessConnectionId: string;
        sourceId: string;
        workspaceId?: string;
      } = {
        businessConnectionId: normalizedId,
        sourceId: effectiveSourceId,
      };

      if (sourceContext.workspaceId) {
        chatUpdate.workspaceId = sourceContext.workspaceId;
      }

      await Chat.findOneAndUpdate(
        { _id: compositeId },
        {
          $setOnInsert: { type: "private" },
          $set: chatUpdate,
        },
        { upsert: true }
      );
    }
  } catch {}
}

export async function upsertBusinessConnectionFromMessage(
  bc: TelegramBotBusinessConnection | undefined,
  chatIdSource: { raw: string; sourceId: string }
) {
  if (!bc) return null;

  const { raw: chatId, sourceId } = chatIdSource;

  const chatNumericId = safeParseChatId(chatId);
  const telegramUserId = bc.user?.id ?? bc.user_id ?? chatNumericId;
  const canReply = getBusinessReplyPermission(bc);
  const isEnabled = getBusinessConnectionEnabled(bc);

  if (!telegramUserId) {
    return null;
  }

  try {
    const sourceContext = await resolveTelegramSourceContext(sourceId);
    const nowIso = new Date().toISOString();
    const connectedAtIso =
      bc.date !== undefined ? new Date(bc.date * 1000).toISOString() : nowIso;

    const upsertPayload = {
      business_connection_id: normalizeBusinessConnectionId(bc.id) ?? null,
      telegram_user_id: telegramUserId,
      user_chat_id: chatNumericId,
      can_reply: canReply,
      is_enabled: isEnabled,
      connected_at: connectedAtIso,
      last_update_at: nowIso,
      ...(sourceContext.workspaceId
        ? {
            workspace_id: sourceContext.workspaceId,
            source_id: sourceContext.sourceId,
          }
        : {}),
    } satisfies {
      business_connection_id: string | null;
      telegram_user_id: number;
      user_chat_id: number | null;
      can_reply: boolean;
      is_enabled: boolean;
      connected_at: string;
      last_update_at: string;
      workspace_id?: string;
      source_id?: string;
    };

    await supabaseAdmin
      .from("telegram_business_connections")
      .upsert(upsertPayload, { onConflict: "business_connection_id" })
      .select();

    if (chatNumericId !== null) {
      const effectiveSourceId = sourceContext.sourceId || sourceId;
      const compositeId = getTelegramChatId(chatNumericId, effectiveSourceId);
      await Chat.findOneAndUpdate(
        { _id: compositeId },
        {
          $set: {
            businessConnectionId: bc.id,
            sourceId: effectiveSourceId,
            ...(sourceContext.workspaceId
              ? { workspaceId: sourceContext.workspaceId }
              : {}),
          },
          $setOnInsert: { type: "private" },
        },
        { upsert: true }
      );
    }
  } catch {}

  return bc.id;
}

export async function getExistingBusinessConnection(
  fromId: number,
  sourceId?: string
): Promise<BusinessConnectionRow | null> {
  let query = supabaseAdmin
    .from("telegram_business_connections")
    .select(
      "business_connection_id, workspace_id, source_id, user_chat_id, can_reply, is_enabled, connected_at, last_update_at"
    )
    .eq("telegram_user_id", fromId);

  if (sourceId && sourceId !== "legacy") {
    query = query.eq("source_id", sourceId);
  }

  const { data } = await query
    .order("last_update_at", { ascending: false })
    .limit(1)
    .maybeSingle<BusinessConnectionRow>();

  return data ?? null;
}

export async function linkBusinessConnectionToSource(
  fromId: number,
  sourceId: string,
  chatId?: string,
  incomingBusinessConnectionId?: string,
  meta?: { can_reply?: boolean | null; is_enabled?: boolean | null }
) {
  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .select("id, workspace_id, companies(name)")
    .eq("id", sourceId)
    .maybeSingle<SourceRow>();

  if (error || !source || !source.workspace_id) {
    throw new Error("Invalid sourceId provided or source has no workspace.");
  }

  const existing = await getExistingBusinessConnection(fromId, sourceId);
  const effectiveBusinessConnectionId =
    normalizeBusinessConnectionId(incomingBusinessConnectionId) ??
    normalizeBusinessConnectionId(existing?.business_connection_id);
  const effectiveChatId =
    chatId ||
    (existing?.user_chat_id ? String(existing.user_chat_id) : undefined);
  const effectiveChatNumericId = safeParseChatId(
    effectiveChatId ?? existing?.user_chat_id
  );

  if (!effectiveBusinessConnectionId) {
    throw new Error(
      "No Telegram Business connection found. Add the bot in Telegram Business first."
    );
  }

  const connectionRecord = {
    telegram_user_id: fromId,
    business_connection_id: effectiveBusinessConnectionId,
    user_chat_id: effectiveChatNumericId,
    workspace_id: source.workspace_id,
    source_id: sourceId,
    can_reply: meta?.can_reply ?? existing?.can_reply ?? false,
    is_enabled: meta?.is_enabled ?? existing?.is_enabled ?? true,
    last_update_at: new Date().toISOString(),
  } satisfies {
    telegram_user_id: number;
    business_connection_id: string;
    user_chat_id: number | null;
    workspace_id: string;
    source_id: string;
    can_reply: boolean;
    is_enabled: boolean;
    last_update_at: string;
  };

  if (!existing?.connected_at) {
    Object.assign(connectionRecord, { connected_at: new Date().toISOString() });
  }

  const { error: upsertError } = await supabaseAdmin
    .from("telegram_business_connections")
    .upsert(connectionRecord, { onConflict: "business_connection_id" })
    .select();

  if (upsertError) {
    throw upsertError;
  }

  if (effectiveChatNumericId !== null) {
    const compositeChatId = getTelegramChatId(effectiveChatNumericId, sourceId);
    await Chat.findOneAndUpdate(
      { _id: compositeChatId },
      {
        $set: {
          sourceId: source.id,
          workspaceId: source.workspace_id,
          ...(effectiveBusinessConnectionId
            ? { businessConnectionId: effectiveBusinessConnectionId }
            : {}),
        },
        $addToSet: { participants: fromId },
      },
      { upsert: true }
    );
  }

  return source;
}

import {
  countTelegramSubscribers,
  getLatestTelegramSubscriberImportBatch,
  listTelegramSubscribers,
  scheduleTelegramSubscriberBackfill,
} from "@/lib/telegram/subscribers";
import { requireTelegramSubscriberSourceAccess } from "@/lib/telegram/subscriber-route-auth";
import { NextResponse } from "next/server";

type Params = Promise<{ sourceId: string }>;

export async function GET(request: Request, { params }: { params: Params }) {
  const { sourceId } = await params;
  const access = await requireTelegramSubscriberSourceAccess({
    request,
    sourceId,
  });
  if (!access.ok) return access.response;

  const { searchParams } = new URL(request.url);
  const limit = Number.parseInt(searchParams.get("limit") || "200", 10);
  const search = searchParams.get("search") || "";
  if (search.trim().length === 0) {
    scheduleTelegramSubscriberBackfill({
      workspaceId: access.workspaceId,
      sourceId: access.source.id,
      reason: "telegram_subscriber_list",
    });
  }

  const [rows, total, latestImport] = await Promise.all([
    listTelegramSubscribers({
      workspaceId: access.workspaceId,
      sourceId: access.source.id,
      search,
      limit,
    }),
    countTelegramSubscribers({
      workspaceId: access.workspaceId,
      sourceId: access.source.id,
      search,
    }),
    getLatestTelegramSubscriberImportBatch({
      workspaceId: access.workspaceId,
      sourceId: access.source.id,
    }),
  ]);

  return NextResponse.json({
    total,
    latestImport,
    subscribers: rows.map(row => ({
      chatId: row.chatId,
      sourceId: row.sourceId,
      status: row.status,
      origin: row.origin,
      displayName: row.displayName,
      username: row.username,
      firstName: row.firstName,
      lastName: row.lastName,
      languageCode: row.languageCode,
      importedAt: row.importedAt,
      lastSeenAt: row.lastSeenAt,
      lastSuccessfulSendAt: row.lastSuccessfulSendAt,
      lastSendError: row.lastSendError,
    })),
  });
}

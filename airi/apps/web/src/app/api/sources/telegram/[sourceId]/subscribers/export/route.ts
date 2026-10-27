import {
  buildTelegramSubscribersCsv,
  listTelegramSubscribers,
  scheduleTelegramSubscriberBackfill,
} from "@/lib/telegram/subscribers";
import { requireTelegramSubscriberSourceAccess } from "@/lib/telegram/subscriber-route-auth";

type Params = Promise<{ sourceId: string }>;

export async function GET(request: Request, { params }: { params: Params }) {
  const { sourceId } = await params;
  const access = await requireTelegramSubscriberSourceAccess({
    request,
    sourceId,
  });
  if (!access.ok) return access.response;

  scheduleTelegramSubscriberBackfill({
    workspaceId: access.workspaceId,
    sourceId: access.source.id,
    reason: "telegram_subscriber_export",
  });

  const rows = await listTelegramSubscribers({
    workspaceId: access.workspaceId,
    sourceId: access.source.id,
    limit: 1000,
  });
  const csv = buildTelegramSubscribersCsv(rows);
  const filename = `telegram-subscribers-${access.source.id}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

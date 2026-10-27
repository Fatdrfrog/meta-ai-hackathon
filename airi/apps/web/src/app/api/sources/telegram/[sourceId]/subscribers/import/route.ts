import { importTelegramSubscriberCsv } from "@/lib/telegram/subscribers";
import { requireTelegramSubscriberSourceAccess } from "@/lib/telegram/subscriber-route-auth";
import { NextResponse } from "next/server";

type Params = Promise<{ sourceId: string }>;

function isAcceptedAttestation(value: string | null): boolean {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return ["true", "1", "yes", "accepted"].includes(normalized);
}

export async function POST(request: Request, { params }: { params: Params }) {
  const { sourceId } = await params;
  const access = await requireTelegramSubscriberSourceAccess({
    request,
    sourceId,
    requireAdmin: true,
  });
  if (!access.ok) return access.response;

  if (
    !isAcceptedAttestation(
      request.headers.get("x-telegram-subscriber-import-attestation")
    )
  ) {
    return NextResponse.json(
      {
        error:
          "Import attestation is required: confirm these users previously contacted this same Telegram bot.",
      },
      { status: 400 }
    );
  }

  const csv = await request.text();
  if (!csv.trim()) {
    return NextResponse.json(
      { error: "CSV body is required" },
      { status: 400 }
    );
  }

  const fileName = request.headers.get("x-import-file-name") || null;
  const result = await importTelegramSubscriberCsv({
    workspaceId: access.workspaceId,
    sourceId: access.source.id,
    csv,
    importedBy: access.userId,
    fileName,
  });

  return NextResponse.json({
    success: true,
    batchId: result.batchId,
    insertedRows: result.insertedRows,
    updatedRows: result.updatedRows,
    summary: result.summary,
    errors: result.errors.slice(0, 50),
  });
}

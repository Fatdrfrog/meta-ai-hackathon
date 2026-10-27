import { processHalykPostLink } from "@/lib/billing/service";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

class PayloadParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadParseError";
  }
}

async function parsePayload(
  request: Request
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return (await request.json()) as Record<string, unknown>;
    } catch {
      throw new PayloadParseError("Malformed JSON payload");
    }
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    return Object.fromEntries(formData.entries());
  }

  const text = await request.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  try {
    const payload = await parsePayload(request);
    const result = await processHalykPostLink(payload);
    if (!result.ok) {
      const status = typeof result.status === "number" ? result.status : 500;
      return NextResponse.json({ error: result.error }, { status });
    }

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof PayloadParseError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logger.error("billing.halyk.postlink_failed", error, {
      event: "billing.halyk.postlink_failed",
    });
    return NextResponse.json(
      { error: "Failed to process Halyk postLink" },
      { status: 500 }
    );
  }
}

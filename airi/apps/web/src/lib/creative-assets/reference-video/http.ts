import "server-only";

import { NextResponse } from "next/server";
import { ReferenceVideoPlanError } from "./service";

export function referenceVideoPlanErrorResponse(
  error: unknown,
  operation: "draft" | "approve"
): NextResponse {
  if (error instanceof ReferenceVideoPlanError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status }
    );
  }
  return NextResponse.json(
    {
      error:
        operation === "draft"
          ? "Video planning is temporarily unavailable. Please retry."
          : "Video rendering is temporarily unavailable. Please retry the saved plan.",
    },
    { status: 503 }
  );
}

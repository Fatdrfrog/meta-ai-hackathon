import { NextResponse } from "next/server";

import {
  applyWhatsAppQrMessage,
  checkWhatsAppQrProviderState,
  connectWhatsAppQrEntryPointCode,
  createWhatsAppQrEntryPointCode,
  deleteWhatsAppQrCodeFromProvider,
  reconcileWhatsAppQrOperation,
  replaceWhatsAppQrCode,
  setWhatsAppQrCodeRouting,
  WhatsAppQrServiceError,
  type ApplyWhatsAppQrMessageParams,
  type CheckWhatsAppQrProviderStateParams,
  type ConnectWhatsAppQrParams,
  type CreateWhatsAppQrParams,
  type DeleteWhatsAppQrCodeFromProviderParams,
  type ReconcileWhatsAppQrParams,
  type ReplaceWhatsAppQrCodeParams,
  type SetWhatsAppQrCodeRoutingParams,
  type WhatsAppQrCommandResult,
  type WhatsAppQrServiceErrorCode,
} from "./service";

export {
  getWhatsAppQrEntryPointDetail,
  listWhatsAppQrScenarioSummaries,
} from "./queries";

export {
  applyWhatsAppQrMessage,
  checkWhatsAppQrProviderState,
  connectWhatsAppQrEntryPointCode,
  createWhatsAppQrEntryPointCode,
  deleteWhatsAppQrCodeFromProvider,
  reconcileWhatsAppQrOperation,
  replaceWhatsAppQrCode,
  setWhatsAppQrCodeRouting,
  WhatsAppQrServiceError,
  type ApplyWhatsAppQrMessageParams,
  type CheckWhatsAppQrProviderStateParams,
  type ConnectWhatsAppQrParams,
  type CreateWhatsAppQrParams,
  type DeleteWhatsAppQrCodeFromProviderParams,
  type ReconcileWhatsAppQrParams,
  type ReplaceWhatsAppQrCodeParams,
  type SetWhatsAppQrCodeRoutingParams,
  type WhatsAppQrCommandResult,
  type WhatsAppQrServiceErrorCode,
};

const SERVICE_ERROR_STATUS: Record<WhatsAppQrServiceErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  ACTIVE_SCENARIO_ASSIGNMENT: 409,
  OPERATION_BUSY: 409,
  OPERATION_CONFLICT: 409,
  PROVIDER_FAILED: 502,
  RECONCILE_REQUIRED: 202,
  STORAGE_FAILED: 500,
};

export function whatsAppQrServiceErrorResponse(
  error: WhatsAppQrServiceError
): NextResponse {
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: SERVICE_ERROR_STATUS[error.code] ?? 500 }
  );
}

export function whatsAppQrCommandResultResponse(
  result: WhatsAppQrCommandResult
): NextResponse {
  switch (result.status) {
    case "applied":
      return NextResponse.json(result, { status: 200 });
    case "replay":
      return NextResponse.json(result, {
        status: result.result.outcome === "failed" ? 502 : 200,
      });
    case "busy":
      return NextResponse.json(result, { status: 409 });
    case "reconcile_required":
      return NextResponse.json(result, { status: 202 });
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export function parseWhatsAppQrIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get("Idempotency-Key");
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  if (!key || key.length > 256) return null;
  return key;
}

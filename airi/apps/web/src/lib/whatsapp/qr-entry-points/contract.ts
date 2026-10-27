import type { WhatsAppQrOperationRecord } from "@/models/whatsapp-qr-operation";

export const WHATSAPP_QR_OPERATION_LEASE_MS = 2 * 60 * 1_000;
export const WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type WhatsAppQrCommandKind = WhatsAppQrOperationRecord["kind"];

export type WhatsAppQrStoreErrorCode =
  | "INVALID_INPUT"
  | "OPERATION_CONFLICT"
  | "OPERATION_BUSY"
  | "ENTRY_POINT_VERSION_CONFLICT"
  | "CODE_VERSION_CONFLICT"
  | "STORAGE_FAILED"
  | "NOT_FOUND";

export class WhatsAppQrStoreError extends Error {
  constructor(
    readonly code: WhatsAppQrStoreErrorCode,
    message = "WhatsApp QR store operation failed"
  ) {
    super(message);
    this.name = "WhatsAppQrStoreError";
  }
}

export type WhatsAppQrTerminalResult = NonNullable<
  WhatsAppQrOperationRecord["cachedTerminalResult"]
>;

export type WhatsAppQrOperationLease = {
  operationId: string;
  workspaceId: string;
  entryPointId: string;
  ownerToken: string;
  fence: number;
  expiresAt: Date;
};

export type ReserveWhatsAppQrOperationResult =
  | {
      kind: "acquired";
      operation: WhatsAppQrOperationRecord;
      lease: WhatsAppQrOperationLease;
      isNew: boolean;
    }
  | {
      kind: "replay";
      operation: WhatsAppQrOperationRecord;
      result: WhatsAppQrTerminalResult;
    }
  | {
      kind: "busy";
      operation: WhatsAppQrOperationRecord;
    };

export type WhatsAppQrSanitizedError = NonNullable<
  WhatsAppQrOperationRecord["sanitizedError"]
>;

export type LookupWhatsAppQrOperationResult =
  | { kind: "miss" }
  | {
      kind: "replay";
      operation: WhatsAppQrOperationRecord;
      result: WhatsAppQrTerminalResult;
    }
  | { kind: "busy"; operation: WhatsAppQrOperationRecord };

export type AcquireWhatsAppQrReconciliationResult =
  | {
      kind: "acquired";
      operation: WhatsAppQrOperationRecord;
      lease: WhatsAppQrOperationLease;
    }
  | { kind: "busy"; operation: WhatsAppQrOperationRecord };

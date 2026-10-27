/**
 * @jest-environment node
 */

jest.mock("./service", () => ({
  applyWhatsAppQrMessage: jest.fn(),
  connectWhatsAppQrEntryPointCode: jest.fn(),
  createWhatsAppQrEntryPointCode: jest.fn(),
  deleteWhatsAppQrCodeFromProvider: jest.fn(),
  ensureWhatsAppQrDraftEntryPoint: jest.fn(),
  moveWhatsAppQrEntryPoint: jest.fn(),
  replaceWhatsAppQrCode: jest.fn(),
  setWhatsAppQrCodeRouting: jest.fn(),
  WhatsAppQrServiceError: class WhatsAppQrServiceError extends Error {},
}));

import { whatsAppQrCommandResultResponse } from "./http";

describe("whatsAppQrCommandResultResponse", () => {
  it("preserves provider failure status for failed idempotent replays", async () => {
    const response = whatsAppQrCommandResultResponse({
      status: "replay",
      entryPointId: "entry-1",
      result: {
        outcome: "failed",
        status: "FAILED",
        entryPointVersion: 2,
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      status: "replay",
      result: { outcome: "failed", status: "FAILED" },
    });
  });

  it("returns successful replays as 200", () => {
    const response = whatsAppQrCommandResultResponse({
      status: "replay",
      entryPointId: "entry-1",
      result: {
        outcome: "applied",
        status: "COMPLETED",
        entryPointVersion: 2,
      },
    });
    expect(response.status).toBe(200);
  });

  it("returns reconciliation results as 202", () => {
    const response = whatsAppQrCommandResultResponse({
      status: "reconcile_required",
      entryPointId: "entry-1",
      operationId: "operation-1",
    });
    expect(response.status).toBe(202);
  });
});

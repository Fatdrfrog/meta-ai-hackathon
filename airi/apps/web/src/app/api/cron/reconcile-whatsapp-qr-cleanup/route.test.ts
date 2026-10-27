const mockVerifyCronAuth = jest.fn();
const mockProcessWhatsAppQrDetachPendingBatch = jest.fn();

jest.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: (...args: unknown[]) => mockVerifyCronAuth(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/cleanup-retry", () => ({
  processWhatsAppQrDetachPendingBatch: (...args: unknown[]) =>
    mockProcessWhatsAppQrDetachPendingBatch(...args),
}));

import { GET } from "./route";

describe("/api/cron/reconcile-whatsapp-qr-cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyCronAuth.mockReturnValue(null);
    mockProcessWhatsAppQrDetachPendingBatch.mockResolvedValue({
      scanned: 2,
      completed: 1,
      pending: 1,
      failed: 0,
    });
  });

  it("rejects unauthorized cron requests before scanning pending cleanup", async () => {
    mockVerifyCronAuth.mockReturnValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await GET(
      new Request("https://example.com/api/cron/reconcile-whatsapp-qr-cleanup")
    );

    expect(response.status).toBe(401);
    expect(mockProcessWhatsAppQrDetachPendingBatch).not.toHaveBeenCalled();
  });

  it("processes the requested bounded cleanup batch", async () => {
    const response = await GET(
      new Request(
        "https://example.com/api/cron/reconcile-whatsapp-qr-cleanup?limit=25"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      scanned: 2,
      completed: 1,
      pending: 1,
      failed: 0,
    });
    expect(mockProcessWhatsAppQrDetachPendingBatch).toHaveBeenCalledWith({
      limit: 25,
    });
  });

  it("does not report success when a due scenario could not be processed", async () => {
    mockProcessWhatsAppQrDetachPendingBatch.mockResolvedValueOnce({
      scanned: 2,
      completed: 1,
      pending: 0,
      failed: 1,
    });

    const response = await GET(
      new Request("https://example.com/api/cron/reconcile-whatsapp-qr-cleanup")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      scanned: 2,
      completed: 1,
      pending: 0,
      failed: 1,
    });
  });
});

export {};

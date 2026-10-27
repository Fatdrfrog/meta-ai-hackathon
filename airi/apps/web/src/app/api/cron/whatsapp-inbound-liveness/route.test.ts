const mockVerifyCronAuth = jest.fn();
const mockAcquireLock = jest.fn();
const mockCompareAndDelete = jest.fn();
const mockRunCheck = jest.fn();

jest.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: (...args: unknown[]) => mockVerifyCronAuth(...args),
}));
jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: string[]) =>
    [namespace, ...parts].join(":"),
  cache: {
    acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
    compareAndDelete: (...args: unknown[]) => mockCompareAndDelete(...args),
  },
}));
jest.mock("@/lib/whatsapp/inbound-liveness-monitor", () => ({
  runWhatsAppInboundLivenessCheck: (...args: unknown[]) =>
    mockRunCheck(...args),
}));
jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { GET } from "./route";

const request = () =>
  new Request("https://www.airi.chat/api/cron/whatsapp-inbound-liveness");

describe("GET /api/cron/whatsapp-inbound-liveness", () => {
  const originalFlag = process.env.WHATSAPP_INBOUND_LIVENESS_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyCronAuth.mockReturnValue(null);
    mockAcquireLock.mockResolvedValue("acquired");
    mockRunCheck.mockResolvedValue({ checked: 2, silent: [], recovered: [] });
    process.env.WHATSAPP_INBOUND_LIVENESS_ENABLED = "true";
  });

  afterAll(() => {
    if (originalFlag === undefined) {
      delete process.env.WHATSAPP_INBOUND_LIVENESS_ENABLED;
    } else {
      process.env.WHATSAPP_INBOUND_LIVENESS_ENABLED = originalFlag;
    }
  });

  it("rejects calls without the cron secret", async () => {
    const denied = new Response("Unauthorized", { status: 401 });
    mockVerifyCronAuth.mockReturnValue(denied);

    expect(await GET(request())).toBe(denied);
    expect(mockRunCheck).not.toHaveBeenCalled();
  });

  it("does nothing until it is enabled", async () => {
    delete process.env.WHATSAPP_INBOUND_LIVENESS_ENABLED;

    const response = await GET(request());

    expect(await response.json()).toEqual({
      status: "skipped",
      reason: "disabled",
    });
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it("runs the check under a lock and releases it", async () => {
    const response = await GET(request());

    expect(await response.json()).toEqual({
      status: "ok",
      checked: 2,
      silent: [],
      recovered: [],
    });
    const [lockKey, lockToken] = mockAcquireLock.mock.calls[0];
    expect(lockKey).toBe("whatsapp:inbound-liveness:v1:global");
    expect(mockCompareAndDelete).toHaveBeenCalledWith(lockKey, lockToken);
  });

  it("skips while another run holds the lock", async () => {
    mockAcquireLock.mockResolvedValue("contended");

    const response = await GET(request());

    expect(await response.json()).toEqual({
      status: "skipped",
      reason: "already_running",
    });
    expect(mockRunCheck).not.toHaveBeenCalled();
  });

  it("releases the lock when the check fails", async () => {
    mockRunCheck.mockRejectedValue(new Error("Mongo unavailable"));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(mockCompareAndDelete).toHaveBeenCalled();
  });
});

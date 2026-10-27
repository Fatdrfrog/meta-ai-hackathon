const mockCreateClient = jest.fn();
const mockImportCustomerBirthdays = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/lib/customers/customer-birthday-import", () => ({
  importCustomerBirthdays: (...args: unknown[]) =>
    mockImportCustomerBirthdays(...args),
}));

import { POST } from "./route";

const counts = {
  total: 2,
  imported: 1,
  updated: 0,
  skippedMissingPhone: 0,
  skippedMissingChatId: 0,
  skippedIneligibleTelegramSubscriber: 0,
  skippedMissingBirthday: 0,
  skippedInvalidBirthday: 1,
};
const membership = jest.fn();
const getUser = jest.fn();

function request(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/campaigns/birthday-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      recipients: [
        { phone: "+77001234567", birthday: "17.04.1992" },
        { phone: "+77007654321", birthday: "31.02" },
      ],
      ...overrides,
    }),
  });
}

describe("POST /api/campaigns/birthday-import", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    membership.mockResolvedValue({ data: { role: "admin" }, error: null });
    mockCreateClient.mockResolvedValue({
      auth: { getUser },
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: membership }) }),
        }),
      }),
    });
    mockImportCustomerBirthdays.mockResolvedValue(counts);
  });

  it.each(["whatsapp", "telegram"])(
    "rejects %s imports with no valid rows",
    async channel => {
      mockImportCustomerBirthdays.mockResolvedValue({
        ...counts,
        imported: 0,
        skippedInvalidBirthday: 2,
      });
      const response = await POST(
        request({
          channel,
          ...(channel === "telegram" ? { sourceId: "bot-1" } : {}),
        })
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "BIRTHDAY_IMPORT_NO_VALID_RECIPIENTS",
        total: 2,
        imported: 0,
        skippedInvalidBirthday: 2,
      });
    }
  );

  it("returns exact partial import counts", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...counts });
  });

  it("rejects empty uploads without importing", async () => {
    expect((await POST(request({ recipients: [] }))).status).toBe(400);
    expect(mockImportCustomerBirthdays).not.toHaveBeenCalled();
  });

  it("requires authentication and membership", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await POST(request())).status).toBe(401);
    membership.mockResolvedValueOnce({ data: null, error: null });
    expect((await POST(request())).status).toBe(403);
    expect(mockImportCustomerBirthdays).not.toHaveBeenCalled();
  });

  it("requires the selected Telegram bot", async () => {
    expect((await POST(request({ channel: "telegram" }))).status).toBe(400);
    expect(mockImportCustomerBirthdays).not.toHaveBeenCalled();
  });

  it("does not expose internal database errors", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      mockImportCustomerBirthdays.mockRejectedValue(
        new Error("private database connection details")
      );
      const response = await POST(request());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to import birthdays",
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});

import { getWorkspaceSourceReadiness } from "./source-readiness";

function mockSupabaseSourceRows(rows: unknown[]) {
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(async () => ({ data: rows, error: null })),
      })),
    })),
  };
}

describe("getWorkspaceSourceReadiness", () => {
  it("ignores unconfigured Telegram placeholders", async () => {
    const readiness = await getWorkspaceSourceReadiness(
      mockSupabaseSourceRows([
        { id: "source-1", type: "telegram", name: "Telegram", credentials: {} },
      ]),
      "workspace-1"
    );

    expect(readiness).toEqual({
      configuredSources: [],
      configuredSourceTypes: [],
      hasConfiguredSources: false,
      hasWhatsApp: false,
      loadError: false,
    });
  });

  it("reports configured source types and WhatsApp readiness", async () => {
    const readiness = await getWorkspaceSourceReadiness(
      mockSupabaseSourceRows([
        {
          id: "source-1",
          type: "telegram",
          name: "Telegram",
          credentials: { bot_token: "123:abc" },
        },
        {
          id: "source-2",
          type: "whatsapp",
          name: "WhatsApp",
          credentials: { phone_number_id: "phone-1" },
        },
      ]),
      "workspace-1"
    );

    expect(readiness.configuredSourceTypes).toEqual(["telegram", "whatsapp"]);
    expect(readiness.hasConfiguredSources).toBe(true);
    expect(readiness.hasWhatsApp).toBe(true);
  });
});

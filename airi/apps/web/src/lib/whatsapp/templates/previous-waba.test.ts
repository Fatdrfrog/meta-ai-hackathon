const mockLimit = jest.fn();
const mockOrder = jest.fn(() => ({ limit: mockLimit }));
const mockNot = jest.fn(() => ({ order: mockOrder }));
const mockEq = jest.fn(() => ({ not: mockNot }));
const mockSelect = jest.fn(() => ({ eq: mockEq }));
const mockFrom = jest.fn((_table: string) => ({ select: mockSelect }));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => mockFrom(table),
  },
}));

import { resolvePreviousWhatsAppWabaId } from "@/lib/whatsapp/templates/previous-waba";

describe("resolvePreviousWhatsAppWabaId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLimit.mockResolvedValue({ data: [], error: null });
  });

  it("loads workspace-scoped connect events and skips the current WABA", async () => {
    mockLimit.mockResolvedValue({
      data: [
        {
          event_type: "embedded_signup_source_persisted",
          legacy_waba_id: "waba-old",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          event_type: "PARTNER_REMOVED",
          legacy_waba_id: "waba-removed",
          created_at: "2026-02-01T00:00:00.000Z",
        },
        {
          event_type: "source_reconnected",
          legacy_waba_id: "waba-new",
          created_at: "2026-03-01T00:00:00.000Z",
        },
      ],
      error: null,
    });

    const result = await resolvePreviousWhatsAppWabaId({
      workspaceId: "workspace-acme",
      currentWabaId: "waba-new",
    });

    expect(mockFrom).toHaveBeenCalledWith("whatsapp_onboarding_events");
    expect(mockEq).toHaveBeenCalledWith("workspace_id", "workspace-acme");
    expect(result).toEqual({
      previousWabaId: "waba-old",
      wabaHistory: [
        { wabaId: "waba-old", recordedAt: "2026-01-01T00:00:00.000Z" },
        { wabaId: "waba-new", recordedAt: "2026-03-01T00:00:00.000Z" },
      ],
    });
  });

  it("returns null previous WABA when the workspace has no other connected account", async () => {
    mockLimit.mockResolvedValue({
      data: [
        {
          event_type: "ACCOUNT_RECONNECTED",
          legacy_waba_id: "waba-only",
          created_at: "2026-04-01T00:00:00.000Z",
        },
      ],
      error: null,
    });

    await expect(
      resolvePreviousWhatsAppWabaId({
        workspaceId: "workspace-beta",
        currentWabaId: "waba-only",
      })
    ).resolves.toEqual({
      previousWabaId: null,
      wabaHistory: [
        { wabaId: "waba-only", recordedAt: "2026-04-01T00:00:00.000Z" },
      ],
    });
  });
});

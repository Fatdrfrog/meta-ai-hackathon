import {
  fetchCampaignBirthdayProtection,
  fetchTelegramSubscriberTotal,
  fetchWorkspaceTelegramSources,
  formatCampaignConnectedSourceLabel,
  importCampaignBirthdays,
  resolveBulkCampaignPickerSourceIds,
} from "./campaign-audience-client";
import { BulkCampaignRequestError } from "./bulk-campaign-client";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("campaign audience client", () => {
  it("formats connected source labels from bot, phone, or address", () => {
    expect(
      formatCampaignConnectedSourceLabel({
        id: "tg-1",
        credentials: { bot_username: "airi_bot" },
      })
    ).toBe("@airi_bot");
    expect(
      formatCampaignConnectedSourceLabel({
        id: "wa-1",
        name: "Sales",
        credentials: { display_phone_number: "+77001234567" },
      })
    ).toBe("+77001234567");
    expect(
      formatCampaignConnectedSourceLabel({
        id: "email-1",
        full_address: "hello@airi.chat",
      })
    ).toBe("hello@airi.chat");
  });

  it("scopes picker sourceIds to the selected campaign channel", () => {
    expect(
      resolveBulkCampaignPickerSourceIds({
        channel: "whatsapp",
        whatsappSourceId: "wa-1",
        telegramSourceId: "tg-1",
      })
    ).toEqual(["wa-1"]);
    expect(
      resolveBulkCampaignPickerSourceIds({
        channel: "telegram",
        whatsappSourceId: "wa-1",
        telegramSourceId: "tg-1",
      })
    ).toEqual(["tg-1"]);
    expect(
      resolveBulkCampaignPickerSourceIds({
        channel: "email",
        emailSourceId: " ",
      })
    ).toBeUndefined();
  });

  it("keeps only telegram integration sources", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        sources: [
          { id: "tg-1", type: "telegram", name: "Bot" },
          { id: "wa-1", type: "whatsapp", name: "WA" },
          { type: "telegram", name: "missing-id" },
        ],
      })
    );

    await expect(fetchWorkspaceTelegramSources("workspace-1")).resolves.toEqual(
      [{ id: "tg-1", type: "telegram", name: "Bot" }]
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/integrations"
    );
  });

  it("reads telegram subscriber totals and birthday protection", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ total: 42 }))
      .mockResolvedValueOnce(
        jsonResponse({ active: true, protectedTodayCount: 3 })
      );

    await expect(
      fetchTelegramSubscriberTotal({
        workspaceId: "workspace-1",
        sourceId: "tg-1",
      })
    ).resolves.toBe(42);
    await expect(
      fetchCampaignBirthdayProtection({
        workspaceId: "workspace-1",
        dailyLimit: 100,
      })
    ).resolves.toEqual({ active: true, protectedTodayCount: 3 });
  });

  it("throws when telegram or birthday-protection reads fail", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 500))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 500));

    await expect(fetchWorkspaceTelegramSources("workspace-1")).rejects.toThrow(
      "unauthorized"
    );
    await expect(
      fetchTelegramSubscriberTotal({
        workspaceId: "workspace-1",
        sourceId: "tg-1",
      })
    ).rejects.toThrow("unavailable");
    await expect(
      fetchCampaignBirthdayProtection({
        workspaceId: "workspace-1",
        dailyLimit: 100,
      })
    ).rejects.toThrow("unavailable");
  });

  it("keeps the status and coded reason of a failed read", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "telegram_unavailable" } }, 503)
      );

    const error = await fetchTelegramSubscriberTotal({
      workspaceId: "workspace-1",
      sourceId: "tg-1",
    }).catch(caught => caught);

    expect(error).toBeInstanceOf(BulkCampaignRequestError);
    expect(error).toMatchObject({
      message: "Failed to load Telegram subscribers",
      status: 503,
      code: "telegram_unavailable",
    });
  });

  it("imports birthdays and surfaces API errors", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          total: 1,
          imported: 1,
          updated: 0,
          skippedMissingPhone: 0,
          skippedMissingChatId: 0,
          skippedIneligibleTelegramSubscriber: 0,
          skippedMissingBirthday: 0,
          skippedInvalidBirthday: 0,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: "Telegram source is required" }, 400)
      );

    await importCampaignBirthdays({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      recipients: [{ phone: "+77001234567" }],
      errorFallback: "Failed to import birthdays",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/campaigns/birthday-import",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workspaceId: "workspace-1",
          channel: "whatsapp",
          recipients: [{ phone: "+77001234567" }],
        }),
      })
    );

    await expect(
      importCampaignBirthdays({
        workspaceId: "workspace-1",
        channel: "telegram",
        recipients: [{ chatId: "1" }],
        errorFallback: "Failed to import birthdays",
      })
    ).rejects.toThrow("Telegram source is required");
  });

  it("returns saved and rejected counts for a partial birthday import", async () => {
    const result = {
      total: 2,
      imported: 1,
      updated: 0,
      skippedMissingPhone: 0,
      skippedMissingChatId: 0,
      skippedIneligibleTelegramSubscriber: 0,
      skippedMissingBirthday: 0,
      skippedInvalidBirthday: 1,
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, ...result }));
    await expect(
      importCampaignBirthdays({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        recipients: [
          { phone: "+77001234567", birthday: "17.04" },
          { phone: "+77007654321", birthday: "31.02" },
        ],
        errorFallback: "Import failed",
      })
    ).resolves.toEqual(result);
  });

  it.each([
    { ok: true },
    {
      ok: true,
      total: 1,
      imported: 0,
      updated: 0,
      skippedMissingPhone: 0,
      skippedMissingChatId: 0,
      skippedIneligibleTelegramSubscriber: 0,
      skippedMissingBirthday: 0,
      skippedInvalidBirthday: 1,
    },
  ])("rejects incomplete or zero-success birthday responses", async payload => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(payload));
    await expect(
      importCampaignBirthdays({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        recipients: [{ phone: "+77001234567" }],
        errorFallback: "Import failed",
      })
    ).rejects.toThrow("Import failed");
  });
});

import {
  isElevenLabsSource,
  isMetaAdsSource,
  isGoogleCalendarSource,
  isHiggsfieldSource,
  isCanvaSource,
  SOURCE_CHANNELS,
  SOURCE_TYPES,
  type Source,
} from "@icecore/shared/types/sources";
describe("shared source types", () => {
  it("persists Google AI without treating it as a messaging channel", () => {
    expect(SOURCE_TYPES).toContain("google_ai");
    expect(SOURCE_CHANNELS).not.toContain("google_ai");
  });
  it("treats Canva as a persisted source type without making it a conversation channel", () => {
    expect(SOURCE_TYPES).toContain("canva");
    expect(SOURCE_CHANNELS).not.toContain("canva");

    const source: Source = {
      id: "source-1",
      created_at: "2026-05-04T00:00:00.000Z",
      company_id: "company-1",
      workspace_id: "workspace-1",
      type: "canva",
      name: "Canva",
      credentials: {
        access_token: { iv: "iv", tag: "tag", ciphertext: "ciphertext" },
        scope: "brandtemplate:meta:read",
      },
    };

    expect(isCanvaSource(source)).toBe(true);
  });

  it("treats Higgsfield as a persisted source type without making it a conversation channel", () => {
    expect(SOURCE_TYPES).toContain("higgsfield");
    expect(SOURCE_CHANNELS).not.toContain("higgsfield");

    const source: Source = {
      id: "source-1",
      created_at: "2026-06-07T00:00:00.000Z",
      company_id: "company-1",
      workspace_id: "workspace-1",
      type: "higgsfield",
      name: "Higgsfield",
      credentials: {
        key: "higgsfield-key",
      },
    };

    expect(isHiggsfieldSource(source)).toBe(true);
  });

  it("treats ElevenLabs as a persisted source type without making it a conversation channel", () => {
    expect(SOURCE_TYPES).toContain("elevenlabs");
    expect(SOURCE_CHANNELS).not.toContain("elevenlabs");

    const source: Source = {
      id: "source-1",
      created_at: "2026-06-07T00:00:00.000Z",
      company_id: "company-1",
      workspace_id: "workspace-1",
      type: "elevenlabs",
      name: "ElevenLabs",
      credentials: {
        api_key: "elevenlabs-key",
      },
    };

    expect(isElevenLabsSource(source)).toBe(true);
  });

  it("treats Google Calendar as a persisted source type without making it a conversation channel", () => {
    expect(SOURCE_TYPES).toContain("google_calendar");
    expect(SOURCE_CHANNELS).not.toContain("google_calendar");

    const source: Source = {
      id: "source-1",
      created_at: "2026-06-01T00:00:00.000Z",
      company_id: "company-1",
      workspace_id: "workspace-1",
      type: "google_calendar",
      name: "Google Calendar",
      credentials: {
        access_token: { iv: "iv", tag: "tag", ciphertext: "ciphertext" },
        refresh_token: { iv: "iv", tag: "tag", ciphertext: "ciphertext" },
        scope: "https://www.googleapis.com/auth/calendar.freebusy",
      },
    };

    expect(isGoogleCalendarSource(source)).toBe(true);
  });

  it("treats Meta Ads as a persisted source type without making it a conversation channel", () => {
    expect(SOURCE_TYPES).toContain("meta_ads");
    expect(SOURCE_CHANNELS).not.toContain("meta_ads");

    const source: Source = {
      id: "source-1",
      created_at: "2026-06-07T00:00:00.000Z",
      company_id: "company-1",
      workspace_id: "workspace-1",
      type: "meta_ads",
      name: "Meta Ads",
      credentials: {
        access_token: { iv: "iv", tag: "tag", ciphertext: "ciphertext" },
        scope: "ads_read",
        ad_accounts: [
          {
            id: "act_123",
            account_id: "123",
            name: "Demoshop ads",
          },
        ],
      },
    };

    expect(isMetaAdsSource(source)).toBe(true);
  });
});

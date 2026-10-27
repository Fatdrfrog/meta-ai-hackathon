import { getIntegrationById, INTEGRATIONS } from "./integration-registry";
import { GoogleLogo } from "./assets/google_logo";

describe("integration registry", () => {
  it("makes the workspace Google AI connection selectable separately from Calendar", () => {
    const googleAI = getIntegrationById("google_ai");
    expect(googleAI).toEqual(
      expect.objectContaining({
        id: "google_ai",
        category: "creative",
        name: "google_ai.name",
        description: "google_ai.description",
      })
    );
    expect(googleAI?.icon.light).toBe(GoogleLogo);
    expect(getIntegrationById("google_calendar")?.id).toBe("google_calendar");
  });
  it("registers Canva as a selectable integration with the public icon", () => {
    const canva = getIntegrationById("canva");

    expect(canva).toEqual(
      expect.objectContaining({
        id: "canva",
        category: "creative",
        name: "canva.name",
        description: "canva.description",
      })
    );
    expect(canva?.icon.light).toEqual(
      expect.objectContaining({ src: "/canva-icon.svg" })
    );
    expect(INTEGRATIONS.map(integration => integration.id)).toContain("canva");
  });

  it("registers Higgsfield as a source integration for creative generation", () => {
    const higgsfield = getIntegrationById("higgsfield");

    expect(higgsfield).toEqual(
      expect.objectContaining({
        id: "higgsfield",
        category: "creative",
        name: "higgsfield.name",
        description: "higgsfield.description",
      })
    );
    expect(INTEGRATIONS.map(integration => integration.id)).toContain(
      "higgsfield"
    );
    expect(higgsfield?.icon.light).toEqual(
      expect.objectContaining({ src: "/higgsfield-logo.png" })
    );
  });

  it("registers ElevenLabs as a source integration for voice assets", () => {
    const elevenlabs = getIntegrationById("elevenlabs");

    expect(elevenlabs).toEqual(
      expect.objectContaining({
        id: "elevenlabs",
        category: "creative",
        name: "elevenlabs.name",
        description: "elevenlabs.description",
      })
    );
    expect(INTEGRATIONS.map(integration => integration.id)).toContain(
      "elevenlabs"
    );
    expect(elevenlabs?.icon.light).toEqual(
      expect.objectContaining({ src: "/elevenlabs-symbol.svg" })
    );
  });

  it("uses Postmark branding for Email and Google branding for Calendar", () => {
    const email = getIntegrationById("email");
    const calendar = getIntegrationById("google_calendar");

    expect(email?.icon.light).toEqual(
      expect.objectContaining({ src: "/postmark.png" })
    );
    expect(calendar?.icon.light).toBe(GoogleLogo);
  });

  it("registers Meta Ads as a source integration for ad attribution enrichment", () => {
    const metaAds = getIntegrationById("meta_ads");

    expect(metaAds).toEqual(
      expect.objectContaining({
        id: "meta_ads",
        category: "creative",
        name: "meta_ads.name",
        description: "meta_ads.description",
      })
    );
    expect(INTEGRATIONS.map(integration => integration.id)).toContain(
      "meta_ads"
    );
  });
});

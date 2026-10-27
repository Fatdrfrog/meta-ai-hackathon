import {
  WhatsAppTemplateCatalogError,
  staleWhatsAppTemplateCatalogMissError,
  type WhatsAppTemplateCatalogMetadata,
  type WhatsAppTemplateCatalogRefreshOutcome,
} from "./catalog-contracts";

function catalog(
  overrides: Partial<WhatsAppTemplateCatalogMetadata> = {}
): WhatsAppTemplateCatalogMetadata {
  return {
    source: "cache",
    stale: true,
    fetchedAt: "2026-10-07T08:00:00.000Z",
    wabaId: "waba-1",
    refreshOutcome: "cooldown",
    retryAt: "2026-10-07T10:00:00.000Z",
    ...overrides,
  };
}

describe("staleWhatsAppTemplateCatalogMissError", () => {
  it.each([
    ["no catalog", undefined],
    ["a null catalog", null],
    [
      "a current catalog",
      catalog({ stale: false, refreshOutcome: "fresh", retryAt: null }),
    ],
    [
      "a catalog just read from Meta",
      catalog({
        source: "live",
        stale: false,
        refreshOutcome: "succeeded",
        retryAt: null,
      }),
    ],
  ])("trusts a miss on %s", (_label, metadata) => {
    expect(staleWhatsAppTemplateCatalogMissError(metadata)).toBeNull();
  });

  it.each([["cooldown"], ["rate_limited"]] as const)(
    "makes a miss on a stale catalog during Meta's %s a rate limit that ends at its retry time",
    refreshOutcome => {
      const error = staleWhatsAppTemplateCatalogMissError(
        catalog({ refreshOutcome, providerCode: 80008 })
      );

      expect(error).toBeInstanceOf(WhatsAppTemplateCatalogError);
      expect(error).toMatchObject({
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        status: 429,
        retryAt: "2026-10-07T10:00:00.000Z",
        providerCode: 80008,
      });
    }
  );

  it.each([
    ["failed"],
    ["in_progress"],
    ["coordination_unavailable"],
    ["minimum_interval"],
  ] as Array<[WhatsAppTemplateCatalogRefreshOutcome]>)(
    "makes a miss on a stale catalog an unavailable catalog when the refresh outcome is %s",
    refreshOutcome => {
      const error = staleWhatsAppTemplateCatalogMissError(
        catalog({ refreshOutcome, retryAt: null })
      );

      expect(error).toMatchObject({
        code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
        status: 503,
        retryAt: null,
      });
    }
  );
});

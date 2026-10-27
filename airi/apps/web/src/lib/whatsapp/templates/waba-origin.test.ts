import {
  compactWhatsAppWabaId,
  inferWhatsAppTemplateSourceWabaId,
} from "@/lib/whatsapp/templates/waba-origin";

describe("compactWhatsAppWabaId", () => {
  it("keeps Graph ids that arrived as numbers", () => {
    expect(compactWhatsAppWabaId(940525742304249)).toBe("940525742304249");
    expect(compactWhatsAppWabaId(" 940525742304249 ")).toBe("940525742304249");
  });
});

describe("inferWhatsAppTemplateSourceWabaId", () => {
  const history = [
    { wabaId: "waba-alpha", recordedAt: "2026-01-10T00:00:00.000Z" },
    { wabaId: "waba-beta", recordedAt: "2026-03-10T00:00:00.000Z" },
    { wabaId: "waba-gamma", recordedAt: "2026-06-10T00:00:00.000Z" },
  ];

  it("prefers a stored origin that is not the connected WABA", () => {
    expect(
      inferWhatsAppTemplateSourceWabaId({
        storedWabaId: "waba-stored",
        currentWabaId: "waba-gamma",
        templateCreatedAt: "2026-04-01T00:00:00.000Z",
        wabaHistory: history,
        fallbackPreviousWabaId: "waba-beta",
      })
    ).toBe("waba-stored");
  });

  it("keeps a numeric stored origin that is not the connected WABA", () => {
    expect(
      inferWhatsAppTemplateSourceWabaId({
        storedWabaId: 940525742304249,
        currentWabaId: "waba-gamma",
      })
    ).toBe("940525742304249");
  });

  it("ignores a stored origin that already matches the connected WABA", () => {
    expect(
      inferWhatsAppTemplateSourceWabaId({
        storedWabaId: "waba-gamma",
        currentWabaId: "waba-gamma",
        templateCreatedAt: "2026-04-01T00:00:00.000Z",
        wabaHistory: history,
        fallbackPreviousWabaId: "waba-beta",
      })
    ).toBe("waba-beta");
  });

  it("infers origin from whichever WABA was connected when the template was created", () => {
    expect(
      inferWhatsAppTemplateSourceWabaId({
        currentWabaId: "waba-gamma",
        templateCreatedAt: "2026-02-01T00:00:00.000Z",
        wabaHistory: history,
      })
    ).toBe("waba-alpha");
    expect(
      inferWhatsAppTemplateSourceWabaId({
        currentWabaId: "waba-gamma",
        templateCreatedAt: "2026-04-01T00:00:00.000Z",
        wabaHistory: history,
      })
    ).toBe("waba-beta");
  });

  it("falls back to the latest previous WABA when created_at is missing", () => {
    expect(
      inferWhatsAppTemplateSourceWabaId({
        currentWabaId: "waba-gamma",
        wabaHistory: history,
        fallbackPreviousWabaId: "waba-beta",
      })
    ).toBe("waba-beta");
  });

  it("never returns the currently connected WABA as a previous origin", () => {
    expect(
      inferWhatsAppTemplateSourceWabaId({
        storedWabaId: "waba-gamma",
        currentWabaId: "waba-gamma",
        fallbackPreviousWabaId: "waba-gamma",
        wabaHistory: [
          {
            wabaId: "waba-gamma",
            recordedAt: "2026-06-10T00:00:00.000Z",
          },
        ],
      })
    ).toBeUndefined();
  });
});

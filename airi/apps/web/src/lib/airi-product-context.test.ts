import {
  AIRI_PRODUCT_CONTEXT,
  AIRI_PRODUCT_CONTEXT_VERSION,
  buildAiriProductCapabilityPromptContext,
  getAiriProductContextMetadata,
} from "./airi-product-context";

describe("airi product context", () => {
  it("keeps a bounded canonical product capability snapshot", () => {
    expect(AIRI_PRODUCT_CONTEXT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(AIRI_PRODUCT_CONTEXT.brandName).toBe("airi.chat");
    expect(AIRI_PRODUCT_CONTEXT.description).toContain(
      "helps teams build useful bulk campaigns and follow-ups from customer chats and knowledge base context"
    );
    expect(AIRI_PRODUCT_CONTEXT.description).not.toContain("knoweldge");
    expect(AIRI_PRODUCT_CONTEXT.legalName).toBe("Ais.ii TOO");
    expect(AIRI_PRODUCT_CONTEXT.entitySignals).toEqual(
      expect.arrayContaining([
        "Legal company: Ais.ii TOO",
        expect.stringContaining(
          "Business Identification Number (BIN) 250640028180"
        ),
        expect.stringContaining("Astana, 010000, Kazakhstan"),
      ])
    );
    expect(AIRI_PRODUCT_CONTEXT.capabilities).toEqual(
      expect.arrayContaining([
        expect.stringContaining("WhatsApp templates"),
        expect.stringContaining("WhatsApp Flows"),
        expect.stringContaining("bulk campaigns"),
        expect.stringContaining("scenarios"),
        expect.stringContaining("Canva"),
        expect.stringContaining("ElevenLabs"),
      ])
    );
    expect(AIRI_PRODUCT_CONTEXT.boundaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Do not claim that an external asset"),
        expect.stringContaining("published airi.chat knowledge-base articles"),
        expect.stringContaining("unpublished Airi conversations"),
      ])
    );
  });

  it("renders prompt context without stale customer-facing brand names", () => {
    const promptContext = buildAiriProductCapabilityPromptContext();

    expect(promptContext).toContain("AIRI.CHAT PRODUCT CAPABILITIES");
    expect(promptContext).toContain("airi.chat");
    expect(promptContext).toContain("WhatsApp Business");
    expect(promptContext).not.toContain("IceCoreAI");
    expect(promptContext).not.toContain("IceCore AI");
  });

  it("exposes stable metadata source ids", () => {
    const metadata = getAiriProductContextMetadata();

    expect(metadata.version).toBe(AIRI_PRODUCT_CONTEXT_VERSION);
    expect(metadata.sourceIds).toEqual(
      expect.arrayContaining([
        `airi_product:${AIRI_PRODUCT_CONTEXT_VERSION}:capabilities`,
        `airi_product:${AIRI_PRODUCT_CONTEXT_VERSION}:boundaries`,
      ])
    );
    expect(new Set(metadata.sourceIds).size).toBe(metadata.sourceIds.length);
  });
});

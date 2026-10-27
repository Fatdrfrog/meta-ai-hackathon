import {
  isSupportedWhatsAppTemplateLanguageCode,
  MAIN_TEMPLATE_LANGUAGE_COUNT,
  normalizeWhatsAppTemplateLanguageCode,
  normalizeWhatsAppTemplateLanguageForSend,
  SUPPORTED_LANGUAGES,
} from "@icecore/shared/constants/whatsapp-templates";

describe("WhatsApp template language codes", () => {
  it("normalizes legacy locale-style language codes to Meta-supported template codes", () => {
    expect(normalizeWhatsAppTemplateLanguageCode("ru_RU")).toBe("ru");
    expect(normalizeWhatsAppTemplateLanguageCode("kk_KZ")).toBe("kk");
    expect(normalizeWhatsAppTemplateLanguageCode("uz_UZ")).toBe("uz");
    expect(normalizeWhatsAppTemplateLanguageCode("en-us")).toBe("en_US");
  });

  it("does not offer unsupported locale-style codes in the picker", () => {
    const codes = SUPPORTED_LANGUAGES.map(language => language.code);

    expect(codes).toContain("ru");
    expect(codes).toContain("kk");
    expect(codes).toContain("uz");
    expect(codes).not.toContain("ru_RU");
    expect(codes).not.toContain("kk_KZ");
    expect(codes).not.toContain("uz_UZ");
  });

  it("rejects ambiguous or unsupported aliases", () => {
    expect(isSupportedWhatsAppTemplateLanguageCode("pt")).toBe(false);
    expect(isSupportedWhatsAppTemplateLanguageCode("zh")).toBe(false);
    expect(normalizeWhatsAppTemplateLanguageCode("pt")).toBeNull();
    expect(normalizeWhatsAppTemplateLanguageCode("zh")).toBeNull();
  });

  it("offers every language Meta lists for templates, once each", () => {
    const codes = SUPPORTED_LANGUAGES.map(language => language.code);

    // Meta's supported-languages table on 2026-10-13.
    expect(codes).toHaveLength(111);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z]{2,3}(_[A-Z]{2})?$/);
    }
    expect(codes).toEqual(
      expect.arrayContaining([
        "id",
        "uk",
        "pl",
        "ky_KG",
        "fil",
        "nb",
        "prs_AF",
        "en_AU",
        "es_CO",
      ])
    );
  });

  it("keeps the main markets first and the rest in name order", () => {
    expect(
      SUPPORTED_LANGUAGES.slice(0, MAIN_TEMPLATE_LANGUAGE_COUNT).map(
        language => language.code
      )
    ).toEqual(["en", "en_US", "en_GB", "ru", "kk", "uz"]);

    const otherNames = SUPPORTED_LANGUAGES.slice(
      MAIN_TEMPLATE_LANGUAGE_COUNT
    ).map(language => language.name);
    expect(otherNames).toEqual(
      [...otherNames].sort((left, right) => left.localeCompare(right, "en"))
    );
  });

  it("accepts the newly listed languages in any common spelling", () => {
    expect(normalizeWhatsAppTemplateLanguageCode("id")).toBe("id");
    expect(normalizeWhatsAppTemplateLanguageCode("ky-kg")).toBe("ky_KG");
    expect(normalizeWhatsAppTemplateLanguageCode("PRS_af")).toBe("prs_AF");
    // Meta takes Norwegian only as "nb".
    expect(normalizeWhatsAppTemplateLanguageCode("no")).toBeNull();
  });

  it("matches sent templates by the same identity as before", () => {
    expect(normalizeWhatsAppTemplateLanguageForSend("id")).toBe("id");
    expect(normalizeWhatsAppTemplateLanguageForSend("en-AU")).toBe("en_au");
    expect(normalizeWhatsAppTemplateLanguageForSend("ru_RU")).toBe("ru");
    expect(normalizeWhatsAppTemplateLanguageForSend("kz")).toBe("kk");
  });
});

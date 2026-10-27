import {
  buildWhatsAppContactMessagePayload,
  normalizeWhatsAppContactConfig,
} from "./whatsapp-contact";

describe("whatsapp contact normalization", () => {
  it("normalizes a scenario contact config into a Meta contacts payload", () => {
    const normalized = normalizeWhatsAppContactConfig({
      formattedName: "  Admissions   Team  ",
      phone: "+7 701 234 56 78",
      email: " HELLO@EXAMPLE.COM ",
      company: " EduDemo ",
      title: " Admissions ",
      websiteUrl: "example.com",
    });

    expect(normalized).toEqual({
      version: 1,
      formattedName: "Admissions Team",
      firstName: undefined,
      lastName: undefined,
      company: "EduDemo",
      title: "Admissions",
      phone: "77012345678",
      email: "hello@example.com",
      websiteUrl: "https://example.com/",
    });

    expect(buildWhatsAppContactMessagePayload(normalized)).toEqual({
      name: {
        formatted_name: "Admissions Team",
        first_name: "Admissions",
        last_name: "Team",
      },
      org: { company: "EduDemo", title: "Admissions" },
      phones: [{ phone: "77012345678", type: "WORK" }],
      emails: [{ email: "hello@example.com", type: "WORK" }],
      urls: [{ url: "https://example.com/", type: "WORK" }],
    });
  });

  it("rejects drafts without a formatted name", () => {
    expect(
      normalizeWhatsAppContactConfig({
        phone: "+77012345678",
        email: "hello@example.com",
      })
    ).toBeUndefined();
    expect(buildWhatsAppContactMessagePayload({ phone: "+77012345678" })).toBe(
      null
    );
  });
});

import {
  buildWhatsAppLocationMessagePayload,
  normalizeWhatsAppLocationConfig,
} from "./whatsapp-location";

describe("whatsapp location normalization", () => {
  it("normalizes a scenario location config into a Meta location payload", () => {
    const normalized = normalizeWhatsAppLocationConfig({
      latitude: " 43,238949 ",
      longitude: " 76.889709 ",
      name: " EduDemo Campus ",
      address: "  Almaty  ",
    });

    expect(normalized).toEqual({
      version: 1,
      latitude: 43.238949,
      longitude: 76.889709,
      name: "EduDemo Campus",
      address: "Almaty",
    });

    expect(buildWhatsAppLocationMessagePayload(normalized)).toEqual({
      latitude: 43.238949,
      longitude: 76.889709,
      name: "EduDemo Campus",
      address: "Almaty",
    });
  });

  it("rejects drafts without valid coordinates", () => {
    expect(
      normalizeWhatsAppLocationConfig({
        latitude: 120,
        longitude: 76.889709,
      })
    ).toBeUndefined();
    expect(
      buildWhatsAppLocationMessagePayload({
        latitude: 43.238949,
      })
    ).toBe(null);
  });
});

import { WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH } from "@icecore/scenario-contracts";
import {
  normalizeWhatsAppQrDisplayPhoneNumber,
  normalizeWhatsAppQrImportUrl,
} from "./import-link";

describe("WhatsApp QR import URL normalization", () => {
  it("normalizes a canonical Meta provider link as an adoption intent", () => {
    expect(
      normalizeWhatsAppQrImportUrl({
        url: "https://wa.me/message/QRVALID123",
        displayPhoneNumber: "+1 (555) 123-4567",
      })
    ).toEqual({
      kind: "provider",
      providerCode: "QRVALID123",
      deepLink: "https://wa.me/message/QRVALID123",
    });
  });

  it("normalizes a direct source link as managed-create input", () => {
    expect(
      normalizeWhatsAppQrImportUrl({
        url: "https://wa.me/15551234567?text=Hello+world%0Aline+2",
        displayPhoneNumber: "+1 (555) 123-4567",
      })
    ).toEqual({
      kind: "direct",
      displayPhoneNumber: "15551234567",
      desiredMessage: "Hello world\nline 2",
    });
  });

  it.each([
    ["+1 (555) 123-4567", "15551234567"],
    ["7 777 123 45 67", "77771234567"],
    ["+44-20-7946-0958", "442079460958"],
  ])("normalizes configured phone %s", (value, expected) => {
    expect(normalizeWhatsAppQrDisplayPhoneNumber(value)).toBe(expected);
  });

  it.each([
    ["blank", ""],
    ["letters", "+1-555-CALL-NOW"],
    ["too many digits", "+1234567890123456"],
    ["leading zero", "0123456789"],
  ])("rejects a configured phone with %s", (_label, value) => {
    expect(() => normalizeWhatsAppQrDisplayPhoneNumber(value)).toThrow(
      "Invalid WhatsApp source phone number"
    );
  });

  it.each([
    ["insecure scheme", "http://wa.me/message/QRVALID123"],
    ["protocol relative", "//wa.me/message/QRVALID123"],
    ["lookalike host", "https://wa.me.evil.test/message/QRVALID123"],
    ["internationalized lookalike", "https://wа.me/message/QRVALID123"],
    ["credentials", "https://user@wa.me/message/QRVALID123"],
    ["port", "https://wa.me:443/message/QRVALID123"],
    ["fragment", "https://wa.me/message/QRVALID123#fragment"],
    ["query", "https://wa.me/message/QRVALID123?x=1"],
    ["blank code", "https://wa.me/message/"],
    ["encoded separator", "https://wa.me/message/QRVALID%2F123"],
    ["extra path", "https://wa.me/message/QRVALID123/extra"],
  ])("rejects provider link with %s", (_label, url) => {
    expect(() =>
      normalizeWhatsAppQrImportUrl({
        url,
        displayPhoneNumber: "+1 (555) 123-4567",
      })
    ).toThrow("Unsupported WhatsApp QR link");
  });

  it.each([
    ["wrong phone", "https://wa.me/15550000000?text=Hello"],
    ["leading-zero phone", "https://wa.me/05551234567?text=Hello"],
    ["missing text", "https://wa.me/15551234567"],
    ["blank text", "https://wa.me/15551234567?text="],
    ["duplicate text", "https://wa.me/15551234567?text=Hello&text=Again"],
    ["extra parameter", "https://wa.me/15551234567?text=Hello&x=1"],
    ["fragment", "https://wa.me/15551234567?text=Hello#fragment"],
    ["encoded path separator", "https://wa.me/1555%2F1234567?text=Hello"],
    [
      "overlong decoded text",
      `https://wa.me/15551234567?text=${encodeURIComponent(
        "x".repeat(WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH + 1)
      )}`,
    ],
  ])("rejects direct link with %s", (_label, url) => {
    expect(() =>
      normalizeWhatsAppQrImportUrl({
        url,
        displayPhoneNumber: "+1 (555) 123-4567",
      })
    ).toThrow("Unsupported WhatsApp QR link");
  });
});

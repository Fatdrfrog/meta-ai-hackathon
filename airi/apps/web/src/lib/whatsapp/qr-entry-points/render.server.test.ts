import { inspectWhatsAppQrImage } from "./image-inspection.server";
import { renderWhatsAppQrPng, renderWhatsAppQrSvg } from "./render.server";

const DEEP_LINK = "https://wa.me/message/QRVALID123";

describe("WhatsApp QR rendering", () => {
  it("renders a PNG that re-decodes to the persisted deep link", async () => {
    const png = await renderWhatsAppQrPng(DEEP_LINK, {
      size: 512,
      margin: 4,
      errorCorrectionLevel: "M",
    });

    await expect(
      inspectWhatsAppQrImage({
        bytes: png,
        mimeType: "image/png",
        displayPhoneNumber: "+1 (555) 123-4567",
      })
    ).resolves.toMatchObject({
      intent: {
        kind: "provider",
        providerCode: "QRVALID123",
        deepLink: DEEP_LINK,
      },
      image: { format: "png", width: 512, height: 512 },
    });
  }, 15_000);

  it("renders print-ready SVG with the requested bounded geometry", async () => {
    const svg = await renderWhatsAppQrSvg(DEEP_LINK, {
      size: 1024,
      margin: 8,
      errorCorrectionLevel: "H",
    });

    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain('width="1024"');
    expect(svg).toContain('height="1024"');
    expect(svg).not.toContain(DEEP_LINK);
  });

  it.each([
    ["size below minimum", { size: 127 }],
    ["size above maximum", { size: 4097 }],
    ["fractional size", { size: 512.5 }],
    ["negative margin", { margin: -1 }],
    ["margin above maximum", { margin: 17 }],
    ["fractional margin", { margin: 1.5 }],
    ["invalid error correction", { errorCorrectionLevel: "Z" }],
  ])("rejects %s before rendering", async (_label, options) => {
    await expect(
      renderWhatsAppQrPng(DEEP_LINK, options as never)
    ).rejects.toThrow("Invalid WhatsApp QR render options");
  });

  it("rejects a noncanonical deep link before rendering", async () => {
    await expect(
      renderWhatsAppQrSvg("https://evil.test/message/QRVALID123")
    ).rejects.toThrow("Unsupported WhatsApp QR link");
  });
});

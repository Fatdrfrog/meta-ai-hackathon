import { readFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

import {
  inspectWhatsAppQrImage,
  WhatsAppQrImageInspectionError,
  type WhatsAppQrImageDecoder,
} from "./image-inspection.server";
import { readQrFixture, VALID_QR_FIXTURES } from "./test-fixtures";

const DEEP_LINK = "https://wa.me/message/QRVALID123";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function rewritePngDimensions(
  source: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const result = Buffer.from(source);
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  result.writeUInt32BE(crc32(result.subarray(12, 29)), 29);
  return result;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  result.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(
    crc32(result.subarray(4, 8 + data.byteLength)),
    8 + data.byteLength
  );
  return result;
}

function asApng(source: Uint8Array): Uint8Array {
  const bytes = Buffer.from(source);
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      const animation = Buffer.alloc(8);
      animation.writeUInt32BE(1, 0);
      animation.writeUInt32BE(0, 4);
      return Buffer.concat([
        bytes.subarray(0, offset),
        pngChunk("acTL", animation),
        bytes.subarray(offset),
      ]);
    }
    offset += 12 + length;
  }
  throw new Error("Fixture has no IDAT");
}

function animatedWebp(): Uint8Array {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02;
  vp8x[4] = 63;
  vp8x[7] = 63;
  const vp8xChunk = Buffer.concat([
    Buffer.from("VP8X"),
    Buffer.from([10, 0, 0, 0]),
    vp8x,
  ]);
  const animChunk = Buffer.concat([
    Buffer.from("ANIM"),
    Buffer.from([6, 0, 0, 0]),
    Buffer.alloc(6),
  ]);
  const body = Buffer.concat([Buffer.from("WEBP"), vp8xChunk, animChunk]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function pngFixture() {
  return readQrFixture(VALID_QR_FIXTURES[0]);
}

function decoderWith(
  results: Array<{ text: string; format?: string; symbology?: string }>
) {
  return jest.fn<
    ReturnType<WhatsAppQrImageDecoder>,
    Parameters<WhatsAppQrImageDecoder>
  >(async () =>
    results.map(result => ({
      text: result.text,
      format: result.format ?? "QRCode",
      symbology: result.symbology ?? "QRCode",
    }))
  );
}

async function compositeQrFixture(format: "png" | "jpeg") {
  const source = Buffer.from(pngFixture());
  const image = sharp({
    create: {
      width: 384,
      height: 192,
      channels: 4,
      background: "white",
    },
  }).composite([
    { input: source, left: 0, top: 0 },
    { input: source, left: 192, top: 0 },
  ]);
  return format === "png"
    ? image.png().toBuffer()
    : image.jpeg({ quality: 95 }).toBuffer();
}

describe("WhatsApp QR image inspection", () => {
  it.each(VALID_QR_FIXTURES)(
    "validates and decodes a real static $format QR fixture with the real reader",
    async fixture => {
      await expect(
        inspectWhatsAppQrImage({
          bytes: readQrFixture(fixture),
          mimeType: fixture.mimeType,
          displayPhoneNumber: "+1 (555) 123-4567",
        })
      ).resolves.toEqual({
        intent: {
          kind: "provider",
          providerCode: "QRVALID123",
          deepLink: DEEP_LINK,
        },
        image: {
          format: fixture.format,
          mimeType: fixture.mimeType,
          width: 192,
          height: 192,
          sizeBytes: Buffer.from(fixture.base64, "base64").byteLength,
        },
      });
    }
  );

  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
  ] as const)(
    "rejects a real hostile composite $format containing two readable QR symbols",
    async (format, mimeType) => {
      await expect(
        inspectWhatsAppQrImage({
          bytes: await compositeQrFixture(format),
          mimeType,
          displayPhoneNumber: "+1 (555) 123-4567",
        })
      ).rejects.toMatchObject({
        name: "WhatsAppQrImageInspectionError",
        code: "QR_SYMBOL_COUNT",
      });
    }
  );

  it("uses QR-only decoding with a result limit that detects multiple symbols", async () => {
    const decode = decoderWith([{ text: DEEP_LINK }]);

    await inspectWhatsAppQrImage({
      bytes: pngFixture(),
      mimeType: "image/png",
      displayPhoneNumber: "+1 (555) 123-4567",
      decode,
    });

    expect(decode).toHaveBeenCalledWith(pngFixture(), {
      formats: ["QRCode"],
      maxNumberOfSymbols: 2,
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
    });
  });

  it.each([
    ["zero", []],
    [
      "multiple",
      [{ text: DEEP_LINK }, { text: "https://wa.me/message/OTHER" }],
    ],
  ])("rejects $label decoded QR results", async (_label, results) => {
    await expect(
      inspectWhatsAppQrImage({
        bytes: pngFixture(),
        mimeType: "image/png",
        displayPhoneNumber: "+1 (555) 123-4567",
        decode: decoderWith(results),
      })
    ).rejects.toMatchObject({
      name: "WhatsAppQrImageInspectionError",
      code: "QR_SYMBOL_COUNT",
    });
  });

  it("accepts a provider QR even when the configured display phone is invalid", async () => {
    await expect(
      inspectWhatsAppQrImage({
        bytes: pngFixture(),
        mimeType: "image/png",
        displayPhoneNumber: "not-a-phone",
        decode: decoderWith([{ text: DEEP_LINK }]),
      })
    ).resolves.toMatchObject({
      intent: {
        kind: "provider",
        providerCode: "QRVALID123",
        deepLink: DEEP_LINK,
      },
    });
  });

  it("maps an unsupported decoded URL to a bounded inspection error", async () => {
    await expect(
      inspectWhatsAppQrImage({
        bytes: pngFixture(),
        mimeType: "image/png",
        displayPhoneNumber: "+1 (555) 123-4567",
        decode: decoderWith([{ text: "https://evil.test/redirect" }]),
      })
    ).rejects.toMatchObject({
      name: "WhatsAppQrImageInspectionError",
      code: "QR_DECODE_FAILED",
      message: "WhatsApp QR image inspection failed",
    });
  });

  it.each([
    ["non-QR symbology", { format: "QRCode", symbology: "Code128" }],
    ["incompatible format", { format: "Code128", symbology: "QRCode" }],
  ])("rejects one decoded result with $label", async (_label, metadata) => {
    await expect(
      inspectWhatsAppQrImage({
        bytes: pngFixture(),
        mimeType: "image/png",
        displayPhoneNumber: "+1 (555) 123-4567",
        decode: decoderWith([{ text: DEEP_LINK, ...metadata }]),
      })
    ).rejects.toMatchObject({
      name: "WhatsAppQrImageInspectionError",
      code: "QR_DECODE_FAILED",
    });
  });

  it("rejects an upload above five MiB before decoding", async () => {
    const decode = decoderWith([{ text: DEEP_LINK }]);
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    bytes.set(pngFixture().subarray(0, 8));

    await expect(
      inspectWhatsAppQrImage({
        bytes,
        mimeType: "image/png",
        displayPhoneNumber: "+1 (555) 123-4567",
        decode,
      })
    ).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects declared MIME that disagrees with the actual signature", async () => {
    const decode = decoderWith([{ text: DEEP_LINK }]);

    await expect(
      inspectWhatsAppQrImage({
        bytes: pngFixture(),
        mimeType: "image/jpeg",
        displayPhoneNumber: "+1 (555) 123-4567",
        decode,
      })
    ).rejects.toMatchObject({ code: "MIME_MISMATCH" });
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(VALID_QR_FIXTURES)(
    "rejects a truncated $format file before decoding",
    async fixture => {
      const decode = decoderWith([{ text: DEEP_LINK }]);
      await expect(
        inspectWhatsAppQrImage({
          bytes: readQrFixture(fixture).subarray(0, 24),
          mimeType: fixture.mimeType,
          displayPhoneNumber: "+1 (555) 123-4567",
          decode,
        })
      ).rejects.toMatchObject({ code: "CORRUPT_IMAGE" });
      expect(decode).not.toHaveBeenCalled();
    }
  );

  it("rejects corrupt PNG chunk checksums before decoding", async () => {
    const bytes = Buffer.from(pngFixture());
    bytes[bytes.length - 1] ^= 0xff;
    const decode = decoderWith([{ text: DEEP_LINK }]);

    await expect(
      inspectWhatsAppQrImage({
        bytes,
        mimeType: "image/png",
        displayPhoneNumber: "+1 (555) 123-4567",
        decode,
      })
    ).rejects.toMatchObject({ code: "CORRUPT_IMAGE" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a raster side above 4096 pixels before decoding", async () => {
    const decode = decoderWith([{ text: DEEP_LINK }]);

    await expect(
      inspectWhatsAppQrImage({
        bytes: rewritePngDimensions(pngFixture(), 4097, 1),
        mimeType: "image/png",
        displayPhoneNumber: "+1 (555) 123-4567",
        decode,
      })
    ).rejects.toMatchObject({ code: "IMAGE_DIMENSIONS" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects APNG before decoding", async () => {
    const decode = decoderWith([{ text: DEEP_LINK }]);

    await expect(
      inspectWhatsAppQrImage({
        bytes: asApng(pngFixture()),
        mimeType: "image/png",
        displayPhoneNumber: "+1 (555) 123-4567",
        decode,
      })
    ).rejects.toMatchObject({ code: "ANIMATED_IMAGE" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects animated WebP before decoding", async () => {
    const decode = decoderWith([{ text: DEEP_LINK }]);

    await expect(
      inspectWhatsAppQrImage({
        bytes: animatedWebp(),
        mimeType: "image/webp",
        displayPhoneNumber: "+1 (555) 123-4567",
        decode,
      })
    ).rejects.toMatchObject({ code: "ANIMATED_IMAGE" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("exposes only a bounded error code and generic message", () => {
    const error = new WhatsAppQrImageInspectionError("CORRUPT_IMAGE");
    expect(error).toEqual(
      expect.objectContaining({
        code: "CORRUPT_IMAGE",
        message: "WhatsApp QR image inspection failed",
      })
    );
  });

  it("decodes WebP through the direct sharp dependency, not Next private APIs", () => {
    const source = readFileSync(
      join(__dirname, "image-inspection.server.ts"),
      "utf8"
    );
    expect(source).toContain('await import("sharp")');
    expect(source).not.toContain("next/dist/server/image-optimizer");
  });
});

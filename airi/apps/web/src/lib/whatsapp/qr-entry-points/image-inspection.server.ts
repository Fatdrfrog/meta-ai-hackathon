import "server-only";

import {
  normalizeWhatsAppQrImportUrl,
  type WhatsAppQrImportIntent,
} from "./import-link";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 4_096;
const MAX_IMAGE_PIXELS = 16_777_216;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export type WhatsAppQrImageFormat = "png" | "jpeg" | "webp";
export type WhatsAppQrImageDecoderOptions = {
  formats: ["QRCode"];
  maxNumberOfSymbols: 2;
  tryHarder: true;
  tryRotate: true;
  tryInvert: true;
};
export type WhatsAppQrDecodedSymbol = {
  text: string;
  format: string;
  symbology: string;
};
export type WhatsAppQrImageDecoder = (
  bytes: Uint8Array,
  options: WhatsAppQrImageDecoderOptions
) => Promise<WhatsAppQrDecodedSymbol[]>;

export type WhatsAppQrImageInspection = {
  intent: WhatsAppQrImportIntent;
  image: {
    format: WhatsAppQrImageFormat;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
    sizeBytes: number;
  };
};

export type WhatsAppQrImageInspectionErrorCode =
  | "EMPTY_IMAGE"
  | "IMAGE_TOO_LARGE"
  | "UNSUPPORTED_IMAGE"
  | "MIME_MISMATCH"
  | "CORRUPT_IMAGE"
  | "ANIMATED_IMAGE"
  | "IMAGE_DIMENSIONS"
  | "QR_DECODE_FAILED"
  | "QR_SYMBOL_COUNT";

export class WhatsAppQrImageInspectionError extends Error {
  readonly code: WhatsAppQrImageInspectionErrorCode;

  constructor(code: WhatsAppQrImageInspectionErrorCode) {
    super("WhatsApp QR image inspection failed");
    this.name = "WhatsAppQrImageInspectionError";
    this.code = code;
  }
}

type RasterMetadata = {
  format: WhatsAppQrImageFormat;
  mimeType: WhatsAppQrImageInspection["image"]["mimeType"];
  width: number;
  height: number;
};

function fail(code: WhatsAppQrImageInspectionErrorCode): never {
  throw new WhatsAppQrImageInspectionError(code);
}

function matches(bytes: Uint8Array, offset: number, values: readonly number[]) {
  return values.every((value, index) => bytes[offset + index] === value);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  );
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x10000
  );
}

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

function parsePng(bytes: Uint8Array): RasterMetadata {
  if (bytes.length < 33 || !matches(bytes, 0, PNG_SIGNATURE)) {
    fail("CORRUPT_IMAGE");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) fail("CORRUPT_IMAGE");
    const length = readUint32Be(bytes, offset);
    if (length > bytes.length - offset - 12) fail("CORRUPT_IMAGE");
    const type = readAscii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) fail("CORRUPT_IMAGE");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (
      crc32(bytes.subarray(offset + 4, dataEnd)) !==
      readUint32Be(bytes, dataEnd)
    ) {
      fail("CORRUPT_IMAGE");
    }
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) fail("CORRUPT_IMAGE");
      sawHeader = true;
      width = readUint32Be(bytes, dataStart);
      height = readUint32Be(bytes, dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      const validDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth));
      if (
        !validDepth ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        (bytes[dataStart + 12] !== 0 && bytes[dataStart + 12] !== 1)
      ) {
        fail("CORRUPT_IMAGE");
      }
    } else if (type === "IHDR") {
      fail("CORRUPT_IMAGE");
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      fail("ANIMATED_IMAGE");
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || dataEnd + 4 !== bytes.length) {
        fail("CORRUPT_IMAGE");
      }
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawHeader || !sawEnd) fail("CORRUPT_IMAGE");
  return { format: "png", mimeType: "image/png", width, height };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseJpeg(bytes: Uint8Array): RasterMetadata {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    fail("CORRUPT_IMAGE");
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;
  let inScan = false;
  while (offset < bytes.length) {
    if (inScan) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset >= bytes.length) fail("CORRUPT_IMAGE");
    } else if (bytes[offset] !== 0xff) {
      fail("CORRUPT_IMAGE");
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail("CORRUPT_IMAGE");
    const marker = bytes[offset++]!;
    if (inScan && marker === 0x00) continue;
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (!inScan) fail("CORRUPT_IMAGE");
      continue;
    }
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== bytes.length) {
        fail("CORRUPT_IMAGE");
      }
      return { format: "jpeg", mimeType: "image/jpeg", width, height };
    }
    inScan = false;
    if (marker === 0xd8 || marker === 0x01) fail("CORRUPT_IMAGE");
    if (bytes.length - offset < 2) fail("CORRUPT_IMAGE");
    const segmentLength = bytes[offset]! * 0x100 + bytes[offset + 1]!;
    if (segmentLength < 2 || segmentLength > bytes.length - offset) {
      fail("CORRUPT_IMAGE");
    }
    const segmentEnd = offset + segmentLength;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8 || sawFrame) fail("CORRUPT_IMAGE");
      height = bytes[offset + 3]! * 0x100 + bytes[offset + 4]!;
      width = bytes[offset + 5]! * 0x100 + bytes[offset + 6]!;
      sawFrame = true;
    }
    if (marker === 0xda) {
      if (segmentLength < 6 || !sawFrame) fail("CORRUPT_IMAGE");
      sawScan = true;
      inScan = true;
    }
    offset = segmentEnd;
  }
  fail("CORRUPT_IMAGE");
}

function parseWebp(bytes: Uint8Array): RasterMetadata {
  if (
    bytes.length < 20 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 4) !== "WEBP" ||
    readUint32Le(bytes, 4) + 8 !== bytes.length
  ) {
    fail("CORRUPT_IMAGE");
  }
  let offset = 12;
  let canvasWidth: number | undefined;
  let canvasHeight: number | undefined;
  let imageWidth: number | undefined;
  let imageHeight: number | undefined;
  let sawImage = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) fail("CORRUPT_IMAGE");
    const type = readAscii(bytes, offset, 4);
    const length = readUint32Le(bytes, offset + 4);
    const dataStart = offset + 8;
    const paddedLength = length + (length & 1);
    if (paddedLength > bytes.length - dataStart) fail("CORRUPT_IMAGE");
    if (type === "ANIM" || type === "ANMF") fail("ANIMATED_IMAGE");
    if (type === "VP8X") {
      if (length !== 10 || canvasWidth !== undefined) fail("CORRUPT_IMAGE");
      if ((bytes[dataStart]! & 0x02) !== 0) fail("ANIMATED_IMAGE");
      canvasWidth = readUint24Le(bytes, dataStart + 4) + 1;
      canvasHeight = readUint24Le(bytes, dataStart + 7) + 1;
    } else if (type === "VP8 ") {
      if (
        sawImage ||
        length < 10 ||
        (bytes[dataStart]! & 1) !== 0 ||
        !matches(bytes, dataStart + 3, [0x9d, 0x01, 0x2a])
      ) {
        fail("CORRUPT_IMAGE");
      }
      imageWidth =
        (bytes[dataStart + 6]! + bytes[dataStart + 7]! * 0x100) & 0x3fff;
      imageHeight =
        (bytes[dataStart + 8]! + bytes[dataStart + 9]! * 0x100) & 0x3fff;
      sawImage = true;
    } else if (type === "VP8L") {
      if (sawImage || length < 5 || bytes[dataStart] !== 0x2f) {
        fail("CORRUPT_IMAGE");
      }
      const bits = readUint32Le(bytes, dataStart + 1) >>> 0;
      if (bits >>> 29) fail("CORRUPT_IMAGE");
      imageWidth = (bits & 0x3fff) + 1;
      imageHeight = ((bits >>> 14) & 0x3fff) + 1;
      sawImage = true;
    }
    offset = dataStart + paddedLength;
  }
  if (!sawImage || offset !== bytes.length || !imageWidth || !imageHeight) {
    fail("CORRUPT_IMAGE");
  }
  if (
    (canvasWidth !== undefined && canvasWidth !== imageWidth) ||
    (canvasHeight !== undefined && canvasHeight !== imageHeight)
  ) {
    fail("CORRUPT_IMAGE");
  }
  return {
    format: "webp",
    mimeType: "image/webp",
    width: imageWidth,
    height: imageHeight,
  };
}

function inspectRaster(bytes: Uint8Array): RasterMetadata {
  if (matches(bytes, 0, PNG_SIGNATURE)) return parsePng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return parseJpeg(bytes);
  if (
    bytes.length >= 12 &&
    readAscii(bytes, 0, 4) === "RIFF" &&
    readAscii(bytes, 8, 4) === "WEBP"
  ) {
    return parseWebp(bytes);
  }
  fail("UNSUPPORTED_IMAGE");
}

function validateDimensions(metadata: RasterMetadata): void {
  if (
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width > MAX_IMAGE_SIDE ||
    metadata.height > MAX_IMAGE_SIDE ||
    metadata.width * metadata.height > MAX_IMAGE_PIXELS
  ) {
    fail("IMAGE_DIMENSIONS");
  }
}

const READER_OPTIONS: WhatsAppQrImageDecoderOptions = {
  formats: ["QRCode"],
  maxNumberOfSymbols: 2,
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
};

async function decodeWithZxing(
  input: Uint8Array | ImageData,
  options: WhatsAppQrImageDecoderOptions
): Promise<WhatsAppQrDecodedSymbol[]> {
  const { readBarcodes } = await import("zxing-wasm/reader");
  const results = await readBarcodes(input, options);
  return results.map(result => ({
    text: result.text,
    format: result.format,
    symbology: result.symbology,
  }));
}

async function defaultDecode(
  bytes: Uint8Array,
  options: WhatsAppQrImageDecoderOptions,
  metadata: RasterMetadata
): Promise<WhatsAppQrDecodedSymbol[]> {
  if (metadata.format !== "webp") {
    return decodeWithZxing(bytes, options);
  }
  const sharp = (await import("sharp")).default;
  const decoded = await sharp(Buffer.from(bytes), {
    animated: false,
    failOn: "warning",
    limitInputPixels: MAX_IMAGE_PIXELS,
    sequentialRead: true,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width !== metadata.width ||
    decoded.info.height !== metadata.height ||
    decoded.info.channels !== 4
  ) {
    fail("CORRUPT_IMAGE");
  }
  return decodeWithZxing(
    {
      data: new Uint8ClampedArray(
        decoded.data.buffer,
        decoded.data.byteOffset,
        decoded.data.byteLength
      ),
      width: decoded.info.width,
      height: decoded.info.height,
      colorSpace: "srgb",
    } as ImageData,
    options
  );
}

export async function inspectWhatsAppQrImage(params: {
  bytes: Uint8Array;
  mimeType: string;
  displayPhoneNumber: string;
  decode?: WhatsAppQrImageDecoder;
}): Promise<WhatsAppQrImageInspection> {
  if (!(params.bytes instanceof Uint8Array) || params.bytes.byteLength === 0) {
    fail("EMPTY_IMAGE");
  }
  if (params.bytes.byteLength > MAX_IMAGE_BYTES) fail("IMAGE_TOO_LARGE");
  const metadata = inspectRaster(params.bytes);
  const mimeType = params.mimeType.trim().toLowerCase();
  if (mimeType !== metadata.mimeType) fail("MIME_MISMATCH");
  validateDimensions(metadata);

  let results: Awaited<ReturnType<WhatsAppQrImageDecoder>>;
  try {
    results = params.decode
      ? await params.decode(params.bytes, READER_OPTIONS)
      : await defaultDecode(params.bytes, READER_OPTIONS, metadata);
  } catch {
    fail("QR_DECODE_FAILED");
  }
  if (!Array.isArray(results) || results.length !== 1) {
    fail("QR_SYMBOL_COUNT");
  }
  const result: unknown = results[0];
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    fail("QR_DECODE_FAILED");
  }
  const symbol = result as Record<string, unknown>;
  if (
    typeof symbol.text !== "string" ||
    symbol.format !== "QRCode" ||
    symbol.symbology !== "QRCode"
  ) {
    fail("QR_DECODE_FAILED");
  }
  const payload = symbol.text;
  let intent: WhatsAppQrImageInspection["intent"];
  try {
    intent = normalizeWhatsAppQrImportUrl({
      url: payload,
      displayPhoneNumber: params.displayPhoneNumber,
    });
  } catch {
    fail("QR_DECODE_FAILED");
  }
  return {
    intent,
    image: {
      ...metadata,
      sizeBytes: params.bytes.byteLength,
    },
  };
}

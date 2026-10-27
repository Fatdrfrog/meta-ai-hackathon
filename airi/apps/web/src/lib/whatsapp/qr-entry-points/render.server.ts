import "server-only";

import QRCodeLib from "qrcode";
import { normalizeWhatsAppQrProviderLink } from "./import-link";

const MIN_QR_SIZE = 128;
const MAX_QR_SIZE = 4_096;
const MAX_QR_MARGIN = 16;
const ERROR_CORRECTION_LEVELS = new Set(["L", "M", "Q", "H"]);

export type WhatsAppQrRenderOptions = {
  size?: number;
  margin?: number;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
};

function normalizeOptions(options: WhatsAppQrRenderOptions = {}): {
  size: number;
  margin: number;
  errorCorrectionLevel: "L" | "M" | "Q" | "H";
} {
  const size = options.size ?? 1024;
  const margin = options.margin ?? 4;
  const errorCorrectionLevel = options.errorCorrectionLevel ?? "M";
  if (
    !Number.isSafeInteger(size) ||
    size < MIN_QR_SIZE ||
    size > MAX_QR_SIZE ||
    !Number.isSafeInteger(margin) ||
    margin < 0 ||
    margin > MAX_QR_MARGIN ||
    !ERROR_CORRECTION_LEVELS.has(errorCorrectionLevel)
  ) {
    throw new RangeError("Invalid WhatsApp QR render options");
  }
  return { size, margin, errorCorrectionLevel };
}

function normalizeDeepLink(value: string): string {
  return normalizeWhatsAppQrProviderLink(value).deepLink;
}

export async function renderWhatsAppQrPng(
  deepLink: string,
  options?: WhatsAppQrRenderOptions
): Promise<Buffer> {
  const normalized = normalizeOptions(options);
  return QRCodeLib.toBuffer(normalizeDeepLink(deepLink), {
    type: "png",
    width: normalized.size,
    margin: normalized.margin,
    errorCorrectionLevel: normalized.errorCorrectionLevel,
  });
}

export async function renderWhatsAppQrSvg(
  deepLink: string,
  options?: WhatsAppQrRenderOptions
): Promise<string> {
  const normalized = normalizeOptions(options);
  return QRCodeLib.toString(normalizeDeepLink(deepLink), {
    type: "svg",
    width: normalized.size,
    margin: normalized.margin,
    errorCorrectionLevel: normalized.errorCorrectionLevel,
  });
}

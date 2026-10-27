import crypto from "node:crypto";

import { encryptString, type EncryptedString } from "@/lib/crypto";

export function createHalykSecretHash(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

export function verifyHalykSecretHash(
  secret: string | null | undefined,
  expectedDigest: string | null | undefined
): boolean {
  if (!secret || !expectedDigest) return false;

  const actual = Buffer.from(createHalykSecretHash(secret), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  if (actual.length !== expected.length) return false;

  return crypto.timingSafeEqual(actual, expected);
}

export function hashHalykCardId(params: {
  cardId: string;
  terminalId: string;
}): {
  encryptedCardId: EncryptedString;
  cardFingerprint: string;
} {
  const normalizedCardId = params.cardId.trim();
  const normalizedTerminalId = params.terminalId.trim();

  if (!normalizedCardId) {
    throw new Error("Halyk cardId is required");
  }
  if (!normalizedTerminalId) {
    throw new Error("Halyk terminalId is required");
  }

  return {
    encryptedCardId: encryptString(normalizedCardId),
    cardFingerprint: crypto
      .createHash("sha256")
      .update(`halyk:${normalizedTerminalId}:${normalizedCardId}`, "utf8")
      .digest("hex"),
  };
}

export function createHalykEventKey(params: {
  invoiceId: string;
  providerEventId?: string | null;
  reference?: string | null;
  code?: string | number | null;
  reasonCode?: string | number | null;
}): string {
  const stableParts = [
    params.providerEventId,
    params.reference,
    params.invoiceId,
    params.code,
    params.reasonCode,
  ]
    .map(part => String(part ?? "").trim())
    .filter(Boolean);

  return crypto
    .createHash("sha256")
    .update(stableParts.join("|"), "utf8")
    .digest("hex");
}

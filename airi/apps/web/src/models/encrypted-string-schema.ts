import { Schema } from "mongoose";

import type { EncryptedString } from "@/lib/crypto";

export const MAX_ENCRYPTED_STRING_CIPHERTEXT_BYTES = 16_384;

const MAX_ENCRYPTED_STRING_CIPHERTEXT_BASE64_LENGTH =
  Math.ceil(MAX_ENCRYPTED_STRING_CIPHERTEXT_BYTES / 3) * 4;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeCanonicalBase64(value: unknown): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !CANONICAL_BASE64_PATTERN.test(value)
  ) {
    return null;
  }

  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function isCanonicalBase64WithDecodedLength(
  value: unknown,
  expectedLength: number
): boolean {
  return decodeCanonicalBase64(value)?.length === expectedLength;
}

function isBoundedCiphertext(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.length > MAX_ENCRYPTED_STRING_CIPHERTEXT_BASE64_LENGTH
  ) {
    return false;
  }

  const decoded = decodeCanonicalBase64(value);
  return (
    decoded !== null &&
    decoded.length > 0 &&
    decoded.length <= MAX_ENCRYPTED_STRING_CIPHERTEXT_BYTES
  );
}

export const EncryptedStringSchema = new Schema<EncryptedString>(
  {
    iv: {
      type: String,
      required: true,
      validate: {
        validator: (value: unknown) =>
          isCanonicalBase64WithDecodedLength(value, 12),
        message: "Encrypted string IV must be canonical base64 for 12 bytes",
      },
    },
    tag: {
      type: String,
      required: true,
      validate: {
        validator: (value: unknown) =>
          isCanonicalBase64WithDecodedLength(value, 16),
        message: "Encrypted string tag must be canonical base64 for 16 bytes",
      },
    },
    ciphertext: {
      type: String,
      required: true,
      maxlength: MAX_ENCRYPTED_STRING_CIPHERTEXT_BASE64_LENGTH,
      validate: {
        validator: isBoundedCiphertext,
        message:
          "Encrypted string ciphertext must be non-empty bounded canonical base64",
      },
    },
  },
  {
    _id: false,
    id: false,
    strict: "throw",
    versionKey: false,
  }
);

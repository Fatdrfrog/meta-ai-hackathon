import crypto from "crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommended 12 bytes

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("Missing ENCRYPTION_SECRET");
  return crypto.createHash("sha256").update(secret).digest();
}

export type EncryptedString = { iv: string; tag: string; ciphertext: string };

function isEncryptedPayload(value: unknown): value is EncryptedString {
  return Boolean(
    value &&
      typeof value === "object" &&
      "iv" in value &&
      "tag" in value &&
      "ciphertext" in value
  );
}

export function encryptString(plaintext: string): EncryptedString {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: enc.toString("base64"),
  };
}

export function decryptString(payload: EncryptedString): string {
  const key = getKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const data = Buffer.from(payload.ciphertext, "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

export function decryptMaybeString(input: unknown): string {
  try {
    if (typeof input === "string") {
      const trimmed = input.trim();
      if (!trimmed) return "";

      // Legacy rows may store encrypted payload as a JSON string.
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
      ) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (isEncryptedPayload(parsed)) {
            return decryptString(parsed);
          }
        } catch {}
      }

      return trimmed;
    }

    if (isEncryptedPayload(input)) {
      return decryptString(input);
    }
  } catch {}
  return "";
}

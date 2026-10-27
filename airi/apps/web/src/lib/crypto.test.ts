import { decryptString, encryptString } from "@/lib/crypto";

const TEST_SECRET = "task-7-encryption-test-secret";

function tamperBase64(value: string): string {
  const bytes = Buffer.from(value, "base64");
  bytes[0] = bytes[0]! ^ 0xff;
  return bytes.toString("base64");
}

describe("strict encrypted strings", () => {
  const originalSecret = process.env.ENCRYPTION_SECRET;

  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.ENCRYPTION_SECRET;
    } else {
      process.env.ENCRYPTION_SECRET = originalSecret;
    }
  });

  it("round-trips canonical AES-256-GCM envelopes without plaintext", () => {
    const plaintext = "managed WhatsApp Flow signing material";
    const encrypted = encryptString(plaintext);

    expect(decryptString(encrypted)).toBe(plaintext);
    expect(Buffer.from(encrypted.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(encrypted.tag, "base64")).toHaveLength(16);
    for (const value of [encrypted.iv, encrypted.tag, encrypted.ciphertext]) {
      expect(Buffer.from(value, "base64").toString("base64")).toBe(value);
    }
    expect(JSON.stringify(encrypted)).not.toContain(plaintext);
  });

  it("fails closed for a wrong secret or tampered ciphertext, IV, and tag", () => {
    const encrypted = encryptString("managed endpoint private material");

    process.env.ENCRYPTION_SECRET = "wrong-secret";
    expect(() => decryptString(encrypted)).toThrow();
    process.env.ENCRYPTION_SECRET = TEST_SECRET;

    for (const field of ["ciphertext", "iv", "tag"] as const) {
      expect(() =>
        decryptString({
          ...encrypted,
          [field]: tamperBase64(encrypted[field]),
        })
      ).toThrow();
    }
  });
});

import {
  createHalykSecretHash,
  hashHalykCardId,
  verifyHalykSecretHash,
} from "./halyk-security";
import { decryptString } from "@/lib/crypto";

describe("Halyk billing security helpers", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = "test-secret";
  });

  it("verifies postLink secret hashes without storing the raw secret", () => {
    const secret = "provider-returned-secret";
    const digest = createHalykSecretHash(secret);

    expect(digest).not.toBe(secret);
    expect(verifyHalykSecretHash(secret, digest)).toBe(true);
    expect(verifyHalykSecretHash("wrong", digest)).toBe(false);
  });

  it("encrypts card ids and creates a stable dedupe fingerprint", () => {
    const encrypted = hashHalykCardId({
      cardId: "card-token-1",
      terminalId: "terminal-id",
    });

    expect(encrypted.encryptedCardId).toEqual({
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    });
    expect(decryptString(encrypted.encryptedCardId)).toBe("card-token-1");
    expect(encrypted.cardFingerprint).toBe(
      hashHalykCardId({
        cardId: "card-token-1",
        terminalId: "terminal-id",
      }).cardFingerprint
    );
    expect(encrypted.cardFingerprint).not.toBe(
      hashHalykCardId({
        cardId: "card-token-1",
        terminalId: "other-terminal",
      }).cardFingerprint
    );
  });
});

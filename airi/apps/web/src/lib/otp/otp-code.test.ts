import {
  generateOtpCode,
  hashOtpCode,
  isOtpHashMatch,
  normalizeOtpCode,
} from "@icecore/otp-runtime";

describe("otp-code", () => {
  const previousOtpSecret = process.env.OTP_HASH_SECRET;
  const previousEncryptionSecret = process.env.ENCRYPTION_SECRET;

  beforeEach(() => {
    process.env.OTP_HASH_SECRET = "12345678901234567890123456789012";
  });

  afterAll(() => {
    process.env.OTP_HASH_SECRET = previousOtpSecret;
    process.env.ENCRYPTION_SECRET = previousEncryptionSecret;
  });

  it("generates a six digit numeric code", () => {
    expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });

  it("normalizes only six digit codes", () => {
    expect(normalizeOtpCode(" 123456 ")).toBe("123456");
    expect(normalizeOtpCode("12345")).toBeNull();
    expect(normalizeOtpCode("abcdef")).toBeNull();
  });

  it("hashes the same tuple consistently", () => {
    const input = {
      code: "123456",
      workspaceId: "workspace-1",
      recipientPhone: "77001234567",
      purpose: "login",
      challengeId: "challenge-1",
    };

    const first = hashOtpCode(input);
    const second = hashOtpCode(input);

    expect(first).toBe(second);
    expect(isOtpHashMatch(first, second)).toBe(true);
  });

  it("changes the hash when challenge id changes", () => {
    const first = hashOtpCode({
      code: "123456",
      workspaceId: "workspace-1",
      recipientPhone: "77001234567",
      purpose: "login",
      challengeId: "challenge-1",
    });
    const second = hashOtpCode({
      code: "123456",
      workspaceId: "workspace-1",
      recipientPhone: "77001234567",
      purpose: "login",
      challengeId: "challenge-2",
    });

    expect(isOtpHashMatch(first, second)).toBe(false);
  });
});

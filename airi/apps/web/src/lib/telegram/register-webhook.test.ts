/**
 * @jest-environment node
 */

const mockSourceUpdate = jest.fn();
const mockSourceRead = jest.fn();
const mockCallTelegramApiWithToken = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ single: () => mockSourceRead() }),
      }),
      update: (payload: unknown) => ({
        eq: async () => mockSourceUpdate(payload),
      }),
    }),
  },
}));

jest.mock("../telegram", () => ({
  callTelegramApiWithToken: (...args: unknown[]) =>
    mockCallTelegramApiWithToken(...args),
}));

import { decryptMaybeString, encryptString } from "@/lib/crypto";
import { registerTelegramWebhook } from "./register-webhook";

describe("registerTelegramWebhook", () => {
  const previousEncryptionSecret = process.env.ENCRYPTION_SECRET;

  beforeAll(() => {
    process.env.ENCRYPTION_SECRET = "local-test-encryption-only";
  });

  afterAll(() => {
    if (previousEncryptionSecret === undefined) {
      delete process.env.ENCRYPTION_SECRET;
    } else {
      process.env.ENCRYPTION_SECRET = previousEncryptionSecret;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSourceUpdate.mockReturnValue({ error: null });
    mockCallTelegramApiWithToken.mockResolvedValue(true);
  });

  function writtenCredentials(): Record<string, unknown> {
    const [payload] = mockSourceUpdate.mock.calls[0] as [
      { credentials: Record<string, unknown> },
    ];
    return payload.credentials;
  }

  it("stores the webhook secret encrypted, without writing the bot token back in plain text", async () => {
    const storedToken = encryptString("123:token");
    mockSourceRead.mockResolvedValue({
      data: {
        id: "source-1",
        type: "telegram",
        credentials: { bot_token: storedToken, bot_username: "airi_bot" },
      },
      error: null,
    });

    await expect(
      registerTelegramWebhook("123:token", "source-1")
    ).resolves.toEqual(expect.objectContaining({ success: true }));

    expect(writtenCredentials()).toEqual({
      bot_token: storedToken,
      bot_username: "airi_bot",
      webhook_secret_token: {
        iv: expect.any(String),
        tag: expect.any(String),
        ciphertext: expect.any(String),
      },
    });
    const secret = decryptMaybeString(
      writtenCredentials().webhook_secret_token
    );
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(writtenCredentials())).not.toContain("123:token");
    expect(JSON.stringify(writtenCredentials())).not.toContain(secret);
    expect(mockCallTelegramApiWithToken).toHaveBeenCalledWith(
      "123:token",
      "setWebhook",
      expect.objectContaining({ secret_token: secret })
    );
  });

  it("encrypts a token saved in plain text before encryption", async () => {
    mockSourceRead.mockResolvedValue({
      data: {
        id: "source-1",
        type: "telegram",
        credentials: { bot_token: "123:legacy" },
      },
      error: null,
    });

    await registerTelegramWebhook("123:legacy", "source-1");

    const credentials = writtenCredentials();
    expect(credentials.bot_token).toEqual({
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    });
    expect(decryptMaybeString(credentials.bot_token)).toBe("123:legacy");
  });

  it.each([
    ["an encrypted", () => encryptString("existing-secret")],
    ["a plain-text legacy", () => "existing-secret"],
  ])(
    "reuses %s webhook secret without rewriting credentials",
    async (_label, storedSecret) => {
      mockSourceRead.mockResolvedValue({
        data: {
          id: "source-1",
          type: "telegram",
          credentials: {
            bot_token: encryptString("123:token"),
            webhook_secret_token: storedSecret(),
          },
        },
        error: null,
      });

      await registerTelegramWebhook("123:token", "source-1");

      expect(mockSourceUpdate).not.toHaveBeenCalled();
      expect(mockCallTelegramApiWithToken).toHaveBeenCalledWith(
        "123:token",
        "setWebhook",
        expect.objectContaining({ secret_token: "existing-secret" })
      );
    }
  );

  it("rotates a readable webhook secret when asked", async () => {
    mockSourceRead.mockResolvedValue({
      data: {
        id: "source-1",
        type: "telegram",
        credentials: {
          bot_token: encryptString("123:token"),
          webhook_secret_token: encryptString("existing-secret"),
        },
      },
      error: null,
    });

    await registerTelegramWebhook("123:token", "source-1", {
      rotateSecret: true,
    });

    const secret = decryptMaybeString(
      writtenCredentials().webhook_secret_token
    );
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(mockCallTelegramApiWithToken).toHaveBeenCalledWith(
      "123:token",
      "setWebhook",
      expect.objectContaining({ secret_token: secret })
    );
  });

  it("replaces a webhook secret this key cannot decrypt", async () => {
    const unreadable = encryptString("old-secret");
    process.env.ENCRYPTION_SECRET = "a-different-key";
    try {
      mockSourceRead.mockResolvedValue({
        data: {
          id: "source-1",
          type: "telegram",
          credentials: {
            bot_token: encryptString("123:token"),
            webhook_secret_token: unreadable,
          },
        },
        error: null,
      });

      await registerTelegramWebhook("123:token", "source-1");

      const secret = decryptMaybeString(
        writtenCredentials().webhook_secret_token
      );
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(mockCallTelegramApiWithToken).toHaveBeenCalledWith(
        "123:token",
        "setWebhook",
        expect.objectContaining({ secret_token: secret })
      );
    } finally {
      process.env.ENCRYPTION_SECRET = "local-test-encryption-only";
    }
  });
});

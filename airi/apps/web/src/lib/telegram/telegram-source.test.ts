/**
 * @jest-environment node
 */

const mockWarn = jest.fn();

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    warn: (...args: unknown[]) => mockWarn(...args),
  }),
}));

import { decryptMaybeString, encryptString } from "@/lib/crypto";
import {
  readTelegramBotToken,
  readTelegramWebhookSecret,
  sealTelegramCredentials,
  toPublicTelegramCredentials,
} from "./telegram-source";

describe("Telegram source credentials", () => {
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

  it("reads encrypted tokens and plain-text tokens saved before encryption", () => {
    expect(
      readTelegramBotToken({ bot_token: encryptString("123:encrypted") })
    ).toBe("123:encrypted");
    expect(
      readTelegramBotToken({
        bot_token: JSON.stringify(encryptString("123:json-string")),
      })
    ).toBe("123:json-string");
    expect(readTelegramBotToken({ bot_token: " 123:legacy " })).toBe(
      "123:legacy"
    );
    expect(readTelegramBotToken({})).toBe("");
    expect(readTelegramBotToken(null)).toBe("");
  });

  it("never returns an undecryptable token and reports it without the value", () => {
    const sealed = encryptString("123:other-key");
    process.env.ENCRYPTION_SECRET = "a-different-key";
    try {
      expect(readTelegramBotToken({ bot_token: sealed })).toBe("");
    } finally {
      process.env.ENCRYPTION_SECRET = "local-test-encryption-only";
    }
    expect(mockWarn).toHaveBeenCalledWith("telegram_bot_token_undecryptable");
  });

  it("seals a plain-text token and webhook secret without touching other settings", () => {
    const envelope = {
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    };
    const sealed = sealTelegramCredentials({
      bot_token: "123:legacy",
      bot_username: "airi_bot",
      webhook_secret_token: "webhook-secret",
      ai_reactions_enabled: true,
    });

    expect(sealed).toEqual({
      bot_token: envelope,
      bot_username: "airi_bot",
      webhook_secret_token: envelope,
      ai_reactions_enabled: true,
    });
    expect(decryptMaybeString(sealed.bot_token)).toBe("123:legacy");
    expect(readTelegramWebhookSecret(sealed)).toBe("webhook-secret");
  });

  it("reads encrypted and plain-text webhook secrets", () => {
    expect(
      readTelegramWebhookSecret({
        webhook_secret_token: encryptString("encrypted-secret"),
      })
    ).toBe("encrypted-secret");
    expect(
      readTelegramWebhookSecret({ webhook_secret_token: "legacy-secret" })
    ).toBe("legacy-secret");
    expect(readTelegramWebhookSecret({})).toBe("");
  });

  it("keeps an encrypted webhook secret as it is when sealing a new token", () => {
    const secret = encryptString("webhook-secret");
    const sealed = sealTelegramCredentials({
      bot_token: "456:new",
      webhook_secret_token: secret,
    });

    expect(sealed.webhook_secret_token).toBe(secret);
    expect(decryptMaybeString(sealed.bot_token)).toBe("456:new");
  });

  it("does not encrypt an encrypted token twice", () => {
    const token = encryptString("123:once");
    expect(sealTelegramCredentials({ bot_token: token })).toEqual({
      bot_token: token,
    });

    const fromJsonString = sealTelegramCredentials({
      bot_token: JSON.stringify(token),
    });
    expect(decryptMaybeString(fromJsonString.bot_token)).toBe("123:once");
  });

  it("drops an empty token instead of storing it", () => {
    expect(
      sealTelegramCredentials({ bot_token: "  ", bot_username: "airi_bot" })
    ).toEqual({ bot_username: "airi_bot" });
    expect(sealTelegramCredentials({ bot_username: "airi_bot" })).toEqual({
      bot_username: "airi_bot",
    });
  });

  it.each([
    ["an encrypted", { iv: "aXY=", tag: "dGFn", ciphertext: "c2VjcmV0" }],
    ["a plain-text", "123:legacy"],
  ])("shows the browser only that %s token is saved", (_label, botToken) => {
    expect(
      toPublicTelegramCredentials({
        bot_token: botToken,
        bot_username: "airi_bot",
        webhook_secret_token: "webhook-secret",
        ai_reactions_enabled: true,
      })
    ).toEqual({
      has_bot_token: true,
      bot_username: "airi_bot",
      ai_reactions_enabled: true,
    });
  });

  it("reports a source without a token as not connected", () => {
    expect(toPublicTelegramCredentials(null)).toEqual({
      has_bot_token: false,
      ai_reactions_enabled: false,
    });
    expect(
      toPublicTelegramCredentials({ bot_token: { ciphertext: "partial" } })
    ).toEqual({ has_bot_token: false, ai_reactions_enabled: false });
  });
});

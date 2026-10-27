/**
 * @jest-environment node
 */

import { encryptString } from "@/lib/crypto";
import type { Source } from "@icecore/shared/types/sources";
import { validateTelegramSourceHasToken } from "./validate-source";

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: jest.fn(),
}));

function telegramSource(credentials: Record<string, unknown>): Source {
  return {
    id: "source-1",
    created_at: "2026-10-26T00:00:00.000Z",
    company_id: "company-1",
    workspace_id: "workspace-1",
    type: "telegram",
    name: "@airi_bot",
    credentials,
  } as Source;
}

describe("validateTelegramSourceHasToken", () => {
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

  it.each([
    ["an encrypted", () => encryptString("123:token")],
    ["a plain-text legacy", () => "123:token"],
  ])("returns the decrypted token for %s bot token", (_label, botToken) => {
    expect(
      validateTelegramSourceHasToken(telegramSource({ bot_token: botToken() }))
    ).toEqual(expect.objectContaining({ valid: true, botToken: "123:token" }));
  });

  it.each([
    ["no token", {}],
    ["a blank token", { bot_token: " " }],
    ["a malformed envelope", { bot_token: { ciphertext: "x" } }],
  ])("rejects a source with %s", (_label, credentials) => {
    expect(validateTelegramSourceHasToken(telegramSource(credentials))).toEqual(
      expect.objectContaining({
        valid: false,
        error: "Telegram source is missing bot_token in credentials",
      })
    );
  });
});

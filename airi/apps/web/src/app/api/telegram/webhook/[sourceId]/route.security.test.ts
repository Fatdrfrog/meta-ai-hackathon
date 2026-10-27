import { encryptString } from "@/lib/crypto";
import connectDB from "@/lib/mongoose";
import { fetchAndValidateTelegramSource } from "@/lib/telegram/validate-source";
import { POST } from "./route";
import { processTelegramUpdateWithDedupe } from "../../dedupe-update";
import { handleMessage } from "../../handleMessage";
import { NextResponse } from "next/server";

jest.mock("@/lib/mongoose", () => jest.fn(async () => undefined));
jest.mock("@/lib/telegram/validate-source", () => ({
  fetchAndValidateTelegramSource: jest.fn(),
}));
jest.mock("../../dedupe-update", () => ({
  processTelegramUpdateWithDedupe: jest.fn(),
}));
jest.mock("../../handleBusinessConnectionUpdate", () => ({
  handleBusinessConnectionUpdate: jest.fn(async () => undefined),
}));
jest.mock("../../handleCallbackQuery", () => ({
  handleCallbackQuery: jest.fn(async () => undefined),
}));
jest.mock("../../handleChatMemberUpdate", () => ({
  handleChatMemberUpdate: jest.fn(async () => undefined),
}));
jest.mock("../../handleMessage", () => ({
  handleMessage: jest.fn(async () => undefined),
}));

function telegramSource(credentials: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    created_at: "2026-06-16T00:00:00.000Z",
    company_id: "company-1",
    workspace_id: "workspace-1",
    type: "telegram",
    name: "Telegram",
    credentials: {
      // Stored encrypted; the route sends the token the validator decrypted.
      bot_token: { iv: "iv", tag: "tag", ciphertext: "ciphertext" },
      ...credentials,
    },
  };
}

function makeRequest(
  body: Record<string, unknown> = { update_id: 1 },
  secret?: string
): Request {
  return new Request("http://localhost/api/telegram/webhook/source-1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : undefined),
    },
    body: JSON.stringify(body),
  });
}

function sourceParams() {
  return { params: Promise.resolve({ sourceId: "source-1" }) };
}

describe("source-specific Telegram webhook security", () => {
  const previousMode = process.env.TELEGRAM_SOURCE_SECRET_MODE;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(processTelegramUpdateWithDedupe)
      .mockImplementation(async ({ process }) => process());
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    (fetchAndValidateTelegramSource as jest.Mock).mockResolvedValue({
      valid: true,
      botToken: "bot-token",
      source: telegramSource({ webhook_secret_token: "source-secret" }),
    });
  });

  afterEach(() => {
    process.env.TELEGRAM_SOURCE_SECRET_MODE = previousMode;
    warnSpy.mockRestore();
  });

  it("rejects sources missing a Telegram secret when strict source mode is required", async () => {
    process.env.TELEGRAM_SOURCE_SECRET_MODE = "required";
    (fetchAndValidateTelegramSource as jest.Mock).mockResolvedValueOnce({
      valid: true,
      botToken: "bot-token",
      source: telegramSource(),
    });

    const res = await POST(makeRequest() as never, sourceParams());

    expect(res.status).toBe(403);
    expect(connectDB).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("rejects updates when the saved secret cannot be decrypted, even when the secret is optional", async () => {
    process.env.TELEGRAM_SOURCE_SECRET_MODE = "optional";
    (fetchAndValidateTelegramSource as jest.Mock).mockResolvedValueOnce({
      valid: true,
      botToken: "bot-token",
      source: telegramSource({
        // An envelope this key cannot decrypt must not read as "no secret".
        webhook_secret_token: { iv: "aXY=", tag: "dGFn", ciphertext: "eA==" },
      }),
    });

    const res = await POST(makeRequest() as never, sourceParams());

    expect(res.status).toBe(403);
    expect(connectDB).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("accepts an encrypted saved secret that matches the update", async () => {
    const previousEncryptionSecret = process.env.ENCRYPTION_SECRET;
    process.env.ENCRYPTION_SECRET = "local-test-encryption-only";
    process.env.TELEGRAM_SOURCE_SECRET_MODE = "required";
    try {
      (fetchAndValidateTelegramSource as jest.Mock).mockResolvedValueOnce({
        valid: true,
        botToken: "bot-token",
        source: telegramSource({
          webhook_secret_token: encryptString("source-secret"),
        }),
      });

      const res = await POST(
        makeRequest({ update_id: 1 }, "source-secret") as never,
        sourceParams()
      );

      expect(res.status).toBe(200);
      expect(processTelegramUpdateWithDedupe).toHaveBeenCalledTimes(1);
    } finally {
      if (previousEncryptionSecret === undefined) {
        delete process.env.ENCRYPTION_SECRET;
      } else {
        process.env.ENCRYPTION_SECRET = previousEncryptionSecret;
      }
    }
  });

  it("passes source context to handlers when the Telegram secret is valid", async () => {
    process.env.TELEGRAM_SOURCE_SECRET_MODE = "optional";
    const message = {
      message_id: 1,
      date: 1710000000,
      chat: { id: 123, type: "private" },
      text: "hi",
    };

    const res = await POST(
      makeRequest({ update_id: 2, message }, "source-secret") as never,
      sourceParams()
    );

    expect(res.status).toBe(200);
    expect(connectDB).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith(message, {
      sourceId: "source-1",
      workspaceId: "workspace-1",
      botToken: "bot-token",
    });
    expect(processTelegramUpdateWithDedupe).toHaveBeenCalledWith({
      scope: "source-1",
      updateId: 2,
      process: expect.any(Function),
    });
  });

  it("returns an error when a source handler fails", async () => {
    process.env.TELEGRAM_SOURCE_SECRET_MODE = "optional";
    const handlerError = new Error("handler failed");
    jest.mocked(handleMessage).mockRejectedValueOnce(handlerError);
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await POST(
      makeRequest(
        {
          update_id: 3,
          message: {
            message_id: 1,
            date: 1710000000,
            chat: { id: 123, type: "private" },
            text: "hi",
          },
        },
        "source-secret"
      ) as never,
      sourceParams()
    );

    expect(res.status).toBe(500);
    expect(processTelegramUpdateWithDedupe).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("acknowledges completed updates without running handlers", async () => {
    process.env.TELEGRAM_SOURCE_SECRET_MODE = "optional";
    jest.mocked(processTelegramUpdateWithDedupe).mockResolvedValueOnce(
      NextResponse.json({
        ok: true,
        duplicate_update: true,
        dedupe_state: "completed",
      })
    );

    const res = await POST(
      makeRequest({ update_id: 4 }, "source-secret") as never,
      sourceParams()
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      duplicate_update: true,
      dedupe_state: "completed",
    });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("returns a retryable response while another request owns the update", async () => {
    process.env.TELEGRAM_SOURCE_SECRET_MODE = "optional";
    jest
      .mocked(processTelegramUpdateWithDedupe)
      .mockResolvedValueOnce(
        NextResponse.json(
          { ok: false, dedupe_state: "in_progress" },
          { status: 503, headers: { "Retry-After": "1" } }
        )
      );

    const res = await POST(
      makeRequest({ update_id: 5 }, "source-secret") as never,
      sourceParams()
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      dedupe_state: "in_progress",
    });
    expect(handleMessage).not.toHaveBeenCalled();
  });
});

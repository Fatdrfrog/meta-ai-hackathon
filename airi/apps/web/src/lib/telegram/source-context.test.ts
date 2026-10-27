const mockFetchSourceWithCredentials = jest.fn();
const mockFetchSourceWithCredentialsResult = jest.fn();

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: (...args: unknown[]) =>
    mockFetchSourceWithCredentials(...args),
  fetchSourceWithCredentialsResult: (...args: unknown[]) =>
    mockFetchSourceWithCredentialsResult(...args),
}));

import { encryptString } from "@/lib/crypto";
import {
  resolveTelegramSendContext,
  resolveTelegramSendContextResult,
} from "./source-context";

describe("resolveTelegramSendContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchSourceWithCredentialsResult.mockImplementation(
      async (...args: unknown[]) => ({
        ok: true,
        source: await mockFetchSourceWithCredentials(...args),
      })
    );
  });

  it("returns the selected workspace Telegram bot credentials", async () => {
    mockFetchSourceWithCredentials.mockResolvedValue({
      id: "source-1",
      workspace_id: "workspace-1",
      type: "telegram",
      credentials: { bot_token: " bot-token " },
    });

    await expect(
      resolveTelegramSendContext({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).resolves.toEqual({
      sourceId: "source-1",
      botToken: "bot-token",
    });
    expect(mockFetchSourceWithCredentials).toHaveBeenCalledWith(
      "source-1",
      "telegram"
    );
  });

  it("decrypts an encrypted bot token", async () => {
    const previousEncryptionSecret = process.env.ENCRYPTION_SECRET;
    process.env.ENCRYPTION_SECRET = "local-test-encryption-only";
    try {
      mockFetchSourceWithCredentials.mockResolvedValue({
        id: "source-1",
        workspace_id: "workspace-1",
        type: "telegram",
        credentials: { bot_token: encryptString("123:encrypted") },
      });

      await expect(
        resolveTelegramSendContext({
          workspaceId: "workspace-1",
          sourceId: "source-1",
        })
      ).resolves.toEqual({ sourceId: "source-1", botToken: "123:encrypted" });

      // A token this key cannot decrypt is missing, never "[object Object]".
      process.env.ENCRYPTION_SECRET = "a-different-key";
      await expect(
        resolveTelegramSendContextResult({
          workspaceId: "workspace-1",
          sourceId: "source-1",
        })
      ).resolves.toEqual({
        ok: false,
        kind: "unavailable",
        reason: "credentials_missing",
      });
    } finally {
      if (previousEncryptionSecret === undefined) {
        delete process.env.ENCRYPTION_SECRET;
      } else {
        process.env.ENCRYPTION_SECRET = previousEncryptionSecret;
      }
    }
  });

  it("rejects Telegram sources from another workspace", async () => {
    mockFetchSourceWithCredentials.mockResolvedValue({
      id: "source-1",
      workspace_id: "workspace-2",
      type: "telegram",
      credentials: { bot_token: "bot-token" },
    });

    await expect(
      resolveTelegramSendContext({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).resolves.toBeNull();
  });

  it("rejects missing source IDs and empty bot tokens", async () => {
    await expect(
      resolveTelegramSendContext({
        workspaceId: "workspace-1",
        sourceId: "",
      })
    ).resolves.toBeNull();
    expect(mockFetchSourceWithCredentials).not.toHaveBeenCalled();

    mockFetchSourceWithCredentials.mockResolvedValue({
      id: "source-1",
      workspace_id: "workspace-1",
      type: "telegram",
      credentials: { bot_token: "" },
    });
    await expect(
      resolveTelegramSendContext({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).resolves.toBeNull();
  });

  it("distinguishes source query failures from confirmed source absence", async () => {
    const queryError = new Error("sources query unavailable");
    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ok: false,
      error: queryError,
    });

    await expect(
      resolveTelegramSendContextResult({
        workspaceId: "workspace-1",
        sourceId: "source-query-failure",
      })
    ).resolves.toEqual({
      ok: false,
      kind: "query_error",
      error: queryError,
    });

    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ok: true,
      source: null,
    });
    await expect(
      resolveTelegramSendContextResult({
        workspaceId: "workspace-1",
        sourceId: "source-absent",
      })
    ).resolves.toMatchObject({
      ok: false,
      kind: "unavailable",
      reason: "source_not_found",
    });
  });
});

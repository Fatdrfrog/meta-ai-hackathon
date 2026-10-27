let mockEmit: jest.Mock;
let mockForceFlush: jest.Mock<Promise<void>, []>;

jest.mock("next/server", () => ({
  after: jest.fn(),
}));

jest.mock("@/instrumentation", () => ({
  loggerProvider: {
    getLogger: jest.fn(() => ({
      emit: (...args: unknown[]) => mockEmit(...args),
    })),
    forceFlush: () => mockForceFlush(),
  },
}));

import { after } from "next/server";
import {
  createRequestLogger,
  createServerLogger,
  flushServerLogsAfterResponse,
} from "./server-logs";

describe("server request logging", () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
    SERVER_LOG_CONSOLE_MODE: process.env.SERVER_LOG_CONSOLE_MODE,
    SERVER_LOG_CONSOLE_SCOPES: process.env.SERVER_LOG_CONSOLE_SCOPES,
    VERCEL: process.env.VERCEL,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  };

  beforeEach(() => {
    mockEmit = jest.fn();
    mockForceFlush = jest.fn(async () => undefined);
    (after as jest.Mock).mockReset();
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.SERVER_LOG_CONSOLE_MODE;
    delete process.env.SERVER_LOG_CONSOLE_SCOPES;
    delete process.env.VERCEL;
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("schedules log flushing after a Next.js request", async () => {
    (after as jest.Mock).mockImplementation(
      (callback: () => Promise<void>) => void callback()
    );

    flushServerLogsAfterResponse();
    await Promise.resolve();

    expect(mockForceFlush).toHaveBeenCalledTimes(1);
  });

  it("does not throw when used outside a Next.js request scope", () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    (after as jest.Mock).mockImplementation(() => {
      throw new Error(
        "`after` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context"
      );
    });

    expect(() => {
      const logger = createRequestLogger(
        "test.scope",
        new Request("http://temporal-worker.local/webhook", {
          method: "POST",
        })
      );
      logger.start("started");
    }).not.toThrow();

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it.each(["api.webhooks.whatsapp", "api.realtime.token"])(
    "mirrors existing selected scope %s completion logs to console on Vercel",
    scope => {
      process.env.VERCEL = "1";
      process.env.NEXT_PUBLIC_APP_VERSION = "test-version";
      const consoleInfoSpy = jest
        .spyOn(console, "info")
        .mockImplementation(() => undefined);

      const logger = createRequestLogger(
        scope,
        new Request("http://localhost/api/webhooks/whatsapp", {
          method: "POST",
          headers: { "x-request-id": "request-1" },
        }),
        { route: "/api/webhooks/whatsapp" }
      );

      logger.start("Webhook received", { hasSignatureHeader: true });
      expect(consoleInfoSpy).not.toHaveBeenCalled();

      logger.success("Webhook queued", {
        webhookSummary: { messageCount: 1, referralCount: 1 },
      });

      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(consoleInfoSpy.mock.calls[0]![0]);
      expect(payload).toMatchObject({
        level: "info",
        service: "@icecore/web",
        scope,
        message: "Webhook queued",
        appVersion: "test-version",
        appVersionSource: "next-public-app-version",
        method: "POST",
        requestId: "request-1",
        route: "/api/webhooks/whatsapp",
        logStage: "complete",
        webhookSummary: { messageCount: 1, referralCount: 1 },
      });
      expect(typeof payload.durationMs).toBe("number");

      consoleInfoSpy.mockRestore();
    }
  );

  it("mirrors conversation detail completion timings by default on Vercel", () => {
    process.env.VERCEL = "1";
    const consoleInfoSpy = jest
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    try {
      const logger = createServerLogger("api.conversations.detail");
      logger.info("Conversation detail completed", {
        method: "GET",
        route: "/api/conversations/[id]",
        requestId: "detail-request-1",
        logStage: "complete",
        statusCode: 200,
        cachePath: "workspace_hit",
        view: "chat",
        page: 1,
        limit: 30,
        durationMs: 368,
        timings: { authMs: 120, cacheGetMs: 8, membershipMs: 240 },
      });

      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(consoleInfoSpy.mock.calls[0]![0])).toMatchObject({
        level: "info",
        service: "@icecore/web",
        scope: "api.conversations.detail",
        message: "Conversation detail completed",
        method: "GET",
        route: "/api/conversations/[id]",
        requestId: "detail-request-1",
        logStage: "complete",
        statusCode: 200,
        cachePath: "workspace_hit",
        view: "chat",
        page: 1,
        limit: 30,
        durationMs: 368,
        timings: { authMs: 120, cacheGetMs: 8, membershipMs: 240 },
      });
    } finally {
      consoleInfoSpy.mockRestore();
    }
  });

  it("mirrors Airi MCP tool-call metadata by default on Vercel", () => {
    process.env.VERCEL = "1";
    const consoleInfoSpy = jest
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    try {
      createServerLogger("api.mcp").info("airi_mcp.tool_call", {
        event: "airi_mcp.tool_call",
        keyId: "key-1",
        workspaceId: "workspace-1",
        tool: "list_conversations",
        outcome: "ok",
        latencyMs: 42,
        itemCount: 3,
      });

      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(consoleInfoSpy.mock.calls[0]![0])).toMatchObject({
        level: "info",
        scope: "api.mcp",
        message: "airi_mcp.tool_call",
        event: "airi_mcp.tool_call",
        keyId: "key-1",
        workspaceId: "workspace-1",
        tool: "list_conversations",
        outcome: "ok",
        latencyMs: 42,
        itemCount: 3,
      });
    } finally {
      consoleInfoSpy.mockRestore();
    }
  });

  it.each([
    { mode: "off", scopes: "api.conversations.detail" },
    { mode: "selected", scopes: "api.webhooks.whatsapp" },
  ])(
    "honors the $mode override for conversation diagnostics",
    ({ mode, scopes }) => {
      process.env.VERCEL = "1";
      process.env.SERVER_LOG_CONSOLE_MODE = mode;
      process.env.SERVER_LOG_CONSOLE_SCOPES = scopes;
      const consoleInfoSpy = jest
        .spyOn(console, "info")
        .mockImplementation(() => undefined);

      try {
        createServerLogger("api.conversations.detail").info(
          "Conversation detail completed",
          { logStage: "complete", durationMs: 368 }
        );

        expect(consoleInfoSpy).not.toHaveBeenCalled();
      } finally {
        consoleInfoSpy.mockRestore();
      }
    }
  );

  it("mirrors Embedded Signup callback logs by default on Vercel", () => {
    process.env.VERCEL = "1";
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    createServerLogger("whatsapp.embedded-signup").warn(
      "embedded_signup.callback_completed",
      { outcome: "failed", error: "missing_code" }
    );

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(consoleWarnSpy.mock.calls[0]![0])).toMatchObject({
      level: "warn",
      scope: "whatsapp.embedded-signup",
      message: "embedded_signup.callback_completed",
      outcome: "failed",
      error: "missing_code",
    });
    consoleWarnSpy.mockRestore();
  });

  it("does not mirror unselected scopes by default", () => {
    process.env.VERCEL = "1";
    const consoleInfoSpy = jest
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const logger = createRequestLogger(
      "api.auth.sync-profile",
      new Request("http://localhost/api/auth/sync-profile", {
        method: "POST",
      })
    );
    logger.success("Profile synced");

    expect(consoleInfoSpy).not.toHaveBeenCalled();
    consoleInfoSpy.mockRestore();
  });

  it("allows explicit console mirroring for configured scopes", () => {
    process.env.SERVER_LOG_CONSOLE_MODE = "selected";
    process.env.SERVER_LOG_CONSOLE_SCOPES = "api.auth.sync-profile";
    const consoleInfoSpy = jest
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const logger = createRequestLogger(
      "api.auth.sync-profile",
      new Request("http://localhost/api/auth/sync-profile", {
        method: "POST",
      })
    );
    logger.success("Profile synced");

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(consoleInfoSpy.mock.calls[0]![0])).toMatchObject({
      scope: "api.auth.sync-profile",
      message: "Profile synced",
    });
    consoleInfoSpy.mockRestore();
  });
});

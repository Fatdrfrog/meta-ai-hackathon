/**
 * @jest-environment node
 */

const mockCreateClient = jest.fn();
const mockSourcesFrom = jest.fn();
const mockSourceSelect = jest.fn();
const mockSourceReadEqId = jest.fn();
const mockSourceReadEqType = jest.fn();
const mockSourceSingle = jest.fn();
const mockSourceUpdate = jest.fn();
const mockSourceWriteEqId = jest.fn();
const mockSourceWriteEqWorkspace = jest.fn();
const mockSourceWriteEqType = jest.fn();
const mockCompanySelect = jest.fn();
const mockCompanyEqUser = jest.fn();
const mockCompanyEqWorkspace = jest.fn();
const mockCompanySingle = jest.fn();

jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  toPublicElevenLabsCredentials: jest.fn(),
}));
jest.mock("@/lib/higgsfield/higgsfield-source", () => ({
  toPublicHiggsfieldCredentials: jest.fn(),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE: "COMPANY_CHANNEL_LIMIT_EXCEEDED",
  ensureCompanyChannelCapacity: jest.fn(),
  toPublicLimitPayload: jest.fn(),
}));
jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({ error: jest.fn() }),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/lib/supabase/queries", () => ({
  getUserCompany: jest.fn(),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/lib/telegram/register-webhook", () => ({
  registerTelegramWebhook: jest.fn(),
}));
jest.mock("@/lib/telegram/validate-token", () => ({
  validateAndEnrichTelegramCredentials: jest.fn(),
}));
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  ManagedWhatsAppFlowSourceRebindError: class extends Error {},
  updateManagedWhatsAppSourceBinding: jest.fn(),
}));
jest.mock("@/lib/widget/quick-reply-translations", () => ({
  translateWidgetQuickRepliesSet: jest.fn(),
}));
jest.mock("next/headers", () => ({ cookies: jest.fn() }));
jest.mock("next/server", () => ({ after: jest.fn() }));

import {
  setLocale,
  createTelegramSource,
  updateSource,
  regenerateWebWidgetKeys,
  updateWebWidgetBranding,
  updateWebWidgetSource,
} from "./actions";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { updateManagedWhatsAppSourceBinding } from "@/lib/whatsapp/flows/source-rebind-guard";
import { validateAndEnrichTelegramCredentials } from "@/lib/telegram/validate-token";
import { registerTelegramWebhook } from "@/lib/telegram/register-webhook";
import { decryptMaybeString, encryptString } from "@/lib/crypto";
import { after } from "next/server";

type WidgetAction = {
  name: string;
  invoke(): Promise<unknown>;
};

const widgetActions: WidgetAction[] = [
  {
    name: "updateWebWidgetSource",
    invoke: () =>
      updateWebWidgetSource("source-1", {
        allowedDomains: ["https://example.com"],
      }),
  },
  {
    name: "regenerateWebWidgetKeys",
    invoke: () => regenerateWebWidgetKeys("source-1"),
  },
  {
    name: "updateWebWidgetBranding",
    invoke: () =>
      updateWebWidgetBranding("source-1", {
        settings: { welcome_message: "Welcome" },
      }),
  },
];

describe("web widget source actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockSourceSelect.mockReturnValue({ eq: mockSourceReadEqId });
    mockSourceReadEqId.mockReturnValue({ eq: mockSourceReadEqType });
    mockSourceReadEqType.mockReturnValue({ single: mockSourceSingle });
    mockSourceUpdate.mockReturnValue({ eq: mockSourceWriteEqId });
    mockSourceWriteEqId.mockReturnValue({ eq: mockSourceWriteEqWorkspace });
    mockSourceWriteEqWorkspace.mockReturnValue({ eq: mockSourceWriteEqType });
    mockSourceWriteEqType.mockResolvedValue({ error: null });

    mockCompanySelect.mockReturnValue({ eq: mockCompanyEqUser });
    mockCompanyEqUser.mockReturnValue({ eq: mockCompanyEqWorkspace });
    mockCompanyEqWorkspace.mockReturnValue({ single: mockCompanySingle });
    mockCompanySingle.mockResolvedValue({
      data: { workspace_id: "workspace-1" },
      error: null,
    });

    mockSourcesFrom.mockImplementation((table: string) => {
      if (table === "sources") {
        return { select: mockSourceSelect, update: mockSourceUpdate };
      }
      if (table === "company_users") {
        return { select: mockCompanySelect };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
        }),
      },
      from: mockSourcesFrom,
    });
  });

  it.each([
    { conversions_api: "injected" },
    { sales_webhook_secret: "injected" },
    { phone_number_id: "another-tenants-phone" },
    { access_token: "plaintext-token" },
    {
      coexistence_reonboarding_status: null,
      cloud_api_messaging_suspended: false,
      partner_app_installed: true,
    },
    { __airi_whatsapp_flow_source_fence: { token: "forged" } },
  ])(
    "refuses to write WhatsApp connection credentials through the generic action: %j",
    async credentials => {
      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: "source-1",
                workspace_id: "workspace-1",
                type: "whatsapp",
                credentials: {},
              },
            }),
          }),
        }),
      });
      await expect(updateSource("source-1", { credentials })).resolves.toEqual({
        error: "Use WhatsApp integration settings to change this connection.",
      });
      expect(updateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
      expect(mockSourceUpdate).not.toHaveBeenCalled();
    }
  );

  it("cannot bypass Google AI validation and encryption through updateSource", async () => {
    (supabaseAdmin.from as jest.Mock).mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "google-1",
              workspace_id: "workspace-1",
              type: "google_ai",
              credentials: {},
            },
          }),
        }),
      }),
    });
    await expect(
      updateSource("google-1", { credentials: { api_key: "plaintext" } })
    ).resolves.toEqual({
      error:
        "Use Google AI integration settings to validate and replace the API key.",
    });
    expect(mockSourceUpdate).not.toHaveBeenCalled();
  });

  it.each(widgetActions)(
    "$name rejects a tampered WhatsApp source id before writing",
    async ({ invoke }) => {
      mockSourceSingle.mockResolvedValue({
        data: {
          workspace_id: "workspace-1",
          type: "whatsapp",
          credentials: {
            waba_id: "waba-1",
            __airi_whatsapp_flow_source_fence: 7,
          },
        },
        error: null,
      });

      await expect(invoke()).resolves.toEqual({
        error: "Source is not a web widget",
      });

      expect(mockSourceReadEqType).toHaveBeenCalledWith("type", "web_widget");
      expect(mockSourceUpdate).not.toHaveBeenCalled();
      expect(mockCompanySelect).not.toHaveBeenCalled();
    }
  );

  it.each(widgetActions)(
    "$name fences the write to the exact web widget row",
    async ({ invoke }) => {
      mockSourceSingle.mockResolvedValue({
        data: {
          workspace_id: "workspace-1",
          type: "web_widget",
          credentials: {
            client_key: "widget-old",
            secret_key: "secret-old",
          },
        },
        error: null,
      });

      await expect(invoke()).resolves.toMatchObject({ success: true });

      expect(mockSourceWriteEqId).toHaveBeenCalledWith("id", "source-1");
      expect(mockSourceWriteEqWorkspace).toHaveBeenCalledWith(
        "workspace_id",
        "workspace-1"
      );
      expect(mockSourceWriteEqType).toHaveBeenCalledWith("type", "web_widget");
    }
  );
});

describe("Telegram source settings", () => {
  const previousEncryptionSecret = process.env.ENCRYPTION_SECRET;
  // Saved before tokens were encrypted, so every write must seal it.
  const currentCredentials = {
    bot_token: "123:current",
    bot_username: "current_bot",
    webhook_secret_token: "webhook-secret",
    ai_reactions_enabled: true,
  };
  const source = {
    id: "telegram-1",
    type: "telegram",
    workspace_id: "workspace-1",
    credentials: currentCredentials as Record<string, unknown>,
  };
  const mockWrite = jest.fn();
  const mockAdminUpdate = jest.fn();
  const mockAdminInsert = jest.fn();
  let existingSource: typeof source | null;

  const encryptedToken = {
    iv: expect.any(String),
    tag: expect.any(String),
    ciphertext: expect.any(String),
  };

  function writtenCredentials(mock: jest.Mock): Record<string, unknown> {
    const [payload] = mock.mock.calls[mock.mock.calls.length - 1] as [
      { credentials: Record<string, unknown> },
    ];
    return payload.credentials;
  }

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
    existingSource = source;
    const readQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(async () => ({ data: existingSource, error: null })),
      single: jest.fn(async () => ({ data: existingSource, error: null })),
      update: mockAdminUpdate,
      insert: mockAdminInsert,
    };
    mockAdminUpdate.mockReturnValue(readQuery);
    mockAdminInsert.mockReturnValue(readQuery);
    jest.mocked(supabaseAdmin.from).mockReturnValue(readQuery as never);
    mockWrite.mockReturnValue({ eq: async () => ({ error: null }) });
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from: (table: string) => {
        if (table === "sources") return { update: mockWrite };
        const membershipQuery = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: async () => ({
            data: { workspace_id: "workspace-1", company_id: "company-1" },
          }),
        };
        return membershipQuery;
      },
    });
    jest.mocked(validateAndEnrichTelegramCredentials).mockImplementation(
      async credentials => ({ valid: true, credentials })
    );
  });

  it("encrypts a plain-text token and webhook secret when saving only the reaction setting", async () => {
    await expect(
      updateSource("telegram-1", {
        credentials: { ai_reactions_enabled: false },
      })
    ).resolves.toEqual({ success: true });

    const credentials = writtenCredentials(mockAdminUpdate);
    expect(credentials).toEqual({
      bot_token: encryptedToken,
      bot_username: "current_bot",
      webhook_secret_token: encryptedToken,
      ai_reactions_enabled: false,
    });
    expect(decryptMaybeString(credentials.bot_token)).toBe("123:current");
    expect(validateAndEnrichTelegramCredentials).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("keeps an already encrypted token as it is", async () => {
    const storedToken = encryptString("123:current");
    existingSource = {
      ...source,
      credentials: { ...currentCredentials, bot_token: storedToken },
    };

    await updateSource("telegram-1", {
      credentials: { ai_reactions_enabled: false },
    });

    expect(writtenCredentials(mockAdminUpdate).bot_token).toEqual(storedToken);
  });

  it("writes only credentials, so a client cannot change the source type or workspace", async () => {
    await expect(
      updateSource("telegram-1", {
        credentials: { ai_reactions_enabled: false },
        type: "whatsapp",
        workspace_id: "another-workspace",
        name: "renamed",
      } as never)
    ).resolves.toEqual({ success: true });

    expect(mockAdminUpdate).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ ai_reactions_enabled: false }),
    });
    expect(Object.keys(mockAdminUpdate.mock.calls[0][0])).toEqual([
      "credentials",
    ]);
  });

  it("writes Telegram settings with the service role, scoped to the source's workspace", async () => {
    await updateSource("telegram-1", {
      credentials: { ai_reactions_enabled: false },
    });

    // Telegram rows are server-managed, so the member's client never writes them.
    expect(mockWrite).not.toHaveBeenCalled();
    const adminQuery = jest.mocked(supabaseAdmin.from).mock.results.at(-1)
      ?.value as { eq: jest.Mock };
    expect(adminQuery.eq).toHaveBeenCalledWith("id", "telegram-1");
    expect(adminQuery.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(adminQuery.eq).toHaveBeenCalledWith("type", "telegram");
  });

  it("encrypts a plain-text webhook secret on the next save", async () => {
    await updateSource("telegram-1", {
      credentials: { ai_reactions_enabled: false },
    });

    const credentials = writtenCredentials(mockAdminUpdate);
    expect(credentials.webhook_secret_token).toEqual(encryptedToken);
    expect(decryptMaybeString(credentials.webhook_secret_token)).toBe(
      "webhook-secret"
    );
  });

  it("rejects a request without a credentials object", async () => {
    await expect(
      updateSource("telegram-1", { credentials: "nope" } as never)
    ).resolves.toEqual({ error: "Invalid credentials" });
    expect(mockAdminUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an encrypted token echoed back",
      { bot_token: { iv: "a", tag: "b", ciphertext: "c" } },
      "Invalid bot token",
    ],
    [
      "a webhook secret",
      { webhook_secret_token: "forged" },
      "Unsupported Telegram credentials",
    ],
    [
      "a public flag",
      { has_bot_token: false },
      "Unsupported Telegram credentials",
    ],
  ])("rejects %s from the browser", async (_label, credentials, error) => {
    await expect(updateSource("telegram-1", { credentials })).resolves.toEqual({
      error,
    });
    expect(mockAdminUpdate).not.toHaveBeenCalled();
    expect(validateAndEnrichTelegramCredentials).not.toHaveBeenCalled();
  });

  it("encrypts a rotated token and registers the webhook with the plain token", async () => {
    await updateSource("telegram-1", {
      credentials: { bot_token: "456:new", bot_username: "new_bot" },
    });

    const credentials = writtenCredentials(mockAdminUpdate);
    expect(credentials).toEqual({
      bot_token: encryptedToken,
      bot_username: "new_bot",
      webhook_secret_token: encryptedToken,
      ai_reactions_enabled: true,
    });
    expect(decryptMaybeString(credentials.bot_token)).toBe("456:new");
    expect(JSON.stringify(credentials)).not.toContain("456:new");

    expect(after).toHaveBeenCalledTimes(1);
    jest.mocked(registerTelegramWebhook).mockResolvedValue({ success: true });
    await (jest.mocked(after).mock.calls[0][0] as () => Promise<void>)();
    expect(registerTelegramWebhook).toHaveBeenCalledWith(
      "456:new",
      "telegram-1"
    );
  });

  it("refreshes the username when rotating a token without providing a username", async () => {
    jest.mocked(validateAndEnrichTelegramCredentials).mockImplementation(
      async credentials => ({
        valid: true,
        credentials: {
          ...credentials,
          bot_username: credentials.bot_username || "new_bot",
        },
      })
    );

    await updateSource("telegram-1", {
      credentials: { bot_token: "456:new" },
    });

    expect(writtenCredentials(mockAdminUpdate)).toEqual({
      bot_token: encryptedToken,
      bot_username: "new_bot",
      webhook_secret_token: encryptedToken,
      ai_reactions_enabled: true,
    });
  });

  it.each(["true", 1, null])(
    "rejects a non-boolean reaction setting (%s) before writing",
    async enabled => {
      await expect(
        updateSource("telegram-1", {
          credentials: { ai_reactions_enabled: enabled },
        })
      ).resolves.toEqual({ error: "AI reactions setting must be a boolean" });
      expect(mockAdminUpdate).not.toHaveBeenCalled();
    }
  );

  it("preserves existing settings and encrypts the token when reconnecting through source creation", async () => {
    await createTelegramSource("workspace-1", {
      bot_token: "456:new",
      bot_username: "new_bot",
    });

    expect(mockAdminUpdate).toHaveBeenCalledWith({
      name: "@new_bot",
      credentials: {
        bot_token: encryptedToken,
        bot_username: "new_bot",
        webhook_secret_token: encryptedToken,
        ai_reactions_enabled: true,
      },
    });
    expect(
      decryptMaybeString(writtenCredentials(mockAdminUpdate).bot_token)
    ).toBe("456:new");
  });

  it("returns only public credentials after connecting a bot", async () => {
    const result = await createTelegramSource("workspace-1", {
      bot_token: "456:new",
      bot_username: "new_bot",
    });

    expect(result).toEqual({
      success: true,
      source: expect.objectContaining({
        id: "telegram-1",
        credentials: {
          has_bot_token: true,
          bot_username: "current_bot",
          ai_reactions_enabled: true,
        },
      }),
    });
    expect(JSON.stringify(result)).not.toContain("123:current");
    expect(JSON.stringify(result)).not.toContain("webhook-secret");
  });

  it("rejects malformed reaction settings when connecting a bot", async () => {
    await expect(
      createTelegramSource("workspace-1", {
        bot_token: "123:token",
        ai_reactions_enabled: "true",
      } as never)
    ).resolves.toEqual({ error: "AI reactions setting must be a boolean" });
    expect(mockAdminUpdate).not.toHaveBeenCalled();
  });

  it("rejects a webhook secret supplied when connecting a bot", async () => {
    await expect(
      createTelegramSource("workspace-1", {
        bot_token: "123:token",
        webhook_secret_token: "forged",
      })
    ).resolves.toEqual({ error: "Unsupported Telegram credentials" });
    expect(mockAdminUpdate).not.toHaveBeenCalled();
  });
});

describe("setLocale", () => {
  const mockCookieSet = jest.fn();

  beforeEach(() => {
    mockCookieSet.mockReset();
    jest.mocked(cookies).mockResolvedValue({
      set: mockCookieSet,
    } as unknown as Awaited<ReturnType<typeof cookies>>);
  });

  it("stores interface locales, including the kk alias for Kazakh", async () => {
    await setLocale("ru");
    await setLocale("kk");

    // Persistent, so an explicit pick still beats the browser-language
    // default after the browser restarts.
    const persistent = { path: "/", sameSite: "lax", maxAge: 31_536_000 };
    expect(mockCookieSet.mock.calls).toEqual([
      ["NEXT_LOCALE", "ru", persistent],
      ["NEXT_LOCALE", "kz", persistent],
    ]);
  });

  it("ignores Uzbek, which is a widget language but not an interface locale", async () => {
    await setLocale("uz");

    expect(mockCookieSet).not.toHaveBeenCalled();
  });
});

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  isVoiceReplySubscriptionEligible,
  resolveWorkspaceVoiceReplyAccess,
} from "./voice-reply-access";

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

const workspaceId = "workspace-1";
const originalPlatformKey = process.env.ELEVENLABS_API_KEY;

function createSourceClient(
  params: {
    subscriptionType?: unknown;
    companyAsArray?: boolean;
    workspaceMissing?: boolean;
    companyMissing?: boolean;
    planError?: unknown;
    source?: unknown;
    sourceError?: unknown;
  } = {}
) {
  const company = {
    subscription_type: params.subscriptionType ?? "pro",
  };
  const workspaceQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockImplementation(async () => ({
      data: params.workspaceMissing
        ? null
        : {
            company_id: "company-1",
            companies: params.companyMissing
              ? null
              : params.companyAsArray
                ? [company]
                : company,
          },
      error: params.planError ?? null,
    })),
  };
  const sourceQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({
      data:
        params.source === undefined
          ? {
              id: "elevenlabs-source-1",
              credentials: {
                api_key: "workspace-secret",
                default_voice_id: "voice-1",
              },
            }
          : params.source,
      error: params.sourceError ?? null,
    }),
  };
  const from = jest.fn((table: string) => {
    if (table === "workspaces") return workspaceQuery;
    if (table === "sources") return sourceQuery;
    throw new Error(`Unexpected table: ${table}`);
  });
  return {
    supabase: { from } as never,
    from,
    company,
    workspaceQuery,
    sourceQuery,
  };
}

afterEach(() => {
  jest.clearAllMocks();
  if (originalPlatformKey === undefined) {
    delete process.env.ELEVENLABS_API_KEY;
  } else {
    process.env.ELEVENLABS_API_KEY = originalPlatformKey;
  }
});

describe("WhatsApp voice reply access", () => {
  it.each(["pro", "enterprise"])(
    "allows %s with the workspace ElevenLabs source",
    async subscriptionType => {
      const client = createSourceClient({ subscriptionType });
      const access = await resolveWorkspaceVoiceReplyAccess({
        workspaceId,
        supabase: client.supabase,
      });

      expect(access).toEqual({
        available: true,
        reason: null,
        apiKey: "workspace-secret",
        defaultVoiceId: "voice-1",
      });
      expect(client.workspaceQuery.eq).toHaveBeenCalledWith("id", workspaceId);
      expect(client.sourceQuery.eq).toHaveBeenCalledWith(
        "workspace_id",
        workspaceId
      );
      expect(client.sourceQuery.eq).toHaveBeenCalledWith("type", "elevenlabs");
    }
  );

  it.each(["free", "unknown", "PRO"])(
    "requires an upgrade for %s even with workspace credentials",
    async subscriptionType => {
      const client = createSourceClient({ subscriptionType });
      const access = await resolveWorkspaceVoiceReplyAccess({
        workspaceId,
        supabase: client.supabase,
      });

      expect(access).toEqual({
        available: false,
        reason: "subscription_required",
        apiKey: null,
        defaultVoiceId: null,
      });
      expect(client.from).not.toHaveBeenCalledWith("sources");
    }
  );

  it("uses the current company plan after a downgrade", async () => {
    const client = createSourceClient();
    const params = { workspaceId, supabase: client.supabase };
    expect((await resolveWorkspaceVoiceReplyAccess(params)).available).toBe(
      true
    );

    client.company.subscription_type = "free";

    expect(await resolveWorkspaceVoiceReplyAccess(params)).toEqual({
      available: false,
      reason: "subscription_required",
      apiKey: null,
      defaultVoiceId: null,
    });
  });

  it("supports the canonical joined company array shape", async () => {
    const client = createSourceClient({ companyAsArray: true });
    expect(
      (
        await resolveWorkspaceVoiceReplyAccess({
          workspaceId,
          supabase: client.supabase,
        })
      ).available
    ).toBe(true);
  });

  it.each([undefined, "platform-secret"])(
    "requires a workspace source when the platform key is %s",
    async platformKey => {
      if (platformKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = platformKey;
      const client = createSourceClient({ source: null });

      expect(
        await resolveWorkspaceVoiceReplyAccess({
          workspaceId,
          supabase: client.supabase,
        })
      ).toEqual({
        available: false,
        reason: "elevenlabs_required",
        apiKey: null,
        defaultVoiceId: null,
      });
    }
  );

  it("rejects an empty workspace key despite a configured platform key", async () => {
    process.env.ELEVENLABS_API_KEY = "platform-secret";
    const client = createSourceClient({
      source: { id: "source-1", credentials: { api_key: "  " } },
    });

    expect(
      await resolveWorkspaceVoiceReplyAccess({
        workspaceId,
        supabase: client.supabase,
      })
    ).toEqual({
      available: false,
      reason: "elevenlabs_required",
      apiKey: null,
      defaultVoiceId: null,
    });
  });

  it("reuses canonical source credential aliases and allows no default voice", async () => {
    const client = createSourceClient({
      source: {
        id: "source-1",
        credentials: { apiKey: "  workspace-secret  " },
      },
    });

    expect(
      await resolveWorkspaceVoiceReplyAccess({
        workspaceId,
        supabase: client.supabase,
      })
    ).toEqual({
      available: true,
      reason: null,
      apiKey: "workspace-secret",
      defaultVoiceId: null,
    });
  });

  it.each([
    { workspaceMissing: true },
    { companyMissing: true },
    { planError: { message: "database-secret" } },
  ])(
    "throws safely when the company plan cannot be verified: %j",
    async params => {
      const client = createSourceClient(params);

      await expect(
        resolveWorkspaceVoiceReplyAccess({
          workspaceId,
          supabase: client.supabase,
        })
      ).rejects.toThrow("Voice reply subscription could not be verified");
      expect(client.from).not.toHaveBeenCalledWith("sources");
    }
  );

  // A failed lookup is not "no source": it throws a sanitized error (callers
  // fall back to text) and never reaches the platform key.
  it("fails closed on a source lookup failure without using platform credentials", async () => {
    process.env.ELEVENLABS_API_KEY = "platform-secret";
    const client = createSourceClient({
      sourceError: { message: "database-secret" },
    });

    const error = await resolveWorkspaceVoiceReplyAccess({
      workspaceId,
      supabase: client.supabase,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "ElevenLabs source could not be loaded."
    );
    expect(String(error)).not.toContain("database-secret");
    expect(String(error)).not.toContain("platform-secret");
  });

  it("sanitizes a thrown subscription lookup failure", async () => {
    const client = createSourceClient();
    client.workspaceQuery.maybeSingle.mockRejectedValue(
      new Error("database-secret")
    );

    await expect(
      resolveWorkspaceVoiceReplyAccess({
        workspaceId,
        supabase: client.supabase,
      })
    ).rejects.toThrow("Voice reply subscription could not be verified");
  });

  it("uses the cookie-free admin client when no client is provided", async () => {
    const client = createSourceClient();
    jest.mocked(supabaseAdmin.from).mockImplementation(client.from as never);

    expect(await resolveWorkspaceVoiceReplyAccess({ workspaceId })).toEqual({
      available: true,
      reason: null,
      apiKey: "workspace-secret",
      defaultVoiceId: "voice-1",
    });
  });

  it("recognizes only eligible paid subscriptions", () => {
    expect(isVoiceReplySubscriptionEligible("pro")).toBe(true);
    expect(isVoiceReplySubscriptionEligible("enterprise")).toBe(true);
    for (const value of ["free", "PRO", "unknown", null, undefined, true]) {
      expect(isVoiceReplySubscriptionEligible(value)).toBe(false);
    }
  });
});

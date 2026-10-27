import {
  fetchSourceWithCredentials,
  fetchSourceWithCredentialsResult,
} from "@/lib/sources/utils";
import {
  clearWhatsAppSendContextCache,
  resolveFreshWhatsAppSendContext,
  resolveWhatsAppSendContext,
  resolveWhatsAppSendContextResult,
} from "./send-context";

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: jest.fn(),
  fetchSourceWithCredentialsResult: jest.fn(),
}));

describe("resolveWhatsAppSendContext", () => {
  beforeEach(() => {
    (fetchSourceWithCredentialsResult as jest.Mock).mockImplementation(
      async (...args: unknown[]) => ({
        ok: true,
        source: await (fetchSourceWithCredentials as jest.Mock)(...args),
      })
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    clearWhatsAppSendContextCache({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
  });

  it("does not return a Cloud API send context while coexistence reonboarding is paused", async () => {
    (fetchSourceWithCredentials as jest.Mock).mockResolvedValue({
      id: "source-offboarded",
      workspace_id: "workspace-1",
      credentials: {
        access_token: "token",
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        coexistence_mode: true,
        coexistence_reonboarding_status: "offboarded",
        cloud_api_messaging_suspended: true,
      },
    });

    await expect(
      resolveWhatsAppSendContext({ sourceId: "source-offboarded" })
    ).resolves.toBeNull();
  });

  it("does not return a Cloud API send context after partner app access is removed", async () => {
    (fetchSourceWithCredentials as jest.Mock).mockResolvedValue({
      id: "source-removed",
      workspace_id: "workspace-1",
      credentials: {
        access_token: "token",
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        coexistence_mode: true,
        coexistence_reonboarding_status: "removed",
      },
    });

    await expect(
      resolveWhatsAppSendContext({ sourceId: "source-removed" })
    ).resolves.toBeNull();
  });

  it("exposes the Messaging Account ID when the source has one", async () => {
    (fetchSourceWithCredentials as jest.Mock).mockResolvedValue({
      id: "source-1",
      workspace_id: "workspace-1",
      credentials: {
        access_token: "token",
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        messaging_account_id: "messaging-1",
      },
    });

    await expect(
      resolveWhatsAppSendContext({ sourceId: "source-1" })
    ).resolves.toMatchObject({
      messagingAccountId: "messaging-1",
    });
  });

  it("rejects an explicit source owned by another workspace without falling back", async () => {
    (fetchSourceWithCredentials as jest.Mock).mockResolvedValue({
      id: "source-1",
      workspace_id: "workspace-2",
      credentials: {
        access_token: "token",
        phone_number_id: "phone-1",
      },
    });

    await expect(
      resolveWhatsAppSendContext({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).resolves.toBeNull();

    expect(fetchSourceWithCredentials).toHaveBeenCalledTimes(1);
    expect(fetchSourceWithCredentials).toHaveBeenCalledWith(
      "source-1",
      "whatsapp"
    );
  });

  it("does not reuse an explicit-source cache entry across workspaces", async () => {
    (fetchSourceWithCredentials as jest.Mock).mockResolvedValue({
      id: "source-1",
      workspace_id: "workspace-1",
      credentials: {
        access_token: "token",
        phone_number_id: "phone-1",
        waba_id: "waba-1",
      },
    });

    await expect(
      resolveWhatsAppSendContext({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).resolves.toMatchObject({ workspaceId: "workspace-1" });
    await expect(
      resolveWhatsAppSendContext({
        workspaceId: "workspace-2",
        sourceId: "source-1",
      })
    ).resolves.toBeNull();

    expect(fetchSourceWithCredentials).toHaveBeenCalledTimes(1);
  });

  it("bypasses a cached credential when bulk dispatch requests a fresh source context", async () => {
    (fetchSourceWithCredentials as jest.Mock)
      .mockResolvedValueOnce({
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "stale-token",
          phone_number_id: "phone-1",
          waba_id: "waba-1",
        },
      })
      .mockResolvedValueOnce(null);

    await expect(
      resolveWhatsAppSendContext({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).resolves.toMatchObject({ accessToken: "stale-token" });
    await expect(
      resolveFreshWhatsAppSendContext({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).resolves.toBeNull();

    expect(fetchSourceWithCredentials).toHaveBeenCalledTimes(2);
  });

  it("rejects a source record whose identity does not match the explicit source", async () => {
    (fetchSourceWithCredentials as jest.Mock).mockResolvedValue({
      id: "source-other",
      workspace_id: "workspace-1",
      credentials: {
        access_token: "token",
        phone_number_id: "phone-1",
      },
    });

    await expect(
      resolveWhatsAppSendContext({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).resolves.toBeNull();
  });

  it.each([
    [undefined, undefined],
    ["2026-09-11T10:00:00Z", "2026-09-11T10:00:00.000Z"],
    ["2026-09-11T15:00:00+05:00", "2026-09-11T10:00:00.000Z"],
    ["2026-09-11", null],
    ["invalid", null],
    ["2026-99-99T99:99:99Z", null],
    ["2026-09-11T10:00:00+99:99", null],
    [null, null],
    [42, null],
  ])(
    "retains the raw disabled-config binding boundary %j",
    async (boundary, expected) => {
      (fetchSourceWithCredentials as jest.Mock).mockResolvedValue({
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "token",
          phone_number_id: "phone-1",
          waba_id: "222",
          conversions_api: {
            enabled: false,
            ...(boundary === undefined
              ? {}
              : { attribution_boundary_at: boundary }),
          },
        },
      });
      const result = await resolveWhatsAppSendContextResult({
        sourceId: "source-1",
      });
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.context.attributionBoundaryAt).toBe(expected);
    }
  );

  it("distinguishes source query failures from confirmed source unavailability", async () => {
    const queryError = new Error("sources query unavailable");
    (fetchSourceWithCredentialsResult as jest.Mock).mockResolvedValue({
      ok: false,
      error: queryError,
    });

    await expect(
      resolveWhatsAppSendContextResult({
        workspaceId: "workspace-1",
        sourceId: "source-query-failure",
      })
    ).resolves.toEqual({
      ok: false,
      kind: "query_error",
      error: queryError,
    });

    (fetchSourceWithCredentialsResult as jest.Mock).mockResolvedValue({
      ok: true,
      source: null,
    });
    await expect(
      resolveWhatsAppSendContextResult({
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

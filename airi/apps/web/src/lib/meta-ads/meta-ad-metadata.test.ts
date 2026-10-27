import {
  clearMetaAdMetadataCacheForTests,
  fetchMetaAdMetadata,
  resolveMetaAdMetadataForWorkspace,
} from "./meta-ad-metadata";
import { supabaseAdmin } from "@/lib/supabase/admin";

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) =>
    typeof value === "string" ? value : null,
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@icecore/shared/lib/logger", () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLogError(...args),
  }),
}));

const from = jest.mocked(supabaseAdmin.from);
const mockLogError = jest.fn();
const fetchMock = jest.fn();
const originalFetch = global.fetch;

describe("campaign referral metadata recovery", () => {
  beforeEach(() => {
    clearMetaAdMetadataCacheForTests();
    fetchMock.mockReset();
    mockLogError.mockClear();
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  function sources(rows: unknown[]) {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: rows }),
    };
    from.mockReturnValue(query as never);
  }

  it("resolves immediately after reconnect instead of retaining a ten-minute missing-token result", async () => {
    sources([]);
    const request = { workspaceId: "workspace-1", adId: "123" };
    expect(await resolveMetaAdMetadataForWorkspace(request)).toBeNull();
    sources([{ credentials: { access_token: "renewed-token" } }]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "123",
        campaign_id: "campaign-1",
        account_id: "42",
        campaign: {
          id: "campaign-1",
          name: "Launch",
          account_id: "42",
          adlabels: { data: [{ id: "label-1", name: "Product" }] },
        },
      }),
    });
    expect(await resolveMetaAdMetadataForWorkspace(request)).toEqual({
      campaignId: "campaign-1",
      campaignName: "Launch",
      adAccountId: "act_42",
      campaignLabels: [{ id: "label-1", name: "Product" }],
      campaignLabelStatus: "present",
    });
  });

  it("retries transient failures but retains successful metadata within its workspace", async () => {
    sources([{ credentials: { access_token: "token" } }]);
    fetchMock
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "123",
          campaign_id: "campaign-1",
          account_id: "42",
          campaign: {
            id: "campaign-1",
            account_id: "42",
            adlabels: { data: [] },
          },
        }),
      });
    const request = { workspaceId: "workspace-1", adId: "123" };
    expect(await resolveMetaAdMetadataForWorkspace(request)).toBeNull();
    expect(await resolveMetaAdMetadataForWorkspace(request)).toEqual({
      campaignId: "campaign-1",
      adAccountId: "act_42",
      campaignLabels: [],
      campaignLabelStatus: "absent",
    });
    await resolveMetaAdMetadataForWorkspace(request);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await resolveMetaAdMetadataForWorkspace({
      ...request,
      workspaceId: "workspace-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not cache an incomplete label payload as untagged", async () => {
    sources([{ credentials: { access_token: "token" } }]);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "123",
          campaign_id: "campaign-1",
          campaign: {
            id: "campaign-1",
            adlabels: { data: [], paging: { next: "more" } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "123",
          account_id: "42",
          campaign: {
            id: "campaign-1",
            account_id: "42",
            adlabels: { data: [] },
          },
        }),
      });
    const request = { workspaceId: "workspace-1", adId: "123" };
    expect(
      (await resolveMetaAdMetadataForWorkspace(request))?.campaignLabelStatus
    ).toBe("unavailable");
    expect(
      (await resolveMetaAdMetadataForWorkspace(request))?.campaignLabelStatus
    ).toBe("absent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ad metadata lookup failure diagnostics", () => {
  const accessToken = "private-token-that-must-not-be-logged";
  const request = { adId: "123", accessToken };

  beforeEach(() => {
    fetchMock.mockReset();
    mockLogError.mockClear();
    global.fetch = fetchMock;
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it.each([
    { status: 403, code: 200, failureKind: "permission" },
    { status: 400, code: 190, failureKind: "permission" },
    { status: 400, code: 10, failureKind: "permission" },
    { status: 401, code: undefined, failureKind: "permission" },
    { status: 429, code: 4, failureKind: "http" },
    { status: 500, code: 2, failureKind: "http" },
  ])(
    "distinguishes $status / $code failures without logging provider text",
    async ({ status, code, failureKind }) => {
      fetchMock.mockResolvedValue({
        ok: false,
        status,
        json: async () => ({
          error: {
            code,
            error_subcode: 33,
            is_transient: true,
            message: `Request with access_token=${accessToken} failed`,
            type: accessToken,
            fbtrace_id: accessToken,
          },
        }),
      });

      expect(await fetchMetaAdMetadata(request)).toBeNull();
      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(
        "meta_ad_metadata_lookup_failed",
        undefined,
        expect.objectContaining({
          adId: "123",
          failureKind,
          httpStatus: status,
          ...(code === undefined ? {} : { providerCode: code }),
          providerSubcode: 33,
          providerTransient: true,
          durationMs: expect.any(Number),
        })
      );
      expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(
        accessToken
      );
      expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(
        "access_token"
      );
    }
  );

  it.each([null, [], { id: 123 }, { error: { message: accessToken } }])(
    "reports malformed successful payloads without logging the body: %p",
    async payload => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      });
      expect(await fetchMetaAdMetadata(request)).toBeNull();
      expect(mockLogError).toHaveBeenCalledWith(
        "meta_ad_metadata_lookup_failed",
        undefined,
        expect.objectContaining({ failureKind: "malformed", httpStatus: 200 })
      );
      expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(
        accessToken
      );
    }
  );

  it("retains HTTP classification when the error body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError(accessToken);
      },
    });
    expect(await fetchMetaAdMetadata(request)).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "meta_ad_metadata_lookup_failed",
      undefined,
      expect.objectContaining({ failureKind: "http", httpStatus: 502 })
    );
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(accessToken);
  });

  it("reports transport failures without serializing request URLs or error objects", async () => {
    fetchMock.mockRejectedValue(
      new Error(`https://graph.facebook.com/123?access_token=${accessToken}`)
    );
    expect(await fetchMetaAdMetadata(request)).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "meta_ad_metadata_lookup_failed",
      undefined,
      expect.objectContaining({ adId: "123", failureKind: "transport" })
    );
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(accessToken);
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain("https://");
  });

  it("distinguishes an interrupted response body from malformed JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new TypeError(accessToken);
      },
    });
    expect(await fetchMetaAdMetadata(request)).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "meta_ad_metadata_lookup_failed",
      undefined,
      expect.objectContaining({ failureKind: "transport", httpStatus: 200 })
    );
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(accessToken);
  });

  it("reports malformed JSON in a successful response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError(accessToken);
      },
    });
    expect(await fetchMetaAdMetadata(request)).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "meta_ad_metadata_lookup_failed",
      undefined,
      expect.objectContaining({ failureKind: "malformed", httpStatus: 200 })
    );
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(accessToken);
  });

  it.each([false, true])(
    "reports the request deadline, including while reading its body (%s)",
    async duringBody => {
      jest.useFakeTimers();
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        const aborted = new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(new Error(accessToken)),
            { once: true }
          );
        });
        return duringBody
          ? Promise.resolve({ ok: true, status: 200, json: () => aborted })
          : aborted;
      });
      const result = fetchMetaAdMetadata(request);
      await jest.advanceTimersByTimeAsync(5000);
      expect(await result).toBeNull();
      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(
        "meta_ad_metadata_lookup_failed",
        undefined,
        expect.objectContaining({
          adId: "123",
          failureKind: "timeout",
          durationMs: 5000,
        })
      );
      expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(
        accessToken
      );
    }
  );

  it("does not turn an incomplete label response into an untagged campaign", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "123",
        campaign_id: "456",
        account_id: "42",
        campaign: {},
      }),
    });
    expect(await fetchMetaAdMetadata(request)).toEqual({
      campaignId: "456",
      adAccountId: "act_42",
      campaignLabels: [],
      campaignLabelStatus: "unavailable",
    });
    expect(mockLogError).toHaveBeenCalledWith(
      "meta_ad_metadata_lookup_failed",
      undefined,
      expect.objectContaining({
        failureKind: "incomplete",
        campaignLabelStatus: "unavailable",
      })
    );
  });
});

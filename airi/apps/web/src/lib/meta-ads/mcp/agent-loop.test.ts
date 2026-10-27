jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: string[]) =>
    [namespace, ...parts].join(":"),
  cache: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
  },
}));

jest.mock("@/lib/airi-chats/meta-ads-mcp-confirmation-store", () => ({
  listAiriMetaAdsMcpPendingTransactions: jest.fn(),
}));

const mockReadAccountAccess = jest.fn();
jest.mock("./account-access", () => ({
  readMetaAdsMcpAccountAccess: (...args: unknown[]) =>
    mockReadAccountAccess(...args),
}));

const mockLoadMetaAdsMcpCreativeAssetReferences = jest.fn();
const mockMaterializeMetaAdsMcpMutationArguments = jest.fn();

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: jest.fn(async () => "company-1"),
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) =>
    typeof value === "string" ? value : "mcp-token",
}));

jest.mock("./creative-assets", () => ({
  loadMetaAdsMcpCreativeAssetReferences: (...args: unknown[]) =>
    mockLoadMetaAdsMcpCreativeAssetReferences(...args),
  buildMetaAdsMcpCreativeAssetContext: jest.fn(),
  materializeMetaAdsMcpCreativeAssetArguments: jest.fn(),
  materializeMetaAdsMcpMutationArguments: (...args: unknown[]) =>
    mockMaterializeMetaAdsMcpMutationArguments(...args),
}));

jest.mock("./client", () => {
  class MetaAdsMcpClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  class MetaAdsMcpToolResultError extends Error {
    readonly toolName: string;
    readonly result: unknown;

    constructor(toolName: string, message: string, result: unknown) {
      super(message);
      this.name = "MetaAdsMcpToolResultError";
      this.toolName = toolName;
      this.result = result;
    }
  }

  return {
    MetaAdsMcpClientError,
    MetaAdsMcpToolResultError,
    createMetaAdsMcpSession: jest.fn((token: string) => ({
      accessToken: token,
      sessionId: null,
      nextId: 1,
    })),
    initializeMetaAdsMcpSession: jest.fn(async () => undefined),
    listMetaAdsMcpTools: jest.fn(),
    callMetaAdsMcpTool: jest.fn(),
    closeMetaAdsMcpSession: jest.fn(async () => undefined),
  };
});

import {
  callMetaAdsMcpTool,
  listMetaAdsMcpTools,
  MetaAdsMcpToolResultError,
  type MetaAdsMcpCatalog,
  type MetaAdsMcpTool,
} from "./client";
import { prepareMetaAdsMcpTransaction } from "./confirmation-contract.server";
import { META_ADS_MCP_WRITE_REQUIRED_SCOPES } from "../meta-ads-mcp-readiness";
import { executeConfirmedMetaAdsMcpMutation } from "./agent-loop";

// runMetaAdsMcpTurn (native Claude tool use) is covered in native-turn.test.ts.

const DEFINITION_SHA256 = "a".repeat(64);
const CATALOG_SHA256 = "b".repeat(64);
const EFFECTIVE_ARGUMENTS_SHA256 = "c".repeat(64);

function createTool(
  name: string,
  inputSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: true,
  },
  description?: string
): MetaAdsMcpTool {
  return {
    name,
    ...(description ? { description } : {}),
    inputSchema,
    definitionSha256: DEFINITION_SHA256,
  };
}

function createCatalog(tools: MetaAdsMcpTool[]): MetaAdsMcpCatalog {
  return {
    tools,
    catalogSha256: CATALOG_SHA256,
    canonicalSizeBytes: 1_024,
    protocol: {
      era: "legacy",
      protocolVersion: "2025-06-18",
      serverName: "meta-ads-mcp-test",
      serverVersion: "1.0.0",
      capabilities: { tools: {} },
    },
  };
}

function createMutation(params: {
  id: string;
  toolName: string;
  logicalArguments: Record<string, unknown>;
  summary: string;
  creativeAssets?: Array<{ id: string; kind: string; name: string }>;
  preparedAt?: string;
}) {
  return prepareMetaAdsMcpTransaction({
    id: params.id,
    preparedAt: params.preparedAt ?? new Date().toISOString(),
    target: {
      sourceId: "source-1",
      connectionId: "connection-1",
      mcpUserId: "mcp-user-1",
      adAccountId: "act_123",
      currency: "USD",
    },
    tool: {
      name: params.toolName,
      definitionSha256: DEFINITION_SHA256,
      catalogSha256: CATALOG_SHA256,
    },
    logicalArguments: params.logicalArguments,
    summary: params.summary,
    creativeAssets: params.creativeAssets ?? [],
  });
}

function readySupabase(
  connectionId = () => "connection-1",
  selectedAccountEnabled?: boolean,
  selectedAccountQueryable?: boolean
) {
  const now = new Date().toISOString();
  type Query = {
    select(columns: string): Query;
    eq(column: string, value: string): Query;
    order(column: string, options: { ascending: boolean }): Query;
    limit(value: number): Query;
    maybeSingle(): Promise<{
      data: { id: string; credentials: Record<string, unknown> };
      error: null;
    }>;
  };
  const query: Query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({
      data: {
        id: "source-1",
        company_id: "company-1",
        updated_at: now,
        credentials: {
          access_token: "graph-token",
          mcp_access_token: "mcp-token",
          mcp_connection_id: connectionId(),
          mcp_user_id: "mcp-user-1",
          mcp_scope: META_ADS_MCP_WRITE_REQUIRED_SCOPES.join(" "),
          mcp_scopes_verified_at: now,
          mcp_expires_at: "2099-01-01T00:00:00.000Z",
          selected_ad_account_id: "act_123",
          mcp_selected_ad_account: { id: "act_123", currency: "USD" },
          mcp_ad_account_ids: ["act_123"],
          mcp_assets_checked_at: now,
          mcp_provider_probe: {
            checkedAt: now,
            outcome: "success",
            warnings: [],
            ...(selectedAccountEnabled !== undefined
              ? { selectedAccountEnabled }
              : {}),
            ...(selectedAccountQueryable !== undefined
              ? { selectedAccountQueryable }
              : {}),
          },
        },
      },
      error: null,
    }),
  };
  return { from: () => query };
}

describe("executeConfirmedMetaAdsMcpMutation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadAccountAccess.mockReset().mockResolvedValue({
      complete: true,
      inventory: {
        ad_accounts: [
          {
            ad_account_id: "123",
            is_ads_mcp_enabled: true,
            is_queryable: true,
          },
        ],
      },
    });
    (listMetaAdsMcpTools as jest.Mock).mockResolvedValue(
      createCatalog([
        createTool("ads_get_ad_accounts", undefined, "List ad accounts"),
        createTool("ads_create_campaign", undefined, "Create a campaign"),
      ])
    );
    (callMetaAdsMcpTool as jest.Mock)
      .mockReset()
      .mockImplementation(
        async (params: { tool: MetaAdsMcpTool; onDispatch?: () => void }) => {
          params.onDispatch?.();
          return { ok: true, tool: params.tool.name };
        }
      );
    mockLoadMetaAdsMcpCreativeAssetReferences.mockReset().mockResolvedValue([]);
    mockMaterializeMetaAdsMcpMutationArguments
      .mockReset()
      .mockImplementation(async ({ arguments: logicalArguments }) => ({
        effectiveArguments: logicalArguments,
        effectiveArgumentsSha256: EFFECTIVE_ARGUMENTS_SHA256,
        materializedCreativeAssetIds: [],
      }));
  });

  it("marks a write-call transport failure as an unknown provider outcome", async () => {
    (callMetaAdsMcpTool as jest.Mock).mockImplementationOnce(
      async (params: { onDispatch?: () => void }) => {
        params.onDispatch?.();
        throw new Error("Meta Ads MCP HTTP 504");
      }
    );

    const result = await executeConfirmedMetaAdsMcpMutation({
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      mutation: createMutation({
        id: "meta-mcp-mutation-1",
        toolName: "ads_create_campaign",
        logicalArguments: { name: "Launch" },
        summary: "Create the Launch campaign",
      }),
    });

    expect(result).toEqual({
      ok: false,
      outcome: "outcome_unknown",
      dispatchStarted: true,
      error:
        "The Meta Ads write was sent, but Airi could not verify its outcome. Review Meta Ads Manager before taking another action.",
      effectiveArgumentsSha256: EFFECTIVE_ARGUMENTS_SHA256,
      materializedCreativeAssetIds: [],
    });
  });

  it("refreshes Creative Asset URLs when a confirmed write executes", async () => {
    const assetId = "507f1f77bcf86cd799439011";
    mockLoadMetaAdsMcpCreativeAssetReferences.mockResolvedValueOnce([
      { id: assetId, kind: "image", name: "launch.jpg" },
    ]);
    mockMaterializeMetaAdsMcpMutationArguments.mockResolvedValueOnce({
      effectiveArguments: {
        image_url: "https://signed.example/fresh-launch.jpg",
      },
      effectiveArgumentsSha256: EFFECTIVE_ARGUMENTS_SHA256,
      materializedCreativeAssetIds: [assetId],
    });

    await executeConfirmedMetaAdsMcpMutation({
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      mutation: createMutation({
        id: "meta-mcp-mutation-asset",
        toolName: "ads_create_campaign",
        logicalArguments: {
          image_url: `airi://creative-assets/${assetId}`,
        },
        summary: "Create launch campaign",
        creativeAssets: [{ id: assetId, kind: "image", name: "launch.jpg" }],
      }),
    });

    expect(mockMaterializeMetaAdsMcpMutationArguments).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      arguments: {
        image_url: `airi://creative-assets/${assetId}`,
      },
    });
    expect(callMetaAdsMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: expect.objectContaining({ name: "ads_create_campaign" }),
        arguments: {
          image_url: "https://signed.example/fresh-launch.jpg",
        },
      })
    );
  });

  it("accepts reviewed local creative handles for an HTTPS-only confirmed tool", async () => {
    const assetId = "507f1f77bcf86cd799439011";
    (listMetaAdsMcpTools as jest.Mock).mockResolvedValueOnce(
      createCatalog([
        createTool("ads_create_ad", {
          type: "object",
          properties: {
            image_url: { type: "string", pattern: "^https://", maxLength: 120 },
          },
          required: ["image_url"],
          additionalProperties: false,
        }),
      ])
    );
    mockLoadMetaAdsMcpCreativeAssetReferences.mockResolvedValueOnce([
      { id: assetId, kind: "image", name: "launch.jpg" },
    ]);
    mockMaterializeMetaAdsMcpMutationArguments.mockResolvedValueOnce({
      effectiveArguments: { image_url: "https://signed.example/launch.jpg" },
      effectiveArgumentsSha256: EFFECTIVE_ARGUMENTS_SHA256,
      materializedCreativeAssetIds: [assetId],
    });

    const result = await executeConfirmedMetaAdsMcpMutation({
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      mutation: createMutation({
        id: "local-creative-confirmation",
        toolName: "ads_create_ad",
        logicalArguments: { image_url: `airi://creative-assets/${assetId}` },
        summary: "Create the ad using launch.jpg",
        creativeAssets: [{ id: assetId, kind: "image", name: "launch.jpg" }],
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "succeeded",
      dispatchStarted: true,
    });
    expect(callMetaAdsMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { image_url: "https://signed.example/launch.jpg" },
      })
    );
  });

  it.each([
    "http://signed.example/launch.jpg",
    `https://signed.example/${"x".repeat(121)}`,
  ])(
    "rejects materialized creative arguments violating the tool contract before dispatch (%s)",
    async imageUrl => {
      const assetId = "507f1f77bcf86cd799439011";
      (listMetaAdsMcpTools as jest.Mock).mockResolvedValueOnce(
        createCatalog([
          createTool("ads_create_ad", {
            type: "object",
            properties: {
              image_url: {
                type: "string",
                pattern: "^(airi://creative-assets/|https://)",
                maxLength: 120,
              },
            },
            required: ["image_url"],
            additionalProperties: false,
          }),
        ])
      );
      mockLoadMetaAdsMcpCreativeAssetReferences.mockResolvedValueOnce([
        { id: assetId, kind: "image", name: "launch.jpg" },
      ]);
      mockMaterializeMetaAdsMcpMutationArguments.mockResolvedValueOnce({
        effectiveArguments: { image_url: imageUrl },
        effectiveArgumentsSha256: EFFECTIVE_ARGUMENTS_SHA256,
        materializedCreativeAssetIds: [assetId],
      });

      const result = await executeConfirmedMetaAdsMcpMutation({
        supabase: readySupabase() as never,
        workspaceId: "workspace-1",
        mutation: createMutation({
          id: "invalid-materialized-creative",
          toolName: "ads_create_ad",
          logicalArguments: { image_url: `airi://creative-assets/${assetId}` },
          summary: "Create the ad using launch.jpg",
          creativeAssets: [{ id: assetId, kind: "image", name: "launch.jpg" }],
        }),
      });

      expect(result).toMatchObject({
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
      });
      expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
    }
  );

  it("reports local Creative Asset resolution failures as not executed", async () => {
    mockLoadMetaAdsMcpCreativeAssetReferences.mockResolvedValueOnce([
      {
        id: "507f1f77bcf86cd799439011",
        kind: "image",
        name: "launch.jpg",
      },
    ]);
    mockMaterializeMetaAdsMcpMutationArguments.mockRejectedValueOnce(
      new Error("Creative asset is not available in this workspace")
    );

    const result = await executeConfirmedMetaAdsMcpMutation({
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      mutation: createMutation({
        id: "meta-mcp-mutation-missing-asset",
        toolName: "ads_create_campaign",
        logicalArguments: {
          image_url: "airi://creative-assets/507f1f77bcf86cd799439011",
        },
        summary: "Create launch campaign",
        creativeAssets: [
          {
            id: "507f1f77bcf86cd799439011",
            kind: "image",
            name: "launch.jpg",
          },
        ],
      }),
    });

    expect(result).toEqual({
      ok: false,
      outcome: "not_executed",
      dispatchStarted: false,
      error: "Creative asset is not available in this workspace",
    });
    expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
  });

  it("rejects schema-invalid confirmed arguments before provider execution", async () => {
    (listMetaAdsMcpTools as jest.Mock).mockResolvedValueOnce(
      createCatalog([
        createTool("ads_create_campaign", {
          type: "object",
          properties: { name: { type: "string", minLength: 1 } },
          required: ["name"],
          additionalProperties: false,
        }),
      ])
    );

    const result = await executeConfirmedMetaAdsMcpMutation({
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      mutation: createMutation({
        id: "meta-mcp-invalid-confirmation",
        toolName: "ads_create_campaign",
        logicalArguments: {},
        summary: "Create a campaign",
      }),
    });

    expect(result).toEqual({
      ok: false,
      outcome: "not_executed",
      dispatchStarted: false,
      error: expect.stringMatching(/name/i),
    });
    expect(mockMaterializeMetaAdsMcpMutationArguments).not.toHaveBeenCalled();
    expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
  });

  it("marks an MCP isError result after dispatch as an unknown provider outcome", async () => {
    (callMetaAdsMcpTool as jest.Mock).mockImplementationOnce(
      async (params: { onDispatch?: () => void }) => {
        params.onDispatch?.();
        throw new MetaAdsMcpToolResultError(
          "ads_create_campaign",
          "Invalid campaign objective",
          { isError: true }
        );
      }
    );

    const result = await executeConfirmedMetaAdsMcpMutation({
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      mutation: createMutation({
        id: "meta-mcp-mutation-2",
        toolName: "ads_create_campaign",
        logicalArguments: { objective: "INVALID" },
        summary: "Create the Launch campaign",
      }),
    });

    expect(result).toEqual({
      ok: false,
      outcome: "outcome_unknown",
      dispatchStarted: true,
      error:
        "The Meta Ads write was sent, but Airi could not verify its outcome. Review Meta Ads Manager before taking another action.",
      effectiveArgumentsSha256: EFFECTIVE_ARGUMENTS_SHA256,
      materializedCreativeAssetIds: [],
    });
  });

  it.each(["rollout_disabled", "incomplete_inventory"])(
    "does not dispatch a confirmed write when %s",
    async reason => {
      mockReadAccountAccess.mockResolvedValueOnce({
        complete: reason !== "incomplete_inventory",
        inventory: {
          ad_accounts: [{ ad_account_id: "123", is_ads_mcp_enabled: false }],
        },
      });
      const result = await executeConfirmedMetaAdsMcpMutation({
        supabase: readySupabase() as never,
        workspaceId: "workspace-1",
        mutation: createMutation({
          id: "rollout-blocked-write",
          toolName: "ads_create_campaign",
          logicalArguments: { name: "Spring" },
          summary: "Create paused campaign",
        }),
      });
      expect(result).toMatchObject({
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
      });
      expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
      if (!result.ok)
        expect(result.error).toMatch(
          reason === "rollout_disabled"
            ? /gradually rolling out/
            : /could not verify/
        );
    }
  );

  it("rechecks the exact connection immediately before a confirmed write", async () => {
    let connection = "connection-1";
    (listMetaAdsMcpTools as jest.Mock).mockImplementationOnce(async () => {
      connection = "reconnected-connection";
      return createCatalog([createTool("ads_create_campaign")]);
    });
    const result = await executeConfirmedMetaAdsMcpMutation({
      supabase: readySupabase(() => connection) as never,
      workspaceId: "workspace-1",
      mutation: createMutation({
        id: "changed-before-send",
        toolName: "ads_create_campaign",
        logicalArguments: { name: "Spring" },
        summary: "Create paused campaign",
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      outcome: "not_executed",
      dispatchStarted: false,
    });
    expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
  });

  it("never dispatches an expired prepared write", async () => {
    const result = await executeConfirmedMetaAdsMcpMutation({
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      mutation: createMutation({
        id: "expired-write",
        toolName: "ads_create_campaign",
        logicalArguments: { name: "Spring" },
        summary: "Create paused campaign",
        preparedAt: new Date(Date.now() - 46 * 60 * 1_000).toISOString(),
      }),
    });
    expect(result).toEqual({
      ok: false,
      outcome: "not_executed",
      dispatchStarted: false,
      error: "The prepared Meta Ads change expired before it was confirmed.",
    });
    expect(listMetaAdsMcpTools).not.toHaveBeenCalled();
    expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
  });
});

jest.mock("@/lib/meta/debug-token", () => ({
  debugConfiguredMetaAccessToken: jest.fn(),
}));
jest.mock("./client", () => ({
  ...jest.requireActual("./client"),
  createMetaAdsMcpSession: jest.fn(() => ({ closed: false })),
  initializeMetaAdsMcpSession: jest.fn(),
  listMetaAdsMcpTools: jest.fn(),
  callMetaAdsMcpTool: jest.fn(),
  closeMetaAdsMcpSession: jest.fn(),
}));

import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import * as client from "./client";
import { runMetaAdsMcpReadTest } from "./read-test";

const params = {
  accessToken: "private-test-token",
  appConfig: { appId: "app-1", appSecret: "private-secret" },
  expectedUserId: "user-1",
};
const tool = {
  name: "ads_get_ad_accounts",
  definitionSha256: "a".repeat(64),
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const catalog: client.MetaAdsMcpCatalog = {
  tools: [tool],
  catalogSha256: "b".repeat(64),
  canonicalSizeBytes: 100,
  protocol: {
    era: "legacy",
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(debugConfiguredMetaAccessToken).mockResolvedValue({
    is_valid: true,
    app_id: "app-1",
    user_id: "user-1",
    type: "USER",
    expires_at: 0,
    scopes: ["ads_mcp_management", "ads_read"],
  });
  jest.mocked(client.listMetaAdsMcpTools).mockResolvedValue(catalog);
  jest.mocked(client.callMetaAdsMcpTool).mockResolvedValue({
    content: [{ type: "text", text: "private account data" }],
  });
});

it("executes one schema-validated read with minimum permissions and returns no account data", async () => {
  const result = await runMetaAdsMcpReadTest(params);
  expect(result).toMatchObject({
    success: true,
    stage: "call",
    tool: "ads_get_ad_accounts",
  });
  expect(client.callMetaAdsMcpTool).toHaveBeenCalledTimes(1);
  expect(client.callMetaAdsMcpTool).toHaveBeenCalledWith(
    expect.objectContaining({ tool, arguments: {}, sideEffect: "read" })
  );
  expect(client.closeMetaAdsMcpSession).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toMatch(/private/);
});

it.each([
  [{ is_valid: false }, "invalid_token"],
  [{ app_id: "different-app" }, "invalid_token"],
  [{ expires_at: 1 }, "invalid_token"],
  [{ user_id: "different-user" }, "identity_mismatch"],
  [{ user_id: undefined }, "identity_mismatch"],
  [{ scopes: ["ads_read"] }, "missing_permissions"],
  [{ scopes: ["ads_mcp_management"] }, "missing_permissions"],
])(
  "does not contact MCP when token validation fails: %j",
  async (override, code) => {
    jest.mocked(debugConfiguredMetaAccessToken).mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes: ["ads_mcp_management", "ads_read"],
      ...override,
    });
    expect(await runMetaAdsMcpReadTest(params)).toMatchObject({
      success: false,
      code,
      stage: "token",
    });
    expect(client.createMetaAdsMcpSession).not.toHaveBeenCalled();
  }
);

it("accepts ads_management instead of ads_read", async () => {
  jest.mocked(debugConfiguredMetaAccessToken).mockResolvedValue({
    is_valid: true,
    app_id: "app-1",
    user_id: "user-1",
    scopes: ["ads_mcp_management", "ads_management"],
  });
  expect(await runMetaAdsMcpReadTest(params)).toMatchObject({ success: true });
});

it("accepts the same verified profile identity used by readiness", async () => {
  jest.mocked(debugConfiguredMetaAccessToken).mockResolvedValue({
    is_valid: true,
    app_id: "app-1",
    profile_id: "user-1",
    scopes: ["ads_mcp_management", "ads_read"],
  });
  expect(await runMetaAdsMcpReadTest(params)).toMatchObject({ success: true });
  expect(client.callMetaAdsMcpTool).toHaveBeenCalledTimes(1);
});

it.each([
  { profile_id: "different-user" },
  { user_id: "different-user", profile_id: "user-1" },
])("does not substitute a different profile identity: %j", async identity => {
  jest.mocked(debugConfiguredMetaAccessToken).mockResolvedValue({
    is_valid: true,
    app_id: "app-1",
    scopes: ["ads_mcp_management", "ads_read"],
    ...identity,
  });
  expect(await runMetaAdsMcpReadTest(params)).toMatchObject({
    success: false,
    code: "identity_mismatch",
  });
  expect(client.createMetaAdsMcpSession).not.toHaveBeenCalled();
});

it("does not substitute a mutation if the account-list tool is absent", async () => {
  jest.mocked(client.listMetaAdsMcpTools).mockResolvedValue({
    ...catalog,
    tools: [{ ...tool, name: "ads_create_campaign" }],
  });
  expect(await runMetaAdsMcpReadTest(params)).toMatchObject({
    success: false,
    code: "read_tool_unavailable",
  });
  expect(client.callMetaAdsMcpTool).not.toHaveBeenCalled();
  expect(client.closeMetaAdsMcpSession).toHaveBeenCalledTimes(1);
});

it("fails closed when the live tool needs unsupported arguments", async () => {
  jest.mocked(client.listMetaAdsMcpTools).mockResolvedValue({
    ...catalog,
    tools: [
      {
        ...tool,
        inputSchema: {
          type: "object",
          properties: { account_id: { type: "string" } },
          required: ["account_id"],
        },
      },
    ],
  });
  expect(await runMetaAdsMcpReadTest(params)).toMatchObject({
    success: false,
    code: "unsupported_read_schema",
  });
  expect(client.callMetaAdsMcpTool).not.toHaveBeenCalled();
});

it("reports provider rejection without leaking error content or claiming success", async () => {
  jest.mocked(client.callMetaAdsMcpTool).mockRejectedValue(
    new client.MetaAdsMcpToolResultError(tool.name, "private token", {
      data: "private customer",
    })
  );
  const result = await runMetaAdsMcpReadTest(params);
  expect(result).toMatchObject({
    success: false,
    stage: "call",
    code: "provider_tool_error",
  });
  expect(JSON.stringify(result)).not.toMatch(/private/);
  expect(client.closeMetaAdsMcpSession).toHaveBeenCalledTimes(1);
});

it("closes the session if initialization rejects", async () => {
  jest
    .mocked(client.initializeMetaAdsMcpSession)
    .mockRejectedValueOnce(
      new client.MetaAdsMcpClientError(
        "provider_unauthorized",
        "private provider detail",
        { status: 401 }
      )
    );
  expect(await runMetaAdsMcpReadTest(params)).toMatchObject({
    success: false,
    stage: "initialize",
    code: "provider_unauthorized",
    httpStatus: 401,
  });
  expect(client.callMetaAdsMcpTool).not.toHaveBeenCalled();
  expect(client.closeMetaAdsMcpSession).toHaveBeenCalledTimes(1);
});

import { validateMetaAdsMcpToolArguments } from "./tool-argument-validation";

const DEFINITION_SHA256 = "a".repeat(64);

describe("Meta Ads MCP tool argument validation", () => {
  it("validates nested required fields, enums, and additional properties", () => {
    const tool = {
      name: "ads_create_campaign",
      definitionSha256: DEFINITION_SHA256,
      inputSchema: {
        type: "object",
        properties: {
          campaign: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1 },
              status: { enum: ["PAUSED", "ACTIVE"] },
            },
            required: ["name", "status"],
            additionalProperties: false,
          },
        },
        required: ["campaign"],
        additionalProperties: false,
      },
    };

    expect(
      validateMetaAdsMcpToolArguments({
        tool,
        arguments: { campaign: { name: "Launch", status: "PAUSED" } },
      })
    ).toEqual({ success: true });
    expect(
      validateMetaAdsMcpToolArguments({
        tool,
        arguments: {
          campaign: { name: "Launch", status: "DRAFT", secret: true },
        },
      })
    ).toEqual({
      success: false,
      errors: expect.arrayContaining([
        expect.stringMatching(/allowed values/i),
        expect.stringMatching(/secret.*not allowed/i),
      ]),
    });
  });

  it("resolves local schema references", () => {
    const result = validateMetaAdsMcpToolArguments({
      tool: {
        name: "ads_get_report",
        definitionSha256: DEFINITION_SHA256,
        inputSchema: {
          type: "object",
          $defs: {
            accountId: { type: "string", pattern: "^act_[0-9]+$" },
          },
          properties: {
            account_id: { $ref: "#/$defs/accountId" },
          },
          required: ["account_id"],
        },
      },
      arguments: { account_id: "invalid" },
    });

    expect(result).toEqual({
      success: false,
      errors: [expect.stringMatching(/required pattern/i)],
    });
  });

  it("fails closed when a provider schema uses an unsupported constraint", () => {
    const result = validateMetaAdsMcpToolArguments({
      tool: {
        name: "ads_unknown_tool",
        definitionSha256: DEFINITION_SHA256,
        inputSchema: {
          type: "object",
          unevaluatedProperties: false,
        },
      },
      arguments: {},
    });

    expect(result).toEqual({
      success: false,
      errors: [expect.stringMatching(/unsupported schema keyword/i)],
    });
  });
});

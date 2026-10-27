import type { MetaAdsMcpTool } from "./client";
import {
  getMetaAdsMcpAccountEligibility,
  getMetaAdsMcpReadPrecondition,
} from "./preconditions";

const tools: MetaAdsMcpTool[] = [
  {
    name: "ads_get_ad_accounts",
    definitionSha256: "a".repeat(64),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ads_get_field_context",
    definitionSha256: "b".repeat(64),
    inputSchema: {
      type: "object",
      properties: { field_names: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
  },
];
const account = {
  ad_account_id: "123",
  is_queryable: true,
  is_ads_mcp_enabled: true,
};
const field = {
  name: "impressions",
  aliases: ["views"],
  levels: ["campaign", "adset", "ad", "ad_account"],
  filterable: true,
  sortable: true,
  supported_filter_operators: ["GREATER_THAN", "EQUAL"],
};

test("distinguishes Meta rollout availability from entity queryability", () => {
  expect(
    evaluate(undefined, [
      accounts({ ad_accounts: [{ ...account, is_ads_mcp_enabled: false }] }),
    ])
  ).toMatchObject({
    kind: "blocked",
    code: "account_not_enabled",
    message: expect.stringContaining("Meta"),
  });
  expect(
    evaluate(undefined, [
      accounts({ ad_accounts: [{ ...account, is_queryable: false }] }),
    ])
  ).toMatchObject({ kind: "blocked", code: "account_not_queryable" });
});

test.each([
  { ad_account_id: "123" },
  { account_id: "act_123" },
  { ad_account_ids: ["123"] },
])("gates nonentity analytics on account availability: %j", args => {
  expect(
    getMetaAdsMcpReadPrecondition({
      toolName: "ads_insights_performance_trend",
      args,
      priorResults: JSON.stringify({
        results: [
          accounts({
            ad_accounts: [{ ...account, is_ads_mcp_enabled: false }],
          }),
        ],
      }),
      tools,
    })
  ).toMatchObject({ kind: "blocked", code: "account_not_enabled" });
});

test("does not require entity queryability for other enabled account tools", () => {
  expect(
    getMetaAdsMcpReadPrecondition({
      toolName: "ads_insights_performance_trend",
      args: { ad_account_id: "123" },
      priorResults: JSON.stringify({
        results: [
          accounts({ ad_accounts: [{ ...account, is_queryable: false }] }),
        ],
      }),
      tools,
    })
  ).toEqual({ kind: "ready" });
});

test("discovers availability before preparing account-scoped writes", () => {
  expect(
    getMetaAdsMcpReadPrecondition({
      toolName: "ads_create_campaign",
      args: { ad_account_id: "123" },
      priorResults: JSON.stringify({ results: [] }),
      tools,
    })
  ).toMatchObject({
    kind: "prerequisite",
    call: { name: "ads_get_ad_accounts" },
  });
});

test.each([
  "ads_get_ad_accounts",
  "ads_get_field_context",
  "ads_search_help_articles",
])(
  "leaves discovery, field metadata and no-account tools untouched: %s",
  toolName => {
    expect(
      getMetaAdsMcpReadPrecondition({
        toolName,
        args: {},
        priorResults: "",
        tools: [],
      })
    ).toEqual({ kind: "ready" });
  }
);

test("blocks a multi-account query if any requested account is unavailable", () => {
  expect(
    getMetaAdsMcpReadPrecondition({
      toolName: "ads_insights_performance_trend",
      args: { ad_account_ids: ["123", "456"] },
      priorResults: JSON.stringify({
        results: [
          accounts({
            ad_accounts: [
              account,
              { ...account, ad_account_id: "456", is_ads_mcp_enabled: false },
            ],
          }),
        ],
      }),
      tools,
    })
  ).toMatchObject({ kind: "blocked", code: "account_not_enabled" });
});

test("shares the rollout availability gate with confirmed writes using provider inventory", () => {
  expect(
    getMetaAdsMcpAccountEligibility({
      inventory: { ad_accounts: [{ ...account, is_ads_mcp_enabled: false }] },
      accountIds: ["act_123"],
    })
  ).toMatchObject({ kind: "blocked", code: "account_not_enabled" });
  expect(
    getMetaAdsMcpAccountEligibility({
      inventory: { ad_accounts: [{ ...account, is_queryable: false }] },
      accountIds: ["123"],
    })
  ).toEqual({ kind: "ready" });
});
function accounts(data: unknown = { ad_accounts: [account] }) {
  return { name: "ads_get_ad_accounts", arguments: {}, data };
}
function fields(data: unknown = { fields: [field] }, names = ["impressions"]) {
  return {
    name: "ads_get_field_context",
    arguments: { field_names: names },
    data,
  };
}
function evaluate(
  args: Record<string, unknown> = {
    ad_account_id: "act_123",
    level: "campaign",
  },
  results: unknown[] = [accounts()],
  availableTools = tools
) {
  return getMetaAdsMcpReadPrecondition({
    toolName: "ads_get_ad_entities",
    args,
    priorResults: JSON.stringify({ results }),
    tools: availableTools,
  });
}

test("does not impose entity prerequisites on unrelated tools", () => {
  expect(
    getMetaAdsMcpReadPrecondition({
      toolName: "ads_get_activity_history",
      args: {},
      priorResults: "",
      tools: [],
    })
  ).toEqual({ kind: "ready" });
});

test("requires account discovery before the first entity query", () => {
  expect(evaluate({ ad_account_id: "123" }, [])).toMatchObject({
    kind: "prerequisite",
    call: { name: "ads_get_ad_accounts", arguments: {} },
  });
});

test("uses seeded server-verified availability instead of a discovery read", () => {
  const seeded = (seededAccountInventory: unknown, args = {}) =>
    getMetaAdsMcpReadPrecondition({
      toolName: "ads_get_ad_entities",
      args: { ad_account_id: "act_123", level: "campaign", ...args },
      priorResults: JSON.stringify({ results: [] }),
      tools,
      seededAccountInventory,
    });
  expect(seeded({ ad_accounts: [account] })).toEqual({ kind: "ready" });
  // Field checks still apply after the seeded account gate.
  expect(
    seeded({ ad_accounts: [account] }, { fields: ["impressions"] })
  ).toMatchObject({
    kind: "prerequisite",
    call: { name: "ads_get_field_context" },
  });
});

test.each([
  { ad_accounts: [{ ...account, is_queryable: false }] },
  { ad_accounts: [{ ad_account_id: "123", is_ads_mcp_enabled: true }] },
  { ad_accounts: [{ ...account, ad_account_id: "456" }] },
  "not an inventory",
])(
  "falls back to the live discovery read when a seed does not prove eligibility: %j",
  seededAccountInventory => {
    expect(
      getMetaAdsMcpReadPrecondition({
        toolName: "ads_get_ad_entities",
        args: { ad_account_id: "123", level: "campaign" },
        priorResults: JSON.stringify({ results: [] }),
        tools,
        seededAccountInventory,
      })
    ).toMatchObject({
      kind: "prerequisite",
      call: { name: "ads_get_ad_accounts" },
    });
  }
);

test("prefers live account evidence over a seed", () => {
  expect(
    getMetaAdsMcpReadPrecondition({
      toolName: "ads_get_ad_entities",
      args: { ad_account_id: "123", level: "campaign" },
      priorResults: JSON.stringify({
        results: [
          accounts({
            ad_accounts: [{ ...account, is_ads_mcp_enabled: false }],
          }),
        ],
      }),
      tools,
      seededAccountInventory: { ad_accounts: [account] },
    })
  ).toMatchObject({ kind: "blocked", code: "account_not_enabled" });
});

test("allows documented default fields after verified account eligibility", () => {
  expect(evaluate()).toEqual({ kind: "ready" });
  expect(
    evaluate({ ad_account_id: "123", fields: ["id", "name", "amount_spent"] })
  ).toEqual({ kind: "ready" });
});

test.each([
  { ...account, is_queryable: false },
  { ...account, is_ads_mcp_enabled: false },
  { ad_account_id: "123" },
  { ...account, is_queryable: "true" },
])(
  "blocks unavailable or unverified account flags without inventing eligibility: %j",
  record => {
    expect(
      evaluate(undefined, [accounts({ ad_accounts: [record] })])
    ).toMatchObject({ kind: "blocked" });
  }
);

test("does not use another account's eligibility", () => {
  expect(evaluate({ ad_account_id: "999" })).toMatchObject({
    kind: "blocked",
    code: "account_not_verified",
  });
});

test.each([{ error: "unavailable" }, { omitted: true }])(
  "never trusts failed or omitted account evidence: %j",
  extra => {
    expect(evaluate(undefined, [{ ...accounts(), ...extra }])).toMatchObject({
      kind: "prerequisite",
      call: { name: "ads_get_ad_accounts" },
    });
  }
);

test("finds account and field evidence in retained multipart provider envelopes", () => {
  const results = [
    accounts({
      parts: [{ data: { ad_accounts: [account] } }, { note: "metadata" }],
    }),
    fields({ parts: [{ data: { fields: [field] } }] }),
  ];
  expect(
    evaluate(
      { ad_account_id: "123", level: "campaign", fields: ["impressions"] },
      results
    )
  ).toEqual({ kind: "ready" });
});

test("verifies nondefault fields and filter/sort fields in one prerequisite", () => {
  expect(
    evaluate({
      ad_account_id: "123",
      level: "campaign",
      fields: ["id", "impressions"],
      filtering: [
        { field: "campaign.name", operator: "EQUAL", value: ["Spring"] },
      ],
      sort: "amount_spent_descending",
    })
  ).toMatchObject({
    kind: "prerequisite",
    call: {
      name: "ads_get_field_context",
      arguments: { field_names: ["impressions", "name", "amount_spent"] },
    },
  });
});

test("blocks noncanonical aliases instead of silently rewriting the query", () => {
  expect(
    evaluate({ ad_account_id: "123", fields: ["views"] }, [
      accounts(),
      fields(),
    ])
  ).toMatchObject({ kind: "blocked", code: "noncanonical_field" });
});

test("blocks unknown fields returned explicitly by the provider", () => {
  expect(
    evaluate({ ad_account_id: "123", fields: ["made_up"] }, [
      accounts(),
      fields({ fields: [], unknown_fields: ["made_up"] }, ["made_up"]),
    ])
  ).toMatchObject({ kind: "blocked", code: "unsupported_field" });
});

test("does not keep asking for a field whose completed lookup did not verify it", () => {
  expect(
    evaluate({ ad_account_id: "123", fields: ["impressions"] }, [
      accounts(),
      fields({ fields: [] }),
    ])
  ).toMatchObject({ kind: "blocked", code: "field_metadata_unavailable" });
});

test("requests only missing field metadata while retaining already verified fields", () => {
  expect(
    evaluate({ ad_account_id: "123", fields: ["impressions", "clicks"] }, [
      accounts(),
      fields(),
    ])
  ).toMatchObject({
    kind: "prerequisite",
    call: { arguments: { field_names: ["clicks"] } },
  });
});

test("blocks a field unsupported at the requested entity level", () => {
  expect(
    evaluate(
      { ad_account_id: "123", level: "campaign", fields: ["impressions"] },
      [accounts(), fields({ fields: [{ ...field, levels: ["ad"] }] })]
    )
  ).toMatchObject({ kind: "blocked", code: "unsupported_field_level" });
});

test("uses an explicit filter prefix as its validation level and supports account alias", () => {
  const results = [
    accounts(),
    fields({ fields: [{ ...field, levels: ["campaign", "ad_account"] }] }),
  ];
  expect(
    evaluate(
      {
        ad_account_id: "123",
        level: "ad",
        filtering: [
          {
            field: "campaign.impressions",
            operator: "GREATER_THAN",
            value: ["0"],
          },
        ],
      },
      results
    )
  ).toEqual({ kind: "ready" });
  expect(
    evaluate(
      { ad_account_id: "123", level: "account", fields: ["impressions"] },
      results
    )
  ).toEqual({ kind: "ready" });
});

test("does not invent a query level when omitted but still requires supported levels", () => {
  expect(
    evaluate({ ad_account_id: "123", fields: ["impressions"] }, [
      accounts(),
      fields(),
    ])
  ).toEqual({ kind: "ready" });
  expect(
    evaluate({ ad_account_id: "123", fields: ["impressions"] }, [
      accounts(),
      fields({ fields: [{ ...field, levels: [] }] }),
    ])
  ).toMatchObject({ kind: "blocked", code: "unsupported_field_level" });
});

test.each([
  [{ ...field, filterable: false }, "GREATER_THAN", "field_not_filterable"],
  [field, "UNSUPPORTED", "unsupported_filter_operator"],
  [
    { ...field, supported_filter_operators: undefined },
    "EQUAL",
    "unsupported_filter_operator",
  ],
])(
  "checks provider filter capability and exact supported operators",
  (metadata, operator, code) => {
    expect(
      evaluate(
        {
          ad_account_id: "123",
          filtering: [{ field: "impressions", operator, value: ["0"] }],
        },
        [accounts(), fields({ fields: [metadata] })]
      )
    ).toMatchObject({ kind: "blocked", code });
  }
);

test("blocks sorting by a field which the provider marks unsortable", () => {
  expect(
    evaluate({ ad_account_id: "123", sort: "impressions_descending" }, [
      accounts(),
      fields({ fields: [{ ...field, sortable: false }] }),
    ])
  ).toMatchObject({ kind: "blocked", code: "field_not_sortable" });
});

test.each([
  { sort: "impressions_desc" },
  { filtering: [{ field: "impressions", operator: "EQUAL", value: "1" }] },
  { fields: "impressions" },
  { fields: ["campaign.impressions"] },
  { level: "invalid" },
])("fails closed for undocumented query syntax: %j", extra => {
  expect(evaluate({ ad_account_id: "123", ...extra })).toMatchObject({
    kind: "blocked",
    code: "invalid_entity_query",
  });
});

test("draft queries skip field checks but retain the account gate", () => {
  expect(
    evaluate({
      ad_account_id: "123",
      object_state: "draft",
      fields: ["not_queried"],
    })
  ).toEqual({ kind: "ready" });
  expect(
    evaluate({ ad_account_id: "123", object_state: "draft" }, [
      accounts({ ad_accounts: [{ ...account, is_queryable: false }] }),
    ])
  ).toMatchObject({ kind: "blocked" });
});

test.each([[], [tools[0]], [tools[1]]].map(available => ({ available })))(
  "does not invent prerequisite tools absent from the verified catalog",
  ({ available }) => {
    expect(evaluate(undefined, [], available)).toMatchObject({
      kind: "blocked",
      code: "prerequisite_tool_unavailable",
    });
  }
);

test("validates generated prerequisites against the exact current tool schema", () => {
  const changed = [
    {
      ...tools[0],
      inputSchema: {
        type: "object",
        required: ["new_required_input"],
        properties: { new_required_input: { type: "string" } },
      },
    },
    tools[1],
  ];
  expect(evaluate(undefined, [], changed)).toMatchObject({
    kind: "blocked",
    code: "prerequisite_schema_changed",
  });
});

test("rejects malformed or excessive evidence safely", () => {
  expect(
    getMetaAdsMcpReadPrecondition({
      toolName: "ads_get_ad_entities",
      args: { ad_account_id: "123" },
      priorResults: "{bad",
      tools,
    })
  ).toMatchObject({ kind: "blocked", code: "invalid_prerequisite_evidence" });
  let nested: unknown = account;
  for (let index = 0; index < 60; index += 1) nested = { data: nested };
  expect(evaluate(undefined, [accounts(nested)])).toMatchObject({
    kind: "blocked",
    code: "invalid_prerequisite_evidence",
  });
});

test.each([
  { ad_account_ids: [] },
  { account_ids: [] },
  { ad_account_id: "123", ad_account_ids: [] },
])(
  "rejects explicit empty scopes rather than treating them as unscoped: %j",
  args => {
    expect(
      getMetaAdsMcpReadPrecondition({
        toolName: "ads_insights_performance_trend",
        args,
        priorResults: JSON.stringify({ results: [] }),
        tools,
      })
    ).toMatchObject({ kind: "blocked", code: "invalid_account_scope" });
  }
);

test("supplies the turn identity before validating required prerequisite arguments", () => {
  const clientConversationId = "ServerConversation01";
  const withIdentity = tools.map(tool => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema.properties as Record<string, unknown>),
        client_conversation_id: { type: "string" },
      },
      required: ["client_conversation_id"],
    },
  }));
  expect(
    getMetaAdsMcpReadPrecondition({
      toolName: "ads_get_ad_entities",
      args: { ad_account_id: "123" },
      priorResults: JSON.stringify({ results: [] }),
      tools: withIdentity,
      clientConversationId,
    })
  ).toMatchObject({
    kind: "prerequisite",
    call: {
      name: "ads_get_ad_accounts",
      arguments: { client_conversation_id: clientConversationId },
    },
  });
});

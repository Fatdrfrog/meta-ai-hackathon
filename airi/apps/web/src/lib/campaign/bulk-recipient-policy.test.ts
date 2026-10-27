jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw new Error("Unexpected database access in recipient policy unit test");
  }),
}));

import {
  evaluateBulkRecipientPolicy,
  type BulkRecipientPolicyDependencies,
} from "./bulk-recipient-policy";

const workspaceId = "11111111-1111-4111-8111-111111111111";

const candidate = (
  stableId: string,
  phone: string,
  templateCategory: "MARKETING" | "UTILITY" | "AUTHENTICATION"
) => ({ stableId, value: stableId, recipient: { phone }, templateCategory });

function completeness(
  uniqueRecipients: number,
  dispatchItems: number,
  hardCaps?: { uniqueRecipientHardCap: number; dispatchItemHardCap: number }
) {
  return {
    complete: true as const,
    uniqueRecipients,
    dispatchItems,
    uniqueRecipientHardCap: hardCaps?.uniqueRecipientHardCap ?? 50_000,
    dispatchItemHardCap: hardCaps?.dispatchItemHardCap ?? 50_000,
  };
}

function dependencies(params?: {
  optedOutIds?: readonly string[];
  warningIds?: readonly string[];
  failedIds?: readonly string[];
  consentError?: Error;
  priorFailureError?: Error;
  recentIds?: readonly string[];
  contactError?: Error;
}): BulkRecipientPolicyDependencies {
  return {
    partitionRecentContacts: jest.fn(async ({ recipients }) => {
      if (params?.contactError) throw params.contactError;
      const recent = new Set(params?.recentIds || []);
      return {
        allowed: recipients.filter(
          (recipient: { stableId: string }) => !recent.has(recipient.stableId)
        ),
        recentlyContacted: recipients.filter(
          (recipient: { stableId: string }) => recent.has(recipient.stableId)
        ),
        nextEligibleAt: null,
      };
    }),
    filterMarketingOptOut: jest.fn(async ({ recipients }) => {
      if (params?.consentError) throw params.consentError;
      const optedOut = new Set(params?.optedOutIds || []);
      const warnings = new Set(params?.warningIds || []);
      return {
        recipients: recipients.filter(
          (recipient: { name?: string }) => !optedOut.has(recipient.name || "")
        ),
        skippedRecipients: recipients.filter((recipient: { name?: string }) =>
          optedOut.has(recipient.name || "")
        ),
        skippedOptIn: optedOut.size,
        skippedPhones: [],
        marketingOptInWarningRecipients: recipients.filter(
          (recipient: { name?: string }) => warnings.has(recipient.name || "")
        ),
        marketingOptInWarningCount: warnings.size,
        marketingOptInWarningPhones: [],
      };
    }),
    filterPriorFailed: jest.fn(async ({ candidates }) => {
      if (params?.priorFailureError) throw params.priorFailureError;
      const failed = new Set(params?.failedIds || []);
      return {
        candidates: candidates.filter(
          (item: { stableId: string }) => !failed.has(item.stableId)
        ),
        skippedPriorFailed: (params?.failedIds || []).length,
      };
    }),
  } as unknown as BulkRecipientPolicyDependencies;
}

function input(
  candidates: ReturnType<typeof candidate>[],
  overrides?: Record<string, unknown>
) {
  return {
    workspaceId,
    channel: "whatsapp" as const,
    candidates,
    recipientLimit: 50_000,
    completeness: completeness(candidates.length, candidates.length),
    policy: { version: 1 as const, excludePriorFailedBulkSends: false },
    ...overrides,
  };
}

async function expectPolicyCode(value: ReturnType<typeof input>, code: string) {
  await expect(
    evaluateBulkRecipientPolicy(value, dependencies())
  ).rejects.toMatchObject({ code });
}

describe("evaluateBulkRecipientPolicy", () => {
  it("applies opt-out then unique limit then prior failure without backfill", async () => {
    const candidates = [
      candidate("opted-out", "+15550000001", "MARKETING"),
      candidate("accepted-then-failed", "+15550000002", "UTILITY"),
      candidate("outside-limit", "+15550000003", "AUTHENTICATION"),
    ].map(item => ({
      ...item,
      recipient: { ...item.recipient, name: item.stableId },
    }));
    const result = await evaluateBulkRecipientPolicy(
      input(candidates, {
        recipientLimit: 1,
        completeness: completeness(3, 3),
        policy: { version: 1, excludePriorFailedBulkSends: true },
        priorFailure: { client: { rpc: jest.fn() }, secret: "test-secret" },
      }),
      dependencies({
        optedOutIds: ["opted-out"],
        failedIds: ["accepted-then-failed"],
      })
    );

    expect(result.retained).toEqual([]);
    expect(result.skippedByReason).toEqual({
      marketing_opt_out: 1,
      recipient_limit: 1,
      prior_failure: 1,
    });
    expect(result.uniqueRecipients).toEqual({ requested: 3, accepted: 0 });
    expect(
      result.excluded.map(item => [item.candidate.stableId, item.reason])
    ).toEqual([
      ["opted-out", "marketing_opt_out"],
      ["accepted-then-failed", "prior_failure"],
      ["outside-limit", "recipient_limit"],
    ]);
  });

  it("does not request marketing consent for utility or authentication rows", async () => {
    const deps = dependencies();
    const result = await evaluateBulkRecipientPolicy(
      input([
        candidate("utility", "+15550000001", "UTILITY"),
        candidate("authentication", "+15550000002", "AUTHENTICATION"),
      ]),
      deps
    );

    expect(result.retained.map(item => item.stableId)).toEqual([
      "utility",
      "authentication",
    ]);
    expect(deps.filterMarketingOptOut).not.toHaveBeenCalled();
  });

  it("excludes only opted-out marketing rows for a mixed identity then applies limit and prior failure to its remaining rows", async () => {
    const candidates = [
      candidate("marketing", "+15550000001", "MARKETING"),
      candidate("utility", "15550000001", "UTILITY"),
      candidate("authentication", "+15550000001", "AUTHENTICATION"),
    ].map(item => ({
      ...item,
      recipient: { ...item.recipient, name: item.stableId },
    }));
    const result = await evaluateBulkRecipientPolicy(
      input(candidates, {
        recipientLimit: 1,
        completeness: completeness(1, 3),
        policy: { version: 1, excludePriorFailedBulkSends: true },
        priorFailure: { client: { rpc: jest.fn() }, secret: "test-secret" },
      }),
      dependencies({
        optedOutIds: ["marketing"],
        failedIds: ["utility", "authentication"],
      })
    );

    expect(result.retained).toEqual([]);
    expect(result.uniqueRecipients).toEqual({ requested: 1, accepted: 0 });
    expect(
      result.excluded.map(item => [item.candidate.stableId, item.reason])
    ).toEqual([
      ["marketing", "marketing_opt_out"],
      ["utility", "prior_failure"],
      ["authentication", "prior_failure"],
    ]);
  });

  it("retains missing-consent marketing rows and reports each warning", async () => {
    const candidates = [candidate("missing", "+15550000001", "MARKETING")].map(
      item => ({
        ...item,
        recipient: { ...item.recipient, name: item.stableId },
      })
    );
    const result = await evaluateBulkRecipientPolicy(
      input(candidates),
      dependencies({ warningIds: ["missing"] })
    );

    expect(result.retained.map(item => item.stableId)).toEqual(["missing"]);
    expect(result.warnings).toEqual({ missingMarketingConsent: 1 });
    expect(result.warningStableIds).toEqual({
      missing_marketing_consent: ["missing"],
    });
  });

  it("attributes cloned and duplicate consent warnings to stable IDs once in candidate order", async () => {
    const candidates = [
      candidate("first", "+15550000001", "MARKETING"),
      candidate("second", "15550000001", "MARKETING"),
      candidate("third", "+15550000002", "MARKETING"),
    ];
    const deps = dependencies();
    deps.filterMarketingOptOut = jest.fn(async ({ recipients }) => ({
      recipients,
      skippedRecipients: [],
      skippedOptIn: 0,
      skippedPhones: [],
      marketingOptInWarningRecipients: [
        { ...recipients[1]! },
        { ...recipients[0]! },
        { ...recipients[0]! },
      ],
      marketingOptInWarningCount: 3,
      marketingOptInWarningPhones: [],
    }));

    const result = await evaluateBulkRecipientPolicy(
      input(candidates, { completeness: completeness(2, 3) }),
      deps
    );

    expect(result.warningStableIds).toEqual({
      missing_marketing_consent: ["first", "second"],
    });
    expect(result.warnings.missingMarketingConsent).toBe(
      result.warningStableIds?.missing_marketing_consent?.length
    );
  });

  it("maps cloned consent rows to every dispatch item with the same canonical identity", async () => {
    const candidates = [
      candidate("first", "+15550000001", "MARKETING"),
      candidate("second", "15550000001", "MARKETING"),
    ];
    const deps = dependencies();
    deps.filterMarketingOptOut = jest.fn(async ({ recipients }) => ({
      recipients: [],
      skippedRecipients: recipients.map(recipient => ({ ...recipient })),
      skippedOptIn: recipients.length,
      skippedPhones: [],
      marketingOptInWarningRecipients: [],
      marketingOptInWarningCount: 0,
      marketingOptInWarningPhones: [],
    }));

    const result = await evaluateBulkRecipientPolicy(
      input(candidates, {
        completeness: completeness(1, 2),
      }),
      deps
    );

    expect(result.retained).toEqual([]);
    expect(result.excluded.map(item => item.candidate.stableId)).toEqual([
      "first",
      "second",
    ]);
    expect(result.skippedByReason).toEqual({ marketing_opt_out: 2 });
    expect(result.uniqueRecipients).toEqual({ requested: 1, accepted: 0 });
  });

  it("reports an opted-out-only identity as requested but not accepted", async () => {
    const candidates = [
      candidate("opted-out", "+15550000001", "MARKETING"),
    ].map(item => ({
      ...item,
      recipient: { ...item.recipient, name: item.stableId },
    }));
    const result = await evaluateBulkRecipientPolicy(
      input(candidates),
      dependencies({ optedOutIds: ["opted-out"] })
    );

    expect(result.retained).toEqual([]);
    expect(result.uniqueRecipients).toEqual({ requested: 1, accepted: 0 });
  });

  it("accepts declared generated-audience proof bounds below the global cap", async () => {
    const candidates = [
      candidate("first", "+15550000001", "UTILITY"),
      candidate("second", "+15550000002", "AUTHENTICATION"),
    ];
    const result = await evaluateBulkRecipientPolicy(
      input(candidates, {
        completeness: completeness(2, 2, {
          uniqueRecipientHardCap: 1_000,
          dispatchItemHardCap: 3_000,
        }),
      }),
      dependencies()
    );

    expect(result.retained).toEqual(candidates);
    expect(result.uniqueRecipients).toEqual({ requested: 2, accepted: 2 });
  });

  it("keeps every row for admitted identities and excludes every row outside the identity limit", async () => {
    const result = await evaluateBulkRecipientPolicy(
      input(
        [
          candidate("first-one", "+15550000001", "UTILITY"),
          candidate("first-two", "15550000001", "AUTHENTICATION"),
          candidate("second-one", "+15550000002", "UTILITY"),
          candidate("second-two", "15550000002", "AUTHENTICATION"),
        ],
        { recipientLimit: 1, completeness: completeness(2, 4) }
      ),
      dependencies()
    );

    expect(result.retained.map(item => item.stableId)).toEqual([
      "first-one",
      "first-two",
    ]);
    expect(
      result.excluded.map(item => [item.candidate.stableId, item.reason])
    ).toEqual([
      ["second-one", "recipient_limit"],
      ["second-two", "recipient_limit"],
    ]);
    expect(result.uniqueRecipients).toEqual({ requested: 2, accepted: 1 });
  });

  it("preserves stable first-seen identity order without limit backfill", async () => {
    const candidates = [
      candidate("opted-out-first", "+15550000001", "MARKETING"),
      candidate("first-admitted", "+15550000002", "UTILITY"),
      candidate("second-outside", "+15550000003", "UTILITY"),
    ].map(item => ({
      ...item,
      recipient: { ...item.recipient, name: item.stableId },
    }));
    const result = await evaluateBulkRecipientPolicy(
      input(candidates, {
        recipientLimit: 1,
        completeness: completeness(3, 3),
      }),
      dependencies({ optedOutIds: ["opted-out-first"] })
    );

    expect(result.retained.map(item => item.stableId)).toEqual([
      "first-admitted",
    ]);
    expect(
      result.excluded.map(item => [item.candidate.stableId, item.reason])
    ).toEqual([
      ["opted-out-first", "marketing_opt_out"],
      ["second-outside", "recipient_limit"],
    ]);
  });

  it.each([
    [
      "duplicate stable id",
      input([
        candidate("same", "+15550000001", "UTILITY"),
        candidate("same", "+15550000002", "UTILITY"),
      ]),
      "duplicate_stable_id",
    ],
    [
      "invalid canonical identity",
      input([candidate("invalid", "", "UTILITY")]),
      "invalid_recipient_identity",
    ],
    [
      "zero limit",
      input([candidate("one", "+15550000001", "UTILITY")], {
        recipientLimit: 0,
      }),
      "invalid_recipient_limit",
    ],
    [
      "negative limit",
      input([candidate("one", "+15550000001", "UTILITY")], {
        recipientLimit: -1,
      }),
      "invalid_recipient_limit",
    ],
    [
      "missing limit",
      input([candidate("one", "+15550000001", "UTILITY")], {
        recipientLimit: undefined,
      }),
      "invalid_recipient_limit",
    ],
    [
      "incomplete audience",
      input([candidate("one", "+15550000001", "UTILITY")], {
        completeness: { ...completeness(1, 1), complete: false },
      }),
      "incomplete_audience",
    ],
    [
      "unique proof imbalance",
      input([candidate("one", "+15550000001", "UTILITY")], {
        completeness: completeness(2, 1),
      }),
      "invariant_imbalance",
    ],
    [
      "dispatch proof imbalance",
      input([candidate("one", "+15550000001", "UTILITY")], {
        completeness: completeness(1, 2),
      }),
      "invariant_imbalance",
    ],
    [
      "unsupported policy version",
      input([candidate("one", "+15550000001", "UTILITY")], {
        policy: { version: 2, excludePriorFailedBulkSends: false },
      }),
      "unsupported_policy_version",
    ],
    [
      "missing policy",
      input([candidate("one", "+15550000001", "UTILITY")], {
        policy: undefined,
      }),
      "unsupported_policy_version",
    ],
    [
      "hard-cap plus one",
      input(
        Array.from({ length: 50_001 }, (_, index) =>
          candidate(
            String(index),
            `+1555${String(index).padStart(7, "0")}`,
            "UTILITY"
          )
        ),
        { completeness: completeness(50_001, 50_001), recipientLimit: 50_000 }
      ),
      "hard_cap_exceeded",
    ],
    [
      "unique proof count above its declared path cap",
      input(
        [
          candidate("first", "+15550000001", "UTILITY"),
          candidate("second", "+15550000002", "UTILITY"),
        ],
        {
          completeness: completeness(2, 2, {
            uniqueRecipientHardCap: 1,
            dispatchItemHardCap: 3_000,
          }),
        }
      ),
      "hard_cap_exceeded",
    ],
    [
      "dispatch proof count above its declared path cap",
      input(
        [
          candidate("first", "+15550000001", "UTILITY"),
          candidate("second", "15550000001", "AUTHENTICATION"),
        ],
        {
          completeness: completeness(1, 2, {
            uniqueRecipientHardCap: 1_000,
            dispatchItemHardCap: 1,
          }),
        }
      ),
      "hard_cap_exceeded",
    ],
  ])("rejects %s with a stable code", async (_label, value, code) => {
    await expectPolicyCode(value, code);
  });

  it("wraps consent and prior-failure helper failures in stable policy errors", async () => {
    await expect(
      evaluateBulkRecipientPolicy(
        input([candidate("marketing", "+15550000001", "MARKETING")]),
        dependencies({ consentError: new Error("database unavailable") })
      )
    ).rejects.toMatchObject({ code: "marketing_consent_lookup_failed" });
    await expect(
      evaluateBulkRecipientPolicy(
        input([candidate("utility", "+15550000001", "UTILITY")], {
          policy: { version: 1, excludePriorFailedBulkSends: true },
          priorFailure: { client: { rpc: jest.fn() }, secret: "test-secret" },
        }),
        dependencies({ priorFailureError: new Error("malformed rpc") })
      )
    ).rejects.toMatchObject({ code: "prior_failure_lookup_failed" });
  });

  it("requires a prior-failure secret only when prior-failure exclusion is enabled", async () => {
    await expect(
      evaluateBulkRecipientPolicy(
        input([candidate("utility", "+15550000001", "UTILITY")], {
          policy: { version: 1, excludePriorFailedBulkSends: true },
          priorFailure: { client: { rpc: jest.fn() }, secret: "" },
        }),
        dependencies()
      )
    ).rejects.toMatchObject({ code: "missing_prior_failure_secret" });
  });

  it("rejects a prior-failure helper result that returns a candidate the engine did not admit", async () => {
    const deps = dependencies();
    deps.filterPriorFailed = jest.fn(async () => ({
      candidates: [candidate("forged", "+15550000009", "UTILITY")],
      skippedPriorFailed: 0,
    })) as unknown as BulkRecipientPolicyDependencies["filterPriorFailed"];

    await expect(
      evaluateBulkRecipientPolicy(
        input([candidate("admitted", "+15550000001", "UTILITY")], {
          policy: { version: 1, excludePriorFailedBulkSends: true },
          priorFailure: { client: { rpc: jest.fn() }, secret: "test-secret" },
        }),
        deps
      )
    ).rejects.toMatchObject({ code: "invariant_imbalance" });
  });

  it("skips recently contacted marketing rows before the daily cap", async () => {
    const deps = dependencies({ recentIds: ["recent"] });
    const result = await evaluateBulkRecipientPolicy(
      input(
        [
          candidate("recent", "+15550000001", "MARKETING"),
          candidate("first", "+15550000002", "MARKETING"),
          candidate("second", "+15550000003", "MARKETING"),
        ],
        { recipientLimit: 2 }
      ),
      deps
    );

    // The cap fills with recipients who can be messaged now.
    expect(result.retained.map(item => item.stableId)).toEqual([
      "first",
      "second",
    ]);
    expect(result.skippedByReason).toEqual({ recent_contact: 1 });
    expect(result.excluded).toEqual([
      expect.objectContaining({
        candidate: expect.objectContaining({ stableId: "recent" }),
        reason: "recent_contact",
      }),
    ]);
    expect(deps.partitionRecentContacts).toHaveBeenCalledWith({
      workspaceId,
      recipients: [
        { phone: "+15550000001", stableId: "recent" },
        { phone: "+15550000002", stableId: "first" },
        { phone: "+15550000003", stableId: "second" },
      ],
      now: undefined,
    });
  });

  it("checks contact windows only for marketing rows that are not opted out", async () => {
    const deps = dependencies();
    const now = new Date("2026-10-19T08:00:00.000Z");
    await evaluateBulkRecipientPolicy(
      input(
        [
          candidate("utility", "+15550000001", "UTILITY"),
          candidate("auth", "+15550000002", "AUTHENTICATION"),
          candidate("marketing", "+15550000003", "MARKETING"),
        ],
        { now }
      ),
      deps
    );

    expect(deps.partitionRecentContacts).toHaveBeenCalledWith({
      workspaceId,
      recipients: [{ phone: "+15550000003", stableId: "marketing" }],
      now,
    });

    const utilityOnly = dependencies();
    await evaluateBulkRecipientPolicy(
      input([candidate("utility", "+15550000001", "UTILITY")]),
      utilityOnly
    );
    expect(utilityOnly.partitionRecentContacts).not.toHaveBeenCalled();
  });

  it("reports an opted-out recipient once even when it was also contacted recently", async () => {
    const deps = dependencies({ optedOutIds: ["Dana"], recentIds: ["dana"] });
    const result = await evaluateBulkRecipientPolicy(
      input([
        {
          ...candidate("dana", "+15550000001", "MARKETING"),
          recipient: { phone: "+15550000001", name: "Dana" },
        },
        candidate("other", "+15550000002", "MARKETING"),
      ]),
      deps
    );

    expect(result.skippedByReason).toEqual({ marketing_opt_out: 1 });
    expect(result.retained.map(item => item.stableId)).toEqual(["other"]);
  });

  it("refuses the send when the contact policy cannot be read", async () => {
    await expect(
      evaluateBulkRecipientPolicy(
        input([candidate("marketing", "+15550000001", "MARKETING")]),
        dependencies({ contactError: new Error("mongo down") })
      )
    ).rejects.toMatchObject({ code: "contact_policy_unavailable" });
  });

  it("does not call the prior-failure helper when its policy is disabled", async () => {
    const deps = dependencies();
    await evaluateBulkRecipientPolicy(
      input([candidate("utility", "+15550000001", "UTILITY")]),
      deps
    );

    expect(deps.filterPriorFailed).not.toHaveBeenCalled();
  });
});

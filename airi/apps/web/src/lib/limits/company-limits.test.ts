const mockConversationCountDocuments = jest.fn();
const mockMessageCountDocuments = jest.fn();
const mockScenarioCountDocuments = jest.fn();
const mockStudioChatCountDocuments = jest.fn();
const mockConnectDB = jest.fn();

let currentConversationCount = 0;
let currentClassificationCount = 0;

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: Array<string | number>) =>
    `icecore:${namespace}:${parts.join(":")}`,
  cache: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    countDocuments: (...args: unknown[]) =>
      mockConversationCountDocuments(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    countDocuments: (...args: unknown[]) => mockMessageCountDocuments(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    countDocuments: (...args: unknown[]) => mockScenarioCountDocuments(...args),
  },
}));

jest.mock("@/models/creative-studio-chat", () => ({
  CreativeStudioChat: {
    countDocuments: (...args: unknown[]) =>
      mockStudioChatCountDocuments(...args),
  },
}));

import {
  COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
  COMPANY_SCENARIO_LIMIT_EXCEEDED_CODE,
  ensureCompanyAiriAutoReplyCapacity,
  ensureCompanyChannelCapacity,
  ensureCompanyClassificationCapacity,
  ensureCompanyCoachCapacity,
  ensureCompanyConversationCapacity,
  ensureCompanyStudioChatCapacity,
  ensureCompanyScenarioCapacity,
  ensureCompanySeatCapacity,
  ensureCompanySeatCapacityForUser,
  ensureCompanyWorkspaceCapacity,
  getCompanyConversationLimitSnapshot,
  isCompanyBulkQuotaRefusal,
  readCompanyBulkRecipientAllowance,
} from "./company-limits";

function queryResult<T>(data: T, error: unknown = null) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error }),
  };
}

function listQueryResult<T>(data: T, error: unknown = null) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockResolvedValue({ data, error }),
  };
}

function createSupabaseMock(options: {
  companyId?: string;
  subscriptionType?: string | null;
  trialStartsAt?: string | null;
  trialEndsAt?: string | null;
  conversationLimit?: number | null;
  workspaceLimit?: number | null;
  seatLimit?: number | null;
  channelLimit?: number | null;
  whatsappNumberLimit?: number | null;
  integrationConnectionLimit?: number | null;
  scenarioLimit?: number | null;
  workspaceIds?: string[];
  seatCount?: number;
  companyUserIds?: Array<string | null | undefined>;
  sourceTypes?: string[];
  /** What the daily usage snapshot still counts; defaults to the live rows. */
  snapshotSourceTypes?: string[];
  snapshotWorkspaceCount?: number;
  activeEmailAddressCount?: number;
  bulkCampaignCount?: number;
  campaignHistoryRows?: Array<{
    total_recipients?: number | null;
    successful_sends?: number | null;
    failed_sends?: number | null;
  }>;
  coachSessionCount?: number;
  classificationCount?: number;
  conversationCount?: number;
  airiAutoReplyCount?: number;
  scenarioCount?: number;
  studioChatCount?: number;
  usageSnapshotMissing?: boolean;
  bulkRecipientUsage?: number;
  bulkRecipientUsageError?: string;
}) {
  const companyId = options.companyId ?? "company-1";
  const workspaceIds = options.workspaceIds ?? ["workspace-1"];
  const workspaceLookup = queryResult({
    id: "workspace-1",
    company_id: companyId,
    companies: {
      subscription_type: options.subscriptionType ?? "free",
      trial_starts_at:
        options.trialStartsAt === undefined
          ? "2026-06-01T00:00:00.000Z"
          : options.trialStartsAt,
      trial_ends_at:
        options.trialEndsAt === undefined
          ? "2099-06-15T00:00:00.000Z"
          : options.trialEndsAt,
      conversation_limit:
        options.conversationLimit === undefined
          ? 500
          : options.conversationLimit,
      workspace_limit:
        options.workspaceLimit === undefined ? 1 : options.workspaceLimit,
      seat_limit: options.seatLimit === undefined ? 1 : options.seatLimit,
      channel_limit:
        options.channelLimit === undefined ? 2 : options.channelLimit,
      whatsapp_number_limit:
        options.whatsappNumberLimit === undefined
          ? 1
          : options.whatsappNumberLimit,
      integration_connection_limit:
        options.integrationConnectionLimit === undefined
          ? 1
          : options.integrationConnectionLimit,
      scenario_limit:
        options.scenarioLimit === undefined ? 5 : options.scenarioLimit,
    },
  });
  const workspaceList = listQueryResult(workspaceIds.map(id => ({ id })));
  const companyUserIds =
    options.companyUserIds ??
    Array.from({ length: options.seatCount ?? 1 }, (_, index) =>
      index === 0 ? "user-1" : `user-${index + 1}`
    );
  let selectedCompanyUsersColumns = "";
  let queriedCompanyUserId = "";
  const companyUsersList: Record<string, jest.Mock> = {
    select: jest.fn((columns: string) => {
      selectedCompanyUsersColumns = columns;
      return companyUsersList;
    }),
    in: jest.fn(() => {
      if (selectedCompanyUsersColumns === "user_id") {
        return Promise.resolve({
          data: companyUserIds.map(userId => ({ user_id: userId })),
          error: null,
        });
      }
      return companyUsersList;
    }),
    eq: jest.fn((column: string, value: unknown) => {
      if (column === "user_id") {
        queriedCompanyUserId = String(value);
      }
      return companyUsersList;
    }),
    limit: jest.fn(() => companyUsersList),
    maybeSingle: jest.fn(() =>
      Promise.resolve({
        data: companyUserIds.includes(queriedCompanyUserId)
          ? { id: "membership-1" }
          : null,
        error: null,
      })
    ),
  };
  let sourcesSelectOptions: unknown;
  const sourcesList: Record<string, jest.Mock> = {
    select: jest.fn((_columns: string, selectOptions?: unknown) => {
      sourcesSelectOptions = selectOptions;
      return sourcesList;
    }),
    eq: jest.fn(() => sourcesList),
    in: jest.fn(() =>
      Promise.resolve(
        sourcesSelectOptions
          ? {
              count: (options.sourceTypes ?? []).filter(
                type => type === "whatsapp"
              ).length,
              error: null,
            }
          : {
              data: (options.sourceTypes ?? []).map(type => ({ type })),
              error: null,
            }
      )
    ),
  };
  const emailAddressCount = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    eq: jest.fn().mockResolvedValue({
      count: options.activeEmailAddressCount ?? 0,
      error: null,
    }),
  };
  type CampaignHistoryCountQueryMock = {
    select: jest.Mock;
    in: jest.Mock;
    range: jest.Mock;
  };

  let selectedCampaignHistoryColumns = "";
  const campaignHistoryCount: CampaignHistoryCountQueryMock = {
    select: jest.fn((columns: string) => {
      selectedCampaignHistoryColumns = columns;
      return campaignHistoryCount;
    }),
    in: jest.fn(() => campaignHistoryCount),
    range: jest.fn().mockImplementation((from: number, to: number) => {
      const rows =
        options.campaignHistoryRows ??
        Array.from({ length: options.bulkCampaignCount ?? 0 }, () => ({
          total_recipients: 1,
          successful_sends: 1,
          failed_sends: 0,
        }));
      return Promise.resolve({
        data: selectedCampaignHistoryColumns.includes("total_recipients")
          ? rows.slice(from, to + 1)
          : undefined,
        count: rows.length,
        error: null,
      });
    }),
  };
  const coachSessionCount = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    eq: jest.fn().mockResolvedValue({
      count: options.coachSessionCount ?? 0,
      error: null,
    }),
  };
  const sourceTypes = options.snapshotSourceTypes ?? options.sourceTypes ?? [];
  const channelTypes = Array.from(new Set(sourceTypes)).sort();
  const integrationConnectionCounts = sourceTypes.reduce<
    Record<string, number>
  >((counts, type) => {
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
  const campaignRows =
    options.campaignHistoryRows ??
    Array.from({ length: options.bulkCampaignCount ?? 0 }, () => ({
      total_recipients: 1,
      successful_sends: 1,
      failed_sends: 0,
    }));
  const usageSnapshot = queryResult({
    company_id: companyId,
    conversation_count: options.conversationCount ?? currentConversationCount,
    workspace_count: options.snapshotWorkspaceCount ?? workspaceIds.length,
    seat_count: new Set(companyUserIds.filter(Boolean)).size,
    channel_count: channelTypes.length,
    channel_types: channelTypes,
    whatsapp_number_count: sourceTypes.filter(type => type === "whatsapp")
      .length,
    integration_connection_counts: integrationConnectionCounts,
    max_integration_connection_count: Math.max(
      0,
      ...Object.values(integrationConnectionCounts)
    ),
    airi_auto_reply_count: options.airiAutoReplyCount ?? 0,
    scenario_count: options.scenarioCount ?? 0,
    bulk_campaign_count: campaignRows.filter(row =>
      row.successful_sends
        ? true
        : (row.total_recipients ?? 0) > 0 &&
          (row.failed_sends ?? 0) < (row.total_recipients ?? 0)
    ).length,
    classification_count:
      options.classificationCount ?? currentClassificationCount,
    coach_count: options.coachSessionCount ?? 0,
    studio_chat_count: options.studioChatCount ?? 0,
    last_event_at: "2026-06-16T00:00:00.000Z",
    repaired_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
  });
  const missingUsageSnapshot = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    upsert: jest.fn().mockResolvedValue({ error: null }),
  };

  return {
    from: jest.fn((table: string) => {
      if (table === "workspaces") {
        return workspaceLookup.select.mock.calls.length === 0
          ? workspaceLookup
          : workspaceList;
      }
      if (table === "company_users") return companyUsersList;
      if (table === "sources") return sourcesList;
      if (table === "workspace_email_addresses") return emailAddressCount;
      if (table === "campaign_history") return campaignHistoryCount;
      if (table === "airi_sessions") return coachSessionCount;
      if (table === "company_usage_snapshots") {
        return options.usageSnapshotMissing
          ? missingUsageSnapshot
          : usageSnapshot;
      }
      throw new Error(`Unexpected Supabase table: ${table}`);
    }),
    rpc: jest.fn((name: string, args: { p_company_ids: string[] }) => {
      if (name !== "get_company_bulk_recipient_usage") {
        throw new Error(`Unexpected Supabase RPC: ${name}`);
      }
      return Promise.resolve(
        options.bulkRecipientUsageError
          ? { data: null, error: { message: options.bulkRecipientUsageError } }
          : {
              data: args.p_company_ids.map(company_id => ({
                company_id,
                used_recipients: options.bulkRecipientUsage ?? 0,
              })),
              error: null,
            }
      );
    }),
  };
}

function mockConversationCounts(options: {
  conversationCount?: number;
  classificationCount?: number;
}) {
  currentConversationCount = options.conversationCount ?? 0;
  currentClassificationCount = options.classificationCount ?? 0;
  mockConversationCountDocuments.mockImplementation(
    (filter: Record<string, unknown>) => {
      if (
        Object.prototype.hasOwnProperty.call(filter, "classification.category")
      ) {
        return Promise.resolve(options.classificationCount ?? 0);
      }
      return Promise.resolve(options.conversationCount ?? 0);
    }
  );
}

describe("getCompanyConversationLimitSnapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockConversationCounts({});
    mockMessageCountDocuments.mockResolvedValue(0);
    mockScenarioCountDocuments.mockResolvedValue(0);
    mockStudioChatCountDocuments.mockResolvedValue(0);
  });

  it("keeps free companies unlocked below the lifetime company cap", async () => {
    mockConversationCounts({ conversationCount: 499 });
    const supabase = createSupabaseMock({
      subscriptionType: "free",
      conversationLimit: 500,
      workspaceIds: ["workspace-1", "workspace-2"],
    });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        companyId: "company-1",
        subscriptionType: "free",
        trialStartsAt: "2026-06-01T00:00:00.000Z",
        trialEndsAt: "2099-06-15T00:00:00.000Z",
        trialExpired: false,
        conversationLimit: 500,
        conversationCount: 499,
        conversationsRemaining: 1,
        visibleConversationLimit: 500,
        visibleConversationCount: 499,
        hiddenConversationCount: 0,
        workspaceLimit: 1,
        workspaceCount: 2,
        workspacesRemaining: 0,
        workspaceExhausted: true,
        seatLimit: 1,
        seatCount: 1,
        seatsRemaining: 0,
        channelLimit: 2,
        channelCount: 0,
        channelsRemaining: 2,
        airiAutoReplyLimit: 100,
        airiAutoReplyCount: 0,
        airiAutoRepliesRemaining: 100,
        classificationLimit: 500,
        classificationCount: 0,
        classificationsRemaining: 500,
        classificationExhausted: false,
        coachLimit: 500,
        coachCount: 0,
        coachSessionsRemaining: 500,
        coachExhausted: false,
        scenarioLimit: 5,
        scenarioCount: 0,
        scenariosRemaining: 5,
        exhausted: false,
        lockedCapabilities: ["workspace_creation", "team_invites"],
      })
    );
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockConversationCountDocuments).not.toHaveBeenCalled();
  });

  it("locks free companies at the lifetime company cap", async () => {
    mockConversationCounts({ conversationCount: 500 });
    const supabase = createSupabaseMock({
      subscriptionType: "free",
      conversationLimit: 500,
    });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        subscriptionType: "free",
        conversationLimit: 500,
        conversationCount: 500,
        conversationsRemaining: 0,
        visibleConversationLimit: 500,
        visibleConversationCount: 500,
        hiddenConversationCount: 0,
        exhausted: true,
        lockedCapabilities: [
          "new_conversations",
          "workspace_creation",
          "team_invites",
        ],
      })
    );
    expect(COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE).toBe(
      "company_conversation_limit_exceeded"
    );
  });

  it("repairs a missing company usage snapshot before enforcing limits", async () => {
    mockConversationCounts({
      conversationCount: 432,
      classificationCount: 379,
    });
    const supabase = createSupabaseMock({
      usageSnapshotMissing: true,
      sourceTypes: ["whatsapp"],
    });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        conversationLimit: 500,
        conversationCount: 432,
        conversationsRemaining: 68,
        channelTypes: ["whatsapp"],
        whatsappNumberCount: 1,
        classificationsRemaining: 121,
      })
    );
    expect(mockConnectDB).toHaveBeenCalledTimes(1);
  });

  it("keeps pro companies unlocked even above the free cap", async () => {
    mockConversationCounts({ conversationCount: 2000 });
    const supabase = createSupabaseMock({
      subscriptionType: "pro",
      conversationLimit: 500,
    });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        subscriptionType: "pro",
        conversationLimit: null,
        conversationCount: 2000,
        conversationsRemaining: null,
        visibleConversationLimit: null,
        visibleConversationCount: 2000,
        hiddenConversationCount: 0,
        workspaceLimit: 1,
        workspacesRemaining: 0,
        workspaceExhausted: true,
        seatLimit: 1,
        seatsRemaining: 0,
        seatExhausted: true,
        channelLimit: null,
        channelsRemaining: null,
        whatsappNumberLimit: 1,
        integrationConnectionLimit: 1,
        airiAutoReplyLimit: null,
        airiAutoRepliesRemaining: null,
        classificationLimit: null,
        classificationsRemaining: null,
        classificationExhausted: false,
        coachLimit: null,
        coachSessionsRemaining: null,
        coachExhausted: false,
        studioChatLimit: null,
        studioChatsRemaining: null,
        studioChatExhausted: false,
        scenarioLimit: 50,
        scenariosRemaining: 50,
        exhausted: false,
        lockedCapabilities: ["workspace_creation", "team_invites"],
      })
    );
  });

  it("locks free trial companies after the 14-day trial expires", async () => {
    mockConversationCounts({ conversationCount: 12 });
    const supabase = createSupabaseMock({
      subscriptionType: "free",
      trialStartsAt: "2026-05-01T00:00:00.000Z",
      trialEndsAt: "2026-05-15T00:00:00.000Z",
    });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        subscriptionType: "free",
        trialExpired: true,
        visibleConversationLimit: 0,
        visibleConversationCount: 0,
        hiddenConversationCount: 12,
        exhausted: true,
      })
    );
    expect(snapshot.lockedCapabilities).toEqual(
      expect.arrayContaining([
        "trial_expired",
        "new_conversations",
        "workspace_creation",
        "team_invites",
        "channel_connections",
        "airi_auto_replies",
      ])
    );
  });

  it("uses enterprise unlimited capacity and 20x AI limits", async () => {
    mockConversationCounts({ conversationCount: 10_000 });
    mockMessageCountDocuments.mockResolvedValue(1999);
    mockScenarioCountDocuments.mockResolvedValue(500);
    const supabase = createSupabaseMock({
      subscriptionType: "enterprise",
      workspaceIds: ["workspace-1", "workspace-2"],
      companyUserIds: ["owner-1", "member-1"],
      sourceTypes: ["whatsapp", "whatsapp", "telegram", "email"],
      bulkCampaignCount: 100,
      coachSessionCount: 1999,
      airiAutoReplyCount: 1999,
      scenarioCount: 500,
    });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        subscriptionType: "enterprise",
        conversationLimit: null,
        workspaceLimit: null,
        seatLimit: null,
        channelLimit: null,
        whatsappNumberLimit: null,
        integrationConnectionLimit: null,
        scenarioLimit: null,
        bulkRecipientLimit: null,
        airiAutoReplyLimit: 2000,
        classificationLimit: 10000,
        coachLimit: 10000,
        studioChatLimit: 10000,
        lockedCapabilities: [],
      })
    );
  });

  it("reports the full free-plan company usage snapshot across workspaces", async () => {
    mockConversationCounts({
      conversationCount: 125,
      classificationCount: 120,
    });
    mockMessageCountDocuments.mockResolvedValue(99);
    mockScenarioCountDocuments.mockResolvedValue(4);
    const supabase = createSupabaseMock({
      workspaceIds: ["workspace-1", "workspace-2"],
      seatCount: 1,
      sourceTypes: ["whatsapp", "telegram", "email"],
      airiAutoReplyCount: 99,
      scenarioCount: 4,
    });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        conversationCount: 125,
        seatCount: 1,
        seatsRemaining: 0,
        channelTypes: ["email", "telegram", "whatsapp"],
        channelCount: 3,
        channelsRemaining: 0,
        channelExhausted: true,
        airiAutoReplyCount: 99,
        airiAutoRepliesRemaining: 1,
        airiAutoReplyExhausted: false,
        classificationCount: 120,
        classificationsRemaining: 380,
        classificationExhausted: false,
        coachCount: 0,
        coachSessionsRemaining: 500,
        coachExhausted: false,
        scenarioCount: 4,
        scenariosRemaining: 1,
        scenarioExhausted: false,
      })
    );
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockConversationCountDocuments).not.toHaveBeenCalled();
    expect(mockMessageCountDocuments).not.toHaveBeenCalled();
    expect(mockScenarioCountDocuments).not.toHaveBeenCalled();
  });

  it("counts unique users once when a teammate belongs to multiple company workspaces", async () => {
    const supabase = createSupabaseMock({
      workspaceIds: ["workspace-1", "workspace-2", "workspace-3"],
      companyUserIds: ["owner-1", "owner-1", "owner-1"],
    });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        seatCount: 1,
        seatsRemaining: 0,
        seatExhausted: true,
      })
    );
  });

  it("does not count pending membership rows without a user id as occupied seats", async () => {
    const supabase = createSupabaseMock({
      companyUserIds: ["owner-1", null],
    });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        seatCount: 1,
        seatsRemaining: 0,
        seatExhausted: true,
      })
    );
  });

  it("blocks a new distinct channel after the free channel cap", async () => {
    const supabase = createSupabaseMock({
      sourceTypes: ["whatsapp", "telegram"],
    });

    const result = await ensureCompanyChannelCapacity(
      supabase as never,
      "workspace-1",
      "instagram"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("channel_connections");
    expect(COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE).toBe(
      "company_channel_limit_exceeded"
    );
  });

  it("blocks a second connection for an already counted integration type", async () => {
    const supabase = createSupabaseMock({
      sourceTypes: ["whatsapp", "telegram"],
    });

    const result = await ensureCompanyChannelCapacity(
      supabase as never,
      "workspace-1",
      "telegram"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain(
      "integration_connections"
    );
  });

  it("blocks team invites once the free seat is already occupied", async () => {
    const supabase = createSupabaseMock({
      seatCount: 1,
    });

    const result = await ensureCompanySeatCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("team_invites");
  });

  it("uses a configured company seat limit for pro team invites", async () => {
    const supabase = createSupabaseMock({
      subscriptionType: "pro",
      seatLimit: 5,
      companyUserIds: ["owner-1", "member-1"],
    });

    const result = await ensureCompanySeatCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(true);
    expect(result.limit.seatLimit).toBe(5);
    expect(result.limit.seatCount).toBe(2);
    expect(result.limit.seatsRemaining).toBe(3);
    expect(result.limit.lockedCapabilities).not.toContain("team_invites");
  });

  it("blocks workspace creation once the workspace cap is reached", async () => {
    const supabase = createSupabaseMock({
      workspaceIds: ["workspace-1"],
    });

    const result = await ensureCompanyWorkspaceCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("workspace_creation");
  });

  it("blocks new conversations once the free conversation cap is reached", async () => {
    mockConversationCounts({ conversationCount: 500 });
    const supabase = createSupabaseMock({
      subscriptionType: "free",
    });

    const result = await ensureCompanyConversationCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("new_conversations");
    expect(result.limit).toEqual(
      expect.objectContaining({
        subscriptionType: "free",
        conversationLimit: 500,
        conversationCount: 500,
        conversationsRemaining: 0,
        conversationExhausted: true,
      })
    );
  });

  it("allows adding an already-counted company user to another workspace at the seat cap", async () => {
    const supabase = createSupabaseMock({
      workspaceIds: ["workspace-1", "workspace-2"],
      companyUserIds: ["owner-1", "member-1"],
    });

    const result = await ensureCompanySeatCapacityForUser(
      supabase as never,
      "workspace-1",
      "member-1"
    );

    expect(result.allowed).toBe(true);
  });

  it("blocks adding a new company user at the seat cap", async () => {
    const supabase = createSupabaseMock({
      workspaceIds: ["workspace-1", "workspace-2"],
      companyUserIds: ["owner-1", "member-1"],
    });

    const result = await ensureCompanySeatCapacityForUser(
      supabase as never,
      "workspace-1",
      "new-user-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("team_invites");
  });

  it("blocks Airi auto-replies at the free auto-reply cap", async () => {
    mockMessageCountDocuments.mockResolvedValue(100);
    const supabase = createSupabaseMock({ airiAutoReplyCount: 100 });

    const result = await ensureCompanyAiriAutoReplyCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("airi_auto_replies");
  });

  it("leaves Pro inference admission to the monthly ledger instead of lifetime reply counts", async () => {
    const belowCap = await ensureCompanyAiriAutoReplyCapacity(
      createSupabaseMock({
        subscriptionType: "pro",
        airiAutoReplyCount: 4_999,
      }) as never,
      "workspace-1"
    );

    expect(belowCap.allowed).toBe(true);
    expect(belowCap.limit).toEqual(
      expect.objectContaining({
        airiAutoReplyLimit: null,
        airiAutoReplyCount: 4_999,
        airiAutoRepliesRemaining: null,
        airiAutoReplyExhausted: false,
      })
    );

    const atCap = await ensureCompanyAiriAutoReplyCapacity(
      createSupabaseMock({
        subscriptionType: "pro",
        airiAutoReplyCount: 5_000,
      }) as never,
      "workspace-1"
    );

    expect(atCap.allowed).toBe(true);
    expect(atCap.limit).toEqual(
      expect.objectContaining({
        airiAutoReplyLimit: null,
        airiAutoReplyCount: 5_000,
        airiAutoRepliesRemaining: null,
        airiAutoReplyExhausted: false,
      })
    );
    expect(atCap.limit.lockedCapabilities).not.toContain("airi_auto_replies");
  });

  it("blocks background feature work when the company conversation cap is reached", async () => {
    mockConversationCounts({ conversationCount: 500 });
    const createBlockedCompanySupabase = () =>
      createSupabaseMock({
        subscriptionType: "free",
        airiAutoReplyCount: 0,
        coachSessionCount: 0,
        studioChatCount: 0,
        scenarioCount: 0,
        bulkCampaignCount: 0,
      });

    const results = [];
    results.push(
      await ensureCompanyAiriAutoReplyCapacity(
        createBlockedCompanySupabase() as never,
        "workspace-1"
      )
    );
    results.push(
      await ensureCompanyClassificationCapacity(
        createBlockedCompanySupabase() as never,
        "workspace-1"
      )
    );
    results.push(
      await ensureCompanyCoachCapacity(
        createBlockedCompanySupabase() as never,
        "workspace-1"
      )
    );
    results.push(
      await ensureCompanyStudioChatCapacity(
        createBlockedCompanySupabase() as never,
        "workspace-1"
      )
    );
    results.push(
      await ensureCompanyScenarioCapacity(
        createBlockedCompanySupabase() as never,
        "workspace-1"
      )
    );
    expect(results.every(result => result.allowed === false)).toBe(true);
    expect(results[0]?.limit).toEqual(
      expect.objectContaining({
        conversationCount: 500,
        conversationExhausted: true,
      })
    );
  });

  it("blocks classifications at the free classification cap", async () => {
    mockConversationCounts({ classificationCount: 500 });
    const supabase = createSupabaseMock({});

    const result = await ensureCompanyClassificationCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("classifications");
  });

  it("does not block Pro classifications using the retired lifetime cap", async () => {
    mockConversationCounts({ classificationCount: 2500 });
    const supabase = createSupabaseMock({ subscriptionType: "pro" });

    const result = await ensureCompanyClassificationCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(true);
    expect(result.limit.lockedCapabilities).not.toContain("classifications");
  });

  it("blocks coach sessions at the free coach cap", async () => {
    const supabase = createSupabaseMock({ coachSessionCount: 500 });

    const result = await ensureCompanyCoachCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("coach");
  });

  it("does not block Pro coach actions using the retired lifetime cap", async () => {
    const supabase = createSupabaseMock({
      subscriptionType: "pro",
      coachSessionCount: 2500,
    });

    const result = await ensureCompanyCoachCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(true);
    expect(result.limit.lockedCapabilities).not.toContain("coach");
  });

  it("blocks studio chats at the free studio chat cap", async () => {
    mockStudioChatCountDocuments.mockResolvedValue(500);
    const supabase = createSupabaseMock({ studioChatCount: 500 });

    const result = await ensureCompanyStudioChatCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("studio_chats");
  });

  it("blocks new scenario creation at the free scenario cap", async () => {
    mockScenarioCountDocuments.mockResolvedValue(5);
    const supabase = createSupabaseMock({ scenarioCount: 5 });

    const result = await ensureCompanyScenarioCapacity(
      supabase as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.lockedCapabilities).toContain("scenario_creation");
    expect(COMPANY_SCENARIO_LIMIT_EXCEEDED_CODE).toBe(
      "company_scenario_limit_exceeded"
    );
  });

  it("reads free bulk recipient usage only when the caller asks for it", async () => {
    const supabase = createSupabaseMock({ bulkRecipientUsage: 120 });

    const snapshot = await getCompanyConversationLimitSnapshot(
      supabase as never,
      "workspace-1"
    );
    expect(snapshot).toEqual(
      expect.objectContaining({
        bulkRecipientLimit: 500,
        bulkRecipientCount: null,
        bulkRecipientsRemaining: null,
        bulkRecipientExhausted: false,
      })
    );
    expect(supabase.rpc).not.toHaveBeenCalled();

    const usageClient = createSupabaseMock({ bulkRecipientUsage: 120 });
    const withUsage = await getCompanyConversationLimitSnapshot(
      usageClient as never,
      "workspace-1",
      { includeBulkRecipientUsage: true }
    );
    expect(usageClient.rpc).toHaveBeenCalledWith(
      "get_company_bulk_recipient_usage",
      { p_company_ids: ["company-1"] }
    );
    expect(withUsage).toEqual(
      expect.objectContaining({
        bulkRecipientLimit: 500,
        bulkRecipientCount: 120,
        bulkRecipientsRemaining: 380,
        bulkRecipientExhausted: false,
      })
    );
    expect(withUsage.lockedCapabilities).not.toContain("bulk_campaigns");
  });

  it("locks bulk campaigns once the free bulk recipients are used up", async () => {
    const supabase = createSupabaseMock({ bulkRecipientUsage: 512 });

    const allowance = await readCompanyBulkRecipientAllowance(
      supabase as never,
      "workspace-1"
    );

    expect(allowance.remaining).toBe(0);
    expect(allowance.limit).toEqual(
      expect.objectContaining({
        bulkRecipientCount: 512,
        bulkRecipientsRemaining: 0,
        bulkRecipientExhausted: true,
        anyLimitExhausted: true,
      })
    );
    expect(allowance.limit.lockedCapabilities).toContain("bulk_campaigns");
  });

  it("never reads bulk recipient usage for unlimited plans", async () => {
    const supabase = createSupabaseMock({
      subscriptionType: "pro",
      bulkRecipientUsage: 10_000,
    });

    const allowance = await readCompanyBulkRecipientAllowance(
      supabase as never,
      "workspace-1"
    );

    expect(allowance.remaining).toBeNull();
    expect(allowance.limit.bulkRecipientLimit).toBeNull();
    expect(allowance.limit.bulkRecipientExhausted).toBe(false);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("fails instead of guessing when free bulk recipient usage is unreadable", async () => {
    const supabase = createSupabaseMock({
      bulkRecipientUsageError: "function does not exist",
    });

    await expect(
      readCompanyBulkRecipientAllowance(supabase as never, "workspace-1")
    ).rejects.toThrow("function does not exist");
  });
});

describe("WhatsApp number and workspace limits", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockConversationCounts({});
    mockMessageCountDocuments.mockResolvedValue(0);
    mockScenarioCountDocuments.mockResolvedValue(0);
    mockStudioChatCountDocuments.mockResolvedValue(0);
  });

  const connectWhatsApp = (supabase: ReturnType<typeof createSupabaseMock>) =>
    ensureCompanyChannelCapacity(supabase as never, "workspace-1", "whatsapp");

  it("uses a configured WhatsApp number limit for a Pro company", async () => {
    const result = await connectWhatsApp(
      createSupabaseMock({
        subscriptionType: "pro",
        whatsappNumberLimit: 3,
        workspaceIds: ["workspace-1", "workspace-2"],
        sourceTypes: ["whatsapp", "whatsapp"],
      })
    );

    expect(result.allowed).toBe(true);
    expect(result.limit).toEqual(
      expect.objectContaining({
        whatsappNumberLimit: 3,
        whatsappNumberCount: 2,
        whatsappNumbersRemaining: 1,
        whatsappNumberExhausted: false,
      })
    );
  });

  it("falls back to the plan's one number when no limit is configured", async () => {
    const result = await connectWhatsApp(
      createSupabaseMock({
        subscriptionType: "pro",
        whatsappNumberLimit: null,
        sourceTypes: ["whatsapp"],
      })
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.whatsappNumberLimit).toBe(1);
    expect(result.limit.lockedCapabilities).toContain(
      "whatsapp_number_connections"
    );
  });

  it("keeps Enterprise unlimited whatever the company row says", async () => {
    const result = await connectWhatsApp(
      createSupabaseMock({
        subscriptionType: "enterprise",
        whatsappNumberLimit: 1,
        workspaceLimit: 1,
        workspaceIds: ["workspace-1", "workspace-2", "workspace-3"],
        sourceTypes: ["whatsapp", "whatsapp", "whatsapp"],
      })
    );

    expect(result.allowed).toBe(true);
    expect(result.limit.whatsappNumberLimit).toBeNull();
    expect(result.limit.workspaceLimit).toBeNull();
  });

  it("does not count WhatsApp numbers against the one-connection-per-type limit", async () => {
    const result = await connectWhatsApp(
      createSupabaseMock({
        subscriptionType: "pro",
        whatsappNumberLimit: 3,
        integrationConnectionLimit: 1,
        workspaceIds: ["workspace-1", "workspace-2"],
        sourceTypes: ["whatsapp", "whatsapp"],
      })
    );

    expect(result.allowed).toBe(true);
    expect(result.limit.integrationConnectionExhausted).toBe(false);
    expect(result.limit.lockedCapabilities).not.toContain(
      "integration_connections"
    );
  });

  it("gives a raised WhatsApp limit the workspaces its numbers need", async () => {
    const result = await ensureCompanyWorkspaceCapacity(
      createSupabaseMock({
        subscriptionType: "pro",
        workspaceLimit: 1,
        whatsappNumberLimit: 3,
        workspaceIds: ["workspace-1", "workspace-2"],
      }) as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(true);
    expect(result.limit.workspaceLimit).toBe(3);
    expect(result.limit.workspacesRemaining).toBe(1);
  });

  it("uses a configured workspace limit above the WhatsApp number limit", async () => {
    const result = await ensureCompanyWorkspaceCapacity(
      createSupabaseMock({
        subscriptionType: "free",
        workspaceLimit: 4,
        whatsappNumberLimit: null,
        workspaceIds: ["workspace-1"],
      }) as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(true);
    expect(result.limit.workspaceLimit).toBe(4);
  });

  it("counts WhatsApp numbers live after one was removed since the daily snapshot", async () => {
    const result = await connectWhatsApp(
      createSupabaseMock({
        subscriptionType: "free",
        sourceTypes: [],
        snapshotSourceTypes: ["whatsapp"],
      })
    );

    expect(result.allowed).toBe(true);
    expect(result.limit.whatsappNumberCount).toBe(0);
  });

  it("counts WhatsApp numbers live after one was connected since the daily snapshot", async () => {
    const result = await connectWhatsApp(
      createSupabaseMock({
        subscriptionType: "free",
        sourceTypes: ["whatsapp"],
        snapshotSourceTypes: [],
      })
    );

    expect(result.allowed).toBe(false);
    expect(result.limit.whatsappNumberCount).toBe(1);
  });

  it("counts workspaces live at the creation gate", async () => {
    const result = await ensureCompanyWorkspaceCapacity(
      createSupabaseMock({
        subscriptionType: "pro",
        workspaceLimit: 2,
        workspaceIds: ["workspace-1"],
        snapshotWorkspaceCount: 2,
      }) as never,
      "workspace-1"
    );

    expect(result.allowed).toBe(true);
    expect(result.limit.workspaceCount).toBe(1);
  });
});

describe("isCompanyBulkQuotaRefusal", () => {
  it.each([
    [
      "an allowance refusal",
      {
        company_bulk_campaign_limit: 500,
        company_bulk_campaign_count: 499,
        company_bulk_recipient_count: 2,
      },
      true,
    ],
    [
      "a send that would have fit",
      {
        company_bulk_campaign_limit: 500,
        company_bulk_campaign_count: 498,
        company_bulk_recipient_count: 2,
      },
      false,
    ],
    [
      "an older campaign count refusal",
      { company_bulk_campaign_limit: 2, company_bulk_campaign_count: 2 },
      true,
    ],
    [
      "an older refusal below the limit",
      { company_bulk_campaign_limit: 2, company_bulk_campaign_count: 1 },
      false,
    ],
    [
      "a negative usage",
      {
        company_bulk_campaign_limit: 500,
        company_bulk_campaign_count: -1,
        company_bulk_recipient_count: 600,
      },
      false,
    ],
    [
      "a string count",
      {
        company_bulk_campaign_limit: 500,
        company_bulk_campaign_count: "500",
      },
      false,
    ],
  ])("validates %s", (_case, row, expected) => {
    expect(isCompanyBulkQuotaRefusal(row)).toBe(expected);
  });
});

const mockConnectDB = jest.fn();
const mockConversationCountDocuments = jest.fn();
const mockScenarioCountDocuments = jest.fn();
const mockCreativeStudioChatCountDocuments = jest.fn();

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

jest.mock("@/models/scenario", () => ({
  Scenario: {
    countDocuments: (...args: unknown[]) => mockScenarioCountDocuments(...args),
  },
}));

jest.mock("@/models/creative-studio-chat", () => ({
  CreativeStudioChat: {
    countDocuments: (...args: unknown[]) =>
      mockCreativeStudioChatCountDocuments(...args),
  },
}));

jest.mock("@icecore/shared/types/sources", () => ({
  isOnboardingTestSource: jest.fn(() => false),
}));

jest.mock("@/lib/campaign/campaign-history-limit", () => ({
  campaignHistoryCountsTowardBulkLimit: jest.fn(() => true),
}));

jest.mock("./company-usage-snapshots", () => ({
  invalidateCompanyUsageSnapshotCache: jest.fn(async () => undefined),
}));

import { WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION } from "@icecore/temporal";
import { repairCompanyUsageSnapshots } from "./company-usage-repair";

function createSupabaseMock(options: { existingAiriAutoReplyCount?: number }) {
  const upsert = jest.fn(async () => ({ error: null }));
  const usageSnapshotQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(async () => ({
      data:
        options.existingAiriAutoReplyCount === undefined
          ? null
          : {
              company_id: "company-1",
              airi_auto_reply_count: options.existingAiriAutoReplyCount,
            },
      error: null,
    })),
    upsert,
  };

  return {
    upsert,
    from: jest.fn((table: string) => {
      if (table === "workspaces") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn(async () => ({
            data: [{ id: "workspace-1" }, { id: "workspace-2" }],
            error: null,
          })),
        };
      }
      if (table === "company_users") {
        return {
          select: jest.fn().mockReturnThis(),
          in: jest.fn(async () => ({
            data: [{ user_id: "user-1" }, { user_id: "user-1" }],
            error: null,
          })),
        };
      }
      if (table === "sources") {
        return {
          select: jest.fn().mockReturnThis(),
          in: jest.fn(async () => ({ data: [], error: null })),
        };
      }
      if (table === "campaign_history") {
        return {
          select: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          range: jest.fn(async () => ({ data: [], error: null })),
        };
      }
      if (table === "airi_sessions") {
        return {
          select: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          eq: jest.fn(async () => ({ count: 0, error: null })),
        };
      }
      if (table === "company_usage_snapshots") {
        return usageSnapshotQuery;
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  };
}

describe("repairCompanyUsageSnapshots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockConversationCountDocuments.mockResolvedValue(11);
    mockScenarioCountDocuments.mockResolvedValue(3);
    mockCreativeStudioChatCountDocuments.mockResolvedValue(5);
  });

  it("preserves the existing Airi auto-reply counter during scheduled repair", async () => {
    const supabase = createSupabaseMock({ existingAiriAutoReplyCount: 42 });

    const result = await repairCompanyUsageSnapshots(supabase as never, {
      contractVersion: WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION,
      companyIds: ["company-1"],
      reason: "scheduled_repair",
    });

    expect(supabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-1",
        airi_auto_reply_count: 42,
      }),
      { onConflict: "company_id" }
    );
    expect(result.companies[0]).toEqual(
      expect.objectContaining({
        companyId: "company-1",
        airiAutoReplyCount: 42,
      })
    );
  });

  it("preserves the materialized Airi counter even for legacy deep-repair input", async () => {
    const supabase = createSupabaseMock({ existingAiriAutoReplyCount: 42 });

    const result = await repairCompanyUsageSnapshots(
      supabase as never,
      {
        contractVersion: WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION,
        companyIds: ["company-1"],
        reason: "manual_backfill",
        includeHistoricalMessageCounts: true,
      } as never
    );

    expect(supabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-1",
        airi_auto_reply_count: 42,
      }),
      { onConflict: "company_id" }
    );
    expect(result.companies[0]).toEqual(
      expect.objectContaining({
        companyId: "company-1",
        airiAutoReplyCount: 42,
      })
    );
  });
});

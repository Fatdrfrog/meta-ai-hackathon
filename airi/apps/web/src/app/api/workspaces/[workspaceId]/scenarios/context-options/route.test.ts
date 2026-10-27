const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockGetWorkspaceCompanyInfo = jest.fn();
const mockConnectDB = jest.fn();
const mockConversationCountDocuments = jest.fn();
const mockAnswerSnippetCountDocuments = jest.fn();
const mockQuickReplyCountDocuments = jest.fn();
const mockSupabaseFrom = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getWorkspaceCompanyInfo: (...args: unknown[]) =>
    mockGetWorkspaceCompanyInfo(...args),
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

jest.mock("@/models/answer-snippet", () => ({
  __esModule: true,
  default: {
    countDocuments: (...args: unknown[]) =>
      mockAnswerSnippetCountDocuments(...args),
  },
}));

jest.mock("@/models/quick-reply", () => ({
  QuickReply: {
    countDocuments: (...args: unknown[]) =>
      mockQuickReplyCountDocuments(...args),
  },
}));

import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";

import { GET } from "./route";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

describe("GET /api/workspaces/[workspaceId]/scenarios/context-options", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: { from: (...args: unknown[]) => mockSupabaseFrom(...args) },
    });
    mockGetWorkspaceCompanyInfo.mockResolvedValue(null);
    mockConnectDB.mockResolvedValue(undefined);
    mockSupabaseFrom.mockImplementation(() =>
      createSupabaseQueryMock({ data: null, count: 6, error: null })
    );
    mockConversationCountDocuments
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    mockAnswerSnippetCountDocuments.mockResolvedValue(3);
    mockQuickReplyCountDocuments.mockResolvedValue(5);
  });

  it("counts manual active labels independently and gates only active classification", async () => {
    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockConversationCountDocuments).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      $or: [
        {
          internal_labels: {
            $in: ["stage:active", "subscription:active"],
          },
        },
        {
          $and: [
            { "classification.category": "active" },
            buildCurrentConversationClassificationFilter(),
          ],
        },
      ],
    });
    const payload = await response.json();
    expect(payload.stats.activeSubscriptionCount).toBe(2);
    expect(
      payload.options.find(
        (option: { id: string }) => option.id === "active_subscriptions"
      )
    ).toEqual(expect.objectContaining({ count: 2, available: true }));
  });
});

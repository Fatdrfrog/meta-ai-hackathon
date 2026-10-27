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
  default: jest.fn(),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {},
}));

jest.mock("@/models/creative-studio-chat", () => ({
  CreativeStudioChat: {},
}));

import { getCompanyLimitSummaries } from "./company-limit-summaries";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

const createCompaniesQuery = (data: unknown[], count: number) =>
  createSupabaseQueryMock({ data, error: null, count });
const createListQuery = (data: unknown[]) =>
  createSupabaseQueryMock({ data, error: null });

describe("getCompanyLimitSummaries", () => {
  it("builds batched limit summaries from company usage snapshots", async () => {
    const companies = [
      {
        id: "company-airi",
        name: "Airi.chat",
        slug: "airichat",
        subscription_type: "pro",
        trial_starts_at: null,
        trial_ends_at: null,
        seat_limit: 1,
        created_at: "2026-02-07T10:38:00.235351+00:00",
      },
      {
        id: "company-bahaai",
        name: "Bahaai",
        slug: "bahaai-c71e3e5e",
        subscription_type: "free",
        trial_starts_at: "2026-06-24T13:08:25.583381+00:00",
        trial_ends_at: "2099-07-08T13:08:25.583381+00:00",
        seat_limit: 1,
        created_at: "2026-06-24T13:08:25.583381+00:00",
      },
    ];
    const workspaces = [
      {
        id: "workspace-airi",
        name: "Airi.chat",
        company_id: "company-airi",
        created_at: "2026-02-07T10:38:00.562051+00:00",
      },
      {
        id: "workspace-bahaai",
        name: "Bahaai",
        company_id: "company-bahaai",
        created_at: "2026-06-24T13:08:25.583381+00:00",
      },
    ];
    const snapshots = [
      {
        company_id: "company-bahaai",
        conversation_count: 11,
        workspace_count: 1,
        seat_count: 1,
        channel_count: 1,
        channel_types: ["whatsapp"],
        whatsapp_number_count: 1,
        integration_connection_counts: { whatsapp: 1 },
        max_integration_connection_count: 1,
        airi_auto_reply_count: 0,
        scenario_count: 1,
        bulk_campaign_count: 0,
        classification_count: 8,
        coach_count: 0,
        studio_chat_count: 2,
        last_event_at: "2026-06-30T20:29:54.658+00:00",
        repaired_at: "2026-07-01T00:00:27.786+00:00",
        updated_at: "2026-07-01T00:00:27.786+00:00",
      },
    ];
    const supabase = {
      from: jest.fn((table: string) => {
        if (table === "companies") {
          return createCompaniesQuery(companies, companies.length);
        }
        if (table === "workspaces") {
          return createListQuery(workspaces);
        }
        if (table === "company_usage_snapshots") {
          return createListQuery(snapshots);
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
      rpc: jest.fn(
        async (_name: string, args: { p_company_ids: string[] }) => ({
          data: args.p_company_ids.map(company_id => ({
            company_id,
            used_recipients: company_id === "company-bahaai" ? 120 : 9000,
          })),
          error: null,
        })
      ),
    };

    const result = await getCompanyLimitSummaries(supabase as never);

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "get_company_bulk_recipient_usage",
      { p_company_ids: ["company-airi", "company-bahaai"] }
    );
    expect(result.truncated).toBe(false);
    expect(result.companies).toHaveLength(2);
    expect(result.companies[0]).toEqual(
      expect.objectContaining({
        isInternalCompany: true,
        limit: expect.objectContaining({
          subscriptionType: "pro",
          conversationLimit: null,
          bulkRecipientLimit: null,
          bulkRecipientCount: null,
        }),
      })
    );
    expect(result.companies[1]).toEqual(
      expect.objectContaining({
        isInternalCompany: false,
        company: expect.objectContaining({ name: "Bahaai" }),
        snapshot: expect.objectContaining({ missing: false }),
        limit: expect.objectContaining({
          subscriptionType: "free",
          conversationCount: 11,
          conversationsRemaining: 489,
          workspacesRemaining: 0,
          channelsRemaining: 1,
          whatsappNumbersRemaining: 0,
          scenariosRemaining: 4,
          classificationsRemaining: 492,
          studioChatsRemaining: 498,
          bulkRecipientLimit: 500,
          bulkRecipientCount: 120,
          bulkRecipientsRemaining: 380,
          bulkRecipientExhausted: false,
        }),
      })
    );
  });

  it("shows the WhatsApp number and workspace limits set on the company", async () => {
    const companiesQuery = createCompaniesQuery(
      [
        {
          id: "company-boutique",
          name: "Boutique",
          slug: "boutique",
          subscription_type: "pro",
          trial_starts_at: null,
          trial_ends_at: null,
          seat_limit: 1,
          workspace_limit: 1,
          whatsapp_number_limit: 3,
          created_at: "2026-06-24T13:08:25.583381+00:00",
        },
      ],
      1
    );
    const supabase = {
      from: jest.fn((table: string) => {
        if (table === "companies") return companiesQuery;
        if (table === "workspaces") {
          return createListQuery([
            { id: "workspace-a", name: "A", company_id: "company-boutique" },
            { id: "workspace-b", name: "B", company_id: "company-boutique" },
          ]);
        }
        if (table === "company_usage_snapshots") return createListQuery([]);
        throw new Error(`Unexpected table: ${table}`);
      }),
      rpc: jest.fn(async () => ({
        data: [{ company_id: "company-boutique", used_recipients: 0 }],
        error: null,
      })),
    };

    const result = await getCompanyLimitSummaries(supabase as never);

    const selectedColumns = String(companiesQuery.select.mock.calls[0][0]);
    expect(selectedColumns).toContain("whatsapp_number_limit");
    expect(selectedColumns).toContain("workspace_limit");
    expect(result.companies[0].limit).toEqual(
      expect.objectContaining({
        whatsappNumberLimit: 3,
        workspaceLimit: 3,
        workspaceCount: 2,
        workspacesRemaining: 1,
      })
    );
  });
});

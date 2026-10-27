const mockFrom = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import { createEmailUnsubscribeToken } from "@/lib/email/email-unsubscribes";
import { POST } from "./route";

describe("/api/email/unsubscribe", () => {
  const originalSecret = process.env.EMAIL_UNSUBSCRIBE_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    } else {
      process.env.EMAIL_UNSUBSCRIBE_SECRET = originalSecret;
    }
  });

  it("persists a signed unsubscribe token without requiring auth", async () => {
    const unsubscribeUpserts: Record<string, unknown>[] = [];
    const campaignMessageUpdates: Record<string, unknown>[] = [];
    const campaignMessageFilters: Array<[string, unknown]> = [];

    mockFrom.mockImplementation((table: string) => {
      if (table === "email_unsubscribes") {
        return {
          upsert: jest.fn(
            async (
              payload: Record<string, unknown>,
              _options?: Record<string, unknown>
            ) => {
              unsubscribeUpserts.push(payload);
              return { error: null };
            }
          ),
        };
      }

      if (table === "campaign_messages") {
        const query = {
          update: jest.fn(),
          eq: jest.fn(),
        };
        query.update.mockImplementation((patch: Record<string, unknown>) => {
          campaignMessageUpdates.push(patch);
          return query;
        });
        query.eq.mockImplementation((column: string, value: unknown) => {
          campaignMessageFilters.push([column, value]);
          return query;
        });
        return query;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const token = createEmailUnsubscribeToken({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      campaignId: "campaign-1",
      email: "Alice@Example.com",
    });
    const response = await POST(
      new Request(
        `http://localhost/api/email/unsubscribe?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
        }
      ) as never
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Unsubscribed");
    expect(unsubscribeUpserts).toEqual([
      expect.objectContaining({
        workspace_id: "11111111-1111-4111-8111-111111111111",
        campaign_id: "campaign-1",
        email: "alice@example.com",
        source: "unsubscribe_link",
      }),
    ]);
    expect(campaignMessageUpdates).toEqual([
      expect.objectContaining({
        status: "unsubscribed",
        unsubscribed_at: expect.any(String),
      }),
    ]);
    expect(campaignMessageFilters).toContainEqual(["channel", "email"]);
  });
});

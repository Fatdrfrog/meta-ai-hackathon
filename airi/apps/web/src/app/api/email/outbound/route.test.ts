const mockFrom = jest.fn();
const mockGetWorkspaceEmailProviderRow = jest.fn();
const mockOutboundLoggerError = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderRow: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderRow(...args),
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    error: (...args: unknown[]) => mockOutboundLoggerError(...args),
  }),
}));

import { POST } from "./route";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

const DELIVERY_EVENT = {
  RecordType: "Delivery",
  MessageID: "postmark-message-1",
  Recipient: "alice@example.com",
  DeliveredAt: "2026-05-22T10:30:00.000Z",
};

function foundCampaignMessage() {
  return {
    data: {
      id: "campaign-message-1",
      campaign_id: "campaign-1",
      open_count: 0,
      click_count: 0,
    },
    error: null,
  };
}

function postOutbound(event: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/email/outbound?token=webhook-token", {
      method: "POST",
      body: JSON.stringify(event),
    }) as never
  );
}

/**
 * Route the outbound webhook's tables: campaign_messages answers the queued
 * lookups in order and records lookup values, channels and update patches.
 */
function routeOutboundTables(
  lookups: unknown[],
  extraTables: Record<string, () => unknown> = {}
) {
  const lookupValues: unknown[] = [];
  const lookupChannels: unknown[] = [];
  const updates: Record<string, unknown>[] = [];

  mockFrom.mockImplementation((table: string) => {
    if (table === "campaign_messages") {
      const query: {
        select: jest.Mock;
        eq: jest.Mock;
        maybeSingle: jest.Mock;
        update: jest.Mock;
      } = {
        select: jest.fn(),
        eq: jest.fn(),
        maybeSingle: jest.fn(),
        update: jest.fn(),
      };
      query.select.mockImplementation(() => query);
      query.eq.mockImplementation((column: string, value: unknown) => {
        if (column === "message_id") {
          lookupValues.push(value);
          return query;
        }
        if (column === "channel") {
          lookupChannels.push(value);
          return query;
        }
        return Promise.resolve({ error: null });
      });
      query.maybeSingle.mockImplementation(async () => lookups.shift());
      query.update.mockImplementation((patch: Record<string, unknown>) => {
        updates.push(patch);
        return query;
      });
      return query;
    }

    if (table === "campaign_history") {
      return createSupabaseQueryMock(
        { data: { workspace_id: "workspace-1" }, error: null },
        { thenable: false }
      );
    }

    if (table === "campaign_message_events") {
      return {
        insert: jest.fn(async () => ({ error: null })),
      };
    }

    const extraTable = extraTables[table];
    if (extraTable) return extraTable();

    throw new Error(`Unexpected table ${table}`);
  });

  return { lookupValues, lookupChannels, updates };
}

describe("/api/email/outbound", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWorkspaceEmailProviderRow.mockResolvedValue({
      webhook_token: "webhook-token",
    });
  });

  it("returns 500 when the campaign message lookup fails", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "campaign_messages") {
        return createSupabaseQueryMock(
          { data: null, error: { message: "database unavailable" } },
          { thenable: false }
        );
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await postOutbound(DELIVERY_EVENT);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Failed to look up campaign message",
    });
    expect(mockOutboundLoggerError).toHaveBeenCalledWith(
      "Failed to look up campaign message for outbound webhook",
      expect.any(Error),
      expect.objectContaining({
        messageId: "postmark-message-1",
      })
    );
  });

  it("matches Bulk API webhook events by metadata correlation id and stores the real Postmark message id", async () => {
    const { lookupValues, lookupChannels, updates } = routeOutboundTables([
      { data: null, error: null },
      foundCampaignMessage(),
    ]);

    const response = await postOutbound({
      ...DELIVERY_EVENT,
      Metadata: {
        airi_campaign_message_id: "bulk:correlation-1",
      },
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      campaignId: "campaign-1",
      duplicate: false,
    });
    expect(lookupValues).toEqual(["postmark-message-1", "bulk:correlation-1"]);
    expect(lookupChannels).toEqual(["email", "email"]);
    expect(updates).toContainEqual(
      expect.objectContaining({
        message_id: "postmark-message-1",
        status: "delivered",
        delivered_at: "2026-05-22T10:30:00.000Z",
      })
    );
  });

  it("matches Bulk API webhook events by the current short metadata key", async () => {
    const { lookupValues } = routeOutboundTables([
      { data: null, error: null },
      foundCampaignMessage(),
    ]);

    const response = await postOutbound({
      ...DELIVERY_EVENT,
      Metadata: {
        airi_msg_id: "bulk:correlation-1",
      },
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      campaignId: "campaign-1",
      duplicate: false,
    });
    expect(lookupValues).toEqual(["postmark-message-1", "bulk:correlation-1"]);
  });

  it("stores subscription change events as workspace email unsubscribes", async () => {
    const unsubscribeUpserts: Record<string, unknown>[] = [];
    const { updates } = routeOutboundTables([foundCampaignMessage()], {
      email_unsubscribes: () => ({
        upsert: jest.fn(
          async (
            payload: Record<string, unknown>,
            _options?: Record<string, unknown>
          ) => {
            unsubscribeUpserts.push(payload);
            return { error: null };
          }
        ),
      }),
    });

    const response = await postOutbound({
      RecordType: "SubscriptionChange",
      MessageID: "postmark-message-1",
      Recipient: "Alice@Example.com",
      ReceivedAt: "2026-05-22T10:30:00.000Z",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      campaignId: "campaign-1",
      duplicate: false,
    });
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: "unsubscribed",
        unsubscribed_at: "2026-05-22T10:30:00.000Z",
      })
    );
    expect(unsubscribeUpserts).toEqual([
      expect.objectContaining({
        workspace_id: "workspace-1",
        email: "alice@example.com",
        campaign_id: "campaign-1",
        source: "postmark_subscription_change",
      }),
    ]);
  });
});

const mockCaptureFunnelEvent = jest.fn();

jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));

import {
  captureBulkSendFunnelOutcome,
  classifyBulkSendFunnelOutcome,
  type BulkSendAnalyticsContext,
} from "./bulk-send-funnel";

const context: BulkSendAnalyticsContext = {
  userId: "user-1",
  workspaceId: "workspace-1",
  channel: "whatsapp",
  source: "page",
  requestedRecipients: 3,
  scheduled: false,
};

describe("bulk send funnel outcome", () => {
  beforeEach(() => {
    mockCaptureFunnelEvent.mockReset();
  });

  it("reads a queued campaign from the success aliases", () => {
    expect(
      classifyBulkSendFunnelOutcome(200, {
        ok: true,
        queued: true,
        scheduled: false,
        noOp: false,
        successful: 2,
        requestedTotal: 3,
        campaignId: "campaign-1",
      })
    ).toEqual({
      event: "campaign_queued",
      scheduled: false,
      accepted: 2,
      requested: 3,
      campaignId: "campaign-1",
    });
  });

  it("treats a send that reached nobody as blocked", () => {
    expect(
      classifyBulkSendFunnelOutcome(200, {
        ok: true,
        noOp: true,
        queued: false,
      })
    ).toEqual({ event: "campaign_send_blocked", code: "no_op", status: 200 });
  });

  it("keeps the refusal code, or the status when there is none", () => {
    expect(
      classifyBulkSendFunnelOutcome(409, { code: "campaign_contact_cooldown" })
    ).toEqual({
      event: "campaign_send_blocked",
      code: "campaign_contact_cooldown",
      status: 409,
    });
    expect(classifyBulkSendFunnelOutcome(500, null)).toEqual({
      event: "campaign_send_blocked",
      code: "http_500",
      status: 500,
    });
  });

  it("ignores an unrecognised success body", () => {
    expect(classifyBulkSendFunnelOutcome(200, { ok: true })).toBeNull();
  });

  it("captures a queued campaign once per campaign id", async () => {
    await captureBulkSendFunnelOutcome(
      context,
      Response.json({
        ok: true,
        queued: true,
        scheduled: true,
        successful: 2,
        campaignId: "campaign-1",
      })
    );
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith({
      event: "campaign_queued",
      userId: "user-1",
      workspaceId: "workspace-1",
      properties: {
        channel: "whatsapp",
        source: "page",
        requested_recipients: 3,
        scheduled: true,
        accepted_recipients: 2,
      },
      insertId: "campaign_queued:campaign-1",
    });
  });

  it("captures a refusal with its code", async () => {
    await captureBulkSendFunnelOutcome(
      context,
      Response.json({ code: "whatsapp_sending_blocked" }, { status: 409 })
    );
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "campaign_send_blocked",
        properties: expect.objectContaining({
          code: "whatsapp_sending_blocked",
          status: 409,
        }),
      })
    );
  });

  it("skips refusals before workspace access was verified", async () => {
    await captureBulkSendFunnelOutcome(
      {},
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    expect(mockCaptureFunnelEvent).not.toHaveBeenCalled();
  });
});

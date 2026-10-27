const mockPostCampaignBulkSend = jest.fn(async (request: Request) => {
  const body = await request.json();
  return new Response(JSON.stringify({ body }), {
    headers: { "content-type": "application/json" },
  });
});

jest.mock("@/app/api/campaigns/bulk-send/route", () => ({
  POST: (request: Request) => mockPostCampaignBulkSend(request),
}));

import { POST } from "./route";

describe("POST /api/whatsapp/bulk-send", () => {
  beforeEach(() => {
    mockPostCampaignBulkSend.mockClear();
  });

  it("adapts legacy WhatsApp payloads to the canonical campaign bulk sender", async () => {
    const response = await POST(
      new Request("http://localhost/api/whatsapp/bulk-send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          recipients: [{ phone: "+15550000001" }],
          templateName: "launch",
          per_message_bid_multiplier: 1.2,
        }),
      })
    );
    const payload = await response.json();

    expect(mockPostCampaignBulkSend).toHaveBeenCalledTimes(1);
    expect(payload.body).toEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        recipients: [{ phone: "+15550000001" }],
        templateName: "launch",
        marketingMessagePricing: { perMessageBidMultiplier: 1.2 },
      })
    );
  });

  it("rejects invalid JSON without calling the canonical sender", async () => {
    const response = await POST(
      new Request("http://localhost/api/whatsapp/bulk-send", {
        method: "POST",
        body: "{",
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Invalid JSON body");
    expect(mockPostCampaignBulkSend).not.toHaveBeenCalled();
  });
});

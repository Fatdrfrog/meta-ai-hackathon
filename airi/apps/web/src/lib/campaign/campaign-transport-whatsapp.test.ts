/** @jest-environment node */

const mockPostJson = jest.fn();
const mockReserveContact = jest.fn();
const mockReleaseContact = jest.fn();

jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({ postJson: mockPostJson }),
}));
jest.mock("./customer-contact-policy", () => ({
  reserveCustomerMarketingContact: (...args: unknown[]) =>
    mockReserveContact(...args),
  releaseCustomerMarketingContact: (...args: unknown[]) =>
    mockReleaseContact(...args),
}));
jest.mock("@/lib/email/email-source", () => ({}));
jest.mock("@/lib/email/provider-config", () => ({}));
jest.mock("@/lib/postmark", () => ({}));

import { sendCampaignTransportSingle } from "./campaign-transport";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";

const request = {
  channel: "whatsapp" as const,
  recipient: { phone: "77001234567" },
  phoneNumberId: "phone-id",
  accessToken: "test-token",
  templateName: "promo",
  templateCategory: "MARKETING" as const,
  contactPolicy: {
    workspaceId: "workspace",
    deliveryKey: "campaign:recipient",
  },
};

describe("campaign transport through the real WhatsApp sender", () => {
  beforeEach(() => {
    mockPostJson.mockReset().mockResolvedValue({
      messages: [{ id: "wamid.test", timestamp: "1711100000" }],
    });
    mockReserveContact.mockReset().mockResolvedValue(null);
    mockReleaseContact.mockReset().mockResolvedValue(1);
  });

  it("uses the same canonical phone for the contact reservation and provider request", async () => {
    const result = await sendCampaignTransportSingle({
      ...request,
      recipient: { phone: "'+77001234567" },
    });
    expect(result).toMatchObject({
      success: true,
      messageId: "wamid.test",
      recipient: "'+77001234567",
    });
    expect(mockReserveContact).toHaveBeenCalledWith({
      ...request.contactPolicy,
      phone: "77001234567",
    });
    expect(mockPostJson).toHaveBeenCalledWith("phone-id/messages", {
      token: "test-token",
      body: expect.objectContaining({ to: "77001234567" }),
    });
    expect(mockReserveContact.mock.invocationCallOrder[0]).toBeLessThan(
      mockPostJson.mock.invocationCallOrder[0]
    );
  });

  it.each(["=77001234567", "customer77001234567", "KZ.12345678901234", ""])(
    "rejects an invalid phone field %s without consuming contact capacity",
    async phone => {
      const result = await sendCampaignTransportSingle({
        ...request,
        recipient: { phone },
      });
      expect(result).toMatchObject({
        success: false,
        providerCode: "invalid_whatsapp_recipient",
        failureScope: "recipient",
      });
      expect(mockReserveContact).not.toHaveBeenCalled();
      expect(mockPostJson).not.toHaveBeenCalled();
    }
  );

  it("does not reserve contacts when template preparation rejects pricing", async () => {
    const result = await sendCampaignTransportSingle({
      ...request,
      marketingMessagesEnabled: true,
      marketingMessagePricing: { perMessageBidMultiplier: Number.NaN },
    });
    expect(result.success).toBe(false);
    expect(mockReserveContact).not.toHaveBeenCalled();
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("rejects an invalid explicitly typed phone before contact reservation", async () => {
    const result = await sendCampaignTransportSingle({
      ...request,
      recipient: { target: { kind: "phone", value: "customer77001234567" } },
    });
    expect(result).toMatchObject({
      success: false,
      providerCode: "invalid_whatsapp_recipient",
    });
    expect(mockReserveContact).not.toHaveBeenCalled();
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it.each(["template", "service_text"] as const)(
    "stops before provider I/O when the final %s reservation is refused",
    async whatsappMessageType => {
      mockReserveContact.mockResolvedValueOnce("contact_frequency_limit");
      const result = await sendCampaignTransportSingle({
        ...request,
        whatsappMessageType,
        messageText: "Hello",
      });
      expect(result).toMatchObject({
        success: false,
        providerCode: "contact_frequency_limit",
        failureScope: "recipient",
      });
      expect(mockReserveContact).toHaveBeenCalledTimes(1);
      expect(mockPostJson).not.toHaveBeenCalled();
    }
  );

  it.each(["network", "missing_id"])(
    "retains the reservation and performs no second send after a %s uncertain response",
    async failure => {
      if (failure === "network")
        mockPostJson.mockRejectedValueOnce(
          new Error("connection lost after request")
        );
      else mockPostJson.mockResolvedValueOnce({ messages: [] });
      const result = await sendCampaignTransportSingle(request);
      expect(result).toMatchObject({
        success: false,
        failureScope: "unknown",
        providerRequestAttempted: true,
        providerAcceptanceUnknown: true,
      });
      expect(mockReserveContact).toHaveBeenCalledTimes(1);
      expect(mockPostJson).toHaveBeenCalledTimes(1);
    }
  );

  it("preserves a service-text provider block through the real sender", async () => {
    mockPostJson.mockRejectedValueOnce(
      new MetaGraphRequestError({
        message: "Business eligibility payment issue",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/v25.0/phone-id/messages",
        details: null,
        metaError: {
          message: "Business eligibility payment issue",
          code: 131042,
          type: "OAuthException",
        },
      })
    );
    const result = await sendCampaignTransportSingle({
      ...request,
      whatsappMessageType: "service_text",
      messageText: "Hello",
    });
    expect(result).toMatchObject({
      success: false,
      providerCode: "131042",
      failureScope: "provider",
      providerRequestAttempted: true,
    });
    expect(result.providerAcceptanceUnknown).toBeUndefined();
    expect(mockReserveContact).toHaveBeenCalledTimes(1);
    expect(mockPostJson).toHaveBeenCalledTimes(1);
  });

  it("durably records send intent after reservation and before the provider request", async () => {
    const beforeProviderSend = jest.fn().mockResolvedValue(undefined);
    const result = await sendCampaignTransportSingle({
      ...request,
      beforeProviderSend,
    });
    expect(result).toMatchObject({
      success: true,
      providerRequestAttempted: true,
    });
    expect(beforeProviderSend).toHaveBeenCalledTimes(1);
    expect(mockReserveContact.mock.invocationCallOrder[0]).toBeLessThan(
      beforeProviderSend.mock.invocationCallOrder[0]
    );
    expect(beforeProviderSend.mock.invocationCallOrder[0]).toBeLessThan(
      mockPostJson.mock.invocationCallOrder[0]
    );
  });

  it("does not call the provider when durable send intent cannot be confirmed", async () => {
    const beforeProviderSend = jest
      .fn()
      .mockRejectedValue(new Error("intent write unconfirmed"));
    const result = await sendCampaignTransportSingle({
      ...request,
      beforeProviderSend,
    });
    expect(result).toMatchObject({
      success: false,
      error: "Error: intent write unconfirmed",
    });
    expect(result.providerRequestAttempted).toBeUndefined();
    expect(result.providerAcceptanceUnknown).toBeUndefined();
    expect(mockPostJson).not.toHaveBeenCalled();
    // Another worker may own this send, so its slot stays reserved.
    expect(mockReleaseContact).not.toHaveBeenCalled();
  });

  const throughputRejection = () =>
    new MetaGraphRequestError({
      message: "(#130429) Rate limit hit",
      status: 400,
      statusText: "Bad Request",
      url: "https://graph.facebook.com/v25.0/phone-id/messages",
      details: null,
      metaError: {
        message: "(#130429) Rate limit hit",
        code: 130429,
        type: "OAuthException",
      },
    });

  it("releases the contact slot when Meta rejects the request", async () => {
    mockPostJson.mockRejectedValueOnce(throughputRejection());
    const result = await sendCampaignTransportSingle({
      ...request,
      recipient: { phone: "+7 700 123 45 67" },
    });
    expect(result).toMatchObject({
      success: false,
      providerCode: "130429",
      providerRequestAttempted: true,
    });
    expect(result.providerAcceptanceUnknown).toBeUndefined();
    expect(mockReleaseContact).toHaveBeenCalledTimes(1);
    expect(mockReleaseContact).toHaveBeenCalledWith({
      ...request.contactPolicy,
      phone: "77001234567",
    });
    expect(mockPostJson.mock.invocationCallOrder[0]).toBeLessThan(
      mockReleaseContact.mock.invocationCallOrder[0]
    );
  });

  it("keeps the contact slot when Meta may have accepted the message", async () => {
    mockPostJson.mockRejectedValueOnce(new Error("socket hang up"));
    const result = await sendCampaignTransportSingle(request);
    expect(result).toMatchObject({
      success: false,
      providerRequestAttempted: true,
      providerAcceptanceUnknown: true,
    });
    expect(mockReleaseContact).not.toHaveBeenCalled();
  });

  it("does not release a slot the contact policy refused", async () => {
    mockReserveContact.mockResolvedValueOnce("contact_frequency_limit");
    const result = await sendCampaignTransportSingle(request);
    expect(result).toMatchObject({
      success: false,
      providerCode: "contact_frequency_limit",
    });
    expect(mockPostJson).not.toHaveBeenCalled();
    expect(mockReleaseContact).not.toHaveBeenCalled();
  });

  it("still reports Meta's rejection when the slot release fails", async () => {
    mockPostJson.mockRejectedValueOnce(throughputRejection());
    mockReleaseContact.mockRejectedValueOnce(new Error("mongo unavailable"));
    const result = await sendCampaignTransportSingle(request);
    expect(result).toMatchObject({
      success: false,
      providerCode: "130429",
      failureScope: "provider",
      providerRequestAttempted: true,
    });
    expect(result.providerAcceptanceUnknown).toBeUndefined();
  });
});

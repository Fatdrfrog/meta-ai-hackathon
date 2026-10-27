jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));

import { WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT } from "@/lib/provider-message-display";
import {
  buildWhatsAppCommerceRagContext,
  buildWhatsAppIdentityLookupFilter,
  classifyWhatsAppIdentityMatchDocuments,
  getWhatsAppInboundMessageText,
  getWhatsAppProviderMediaErrorText,
  isNonDisplayableWhatsAppUnsupportedMessage,
} from "@icecore/airi-runtime/whatsapp-message-processor";
import { getWhatsAppMessageMutationKind } from "@icecore/shared/lib/whatsapp/message-mutations";
import type { WhatsAppMessage } from "@icecore/shared/lib/whatsapp/webhook-payload";

describe("WhatsApp identity lookup", () => {
  it("preserves an unavailable history message as a visible placeholder", () => {
    const message = {
      id: "wamid.history",
      type: "errors",
      errors: [{ code: 131051 }],
    } as WhatsAppMessage;
    expect(getWhatsAppInboundMessageText(message)).toBe(
      WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT
    );
    expect(isNonDisplayableWhatsAppUnsupportedMessage(message)).toBe(false);
  });

  it("combines all exact identity keys into one workspace-scoped query", () => {
    const filter = buildWhatsAppIdentityLookupFilter({
      workspaceId: "workspace-1",
      contactData: {
        waId: "77010000201",
        userId: "bsuid-1",
        parentUserId: "parent-bsuid-1",
        profile: { name: "Customer" },
        primaryIdType: "wa_id",
      },
    });

    expect(filter).toEqual({
      workspaceId: "workspace-1",
      $or: [
        { _id: "wa_77010000201" },
        { "whatsapp.waId": "77010000201" },
        { "whatsapp.previousWaIds": "77010000201" },
        { _id: "wa_87010000201" },
        { "whatsapp.waId": "87010000201" },
        { "whatsapp.previousWaIds": "87010000201" },
        { "whatsapp.userId": "bsuid-1" },
        { "whatsapp.previousUserIds": "bsuid-1" },
        { "whatsapp.parentUserId": "parent-bsuid-1" },
      ],
    });
  });

  it("omits lookup clauses for identifiers that are not present", () => {
    const filter = buildWhatsAppIdentityLookupFilter({
      workspaceId: "workspace-1",
      contactData: {
        userId: "bsuid-1",
        profile: { name: "Customer" },
        primaryIdType: "user_id",
      },
    });

    expect(filter).toEqual({
      workspaceId: "workspace-1",
      $or: [
        { "whatsapp.userId": "bsuid-1" },
        { "whatsapp.previousUserIds": "bsuid-1" },
      ],
    });
  });

  it("preserves phone, BSUID, and parent match precedence data", () => {
    const matches = classifyWhatsAppIdentityMatchDocuments({
      contactData: {
        waId: "77010000201",
        userId: "bsuid-1",
        parentUserId: "parent-bsuid-1",
        profile: { name: "Customer" },
        primaryIdType: "wa_id",
      },
      documents: [
        {
          _id: "wa_77010000201",
          whatsapp: { userId: "old-bsuid" },
        },
        {
          _id: "legacy-user",
          whatsapp: { previousUserIds: ["bsuid-1"] },
        },
        {
          _id: "parent-user",
          whatsapp: { parentUserId: "parent-bsuid-1" },
        },
      ],
    });

    expect(matches).toEqual({
      phoneIds: ["wa_77010000201"],
      userIds: ["legacy-user"],
      parentUserIds: ["parent-user"],
    });
  });
});

describe("getWhatsAppInboundMessageText", () => {
  it("returns template button reply text for WhatsApp button messages", () => {
    const message = {
      id: "wamid.1",
      from: "77010000201",
      timestamp: "1711532464",
      type: "button",
      button: {
        text: "Макет",
        payload: "maket_payload",
      },
    } satisfies WhatsAppMessage;

    expect(getWhatsAppInboundMessageText(message)).toBe("Макет");
  });

  it("falls back to button payload when button text is absent", () => {
    const message = {
      id: "wamid.2",
      from: "77010000201",
      timestamp: "1711532464",
      type: "button",
      button: {
        payload: "maket_payload",
      },
    } satisfies WhatsAppMessage;

    expect(getWhatsAppInboundMessageText(message)).toBe("maket_payload");
  });

  it("returns interactive button reply titles without decoration", () => {
    const message = {
      id: "wamid.3",
      from: "77010000201",
      timestamp: "1711532464",
      type: "interactive",
      interactive: {
        type: "button_reply",
        button_reply: {
          id: "maket_payload",
          title: "Макет",
        },
      },
    } satisfies WhatsAppMessage;

    expect(getWhatsAppInboundMessageText(message)).toBe("Макет");
  });

  it("summarizes product inquiries from referred product context", () => {
    const message = {
      id: "wamid.product-inquiry",
      from: "77010000201",
      timestamp: "1777817357",
      type: "text",
      text: {
        body: "Is this available?",
      },
      context: {
        id: "wamid.outbound-product",
        referred_product: {
          catalog_id: "catalog-1",
          product_retailer_id: "sku-1",
        },
      },
    } satisfies WhatsAppMessage;

    expect(getWhatsAppInboundMessageText(message)).toBe(
      "[Product inquiry: sku-1] Is this available?"
    );
  });

  it("summarizes inbound WhatsApp catalog orders", () => {
    const message = {
      id: "wamid.order",
      from: "77010000201",
      timestamp: "1777817357",
      type: "order",
      order: {
        catalog_id: "catalog-1",
        text: "Please deliver today",
        product_items: [
          {
            product_retailer_id: "sku-1",
            quantity: 2,
            item_price: 10,
            currency: "USD",
          },
          {
            product_retailer_id: "sku-2",
            quantity: 1,
            item_price: 5.5,
            currency: "USD",
          },
        ],
      },
    } satisfies WhatsAppMessage;

    expect(getWhatsAppInboundMessageText(message)).toBe(
      "[WhatsApp order: 3 items, 25.50 USD] Please deliver today"
    );
  });

  it("returns a visible placeholder for unavailable WhatsApp Business app messages", () => {
    const message = {
      id: "wamid.4",
      from: "77010000201",
      timestamp: "1777817357",
      type: "unsupported",
      errors: [
        {
          code: 131060,
          title: "This message is unavailable.",
          message: "This message is unavailable.",
          error_data: {
            details: "This message is currently unavailable.",
          },
        },
      ],
      unsupported: {
        type: "unknown",
      },
    } satisfies WhatsAppMessage;

    expect(getWhatsAppInboundMessageText(message)).toBe(
      "[WhatsApp message unavailable: open WhatsApp Business app to view]"
    );
  });

  it("returns a visible placeholder for unsupported WhatsApp message types", () => {
    const message = {
      id: "wamid.5",
      from: "77010000201",
      timestamp: "1777817357",
      type: "unsupported",
      errors: [
        {
          code: 131051,
          title: "Message type unknown",
          message: "Message type unknown",
          error_data: {
            details: "Message type is currently not supported.",
          },
        },
      ],
      unsupported: {
        type: "poll_creation",
      },
    } satisfies WhatsAppMessage;

    expect(getWhatsAppInboundMessageText(message)).toBe(
      "[Unsupported WhatsApp message: poll_creation]"
    );
  });

  it("renders API-unavailable placeholders for provider unsupported unknown type events", () => {
    const message = {
      id: "wamid.empty-unknown",
      from: "77010000201",
      timestamp: "1777817357",
      type: "unsupported",
      errors: [
        {
          code: 131051,
          title: "Message type unknown",
          message: "Message type unknown",
          error_data: {
            details: "Message type is currently not supported.",
          },
        },
      ],
      unsupported: {
        type: "unknown",
      },
    } satisfies WhatsAppMessage;

    expect(isNonDisplayableWhatsAppUnsupportedMessage(message)).toBe(false);
    expect(getWhatsAppInboundMessageText(message)).toBe(
      WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT
    );
  });

  it("classifies co-existence unsupported edit events as message mutations, not visible inbound text", () => {
    const message = {
      id: "wamid.edit-event",
      from: "77010000201",
      timestamp: "1777817357",
      type: "unsupported",
      errors: [
        {
          code: 131051,
          title: "Message type unknown",
          message: "Message type unknown",
          error_data: {
            details: "Message type is currently not supported.",
          },
        },
      ],
      unsupported: {
        type: "edit",
      },
      context: {
        id: "wamid.original",
      },
    } satisfies WhatsAppMessage;

    expect(getWhatsAppMessageMutationKind(message)).toBe("edit");
    expect(getWhatsAppInboundMessageText(message)).toBe("");
  });
});

describe("buildWhatsAppCommerceRagContext", () => {
  it("grounds product inquiries and orders with catalog and SKU details", () => {
    const productInquiry = {
      id: "wamid.product-inquiry",
      from: "77010000201",
      timestamp: "1777817357",
      type: "text",
      text: { body: "Is this available?" },
      context: {
        id: "wamid.outbound-product",
        referred_product: {
          catalog_id: "catalog-1",
          product_retailer_id: "sku-1",
        },
      },
    } satisfies WhatsAppMessage;

    expect(buildWhatsAppCommerceRagContext(productInquiry)).toBe(
      "WhatsApp commerce context: product inquiry; catalog_id=catalog-1; product_retailer_id=sku-1; context_message_id=wamid.outbound-product"
    );

    const order = {
      id: "wamid.order",
      from: "77010000201",
      timestamp: "1777817357",
      type: "order",
      order: {
        catalog_id: "catalog-2",
        text: "Please deliver today",
        product_items: [
          {
            product_retailer_id: "sku-2",
            quantity: 2,
            item_price: 10,
            currency: "USD",
          },
        ],
      },
    } satisfies WhatsAppMessage;

    expect(buildWhatsAppCommerceRagContext(order)).toBe(
      "WhatsApp commerce context: order; catalog_id=catalog-2; total_quantity=2; total_amount=20.00 USD; note=Please deliver today; items=sku-2 x2 @ 10.00 USD"
    );
  });
});

describe("getWhatsAppProviderMediaErrorText", () => {
  it("returns a visible placeholder for WhatsApp oversized media errors", () => {
    const placeholder = getWhatsAppProviderMediaErrorText([
      {
        code: 131052,
        title: "Media download error",
        message: "Media file size too big",
        error_data: {
          details:
            "Media file size too big. Max file size we support is 100MB.",
        },
      },
    ]);

    expect(placeholder).toContain("Media unavailable");
    expect(placeholder).toContain("Max file size");
  });

  it("ignores unrelated provider errors", () => {
    expect(
      getWhatsAppProviderMediaErrorText([
        {
          code: 131000,
          title: "Generic error",
          message: "Something else",
        },
      ])
    ).toBeNull();
  });
});

import {
  buildCoachConversationWindow,
  buildCoachProfileContextBlock,
  COACH_MESSAGE_SELECT,
  getCoachMessageContent,
} from "./conversation-window";

describe("coach conversation window", () => {
  it("keeps the message select list aligned with media-aware formatting", () => {
    expect(COACH_MESSAGE_SELECT.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "text",
        "direction",
        "date",
        "imageUrl",
        "imageAnalysis",
        "audioAnalysis",
        "videoAnalysis",
        "mediaType",
        "mimeType",
        "fileName",
        "attachments",
        "whatsappLocation",
        "whatsappContacts",
        "whatsappProductInquiry",
        "whatsappOrder",
        "whatsappReferral",
        "whatsappFlow",
        "whatsappFlowReply",
        "whatsappServiceMessage",
        "whatsappTemplate",
        "delivery",
      ])
    );
  });

  it("includes stored image analysis in coach message content", () => {
    expect(
      getCoachMessageContent({
        text: "Can you help?",
        imageUrl: "https://example.com/photo.jpg",
        imageAnalysis:
          "The customer sent a photo of a damaged package with a torn corner.",
      })
    ).toContain(
      "[Image content: The customer sent a photo of a damaged package with a torn corner.]"
    );
  });

  it("marks image attachments as pending when analysis has not completed", () => {
    expect(
      getCoachMessageContent({
        text: "",
        attachments: [
          {
            url: "https://example.com/order-proof.webp",
            contentType: "image/webp",
            filename: "order-proof.webp",
          },
        ],
      })
    ).toBe("[Image attached: order-proof.webp; analysis pending]");
  });

  it("builds a chronological conversation window with media context", () => {
    const window = buildCoachConversationWindow([
      {
        text: "Here is the issue",
        direction: "inbound",
        date: "2026-07-08T10:00:00.000Z",
        imageAnalysis: "Screenshot shows a payment error.",
      },
      {
        text: "I will check this.",
        direction: "outbound",
        date: "2026-07-08T10:01:00.000Z",
      },
    ]);

    expect(window).toContain(
      "2026-07-08T10:00:00.000Z [CUSTOMER] Here is the issue [Image content: Screenshot shows a payment error.]"
    );
    expect(window).toContain(
      "2026-07-08T10:01:00.000Z [AGENT] I will check this."
    );
  });

  it("includes compact structured WhatsApp message context", () => {
    const content = getCoachMessageContent({
      text: "Please check this",
      whatsappLocation: {
        name: "Warehouse",
        address: "Main street 12",
        latitude: 43.2,
        longitude: 76.9,
      },
      whatsappContacts: [
        {
          name: { formatted_name: "Sabyrzhan Torg" },
          phones: [{ phone: "+77051309419" }],
        },
      ],
      whatsappProductInquiry: {
        productRetailerId: "SKU-2",
        catalogId: "catalog-1",
      },
      whatsappOrder: {
        totalQuantity: 2,
        totalAmount: 15000,
        currency: "KZT",
        text: "Deliver today",
        productItems: [{ productRetailerId: "SKU-1" }],
      },
      whatsappFlowReply: {
        body: "Submitted checkout form",
        responseJson: JSON.stringify({ selected_plan: "Premium" }),
      },
      whatsappReferral: {
        sourceType: "ad",
        campaignName: "Summer campaign",
        headline: "Premium plan",
      },
      whatsappTemplate: {
        name: "delivery_update",
        category: "UTILITY",
        language: "ru",
      },
      delivery: {
        status: "failed",
        errorMessage: "Template parameter missing",
      },
    });

    expect(content).toContain("[Location: Warehouse; Main street 12");
    expect(content).toContain("[Shared contacts: Sabyrzhan Torg; 1 phone(s)]");
    expect(content).toContain("[Product inquiry: SKU-2; catalog catalog-1]");
    expect(content).toContain(
      "[WhatsApp order: 2 item(s); total 15000 KZT; Deliver today; products SKU-1]"
    );
    expect(content).toContain(
      "[Flow reply: Submitted checkout form; selected_plan=Premium]"
    );
    expect(content).toContain("[Referral: ad; Summer campaign; Premium plan]");
    expect(content).toContain(
      "[Template: delivery_update; category UTILITY; language ru]"
    );
    expect(content).toContain("[Delivery: failed; Template parameter missing]");
  });

  it("uses canonical service-message content instead of stale legacy send fields", () => {
    const content = getCoachMessageContent({
      text: "[outbound]",
      whatsappServiceMessage: {
        version: 1,
        kind: "reply_buttons",
        command: {
          kind: "reply_buttons",
          body: "Choose a course",
          header: { kind: "text", text: "Recommended courses" },
          footerText: "Reply below",
          options: [
            { id: "starter", label: "Starter" },
            { id: "advanced", label: "Advanced" },
          ],
        },
      },
      whatsappFlow: {
        bodyText: "Stale Flow body",
        flowCta: "Stale Flow CTA",
      },
      whatsappTemplate: {
        name: "stale_template",
      },
    });

    expect(content).toContain(
      "[Service message: reply_buttons; Choose a course; Recommended courses; Reply below; Starter; Advanced]"
    );
    expect(content).not.toContain("Stale Flow");
    expect(content).not.toContain("stale_template");
  });

  it("builds bounded conversation and customer profile context", () => {
    const context = buildCoachProfileContextBlock({
      conversation: {
        channel: "whatsapp",
        status: "open",
        preferred_language: "ru",
        internal_labels: ["vip", "refund"],
        quick_note: "Customer wants a callback after 18:00.",
        classification: {
          category: "Billing",
          priority: "high",
          sentiment: "negative",
          summary: "Customer is unhappy about a failed payment.",
          action: "Confirm payment status and offer next step.",
          tags: ["payment", "urgent"],
        },
      },
      customer: {
        displayName: "Aida",
        status: "active",
        currentFunnelStage: "Qualified",
        profileSummary: {
          channels: ["whatsapp", "instagram"],
          languages: ["ru", "kk"],
          tags: ["repeat buyer"],
          lastSentiment: "frustrated",
          churnRiskLevel: "medium",
          conversationCount: 4,
        },
        behavioralProfile: {
          summary: "Prefers short concrete answers.",
          communicationStyle: "direct",
          recommendedApproach: ["give exact timing"],
          objections: ["delivery delays"],
          motivations: ["speed"],
        },
      },
    });

    expect(context).toContain("Conversation/customer context:");
    expect(context).toContain(
      "- Conversation: channel whatsapp; status open; language ru"
    );
    expect(context).toContain(
      "- Classification: category Billing; priority high; sentiment negative; tags payment, urgent"
    );
    expect(context).toContain("- Internal labels: vip, refund");
    expect(context).toContain(
      "- Manager note: Customer wants a callback after 18:00."
    );
    expect(context).toContain(
      "- Customer: Aida; status active; stage Qualified; 4 conversation(s); channels whatsapp, instagram; languages ru, kk"
    );
    expect(context).toContain(
      "- Customer behavior: Prefers short concrete answers.; communication direct; approach give exact timing; objections delivery delays; motivations speed"
    );
  });
});

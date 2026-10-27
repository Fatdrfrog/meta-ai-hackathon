import {
  dispatchWhatsAppServiceMessage,
  type WhatsAppServiceMessageTransport,
} from "@/lib/airi/reply/delivery/whatsapp-service-message";
import type { WhatsAppServiceSendCommand } from "@icecore/scenario-contracts";

const providerResult = {
  messageId: "wamid.service-1",
  date: 1_721_000_000,
  status: undefined,
  messageStatus: undefined,
};

function createTransport() {
  return {
    sendWhatsappMessage: jest.fn(async () => providerResult),
    sendWhatsappMedia: jest.fn(async () => providerResult),
    sendWhatsappInteractiveReplyButtonsMessage: jest.fn(
      async () => providerResult
    ),
    sendWhatsappInteractiveListMessage: jest.fn(async () => providerResult),
    sendWhatsappInteractiveCtaUrlMessage: jest.fn(async () => providerResult),
    sendWhatsappInteractiveMediaCarousel: jest.fn(async () => providerResult),
    sendWhatsappInteractiveFlow: jest.fn(async () => providerResult),
    sendWhatsappContacts: jest.fn(async () => providerResult),
    sendWhatsappLocation: jest.fn(async () => providerResult),
    sendWhatsappLocationRequest: jest.fn(async () => providerResult),
    sendWhatsappRequestContactInfo: jest.fn(async () => providerResult),
    sendWhatsappVoiceCall: jest.fn(async () => providerResult),
    sendWhatsappCatalogMessage: jest.fn(async () => providerResult),
    sendWhatsappSingleProductMessage: jest.fn(async () => providerResult),
    sendWhatsappMultiProductMessage: jest.fn(async () => providerResult),
    sendWhatsappProductCarouselMessage: jest.fn(async () => providerResult),
  } satisfies WhatsAppServiceMessageTransport;
}

const commands: Array<{
  name: string;
  method: keyof WhatsAppServiceMessageTransport;
  command: WhatsAppServiceSendCommand;
}> = [
  {
    name: "text",
    method: "sendWhatsappMessage",
    command: { kind: "text", body: "Hello", previewUrl: false },
  },
  {
    name: "media",
    method: "sendWhatsappMedia",
    command: {
      kind: "media",
      attachment: {
        url: "https://cdn.example.com/file.pdf",
        mediaType: "document",
        fileName: "file.pdf",
      },
      caption: "Read this",
    },
  },
  {
    name: "voice note media",
    method: "sendWhatsappMedia",
    command: {
      kind: "media",
      attachment: {
        url: "https://cdn.example.com/note.ogg",
        mediaType: "audio",
        mimeType: "audio/ogg",
        fileName: "note.ogg",
      },
      voice: true,
    },
  },
  {
    name: "reply buttons",
    method: "sendWhatsappInteractiveReplyButtonsMessage",
    command: {
      kind: "reply_buttons",
      body: "Choose",
      header: { kind: "text", text: "Actions" },
      footerText: "Airi",
      options: [{ id: "yes", label: "Yes" }],
    },
  },
  {
    name: "list",
    method: "sendWhatsappInteractiveListMessage",
    command: {
      kind: "list",
      body: "Choose",
      headerText: "Products",
      footerText: "Airi",
      buttonLabel: "Open",
      sections: [{ rows: [{ id: "one", title: "One" }] }],
    },
  },
  {
    name: "URL CTA",
    method: "sendWhatsappInteractiveCtaUrlMessage",
    command: {
      kind: "cta_url",
      body: "Open",
      buttonLabel: "Website",
      url: "https://example.com",
    },
  },
  {
    name: "media carousel",
    method: "sendWhatsappInteractiveMediaCarousel",
    command: {
      kind: "media_carousel",
      body: "Compare",
      cards: [
        {
          id: "one",
          media: {
            url: "https://cdn.example.com/one.png",
            mediaType: "image",
          },
          interaction: {
            kind: "quick_replies",
            options: [{ id: "one", label: "Choose" }],
          },
        },
        {
          id: "two",
          media: {
            url: "https://cdn.example.com/two.png",
            mediaType: "image",
          },
          interaction: {
            kind: "quick_replies",
            options: [{ id: "two", label: "Choose" }],
          },
        },
      ],
    },
  },
  {
    name: "Flow",
    method: "sendWhatsappInteractiveFlow",
    command: {
      kind: "flow",
      body: "Start",
      flowToken: "flow-token",
      flowConfig: {
        templateId: "local-flow",
        screens: [],
        ctaText: "Open flow",
        metaFlowId: "meta-flow-1",
      },
    },
  },
  {
    name: "contacts",
    method: "sendWhatsappContacts",
    command: {
      kind: "contacts",
      contacts: [{ formattedName: "Airi", phone: "+77012345678" }],
    },
  },
  {
    name: "location",
    method: "sendWhatsappLocation",
    command: {
      kind: "location",
      location: { latitude: 43.23, longitude: 76.89 },
    },
  },
  {
    name: "location request",
    method: "sendWhatsappLocationRequest",
    command: { kind: "location_request", body: "Share your location" },
  },
  {
    name: "contact info request",
    method: "sendWhatsappRequestContactInfo",
    command: { kind: "request_contact_info", body: "Share your number" },
  },
  {
    name: "voice call",
    method: "sendWhatsappVoiceCall",
    command: {
      kind: "voice_call",
      body: "Call us",
      buttonLabel: "Call",
      ttlMinutes: 60,
      payload: "action:one",
    },
  },
  {
    name: "catalog",
    method: "sendWhatsappCatalogMessage",
    command: {
      kind: "commerce",
      commerce: {
        mode: "catalog",
        catalogId: "catalog-1",
        bodyText: "Browse",
      },
    },
  },
  {
    name: "single product",
    method: "sendWhatsappSingleProductMessage",
    command: {
      kind: "commerce",
      commerce: {
        mode: "single_product",
        catalogId: "catalog-1",
        productRetailerId: "sku-1",
      },
    },
  },
  {
    name: "multiple products",
    method: "sendWhatsappMultiProductMessage",
    command: {
      kind: "commerce",
      commerce: {
        mode: "multi_product",
        catalogId: "catalog-1",
        headerText: "Products",
        bodyText: "Choose",
        sections: [
          { id: "main", title: "Main", productRetailerIds: ["sku-1"] },
        ],
      },
    },
  },
  {
    name: "product carousel",
    method: "sendWhatsappProductCarouselMessage",
    command: {
      kind: "commerce",
      commerce: {
        mode: "product_carousel",
        catalogId: "catalog-1",
        bodyText: "Compare",
        productRetailerIds: ["sku-1", "sku-2"],
      },
    },
  },
];

describe("dispatchWhatsAppServiceMessage", () => {
  it("sends the managed provider Flow id instead of stale legacy metadata", async () => {
    const transport = createTransport();

    await dispatchWhatsAppServiceMessage(
      {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        sourceId: "source-1",
        wabaId: "waba-1",
        recipient: { kind: "phone", value: "77012345678" },
        command: {
          kind: "flow",
          body: "Start",
          flowConfig: {
            templateId: "local-flow",
            screens: [],
            ctaText: "Open flow",
            metaFlowId: "stale-meta-flow-id",
            managedProvisioning: {
              operationId: "operation-1",
              sourceId: "source-1",
              wabaId: "waba-1",
              contentRevision: 2,
              contentDigest: "digest-2",
              flowId: "managed-flow-id",
              providerStatus: "PUBLISHED",
            },
          },
        },
      },
      transport
    );

    expect(transport.sendWhatsappInteractiveFlow).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.objectContaining({ flowId: "managed-flow-id" })
    );
  });

  it("sends a Flow by name with draft mode and navigate payload", async () => {
    const transport = createTransport();

    await dispatchWhatsAppServiceMessage(
      {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        recipient: { kind: "phone", value: "77012345678" },
        command: {
          kind: "flow",
          body: "Start",
          flowToken: "flow-token",
          flowConfig: {
            templateId: "named-flow",
            screens: [{ id: "WELCOME", title: "Welcome", fields: [] }],
            ctaText: "Book",
            metaFlowName: "appointment_booking_v1",
            flowMode: "draft",
            flowActionPayload: {
              screen: "DETAILS",
              data: { product_name: "name" },
            },
          },
        },
      },
      transport
    );

    expect(transport.sendWhatsappInteractiveFlow).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        flowName: "appointment_booking_v1",
        mode: "draft",
        flowToken: "flow-token",
        flowCta: "Book",
        bodyText: "Start",
        headerText: undefined,
        footerText: undefined,
        flowActionType: "navigate",
        flowActionPayload: {
          screen: "DETAILS",
          data: { product_name: "name" },
        },
      }
    );
  });

  it("sends a published provider reference through its bound source", async () => {
    const transport = createTransport();

    await dispatchWhatsAppServiceMessage(
      {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        sourceId: "source-1",
        wabaId: "waba-1",
        recipient: { kind: "phone", value: "77012345678" },
        command: {
          kind: "flow",
          body: "Start",
          flowConfig: {
            templateId: "provider-reference",
            screens: [],
            ctaText: "Open flow",
            providerReference: {
              flowId: "provider-flow-id",
              sourceId: "source-1",
              wabaId: "waba-1",
              providerStatus: "PUBLISHED",
            },
          },
        },
      },
      transport
    );

    expect(transport.sendWhatsappInteractiveFlow).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.objectContaining({ flowId: "provider-flow-id" })
    );
  });

  it("does not dispatch a provider reference through another outbound source", async () => {
    const transport = createTransport();

    await expect(
      dispatchWhatsAppServiceMessage(
        {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          sourceId: "source-b",
          wabaId: "waba-a",
          recipient: { kind: "phone", value: "77012345678" },
          command: {
            kind: "flow",
            body: "Start",
            flowConfig: {
              templateId: "provider-reference",
              screens: [],
              ctaText: "Open flow",
              providerReference: {
                flowId: "provider-flow-id",
                sourceId: "source-a",
                wabaId: "waba-a",
                providerStatus: "PUBLISHED",
              },
            },
          },
        },
        transport
      )
    ).rejects.toThrow("does not match outbound source");

    expect(transport.sendWhatsappInteractiveFlow).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy identity for a blocked provider reference", async () => {
    const transport = createTransport();

    await expect(
      dispatchWhatsAppServiceMessage(
        {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          sourceId: "source-1",
          wabaId: "waba-1",
          recipient: { kind: "phone", value: "77012345678" },
          command: {
            kind: "flow",
            body: "Start",
            flowConfig: {
              templateId: "provider-reference",
              screens: [],
              ctaText: "Open flow",
              metaFlowId: "stale-published-flow-id",
              providerReference: {
                flowId: "provider-flow-id",
                sourceId: "source-1",
                wabaId: "waba-1",
                providerStatus: "BLOCKED",
              },
            },
          },
        },
        transport
      )
    ).rejects.toThrow("requires flow_id or flow_name");

    expect(transport.sendWhatsappInteractiveFlow).not.toHaveBeenCalled();
  });

  it("does not dispatch a managed Flow through another outbound source", async () => {
    const transport = createTransport();

    await expect(
      dispatchWhatsAppServiceMessage(
        {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          sourceId: "source-b",
          recipient: { kind: "phone", value: "77012345678" },
          command: {
            kind: "flow",
            body: "Start",
            flowConfig: {
              templateId: "local-flow",
              screens: [],
              ctaText: "Open flow",
              managedProvisioning: {
                operationId: "operation-1",
                sourceId: "source-a",
                wabaId: "waba-a",
                contentRevision: 2,
                contentDigest: "digest-2",
                flowId: "managed-flow-id",
                providerStatus: "PUBLISHED",
              },
            },
          },
        },
        transport
      )
    ).rejects.toThrow("does not match outbound source");

    expect(transport.sendWhatsappInteractiveFlow).not.toHaveBeenCalled();
  });

  it("does not dispatch a managed Flow after its source reconnects to another WABA", async () => {
    const transport = createTransport();

    await expect(
      dispatchWhatsAppServiceMessage(
        {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          sourceId: "source-1",
          wabaId: "waba-reconnected",
          recipient: { kind: "phone", value: "77012345678" },
          command: {
            kind: "flow",
            body: "Start",
            flowConfig: {
              templateId: "local-flow",
              screens: [],
              ctaText: "Open flow",
              managedProvisioning: {
                operationId: "operation-1",
                sourceId: "source-1",
                wabaId: "waba-original",
                contentRevision: 2,
                contentDigest: "digest-2",
                flowId: "managed-flow-id",
                providerStatus: "PUBLISHED",
              },
            },
          },
        },
        transport
      )
    ).rejects.toThrow("does not match outbound WABA");

    expect(transport.sendWhatsappInteractiveFlow).not.toHaveBeenCalled();
  });

  it("does not dispatch a managed Flow whose provider status is no longer PUBLISHED", async () => {
    const transport = createTransport();

    await expect(
      dispatchWhatsAppServiceMessage(
        {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          sourceId: "source-1",
          wabaId: "waba-1",
          recipient: { kind: "phone", value: "77012345678" },
          command: {
            kind: "flow",
            body: "Start",
            flowConfig: {
              templateId: "local-flow",
              screens: [],
              ctaText: "Open flow",
              metaFlowId: "stale-published-flow-id",
              managedProvisioning: {
                operationId: "operation-1",
                sourceId: "source-1",
                wabaId: "waba-1",
                contentRevision: 2,
                contentDigest: "digest-2",
                flowId: "managed-flow-id",
                providerStatus: "BLOCKED",
              },
            },
          },
        },
        transport
      )
    ).rejects.toThrow("requires flow_id or flow_name");

    expect(transport.sendWhatsappInteractiveFlow).not.toHaveBeenCalled();
  });

  it.each(commands)(
    "dispatches $name through exactly one sender",
    async row => {
      const transport = createTransport();

      const result = await dispatchWhatsAppServiceMessage(
        {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          recipient: { kind: "phone", value: "77012345678" },
          command: row.command,
        },
        transport
      );

      expect(result.messageId).toBe("wamid.service-1");
      expect(transport[row.method]).toHaveBeenCalledTimes(1);
      expect(
        Object.values(transport).reduce(
          (count, sender) => count + sender.mock.calls.length,
          0
        )
      ).toBe(1);
    }
  );

  it("forwards voice:true on media voice notes", async () => {
    const transport = createTransport();

    await dispatchWhatsAppServiceMessage(
      {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        recipient: { kind: "phone", value: "77012345678" },
        command: {
          kind: "media",
          attachment: {
            url: "https://cdn.example.com/note.ogg",
            mediaType: "audio",
            mimeType: "audio/ogg",
            fileName: "note.ogg",
          },
          voice: true,
        },
      },
      transport
    );

    expect(transport.sendWhatsappMedia).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.objectContaining({
        type: "audio",
        link: "https://cdn.example.com/note.ogg",
        voice: true,
      })
    );
  });

  it("rejects unresolved gcs media instead of calling Meta", async () => {
    const transport = createTransport();

    await expect(
      dispatchWhatsAppServiceMessage(
        {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          recipient: { kind: "phone", value: "77012345678" },
          command: {
            kind: "media",
            attachment: {
              url: "gcs://bucket/path/card.jpg",
              mediaType: "image",
              bucket: "bucket",
              path: "path/card.jpg",
            },
          },
        },
        transport
      )
    ).rejects.toThrow(/unresolved media URL/);

    expect(transport.sendWhatsappMedia).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "reply_buttons header",
      command: {
        kind: "reply_buttons" as const,
        body: "Choose",
        header: {
          kind: "media" as const,
          attachment: { url: "gs://bucket/header.jpg", mediaType: "image" },
        },
        options: [{ id: "one", label: "One" }],
      },
    },
    {
      label: "carousel card 1",
      command: {
        kind: "media_carousel" as const,
        body: "Pick one",
        cards: [
          {
            id: "signed",
            media: {
              url: "https://cdn.example.com/one.jpg",
              mediaType: "image",
            },
            interaction: {
              kind: "quick_replies" as const,
              options: [{ id: "a", label: "A" }],
            },
          },
          {
            id: "unsigned",
            media: { url: "gcs://bucket/two.jpg", mediaType: "image" },
            interaction: {
              kind: "quick_replies" as const,
              options: [{ id: "b", label: "B" }],
            },
          },
        ],
      },
    },
  ])(
    "names the unresolved $label before calling Meta",
    async ({ label, command }) => {
      const transport = createTransport();

      await expect(
        dispatchWhatsAppServiceMessage(
          {
            phoneNumberId: "phone-number-id",
            accessToken: "access-token",
            recipient: { kind: "phone", value: "77012345678" },
            command: command as WhatsAppServiceSendCommand,
          },
          transport
        )
      ).rejects.toThrow(`unresolved media URL (${label})`);

      expect(
        transport.sendWhatsappInteractiveReplyButtonsMessage
      ).not.toHaveBeenCalled();
      expect(
        transport.sendWhatsappInteractiveMediaCarousel
      ).not.toHaveBeenCalled();
    }
  );

  it("rejects plain http media links instead of calling Meta", async () => {
    const transport = createTransport();

    await expect(
      dispatchWhatsAppServiceMessage(
        {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          recipient: { kind: "phone", value: "77012345678" },
          command: {
            kind: "media",
            attachment: {
              url: "http://cdn.example.com/card.jpg",
              mediaType: "image",
            },
          },
        },
        transport
      )
    ).rejects.toThrow(/unresolved media URL/);

    expect(transport.sendWhatsappMedia).not.toHaveBeenCalled();
  });

  it("propagates provider failures without falling back to text", async () => {
    const transport = createTransport();
    transport.sendWhatsappInteractiveReplyButtonsMessage.mockRejectedValueOnce(
      new Error("Meta rejected the buttons")
    );

    await expect(
      dispatchWhatsAppServiceMessage(
        {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          recipient: { kind: "phone", value: "77012345678" },
          command: {
            kind: "reply_buttons",
            body: "Choose",
            options: [{ id: "yes", label: "Yes" }],
          },
        },
        transport
      )
    ).rejects.toThrow("Meta rejected the buttons");

    expect(transport.sendWhatsappMessage).not.toHaveBeenCalled();
  });
});

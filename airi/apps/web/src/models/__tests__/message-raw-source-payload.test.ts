import Message from "../message";

describe("Message rawSourcePayload", () => {
  it("declares the used raw payload index but not the unused payload-type one", () => {
    const indexes = Message.schema.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          {
            "rawSourcePayload.provider": 1,
            "rawSourcePayload.eventType": 1,
            createdAt: -1,
          },
          expect.objectContaining({
            name: "messages_raw_provider_event_type_created_at_desc",
          }),
        ],
      ])
    );
    expect(
      indexes.some(
        ([, options]) =>
          options.name === "messages_raw_provider_payload_type_created_at_desc"
      )
    ).toBe(false);
  });

  it("keeps provider raw source payloads on message documents", () => {
    const capturedAt = new Date("2026-04-29T08:13:28.000Z");
    const message = new Message({
      workspaceId: "ws_1",
      conversation: "6621b4ef4f9c8e0012345678",
      channel: "whatsapp",
      direction: "inbound",
      text: "",
      date: capturedAt,
      rawSourcePayload: {
        provider: "whatsapp",
        eventType: "message",
        capturedAt,
        payload: {
          id: "wamid.1",
          type: "unsupported",
          referral: { source_id: "ad_123" },
        },
      },
    });

    expect(message.toObject()).toMatchObject({
      rawSourcePayload: {
        provider: "whatsapp",
        eventType: "message",
        capturedAt,
        payload: {
          id: "wamid.1",
          type: "unsupported",
          referral: { source_id: "ad_123" },
        },
      },
    });
  });
});

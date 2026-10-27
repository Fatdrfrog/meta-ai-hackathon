import Message, {
  MESSAGE_AIRI_INGRESS_PENDING_INDEX,
  MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX,
  MESSAGE_REQUEST_AIRI_WITNESS_INDEX_KEYS,
  MESSAGE_REQUEST_AIRI_WITNESS_INDEX_NAME,
  MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS,
} from "../message";

describe("Message indexes", () => {
  const declares = (keys: Record<string, number>) =>
    Message.schema.indexes().some(([actual]) => JSON.stringify(actual) === JSON.stringify(keys));
  it.each([{ workspaceId: 1 }, { conversation: 1 }])(
    "does not recreate a redundant non-unique prefix %j", keys => {
      expect(declares(keys)).toBe(false);
    }
  );
  it.each([
    { workspaceId: 1, text: 1, conversation: 1 },
    { workspaceId: 1, date: -1, conversation: 1 },
    { workspaceId: 1, channel: 1, date: -1, conversation: 1 },
    { workspaceId: 1, channel: 1, "whatsappGroup.groupId": 1, date: -1 },
    { workspaceId: 1, "mediaAnalysis.workflowId": 1 },
    { channel: 1 },
    { direction: 1 },
    { "external_ids.messageId": 1 },
  ])("does not declare an index retired after zero use %j", keys => {
    expect(declares(keys)).toBe(false);
  });
  it.each([
    { workspaceId: 1, channel: 1, date: -1 },
    { direction: 1, date: -1 },
  ])("declares the used index %j that production queries rely on", keys => {
    expect(declares(keys)).toBe(true);
  });
  it("constrains delivery keys only when strings, allowing legacy null and missing keys", () => {
    const indexes = Message.schema.indexes().filter(([keys]) =>
      Object.keys(keys).length === 1 && keys.temporalDeliveryKey === 1
    );
    expect(indexes).toEqual([
      [{ temporalDeliveryKey: 1 }, expect.objectContaining({
        name: "messages_temporal_delivery_key_unique_v1",
        unique: true,
        partialFilterExpression: { temporalDeliveryKey: { $type: "string" } },
      })],
    ]);
    expect(indexes[0][1].sparse).not.toBe(true);
  });

  it("assigns a normalized private dedupe key to new inbound WhatsApp messages only", async () => {
    const base = {
      date: new Date(),
      workspaceId: "workspace",
      channel: "whatsapp",
      direction: "inbound",
    };
    for (const messageId of ["wamid.replayed", "ws_wamid.replayed"]) {
      const message = new Message({ ...base, messageId });
      await message.validate();
      expect(message.whatsappInboundDedupeKey).toBe("ws_wamid.replayed");
    }
    const historical = Message.hydrate({
      ...base,
      messageId: "wamid.replayed",
    });
    await historical.validate();
    expect(historical.whatsappInboundDedupeKey).toBeUndefined();
    const outbound = new Message({
      ...base,
      messageId: "wamid.replayed",
      direction: "outbound",
    });
    await outbound.validate();
    expect(outbound.whatsappInboundDedupeKey).toBeUndefined();
    expect(Message.schema.path("whatsappInboundDedupeKey").options.select).toBe(
      false
    );
    expect(Message.schema.indexes()).toContainEqual([
      MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX.keys,
      expect.objectContaining(MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX.options),
    ]);
  });

  it("keeps the private ingress intent queryable through a bounded pending index", () => {
    expect(Message.schema.path("airiIngressIntent").options.select).toBe(false);
    expect(Message.schema.indexes()).toContainEqual([
      MESSAGE_AIRI_INGRESS_PENDING_INDEX.keys,
      expect.objectContaining(MESSAGE_AIRI_INGRESS_PENDING_INDEX.options),
    ]);
    const message = new Message({
      airiIngressIntent: {
        ingressKey: "key-1",
        ingressNextRetryAt: new Date(),
      },
    });
    expect(message.toObject().airiIngressIntent.ingressKey).toBe("key-1");
  });
  it("declares a chronological conversation index for thread reads", () => {
    expect(Message.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ conversation: 1, date: 1, _id: 1 }, expect.objectContaining({})],
      ])
    );
  });

  it("declares the shared workspace inbound-date analytics index", () => {
    expect(MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS).toEqual({
      workspaceId: 1,
      direction: 1,
      date: -1,
    });
    expect(Message.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS,
          expect.objectContaining({}),
        ],
      ])
    );
    expect(
      Message.schema
        .indexes()
        .filter(
          ([keys]) =>
            JSON.stringify(keys) ===
            JSON.stringify(MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS)
        )
    ).toHaveLength(1);
  });

  it("declares the Requests Airi witness index in exact query order", () => {
    expect(MESSAGE_REQUEST_AIRI_WITNESS_INDEX_KEYS).toEqual({
      conversation: 1,
      direction: 1,
      "origin.kind": 1,
      _id: -1,
    });
    expect(Message.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          MESSAGE_REQUEST_AIRI_WITNESS_INDEX_KEYS,
          expect.objectContaining({
            name: MESSAGE_REQUEST_AIRI_WITNESS_INDEX_NAME,
          }),
        ],
      ])
    );
  });
});

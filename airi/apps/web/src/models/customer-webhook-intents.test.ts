import Message from "./message";
import MessageDeliveryEvent from "./message-delivery-event";

async function runBeforeSave(
  document: InstanceType<typeof Message>
): Promise<void> {
  // Exercise the compiled middleware without connecting to MongoDB. Mongoose
  // keeps this test seam on its internal schema state, outside its public types.
  const middleware = Message.schema as unknown as {
    s: {
      hooks: {
        execPre(
          name: string,
          context: unknown,
          args: unknown[],
          callback: (error: Error | null) => void
        ): void;
      };
    };
  };
  await new Promise<void>((resolve, reject) => {
    middleware.s.hooks.execPre(
      "save",
      document,
      [],
      (error: Error | null) => (error ? reject(error) : resolve())
    );
  });
}

describe("customer webhook canonical persistence boundary", () => {
  it("commits the webhook recovery fact during save rather than a detached side effect", async () => {
    const message = new Message({
      channel: "whatsapp",
      direction: "inbound",
      workspaceId: "workspace-1",
      author: 0,
      conversation: "507f1f77bcf86cd799439012",
      messageId: "wamid.inbound",
      date: new Date("2026-10-03T04:00:00Z"),
      text: "Hello",
    });
    message.$locals.customerWebhookSourceId = "source-1";
    await runBeforeSave(message);
    expect(message.get("customerWebhookIntent")).toMatchObject({
      workspaceId: "workspace-1",
      eventType: "message.received",
      resourceId: "wamid.inbound",
      data: {
        source_id: "source-1",
        conversation_id: "507f1f77bcf86cd799439012",
      },
    });
    expect(message.toObject()).not.toHaveProperty("customerWebhookIntent");
    expect(message.toJSON()).not.toHaveProperty("customerWebhookIntent");
  });

  it("does not emit an outbound intent for a reserved dispatch owner", async () => {
    const message = new Message({
      channel: "whatsapp",
      direction: "outbound",
      workspaceId: "workspace-1",
      author: 0,
      conversation: "507f1f77bcf86cd799439012",
      messageId: "wamid.pending",
      date: new Date(),
      temporalDispatch: {
        version: 1,
        state: "reserved",
        deliveryKey: "delivery-1",
        attemptToken: "attempt-1",
      },
    });
    await runBeforeSave(message);
    expect(message.get("customerWebhookIntent")).toBeUndefined();
    message.temporalDispatch.state = "sent";
    message.messageId = "wamid.accepted";
    await runBeforeSave(message);
    expect(message.get("customerWebhookIntent")).toMatchObject({
      eventType: "message.sent",
      resourceId: "wamid.accepted",
    });
  });

  it("hides status recovery facts and provides bounded pending indexes", () => {
    const status = new MessageDeliveryEvent({
      workspaceId: "workspace-1",
      messageId: "wamid.outbound",
      status: "sent",
      eventAt: new Date(),
      customerWebhookIntent: {
        workspaceId: "workspace-1",
        resourceId: "private",
      },
    });
    expect(status.toJSON()).not.toHaveProperty("customerWebhookIntent");
    for (const model of [Message, MessageDeliveryEvent]) {
      expect(model.schema.path("customerWebhookIntent").options.select).toBe(
        false
      );
      expect(model.schema.indexes()).toEqual(
        expect.arrayContaining([
          [
            { "customerWebhookIntent.timestamp": 1, _id: 1 },
            expect.objectContaining({
              partialFilterExpression: {
                customerWebhookIntent: { $exists: true },
              },
            }),
          ],
        ])
      );
    }
  });
});

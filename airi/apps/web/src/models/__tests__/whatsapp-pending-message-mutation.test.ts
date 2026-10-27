import WhatsAppPendingMessageMutation from "../whatsapp-pending-message-mutation";

describe("WhatsAppPendingMessageMutation indexes", () => {
  it("declares the workspace-scoped pending apply query index", () => {
    expect(WhatsAppPendingMessageMutation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          {
            workspaceId: 1,
            status: 1,
            normalizedTargetMessageId: 1,
            eventAt: 1,
            createdAt: 1,
          },
          expect.objectContaining({
            name: "whatsapp_pending_mutations_workspace_status_target_event_created",
          }),
        ],
      ])
    );
  });
});

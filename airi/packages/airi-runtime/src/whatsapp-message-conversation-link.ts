export type WhatsAppMessageConversationLinkParams<ConversationId, MessageId> = {
  workspaceId: string;
  messageId: string;
  messageObjectId: MessageId;
  eventAt: Date;
  conversationId: ConversationId;
  direction: "inbound" | "outbound";
  conversationSet: Record<string, unknown>;
  importMode?: "history";
};

export type WhatsAppMessageConversationLinkDependencies<
  ConversationId,
  MessageId,
> = {
  applyPendingMutations: (params: {
    workspaceId: string;
    messageId: string;
    messageObjectId: MessageId;
    eventAt: Date;
  }) => Promise<void>;
  appendMessage: (
    conversationId: ConversationId,
    messageObjectId: MessageId,
    options: {
      lastMessageAt: Date;
      direction: "inbound" | "outbound";
      set: Record<string, unknown>;
      importMode?: "history";
      historicalUpdatedAt?: Date;
    },
  ) => Promise<unknown>;
};

export async function persistWhatsAppMessageConversationLink<
  ConversationId,
  MessageId,
>(
  params: WhatsAppMessageConversationLinkParams<ConversationId, MessageId>,
  dependencies: WhatsAppMessageConversationLinkDependencies<
    ConversationId,
    MessageId
  >,
): Promise<void> {
  await dependencies.applyPendingMutations({
    workspaceId: params.workspaceId,
    messageId: params.messageId,
    messageObjectId: params.messageObjectId,
    eventAt: params.eventAt,
  });
  await dependencies.appendMessage(
    params.conversationId,
    params.messageObjectId,
    {
      lastMessageAt: params.eventAt,
      direction: params.direction,
      set: params.conversationSet,
      ...(params.importMode === "history"
        ? {
            importMode: "history" as const,
            historicalUpdatedAt: params.eventAt,
          }
        : {}),
    },
  );
}

import ApiMessageSendOperation from "./api-message-send-operation";

function operation(success: boolean) {
  return new ApiMessageSendOperation({
    _id: "a".repeat(64),
    workspaceId: "workspace-1",
    apiKeyId: "key-1",
    conversationId: "507f1f77bcf86cd799439011",
    sourceId: "source-1",
    payloadDigest: "b".repeat(64),
    state: "completed",
    messageId: "507f1f77bcf86cd799439012",
    response: {
      success,
      messageId: "507f1f77bcf86cd799439012",
      sentAt: "2026-10-03T00:00:00.000Z",
    },
  });
}

it("does not persist a failed response as a successful cached send result", () => {
  expect(
    operation(false).validateSync()?.errors["response.success"]
  ).toBeDefined();
  expect(operation(true).validateSync()).toBeUndefined();
});

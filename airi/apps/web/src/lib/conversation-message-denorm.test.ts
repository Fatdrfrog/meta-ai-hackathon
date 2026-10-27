import {
  buildConversationFirstResponseUpdate,
  isAutomatedOutboundOriginKind,
  resolveConversationFirstResponseManager,
} from "./conversation-message-denorm";

describe("conversation message denormalization", () => {
  it("classifies campaign/scenario outbounds as automated (not manager handoff)", () => {
    expect(isAutomatedOutboundOriginKind("campaign")).toBe(true);
    expect(isAutomatedOutboundOriginKind("scenario")).toBe(true);
    expect(isAutomatedOutboundOriginKind("airi")).toBe(true);
    expect(isAutomatedOutboundOriginKind("bulk_analytics")).toBe(true);
    expect(isAutomatedOutboundOriginKind("system")).toBe(true);
    expect(isAutomatedOutboundOriginKind("manager")).toBe(false);
    expect(isAutomatedOutboundOriginKind(null)).toBe(false);
    expect(isAutomatedOutboundOriginKind(undefined)).toBe(false);
  });

  it("treats manager-origin outbound messages as first-response candidates", () => {
    expect(
      resolveConversationFirstResponseManager({
        direction: "outbound",
        author: "mongo-user-1",
        origin: {
          kind: "manager",
          sentByUserId: "manager-1",
        },
      })
    ).toEqual({
      managerId: "manager-1",
      authorId: "mongo-user-1",
      managerName: null,
    });
  });

  it("ignores inbound and automated outbound messages for first-response denorm", () => {
    expect(
      resolveConversationFirstResponseManager({
        direction: "inbound",
        author: "manager-1",
        origin: { kind: "manager", sentByUserId: "manager-1" },
      })
    ).toBeNull();

    expect(
      resolveConversationFirstResponseManager({
        direction: "outbound",
        author: 0,
        origin: { kind: "airi" },
      })
    ).toBeNull();

    expect(
      resolveConversationFirstResponseManager({
        direction: "outbound",
        author: "manager-1",
        origin: { kind: "campaign", sentByUserId: "manager-1" },
      })
    ).toBeNull();
  });

  it("can use a verified non-bot author as a manager fallback", () => {
    expect(
      resolveConversationFirstResponseManager(
        {
          direction: "outbound",
          author: "mongo-user-1",
          origin: null,
        },
        { authorIsHuman: true, managerName: "Aida Manager" }
      )
    ).toEqual({
      managerId: "mongo-user-1",
      authorId: "mongo-user-1",
      managerName: "Aida Manager",
    });
  });

  it("builds an atomic first-response update against the conversation read model", () => {
    const messageDate = new Date("2026-06-27T10:00:00.000Z");

    expect(
      buildConversationFirstResponseUpdate(
        {
          conversation: "conversation-1",
          workspaceId: "workspace-1",
          direction: "outbound",
          date: messageDate,
          author: "mongo-user-1",
          origin: {
            kind: "manager",
            sentByUserId: "manager-1",
          },
        },
        { managerName: "Aida Manager" }
      )
    ).toEqual({
      filter: {
        _id: "conversation-1",
        workspaceId: "workspace-1",
        first_response_at: null,
        first_inbound_at: { $type: "date", $lte: messageDate },
      },
      update: [
        {
          $set: {
            first_response_at: messageDate,
            first_response_seconds: {
              $divide: [
                { $subtract: [messageDate, "$first_inbound_at"] },
                1000,
              ],
            },
            first_response_manager_id: "manager-1",
            first_response_manager_name: "Aida Manager",
          },
        },
      ],
    });
  });
});

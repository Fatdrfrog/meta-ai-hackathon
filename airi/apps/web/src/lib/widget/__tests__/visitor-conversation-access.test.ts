const mockVerifyVisitorToken = jest.fn();

jest.mock("@/lib/widget/visitor-auth", () => ({
  verifyVisitorToken: (...args: unknown[]) => mockVerifyVisitorToken(...args),
}));

import {
  isWidgetConversationOwnedByVisitor,
  resolveWidgetRequestVisitorIds,
} from "@/lib/widget/visitor-conversation-access";

const SCOPE = { workspaceId: "workspace-1", sourceId: "source-1" };
const OWNED = {
  workspaceId: "workspace-1",
  channel: "web_widget",
  sourceId: "source-1",
  visitor_id: "visitor-1",
  user: "visitor-1",
};

function request(headers: Record<string, string>) {
  return new Request("https://www.airi.chat/api/widget/x", { headers });
}

describe("isWidgetConversationOwnedByVisitor", () => {
  const owns = (conversation: Record<string, unknown>, visitorIds: string[]) =>
    isWidgetConversationOwnedByVisitor(conversation, {
      ...SCOPE,
      visitorIds,
    });

  it("accepts the visitor's own widget conversation", () => {
    expect(owns(OWNED, ["visitor-1"])).toBe(true);
    expect(owns({ ...OWNED, sourceId: null }, ["visitor-1"])).toBe(true);
  });

  it.each([
    ["another visitor", OWNED, ["visitor-2"]],
    ["no visitor proof", OWNED, []],
    [
      "a WhatsApp conversation",
      { ...OWNED, channel: "whatsapp" },
      ["visitor-1"],
    ],
    [
      "another workspace",
      { ...OWNED, workspaceId: "workspace-2" },
      ["visitor-1"],
    ],
    [
      "another widget source",
      { ...OWNED, sourceId: "source-2" },
      ["visitor-1"],
    ],
    [
      "an ownerless conversation",
      { ...OWNED, visitor_id: null, user: null },
      ["visitor-1"],
    ],
  ])("refuses %s", (_label, conversation, visitorIds) => {
    expect(owns(conversation, visitorIds)).toBe(false);
  });

  it("uses user only for legacy conversations without visitor_id", () => {
    expect(owns({ ...OWNED, visitor_id: null }, ["visitor-1"])).toBe(true);
    expect(
      owns({ ...OWNED, visitor_id: null, user: { _id: "visitor-1" } }, [
        "visitor-1",
      ])
    ).toBe(true);
    expect(owns({ ...OWNED, user: "visitor-2" }, ["visitor-2"])).toBe(false);
  });
});

describe("resolveWidgetRequestVisitorIds", () => {
  beforeEach(() => {
    mockVerifyVisitorToken.mockReset();
  });

  it("collects the visitor id header and a token for this widget source", async () => {
    mockVerifyVisitorToken.mockResolvedValue({
      visitorId: "visitor-token-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scope: "widget",
    });

    await expect(
      resolveWidgetRequestVisitorIds(
        request({
          "x-visitor-id": " visitor-1 ",
          "x-visitor-token": "token",
        }),
        SCOPE
      )
    ).resolves.toEqual(["visitor-1", "visitor-token-1"]);
  });

  it.each([
    ["workspace", { workspaceId: "workspace-2", sourceId: "source-1" }],
    ["source", { workspaceId: "workspace-1", sourceId: "source-2" }],
  ])("ignores a token minted for another %s", async (_label, tokenScope) => {
    mockVerifyVisitorToken.mockResolvedValue({
      visitorId: "visitor-1",
      scope: "widget",
      ...tokenScope,
    });

    await expect(
      resolveWidgetRequestVisitorIds(
        request({ "x-visitor-token": "token" }),
        SCOPE
      )
    ).resolves.toEqual([]);
  });

  it("ignores invalid tokens and blank or oversized visitor ids", async () => {
    mockVerifyVisitorToken.mockResolvedValue(null);

    await expect(
      resolveWidgetRequestVisitorIds(
        request({ "x-visitor-id": "   ", "x-visitor-token": "bad" }),
        SCOPE
      )
    ).resolves.toEqual([]);
    await expect(
      resolveWidgetRequestVisitorIds(
        request({ "x-visitor-id": "v".repeat(257) }),
        SCOPE
      )
    ).resolves.toEqual([]);
  });
});

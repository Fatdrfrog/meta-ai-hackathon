const mockMessageFindOne = jest.fn();
const mockMessageExists = jest.fn();

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
    exists: (...args: unknown[]) => mockMessageExists(...args),
  },
}));

import { Types } from "mongoose";
import { findLatestInboundSharedLocation } from "./inbound-location-query";

const WAIT_FLOOR = new Date("2026-10-05T09:59:58.000Z");
const NOW = new Date("2026-10-05T10:05:00.000Z");
const SHARED_AT = new Date("2026-10-05T10:01:00.000Z");
const SHARE_ID = "651f1f77bcf86cd799439011";
const DECIDED_ID = "651f1f77bcf86cd799439012";

function createFindOneQuery(value: unknown) {
  return {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

function storedShare(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(SHARE_ID),
    date: SHARED_AT,
    text: " [Location] Abay Ave 10, Almaty ",
    whatsappLocation: { latitude: 43.238949, longitude: 76.889709 },
    whatsappMeta: { replyToWhatsAppMessageId: "wamid.request" },
    ...overrides,
  };
}

function findShare(excludeMessageIds: string[] = []) {
  return findLatestInboundSharedLocation({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    since: WAIT_FLOOR,
    until: NOW,
    excludeMessageIds,
  });
}

describe("findLatestInboundSharedLocation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageExists.mockResolvedValue(null);
  });

  it("reads the newest numeric inbound WhatsApp share in the window, skipping decided shares", async () => {
    const query = createFindOneQuery(storedShare());
    mockMessageFindOne.mockReturnValue(query);

    await expect(
      findShare([DECIDED_ID, "wamid.HBgLNzcwMTIzNDU2Nzg", "", "not-an-id"])
    ).resolves.toEqual({
      messageId: SHARE_ID,
      date: SHARED_AT,
      latitude: 43.238949,
      longitude: 76.889709,
      hasReplyContext: true,
      text: "[Location] Abay Ave 10, Almaty",
    });

    expect(mockMessageFindOne).toHaveBeenCalledTimes(1);
    expect(mockMessageFindOne.mock.calls[0][0]).toEqual({
      workspaceId: "workspace-1",
      conversation: "conversation-1",
      channel: "whatsapp",
      direction: "inbound",
      date: { $gte: WAIT_FLOOR, $lte: NOW },
      _id: { $nin: [DECIDED_ID] },
      "whatsappLocation.latitude": { $type: "number" },
      "whatsappLocation.longitude": { $type: "number" },
    });
    expect(query.sort).toHaveBeenCalledWith({ date: -1, _id: -1 });
    expect(String(query.select.mock.calls[0][0]).split(" ").sort()).toEqual(
      [
        "_id",
        "date",
        "text",
        "whatsappLocation.latitude",
        "whatsappLocation.longitude",
        "whatsappMeta.replyToWhatsAppMessageId",
      ].sort()
    );
    expect(mockMessageExists).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversation: "conversation-1",
      direction: "outbound",
      date: { $gt: new Date(SHARED_AT.getTime() + 1_000), $lte: NOW },
    });
  });

  it("leaves the id filter out when no decided id is a stored message id", async () => {
    mockMessageFindOne.mockReturnValue(createFindOneQuery(storedShare()));

    await findShare(["wamid.HBgLNzcwMTIzNDU2Nzg", "", "651f1f77"]);

    expect(mockMessageFindOne.mock.calls[0][0]).not.toHaveProperty("_id");
  });

  it("returns null when no share is in the window", async () => {
    mockMessageFindOne.mockReturnValue(createFindOneQuery(null));

    await expect(findShare()).resolves.toBeNull();
    expect(mockMessageExists).not.toHaveBeenCalled();
  });

  it.each([
    ["0,0", { whatsappLocation: { latitude: 0, longitude: 0 } }],
    [
      "an out-of-range latitude",
      { whatsappLocation: { latitude: 91, longitude: 76.9 } },
    ],
    [
      "a string coordinate",
      { whatsappLocation: { latitude: "43.2", longitude: 76.9 } },
    ],
    ["no location", { whatsappLocation: null }],
    ["no stored date", { date: undefined }],
  ])("returns null for a share with %s", async (_label, overrides) => {
    mockMessageFindOne.mockReturnValue(
      createFindOneQuery(storedShare(overrides))
    );

    await expect(findShare()).resolves.toBeNull();
    expect(mockMessageExists).not.toHaveBeenCalled();
  });

  it("returns null for a share an outbound message already followed", async () => {
    mockMessageFindOne.mockReturnValue(createFindOneQuery(storedShare()));
    mockMessageExists.mockResolvedValue({ _id: "651f1f77bcf86cd799439013" });

    await expect(findShare()).resolves.toBeNull();
    expect(mockMessageExists.mock.calls[0][0]).toMatchObject({
      direction: "outbound",
      date: { $gt: new Date("2026-10-05T10:01:01.000Z"), $lte: NOW },
    });
  });

  it.each([
    ["a cited message", { replyToWhatsAppMessageId: "wamid.request" }, true],
    ["a blank citation", { replyToWhatsAppMessageId: "   " }, false],
    ["no citation", null, false],
  ])(
    "reports reply context for %s",
    async (_label, whatsappMeta, hasReplyContext) => {
      mockMessageFindOne.mockReturnValue(
        createFindOneQuery(storedShare({ whatsappMeta }))
      );

      await expect(findShare()).resolves.toMatchObject({ hasReplyContext });
    }
  );
});

/** @jest-environment node */

const mockLinkCreate = jest.fn();
const mockLinkFindOne = jest.fn();
const mockLinkFindOneAndUpdate = jest.fn();
const mockLinkDeleteMany = jest.fn();
const mockLinkUpdateOne = jest.fn();
const mockImportFindOneAndUpdate = jest.fn();
const mockMessageFindOne = jest.fn();
const mockCreateImport = jest.fn();
const mockSendText = jest.fn();
const mockSendButtons = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockWarn = jest.fn();
let mockSources: Array<{ workspace_id: string; display_phone: string }> = [];

jest.mock("@/models/product-whatsapp-link", () => ({
  ProductWhatsAppLink: {
    create: (...args: unknown[]) => mockLinkCreate(...args),
    findOne: (...args: unknown[]) => mockLinkFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockLinkFindOneAndUpdate(...args),
    deleteMany: (...args: unknown[]) => mockLinkDeleteMany(...args),
    updateOne: (...args: unknown[]) => mockLinkUpdateOne(...args),
  },
}));
jest.mock("@/models/product-video-import", () => ({
  ProductVideoImport: {
    findOneAndUpdate: (...args: unknown[]) =>
      mockImportFindOneAndUpdate(...args),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockMessageFindOne(...args) },
}));
jest.mock("@/lib/products/imports", () => ({
  createProductVideoImport: (...args: unknown[]) => mockCreateImport(...args),
}));
jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappMessage: (...args: unknown[]) => mockSendText(...args),
  sendWhatsappInteractiveReplyButtons: (...args: unknown[]) =>
    mockSendButtons(...args),
}));
jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: async () => ({
    phoneNumberId: "airi-phone",
    accessToken: "token",
  }),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockFeatureEnabled(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));
jest.mock("@/lib/billing/config", () => ({
  getAppBaseUrl: () => "https://www.airi.chat",
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "workspaces")
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { name: "QazOner Group" } }),
            }),
          }),
        };
      return {
        select: () => ({
          eq: async () => ({ data: mockSources, error: null }),
        }),
      };
    },
  },
}));

import { createHash } from "node:crypto";
import {
  createProductsWhatsAppLink,
  handleProductsWhatsAppMessage,
  notifyProductsWhatsAppOwner,
  type ProductsWhatsAppMessage,
} from "./whatsapp-intake";

const NOW = new Date("2026-10-28T12:00:00Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);
const OWNER = "77011234567";
const CODE = "0123456789abcdef0123456789abcdef";
const VIDEO_MESSAGE = "651f1f77bcf86cd799439071";

/** A Mongoose query answering `result`, however it's narrowed. */
const query = (result: unknown) => ({
  select() {
    return this;
  },
  lean: async () => result,
});

const message = (
  overrides: Partial<ProductsWhatsAppMessage> = {}
): ProductsWhatsAppMessage => ({
  receivingPhone: "+7 708 260 9346",
  sourceId: "airi-source",
  workspaceId: "airi-workspace",
  conversationId: "651f1f77bcf86cd799439060",
  messageId: VIDEO_MESSAGE,
  from: OWNER,
  text: null,
  buttonReplyId: null,
  video: { mediaId: "media-1", mimeType: "video/mp4" },
  ...overrides,
});

const link = (overrides: Record<string, unknown> = {}) => ({
  _id: "link-1",
  workspaceId: "shop-workspace",
  via: "code",
  phone: OWNER,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PRODUCTS_WHATSAPP_NUMBER = "+7 708 260 9346";
  mockSources = [];
  mockFeatureEnabled.mockResolvedValue(true);
  mockCreateImport.mockResolvedValue({ importId: "import-1" });
  mockLinkUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mockLinkDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockLinkFindOne.mockReturnValue(query(null));
});

afterAll(() => {
  delete process.env.PRODUCTS_WHATSAPP_NUMBER;
});

describe("createProductsWhatsAppLink", () => {
  it("opens WhatsApp to airi's number with a one-time code written in", async () => {
    const created = await createProductsWhatsAppLink(
      "shop-workspace",
      "user-1",
      NOW
    );

    const url = new URL(created!.url);
    expect(url.origin + url.pathname).toBe("https://wa.me/77082609346");
    const text = url.searchParams.get("text")!;
    const code = /AIRI-SHOP:([a-f0-9]{32})$/.exec(text)![1]!;
    expect(text.startsWith("Link my shop to Airi\n")).toBe(true);
    expect(created!.expiresAt).toBe("2026-10-28T12:30:00.000Z");
    // Only the code's hash is kept.
    expect(mockLinkCreate).toHaveBeenCalledWith({
      workspaceId: "shop-workspace",
      via: "code",
      createdBy: "user-1",
      codeHash: createHash("sha256").update(code).digest("hex"),
      expiresAt: new Date("2026-10-28T12:30:00.000Z"),
    });
  });

  it("is off until airi's number is set up", async () => {
    delete process.env.PRODUCTS_WHATSAPP_NUMBER;
    expect(
      await createProductsWhatsAppLink("shop-workspace", "user-1")
    ).toBeNull();
    expect(mockLinkCreate).not.toHaveBeenCalled();
  });
});

describe("handleProductsWhatsAppMessage", () => {
  it("leaves alone messages to other numbers, and senders without a number", async () => {
    expect(
      await handleProductsWhatsAppMessage(
        message({ receivingPhone: "+1 555 000 0000" }),
        NOW
      )
    ).toEqual({ handled: false, outcome: "other_number" });
    expect(
      await handleProductsWhatsAppMessage(message({ from: null }), NOW)
    ).toEqual({ handled: false, outcome: "no_sender" });
    expect(mockLinkFindOne).not.toHaveBeenCalled();
  });

  it("links the phone that sends the code, moving it from any other workspace", async () => {
    mockLinkFindOne.mockReturnValue(
      query({ _id: "link-1", workspaceId: "shop-workspace" })
    );

    const result = await handleProductsWhatsAppMessage(
      message({ video: null, text: `Link my shop to Airi\nAIRI-SHOP:${CODE}` }),
      NOW
    );

    expect(result).toEqual({ handled: true, outcome: "linked" });
    const codeHash = createHash("sha256").update(CODE).digest("hex");
    expect(mockLinkFindOne).toHaveBeenCalledWith({
      codeHash,
      expiresAt: { $gt: NOW },
    });
    expect(mockLinkDeleteMany).toHaveBeenCalledWith({
      phone: OWNER,
      _id: { $ne: "link-1" },
    });
    expect(mockLinkUpdateOne).toHaveBeenCalledWith(
      { _id: "link-1", codeHash },
      {
        $set: { phone: OWNER, linkedAt: NOW },
        $unset: { codeHash: "", expiresAt: "" },
      }
    );
    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      expect.stringMatching(/^You're linked to QazOner Group\. Send me a video/)
    );
  });

  it("answers an expired or used code, and links nothing", async () => {
    const result = await handleProductsWhatsAppMessage(
      message({ video: null, text: `AIRI-SHOP:${CODE}` }),
      NOW
    );

    expect(result).toEqual({ handled: true, outcome: "link_expired" });
    expect(mockLinkUpdateOne).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      "That code has expired. Open Products in airi and scan the new one."
    );
  });

  it("imports a video from a phone linked within 30 minutes, without writing back", async () => {
    mockLinkFindOne.mockReturnValue(query(link({ linkedAt: minutesAgo(10) })));

    const result = await handleProductsWhatsAppMessage(message(), NOW);

    expect(result).toEqual({ handled: true, outcome: "import_started" });
    expect(mockCreateImport).toHaveBeenCalledWith({
      workspaceId: "shop-workspace",
      source: "whatsapp",
      whatsapp: {
        sourceId: "airi-source",
        workspaceId: "airi-workspace",
        conversationId: "651f1f77bcf86cd799439060",
        messageId: VIDEO_MESSAGE,
        mediaId: "media-1",
        mimeType: "video/mp4",
        phone: OWNER,
      },
    });
    expect(mockLinkUpdateOne).toHaveBeenCalledWith(
      { _id: "link-1" },
      { $set: { lastVideoAt: NOW } }
    );
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockSendButtons).not.toHaveBeenCalled();
  });

  it("asks about a later video first, and imports it when the owner says so", async () => {
    mockLinkFindOne.mockReturnValue(
      query(link({ linkedAt: minutesAgo(180), lastVideoAt: minutesAgo(45) }))
    );

    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: true,
      outcome: "asked",
    });
    expect(mockCreateImport).not.toHaveBeenCalled();
    expect(mockSendButtons).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      "Should I add the products in this video to QazOner Group?",
      [
        { id: `products-intake:add:${VIDEO_MESSAGE}`, title: "Add them" },
        { id: `products-intake:skip:${VIDEO_MESSAGE}`, title: "No" },
      ]
    );

    mockMessageFindOne.mockReturnValue(
      query({ whatsappMediaId: "media-1", mimeType: "video/mp4" })
    );
    const answer = message({
      messageId: "651f1f77bcf86cd799439072",
      video: null,
      buttonReplyId: `products-intake:add:${VIDEO_MESSAGE}`,
    });
    expect(await handleProductsWhatsAppMessage(answer, NOW)).toEqual({
      handled: true,
      outcome: "import_started",
    });
    // Only that video, in the same chat.
    expect(mockMessageFindOne).toHaveBeenCalledWith({
      _id: VIDEO_MESSAGE,
      conversation: "651f1f77bcf86cd799439060",
      whatsappMediaId: { $type: "string" },
    });
    expect(mockCreateImport).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "shop-workspace",
        whatsapp: expect.objectContaining({
          messageId: VIDEO_MESSAGE,
          mediaId: "media-1",
        }),
      })
    );

    mockCreateImport.mockClear();
    expect(
      await handleProductsWhatsAppMessage(
        message({
          video: null,
          buttonReplyId: `products-intake:skip:${VIDEO_MESSAGE}`,
        }),
        NOW
      )
    ).toEqual({ handled: true, outcome: "skipped" });
    expect(mockCreateImport).not.toHaveBeenCalled();
  });

  it("treats the workspace's own connected number as linked, asking about its first video", async () => {
    mockSources = [
      { workspace_id: "shop-workspace", display_phone: "+7 701 123 4567" },
      { workspace_id: "other-workspace", display_phone: "+7 700 000 0000" },
    ];
    mockLinkFindOneAndUpdate.mockReturnValue(
      query(link({ via: "connected_number" }))
    );

    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: true,
      outcome: "asked",
    });
    expect(mockLinkFindOneAndUpdate).toHaveBeenCalledWith(
      { phone: OWNER },
      {
        $setOnInsert: {
          phone: OWNER,
          workspaceId: "shop-workspace",
          via: "connected_number",
        },
      },
      { upsert: true, new: true }
    );
  });

  it("leaves alone videos from unknown phones, shared numbers, and workspaces without Products", async () => {
    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: false,
      outcome: "not_linked",
    });

    // A number two workspaces have connected links to neither.
    mockSources = [
      { workspace_id: "a", display_phone: "77011234567" },
      { workspace_id: "b", display_phone: "+7 701 123 45 67" },
    ];
    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: false,
      outcome: "not_linked",
    });

    mockLinkFindOne.mockReturnValue(query(link({ linkedAt: minutesAgo(5) })));
    mockFeatureEnabled.mockResolvedValue(false);
    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: false,
      outcome: "products_off",
    });

    // Text from a linked phone is for Airi as usual.
    expect(
      await handleProductsWhatsAppMessage(
        message({ video: null, text: "How much is delivery?" }),
        NOW
      )
    ).toEqual({ handled: false, outcome: "not_a_video" });
    expect(mockCreateImport).not.toHaveBeenCalled();
  });
});

describe("notifyProductsWhatsAppOwner", () => {
  const imported = (overrides: Record<string, unknown> = {}) => ({
    workspaceId: "shop-workspace",
    status: "ready",
    productCount: 7,
    errorCode: null,
    whatsapp: { sourceId: "airi-source", phone: OWNER },
    ...overrides,
  });

  it("tells the owner once where to check the products", async () => {
    mockImportFindOneAndUpdate.mockReturnValue(query(imported()));

    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");

    expect(mockImportFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "651f1f77bcf86cd799439061",
        "whatsapp.phone": { $type: "string" },
        "whatsapp.notifiedAt": null,
        status: { $in: ["ready", "failed"] },
      },
      { $set: { "whatsapp.notifiedAt": expect.any(Date) } },
      { new: true }
    );
    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      "I found 7 products in your video. Check them before they go on your shelf: https://www.airi.chat/panel/w/shop-workspace/products?review=651f1f77bcf86cd799439061"
    );
  });

  it("says why an import failed, or that it found nothing", async () => {
    mockImportFindOneAndUpdate.mockReturnValueOnce(
      query(imported({ status: "failed", errorCode: "video_too_long" }))
    );
    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");
    mockImportFindOneAndUpdate.mockReturnValueOnce(
      query(imported({ productCount: 0 }))
    );
    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");

    expect(mockSendText.mock.calls.map(call => call[3])).toEqual([
      "The video is longer than 5 minutes. Film a shorter one and upload it.",
      "No products were found in this video. Film your shelf again, saying each product's name and price.",
    ]);
  });

  it("does nothing for an upload, a running import, or an owner already told", async () => {
    mockImportFindOneAndUpdate.mockReturnValue(query(null));

    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("logs a reply WhatsApp refused, without failing", async () => {
    mockImportFindOneAndUpdate.mockReturnValue(query(imported()));
    mockSendText.mockRejectedValue(new Error("131047 re-engagement"));

    await expect(
      notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061")
    ).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      "[Products] WhatsApp reply failed",
      expect.objectContaining({ error: "131047 re-engagement" })
    );
  });
});

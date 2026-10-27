import mongoose from "mongoose";
import { buildConversationListPreview } from "@/features/panel/requests/message-preview";
import {
  REQUEST_LIST_ROW_MAX_BYTES,
  requestListPayloadUtf8Bytes,
  type RequestProjectionSource,
} from "./contract";
import { REQUEST_LIST_MIN_SORT_AT, deriveRequestListItem } from "./derive";

const conversationId = new mongoose.Types.ObjectId("65f000000000000000000001");
const chatId = new mongoose.Types.ObjectId("65f000000000000000000002");
const olderMessageId = new mongoose.Types.ObjectId("65f000000000000000000003");
const newerMessageId = new mongoose.Types.ObjectId("65f000000000000000000004");
const sourceWatermark = new mongoose.mongo.Timestamp({ t: 12, i: 3 });
const readStateWatermark = new mongoose.mongo.Timestamp({ t: 11, i: 9 });

function source(
  overrides: Partial<RequestProjectionSource> = {}
): RequestProjectionSource {
  return {
    conversation: {
      _id: conversationId,
      workspaceId: "workspace-1",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      lastMessageAt: new Date("2026-08-10T00:00:00.000Z"),
      last_inbound_at: new Date("2026-08-09T00:00:00.000Z"),
      last_outbound_at: new Date("2026-08-10T00:00:00.000Z"),
      channel: "whatsapp",
      status: "open",
      user: "customer-1",
      chat: chatId,
      sourceId: "source-1",
      business_connection_id: "business-1",
      rename: "Primary Contact",
      internal_labels: ["vip"],
      participants: { from: ["+1 (555) 0100"], to: ["15550101"] },
      classification: {
        summary: "Needs help",
        category: "Support",
        priority: "high",
        action: "Reply",
      },
      is_read_by_manager: true,
      is_best_practice: true,
      customer_satisfaction_score: 4,
      awaiting_csat: false,
    },
    messages: [
      {
        _id: olderMessageId,
        text: "older",
        date: new Date("2026-08-08T00:00:00.000Z"),
        direction: "inbound",
        author: "customer-1",
      },
      {
        _id: newerMessageId,
        text: "newer",
        date: new Date("2026-08-10T00:00:00.000Z"),
        direction: "outbound",
        author: "manager-1",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        text: "must be dropped",
        date: new Date("2026-08-07T00:00:00.000Z"),
      },
    ],
    users: [
      {
        _id: "customer-1",
        firstName: "Ada",
        lastName: "Lovelace",
        username: "ADA.USER",
        avatar_url: "https://example.test/customer.png",
      },
      {
        _id: "manager-1",
        firstName: "Grace",
        lastName: "Hopper",
        username: "grace",
        isBot: false,
      },
    ],
    chat: {
      _id: chatId,
      title: "Priority Chat",
      type: "private",
      username: "priority_chat",
      is_forum: false,
    },
    airiWitness: { _id: new mongoose.Types.ObjectId() },
    ...overrides,
  };
}

function derive(inputSource = source()) {
  return deriveRequestListItem({
    source: inputSource,
    generation: BigInt(7),
    workspaceUnreadGeneration: BigInt(3),
    projectedAt: new Date("2026-08-15T00:00:00.000Z"),
    sourceWatermark,
    readStateWatermark,
  });
}

describe("deriveRequestListItem", () => {
  it("installs the explicit native source and read-state watermarks", () => {
    expect(derive().projection).toMatchObject({
      sourceWatermark,
      readStateWatermark,
    });
  });

  it("keeps the latest two messages ordered by date and id", () => {
    const sameDate = new Date("2026-08-10T00:00:00.000Z");
    const row = derive(
      source({
        messages: [
          { _id: olderMessageId, text: "lower id", date: sameDate },
          { _id: newerMessageId, text: "higher id", date: sameDate },
          {
            _id: new mongoose.Types.ObjectId("65f000000000000000000005"),
            text: "older date",
            date: new Date("2026-08-09T00:00:00.000Z"),
          },
        ],
      })
    );

    expect(row.recentMessages?.map(message => message.text)).toEqual([
      "higher id",
      "lower id",
    ]);
  });

  it("preserves non-true manager-read compatibility as unread", () => {
    for (const value of [false, null, undefined, "legacy"]) {
      const row = derive(
        source({
          conversation: { ...source().conversation, is_read_by_manager: value },
        })
      );
      expect(row.projection.generation).toBe(BigInt(7));
      expect(row.unreadGeneration).toBe(BigInt(3));
    }
    expect(derive().unreadGeneration).toBeNull();
  });

  it("derives SLA and CSAT and no longer projects retired health signals", () => {
    const row = derive(
      source({
        conversation: {
          ...source().conversation,
          churn_risk_level: "high",
          health_score_snapshot: 90,
          health_score_factors: { engagement: 80 },
        },
      })
    );

    expect(row.customerSatisfactionScore).toBe(4);
    expect(row.slaDueAt).toEqual(new Date("2026-08-04T00:00:00.000Z"));
    expect(row).not.toHaveProperty("health");
    expect(row).not.toHaveProperty("hasChurnRisk");
    expect(row).not.toHaveProperty("churnRank");
  });

  it("requires last outbound plus an eligible historical Airi message", () => {
    expect(derive().hasAiriReply).toBe(true);
    expect(
      derive(
        source({
          conversation: { ...source().conversation, last_outbound_at: null },
        })
      ).hasAiriReply
    ).toBe(false);
    expect(derive(source({ airiWitness: null })).hasAiriReply).toBe(false);
  });

  it("normalizes profile and phone search without locale formatting", () => {
    const row = derive();

    expect(row.profileSearchText).toBe(
      "ada.user ada lovelace priority chat priority_chat primary contact +1 (555) 0100 15550101"
    );
    expect(row.phoneDigits).toBe("1555010015550101");
  });

  it("prefers the conversation source and falls back to the chat source", () => {
    expect(derive().sourceId).toBe("source-1");
    expect(
      derive(
        source({
          conversation: { ...source().conversation, sourceId: null },
          chat: { ...source().chat, sourceId: "chat-source" },
        })
      ).sourceId
    ).toBe("chat-source");
  });

  it("caps strings, arrays and the serialized payload at 16 KiB", () => {
    const huge = "🙂".repeat(10_000);
    const row = derive(
      source({
        conversation: {
          ...source().conversation,
          rename: huge,
          subject: huge,
          internal_labels: Array.from(
            { length: 200 },
            (_, index) => `${index}-${huge}`
          ),
        },
        messages: [
          {
            _id: newerMessageId,
            date: new Date(),
            text: huge,
            rawSourcePayload: { credentials: huge },
          },
        ],
      })
    );

    expect(row.internalLabels?.length).toBeLessThanOrEqual(64);
    expect(requestListPayloadUtf8Bytes(row)).toBeLessThanOrEqual(
      REQUEST_LIST_ROW_MAX_BYTES
    );
  });

  it("never persists rawSourcePayload, credentials, transcript or Flow response JSON", () => {
    const row = derive(
      source({
        messages: [
          {
            _id: newerMessageId,
            date: new Date("2026-08-10T00:00:00.000Z"),
            text: "original",
            rawSourcePayload: {
              provider: "whatsapp",
              credentials: "secret",
            },
            transcript: "private transcript",
            editMeta: {
              editedAt: new Date("2026-08-10T01:00:00.000Z"),
              previousText: "before edit",
              editCount: 1,
              source: "manager",
              kind: "edit",
            },
            whatsappFlow: { flowId: "flow-1", responseJson: "secret response" },
            whatsappFlowReply: {
              body: "answer",
              responseJson: "secret response",
            },
            whatsappTemplate: {
              name: "welcome",
              bodyText: "Welcome!",
              buttons: [{ type: "quick_reply", text: "Continue" }],
            },
            whatsappServiceMessage: {
              version: 1,
              kind: "reply_buttons",
              bodyText: "Choose one",
              command: { secretCommand: "must not persist" },
            },
            groundedReplyOptions: {
              surface: "whatsapp_button",
              options: [
                {
                  id: "option-1",
                  label: "Basic",
                  sourceKind: "kb",
                  sourceIds: ["source-secret"],
                },
              ],
            },
            telegramReplyMarkup: {
              inlineKeyboard: [
                [{ text: "Open", type: "url", url: "https://example.test" }],
              ],
            },
          },
        ],
      })
    );
    const serialized = JSON.stringify(row, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );

    expect(serialized).not.toContain("rawSourcePayload");
    expect(serialized).not.toContain("credentials");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("responseJson");
    expect(serialized).not.toContain("secretCommand");
    expect(serialized).not.toContain("source-secret");
    expect(row.recentMessages?.[0]).toMatchObject({
      text: "original",
      editMeta: { previousText: "before edit", editCount: 1 },
      whatsappFlow: { flowId: "flow-1" },
      whatsappFlowReply: { body: "answer" },
      whatsappTemplate: { name: "welcome", bodyText: "Welcome!" },
      whatsappServiceMessage: {
        version: 1,
        kind: "reply_buttons",
        bodyText: "Choose one",
      },
      groundedReplyOptions: {
        surface: "whatsapp_button",
        options: [{ id: "option-1", label: "Basic", sourceIds: [] }],
      },
      telegramReplyMarkup: {
        inlineKeyboard: [
          [{ text: "Open", type: "url", url: "https://example.test" }],
        ],
      },
    });
  });

  it("maps absent lastMessageAt to the documented minimum sort sentinel", () => {
    const row = derive(
      source({
        conversation: { ...source().conversation, lastMessageAt: null },
      })
    );

    expect(REQUEST_LIST_MIN_SORT_AT.getTime()).toBe(-8_640_000_000_000_000);
    expect(row.sortAt).toEqual(REQUEST_LIST_MIN_SORT_AT);
    expect(row.displayAt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
  });

  it("caps every retained display/query category and always fits the final row", () => {
    const huge = "🙂".repeat(10_000);
    const row = derive(
      source({
        conversation: {
          ...source().conversation,
          channel: "instagram",
          status: huge,
          rename: huge,
          subject: huge,
          internal_labels: Array.from(
            { length: 200 },
            (_, index) => `${index}-${huge}`
          ),
          participants: {
            from: Array.from({ length: 100 }, (_, index) => `${index}${huge}`),
            to: Array.from(
              { length: 100 },
              (_, index) => `${index + 100}${huge}`
            ),
          },
          classification: {
            summary: huge,
            category: huge,
            priority: huge,
            action: huge,
          },
          external_thread: {
            type: "comment",
            permalink: huge,
            comment: {
              timestamp: new Date("2026-08-09T12:00:00.000Z"),
              parentId: huge,
              hidden: false,
              likeCount: 1,
            },
            media: {
              mediaType: huge,
              mediaProductType: huge,
              timestamp: new Date("2026-08-08T12:00:00.000Z"),
              caption: huge,
              mediaUrl: huge,
              thumbnailUrl: huge,
              shortcode: huge,
              username: huge,
            },
          },
        },
        users: [
          {
            _id: "customer-1",
            firstName: huge,
            lastName: huge,
            username: huge,
            avatar_url: huge,
          },
        ],
        chat: {
          _id: chatId,
          title: huge,
          type: huge,
          first_name: huge,
          last_name: huge,
          username: huge,
          sourceId: "source-1",
        },
        messages: [
          {
            _id: newerMessageId,
            date: new Date("2026-08-10T00:00:00.000Z"),
            text: huge,
            direction: huge,
            imageUrl: huge,
            mediaType: huge,
            mimeType: huge,
            fileName: huge,
            editMeta: { previousText: huge, source: huge, kind: huge },
            whatsappTemplate: {
              name: huge,
              bodyText: huge,
              buttons: Array.from({ length: 100 }, () => ({
                type: huge,
                text: huge,
              })),
            },
            whatsappServiceMessage: { version: 1, kind: huge, bodyText: huge },
            telegramReplyMarkup: {
              inlineKeyboard: Array.from({ length: 100 }, () =>
                Array.from({ length: 100 }, () => ({
                  text: huge,
                  type: "url",
                  url: huge,
                }))
              ),
            },
          },
        ],
      })
    );

    expect(requestListPayloadUtf8Bytes(row)).toBeLessThanOrEqual(
      REQUEST_LIST_ROW_MAX_BYTES
    );
    expect(Buffer.byteLength(row.status || "", "utf8")).toBeLessThanOrEqual(
      128
    );
    expect(
      Buffer.byteLength(row.profileSearchText || "", "utf8")
    ).toBeLessThanOrEqual(2048);
  });

  it.each([
    ["workspaceId", { workspaceId: "x".repeat(257) }],
    ["sourceId", { sourceId: "x".repeat(257) }],
    ["businessConnectionId", { business_connection_id: "x".repeat(257) }],
  ])("rejects oversized collision-sensitive %s", (field, override) => {
    expect(() =>
      derive(
        source({ conversation: { ...source().conversation, ...override } })
      )
    ).toThrow(new RegExp(`${field}.*256 UTF-8 bytes`, "i"));
  });

  it("shows stored Instagram media under the provider's label", () => {
    const row = derive(
      source({
        messages: [
          {
            _id: newerMessageId,
            date: new Date("2026-08-10T00:00:00.000Z"),
            text: "[file attachment]",
            imageUrl: "https://storage.test/instagram/story.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            rawSourcePayload: {
              provider: "instagram",
              payload: {
                message: {
                  attachments: [
                    {
                      type: "story_mention",
                      payload: {
                        url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1",
                      },
                    },
                  ],
                },
              },
            },
          },
          {
            _id: olderMessageId,
            date: new Date("2026-08-09T00:00:00.000Z"),
            mediaType: "file",
            rawSourcePayload: {
              provider: "instagram",
              payload: {
                message: {
                  attachments: [
                    {
                      type: "ig_reel",
                      payload: { url: "https://www.instagram.com/reel/abc/" },
                    },
                  ],
                },
              },
            },
          },
        ],
      })
    );

    expect(row.recentMessages).toMatchObject([
      {
        text: "Tagged in Instagram story",
        mediaType: "video",
        mimeType: "video/mp4",
        imageUrl: "https://storage.test/instagram/story.mp4",
      },
      {
        text: "Shared Instagram reel\nhttps://www.instagram.com/reel/abc/",
        mediaType: "file",
      },
    ]);
    expect(row.recentMessages?.[1]).not.toHaveProperty("imageUrl");
  });

  it("keeps safe Flow reply response semantics without raw response JSON", () => {
    const row = derive(
      source({
        messages: [
          {
            _id: newerMessageId,
            date: new Date("2026-08-10T00:00:00.000Z"),
            direction: "inbound",
            whatsappFlowReply: {
              flowName: "survey",
              responseJson:
                '{"flow_token":"secret","name":"Ada","city":"London"}',
            },
          },
        ],
      })
    );
    const serialized = JSON.stringify(row, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );

    expect(row.recentMessages?.[0]?.whatsappFlowReply).toMatchObject({
      responseFieldCount: 2,
      responseSubmitted: true,
    });
    expect(serialized).not.toContain("responseJson");
    expect(serialized).not.toContain("secret");
    expect(
      buildConversationListPreview({
        messages: row.recentMessages as never,
      })
    ).toMatchObject({ details: "2 answers" });
  });

  it("derives a bounded Instagram comment-thread preview from exact fields", () => {
    const row = derive(
      source({
        conversation: {
          ...source().conversation,
          channel: "instagram",
          external_thread: {
            provider: "instagram",
            type: "comment",
            permalink: "",
            comment: {
              id: "comment-1",
              timestamp: new Date("2026-08-09T12:00:00.000Z"),
              parentId: "parent-1",
              hidden: true,
              likeCount: 8,
            },
            media: {
              id: "media-1",
              mediaType: "IMAGE",
              mediaProductType: "FEED",
              shortcode: "short-code",
              timestamp: new Date("2026-08-08T12:00:00.000Z"),
              caption: "Caption",
              mediaUrl: "media.jpg",
              thumbnailUrl: "thumb.jpg",
              username: "brand",
            },
          },
        },
        messages: [
          {
            _id: newerMessageId,
            date: new Date("2026-08-10T00:00:00.000Z"),
            text: "[Comment by @ada]: Nice post\n[Post]: https://example.test/p/1",
          },
        ],
      })
    );

    expect(row.recentMessages?.[0]?.text).toBe("Nice post");
    expect(row.instagram).toEqual({
      commentTimestamp: new Date("2026-08-09T12:00:00.000Z"),
      isReply: true,
      isHidden: true,
      likeCount: 8,
      mediaType: "IMAGE",
      mediaProductType: "FEED",
      mediaTimestamp: new Date("2026-08-08T12:00:00.000Z"),
      mediaCaption: "Caption",
      mediaPreviewUrl: "thumb.jpg",
      mediaPermalink: "https://www.instagram.com/p/short-code/",
      mediaShortcode: "short-code",
      mediaAuthorUsername: "brand",
    });

    const fallback = derive(
      source({
        conversation: {
          ...source().conversation,
          channel: "instagram",
          external_thread: { type: "comment", comment: {}, media: {} },
        },
        messages: [
          {
            _id: newerMessageId,
            date: new Date("2026-08-10T00:00:00.000Z"),
            text: "Comment",
          },
        ],
      })
    );
    expect(fallback.instagram?.commentTimestamp).toEqual(
      new Date("2026-08-10T00:00:00.000Z")
    );
  });

  it("matches mixed user identities without persisting routing control fields", () => {
    const row = derive(
      source({
        conversation: { ...source().conversation, user: 123 },
        messages: [
          {
            _id: newerMessageId,
            date: new Date("2026-08-10T00:00:00.000Z"),
            author: "123",
          },
        ],
        users: [
          { _id: 123, firstName: "Numeric customer" },
          { _id: "123", firstName: "String author" },
        ],
      })
    );

    expect(row.customer).toMatchObject({ firstName: "Numeric customer" });
    expect(row.recentMessages?.[0]?.author).toMatchObject({
      firstName: "String author",
    });
    expect(row).not.toHaveProperty("dependencyUserKeys");
    expect(row).not.toHaveProperty("dependencyChatKey");
  });
});

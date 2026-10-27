import {
  buildInstagramAttachmentMessagePayload,
  buildInstagramDmMessageBody,
  buildInstagramPrivateReplyMessageBody,
  resolveInstagramSenderId,
} from "@/lib/instagram/outbound";

describe("Instagram outbound helpers", () => {
  it("sends as the Instagram account under Instagram Login, otherwise as the Page", () => {
    const credentials = {
      page_id: 1234567890,
      instagram_business_account_id: " 17841400000000000 ",
      instagram_scoped_id: "",
    };
    expect(
      resolveInstagramSenderId(credentials, "instagram_business_login")
    ).toBe("17841400000000000");
    expect(resolveInstagramSenderId(credentials, "facebook_login")).toBe(
      "1234567890"
    );
    expect(resolveInstagramSenderId({}, null)).toBe("");
  });

  it.each([
    ["image", "image"],
    ["video", "video"],
    ["audio", "audio"],
    ["document", "file"],
    ["file", "file"],
  ] as const)(
    "maps %s attachments to Instagram %s payloads",
    (mediaType, expectedType) => {
      expect(
        buildInstagramAttachmentMessagePayload({
          mediaType,
          url: "https://cdn.example.com/asset",
        })
      ).toEqual({
        attachment: {
          type: expectedType,
          payload: {
            url: "https://cdn.example.com/asset",
          },
        },
      });
    }
  );

  it("builds private-reply bodies with recipient.comment_id", () => {
    expect(
      buildInstagramPrivateReplyMessageBody({
        commentId: "comment-1",
        text: "How can I help?",
      })
    ).toEqual({
      recipient: {
        comment_id: "comment-1",
      },
      message: {
        text: "How can I help?",
      },
    });
  });

  it("builds normal DM bodies without the Human Agent tag", () => {
    expect(
      buildInstagramDmMessageBody({
        recipientId: "ig-user-1",
        message: { text: "Inside the standard window" },
      })
    ).toEqual({
      recipient: { id: "ig-user-1" },
      message: { text: "Inside the standard window" },
      messaging_type: "RESPONSE",
    });
  });

  it("adds the Human Agent tag only for approved outside-window replies", () => {
    expect(
      buildInstagramDmMessageBody({
        recipientId: "ig-user-1",
        message: { text: "Follow-up from a teammate" },
        useHumanAgentTag: true,
      })
    ).toEqual({
      recipient: { id: "ig-user-1" },
      message: { text: "Follow-up from a teammate" },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });
  });
});

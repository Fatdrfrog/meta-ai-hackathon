import { classifyGenerativeAIInbound } from "@/lib/airi/reply/runtime/generative-ai-input";
import { type GenerativeAIInboundCandidate } from "@icecore/airi-runtime/scenario-generative-ai-input-types";

function candidate(
  overrides: Partial<GenerativeAIInboundCandidate> = {}
): GenerativeAIInboundCandidate {
  return {
    messageId: "message-1",
    kind: "text",
    textOrCaption: "Create a launch video",
    whatsappMediaId: null,
    declaredMimeType: null,
    fileName: null,
    ...overrides,
  };
}

describe("generative AI inbound classification", () => {
  it("accepts meaningful text without media for text-to-video", () => {
    expect(
      classifyGenerativeAIInbound({
        expectedInputKind: "text",
        inbound: candidate({ textOrCaption: "  Create a launch video  " }),
      })
    ).toEqual({
      status: "compatible",
      input: {
        messageId: "message-1",
        kind: "text",
        textOrCaption: "Create a launch video",
        whatsappMediaId: null,
        declaredMimeType: null,
        fileName: null,
      },
    });
  });

  it.each([
    candidate({ textOrCaption: "   " }),
    candidate({ textOrCaption: "[Message deleted]" }),
    candidate({ textOrCaption: "[image attachment]" }),
    candidate({
      kind: "image",
      textOrCaption: "caption",
      whatsappMediaId: "wa-media-1",
      declaredMimeType: "image/jpeg",
    }),
  ])("rejects non-meaningful text or media for text-to-video", inbound => {
    expect(
      classifyGenerativeAIInbound({
        expectedInputKind: "text",
        inbound,
      })
    ).toEqual({
      status: "wrong_type",
      expectedInputKind: "text",
    });
  });

  it.each([
    candidate({
      kind: "audio",
      textOrCaption: "[audio attachment]",
      whatsappMediaId: "wa-audio-1",
      declaredMimeType: "audio/ogg",
      promptInputAnswerText: "Aya, rhythmic gymnastics",
    }),
    candidate({
      kind: "video",
      textOrCaption: "[Round video]",
      whatsappMediaId: "wa-video-1",
      declaredMimeType: "video/mp4",
      promptInputAnswerText: "Aya, rhythmic gymnastics",
    }),
    candidate({
      kind: "image",
      textOrCaption: "Aya, rhythmic gymnastics",
      whatsappMediaId: "wa-image-1",
      declaredMimeType: "image/jpeg",
      fileName: "photo.jpg",
      promptInputAnswerText: "Aya, rhythmic gymnastics",
    }),
  ])(
    "accepts the reply that completed a prompt-input collector for text-to-video",
    inbound => {
      expect(
        classifyGenerativeAIInbound({ expectedInputKind: "text", inbound })
      ).toEqual({
        status: "compatible",
        input: {
          messageId: "message-1",
          kind: "text",
          textOrCaption: "Aya, rhythmic gymnastics",
          whatsappMediaId: null,
          declaredMimeType: null,
          fileName: null,
        },
      });
    }
  );

  it("keeps image input strict for a reply that completed a collector", () => {
    expect(
      classifyGenerativeAIInbound({
        expectedInputKind: "image",
        inbound: candidate({
          kind: "audio",
          textOrCaption: "[audio attachment]",
          whatsappMediaId: "wa-audio-1",
          declaredMimeType: "audio/ogg",
          promptInputAnswerText: "Aya, rhythmic gymnastics",
        }),
      })
    ).toEqual({ status: "wrong_type", expectedInputKind: "image" });
  });

  it("accepts owned WhatsApp image media and keeps its caption optional", () => {
    expect(
      classifyGenerativeAIInbound({
        expectedInputKind: "image",
        inbound: candidate({
          kind: "image",
          textOrCaption: "   ",
          whatsappMediaId: "  wa-media-1  ",
          declaredMimeType: " IMAGE/JPEG; charset=binary ",
          fileName: "  photo.jpg  ",
        }),
      })
    ).toEqual({
      status: "compatible",
      input: {
        messageId: "message-1",
        kind: "image",
        textOrCaption: null,
        whatsappMediaId: "wa-media-1",
        declaredMimeType: "image/jpeg",
        fileName: "photo.jpg",
      },
    });
  });

  it("drops a placeholder caption from owned image input", () => {
    expect(
      classifyGenerativeAIInbound({
        expectedInputKind: "image",
        inbound: candidate({
          kind: "image",
          textOrCaption: " [image attachment] ",
          whatsappMediaId: "wa-media-1",
          declaredMimeType: "image/png",
        }),
      })
    ).toEqual({
      status: "compatible",
      input: {
        messageId: "message-1",
        kind: "image",
        textOrCaption: null,
        whatsappMediaId: "wa-media-1",
        declaredMimeType: "image/png",
        fileName: null,
      },
    });
  });

  it("rejects a non-image kind or an image MIME outside the official allowlist", () => {
    for (const inbound of [
      candidate({
        kind: "video",
        whatsappMediaId: "wa-media-1",
        declaredMimeType: "video/mp4",
      }),
      candidate({
        kind: "image",
        whatsappMediaId: "wa-media-1",
        declaredMimeType: "image/svg+xml",
      }),
    ]) {
      expect(
        classifyGenerativeAIInbound({
          expectedInputKind: "image",
          inbound,
        })
      ).toEqual({
        status: "wrong_type",
        expectedInputKind: "image",
      });
    }
  });

  it("classifies allowed image media without a WhatsApp owner ID separately", () => {
    expect(
      classifyGenerativeAIInbound({
        expectedInputKind: "image",
        inbound: candidate({
          kind: "image",
          whatsappMediaId: " ",
          declaredMimeType: "image/png",
        }),
      })
    ).toEqual({
      status: "missing_owned_media",
      expectedInputKind: "image",
    });
  });

  it("projects only the bounded descriptor fields", () => {
    const inbound = {
      ...candidate({
        kind: "image",
        whatsappMediaId: "wa-media-1",
        declaredMimeType: "image/png",
      }),
      rawWebhook: { access_token: "secret" },
      mediaBytes: Buffer.from("secret"),
      proxyUrl: "https://example.test/private",
    };

    const result = classifyGenerativeAIInbound({
      expectedInputKind: "image",
      inbound,
    });

    expect(result.status).toBe("compatible");
    if (result.status !== "compatible") return;
    expect(Object.keys(result.input).sort()).toEqual(
      [
        "declaredMimeType",
        "fileName",
        "kind",
        "messageId",
        "textOrCaption",
        "whatsappMediaId",
      ].sort()
    );
  });
});

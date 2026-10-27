import {
  isDeletedMessagePlaceholderText,
  isMeaningfulMessageText,
  isMediaPlaceholderText,
  isNonLinguisticPlaceholderText,
  resolveReplyVisibleMessageText,
} from "@/lib/media/message-media-utils";
import { buildMediaOnlyClarification } from "@/lib/airi/reply/runtime/media-only";

describe("media-only placeholder handling", () => {
  it("treats attachment and deleted-message placeholders as non-meaningful text", () => {
    expect(isMediaPlaceholderText("[video attachment]")).toBe(true);
    expect(isMediaPlaceholderText("[image attachment]")).toBe(true);
    expect(isMediaPlaceholderText("[document attachment]")).toBe(true);
    expect(isMediaPlaceholderText("[attachment]")).toBe(true);
    expect(isDeletedMessagePlaceholderText("[Message deleted]")).toBe(true);
    expect(isNonLinguisticPlaceholderText("[Message deleted]")).toBe(true);

    expect(isMeaningfulMessageText("[video attachment]")).toBe(false);
    expect(isMeaningfulMessageText("[image attachment]")).toBe(false);
    expect(isMeaningfulMessageText("[document attachment]")).toBe(false);
    expect(isMeaningfulMessageText("[attachment]")).toBe(false);
    expect(isMeaningfulMessageText("[Round video]")).toBe(false);
    expect(isMeaningfulMessageText("[Message deleted]")).toBe(false);
    expect(isMeaningfulMessageText("РњРµРЅРґРµ СЃТ±СЂР°Т› Р±Р°СЂ")).toBe(true);
  });

  it("builds a safe Russian clarification for media-only inbound without claiming the media was viewed", () => {
    const reply = buildMediaOnlyClarification("ru", "video");

    expect(reply).toContain("видео");
    expect(reply).toContain("что именно вас интересует");
    expect(reply).not.toMatch(/видел|посмотрел|просмотрел/i);
  });

  it("builds a safe Kazakh clarification for media-only inbound", () => {
    const reply = buildMediaOnlyClarification("kz", "image");

    expect(reply).toContain("суретіңіз");
    expect(reply).toContain("нақты не қызықтыратынын");
  });
  it("uses stored audio and video analysis as fallback thread text", () => {
    expect(
      resolveReplyVisibleMessageText({
        mediaType: "audio",
        text: "[voice message]",
        audioAnalysis: "Transcript: Pricing details\nIntent: Grant eligibility",
      })
    ).toEqual({
      text: "Audio message summary:\nTranscript: Pricing details\nIntent: Grant eligibility",
      source: "audio_analysis",
    });

    expect(
      resolveReplyVisibleMessageText({
        mediaType: "video",
        text: "",
        videoAnalysis: "Video shows a cracked screen and error banner.",
      })
    ).toEqual({
      text: "Video message summary:\nVideo shows a cracked screen and error banner.",
      source: "video_analysis",
    });
  });

  it("shows one part: typed text first, then the analysis the media type allows", () => {
    const analyses = {
      audioAnalysis: "  Spoken order  ",
      videoAnalysis: "Filmed order",
    };
    expect(
      resolveReplyVisibleMessageText({
        ...analyses,
        mediaType: "audio",
        text: "  Typed order  ",
      })
    ).toEqual({ text: "Typed order", source: "text" });
    expect(
      resolveReplyVisibleMessageText({ ...analyses, mediaType: " VOICE " })
    ).toEqual({
      text: "Audio message summary:\nSpoken order",
      source: "audio_analysis",
    });
    expect(
      resolveReplyVisibleMessageText({ ...analyses, mediaType: "video" })
    ).toEqual({
      text: "Video message summary:\nFilmed order",
      source: "video_analysis",
    });
    expect(
      resolveReplyVisibleMessageText({
        ...analyses,
        mediaType: null,
        text: "[image attachment]",
      })
    ).toEqual({
      text: "Audio message summary:\nSpoken order",
      source: "audio_analysis",
    });
    expect(
      resolveReplyVisibleMessageText({
        mediaType: "",
        audioAnalysis: "[audio attachment]",
        videoAnalysis: "Filmed order",
      })
    ).toEqual({
      text: "Video message summary:\nFilmed order",
      source: "video_analysis",
    });
    expect(
      resolveReplyVisibleMessageText({ ...analyses, mediaType: "image" })
    ).toEqual({ text: "", source: "none" });
    expect(
      resolveReplyVisibleMessageText({ text: "   ", mediaType: "audio" })
    ).toEqual({ text: "", source: "none" });
  });
});

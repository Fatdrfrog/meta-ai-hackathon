import {
  finalizeAssistantReplyForDelivery,
  formatFinalizedAssistantReplyForOutbound,
} from "@/lib/airi/reply/generation/reply-safety";
import { shouldPreferRetriedAssistantReply } from "@/lib/airi/reply/generation/reply-completeness";

describe("reply safety", () => {
  it("normalizes delivery text without replacing it with a clarification", () => {
    const result = finalizeAssistantReplyForDelivery({
      reply: "  Ответ с пробелами по краям  ",
    });

    expect(result.reply).toBe("Ответ с пробелами по краям");
    expect(result.wasTrimmed).toBe(true);
  });

  it("removes an assistant prefix from generated model output", () => {
    expect(
      finalizeAssistantReplyForDelivery({
        reply: "  Airi: welcome  ",
      })
    ).toEqual({
      reply: "welcome",
      wasTrimmed: true,
    });
  });

  it("does not add an assistant prefix to canonical service-message output", () => {
    expect(
      formatFinalizedAssistantReplyForOutbound({
        reply: "welcome",
        includeAssistantPrefix: false,
      })
    ).toBe("welcome");
  });

  it("adds exactly one assistant prefix to ordinary generated output", () => {
    expect(
      formatFinalizedAssistantReplyForOutbound({
        reply: "welcome",
        includeAssistantPrefix: true,
      })
    ).toBe("Airi: welcome");
  });

  it("never prefers an incomplete but longer retry candidate", () => {
    const original =
      "Пожалуйста, уточните, о каком именно этапе идет речь.\n\nРанее мы сообщали о 3-м туре:\n1. Пройти 1-";
    const candidate =
      "Пожалуйста, уточните, о каком именно этапе идет речь.\n\nРанее мы сообщали о 3-м туре:\n1. Пройти 1-й и 2-й туры.\n2. Под";

    expect(shouldPreferRetriedAssistantReply(original, candidate)).toBe(false);
  });
});

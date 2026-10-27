jest.mock("@/lib/ai", () => {
  throw new Error("safe intent replies must not import the AI provider stack");
});

import { generateSafeIntentReply } from "@/lib/airi/reply/generation/safe-intent-reply";

describe("safe intent reply", () => {
  it("uses deterministic templates without an LLM dependency", () => {
    expect(
      generateSafeIntentReply({
        type: "greeting",
        language: "en",
        alreadyGreetedToday: false,
      })
    ).toBe("Hi, how can I help?");

    expect(
      generateSafeIntentReply({
        type: "presence_check",
        language: "en",
        alreadyGreetedToday: true,
      })
    ).toBe("I am here and ready to help.");
  });
});

import { buildAgentContext } from "@/lib/airi/agent-context";

describe("agent context", () => {
  it("formats prompt guidance from canonical thread inputs only", () => {
    const context = buildAgentContext({
      currentGoal: "Pricing and WhatsApp onboarding for Airi.chat",
      unresolvedNeeds: [
        "Pricing and WhatsApp onboarding for Airi.chat",
        "WhatsApp setup steps",
      ],
      resolvedNeeds: ["Initial greeting"],
      hasUnresolvedNeed: true,
      dominantLanguage: "ru",
      latestMessage: "Здравствуйте! Хочу узнать об Airi.chat и WhatsApp",
      channel: "whatsapp",
      hasActiveScenario: true,
      hasRetrievedContext: true,
      workspacePersona: {
        displayName: "Airi",
        tone: "calm and direct",
        topicRestrictions: ["medical advice"],
      },
    });

    const promptBlock = context.toPromptBlock();

    expect(promptBlock).toContain("CURRENT CUSTOMER GOAL");
    expect(promptBlock).toContain("OPEN CUSTOMER NEEDS");
    expect(promptBlock).toContain("ALREADY ADDRESSED");
    expect(promptBlock).toContain("CONVERSATION CONTINUITY");
    expect(promptBlock).toContain("DOMINANT CUSTOMER LANGUAGE: ru");
    expect(promptBlock).toContain("TOPIC RESTRICTIONS");
    expect(promptBlock).toContain("Stay aligned with the active scenario");
    expect(promptBlock).toContain("Answer with grounded facts");
    expect(promptBlock).not.toContain("CONVERSATION PHASE");
  });

  it("falls back to the latest message theme when no goal exists yet", () => {
    const context = buildAgentContext({
      latestMessage: "Can you tell me more about pricing?",
      hasRetrievedContext: false,
    });

    expect(context.toPromptBlock()).toContain("LATEST CUSTOMER MESSAGE THEME");
    expect(context.toPromptBlock()).toContain(
      "Clarify or state limits honestly"
    );
  });
});

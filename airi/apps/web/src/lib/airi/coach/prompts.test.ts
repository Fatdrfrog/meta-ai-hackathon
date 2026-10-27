import { buildAnthropicMessageParams } from "@/lib/ai/anthropic-messages";

import {
  buildCoachSystemPrompt,
  buildCoachUserPrompt,
  COACH_RESPONSE_SCHEMA,
  COACH_TIP_TYPES,
} from "./prompts";

describe("coach prompts", () => {
  it("uses display language names and dual-language field rules", () => {
    const prompt = buildCoachSystemPrompt({
      tipsLanguage: "ru",
      customerLanguage: "kz",
      conversationContext: {
        stage: "middle",
        priority: "high",
        customerSentiment: "frustrated",
        riskLevel: 2,
      },
      alreadyGreeted: true,
    });

    expect(prompt).toContain("Russian (ISO ru)");
    expect(prompt).toContain("Kazakh (ISO kz)");
    expect(prompt).toContain("tips.title, tips.suggestion, tips.reasoning");
    expect(prompt).toContain("suggestedEdit");
    expect(prompt).toContain("ESCALATION RISK");
    expect(prompt).toContain("GREETING POLICY");
    expect(prompt).toContain("Return JSON only");
  });

  it("keeps single-language instructions when tips and customer match", () => {
    const prompt = buildCoachSystemPrompt({
      tipsLanguage: "en",
      customerLanguage: "en",
      alreadyGreeted: false,
    });

    expect(prompt).toContain("English (ISO en)");
    expect(prompt).not.toContain("ESCALATION RISK");
    expect(prompt).not.toContain("GREETING POLICY");
    expect(prompt).toContain(
      "Write tips.title, tips.suggestion, tips.reasoning, and suggestedEdit"
    );
  });

  it("builds labeled user sections and task suffix", () => {
    const prompt = buildCoachUserPrompt({
      knowledgeBlock: "Q/A SNIPPET:\nQ: hours?\nA: 9-18",
      conversationWindow: "Customer: When are you open?\nAgent: ...",
      agentDraft: "We open tomorrow.",
    });

    expect(prompt).toContain("REFERENCE CONTEXT");
    expect(prompt).toContain("RECENT CONVERSATION");
    expect(prompt).toContain("MANAGER DRAFT TO ANALYZE");
    expect(prompt).toContain("We open tomorrow.");
    expect(prompt).toContain("JSON only.");
  });

  it("exports a Vertex-compatible response schema", () => {
    expect(COACH_RESPONSE_SCHEMA.type).toBe("OBJECT");
    expect(COACH_RESPONSE_SCHEMA.required).toEqual(["tips", "suggestedEdit"]);
    expect(
      COACH_RESPONSE_SCHEMA.properties.tips.items.properties.type.enum
    ).toContain("empathy");
  });

  it("converts to a Claude structured-output schema so replies stay raw JSON", () => {
    const before = JSON.stringify(COACH_RESPONSE_SCHEMA);
    const params = buildAnthropicMessageParams({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "system", content: "coach" },
        { role: "user", content: "draft" },
      ],
      forceJson: true,
      generationConfig: { responseSchema: COACH_RESPONSE_SCHEMA },
    });

    expect(params.output_config?.format).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        required: ["tips", "suggestedEdit"],
        additionalProperties: false,
        properties: {
          tips: {
            type: "array",
            items: {
              type: "object",
              required: [
                "title",
                "suggestion",
                "type",
                "confidence",
                "reasoning",
              ],
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                suggestion: { type: "string" },
                type: { type: "string", enum: [...COACH_TIP_TYPES] },
                confidence: { type: "number" },
                reasoning: { type: "string" },
              },
            },
          },
          suggestedEdit: { type: "string" },
        },
      },
    });
    expect(JSON.stringify(COACH_RESPONSE_SCHEMA)).toBe(before);
  });
});

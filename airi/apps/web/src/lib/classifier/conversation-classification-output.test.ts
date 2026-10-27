import {
  buildConversationClassificationPrompt,
  parseConversationClassificationOutput,
} from "@/lib/classifier/conversation-classification-output";
import {
  CLASSIFICATION_ENTITY_TYPES,
  CLASSIFICATION_KEY_MOMENT_TYPES,
} from "@/lib/classifier/conversation-analysis-types";
import { InvalidClassificationOutputError } from "@/lib/classifier/conversation-classification-errors";

type MutableClassificationOutput = Record<string, unknown> & {
  category: unknown;
  priority: unknown;
  sentiment: unknown;
  summary: unknown;
  action: unknown;
  tags: unknown;
  confidence: Record<string, unknown>;
  extracted_entities: Array<Record<string, unknown>>;
  key_moments: Array<Record<string, unknown>>;
  agent_performance_scorecard?: Record<string, unknown>;
  is_best_practice: unknown;
};

function validOutput(): MutableClassificationOutput {
  return {
    category: "Support",
    priority: "high",
    sentiment: "negative",
    summary: "Customer cannot access the account.",
    action: "Reset the customer account access.",
    tags: ["account access"],
    confidence: { category: 0.91, priority: 0.8, sentiment: 0.75 },
    extracted_entities: [{ type: "product", value: "Premium" }],
    key_moments: [{ type: "objection", message_index: 1 }],
    agent_performance_scorecard: {
      empathy_score: 8,
      clarity_score: 9,
      script_adherence_score: 7,
      resolution_efficiency_score: 8,
      overall_comment: "Clear and empathetic response.",
    },
    is_best_practice: true,
  };
}

function expectInvalid(
  mutate: (value: MutableClassificationOutput) => void,
  path: string
) {
  const value = structuredClone(validOutput()) as MutableClassificationOutput;
  mutate(value);
  expect(() =>
    parseConversationClassificationOutput(value, {
      taxonomyLabels: ["Support", "Other"],
      presentedMessageCount: 3,
    })
  ).toThrow(
    expect.objectContaining({
      name: "InvalidClassificationOutputError",
      code: "invalid_classification_output",
      path,
    })
  );
}

describe("conversation classification output", () => {
  it("accepts bounded payment evidence in the existing classification response", () => {
    const payment_evidence = [
      { message_index: 0, kind: "receipt", amount: 45000, currency: "KZT" },
    ];
    expect(
      parseConversationClassificationOutput(
        { ...validOutput(), payment_evidence },
        {
          taxonomyLabels: ["Support", "Other"],
          presentedMessageCount: 3,
        }
      )
    ).toHaveProperty("payment_evidence", payment_evidence);
  });

  it.each([
    [{ message_index: 3, kind: "receipt", amount: 45000, currency: "KZT" }],
    [{ message_index: 0, kind: "settled", amount: 45000, currency: "KZT" }],
    [{ message_index: 0, kind: "receipt", amount: -10, currency: "KZT" }],
    [{ message_index: 0, kind: "receipt", amount: 45000, currency: "tenge" }],
    "paid",
  ])(
    "drops malformed optional payment evidence without retrying classification: %j",
    payment_evidence => {
      expect(
        parseConversationClassificationOutput(
          { ...validOutput(), payment_evidence },
          {
            taxonomyLabels: ["Support", "Other"],
            presentedMessageCount: 3,
          }
        )
      ).toHaveProperty("payment_evidence", []);
    }
  );

  it("builds one canonical language-aware prompt with an optional repair reason", () => {
    const messages = buildConversationClassificationPrompt({
      businessContext: {
        workspaceId: "workspace-1",
        companyId: "company-1",
        businessContext: "premium retail support",
        airiLanguage: "en",
        source: { id: "source-1", type: "whatsapp" },
      },
      conversationContext: "Channel: whatsapp",
      textForAnalysis: "Message 0: [Human] Customer: Help",
      taxonomy: {
        id: "taxonomy-1",
        workspaceId: "workspace-1",
        labels: ["Support", "Other"],
        guidelines: "Choose the dominant intent.",
        fewShots: [{ text: "Cannot log in", label: "Support" }],
        confidenceThreshold: 0.8,
      },
      existingCategory: "Support",
      presentedMessageCount: 1,
      paymentEvidenceMessageIndices: [0],
      repairReason: "Previous output omitted confidence.sentiment.",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0].content).toContain("English");
    expect(messages[0].content).toContain("Return one JSON object");
    expect(messages[0].content).toContain(
      "Optional keys: agent_performance_scorecard, payment_evidence"
    );
    expect(messages[1].content).toContain("Also return payment_evidence");
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(messages[1].content).toContain("premium retail support");
    expect(messages[1].content).toContain("Existing category: Support");
    expect(messages[1].content).toContain("Presented message count: 1");
    expect(messages[1].content).toContain(
      "Repair reason: Previous output omitted confidence.sentiment."
    );
  });

  it("names every enumerated value and key the parser enforces", () => {
    const [, user] = buildConversationClassificationPrompt({
      businessContext: {
        workspaceId: "workspace-1",
        companyId: "company-1",
        businessContext: "language school",
        airiLanguage: "ru",
        source: null,
      },
      conversationContext: "Channel: whatsapp",
      textForAnalysis: "Message 0: [Human] Customer: Сколько стоит курс?",
      taxonomy: {
        id: "taxonomy-1",
        workspaceId: "workspace-1",
        labels: ["Sales", "Other"],
        guidelines: "Choose the dominant intent.",
        fewShots: [],
        confidenceThreshold: 0.8,
      },
      existingCategory: null,
      presentedMessageCount: 1,
    });
    const keyMomentRule = user.content
      .split("\n")
      .find(line => line.startsWith("- key_moments"));
    const entityRule = user.content
      .split("\n")
      .find(line => line.startsWith("- extracted_entities"));
    const scorecardRule = user.content
      .split("\n")
      .find(line => line.startsWith("- agent_performance_scorecard"));

    // Claude invents key-moment types and scorecard keys the prompt doesn't name.
    for (const type of CLASSIFICATION_KEY_MOMENT_TYPES) {
      expect(keyMomentRule).toContain(type);
    }
    for (const type of CLASSIFICATION_ENTITY_TYPES) {
      expect(entityRule).toContain(type);
    }
    for (const key of Object.keys(validOutput().agent_performance_scorecard!)) {
      expect(scorecardRule).toContain(key);
    }
  });

  it("accepts only the exact strict result and preserves raw confidence", () => {
    expect(
      parseConversationClassificationOutput(validOutput(), {
        taxonomyLabels: ["Support", "Other"],
        presentedMessageCount: 3,
      })
    ).toEqual(validOutput());
  });

  it("accepts a response without the optional scorecard", () => {
    const value = validOutput();
    delete value.agent_performance_scorecard;
    expect(
      parseConversationClassificationOutput(value, {
        taxonomyLabels: ["Support", "Other"],
        presentedMessageCount: 3,
      })
    ).not.toHaveProperty("agent_performance_scorecard");
  });

  it.each([
    "category",
    "priority",
    "sentiment",
    "summary",
    "action",
    "tags",
    "confidence",
    "extracted_entities",
    "key_moments",
    "is_best_practice",
  ])("rejects a missing required %s key", key => {
    expectInvalid(value => delete value[key], key);
  });

  it("rejects unknown top-level keys", () => {
    expectInvalid(value => {
      value.status = "ready";
    }, "$root");
  });

  it.each([
    [
      "category",
      (value: MutableClassificationOutput) => (value.category = "support"),
    ],
    [
      "priority",
      (value: MutableClassificationOutput) => (value.priority = "HIGH"),
    ],
    [
      "sentiment",
      (value: MutableClassificationOutput) => (value.sentiment = "mixed"),
    ],
    [
      "summary",
      (value: MutableClassificationOutput) => (value.summary = " summary"),
    ],
    [
      "summary",
      (value: MutableClassificationOutput) =>
        (value.summary = "x".repeat(221)),
    ],
    [
      "action",
      (value: MutableClassificationOutput) => (value.action = " "),
    ],
    [
      "action",
      (value: MutableClassificationOutput) =>
        (value.action = "x".repeat(221)),
    ],
    [
      "tags",
      (value: MutableClassificationOutput) => (value.tags = "tag"),
    ],
    [
      "tags",
      (value: MutableClassificationOutput) =>
        (value.tags = Array(6).fill("tag")),
    ],
    [
      "tags[0]",
      (value: MutableClassificationOutput) => (value.tags = [" tag"]),
    ],
    [
      "tags[0]",
      (value: MutableClassificationOutput) =>
        (value.tags = ["x".repeat(65)]),
    ],
    [
      "confidence",
      (value: MutableClassificationOutput) => (value.confidence.extra = 1),
    ],
    [
      "confidence.category",
      (value: MutableClassificationOutput) =>
        (value.confidence.category = NaN),
    ],
    [
      "confidence.priority",
      (value: MutableClassificationOutput) =>
        (value.confidence.priority = -0.1),
    ],
    [
      "confidence.sentiment",
      (value: MutableClassificationOutput) =>
        (value.confidence.sentiment = 1.1),
    ],
    [
      "extracted_entities",
      (value: MutableClassificationOutput) =>
        (value.extracted_entities = Array(21).fill({
          type: "product",
          value: "x",
        })),
    ],
    [
      "extracted_entities[0]",
      (value: MutableClassificationOutput) =>
        (value.extracted_entities[0].extra = true),
    ],
    [
      "extracted_entities[0].type",
      (value: MutableClassificationOutput) =>
        (value.extracted_entities[0].type = "person"),
    ],
    [
      "extracted_entities[0].value",
      (value: MutableClassificationOutput) =>
        (value.extracted_entities[0].value = " value"),
    ],
    [
      "extracted_entities[0].value",
      (value: MutableClassificationOutput) =>
        (value.extracted_entities[0].value = "x".repeat(257)),
    ],
    [
      "key_moments",
      (value: MutableClassificationOutput) =>
        (value.key_moments = Array(21).fill({
          type: "objection",
          message_index: 0,
        })),
    ],
    [
      "key_moments[0]",
      (value: MutableClassificationOutput) =>
        (value.key_moments[0].extra = true),
    ],
    [
      "key_moments[0].type",
      (value: MutableClassificationOutput) =>
        (value.key_moments[0].type = "unknown"),
    ],
    [
      "key_moments[0].message_index",
      (value: MutableClassificationOutput) =>
        (value.key_moments[0].message_index = 1.5),
    ],
    [
      "key_moments[0].message_index",
      (value: MutableClassificationOutput) =>
        (value.key_moments[0].message_index = 3),
    ],
    [
      "agent_performance_scorecard",
      (value: MutableClassificationOutput) =>
        (value.agent_performance_scorecard!.extra = true),
    ],
    [
      "agent_performance_scorecard.empathy_score",
      (value: MutableClassificationOutput) =>
        (value.agent_performance_scorecard!.empathy_score = 0),
    ],
    [
      "agent_performance_scorecard.clarity_score",
      (value: MutableClassificationOutput) =>
        (value.agent_performance_scorecard!.clarity_score = Infinity),
    ],
    [
      "agent_performance_scorecard.overall_comment",
      (value: MutableClassificationOutput) =>
        (value.agent_performance_scorecard!.overall_comment = "x".repeat(501)),
    ],
    [
      "is_best_practice",
      (value: MutableClassificationOutput) =>
        (value.is_best_practice = "true"),
    ],
  ])("rejects invalid %s without coercion or clamping", (path, mutate) => {
    expectInvalid(mutate, path);
  });

  it("reports the output error class for a non-object payload", () => {
    expect(() =>
      parseConversationClassificationOutput("{}", {
        taxonomyLabels: ["Support"],
        presentedMessageCount: 1,
      })
    ).toThrow(InvalidClassificationOutputError);
  });
});

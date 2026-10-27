jest.mock("@icecore/airi-runtime/mongoose", () => {
  const connectDB = jest
    .fn()
    .mockRejectedValue(new Error("Unexpected database access"));
  return { __esModule: true, default: connectDB, connectDB };
});

import {
  buildGenerativeAIInboundCandidate,
  buildGenerativeAIInboundCandidateForTurn,
  buildScenarioCrmContextBlock,
  resolveScenarioWhatsAppCta,
} from "@/lib/airi/reply/runtime/scenario";
import {
  buildScenarioRevisionFingerprintFromRecord,
  evaluateScenarioFlow,
} from "@/lib/airi/scenario/scenario-runtime";
import { compileScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import { createClientMessageTriggerData } from "@icecore/scenario-contracts";

function currentClassification(category: string) {
  return {
    classification: { category },
    is_classified: true,
    classification_revision: 3,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 3,
      appliedRevision: 3,
    },
    classification_meta: {
      source_revision: 3,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-3",
    },
  };
}

describe("buildScenarioCrmContextBlock", () => {
  const scenarioRuntime = { includeCustomerProfile: true } as never;

  it.each([
    ["stale", { classification: { category: "lead_generation" } }],
    [
      "partial",
      {
        classification: { category: "lead_generation" },
        is_classified: true,
        classification_revision: 3,
      },
    ],
  ])("prints unknown for %s classification", (_, conversation) => {
    expect(
      buildScenarioCrmContextBlock({
        scenarioRuntime,
        conversation: conversation as never,
      })
    ).toContain("- Classification: unknown");
  });

  it("prints the current classification category", () => {
    expect(
      buildScenarioCrmContextBlock({
        scenarioRuntime,
        conversation: currentClassification("lead_generation") as never,
      })
    ).toContain("- Classification: lead_generation");
  });
});

describe("resolveScenarioWhatsAppCta", () => {
  it("derives compact WhatsApp Flow response field metadata, with field types, from the action config", () => {
    const result = resolveScenarioWhatsAppCta({
      channel: "whatsapp",
      targetLanguage: "en",
      scenarioRuntime: {
        actionType: "reply",
        actionReplyCtaType: "flow",
        actionReplyCtaFlowId: "flow-1",
        actionFlowConfig: {
          screens: [
            {
              id: "SCREEN_A",
              title: "Choose preferences",
              fields: [
                {
                  id: "911CBF",
                  label: "Product",
                  helperText: "Pick one",
                  fieldType: "RadioButtonsGroup",
                  options: [{ id: "opt_medal", title: "Medal hanger" }],
                },
              ],
            },
          ],
        },
      } as never,
    });

    expect(result.whatsappFlowCta).toEqual(
      expect.objectContaining({
        flowId: "flow-1",
        responseFieldMetadata: [
          {
            id: "911CBF",
            label: "Product",
            helperText: "Pick one",
            screenTitle: "Choose preferences",
            options: [{ id: "opt_medal", title: "Medal hanger" }],
            fieldType: "RadioButtonsGroup",
          },
        ],
      })
    );
    expect(
      (result.whatsappFlowCta as Record<string, unknown>)?.flowConfig
    ).toBeUndefined();
  });

  it("does not project stale legacy CTA data beside a canonical service owner", () => {
    expect(
      resolveScenarioWhatsAppCta({
        channel: "whatsapp",
        scenarioRuntime: {
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "text",
              body: { mode: "fixed", text: "Canonical" },
            },
          },
          actionReplyCtaType: "flow",
          actionReplyCtaFlowId: "stale-flow",
          actionReplyCtaLabel: "Stale CTA",
          actionLinkUrls: ["https://example.com/stale"],
        } as never,
      })
    ).toEqual({});
  });

  it("projects the managed Flow id and its source binding for delivery", () => {
    const result = resolveScenarioWhatsAppCta({
      channel: "whatsapp",
      scenarioRuntime: {
        actionType: "reply",
        actionReplyCtaType: "flow",
        actionReplyCtaFlowId: "stale-flow-id",
        actionFlowConfig: {
          templateId: "local-flow",
          screens: [],
          ctaText: "Open flow",
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-a",
            wabaId: "waba-a",
            contentRevision: 2,
            contentDigest: "digest-2",
            flowId: "managed-flow-id",
            providerStatus: "PUBLISHED",
          },
        },
      } as never,
    });

    expect(result.whatsappFlowCta).toEqual(
      expect.objectContaining({
        flowId: "managed-flow-id",
        managedSourceId: "source-a",
        managedWabaId: "waba-a",
      })
    );
  });

  it("projects a provider-referenced Flow and its source binding for delivery", () => {
    const result = resolveScenarioWhatsAppCta({
      channel: "whatsapp",
      scenarioRuntime: {
        actionType: "reply",
        actionReplyCtaType: "flow",
        actionReplyCtaFlowId: "stale-flow-id",
        actionFlowConfig: {
          templateId: "provider-reference",
          flowNavigationMode: "data_endpoint",
          screens: [{ id: "ONLY", title: "Only", fields: [] }],
          ctaText: "Open flow",
          providerReference: {
            flowId: "provider-flow-id",
            sourceId: "source-a",
            wabaId: "waba-a",
            providerStatus: "PUBLISHED",
            dataApiVersion: "3.0",
          },
        },
      } as never,
    });

    expect(result.whatsappFlowCta).toEqual(
      expect.objectContaining({
        flowId: "provider-flow-id",
        managedSourceId: "source-a",
        managedWabaId: "waba-a",
        flowActionType: "data_exchange",
      })
    );
  });

  it("does not send a stale legacy Flow id when the managed Flow is not published", () => {
    expect(
      resolveScenarioWhatsAppCta({
        channel: "whatsapp",
        scenarioRuntime: {
          actionType: "reply",
          actionReplyCtaType: "flow",
          actionReplyCtaFlowId: "stale-flow-id",
          actionFlowConfig: {
            templateId: "local-flow",
            screens: [],
            ctaText: "Open flow",
            managedProvisioning: {
              operationId: "operation-1",
              sourceId: "source-a",
              wabaId: "waba-a",
              contentRevision: 2,
              contentDigest: "digest-2",
              flowId: "managed-flow-id",
              providerStatus: "BLOCKED",
            },
          },
        } as never,
      })
    ).toEqual({});
  });
});

describe("generative AI runtime projection", () => {
  it("projects only the owned hydrated message fields used by strict matching", () => {
    expect(
      buildGenerativeAIInboundCandidate({
        _id: "message-1",
        text: "  product reveal  ",
        mediaType: "image",
        whatsappMediaId: "media-1",
        mimeType: "image/jpeg",
        fileName: "source.jpg",
        imageUrl: "https://temporary.example/source.jpg",
        rawSourcePayload: { secret: "must-not-leak" },
      } as never)
    ).toEqual({
      messageId: "message-1",
      kind: "image",
      textOrCaption: "product reveal",
      whatsappMediaId: "media-1",
      declaredMimeType: "image/jpeg",
      fileName: "source.jpg",
    });
  });

  it("projects no generative inbound for a synthetic turn", () => {
    expect(buildGenerativeAIInboundCandidate(null)).toBeNull();
    const message = {
      _id: "message-1",
      text: "should not be classified",
      mediaType: "text",
      whatsappMediaId: null,
      mimeType: null,
      fileName: null,
    } as never;
    expect(
      buildGenerativeAIInboundCandidateForTurn({
        persistedMessage: message,
        direction: "inbound",
        synthetic: true,
        proactive: false,
      })
    ).toBeNull();
    expect(
      buildGenerativeAIInboundCandidateForTurn({
        persistedMessage: message,
        direction: "inbound",
        synthetic: false,
        proactive: true,
      })
    ).toBeNull();
  });

  it("admits text personalization to an image action with saved references", () => {
    const config = { version: 1 as const, mode: "text_to_image" as const, prompt: "Medal preview", image: {
      provider: "google" as const, sourceId: "11111111-1111-4111-8111-111111111111",
      modelId: "gemini-3.1-flash-image", aspectRatio: "16:9" as const,
      referenceImages: [], includeInboundText: true,
    } };
    const graph = compileScenarioGraph([
      { id: "trigger", data: createClientMessageTriggerData() },
      { id: "generate", data: { kind: "action", actionType: "generative_ai", actionGenerativeAIConfig: config } },
    ], [{ source: "trigger", target: "generate" }]);
    const inbound = { messageId: "message-1", kind: "text", textOrCaption: "Аяла, gymnastics", whatsappMediaId: null, declaredMimeType: null, fileName: null };
    const match = evaluateScenarioFlow({ graph, conversation: {} as never, channel: "whatsapp", matchedTriggerNodeId: "trigger", generativeInbound: inbound });
    expect(match?.generativeAI).toEqual({ config, input: { status: "compatible", input: inbound } });
    const synthetic = evaluateScenarioFlow({ graph, conversation: {} as never, channel: "whatsapp", matchedTriggerNodeId: "trigger" });
    expect(synthetic?.generativeAI?.input).toEqual({ status: "waiting_for_compatible_input", expectedInputKind: "text" });
  });

  it("admits a voice answer that completed a collector to the image action it resumes", () => {
    const config = {
      version: 1 as const,
      mode: "text_to_image" as const,
      prompt: "Medal preview",
      image: {
        provider: "google" as const,
        sourceId: "11111111-1111-4111-8111-111111111111",
        modelId: "gemini-3.1-flash-image",
        aspectRatio: "16:9" as const,
        referenceImages: [],
        includeInboundText: true,
      },
    };
    const graph = compileScenarioGraph(
      [
        { id: "trigger", data: createClientMessageTriggerData() },
        {
          id: "generate",
          data: {
            kind: "action",
            actionType: "generative_ai",
            actionGenerativeAIConfig: config,
          },
        },
      ],
      [{ source: "trigger", target: "generate" }]
    );
    const voice = {
      messageId: "message-1",
      kind: "audio",
      textOrCaption: "[audio attachment]",
      whatsappMediaId: "wa-audio-1",
      declaredMimeType: "audio/ogg",
      fileName: null,
    };
    const evaluate = (
      inbound: typeof voice & { promptInputAnswerText?: string }
    ) =>
      evaluateScenarioFlow({
        graph,
        conversation: {} as never,
        channel: "whatsapp",
        matchedTriggerNodeId: "trigger",
        generativeInbound: inbound,
      })?.generativeAI?.input;

    expect(evaluate(voice)).toEqual({
      status: "wrong_type",
      expectedInputKind: "text",
    });
    expect(
      evaluate({ ...voice, promptInputAnswerText: "Аяла, gymnastics" })
    ).toEqual({
      status: "compatible",
      input: {
        messageId: "message-1",
        kind: "text",
        textOrCaption: "Аяла, gymnastics",
        whatsappMediaId: null,
        declaredMimeType: null,
        fileName: null,
      },
    });
  });

  it("uses the text answers of a template's Flow as the generative input", () => {
    const graph = compileScenarioGraph(
      [
        { id: "trigger", data: createClientMessageTriggerData() },
        {
          id: "template",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "medal_details",
            actionFlowConfig: {
              templateId: "details",
              ctaText: "Open",
              screens: [
                {
                  id: "FORM",
                  title: "Details",
                  fields: [
                    { id: "name", label: "Name", fieldType: "TextInput" },
                    { id: "sport", label: "Sport", fieldType: "TextArea" },
                  ],
                },
              ],
            },
          },
        },
        {
          id: "generate",
          data: {
            kind: "action",
            actionType: "generative_ai",
            actionGenerativeAIConfig: {
              version: 1,
              mode: "text_to_video",
              prompt: "Film {{input.name}} playing {{input.sport}}",
            },
          },
        },
      ],
      [
        { source: "trigger", target: "template" },
        { source: "template", target: "generate" },
      ]
    );

    const match = evaluateScenarioFlow({
      graph,
      conversation: {} as never,
      channel: "whatsapp",
      preferredActionNodeId: "template",
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: JSON.stringify({
        name: "Aya",
        sport: "judo",
        flow_token: "flow_1",
      }),
      generativeInbound: {
        messageId: "message-1",
        kind: "interactive",
        textOrCaption: "[Flow response]",
        whatsappMediaId: null,
        declaredMimeType: null,
        fileName: null,
      },
    });

    expect(match?.selectedAction.id).toBe("generate");
    expect(match?.generativeAI?.input).toMatchObject({
      status: "compatible",
      input: { kind: "text", textOrCaption: "Name: Aya\nSport: judo" },
    });
  });

  it("returns a positive waiting disposition for incompatible input", () => {
    const graph = compileScenarioGraph(
      [
        {
          id: "trigger",
          data: createClientMessageTriggerData(),
        },
        {
          id: "generate",
          data: {
            kind: "action",
            actionType: "generative_ai",
            actionGenerativeAIConfig: {
              version: 1,
              mode: "image_to_video",
              prompt: "Animate this image",
            },
          },
        },
      ],
      [{ source: "trigger", target: "generate" }]
    );

    const match = evaluateScenarioFlow({
      graph,
      conversation: {} as never,
      channel: "whatsapp",
      matchedTriggerNodeId: "trigger",
      generativeInbound: {
        messageId: "message-1",
        kind: "text",
        textOrCaption: "not an image",
        whatsappMediaId: null,
        declaredMimeType: null,
        fileName: null,
      },
    });

    expect(match?.selectedAction.id).toBe("generate");
    expect(match?.generativeAI).toEqual({
      config: {
        version: 1,
        mode: "image_to_video",
        prompt: "Animate this image",
      },
      input: { status: "wrong_type", expectedInputKind: "image" },
    });
  });

  it("fingerprints the raw activated nodes and edges", () => {
    const baseline = buildScenarioRevisionFingerprintFromRecord({
      nodes: [{ id: "trigger" }, { id: "generate" }],
      edges: [{ source: "trigger", target: "generate" }],
    });
    const changed = buildScenarioRevisionFingerprintFromRecord({
      nodes: [{ id: "trigger" }, { id: "generate", prompt: "changed" }],
      edges: [{ source: "trigger", target: "generate" }],
    });

    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(changed).not.toBe(baseline);
  });
});

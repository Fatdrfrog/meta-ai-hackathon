import {
  buildScenarioWhatsAppServiceFlowSelectionPatch,
  buildWhatsAppServiceMessagePatch,
  getScenarioWhatsAppServiceMessageAuthoringTexts,
  projectScenarioWhatsAppServiceMessagePresentation,
  resolveScenarioWhatsAppInteractiveFlowConfig,
  resolveScenarioWhatsAppServiceFlowConfig,
  resolveScenarioWhatsAppServiceMessage,
  scenarioActionAwaitsWhatsAppFlowReply,
  whatsappTemplateAwaitingFlowReply,
} from "@/lib/scenarios/whatsapp-service-message";
import {
  type ScenarioNodeData,
  type ScenarioWhatsAppServiceMessage,
} from "@icecore/scenario-contracts";

function action(patch: Partial<ScenarioNodeData> = {}): ScenarioNodeData {
  return { kind: "action", ...patch };
}

const canonical: ScenarioWhatsAppServiceMessage = {
  version: 1,
  message: {
    kind: "text",
    body: { mode: "fixed", text: "Canonical" },
    previewUrl: true,
  },
};

describe("resolveScenarioWhatsAppServiceMessage", () => {
  it("uses supported canonical data without consulting generic reply fields", () => {
    expect(
      resolveScenarioWhatsAppServiceMessage(
        action({
          actionType: "reply",
          actionReplyChannel: "whatsapp",
          actionReplyText: "Generic reply",
          actionWhatsAppServiceMessage: canonical,
        })
      )
    ).toEqual({ status: "canonical", value: canonical });
  });

  it("fails closed on a future canonical version", () => {
    expect(
      resolveScenarioWhatsAppServiceMessage(
        action({
          actionWhatsAppServiceMessage: {
            version: 2,
            message: { kind: "text", body: { mode: "fixed", text: "Future" } },
          } as unknown as ScenarioWhatsAppServiceMessage,
        })
      )
    ).toEqual({ status: "unsupported_version", version: 2 });
  });

  it("does not synthesize a service message from generic WhatsApp fields", () => {
    expect(
      resolveScenarioWhatsAppServiceMessage(
        action({
          actionType: "reply",
          actionReplyChannel: "whatsapp",
          actionReplyText: "Generic reply",
          actionReplyCtaType: "flow",
          actionReplyCtaFlowId: "flow-1",
        })
      )
    ).toEqual({ status: "not_applicable" });
  });

  it("never adapts template-owned Flows", () => {
    expect(
      resolveScenarioWhatsAppServiceMessage(
        action({
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "approved_template",
          actionFlowConfig: {
            templateId: "flow-1",
            metaFlowId: "flow-1",
            ctaText: "Open",
            screens: [],
          },
        })
      )
    ).toEqual({ status: "not_applicable" });
  });
});

describe("canonical WhatsApp service-message helpers", () => {
  it("writes the canonical owner as a reply and clears incompatible generic and template fields", () => {
    const patch = buildWhatsAppServiceMessagePatch(canonical);

    expect(patch).toMatchObject({
      actionType: "reply",
      actionWhatsAppServiceMessage: canonical,
    });
    expect(patch.actionReplyText).toBeUndefined();
    expect(patch.actionReplyChannel).toBeUndefined();
    expect(patch.actionFlowConfig).toBeUndefined();
    expect(patch.actionWhatsAppTemplateId).toBeUndefined();
  });

  it("updates only a canonical service Flow and leaves template Flow ownership separate", () => {
    const flowConfig = {
      templateId: "flow-1",
      metaFlowId: "flow-1",
      ctaText: "Open",
      screens: [],
    };
    const serviceNode = action({
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Open" },
          flowConfig,
        },
      },
    });

    expect(resolveScenarioWhatsAppServiceFlowConfig(serviceNode)).toEqual(
      flowConfig
    );
    expect(resolveScenarioWhatsAppInteractiveFlowConfig(serviceNode)).toEqual(
      flowConfig
    );
    expect(
      buildScenarioWhatsAppServiceFlowSelectionPatch(serviceNode, {
        ...flowConfig,
        ctaText: "Continue",
      })
    ).toMatchObject({
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        message: { kind: "flow", flowConfig: { ctaText: "Continue" } },
      },
    });

    const templateNode = action({
      actionType: "whatsapp_template",
      actionFlowConfig: flowConfig,
    });
    expect(resolveScenarioWhatsAppInteractiveFlowConfig(templateNode)).toEqual(
      flowConfig
    );
    expect(
      buildScenarioWhatsAppServiceFlowSelectionPatch(templateNode, flowConfig)
    ).toBeNull();
  });

  it("projects canonical authoring and presentation text", () => {
    const serviceMessage: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "contacts",
        contacts: [{ formattedName: "Airi", phone: "+77012345678" }],
      },
    };

    expect(
      getScenarioWhatsAppServiceMessageAuthoringTexts(serviceMessage)
    ).toEqual(["Airi", "+77012345678"]);
    expect(
      projectScenarioWhatsAppServiceMessagePresentation(
        action({ actionWhatsAppServiceMessage: serviceMessage })
      )
    ).toEqual({ title: "Airi", previewText: "+77012345678" });
  });

  it("presents the managed Flow id instead of stale legacy metadata", () => {
    expect(
      projectScenarioWhatsAppServiceMessagePresentation(
        action({
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "flow",
              body: { mode: "fixed", text: "Complete the form" },
              flowConfig: {
                templateId: "local-flow",
                screens: [],
                ctaText: "Open flow",
                metaFlowId: "stale-meta-flow-id",
                managedProvisioning: {
                  operationId: "operation-1",
                  sourceId: "source-1",
                  wabaId: "waba-1",
                  contentRevision: 2,
                  contentDigest: "digest-2",
                  flowId: "managed-flow-id",
                  providerStatus: "PUBLISHED",
                },
              },
            },
          },
        })
      )
    ).toEqual({ title: "managed-flow-id", previewText: "Complete the form" });
  });
});

describe("scenarioActionAwaitsWhatsAppFlowReply", () => {
  const flowConfig = {
    templateId: "flow-1",
    metaFlowId: "meta-flow-1",
    ctaText: "Open",
    screens: [],
  };
  const flowButtonTemplate = (patch: Partial<ScenarioNodeData> = {}) =>
    action({
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "form",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Fill" },
        {
          type: "BUTTONS",
          buttons: [{ type: "FLOW", text: "Open", flow_id: "meta-flow-1" }],
        },
      ],
      actionReplyCtaType: "flow",
      ...patch,
    });

  it.each<[string, ScenarioNodeData]>([
    [
      "a chat-message Flow",
      action({
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Open the form" },
            flowConfig,
          },
        },
      }),
    ],
    [
      "a template with its Flow",
      flowButtonTemplate({ actionFlowConfig: flowConfig }),
    ],
    [
      "a template with only a legacy Flow id",
      flowButtonTemplate({ actionReplyCtaFlowId: "meta-flow-1" }),
    ],
  ])("waits for the Flow of %s", (_label, data) => {
    expect(scenarioActionAwaitsWhatsAppFlowReply(data)).toBe(true);
  });

  it.each<[string, ScenarioNodeData]>([
    ["a template whose Flow button has no saved Flow", flowButtonTemplate()],
    [
      "a chat message",
      action({ actionType: "reply", actionWhatsAppServiceMessage: canonical }),
    ],
    [
      "a template without buttons",
      action({
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "hello",
        actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Hi" }],
      }),
    ],
  ])("does not wait for a Flow on %s", (_label, data) => {
    expect(scenarioActionAwaitsWhatsAppFlowReply(data)).toBe(false);
  });

  it("reads a template's Flow from its config or its legacy Flow id", () => {
    expect(
      whatsappTemplateAwaitingFlowReply(
        flowButtonTemplate({ actionReplyCtaFlowId: " meta-flow-1 " })
      )
    ).toBe(true);
    expect(
      whatsappTemplateAwaitingFlowReply(
        flowButtonTemplate({
          actionReplyCtaType: "none",
          actionFlowConfig: flowConfig,
        })
      )
    ).toBe(true);
    expect(whatsappTemplateAwaitingFlowReply(flowButtonTemplate())).toBe(false);
    expect(
      whatsappTemplateAwaitingFlowReply({
        kind: "logic",
        actionReplyCtaFlowId: "meta-flow-1",
      })
    ).toBe(false);
  });
});

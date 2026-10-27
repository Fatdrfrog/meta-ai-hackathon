import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import {
  normalizeFlowConfig,
  normalizeReplyCtaTypeForActionNode,
  normalizeReplyModeForActionNode,
} from "../normalization";

const managedProvisioning = {
  operationId: "operation-1",
  sourceId: "source-1",
  wabaId: "waba-1",
  contentRevision: 2,
  contentDigest: "digest-2",
  flowId: "managed-flow-id",
  providerStatus: "PUBLISHED" as const,
};

describe("WhatsApp Flow provider identity normalization", () => {
  it("projects the managed provider id over stale legacy metadata", () => {
    expect(
      normalizeFlowConfig({
        templateId: "local-flow",
        screens: [],
        ctaText: "Open flow",
        metaFlowId: "stale-meta-flow-id",
        managedProvisioning,
      })
    ).toEqual(
      expect.objectContaining({
        metaFlowId: "managed-flow-id",
      })
    );
  });

  it("recognizes a managed-only template Flow CTA", () => {
    expect(
      normalizeReplyCtaTypeForActionNode({
        nodeData: {
          kind: "action",
          actionType: "whatsapp_template",
          actionReplyCtaType: "flow",
          actionFlowConfig: {
            templateId: "local-flow",
            screens: [],
            ctaText: "Open flow",
            managedProvisioning,
          },
        },
        actionLinkUrls: [],
      })
    ).toBe("flow");
  });
});

describe("normalizeReplyModeForActionNode", () => {
  it("treats an undefined service-message clear marker as absent", () => {
    expect(
      normalizeReplyModeForActionNode({
        kind: "action",
        actionReplyMode: "ai",
        actionWhatsAppServiceMessage: undefined,
      })
    ).toBe("ai");
  });

  it.each([
    {
      label: "an invalid",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "future_kind" },
      },
    },
    {
      label: "a future-version",
      actionWhatsAppServiceMessage: {
        version: 2,
        message: {
          kind: "text",
          body: { mode: "ai", instruction: "Future AI body" },
        },
      },
    },
  ])(
    "does not reopen stale AI mode beside $label canonical service owner",
    ({ actionWhatsAppServiceMessage }) => {
      const nodeData = {
        kind: "action",
        actionReplyMode: "ai",
        actionReplyInstruction: "Stale AI instruction",
        actionWhatsAppServiceMessage,
      } as unknown as ScenarioNodeData;

      expect(normalizeReplyModeForActionNode(nodeData)).toBe("fixed");
    }
  );
});

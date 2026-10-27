import {
  createNodeFromPaletteItem,
  SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_IDS,
  SCENARIO_NODE_PALETTE,
} from "./node-palette";

const visiblePaletteItemIds = () =>
  SCENARIO_NODE_PALETTE.filter(item => !item.hiddenFromMenu).map(
    item => item.id
  );

describe("scenario node palette", () => {
  it("keeps the add menu focused on distinct visible node choices", () => {
    expect(visiblePaletteItemIds()).toEqual([
      "bulk-campaign",
      "trigger-incoming-message",
      "trigger-whatsapp-qr",
      "logic-if-else",
      "logic-recipient-column-split",
      "context-knowledge",
      "action-reply",
      "action-generative-ai",
    ]);
  });

  it("exposes incoming message and WhatsApp QR triggers in the palette", () => {
    expect(
      SCENARIO_NODE_PALETTE.filter(item => item.kind === "trigger")
    ).toEqual([
      expect.objectContaining({
        id: "trigger-incoming-message",
        defaults: {
          triggerConfig: {
            enabled: true,
            messageMatchMode: "any",
          },
        },
      }),
      expect.objectContaining({
        id: "trigger-whatsapp-qr",
        titleKey: "presetTriggerWhatsAppQr",
        defaults: {
          triggerConfig: {
            enabled: true,
            entryPointType: "whatsapp_qr",
            messageMatchMode: "any",
          },
        },
      }),
    ]);
    expect(
      SCENARIO_NODE_PALETTE.find(item => item.id === "trigger-incoming-message")
        ?.defaults
    ).not.toHaveProperty("triggerType");
  });

  it("keeps empty-canvas root as incoming message only", () => {
    expect(SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_IDS.trigger).toBe(
      "trigger-incoming-message"
    );
    expect(Object.values(SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_IDS)).not.toContain(
      "trigger-whatsapp-qr"
    );
  });

  it("creates a WhatsApp QR trigger with entryPointType whatsapp_qr", () => {
    const item = SCENARIO_NODE_PALETTE.find(
      paletteItem => paletteItem.id === "trigger-whatsapp-qr"
    );
    expect(item).toBeDefined();

    const node = createNodeFromPaletteItem(item!, { x: 10, y: 20 });

    expect(node.type).toBe("triggerNode");
    expect(node.data).toMatchObject({
      kind: "trigger",
      triggerConfig: {
        enabled: true,
        entryPointType: "whatsapp_qr",
        messageMatchMode: "any",
      },
    });
  });

  it("keeps persisted reply splits out of the authoring palette", () => {
    expect(SCENARIO_NODE_PALETTE.map(item => item.id)).not.toContain(
      "logic-post-action-condition"
    );
    expect(
      SCENARIO_NODE_PALETTE.some(
        item => item.defaults?.logicType === "post_action_condition"
      )
    ).toBe(false);
    expect(
      SCENARIO_NODE_PALETTE.find(item => item.id === "logic-if-else")
    ).toMatchObject({
      titleKey: "scenarioGate",
      defaults: { logicType: "audience_filter" },
    });
  });

  it("creates a bulk campaign root node from the bulk campaign palette item", () => {
    const item = SCENARIO_NODE_PALETTE.find(
      paletteItem => paletteItem.id === "bulk-campaign"
    );

    expect(item).toBeDefined();

    const node = createNodeFromPaletteItem(item!, { x: 120, y: 240 });

    expect(node.type).toBe("bulkNode");
    expect(node.position).toEqual({ x: 120, y: 240 });
    expect(node.data).toMatchObject({
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Bulk campaign",
        recipientSourceSummary: "No generated recipients yet",
        generationStatus: "idle",
        cohorts: [],
      },
    });
  });

  it("creates a canonical WhatsApp service reply from the palette", () => {
    const item = SCENARIO_NODE_PALETTE.find(
      paletteItem => paletteItem.id === "action-reply"
    );

    expect(item).toBeDefined();

    const node = createNodeFromPaletteItem(item!, { x: 0, y: 0 });

    expect(node.type).toBe("actionNode");
    expect(node.data).toMatchObject({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "" },
          previewUrl: true,
        },
      },
    });
  });

  it("creates a canonical Generative AI action from its dedicated palette item", () => {
    const item = SCENARIO_NODE_PALETTE.find(
      paletteItem => paletteItem.id === "action-generative-ai"
    );

    expect(item).toBeDefined();

    const node = createNodeFromPaletteItem(item!, { x: 12, y: 24 });

    expect(node.type).toBe("actionNode");
    expect(node.data).toEqual({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "",
      },
    });
  });
});

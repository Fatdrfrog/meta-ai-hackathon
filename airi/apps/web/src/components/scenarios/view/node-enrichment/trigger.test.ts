import { enrichTriggerNodeData } from "./trigger";

describe("enrichTriggerNodeData", () => {
  it("projects the canonical trigger editor and routes configuration deltas", () => {
    const updateTriggerConfigById = jest.fn();
    const openNodePickerFromHandle = jest.fn();
    const audienceOptions = {
      channels: [],
      customers: [],
      internalLabels: [],
      funnelStages: [],
      classificationCategories: [],
    };
    const enriched = enrichTriggerNodeData(
      "trigger-1",
      {
        kind: "trigger",
        triggerConfig: { enabled: true },
      },
      {
        callbacksRef: {
          current: {
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
            updateTriggerConfigById,
          },
        },
        openNodePickerFromHandle,
        audienceOptions,
        linkedConditionParentCountByNodeId: new Map([["trigger-1", 3]]),
        selectedNodeId: "trigger-1",
        sourceCapabilities: {
          hasMetaAds: true,
          hasWhatsApp: true,
          hasWhatsAppCoexistence: false,
        },
        whatsAppQrSummariesByNodeId: new Map(),
        openWhatsAppQrSettings: jest.fn(),
        t: (key: string) => key,
      } as never
    );

    enriched.uiOnTriggerConfigChange?.({ channelFilter: ["whatsapp"] });
    enriched.uiOnCreateNodeFromSourceHandle?.("right-source", 10, 20);

    expect(enriched.uiNodeLabel).toBe("presetTriggerIncoming");
    expect(enriched.uiAudienceOptions).toBe(audienceOptions);
    expect(enriched.uiTriggerConfig).toMatchObject({
      enabled: true,
      messageMatchMode: "any",
    });
    expect(updateTriggerConfigById).toHaveBeenCalledWith("trigger-1", {
      channelFilter: ["whatsapp"],
    });
    expect(openNodePickerFromHandle).toHaveBeenCalledWith(
      "trigger-1",
      "right-source",
      10,
      20
    );
  });

  it("keeps whatsapp_qr compact and wires the existing QR picker", () => {
    const picker = {
      selected: {
        entryPointId: "ep-1",
        placementName: "Lobby",
        status: "ACTIVE",
        hasCurrentCode: true,
        readiness: "ready" as const,
        reconcilePending: false,
        version: 1,
      },
      selectedEntryPointId: "ep-1",
      selectionResolved: true,
      targetScenarioId: "scenario-1",
      targetNodeId: "qr-1",
      targetScenarioName: "Scenario",
      managerHref: "/panel/w/workspace-1/messengers/whatsapp-qr",
      sourceLabels: {},
      loading: false,
      error: null,
      busy: false,
      loadOptions: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      onAssign: jest.fn().mockResolvedValue(undefined),
      onUnassign: jest.fn().mockResolvedValue(undefined),
      onRefresh: jest.fn().mockResolvedValue(undefined),
      onOpenScenario: jest.fn(),
    };
    const getWhatsAppQrPickerProps = jest.fn(() => picker);
    const enriched = enrichTriggerNodeData(
      "qr-1",
      {
        kind: "trigger",
        triggerConfig: { entryPointType: "whatsapp_qr", enabled: true },
      },
      {
        callbacksRef: {
          current: {
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
            updateTriggerConfigById: jest.fn(),
          },
        },
        openNodePickerFromHandle: jest.fn(),
        audienceOptions: {
          channels: [],
          customers: [],
          internalLabels: [],
          funnelStages: [],
          classificationCategories: [],
        },
        linkedConditionParentCountByNodeId: new Map(),
        selectedNodeId: "qr-1",
        sourceCapabilities: {
          hasMetaAds: false,
          hasWhatsApp: true,
          hasWhatsAppCoexistence: false,
        },
        getWhatsAppQrPickerProps,
        t: (key: string) => key,
      } as never
    );

    expect(enriched.uiNodeLabel).toBe("presetTriggerWhatsAppQr");
    expect(enriched.uiIsEditorExpanded).toBe(false);
    expect(enriched.uiWhatsAppQrPicker).toBe(picker);
    expect(getWhatsAppQrPickerProps).toHaveBeenCalledWith("qr-1");
  });
});

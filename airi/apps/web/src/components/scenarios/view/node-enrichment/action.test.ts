import { buildScenarioFormAnswersKeyStamps } from "@/lib/scenarios/scenario-form-answer-checks";
import {
  readSingleWhatsAppTemplateFlowButtonFlowId,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";
import { resolveTemplateFormFieldsNotice } from "../../nodes/action-node/action-node-whatsapp-template-form-fields-state";
import { enrichActionNodeData } from "./action";
function createActionContext(overrides: Record<string, unknown> = {}) {
  return {
    graphIndex: {
      connectedSourceHandleIdsByNodeId: new Map(),
      connectedTelegramBranchPayloadsByActionId: new Map(),
      connectedInstagramBranchPayloadsByActionId: new Map(),
      connectedWhatsAppSessionChoicePayloadsByActionId: new Map(),
      connectedFlowBranchIdsByActionId: new Map(),
      connectedWhatsAppTemplateButtonPayloadsByActionId: new Map(),
      previewProfileByActionId: new Map(),
      bulkPrimaryActionIds: new Set<string>(),
      bulkRouteRecipientsByActionId: new Map(),
      instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
      postActionConditionScopeByNodeId: new Map(),
      scenarioPromptInputsByNodeId: new Map(),
    },
    callbacksRef: {
      current: {
        updateNodeById: jest.fn(),
        removeNodeById: jest.fn(),
        resolvePreviewProfileForActionNode: jest.fn(() => ({
          channel: "whatsapp",
        })),
      },
    },
    resolvePreviewProfileForActionNode: jest.fn(() => ({
      channel: "whatsapp",
    })),
    handleBranchSyncForNodeRef: { current: jest.fn() },
    openNodePickerFromHandle: jest.fn(),
    connectedActionSources: [],
    whatsAppTemplates: [],
    whatsAppFlows: [],
    audienceOptions: { channels: [] },
    t: (key: string) => key,
    workspaceId: "workspace-1",
    legacyRoutingByActionId: new Map(),
    ...overrides,
  } as never;
}

describe("enrichActionNodeData", () => {
  it("previews explicitly bound constants and keeps unresolved variables visible", () => {
    const data = {
      kind: "action" as const,
      actionType: "whatsapp_template" as const,
      actionWhatsAppTemplateComponents: [
        { type: "BODY" as const, text: "Order {{1}}: {{2}}" },
      ],
      actionWhatsAppTemplateBindings: {
        version: 1 as const,
        parameters: {
          "body:1": { source: "literal" as const, value: "A123" },
          "body:2": { source: "prompt_input" as const, key: "status" },
        },
      },
    };
    const enriched = enrichActionNodeData(
      "action-1",
      data,
      createActionContext()
    );
    expect(enriched.uiWhatsAppTemplates.preview?.bodyText).toBe(
      "Order A123: {{2}}"
    );
    expect(data.actionWhatsAppTemplateComponents[0].text).toBe(
      "Order {{1}}: {{2}}"
    );
  });

  it("names the customer data positional variables get without set values", () => {
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action" as const,
        actionType: "whatsapp_template" as const,
        actionWhatsAppTemplateComponents: [
          { type: "BODY" as const, text: "Dear {{1}}, call {{2}}" },
        ],
      },
      createActionContext()
    );

    expect(enriched.uiWhatsAppTemplates.preview?.bodyText).toBe(
      "Dear [variableFieldFullName], call [variableFieldPhone]"
    );
  });

  it.each(["draft", "runnable"])(
    "projects %s validation without persisting it",
    validationMode => {
      const rawData = { kind: "action" as const, actionType: "reply" as const };
      const result = enrichActionNodeData(
        "action-1",
        rawData,
        createActionContext({ validationMode })
      );
      expect(result.uiValidationMode).toBe(validationMode);
      expect(rawData).toEqual({ kind: "action", actionType: "reply" });
    }
  );
  it("exposes complete capabilities with the existing resource refresh semantics", async () => {
    const loadWhatsAppTemplates = jest.fn(async () => undefined);
    const loadWhatsAppFlows = jest.fn(async () => undefined);
    const uploadActionImageForNodeId = jest.fn(async () => undefined);
    const callbacksRef = {
      current: {
        loadWhatsAppTemplates,
        loadWhatsAppFlows,
        uploadActionImageForNodeId,
      },
    };
    const enriched = enrichActionNodeData(
      "action-1",
      { kind: "action", actionType: "reply" },
      createActionContext({ callbacksRef })
    );

    enriched.uiWhatsAppTemplates.onOpenChange(false);
    enriched.uiWhatsAppFlows.onCtaOptionsOpenChange(false);
    expect(loadWhatsAppTemplates).not.toHaveBeenCalled();
    expect(loadWhatsAppFlows).not.toHaveBeenCalled();

    enriched.uiWhatsAppTemplates.onOpenChange(true);
    await enriched.uiWhatsAppTemplates.refresh();
    enriched.uiWhatsAppFlows.onCtaOptionsOpenChange(true);
    enriched.uiWhatsAppFlows.openPicker();
    enriched.uiWhatsAppFlows.refresh();
    expect(loadWhatsAppTemplates.mock.calls).toEqual([[], [true]]);
    expect(loadWhatsAppFlows.mock.calls).toEqual([[], [], [true]]);

    const nextUpload = jest.fn(async () => undefined);
    callbacksRef.current = {
      ...callbacksRef.current,
      uploadActionImageForNodeId: nextUpload,
    };
    const file = new File(["media"], "image.png", { type: "image/png" });
    await enriched.uiMedia.upload(file, { persist: false });
    expect(nextUpload).toHaveBeenCalledWith("action-1", file, {
      persist: false,
    });
    expect(uploadActionImageForNodeId).not.toHaveBeenCalled();
    expect(enriched.uiConnections.sourceHandleIds).toEqual([]);
    expect(enriched.uiActionCommands.changeType).toEqual(expect.any(Function));
    expect(enriched).not.toHaveProperty("uiActionType");
    expect(enriched).not.toHaveProperty("uiReplyMode");
    expect(enriched).not.toHaveProperty("uiActionTypeOptions");
    expect(enriched).not.toHaveProperty("uiHasTelegramSource");
    expect(enriched).not.toHaveProperty("actionPreviewImageUrl");
  });

  it("delegates generated submission and pending state to its document owner", async () => {
    const submitGeneratedTemplateForNode = jest.fn(async () => true);
    const context = createActionContext({
      submitGeneratedTemplateForNode,
      submittingGeneratedTemplateNodeId: "action-1",
    });
    const enriched = enrichActionNodeData(
      "action-1",
      { kind: "action", actionType: "whatsapp_template" },
      context
    );
    expect(enriched.uiWhatsAppTemplates.submittingGenerated).toBe(true);
    expect(await enriched.uiWhatsAppTemplates.submitGenerated()).toBe(true);
    expect(submitGeneratedTemplateForNode).toHaveBeenCalledWith("action-1");
    expect(
      enrichActionNodeData("action-2", { kind: "action" }, context)
        .uiWhatsAppTemplates.submittingGenerated
    ).toBe(false);
  });

  it("projects every connected source handle onto the action editor UI", () => {
    const connectedSourceHandleIds = [
      "right-source-generative-ai::success",
      "right-source-interactive-no-reply",
    ] as const;
    const baseContext = createActionContext() as unknown as {
      graphIndex: Record<string, unknown>;
    };
    const enriched = enrichActionNodeData(
      "action-1",
      { kind: "action", actionType: "generative_ai" },
      createActionContext({
        graphIndex: {
          ...baseContext.graphIndex,
          connectedSourceHandleIdsByNodeId: new Map([
            ["action-1", connectedSourceHandleIds],
          ]),
        },
      })
    );

    expect(enriched.uiConnections.sourceHandleIds).toBe(
      connectedSourceHandleIds
    );
  });

  it("uses the generic preview when the action profile is not indexed", () => {
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Hello {{customer.name}}",
      },
      createActionContext()
    );

    expect(enriched.actionPreviewText).toBe("Hello customer");
  });

  it("previews the answers scoped to this step and samples unknown data", () => {
    const { graphIndex } = createActionContext() as unknown as {
      graphIndex: Record<string, unknown>;
    };
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText:
          "Medal for {{input.name}}, next slot {{calendar.next_free_slot}}",
      },
      createActionContext({
        graphIndex: {
          ...graphIndex,
          scenarioPromptInputsByNodeId: new Map([
            [
              "action-1",
              [{ key: "name", label: "Name", prompt: "Name on the medal" }],
            ],
          ]),
        },
      })
    );

    expect(enriched.actionPreviewText).toBe(
      "Medal for [Name], next slot [Next Free Slot]"
    );
    expect(enriched.uiScenarioPromptInputs).toEqual([
      { key: "name", label: "Name", prompt: "Name on the medal" },
    ]);
  });

  it("exposes the forms before this step and keeps a form text answer's label", () => {
    const { graphIndex } = createActionContext() as unknown as {
      graphIndex: Record<string, unknown>;
    };
    const order = {
      nodeId: "order",
      formKey: "order",
      formLabel: "Order",
      label: "Order details",
      availability: "some_paths" as const,
      schema: "known" as const,
      fields: [],
    };
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "ai",
        actionReplyInstruction: "Thank {{input.name}}",
      },
      createActionContext({
        graphIndex: {
          ...graphIndex,
          scenarioPromptInputsByNodeId: new Map([
            [
              "action-1",
              [{ key: "name", label: "Name", prompt: "Name", fromForm: true }],
            ],
          ]),
          scenarioFormAnswerSourcesByNodeId: new Map([["action-1", [order]]]),
        },
      })
    );

    expect(enriched.uiScenarioFormAnswerSources).toEqual([order]);
    expect(enriched.uiScenarioPromptInputs).toEqual([
      { key: "name", label: "Name", prompt: "Name", fromForm: true },
    ]);
    expect(enriched.actionPreviewText).toBe(
      "actionPreviewAiReply · Thank [Name]"
    );
    expect(
      enrichActionNodeData(
        "action-2",
        { kind: "action", actionType: "reply" },
        createActionContext()
      ).uiScenarioFormAnswerSources
    ).toBeUndefined();
  });

  it("gives the Flow builder every form's key, and stores a form's key once a prompt reads it", () => {
    const { graphIndex } = createActionContext() as unknown as {
      graphIndex: Record<string, unknown>;
    };
    const form = (id: string) => ({
      id,
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionFlowConfig: {
          templateId: "",
          ctaText: "Open",
          screens: [
            {
              id: "S",
              title: "S",
              fields: [{ id: "size", label: "Size", fieldType: "TextInput" }],
            },
          ],
        },
      },
    });
    const formKeys = new Map([
      ["e", "form"],
      ["f", "form_2"],
    ]);
    const updateNodeById = jest.fn();
    const enriched = enrichActionNodeData(
      "action-1",
      { kind: "action", actionType: "reply", actionReplyMode: "ai" },
      createActionContext({
        graphIndex: {
          ...graphIndex,
          scenarioFormKeysByNodeId: formKeys,
          scenarioFormKeyStampsByFormKey: buildScenarioFormAnswersKeyStamps([
            form("e"),
            form("f"),
          ]),
        },
        callbacksRef: { current: { updateNodeById } },
      })
    );
    expect(enriched.uiScenarioFormKeys).toBe(formKeys);

    enriched.uiOnPatch({ actionReplyInstruction: "Confirm the size." });
    expect(updateNodeById.mock.calls.map(([nodeId]) => nodeId)).toEqual([
      "action-1",
    ]);

    updateNodeById.mockClear();
    enriched.uiOnPatch({
      actionReplyInstruction: "Confirm {{form.form_2.size}}.",
    });
    expect(updateNodeById).toHaveBeenCalledWith("f", {
      actionFlowConfig: expect.objectContaining({ answersKey: "form_2" }),
    });
    expect(updateNodeById).toHaveBeenLastCalledWith("action-1", {
      actionReplyInstruction: "Confirm {{form.form_2.size}}.",
    });
  });

  it("leaves the preview empty for a step with nothing to send", () => {
    const enriched = enrichActionNodeData(
      "action-1",
      { kind: "action", actionType: "reply", actionReplyMode: "fixed" },
      createActionContext()
    );

    expect(enriched.actionPreviewText).toBeUndefined();
  });

  it("says the AI writes the reply, followed by its instructions", () => {
    const { graphIndex } = createActionContext() as unknown as {
      graphIndex: Record<string, unknown>;
    };
    const context = createActionContext({
      graphIndex: {
        ...graphIndex,
        scenarioPromptInputsByNodeId: new Map([
          ["action-1", [{ key: "name", label: "Name", prompt: "Your name" }]],
        ]),
      },
    });

    expect(
      enrichActionNodeData(
        "action-1",
        { kind: "action", actionType: "reply", actionReplyMode: "ai" },
        context
      ).actionPreviewText
    ).toBe("actionPreviewAiReply");
    expect(
      enrichActionNodeData(
        "action-1",
        {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "ai",
          actionReplyInstruction: "Greet {{input.name}} warmly",
        },
        context
      ).actionPreviewText
    ).toBe("actionPreviewAiReply · Greet [Name] warmly");
  });

  it("flags a step reached after a No reply of a day or more", () => {
    const { graphIndex } = createActionContext() as unknown as {
      graphIndex: Record<string, unknown>;
    };
    const context = createActionContext({
      graphIndex: {
        ...graphIndex,
        reachedAfterLongNoReplyNodeIds: new Set(["action-1"]),
      },
    });
    const data = { kind: "action" as const, actionType: "reply" as const };

    expect(
      enrichActionNodeData("action-1", data, context).uiReachedAfterLongNoReply
    ).toBe(true);
    expect(
      enrichActionNodeData("action-2", data, context).uiReachedAfterLongNoReply
    ).toBe(false);
  });

  it("routes action selector changes through branch synchronization", () => {
    const handleBranchSyncForNode = jest.fn();
    const ctx = createActionContext({
      handleBranchSyncForNodeRef: { current: handleBranchSyncForNode },
    });
    const enriched = enrichActionNodeData(
      "action-1",
      { kind: "action", actionType: "reply" },
      ctx
    );

    enriched.uiActionCommands.changeType?.("whatsapp_template");

    expect(handleBranchSyncForNode).toHaveBeenCalledTimes(1);
    expect(handleBranchSyncForNode).toHaveBeenCalledWith(
      "action-1",
      expect.any(Array),
      expect.objectContaining({
        actionType: "whatsapp_template",
        actionReplyMode: undefined,
      }),
      undefined
    );
  });

  it("routes picking another template through branch sync with Undo", () => {
    const handleBranchSyncForNode = jest.fn();
    const updateNodeById = jest.fn();
    const pickTier = {
      id: "meta-2",
      name: "pick_tier",
      language: "en",
      category: "MARKETING",
      components: [
        { type: "BODY", text: "Which tier?" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Gold" },
            { type: "QUICK_REPLY", text: "Premium" },
          ],
        },
      ],
    };
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "pick_plan",
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Which plan?" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Basic" },
              { type: "QUICK_REPLY", text: "Premium" },
            ],
          },
        ],
      },
      createActionContext({
        callbacksRef: { current: { updateNodeById } },
        handleBranchSyncForNodeRef: { current: handleBranchSyncForNode },
        whatsAppTemplates: [pickTier],
      })
    );

    enriched.uiWhatsAppTemplates.select("pick_tier::en");

    expect(updateNodeById).not.toHaveBeenCalled();
    expect(handleBranchSyncForNode).toHaveBeenCalledWith(
      "action-1",
      expect.arrayContaining([
        expect.objectContaining({ kind: "whatsapp_template_button" }),
      ]),
      expect.objectContaining({
        actionWhatsAppTemplateName: "pick_tier",
        actionWhatsAppTemplateComponents: pickTier.components,
        // Premium keeps its id, so its route stays; Gold gets a new one.
        actionWhatsAppTemplateButtonIds: {
          version: 1,
          nextId: 11,
          buttons: [
            { id: 10, index: 0, text: "Gold" },
            { id: 1, index: 1, text: "Premium" },
          ],
        },
      }),
      { templatePick: true }
    );
  });

  it("loads the form fields of a picked template whose button opens a form, after its branch sync", () => {
    const formTemplate = {
      id: "meta-3",
      name: "demoshop_test",
      language: "kk",
      category: "MARKETING",
      components: [
        { type: "BODY", text: "Choose your medal" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "FLOW", text: "Open form", flow_id: 1571793974235171 },
          ],
        },
      ],
    };
    const replyTemplate = {
      ...formTemplate,
      id: "meta-4",
      name: "quick_reply_only",
      components: [
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
      ],
    };
    const pick = (templateValue: string) => {
      const handleBranchSyncForNode = jest.fn();
      const loadWhatsAppTemplateForm = jest.fn(async () => ({
        status: "unchanged" as const,
      }));
      enrichActionNodeData(
        "action-1",
        { kind: "action", actionType: "whatsapp_template" },
        createActionContext({
          handleBranchSyncForNodeRef: { current: handleBranchSyncForNode },
          loadWhatsAppTemplateForm,
          whatsAppTemplates: [formTemplate, replyTemplate],
        })
      ).uiWhatsAppTemplates.select(templateValue);
      expect(handleBranchSyncForNode).toHaveBeenCalledTimes(1);
      return { handleBranchSyncForNode, loadWhatsAppTemplateForm };
    };

    const picked = pick("demoshop_test::kk");
    expect(picked.loadWhatsAppTemplateForm).toHaveBeenCalledWith("action-1", {
      reason: "pick",
    });
    expect(
      picked.handleBranchSyncForNode.mock.invocationCallOrder[0]
    ).toBeLessThan(picked.loadWhatsAppTemplateForm.mock.invocationCallOrder[0]);
    expect(
      pick("quick_reply_only::kk").loadWhatsAppTemplateForm
    ).not.toHaveBeenCalled();
  });

  it("hands the template section this step's form load and whether it runs", async () => {
    const loadWhatsAppTemplateForm = jest.fn(async () => ({
      status: "unchanged" as const,
    }));
    const formFieldsWhileLoading = (nodeIds: string[]) =>
      enrichActionNodeData(
        "action-1",
        { kind: "action", actionType: "whatsapp_template" },
        createActionContext({
          loadWhatsAppTemplateForm,
          loadingTemplateFormNodeIds: new Set(nodeIds),
        })
      ).uiWhatsAppTemplates.formFields;

    expect(formFieldsWhileLoading(["action-2"]).loading).toBe(false);
    const formFields = formFieldsWhileLoading(["action-1"]);
    expect(formFields.loading).toBe(true);
    await expect(
      formFields.load("update", { confirmRemovals: true })
    ).resolves.toEqual({ status: "unchanged" });
    expect(loadWhatsAppTemplateForm).toHaveBeenCalledWith("action-1", {
      reason: "update",
      confirmRemovals: true,
    });
  });

  it("offers a form's Load only for the Flow the saved step opens, as the loader reads it", () => {
    const flowId = "1571793974235171";
    const components: WhatsAppComponent[] = [
      { type: "BODY", text: "Choose your medal" },
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Open form", flow_id: flowId }],
      },
    ];
    const formTemplate = {
      id: "meta-3",
      name: "demoshop_test",
      language: "kk",
      category: "MARKETING",
      components,
    };
    const noticeFor = (data: Parameters<typeof enrichActionNodeData>[1]) => {
      const enriched = enrichActionNodeData(
        "action-1",
        data,
        createActionContext({ whatsAppTemplates: [formTemplate] })
      );
      return {
        enriched,
        // As the template section's form fields notice reads it.
        notice: resolveTemplateFormFieldsNotice({
          nodeId: "action-1",
          nodeData: enriched,
          flowId: enriched.uiWhatsAppTemplates.formFields.flowId,
          flowFacts: { factsByFlowId: {}, isRefreshing: () => false },
          formLoading: false,
        }),
      };
    };
    const older = {
      kind: "action" as const,
      actionType: "whatsapp_template" as const,
      actionWhatsAppTemplateName: "demoshop_test",
      actionWhatsAppTemplateLanguage: "kk",
    };

    // An older step saved only the template's name and language. It shows
    // the approved template's form button, but the loader reads the saved
    // step, which opens no form, so a Load would do nothing.
    const shown = noticeFor(older);
    expect(
      readSingleWhatsAppTemplateFlowButtonFlowId(
        shown.enriched.actionWhatsAppTemplateComponents
      )
    ).toBe(flowId);
    expect(shown.notice).toBeNull();
    expect(shown.enriched.uiWhatsAppTemplates.formFields.flowId).toBeNull();

    // A step that saved the button loads its form.
    const saved = noticeFor({
      ...older,
      actionWhatsAppTemplateComponents: components,
    });
    expect(saved.enriched.uiWhatsAppTemplates.formFields.flowId).toBe(flowId);
    expect(saved.notice).toMatchObject({
      kind: "missing",
      action: { type: "load", flowId },
    });
  });

  it("binds managed WhatsApp Flow provisioning to the enriched action node", async () => {
    const sources = [{ id: "source-wa-1", label: "Primary WhatsApp" }];
    const publication = { response: { ok: true }, adopted: true };
    const publishManagedWhatsAppFlow = jest.fn().mockResolvedValue(publication);
    const enriched = enrichActionNodeData(
      "action-1",
      { kind: "action", actionType: "whatsapp_template" },
      createActionContext({
        managedWhatsAppFlowProvisioningSources: sources,
        publishManagedWhatsAppFlow,
        scenarioSessionOwnerKey: "session-1",
        publishingManagedFlowNodeId: "action-1",
      })
    );
    const host = enriched.uiWhatsAppFlows.managedProvisioningHost;
    const editableConfig = {
      version: 1 as const,
      templateId: "custom",
      headerText: "Appointment",
      bodyText: "Choose a time",
      ctaText: "Start",
      screens: [],
    };

    await expect(
      host?.publish({
        sourceId: "source-wa-1",
        editableConfig,
      })
    ).resolves.toEqual(publication);
    expect(host?.sources).toBe(sources);
    expect(publishManagedWhatsAppFlow).toHaveBeenCalledWith({
      nodeId: "action-1",
      sourceId: "source-wa-1",
      editableConfig,
    });

    expect(host?.ownerKey).toBe(JSON.stringify(["session-1", "action-1"]));
    expect(host?.publishing).toBe(true);
  });

  it("previews a service-message Flow with its source-bound provider reference", () => {
    const openLinkedWhatsAppFlowPreview = jest.fn();
    const flowConfig = {
      templateId: "provider_reference",
      ctaText: "Open",
      screens: [],
      providerReference: {
        flowId: "flow-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        providerStatus: "PUBLISHED" as const,
      },
    };
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Complete the form" },
            flowConfig,
          },
        },
      },
      createActionContext({
        callbacksRef: {
          current: {
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
            openLinkedWhatsAppFlowPreview,
            resolvePreviewProfileForActionNode: jest.fn(() => ({
              channel: "whatsapp",
            })),
          },
        },
      })
    );

    enriched.uiWhatsAppFlows.openPreview?.("flow-1", "data_exchange");

    expect(openLinkedWhatsAppFlowPreview).toHaveBeenCalledWith(
      "action-1",
      "flow-1",
      "data_exchange",
      flowConfig
    );
  });

  it("converts projected legacy routing before editing or opening an outcome", async () => {
    const convertLegacyActionRouting = jest.fn().mockResolvedValue(true);
    const updateNodeById = jest.fn();
    const openNodePickerFromHandle = jest.fn();
    const ctx = createActionContext({
      callbacksRef: {
        current: {
          convertLegacyActionRouting,
          updateNodeById,
          removeNodeById: jest.fn(),
          resolvePreviewProfileForActionNode: jest.fn(() => ({
            channel: "whatsapp",
          })),
        },
      },
      openNodePickerFromHandle,
      legacyRoutingByActionId: new Map([
        [
          "action-1",
          {
            actionOutcomes: {
              version: 1,
              anyReply: { enabled: true },
            },
            actionOutcomesSource: {
              sourceNodeId: "condition-1",
              sourceKind: "post_action_condition",
            },
          },
        ],
      ]),
    });
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action",
        actionType: "reply",
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
        },
      },
      ctx
    );
    const actionOutcomes = {
      version: 1 as const,
      noReply: { enabled: true, timeoutMinutes: 45 },
    };

    enriched.uiOnPatch?.({ actionOutcomes });
    await enriched.uiOnCreateNodeFromSourceHandle?.(
      "right-source-action-outcome::any-reply",
      100,
      200
    );

    expect(convertLegacyActionRouting).toHaveBeenNthCalledWith(1, {
      sourceActionNodeId: "action-1",
      sourceNodeId: "condition-1",
      sourceKind: "post_action_condition",
      patch: { actionOutcomes },
    });
    expect(convertLegacyActionRouting).toHaveBeenNthCalledWith(2, {
      sourceActionNodeId: "action-1",
      sourceNodeId: "condition-1",
      sourceKind: "post_action_condition",
      patch: {},
    });
    expect(updateNodeById).not.toHaveBeenCalled();
    expect(openNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      "right-source-action-outcome::any-reply",
      100,
      200
    );
  });

  it.each([true, false])(
    "converts a legacy wait before a branch change re-owns its handles (converted: %s)",
    async converted => {
      const convertLegacyActionRouting = jest.fn().mockResolvedValue(converted);
      const handleBranchSyncForNode = jest.fn();
      const ctx = createActionContext({
        callbacksRef: {
          current: {
            convertLegacyActionRouting,
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
            resolvePreviewProfileForActionNode: jest.fn(() => ({
              channel: "whatsapp",
            })),
          },
        },
        handleBranchSyncForNodeRef: { current: handleBranchSyncForNode },
        legacyRoutingByActionId: new Map([
          [
            "action-1",
            {
              actionOutcomes: {
                version: 1,
                noReply: { enabled: true, timeoutMinutes: 30 },
              },
              actionOutcomesSource: {
                sourceNodeId: "condition-1",
                sourceKind: "post_action_condition",
              },
            },
          ],
        ]),
      });
      const enriched = enrichActionNodeData(
        "action-1",
        {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionTelegramQuickReplies: [],
        },
        ctx
      );

      enriched.uiActionCommands.changeTelegramQuickReplies?.([
        [{ text: "Yes", payload: "yes" }],
      ]);
      await Promise.resolve();
      await Promise.resolve();

      expect(convertLegacyActionRouting).toHaveBeenCalledWith({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {},
      });
      expect(handleBranchSyncForNode).toHaveBeenCalledTimes(converted ? 1 : 0);
    }
  );

  it("syncs a legacy action's branch edit directly when its handles stay owned", () => {
    const convertLegacyActionRouting = jest.fn().mockResolvedValue(true);
    const handleBranchSyncForNode = jest.fn();
    const ctx = createActionContext({
      callbacksRef: {
        current: {
          convertLegacyActionRouting,
          updateNodeById: jest.fn(),
          removeNodeById: jest.fn(),
          resolvePreviewProfileForActionNode: jest.fn(() => ({
            channel: "whatsapp",
          })),
        },
      },
      handleBranchSyncForNodeRef: { current: handleBranchSyncForNode },
      legacyRoutingByActionId: new Map([
        [
          "action-1",
          {
            actionOutcomes: { version: 1, anyReply: { enabled: true } },
            actionOutcomesSource: {
              sourceNodeId: "condition-1",
              sourceKind: "post_action_condition",
            },
          },
        ],
      ]),
    });
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "telegram",
        actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
      },
      ctx
    );

    enriched.uiActionCommands.changeTelegramQuickReplies?.([
      [{ text: "Yes, please", payload: "yes" }],
    ]);

    expect(convertLegacyActionRouting).not.toHaveBeenCalled();
    expect(handleBranchSyncForNode).toHaveBeenCalledTimes(1);
  });
});

import {
  resolveWhatsAppFlowProviderId,
  type ManagedWhatsAppFlowProvisioningProjection,
  type ScenarioNodeData,
  type ScenarioWhatsAppTemplateForm,
  type WhatsAppFlowConfig,
  type WhatsAppFlowProviderReference,
} from "@icecore/scenario-contracts";

import type { ScenarioFlowNode } from "@/components/scenarios/types";
import { createHash } from "node:crypto";
import { normalizeScenarioNodesForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { serializeWhatsAppFlowEditableContent } from "./whatsapp-flow-config";
import { buildWhatsAppTemplateFormAlignmentPatch } from "./whatsapp-template-flow";
import {
  buildScenarioWhatsAppInteractiveFlowConfigPatch,
  resolveScenarioWhatsAppInteractiveFlowTarget,
} from "@/lib/scenarios/whatsapp-service-message";

import {
  applyManagedWhatsAppFlowProvisioningProjectionToNode,
  applyScenarioWhatsAppInteractiveFlowSelectionToNode,
  collectScenarioWhatsAppFlowProviderSourceIds,
  createWhatsAppFlowEditableContentDigest,
  mergeServerOwnedWhatsAppFlowProjection,
  normalizeManagedWhatsAppFlowProvisioningProjection,
} from "./whatsapp-flow-projection";

function flowConfig(
  overrides: Partial<WhatsAppFlowConfig> = {}
): WhatsAppFlowConfig {
  return {
    templateId: "local-flow-1",
    ctaText: "Book",
    flowNavigationMode: "data_endpoint",
    screens: [
      { id: "DETAILS", title: "Details", fields: [] },
      { id: "CONFIRM", title: "Confirm", fields: [] },
    ],
    screenRoutes: {
      DETAILS: ["CONFIRM"],
      CONFIRM: [],
    },
    ...overrides,
  };
}

function projection(
  config: WhatsAppFlowConfig,
  overrides: Partial<ManagedWhatsAppFlowProvisioningProjection> = {}
): ManagedWhatsAppFlowProvisioningProjection {
  return {
    operationId: "operation-current",
    sourceId: "source-1",
    wabaId: "waba-1",
    contentRevision: 4,
    contentDigest: createWhatsAppFlowEditableContentDigest(config),
    flowId: "provider-flow-1",
    flowName: "Booking",
    providerStatus: "PUBLISHED",
    ...overrides,
  };
}

function providerReference(
  overrides: Partial<WhatsAppFlowProviderReference> = {}
): WhatsAppFlowProviderReference {
  return {
    flowId: "provider-reference-flow-1",
    sourceId: "source-1",
    wabaId: "waba-1",
    flowName: "Provider Flow",
    providerStatus: "PUBLISHED",
    jsonVersion: "7.3",
    dataApiVersion: "3.0",
    ...overrides,
  };
}

function templateNode(
  id: string,
  config: WhatsAppFlowConfig
): ScenarioFlowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionFlowConfig: config,
    },
  };
}

function serviceMessageNode(
  id: string,
  config: WhatsAppFlowConfig
): ScenarioFlowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Choose" },
          flowConfig: config,
        },
      },
    },
  };
}

function resolvedProjection(
  node: ScenarioFlowNode
): ManagedWhatsAppFlowProvisioningProjection | undefined {
  return resolveScenarioWhatsAppInteractiveFlowTarget(node.data)?.config
    .managedProvisioning;
}

function resolvedProviderReference(node: ScenarioFlowNode) {
  return resolveScenarioWhatsAppInteractiveFlowTarget(node.data)?.config
    .providerReference;
}

describe("managed WhatsApp Flow scenario projection", () => {
  it("loads and hashes editable content without Node crypto in the browser", () => {
    jest.doMock("node:crypto", () => {
      throw new Error("Node crypto is unavailable in the browser");
    });
    try {
      jest.isolateModules(() => {
        const browserProjection = jest.requireActual<
          typeof import("./whatsapp-flow-projection")
        >("./whatsapp-flow-projection");
        const config = flowConfig({ bodyText: "Сәлем 🌍 — 你好" });
        expect(
          browserProjection.createWhatsAppFlowEditableContentDigest(config)
        ).toBe(
          createHash("sha256")
            .update(serializeWhatsAppFlowEditableContent(config))
            .digest("hex")
        );
      });
    } finally {
      jest.dontMock("node:crypto");
    }
  });

  it("preserves server SHA-256 and canonical property ordering", () => {
    const config = flowConfig({ bodyText: "Сәлем 🌍 — 你好" });
    const reordered = Object.fromEntries(
      Object.entries(config).reverse()
    ) as unknown as WhatsAppFlowConfig;
    const expected = createHash("sha256")
      .update(serializeWhatsAppFlowEditableContent(config))
      .digest("hex");

    expect(createWhatsAppFlowEditableContentDigest(config)).toBe(expected);
    expect(createWhatsAppFlowEditableContentDigest(reordered)).toBe(expected);
  });

  it("collects managed and provider-reference source ids without duplicates", () => {
    const managed = flowConfig();
    const provider = flowConfig({ providerReference: providerReference() });

    expect(
      collectScenarioWhatsAppFlowProviderSourceIds(
        [
          templateNode("managed", {
            ...managed,
            managedProvisioning: projection(managed),
          }),
          serviceMessageNode("provider", provider),
          { data: undefined },
          { data: "not-node-data" },
        ],
        ["source-evidence", "source-1", " "]
      )
    ).toEqual(["source-evidence", "source-1"]);
  });

  it.each(["DRAFT", "PUBLISHED", "DEPRECATED", "BLOCKED", "THROTTLED"])(
    "preserves the truthful Meta provider status %s",
    providerStatus => {
      const config = flowConfig();
      expect(
        normalizeManagedWhatsAppFlowProvisioningProjection({
          ...projection(config),
          providerStatus,
        })?.providerStatus
      ).toBe(providerStatus);
    }
  );

  it.each([
    ["template", templateNode],
    ["service message", serviceMessageNode],
  ])("projects server state into the exact %s owner", (_label, createNode) => {
    const config = flowConfig();
    const node = createNode("action-1", config);
    const managed = projection(config, { providerStatus: "DRAFT" });

    const projected = applyManagedWhatsAppFlowProvisioningProjectionToNode(
      node,
      managed
    );

    expect(projected).not.toBeNull();
    expect(resolvedProjection(projected!)).toEqual(managed);
  });

  it.each([
    ["template", templateNode],
    ["service message", serviceMessageNode],
  ] as const)("resolves and patches the %s Flow owner", (_label, makeNode) => {
    const original = flowConfig();
    const node = makeNode("action-1", original);
    const target = resolveScenarioWhatsAppInteractiveFlowTarget(node.data);
    const next = flowConfig({ ctaText: "Continue" });

    expect(target?.owner).toBe(
      makeNode === templateNode ? "template" : "service_message"
    );

    const patch = buildScenarioWhatsAppInteractiveFlowConfigPatch(
      node.data,
      next
    );
    expect(patch).not.toBeNull();
    const patchedTarget = resolveScenarioWhatsAppInteractiveFlowTarget({
      ...node.data,
      ...patch,
    } as ScenarioNodeData);
    expect(patchedTarget?.owner).toBe(target?.owner);
    expect(patchedTarget?.config).toEqual(next);
  });

  it("attaches a selected Flow to an empty matching WhatsApp template action", () => {
    const selected = flowConfig({
      providerReference: providerReference(),
    });
    const populated = templateNode("action-1", flowConfig());
    const node = {
      ...populated,
      data: {
        ...populated.data,
        actionFlowConfig: null,
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              {
                type: "FLOW",
                text: "Open",
                flow_id: "provider-reference-flow-1",
              },
            ],
          },
        ],
      },
    } as ScenarioFlowNode;

    const updated = applyScenarioWhatsAppInteractiveFlowSelectionToNode(
      node,
      selected
    );

    expect(updated).not.toBeNull();
    expect((updated?.data as ScenarioNodeData).actionFlowConfig).toEqual(
      selected
    );
  });

  it("rejects a provider reference that does not match the template Flow button", () => {
    const selected = flowConfig({
      providerReference: providerReference(),
    });
    const populated = templateNode("action-1", flowConfig());
    const node = {
      ...populated,
      data: {
        ...populated.data,
        actionFlowConfig: null,
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "FLOW", text: "Open", flow_id: "different-flow-id" },
            ],
          },
        ],
      },
    } as ScenarioFlowNode;

    expect(
      applyScenarioWhatsAppInteractiveFlowSelectionToNode(node, selected)
    ).toBeNull();
  });

  it("attaches a selected Flow only to a canonical Flow service message", () => {
    const selected = flowConfig({
      providerReference: providerReference(),
    });
    const flowNode = serviceMessageNode("action-flow", flowConfig());
    const nonFlowNode = {
      ...flowNode,
      id: "action-text",
      data: {
        ...flowNode.data,
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "Hello" },
          },
        },
      },
    } as ScenarioFlowNode;

    const updated = applyScenarioWhatsAppInteractiveFlowSelectionToNode(
      flowNode,
      selected
    );

    expect(updated).not.toBeNull();
    expect(
      resolveScenarioWhatsAppInteractiveFlowTarget(updated!.data)?.config
    ).toEqual(selected);
    expect(
      applyScenarioWhatsAppInteractiveFlowSelectionToNode(nonFlowNode, selected)
    ).toBeNull();
  });

  it("never accepts a forged browser projection", () => {
    const incomingConfig = flowConfig({
      managedProvisioning: projection(flowConfig(), {
        operationId: "attacker-operation",
      }),
    });

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [templateNode("action-1", incomingConfig)],
      storedNodes: [templateNode("action-1", flowConfig())],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    expect(resolvedProjection(merged)).toBeUndefined();
  });

  it.each([
    ["template", templateNode],
    ["service message", serviceMessageNode],
  ] as const)(
    "strips a forged provider reference from a new %s node",
    (_label, makeNode) => {
      const [merged] = mergeServerOwnedWhatsAppFlowProjection({
        incomingNodes: [
          makeNode(
            "action-new",
            flowConfig({
              providerReference: providerReference({
                flowId: "attacker-flow",
              }),
            })
          ),
        ],
        storedNodes: [],
        digestEditableConfig: createWhatsAppFlowEditableContentDigest,
      });

      expect(resolvedProviderReference(merged)).toBeUndefined();
    }
  );

  it.each([
    ["template", templateNode],
    ["service message", serviceMessageNode],
  ] as const)(
    "restores the stored provider reference for unchanged %s content",
    (_label, makeNode) => {
      const editable = flowConfig();
      const storedReference = providerReference();

      const [merged] = mergeServerOwnedWhatsAppFlowProjection({
        incomingNodes: [
          makeNode(
            "action-1",
            flowConfig({
              providerReference: providerReference({ flowId: "forged-flow" }),
            })
          ),
        ],
        storedNodes: [
          makeNode(
            "action-1",
            flowConfig({
              ...editable,
              providerReference: storedReference,
            })
          ),
        ],
        digestEditableConfig: createWhatsAppFlowEditableContentDigest,
      });

      expect(resolvedProviderReference(merged)).toEqual(storedReference);
    }
  );

  it("keeps a template's saved form beside its linked Flow through save", () => {
    const savedForm: ScenarioWhatsAppTemplateForm = {
      version: 1,
      flowId: "2244981489363579",
      flowName: "demoshop_ai_case",
      answersKey: "demoshop_ai_case",
      digest: null,
      coverage: "complete",
      endpoint: false,
      readAt: "2026-10-04T08:00:00.000Z",
      fields: [
        {
          responseKey: "_68d224",
          label: "Athlete's name",
          description: "",
          fieldType: "TextInput",
          required: true,
          screenIndex: 1,
          options: [],
        },
      ],
    };
    const storedReference = providerReference();
    const linkedNode = (): ScenarioFlowNode => {
      const node = templateNode(
        "action-1",
        flowConfig({ providerReference: storedReference })
      );
      return {
        ...node,
        data: { ...node.data, actionWhatsAppTemplateForm: savedForm },
      };
    };
    const [normalizedIncoming] = normalizeScenarioNodesForPersistence([
      linkedNode(),
    ]) as ScenarioFlowNode[];

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [normalizedIncoming],
      storedNodes: [linkedNode()],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    expect(resolvedProviderReference(merged)).toEqual(storedReference);
    expect(
      (merged.data as ScenarioNodeData).actionWhatsAppTemplateForm
    ).toEqual(savedForm);
  });

  it.each([
    [
      "linked",
      (config: WhatsAppFlowConfig) => ({
        ...config,
        providerReference: providerReference(),
      }),
    ],
    [
      "managed",
      (config: WhatsAppFlowConfig) => ({
        ...config,
        managedProvisioning: projection(config),
      }),
    ],
  ] as const)(
    "does not bring back a %s Flow that a pick of another form dropped",
    (_label, link) => {
      const formButton = (flowId: string) => [
        {
          type: "BUTTONS" as const,
          buttons: [{ type: "FLOW" as const, text: "Book", flow_id: flowId }],
        },
      ];
      const linkedConfig = link(flowConfig());
      const stored = templateNode("action-1", linkedConfig);
      stored.data = {
        ...stored.data,
        actionWhatsAppTemplateComponents: formButton(
          resolveWhatsAppFlowProviderId({ flowConfig: linkedConfig })!
        ),
      };
      const nextComponents = formButton("2244981489363579");
      const [picked] = normalizeScenarioNodesForPersistence([
        {
          ...stored,
          data: {
            ...stored.data,
            actionWhatsAppTemplateComponents: nextComponents,
            ...buildWhatsAppTemplateFormAlignmentPatch(
              stored.data,
              nextComponents
            ),
          },
        },
      ]) as ScenarioFlowNode[];

      const [merged] = mergeServerOwnedWhatsAppFlowProjection({
        incomingNodes: [picked],
        storedNodes: [stored],
        digestEditableConfig: createWhatsAppFlowEditableContentDigest,
      });

      expect(resolveScenarioWhatsAppInteractiveFlowTarget(merged.data)).toBe(
        null
      );
      expect(
        (merged.data as ScenarioNodeData).actionFlowConfig
      ).toBeUndefined();
    }
  );

  it.each([
    ["template", templateNode],
    ["service message", serviceMessageNode],
  ] as const)(
    "drops the provider reference when %s editable content changes",
    (_label, makeNode) => {
      const storedConfig = flowConfig();

      const [merged] = mergeServerOwnedWhatsAppFlowProjection({
        incomingNodes: [
          makeNode(
            "action-1",
            flowConfig({
              ctaText: "Changed",
              providerReference: providerReference({ flowId: "forged-flow" }),
            })
          ),
        ],
        storedNodes: [
          makeNode(
            "action-1",
            flowConfig({
              ...storedConfig,
              providerReference: providerReference(),
            })
          ),
        ],
        digestEditableConfig: createWhatsAppFlowEditableContentDigest,
      });

      expect(resolvedProviderReference(merged)).toBeUndefined();
    }
  );

  it("replaces stale full-graph browser state with the current stored projection", () => {
    const editable = flowConfig();
    const currentProjection = projection(editable);
    const staleProjection = projection(editable, {
      operationId: "operation-stale",
      contentRevision: 3,
      flowId: "provider-flow-stale",
    });

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [
        serviceMessageNode("action-1", {
          ...editable,
          managedProvisioning: staleProjection,
        }),
      ],
      storedNodes: [
        serviceMessageNode("action-1", {
          ...editable,
          managedProvisioning: currentProjection,
        }),
      ],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    expect(resolvedProjection(merged)).toEqual(currentProjection);
  });

  it("restores the stored projection after API graph normalization", () => {
    const editable = flowConfig();
    const currentProjection = projection(editable);
    const stored = templateNode("action-1", {
      ...editable,
      managedProvisioning: currentProjection,
    });
    const [normalizedIncoming] = normalizeScenarioNodesForPersistence([
      templateNode("action-1", {
        ...editable,
        managedProvisioning: {
          ...currentProjection,
          operationId: "operation-stale",
        },
      }),
    ]) as ScenarioFlowNode[];

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [normalizedIncoming],
      storedNodes: [stored],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    expect(resolvedProjection(merged)).toEqual(currentProjection);
  });

  it.each([
    ["template", templateNode],
    ["service message", serviceMessageNode],
  ] as const)(
    "preserves the stored %s projection when editable content is unchanged",
    (_label, makeNode) => {
      const editable = flowConfig();
      const storedProjection = projection(editable);

      const [merged] = mergeServerOwnedWhatsAppFlowProjection({
        incomingNodes: [makeNode("action-1", editable)],
        storedNodes: [
          makeNode("action-1", {
            ...editable,
            managedProvisioning: storedProjection,
          }),
        ],
        digestEditableConfig: createWhatsAppFlowEditableContentDigest,
      });

      expect(resolvedProjection(merged)).toEqual(storedProjection);
    }
  );

  it("invalidates service-message provisioning when editable Flow content changes", () => {
    const storedConfig = flowConfig();
    const storedProjection = projection(storedConfig);

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [
        serviceMessageNode("action-1", flowConfig({ ctaText: "Changed" })),
      ],
      storedNodes: [
        serviceMessageNode("action-1", {
          ...storedConfig,
          managedProvisioning: storedProjection,
        }),
      ],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    expect(resolvedProjection(merged)).toBeUndefined();
  });

  it("preserves the server-owned template Flow binding across draft edits", () => {
    const storedConfig = flowConfig({ flowNavigationMode: "linear" });
    const storedProjection = projection(storedConfig);

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [
        templateNode("action-1", {
          ...flowConfig({
            flowNavigationMode: "linear",
            ctaText: "Changed",
          }),
          managedProvisioning: projection(storedConfig, {
            operationId: "forged-operation",
            flowId: "forged-flow",
          }),
        }),
      ],
      storedNodes: [
        templateNode("action-1", {
          ...storedConfig,
          managedProvisioning: storedProjection,
        }),
      ],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    expect(resolvedProjection(merged)).toEqual(storedProjection);
    expect(
      resolveScenarioWhatsAppInteractiveFlowTarget(merged.data)?.config.ctaText
    ).toBe("Changed");
  });

  it("invalidates a changed template binding when the scenario remains active", () => {
    const storedConfig = flowConfig({ flowNavigationMode: "linear" });
    const storedProjection = projection(storedConfig);

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [
        templateNode(
          "action-1",
          flowConfig({ flowNavigationMode: "linear", ctaText: "Changed" })
        ),
      ],
      storedNodes: [
        templateNode("action-1", {
          ...storedConfig,
          managedProvisioning: storedProjection,
        }),
      ],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
      preserveTemplateProviderBindingOnContentChange: false,
    });

    expect(resolvedProjection(merged)).toBeUndefined();
  });

  it("keeps legacy flat provider metadata readable for legacy records", () => {
    const legacyConfig = flowConfig({
      flowNavigationMode: "linear",
      metaFlowId: "legacy-flow-1",
      metaFlowName: "Legacy Flow",
      metaFlowStatus: "PUBLISHED",
    });

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [
        templateNode(
          "action-1",
          flowConfig({ flowNavigationMode: "linear", ctaText: "Changed" })
        ),
      ],
      storedNodes: [templateNode("action-1", legacyConfig)],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    expect(
      resolveScenarioWhatsAppInteractiveFlowTarget(merged.data)?.config
    ).toEqual({ ...legacyConfig, ctaText: "Changed" });
  });

  it("strips forged legacy provider metadata from a new endpoint Flow", () => {
    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [
        templateNode("action-new", {
          ...flowConfig(),
          metaFlowId: "attacker-flow",
          metaFlowName: "Attacker",
          metaFlowStatus: "PUBLISHED",
        }),
      ],
      storedNodes: [],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    const config = resolveScenarioWhatsAppInteractiveFlowTarget(
      merged.data
    )?.config;
    expect(config?.metaFlowId).toBeUndefined();
    expect(config?.metaFlowName).toBeUndefined();
    expect(config?.metaFlowStatus).toBeUndefined();
  });

  it("does not downgrade malformed stored provider references to legacy identity", () => {
    const editable = flowConfig();
    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [templateNode("action-1", editable)],
      storedNodes: [
        templateNode("action-1", {
          ...editable,
          metaFlowId: "legacy-flow-id",
          metaFlowStatus: "PUBLISHED",
          providerReference: {
            flowId: "provider-flow-id",
          } as unknown as WhatsAppFlowProviderReference,
        }),
      ],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    const config = resolveScenarioWhatsAppInteractiveFlowTarget(
      merged.data
    )?.config;
    expect(config?.providerReference).toBeUndefined();
    expect(config?.metaFlowId).toBeUndefined();
    expect(config?.metaFlowStatus).toBeUndefined();
  });

  it("does not let edited managed records downgrade to forged legacy provider metadata", () => {
    const storedConfig = flowConfig();
    const storedProjection = projection(storedConfig);

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [
        templateNode("action-1", {
          ...flowConfig({ ctaText: "Changed" }),
          metaFlowId: "attacker-flow",
          metaFlowName: "Attacker",
          metaFlowStatus: "PUBLISHED",
        }),
      ],
      storedNodes: [
        templateNode("action-1", {
          ...storedConfig,
          managedProvisioning: storedProjection,
        }),
      ],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    const config = resolveScenarioWhatsAppInteractiveFlowTarget(
      merged.data
    )?.config;
    expect(config?.managedProvisioning).toEqual(storedProjection);
    expect(config?.metaFlowId).toBeUndefined();
    expect(config?.metaFlowName).toBeUndefined();
    expect(config?.metaFlowStatus).toBeUndefined();
  });

  it("does not copy a projection from a missing stored node", () => {
    const incomingConfig = flowConfig({
      managedProvisioning: projection(flowConfig()),
    });

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [templateNode("action-new", incomingConfig)],
      storedNodes: [],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    expect(resolvedProjection(merged)).toBeUndefined();
  });

  it("does not move a projection between template and service-message owners", () => {
    const editable = flowConfig();
    const storedProjection = projection(editable);

    const [merged] = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: [serviceMessageNode("action-1", editable)],
      storedNodes: [
        templateNode("action-1", {
          ...editable,
          managedProvisioning: storedProjection,
        }),
      ],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
    });

    expect(resolvedProjection(merged)).toBeUndefined();
  });

  it("excludes managed, provider-reference, and legacy metadata from editable digests", () => {
    const editable = flowConfig();
    const digest = createWhatsAppFlowEditableContentDigest(editable);

    expect(
      createWhatsAppFlowEditableContentDigest({
        ...editable,
        metaFlowId: "legacy-id",
        metaFlowName: "legacy-name",
        metaFlowStatus: "PUBLISHED",
        managedProvisioning: projection(editable),
        providerReference: providerReference(),
      })
    ).toBe(digest);
  });

  it("treats omitted and undefined optional fields as the same persisted content", () => {
    const editable = flowConfig();

    expect(
      createWhatsAppFlowEditableContentDigest({
        ...editable,
        bodyText: undefined,
        screens: editable.screens.map(screen => ({
          ...screen,
          fields: screen.fields.map(field => ({
            ...field,
            helperText: undefined,
          })),
        })),
      })
    ).toBe(createWhatsAppFlowEditableContentDigest(editable));
  });
});

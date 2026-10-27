const mockGetMetaWhatsAppFlow = jest.fn();
const mockIsMetaWhatsAppFlowOwnedByWaba = jest.fn();
const mockMutateScenarioGraphWithCas = jest.fn();
const mockAcquireSourceFence = jest.fn();
const mockAssertSourceFence = jest.fn();
const mockReleaseSourceFence = jest.fn();
const mockGetEndpointSecurityStatus = jest.fn();

jest.mock("@/lib/whatsapp/flows/service", () => ({
  getMetaWhatsAppFlow: (...args: unknown[]) => mockGetMetaWhatsAppFlow(...args),
  isMetaWhatsAppFlowOwnedByWaba: (...args: unknown[]) =>
    mockIsMetaWhatsAppFlowOwnedByWaba(...args),
}));

jest.mock("@/lib/scenarios/scenario-graph-mutation", () => ({
  mutateScenarioGraphWithCas: (...args: unknown[]) =>
    mockMutateScenarioGraphWithCas(...args),
}));

jest.mock("@/lib/whatsapp/flows/source-binding-fence-store", () => ({
  WhatsAppFlowSourceBindingFenceConflictError: class extends Error {},
  whatsAppFlowSourceBindingFenceStore: {
    acquire: (...args: unknown[]) => mockAcquireSourceFence(...args),
    assertCurrent: (...args: unknown[]) => mockAssertSourceFence(...args),
    release: (...args: unknown[]) => mockReleaseSourceFence(...args),
  },
}));

jest.mock("@/lib/whatsapp/flows/endpoint-security-service", () => ({
  getWhatsAppFlowEndpointSecurityStatus: (...args: unknown[]) =>
    mockGetEndpointSecurityStatus(...args),
}));

import { buildFlowBranchSourceHandleId } from "@icecore/scenario-contracts";

import { attachWhatsAppFlowProviderReference } from "./provider-reference-service";
import { WhatsAppFlowSourceBindingFenceConflictError } from "./source-binding-fence-store";

const SOURCE_FENCE_LEASE = {
  sourceId: "source-1",
  workspaceId: "workspace-1",
  expectedWabaId: "waba-1",
  kind: "PROVISIONING",
  semanticOperationId: "provider-reference:operation-1",
  ownerToken: "owner-token-1",
  fence: 7,
  leaseExpiresAt: new Date("2026-08-05T10:02:00.000Z"),
};

const META_FLOW = {
  id: "flow-1",
  name: "Appointment",
  status: "PUBLISHED",
  json_version: "7.3",
  data_api_version: "3.0",
  endpoint_uri: "https://example.com/flows",
  whatsapp_business_account: { id: "waba-1" },
  validation_errors: [],
};

const META_FLOW_JSON = {
  version: "7.3",
  data_api_version: "3.0",
  routing_model: {
    APPOINTMENT: ["DETAILS"],
    DETAILS: ["SUMMARY"],
    SUMMARY: ["TERMS"],
    TERMS: [],
  },
  screens: [
    {
      id: "APPOINTMENT",
      title: "Choose appointment",
      data: {
        city: {
          type: "array",
          __example__: [{ id: "astana", title: "Astana" }],
        },
      },
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "Form",
            name: "appointment",
            children: [
              {
                type: "Dropdown",
                name: "city",
                label: "City",
                "data-source": "${data.city}",
                "on-select-action": { name: "data_exchange", payload: {} },
              },
            ],
          },
        ],
      },
    },
    {
      id: "DETAILS",
      title: "Your details",
      data: {},
      layout: { type: "SingleColumnLayout", children: [] },
    },
    {
      id: "SUMMARY",
      title: "Summary",
      terminal: true,
      data: {},
      layout: {
        type: "SingleColumnLayout",
        children: [
          { type: "TextHeading", text: "Confirm appointment" },
          {
            type: "OptIn",
            name: "terms",
            label: "I accept",
            "on-click-action": {
              name: "navigate",
              next: { type: "screen", name: "TERMS" },
            },
          },
        ],
      },
    },
    {
      id: "TERMS",
      title: "Terms",
      data: {},
      layout: {
        type: "SingleColumnLayout",
        children: [{ type: "TextBody", text: "Terms and conditions" }],
      },
    },
  ],
};

const CURRENT_FLOW_CONFIG = {
  templateId: "lead_generation",
  screens: [{ id: "OLD", title: "Old", fields: [] }],
  ctaText: "Book now",
  headerText: "Booking",
  bodyText: "Choose a slot",
};

function serviceInput() {
  return {
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scenarioId: "scenario-1",
    nodeId: "action-1",
    flowId: "flow-1",
    expectedUpdatedAt: "2026-08-05T10:00:00.000Z",
    accessToken: "token-1",
    phoneNumberId: "phone-1",
    wabaId: "waba-1",
    applicationId: "application-1",
    updatedBy: "user-1",
  };
}

function serviceFlowNode() {
  return {
    id: "action-1",
    data: {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Complete the form" },
          flowConfig: CURRENT_FLOW_CONFIG,
        },
      },
    },
  };
}

describe("WhatsApp provider Flow reference service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMetaWhatsAppFlow.mockResolvedValue({
      ok: true,
      status: 200,
      flow: META_FLOW,
      flowJson: META_FLOW_JSON,
      flowJsonError: null,
    });
    mockIsMetaWhatsAppFlowOwnedByWaba.mockReturnValue(true);
    mockAcquireSourceFence.mockResolvedValue(SOURCE_FENCE_LEASE);
    mockAssertSourceFence.mockResolvedValue({});
    mockReleaseSourceFence.mockResolvedValue(undefined);
    mockGetEndpointSecurityStatus.mockResolvedValue({
      configured: false,
      endpointUri: null,
    });
  });

  it("verifies provider ownership then atomically attaches the exact source-bound reference", async () => {
    const node = serviceFlowNode();
    mockMutateScenarioGraphWithCas.mockImplementation(
      async (params: {
        project: (snapshot: { nodes: unknown[]; edges: unknown[] }) => {
          changed: boolean;
          nodes?: unknown[];
          value: unknown;
        };
      }) => {
        const projection = params.project({ nodes: [node], edges: [] });
        return {
          status: projection.changed ? "updated" : "unchanged",
          value: projection.value,
          previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
          scenarioUpdatedAt: "2026-08-05T10:00:01.000Z",
        };
      }
    );

    const result = await attachWhatsAppFlowProviderReference(serviceInput());

    expect(result).toMatchObject({
      ok: true,
      previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:00:01.000Z",
      flowConfig: {
        templateId: "provider_reference",
        ctaText: "Book now",
        headerText: "Booking",
        bodyText: "Choose a slot",
        flowNavigationMode: "data_endpoint",
        screens: [
          { id: "APPOINTMENT", title: "Choose appointment", fields: [] },
          { id: "DETAILS", title: "Your details", fields: [] },
          { id: "SUMMARY", title: "Summary", fields: [] },
          { id: "TERMS", title: "Terms", fields: [] },
        ],
        providerReference: {
          flowId: "flow-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          flowName: "Appointment",
          providerStatus: "PUBLISHED",
          jsonVersion: "7.3",
          dataApiVersion: "3.0",
        },
      },
    });
    expect(mockGetMetaWhatsAppFlow).toHaveBeenCalledWith({
      accessToken: "token-1",
      flowId: "flow-1",
      phoneNumberId: "phone-1",
      includeJson: true,
      expectedWabaId: "waba-1",
    });
    expect(mockIsMetaWhatsAppFlowOwnedByWaba).toHaveBeenCalledWith(
      META_FLOW,
      "waba-1"
    );
    expect(mockMutateScenarioGraphWithCas).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        expectedUpdatedAt: "2026-08-05T10:00:00.000Z",
        updatedBy: "user-1",
      })
    );
    expect(mockAcquireSourceFence).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      kind: "PROVISIONING",
      semanticOperationId: expect.stringMatching(/^provider-reference:/),
    });
    expect(mockAssertSourceFence).toHaveBeenCalledWith(SOURCE_FENCE_LEASE);
    expect(mockReleaseSourceFence).toHaveBeenCalledWith(SOURCE_FENCE_LEASE);
    expect(mockAcquireSourceFence.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetMetaWhatsAppFlow.mock.invocationCallOrder[0]!
    );
    expect(mockGetMetaWhatsAppFlow.mock.invocationCallOrder[0]).toBeLessThan(
      mockAssertSourceFence.mock.invocationCallOrder[0]!
    );
    expect(mockAssertSourceFence.mock.invocationCallOrder[0]).toBeLessThan(
      mockMutateScenarioGraphWithCas.mock.invocationCallOrder[0]!
    );
    expect(
      mockMutateScenarioGraphWithCas.mock.invocationCallOrder[0]
    ).toBeLessThan(mockReleaseSourceFence.mock.invocationCallOrder[0]!);

    const mutation = mockMutateScenarioGraphWithCas.mock.calls[0]?.[0];
    const projected = mutation.project({ nodes: [node], edges: [] });
    const persistedConfig =
      projected.nodes[0].data.actionWhatsAppServiceMessage.message.flowConfig;
    expect(persistedConfig.providerReference.flowId).toBe("flow-1");
    expect(persistedConfig.screens[0]).toEqual({
      id: "APPOINTMENT",
      title: "Choose appointment",
      fields: [],
    });
  });

  it("names the linked form in variables: the step's own key, else one from the Flow name", async () => {
    const otherForm = {
      id: "other",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionFlowConfig: {
          templateId: "provider_reference",
          screens: [],
          ctaText: "Open",
          answersKey: "appointment",
          providerReference: {
            flowId: "flow-2",
            sourceId: "source-1",
            wabaId: "waba-1",
            flowName: "Appointment",
          },
        },
      },
    };
    const attachTo = async (nodes: unknown[]) => {
      mockMutateScenarioGraphWithCas.mockImplementationOnce(
        async (params: {
          project: (snapshot: { nodes: unknown[]; edges: unknown[] }) => {
            changed: boolean;
            value: unknown;
          };
        }) => ({
          status: "updated",
          value: params.project({ nodes, edges: [] }).value,
          previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
          scenarioUpdatedAt: "2026-08-05T10:00:01.000Z",
        })
      );
      const result = await attachWhatsAppFlowProviderReference(serviceInput());
      return result.ok ? result.flowConfig.answersKey : null;
    };

    // A step without a form yet gets a new key, clear of the other form's.
    await expect(attachTo([serviceFlowNode(), otherForm])).resolves.toBe(
      "appointment_2"
    );

    // Linking another Flow to a step that had a form keeps its variables.
    const named = serviceFlowNode();
    named.data.actionWhatsAppServiceMessage.message.flowConfig = {
      ...CURRENT_FLOW_CONFIG,
      screens: [
        {
          id: "OLD",
          title: "Old",
          fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
        },
      ],
      answersKey: "booking",
    } as unknown as typeof CURRENT_FLOW_CONFIG;
    await expect(attachTo([named, otherForm])).resolves.toBe("booking");
  });

  it("fails closed before graph mutation when Meta does not confirm ownership", async () => {
    mockIsMetaWhatsAppFlowOwnedByWaba.mockReturnValueOnce(false);

    await expect(
      attachWhatsAppFlowProviderReference(serviceInput())
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "FLOW_NOT_OWNED",
        message: "Flow does not belong to this WhatsApp Business Account",
        retryable: false,
      },
    });
    expect(mockMutateScenarioGraphWithCas).not.toHaveBeenCalled();
    expect(mockReleaseSourceFence).toHaveBeenCalledWith(SOURCE_FENCE_LEASE);
  });

  it("fails closed when the source binding changes after Meta verification and before graph CAS", async () => {
    mockAssertSourceFence.mockRejectedValueOnce(
      new WhatsAppFlowSourceBindingFenceConflictError()
    );

    await expect(
      attachWhatsAppFlowProviderReference(serviceInput())
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "SOURCE_BINDING_CHANGED",
        message: "WhatsApp source binding changed; refresh and retry",
        retryable: false,
      },
    });

    expect(mockGetMetaWhatsAppFlow).toHaveBeenCalledTimes(1);
    expect(mockAssertSourceFence).toHaveBeenCalledWith(SOURCE_FENCE_LEASE);
    expect(mockMutateScenarioGraphWithCas).not.toHaveBeenCalled();
    expect(mockReleaseSourceFence).toHaveBeenCalledWith(SOURCE_FENCE_LEASE);
    expect(mockGetMetaWhatsAppFlow.mock.invocationCallOrder[0]).toBeLessThan(
      mockAssertSourceFence.mock.invocationCallOrder[0]!
    );
  });

  it("does not call Meta when the exact source and WABA fence cannot be acquired", async () => {
    mockAcquireSourceFence.mockRejectedValueOnce(
      new WhatsAppFlowSourceBindingFenceConflictError()
    );

    await expect(
      attachWhatsAppFlowProviderReference(serviceInput())
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "SOURCE_BINDING_CHANGED" },
    });

    expect(mockGetMetaWhatsAppFlow).not.toHaveBeenCalled();
    expect(mockMutateScenarioGraphWithCas).not.toHaveBeenCalled();
    expect(mockReleaseSourceFence).not.toHaveBeenCalled();
  });

  it("rejects provider-only attachment when Meta points the Flow at this app's managed endpoint", async () => {
    const managedEndpointUri =
      "https://public.example/api/webhooks/whatsapp/flow-endpoint/endpoint-1";
    mockGetMetaWhatsAppFlow.mockResolvedValueOnce({
      ok: true,
      status: 200,
      flow: { ...META_FLOW, endpoint_uri: `${managedEndpointUri}/?ignored=1` },
      flowJson: META_FLOW_JSON,
      flowJsonError: null,
    });
    mockGetEndpointSecurityStatus.mockResolvedValueOnce({
      configured: true,
      endpointUri: managedEndpointUri,
    });

    await expect(
      attachWhatsAppFlowProviderReference(serviceInput())
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "MANAGED_ENDPOINT_INCOMPATIBLE",
        message:
          "This Flow uses airi.chat's managed endpoint and cannot be attached as a provider-managed reference",
        retryable: false,
      },
    });

    expect(mockGetEndpointSecurityStatus).toHaveBeenCalledWith({
      context: {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        applicationId: "application-1",
        accessToken: "token-1",
      },
    });
    expect(mockMutateScenarioGraphWithCas).not.toHaveBeenCalled();
    expect(mockReleaseSourceFence).toHaveBeenCalledWith(SOURCE_FENCE_LEASE);
  });

  it("allows a provider Flow that uses a different external endpoint", async () => {
    const node = serviceFlowNode();
    mockGetEndpointSecurityStatus.mockResolvedValueOnce({
      configured: true,
      endpointUri:
        "https://public.example/api/webhooks/whatsapp/flow-endpoint/endpoint-1",
    });
    mockMutateScenarioGraphWithCas.mockImplementation(
      async (params: {
        project: (snapshot: {
          status: "draft";
          nodes: unknown[];
          edges: unknown[];
        }) => { changed: boolean; value: unknown };
      }) => {
        const projection = params.project({
          status: "draft",
          nodes: [node],
          edges: [],
        });
        return {
          status: "updated",
          value: projection.value,
          previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
          scenarioUpdatedAt: "2026-08-05T10:00:01.000Z",
        };
      }
    );

    await expect(
      attachWhatsAppFlowProviderReference(serviceInput())
    ).resolves.toMatchObject({ ok: true });
  });

  it("preserves presentation from the canonical service owner when stale template state coexists", async () => {
    const node = {
      ...serviceFlowNode(),
      data: {
        ...serviceFlowNode().data,
        actionFlowConfig: {
          ...CURRENT_FLOW_CONFIG,
          ctaText: "Stale template CTA",
        },
      },
    };
    mockMutateScenarioGraphWithCas.mockImplementation(
      async (params: {
        project: (snapshot: { nodes: unknown[]; edges: unknown[] }) => {
          changed: boolean;
          value: unknown;
        };
      }) => {
        const projection = params.project({ nodes: [node], edges: [] });
        return {
          status: "updated",
          value: projection.value,
          previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
          scenarioUpdatedAt: "2026-08-05T10:00:01.000Z",
        };
      }
    );

    const result = await attachWhatsAppFlowProviderReference(serviceInput());

    expect(result).toMatchObject({
      ok: true,
      flowConfig: { ctaText: "Book now" },
    });
  });

  it("returns the current revision when the expected scenario revision is stale", async () => {
    mockMutateScenarioGraphWithCas.mockResolvedValueOnce({
      status: "conflict",
      previousScenarioUpdatedAt: "2026-08-05T10:01:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:01:00.000Z",
    });

    await expect(
      attachWhatsAppFlowProviderReference(serviceInput())
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "SCENARIO_REVISION_CONFLICT",
        message: "Scenario changed; refresh before attaching this Flow",
        retryable: false,
      },
      previousScenarioUpdatedAt: "2026-08-05T10:01:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:01:00.000Z",
    });
  });

  it("atomically rejects a non-published Flow when the scenario is active", async () => {
    const node = serviceFlowNode();
    mockGetMetaWhatsAppFlow.mockResolvedValueOnce({
      ok: true,
      status: 200,
      flow: { ...META_FLOW, status: "DRAFT" },
      flowJson: META_FLOW_JSON,
      flowJsonError: null,
    });
    mockMutateScenarioGraphWithCas.mockImplementation(
      async (params: {
        project: (snapshot: {
          status: "draft" | "active";
          nodes: unknown[];
          edges: unknown[];
        }) => { changed: boolean; value: unknown };
      }) => {
        const projection = params.project({
          status: "active",
          nodes: [node],
          edges: [],
        });
        expect(projection.changed).toBe(false);
        return {
          status: "unchanged",
          value: projection.value,
          previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
          scenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
        };
      }
    );

    await expect(
      attachWhatsAppFlowProviderReference(serviceInput())
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "ACTIVE_SCENARIO_REQUIRES_PUBLISHED_FLOW",
        message: "Active scenarios can only attach a PUBLISHED WhatsApp Flow",
        retryable: false,
      },
      previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
    });
  });

  it("preserves read-only draft Flow attachment for draft scenarios", async () => {
    const node = serviceFlowNode();
    mockGetMetaWhatsAppFlow.mockResolvedValueOnce({
      ok: true,
      status: 200,
      flow: { ...META_FLOW, status: "DRAFT" },
      flowJson: META_FLOW_JSON,
      flowJsonError: null,
    });
    mockMutateScenarioGraphWithCas.mockImplementation(
      async (params: {
        project: (snapshot: {
          status: "draft" | "active";
          nodes: unknown[];
          edges: unknown[];
        }) => { changed: boolean; nodes?: unknown[]; value: unknown };
      }) => {
        const projection = params.project({
          status: "draft",
          nodes: [node],
          edges: [],
        });
        return {
          status: projection.changed ? "updated" : "unchanged",
          value: projection.value,
          previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
          scenarioUpdatedAt: "2026-08-05T10:00:01.000Z",
        };
      }
    );

    await expect(
      attachWhatsAppFlowProviderReference(serviceInput())
    ).resolves.toMatchObject({
      ok: true,
      flowConfig: {
        providerReference: {
          flowId: "flow-1",
          providerStatus: "DRAFT",
        },
      },
    });
  });

  it("fails closed instead of rebinding existing option branches to a provider shell", async () => {
    const node = serviceFlowNode();
    const branchTarget = {
      id: "branch-target",
      data: {
        kind: "action",
        actionType: "reply",
        flowBranchSourceFieldId: "appointment_type",
        flowBranchOptionId: "consultation",
        flowBranchOptionLabel: "Consultation",
      },
    };
    const branchEdge = {
      id: "branch-edge",
      source: "action-1",
      sourceHandle: buildFlowBranchSourceHandleId(
        "appointment_type",
        "consultation"
      ),
      target: "branch-target",
      targetHandle: "left-target",
    };
    mockMutateScenarioGraphWithCas.mockImplementation(
      async (params: {
        project: (snapshot: {
          status: "draft" | "active";
          nodes: unknown[];
          edges: unknown[];
        }) => { changed: boolean; value: unknown };
      }) => {
        const projection = params.project({
          status: "draft",
          nodes: [node, branchTarget],
          edges: [branchEdge],
        });
        expect(projection.changed).toBe(false);
        return {
          status: "unchanged",
          value: projection.value,
          previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
          scenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
        };
      }
    );

    await expect(
      attachWhatsAppFlowProviderReference(serviceInput())
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "FLOW_BRANCHES_CONNECTED",
        message:
          "Disconnect existing WhatsApp Flow branches before attaching a provider Flow",
        retryable: false,
      },
      previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
    });
  });
});

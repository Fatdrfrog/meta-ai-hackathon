/**
 * @jest-environment jsdom
 */

import { TextEncoder } from "node:util";
import { deserialize, serialize } from "node:v8";

Object.defineProperty(globalThis, "TextEncoder", {
  configurable: true,
  value: TextEncoder,
});
Object.defineProperty(globalThis, "structuredClone", {
  configurable: true,
  value: <T,>(value: T): T => deserialize(serialize(value)) as T,
});

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img {...props} alt={props.alt ?? ""} />
  ),
}));
jest.mock("./field-editor", () => ({
  FieldEditor: ({ validationMode }: { validationMode?: string }) => (
    <div data-testid="field-editor" data-validation-mode={validationMode} />
  ),
  FlowFormEditorContent: ({ validationMode }: { validationMode?: string }) => (
    <div data-testid="flow-form-editor" data-validation-mode={validationMode} />
  ),
}));
jest.mock("./flow-builder-header-meta", () => ({
  getFlowBuilderHeaderMeta: (config: WhatsAppFlowConfig | null) => ({
    displayFlowName: config?.providerReference?.flowName ?? "Flow",
    displayFlowStatus:
      config?.providerReference?.providerStatus ??
      config?.managedProvisioning?.providerStatus ??
      null,
    hasUnpublishedChanges: Boolean(config?.managedProvisioning),
  }),
}));
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { ManagedWhatsAppFlowProvisioningHost } from "./managed-provisioning-host";
import { FlowBuilder } from "./flow-builder";

function flowConfig(
  overrides: Partial<WhatsAppFlowConfig> = {}
): WhatsAppFlowConfig {
  return {
    templateId: "appointment_booking",
    ctaText: "Book",
    headerText: "Appointment",
    flowNavigationMode: "data_endpoint",
    screens: [
      {
        id: "DETAILS",
        title: "Details",
        fields: [
          {
            id: "name",
            label: "Name",
            fieldType: "TextInput",
            required: true,
          },
        ],
      },
      { id: "CONFIRM", title: "Confirm", fields: [] },
    ],
    screenRoutes: { DETAILS: ["CONFIRM"] },
    ...overrides,
  };
}

function host(
  overrides: Partial<ManagedWhatsAppFlowProvisioningHost> = {}
): ManagedWhatsAppFlowProvisioningHost {
  return {
    ownerKey: "scenario-1:node-1:visit-1",
    sources: [{ id: "source-1", label: "WhatsApp primary" }],
    publishing: false,
    publish: jest.fn().mockResolvedValue({
      response: { ok: true, status: 200, data: successResult() },
      adopted: true,
    }),
    ...overrides,
  };
}

function successResult() {
  return {
    ok: true as const,
    operationId: "operation-1",
    status: "COMPLETED" as const,
    stage: "COMPLETED" as const,
    projection: {
      operationId: "operation-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      contentRevision: 1,
      contentDigest: "a".repeat(64),
      flowId: "flow-1",
      providerStatus: "PUBLISHED" as const,
    },
    scenarioRevision: {
      finalUpdatedAt: "2026-08-08T10:00:01.000Z",
    },
    phones: [],
    validationErrors: [] as [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("FlowBuilder publish lifecycle", () => {
  it("validates an explicit provider publication even while the scenario is a draft", () => {
    const managedHost = host();
    render(
      <FlowBuilder
        flowConfig={flowConfig({
          screens: [
            {
              id: "DETAILS",
              title: "Details",
              fields: [{ id: "name", label: "", fieldType: "TextInput" }],
            },
          ],
          flowNavigationMode: undefined,
          screenRoutes: undefined,
        })}
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={managedHost}
        validationMode="draft"
      />
    );
    expect(
      screen.getByTestId("field-editor").getAttribute("data-validation-mode")
    ).toBe("draft");
    fireEvent.click(screen.getByRole("button", { name: "flowSaveButton" }));
    expect(
      screen.getByTestId("field-editor").getAttribute("data-validation-mode")
    ).toBe("runnable");
    expect(managedHost.publish).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists endpoint content then calls exactly one managed provisioning boundary", async () => {
    const managedHost = host();
    const onFlowArtifactsChanged = jest.fn();
    render(
      <FlowBuilder
        flowConfig={flowConfig({
          metaFlowId: "browser-owned-id",
          metaFlowStatus: "PUBLISHED",
        })}
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={managedHost}
        onFlowArtifactsChanged={onFlowArtifactsChanged}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "flowSaveButton" }));

    await waitFor(() =>
      expect(onFlowArtifactsChanged).toHaveBeenCalledTimes(1)
    );
    expect(managedHost.publish).toHaveBeenCalledWith({
      sourceId: "source-1",
      editableConfig: expect.not.objectContaining({
        metaFlowId: expect.anything(),
        metaFlowStatus: expect.anything(),
      }),
    });
    expect(managedHost.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        editableConfig: expect.objectContaining({
          flowNavigationMode: "data_endpoint",
        }),
      })
    );
    expect(screen.getByRole("button", { name: "flowSaved" })).toBeTruthy();
  });

  it("admits only one save attempt before React can render the disabled state", async () => {
    const prepared = deferred<{
      response: {
        ok: true;
        status: number;
        data: ReturnType<typeof successResult>;
      };
      adopted: true;
    }>();
    const managedHost = host({
      publish: jest.fn().mockReturnValue(prepared.promise),
    });
    render(
      <FlowBuilder
        flowConfig={flowConfig()}
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={managedHost}
      />
    );

    const saveButton = screen.getByRole("button", { name: "flowSaveButton" });
    act(() => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(managedHost.publish).toHaveBeenCalledTimes(1);
    await act(async () => {
      prepared.resolve({
        response: { ok: true, status: 200, data: successResult() },
        adopted: true,
      });
      await prepared.promise;
    });
    expect(managedHost.publish).toHaveBeenCalledTimes(1);
  });

  it("uses the document host adoption decision after an in-flight content edit", async () => {
    const prepared = deferred<{
      response: {
        ok: true;
        status: number;
        data: ReturnType<typeof successResult>;
      };
      adopted: true;
    }>();
    const managedHost = host({
      publish: jest.fn().mockReturnValue(prepared.promise),
    });
    const initialConfig = flowConfig({ bodyText: "Original body" });
    const props = {
      onFlowConfigChange: jest.fn(),
      workspaceId: "workspace-1",
      managedProvisioningHost: managedHost,
    };
    const { rerender } = render(
      <FlowBuilder flowConfig={initialConfig} {...props} />
    );

    fireEvent.click(screen.getByRole("button", { name: "flowSaveButton" }));
    await waitFor(() => expect(managedHost.publish).toHaveBeenCalledTimes(1));
    rerender(
      <FlowBuilder
        flowConfig={{
          ...initialConfig,
          bodyText: "Changed body",
          ctaText: "Changed CTA",
        }}
        {...props}
      />
    );
    await act(async () => {
      prepared.resolve({
        response: { ok: true, status: 200, data: successResult() },
        adopted: true,
      });
      await prepared.promise;
    });

    await waitFor(() => expect(screen.getByText("flowSaved")).toBeTruthy());
    expect(managedHost.publish).toHaveBeenCalledTimes(1);
  });

  it("drops legacy provider identity when selecting a stock template", () => {
    const onFlowConfigChange = jest.fn();
    render(
      <FlowBuilder
        flowConfig={flowConfig({
          templateId: "",
          metaFlowId: "legacy-flow",
          metaFlowName: "Legacy flow",
          metaFlowStatus: "PUBLISHED",
        })}
        onFlowConfigChange={onFlowConfigChange}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "flowTemplateLeadGenTitle" })
    );

    expect(onFlowConfigChange).toHaveBeenCalledWith(
      expect.not.objectContaining({
        metaFlowId: expect.anything(),
        metaFlowName: expect.anything(),
        metaFlowStatus: expect.anything(),
      })
    );
  });

  it("drops legacy provider identity when resetting the selected template", () => {
    const onFlowConfigChange = jest.fn();
    render(
      <FlowBuilder
        flowConfig={flowConfig({
          metaFlowId: "legacy-flow",
          metaFlowName: "Legacy flow",
          metaFlowStatus: "PUBLISHED",
        })}
        onFlowConfigChange={onFlowConfigChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "flowChangeTemplate" }));
    fireEvent.click(
      screen.getByRole("button", { name: "flowChangeTemplateYes" })
    );

    expect(onFlowConfigChange).toHaveBeenLastCalledWith(
      expect.not.objectContaining({
        metaFlowId: expect.anything(),
        metaFlowName: expect.anything(),
        metaFlowStatus: expect.anything(),
      })
    );
  });

  it("routes a scenario-bound linear Flow through the same durable provisioning boundary", async () => {
    const managedHost = host();
    const onFlowArtifactsChanged = jest.fn();
    render(
      <FlowBuilder
        flowConfig={flowConfig({
          flowNavigationMode: "linear",
          screens: [{ id: "LEAD_FORM", title: "Lead form", fields: [] }],
          screenRoutes: undefined,
          metaFlowId: "legacy-flow-id",
          metaFlowStatus: "PUBLISHED",
        })}
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={managedHost}
        onFlowArtifactsChanged={onFlowArtifactsChanged}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "flowSaveButton" }));

    await waitFor(() =>
      expect(onFlowArtifactsChanged).toHaveBeenCalledTimes(1)
    );
    expect(managedHost.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        editableConfig: expect.not.objectContaining({
          flowNavigationMode: "data_endpoint",
        }),
      })
    );
  });

  it("pins an existing managed Flow to its provisioning source", async () => {
    const managedHost = host({
      sources: [
        { id: "source-1", label: "WhatsApp primary" },
        { id: "source-2", label: "WhatsApp secondary" },
      ],
    });
    const onFlowArtifactsChanged = jest.fn();
    render(
      <FlowBuilder
        flowConfig={flowConfig({
          managedProvisioning: {
            operationId: "operation-2",
            sourceId: "source-2",
            wabaId: "waba-2",
            contentRevision: 2,
            contentDigest: "b".repeat(64),
            flowId: "flow-2",
            providerStatus: "PUBLISHED",
          },
        })}
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={managedHost}
        onFlowArtifactsChanged={onFlowArtifactsChanged}
      />
    );

    const sourceSelect = screen.getByLabelText(
      "flowManagedSourceLabel"
    ) as HTMLSelectElement;
    expect(sourceSelect.value).toBe("source-2");
    expect(sourceSelect.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "flowSaveButton" }));

    await waitFor(() =>
      expect(onFlowArtifactsChanged).toHaveBeenCalledTimes(1)
    );
    expect(managedHost.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "source-2" })
    );
  });

  it("shows unpublished local changes separately from the published provider artifact", () => {
    render(
      <FlowBuilder
        flowConfig={flowConfig({
          managedProvisioning: {
            operationId: "operation-2",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 2,
            contentDigest: "b".repeat(64),
            flowId: "flow-2",
            providerStatus: "PUBLISHED",
          },
        })}
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={host()}
      />
    );

    // Published is the normal state and gets no badge.
    expect(screen.queryByText("PUBLISHED")).toBeNull();
    expect(screen.queryByText("flowStatusDraft")).toBeNull();
    expect(screen.getByText("flowUnpublishedChanges")).toBeTruthy();
  });

  it("names an unpublished form status in the header", () => {
    render(
      <FlowBuilder
        flowConfig={
          flowConfig({
            managedProvisioning: {
              operationId: "operation-3",
              sourceId: "source-1",
              wabaId: "waba-1",
              contentRevision: 1,
              contentDigest: "c".repeat(64),
              flowId: "flow-3",
              providerStatus: "DRAFT",
            },
          } as Partial<WhatsAppFlowConfig>) as WhatsAppFlowConfig
        }
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={host()}
      />
    );

    expect(screen.getByText("flowStatusDraft")).toBeTruthy();
    expect(screen.queryByText("DRAFT")).toBeNull();
  });

  it("keeps Meta version details behind a Details popover", async () => {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const previous = global.ResizeObserver;
    global.ResizeObserver =
      MockResizeObserver as unknown as typeof global.ResizeObserver;
    try {
      render(
        <FlowBuilder
          flowConfig={
            {
              ...flowConfig(),
              providerReference: {
                flowId: "flow-provider",
                sourceId: "source-1",
                wabaId: "waba-1",
                flowName: "Meta appointment Flow",
                providerStatus: "PUBLISHED",
                jsonVersion: "7.3",
                dataApiVersion: "3.0",
              },
            } as WhatsAppFlowConfig
          }
          onFlowConfigChange={jest.fn()}
        />
      );

      expect(screen.queryByText(/Flow JSON/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "flowDetails" }));
      expect(await screen.findByText("Flow JSON 7.3")).toBeTruthy();
      expect(screen.getByText("Data API 3.0")).toBeTruthy();
    } finally {
      global.ResizeObserver = previous;
    }
  });

  it("blocks publishing when the managed provisioning source is unavailable", () => {
    const managedHost = host();
    render(
      <FlowBuilder
        flowConfig={flowConfig({
          managedProvisioning: {
            operationId: "operation-2",
            sourceId: "source-2",
            wabaId: "waba-2",
            contentRevision: 2,
            contentDigest: "b".repeat(64),
            flowId: "flow-2",
            providerStatus: "PUBLISHED",
          },
        })}
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={managedHost}
      />
    );

    expect(
      screen
        .getByRole("button", { name: "flowSaveButton" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(screen.getByText("flowManagedSourceRequired")).toBeTruthy();
    expect(managedHost.publish).not.toHaveBeenCalled();
  });

  it("adopts a persisted BLOCKED reconciliation failure and never displays saved", async () => {
    const managedHost = host();
    const onFlowArtifactsChanged = jest.fn();
    const failure = {
      ok: false as const,
      operationId: "operation-1",
      status: "COMPLETED" as const,
      stage: "READING_BACK" as const,
      projection: {
        operationId: "operation-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        contentRevision: 1,
        contentDigest: "a".repeat(64),
        flowId: "flow-1",
        providerStatus: "BLOCKED" as const,
      },
      scenarioRevision: {
        finalUpdatedAt: "2026-08-08T10:00:01.000Z",
      },
      phones: [],
      validationErrors: [],
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED" as const,
        message: "Meta did not confirm PUBLISHED",
        retryable: true,
      },
    };
    managedHost.publish = jest.fn().mockResolvedValueOnce({
      response: { ok: false, status: 409, data: failure },
      adopted: true,
    });
    render(
      <FlowBuilder
        flowConfig={flowConfig()}
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={managedHost}
        onFlowArtifactsChanged={onFlowArtifactsChanged}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "flowSaveButton" }));

    await waitFor(() =>
      expect(screen.getByText("Meta did not confirm PUBLISHED")).toBeTruthy()
    );
    expect(managedHost.publish).toHaveBeenCalledTimes(1);
    expect(onFlowArtifactsChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "flowSaved" })).toBeNull();
  });

  it("refreshes once after a provider draft failure without adopting a missing projection", async () => {
    const managedHost = host();
    const onFlowArtifactsChanged = jest.fn();
    managedHost.publish = jest.fn().mockResolvedValueOnce({
      response: {
        ok: false,
        status: 409,
        data: {
          ok: false,
          operationId: "operation-draft",
          status: "FAILED",
          stage: "UPLOADING_JSON",
          phones: [],
          validationErrors: [],
          error: {
            code: "WHATSAPP_FLOW_PROVISIONING_JSON_INVALID",
            message: "Meta retained the draft",
            retryable: false,
          },
        },
      },
      adopted: false,
    });
    render(
      <FlowBuilder
        flowConfig={flowConfig()}
        onFlowConfigChange={jest.fn()}
        workspaceId="workspace-1"
        managedProvisioningHost={managedHost}
        onFlowArtifactsChanged={onFlowArtifactsChanged}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "flowSaveButton" }));

    await waitFor(() =>
      expect(screen.getByText("Meta retained the draft")).toBeTruthy()
    );
    expect(managedHost.publish).toHaveBeenCalledTimes(1);
    expect(onFlowArtifactsChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "flowSaved" })).toBeNull();
  });

  it.each(["linear", "data_endpoint"] as const)(
    "hard-stops %s publish outside a persisted scenario host",
    flowNavigationMode => {
      render(
        <FlowBuilder
          flowConfig={flowConfig({ flowNavigationMode })}
          onFlowConfigChange={jest.fn()}
          workspaceId="workspace-1"
        />
      );

      expect(
        screen
          .getByRole("button", { name: "flowSaveButton" })
          .hasAttribute("disabled")
      ).toBe(true);
      expect(screen.getByText("flowManagedScenarioRequired")).toBeTruthy();
    }
  );

  it.each(["full", "inline"] as const)(
    "keeps a Meta-authored provider reference read-only in %s mode",
    renderMode => {
      const onOpenProviderPreview = jest.fn();
      const onFlowConfigChange = jest.fn();
      const managedHost = host({
        sources: [
          { id: "source-1", label: "WhatsApp primary" },
          { id: "source-2", label: "WhatsApp secondary" },
        ],
      });
      const providerReferenceConfig = {
        ...flowConfig(),
        providerReference: {
          flowId: "flow-provider",
          sourceId: "source-1",
          wabaId: "waba-1",
          flowName: "Meta appointment Flow",
          providerStatus: "PUBLISHED" as const,
          jsonVersion: "7.3",
          dataApiVersion: "3.0",
        },
      } as WhatsAppFlowConfig;

      render(
        <FlowBuilder
          flowConfig={providerReferenceConfig}
          onFlowConfigChange={onFlowConfigChange}
          onOpenProviderPreview={onOpenProviderPreview}
          workspaceId="workspace-1"
          managedProvisioningHost={managedHost}
          renderMode={renderMode}
          onInlineClose={renderMode === "inline" ? jest.fn() : undefined}
          templateFlowLanguageCode="ru"
        />
      );

      expect(screen.getByText("flowProviderReferenceTitle")).toBeTruthy();
      expect(screen.getByText("flowProviderReferenceDescription")).toBeTruthy();
      expect(screen.getByText("Meta appointment Flow")).toBeTruthy();
      expect(screen.queryByTestId("field-editor")).toBeNull();
      expect(screen.queryByTestId("flow-form-editor")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "flowSaveButton" })
      ).toBeNull();
      expect(screen.queryByLabelText("flowManagedSourceLabel")).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "flowProviderReferencePreview" })
      );
      expect(onOpenProviderPreview).toHaveBeenCalledWith("flow-provider");
      expect(onFlowConfigChange).not.toHaveBeenCalled();
    }
  );

  it.each(["full", "inline"] as const)(
    "does not offer a replacement Flow when an approved template owns the provider reference in %s mode",
    renderMode => {
      render(
        <FlowBuilder
          flowConfig={flowConfig({
            providerReference: {
              flowId: "flow-provider",
              sourceId: "source-1",
              wabaId: "waba-1",
              flowName: "Template appointment Flow",
              providerStatus: "PUBLISHED",
            },
          })}
          onFlowConfigChange={jest.fn()}
          existingFlows={[
            {
              id: "flow-provider",
              name: "Template appointment Flow",
              sourceId: "source-1",
            },
            {
              id: "other-flow",
              name: "Unrelated Flow",
              sourceId: "source-1",
            },
          ]}
          onSelectExistingFlow={jest.fn()}
          templateEmbeddedFlowId="flow-provider"
          renderMode={renderMode}
          onInlineClose={renderMode === "inline" ? jest.fn() : undefined}
        />
      );

      expect(screen.getByText("flowTemplateOwnedDescription")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "flowProviderReferenceChange" })
      ).toBeNull();
      expect(screen.queryByText("Unrelated Flow")).toBeNull();
    }
  );
});

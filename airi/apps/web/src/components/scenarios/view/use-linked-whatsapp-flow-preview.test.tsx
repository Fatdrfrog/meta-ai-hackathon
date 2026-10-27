/**
 * @jest-environment jsdom
 */

import type {
  TranslateFn,
  WhatsAppFlowConfig,
} from "@/components/scenarios/types";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ScenarioWhatsAppFlowOption } from "../types";
import { useLinkedWhatsAppFlowPreview } from "./use-linked-whatsapp-flow-preview";

const mockFetchScenarioWhatsAppFlowDetails = jest.fn();

jest.mock("@/lib/scenarios/client", () => ({
  fetchScenarioWhatsAppFlowDetails: (...args: unknown[]) =>
    mockFetchScenarioWhatsAppFlowDetails(...args),
}));

const EXISTING_CONFIG: WhatsAppFlowConfig = {
  templateId: "existing_flow",
  ctaText: "Open",
  screens: [
    {
      id: "LEAD_FORM",
      title: "Lead form",
      fields: [],
    },
  ],
  metaFlowId: "flow-1",
  metaFlowName: "Provider Flow",
  metaFlowStatus: "PUBLISHED",
};

const WHATSAPP_FLOWS: ScenarioWhatsAppFlowOption[] = [
  {
    id: "flow-1",
    name: "Provider Flow",
    sourceId: "source-1",
    status: "PUBLISHED",
  },
];

const translate = ((key: string) => key) as TranslateFn;

function deferredPreview(flowId: string) {
  const details = {
    flow: {
      id: flowId,
      name: flowId,
      status: "PUBLISHED",
      preview: { preview_url: `https://example.com/preview/${flowId}` },
    },
    flowJson: null,
    flowJsonError: null,
  };
  let resolve!: (value: typeof details) => void;
  const promise = new Promise<typeof details>(complete => {
    resolve = complete;
  });
  return { promise, complete: () => resolve(details) };
}

function renderLinkedFlowPreview(
  attachWhatsAppFlowProviderReferenceToNode = jest.fn()
) {
  return renderHook(() =>
    useLinkedWhatsAppFlowPreview({
      workspaceId: "workspace-1",
      whatsAppFlows: WHATSAPP_FLOWS,
      attachWhatsAppFlowProviderReferenceToNode,
      t: translate,
    })
  );
}

describe("useLinkedWhatsAppFlowPreview existing Flow selection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps a preview closed when its pending load succeeds", async () => {
    const load = deferredPreview("flow-1");
    mockFetchScenarioWhatsAppFlowDetails.mockReturnValueOnce(load.promise);
    const { result } = renderLinkedFlowPreview();

    act(() => {
      result.current.openLinkedWhatsAppFlowPreview("node-1", "flow-1");
    });
    expect(result.current.linkedFlowPreview.loading).toBe(true);
    act(() => result.current.handleLinkedFlowPreviewOpenChange(false));

    await act(async () => {
      load.complete();
      await load.promise;
    });

    expect(result.current.linkedFlowPreview).toMatchObject({
      open: false,
      loading: false,
      flowId: null,
    });
    expect(result.current.openingLinkedFlowPreview).toBeNull();
  });

  it("keeps the newer preview and its loading state when an older load succeeds", async () => {
    const first = deferredPreview("flow-1");
    const second = deferredPreview("flow-2");
    mockFetchScenarioWhatsAppFlowDetails
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderLinkedFlowPreview();

    act(() => result.current.openLinkedWhatsAppFlowPreview("node-1", "flow-1"));
    act(() => result.current.openLinkedWhatsAppFlowPreview("node-2", "flow-2"));
    await act(async () => {
      first.complete();
      await first.promise;
    });

    expect(result.current.linkedFlowPreview).toMatchObject({
      open: true,
      loading: true,
      flowId: "flow-2",
      previewUrl: null,
    });
    expect(result.current.openingLinkedFlowPreview).toMatchObject({
      nodeId: "node-2",
      flowId: "flow-2",
    });

    await act(async () => {
      second.complete();
      await second.promise;
    });
    expect(result.current.linkedFlowPreview).toMatchObject({
      open: true,
      loading: false,
      flowId: "flow-2",
      previewUrl: "https://example.com/preview/flow-2",
    });
    expect(result.current.openingLinkedFlowPreview).toBeNull();
  });

  it("attaches the exact source-bound provider Flow without locally parsing its JSON", async () => {
    const attachWhatsAppFlowProviderReferenceToNode = jest
      .fn()
      .mockResolvedValue({
        templateId: "provider_reference",
        ctaText: "Open",
        screens: [],
        providerReference: {
          flowId: "flow-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          providerStatus: "PUBLISHED",
        },
      });
    const { result } = renderLinkedFlowPreview(
      attachWhatsAppFlowProviderReferenceToNode
    );

    await act(async () => {
      await result.current.selectExistingFlowForNode(
        "node-1",
        WHATSAPP_FLOWS[0]!
      );
    });

    expect(attachWhatsAppFlowProviderReferenceToNode).toHaveBeenCalledWith({
      nodeId: "node-1",
      sourceId: "source-1",
      flowId: "flow-1",
    });
    expect(mockFetchScenarioWhatsAppFlowDetails).not.toHaveBeenCalled();
  });

  it("does not collapse same-id Flows from different sources during attachment", async () => {
    const attachWhatsAppFlowProviderReferenceToNode = jest
      .fn()
      .mockResolvedValue(EXISTING_CONFIG);
    const secondaryFlow: ScenarioWhatsAppFlowOption = {
      id: "flow-1",
      name: "Provider Flow",
      sourceId: "source-2",
      status: "PUBLISHED",
    };
    const { result } = renderHook(() =>
      useLinkedWhatsAppFlowPreview({
        workspaceId: "workspace-1",
        whatsAppFlows: [...WHATSAPP_FLOWS, secondaryFlow],
        attachWhatsAppFlowProviderReferenceToNode,
        t: translate,
      })
    );

    await act(async () => {
      await result.current.selectExistingFlowForNode("node-1", secondaryFlow);
    });

    expect(attachWhatsAppFlowProviderReferenceToNode).toHaveBeenCalledWith({
      nodeId: "node-1",
      sourceId: "source-2",
      flowId: "flow-1",
    });
  });

  it("hard-stops attachment when the provider source identity is unavailable", async () => {
    const attachWhatsAppFlowProviderReferenceToNode = jest.fn();
    const { result } = renderHook(() =>
      useLinkedWhatsAppFlowPreview({
        workspaceId: "workspace-1",
        whatsAppFlows: [
          { id: "flow-1", name: "Provider Flow", status: "PUBLISHED" },
        ],
        attachWhatsAppFlowProviderReferenceToNode,
        t: translate,
      })
    );

    await act(async () => {
      await expect(
        result.current.selectExistingFlowForNode("node-1", {
          id: "flow-1",
          name: "Provider Flow",
          status: "PUBLISHED",
        })
      ).rejects.toThrow("linkedFlowPreviewLoadFailed");
    });

    expect(attachWhatsAppFlowProviderReferenceToNode).not.toHaveBeenCalled();
  });

  it("offers Meta preview when provider JSON is valid there but not losslessly editable here", async () => {
    mockFetchScenarioWhatsAppFlowDetails.mockResolvedValue({
      flow: {
        id: "flow-1",
        name: "Provider Flow",
        status: "PUBLISHED",
        preview: {
          preview_url:
            "https://business.facebook.com/wa/manage/flows/preview/token",
          expires_at: "2026-09-04T00:00:00.000Z",
        },
      },
      flowJson: {
        version: "7.3",
        data_api_version: "3.0",
        routing_model: { APPOINTMENT: [] },
        screens: [
          {
            id: "APPOINTMENT",
            title: "Appointment",
            terminal: true,
            layout: {
              type: "SingleColumnLayout",
              children: [{ type: "TextHeading", text: "Choose a service" }],
            },
          },
        ],
      },
      flowJsonError: null,
    });
    const { result } = renderLinkedFlowPreview();

    act(() => {
      result.current.openLinkedWhatsAppFlowPreview(
        "node-1",
        "flow-1",
        "data_exchange",
        EXISTING_CONFIG
      );
    });

    await waitFor(() =>
      expect(result.current.linkedFlowPreview.loading).toBe(false)
    );
    expect(result.current.linkedFlowPreview).toMatchObject({
      open: true,
      flowId: "flow-1",
      config: null,
      error: null,
      previewUrl: "https://business.facebook.com/wa/manage/flows/preview/token",
    });
    expect(mockFetchScenarioWhatsAppFlowDetails).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      flowId: "flow-1",
    });
  });
});

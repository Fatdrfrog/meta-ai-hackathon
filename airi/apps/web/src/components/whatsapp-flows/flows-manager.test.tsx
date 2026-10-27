/**
 * @jest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";

import {
  createWhatsAppFlow,
  deleteWhatsAppFlow,
  fetchWhatsAppFlowDetails,
  fetchWhatsAppFlowsList,
  sendWhatsAppFlowTest,
  updateWhatsAppFlow,
  type WhatsAppFlowSummary,
} from "@/lib/whatsapp/flows/client";

import { WhatsAppFlowsManager } from "./flows-manager";
import enMessages from "../../../messages/settings/integrations/en/page.json";
import ruMessages from "../../../messages/settings/integrations/ru/page.json";
import kzMessages from "../../../messages/settings/integrations/kz/page.json";

let mockExternalPreviewLabel: string | null = null;

// Real measurement is exercised in Chromium; jsdom reports zero-width boxes.
jest.mock("@/components/Masonry", () => ({
  __esModule: true,
  default: ({
    items,
    renderItem,
  }: {
    items: WhatsAppFlowSummary[];
    renderItem: (flow: WhatsAppFlowSummary) => React.ReactNode;
  }) => (
    <>
      {items.map(flow => (
        <div key={flow.id}>{renderItem(flow)}</div>
      ))}
    </>
  ),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

jest.mock(
  "./flow-editor",
  () => ({
    WhatsAppFlowEditor: ({
      flow,
      sourceId,
      onClose,
    }: {
      flow: WhatsAppFlowSummary;
      sourceId: string;
      onClose: () => void;
    }) => (
      <div role="dialog" aria-label="Flow editor">
        <span>{flow.name}</span>
        <span>{sourceId}</span>
        <button onClick={onClose}>Close editor</button>
      </div>
    ),
  }),
  { virtual: true }
);


jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    namespace === "WhatsAppFlows" && key === "actions.preview"
      ? (mockExternalPreviewLabel ?? key)
      : key,
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));
jest.mock("@/lib/whatsapp/flows/client", () => ({
  createWhatsAppFlow: jest.fn(),
  deleteWhatsAppFlow: jest.fn(),
  fetchWhatsAppFlowDetails: jest.fn(),
  fetchWhatsAppFlowsList: jest.fn(),
  generateWhatsAppFlowToken: jest.fn(() => "token-1"),
  getWhatsAppFlowPreviewUrl: jest.fn(),
  getWhatsAppFlowStatusVariant: jest.fn(() => "outline"),
  parseWhatsAppFlowActionPayload: jest.fn(() => ({})),
  sendWhatsAppFlowTest: jest.fn(),
  updateWhatsAppFlow: jest.fn(),
}));

const mockFetchWhatsAppFlowsList = jest.mocked(fetchWhatsAppFlowsList);
const mockFetchWhatsAppFlowDetails = jest.mocked(fetchWhatsAppFlowDetails);
const mockUpdateWhatsAppFlow = jest.mocked(updateWhatsAppFlow);
const mockDeleteWhatsAppFlow = jest.mocked(deleteWhatsAppFlow);
const mockCreateWhatsAppFlow = jest.mocked(createWhatsAppFlow);
const mockSendWhatsAppFlowTest = jest.mocked(sendWhatsAppFlowTest);

const readiness = {
  hasAccessToken: true,
  hasWabaId: true,
  hasPhoneNumberId: true,
};

beforeEach(() => {
  mockExternalPreviewLabel = null;
  mockFetchWhatsAppFlowDetails.mockResolvedValue({
    ok: true,
    status: 200,
    data: { flow: { id: "flow-1", status: "DRAFT" }, flowJson: null },
  });
});

function flowList(name: string, id = `flow-${name}`) {
  return {
    ok: true,
    status: 200,
    data: {
      flows: [{ id, name, status: "DRAFT" }],
      readiness,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function clickMenuAction(name: string) {
  fireEvent.keyDown(
    await screen.findByRole("button", { name: "actions.more" }),
    { key: "Enter" }
  );
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

async function selectOption(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

function listFlow(status: "DRAFT" | "PUBLISHED") {
  mockFetchWhatsAppFlowsList.mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      flows: [{ id: "flow-1", name: "Managed Flow", status }],
      readiness: {
        hasAccessToken: true,
        hasWabaId: true,
        hasPhoneNumberId: true,
      },
    },
  });
}

function renderManager(
  sourceOptions: ReadonlyArray<{ id: string; label: string }> = [
    { id: "source-1", label: "Primary WhatsApp" },
  ]
) {
  try {
    return render(
      <WhatsAppFlowsManager
        workspaceId="workspace-1"
        sourceOptions={sourceOptions}
      />
    );
  } catch (error) {
    if (error instanceof AggregateError && error.errors[0]) {
      throw error.errors[0];
    }
    throw error;
  }
}

describe("WhatsAppFlowsManager destructive Flow actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateWhatsAppFlow.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, operation: "deprecate" },
    });
    mockDeleteWhatsAppFlow.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, flowId: "flow-1" },
    });
    window.confirm = jest.fn();
  });

  it.each([
    ["en", enMessages.WhatsAppFlows, "Meta preview"],
    ["ru", ruMessages.WhatsAppFlows, "Предпросмотр Meta"],
    ["kz", kzMessages.WhatsAppFlows, "Meta алдын ала қарауы"],
  ] as const)(
    "names the external provider action Meta preview in %s",
    async (_locale, messages, expectedLabel) => {
      mockExternalPreviewLabel = messages.actions.preview;
      listFlow("DRAFT");
      renderManager();
      fireEvent.keyDown(
        await screen.findByRole("button", { name: "actions.more" }),
        { key: "Enter" }
      );
      expect(
        await screen.findByRole("menuitem", { name: expectedLabel })
      ).toBeTruthy();
      expect(
        screen.queryByRole("menuitem", { name: messages.editor.preview })
      ).toBeNull();
    }
  );

  it("pages preview cards and keeps the draft Edit action visible", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        readiness,
        flows: Array.from({ length: 25 }, (_, index) => ({
          id: `draft-${index}`,
          name: `Draft ${index}`,
          status: "DRAFT",
        })),
      },
    });
    renderManager();
    await screen.findByText("Draft 0");
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(
      screen.getAllByRole("button", { name: "actions.edit" })
    ).toHaveLength(12);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Draft 12")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "gallery.loadMore" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(24);
    fireEvent.change(screen.getByRole("textbox", { name: "searchLabel" }), {
      target: { value: "Draft 24" },
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "actions.edit" }));
    expect(screen.getByRole("dialog", { name: "Flow editor" })).toBeTruthy();
    expect(screen.getAllByText("Draft 24")).toHaveLength(2);
  });

  it("allows editing even when the thumbnail could not be loaded", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Editable draft"));
    mockFetchWhatsAppFlowDetails.mockRejectedValue(
      new Error("Preview offline")
    );
    renderManager();
    await screen.findByText("Preview offline");
    fireEvent.click(screen.getByRole("button", { name: "actions.edit" }));
    expect(screen.getByRole("dialog", { name: "Flow editor" })).toBeTruthy();
  });

  it("does not deprecate when the operator rejects the message-impact warning", async () => {
    listFlow("PUBLISHED");
    jest.mocked(window.confirm).mockReturnValue(false);
    renderManager();

    await clickMenuAction("actions.deprecate");

    expect(window.confirm).toHaveBeenCalledWith("alerts.deprecateConfirm");
    expect(mockUpdateWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("sends strict acknowledgement after the operator accepts deprecation", async () => {
    listFlow("PUBLISHED");
    jest.mocked(window.confirm).mockReturnValue(true);
    renderManager();

    await clickMenuAction("actions.deprecate");

    await waitFor(() =>
      expect(mockUpdateWhatsAppFlow).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "deprecate",
        acknowledgePreviouslySentMessagesWillStopOpening: true,
      })
    );
  });

  it("reuses the existing draft warning as the deletion acknowledgement", async () => {
    listFlow("DRAFT");
    jest.mocked(window.confirm).mockReturnValue(true);
    renderManager();

    await clickMenuAction("actions.deleteDraft");

    expect(window.confirm).toHaveBeenCalledWith("alerts.deleteConfirm");
    await waitFor(() =>
      expect(mockDeleteWhatsAppFlow).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        acknowledgeDraftDeletion: true,
      })
    );
  });

  it("does not fetch an arbitrary account when multiple WhatsApp sources exist", () => {
    renderManager([
      { id: "source-1", label: "Primary WhatsApp" },
      { id: "source-2", label: "Secondary WhatsApp" },
    ]);

    expect(screen.getByText("sourcePlaceholder")).toBeTruthy();
    expect(screen.getByText("alerts.sourceRequired")).toBeTruthy();
    expect(mockFetchWhatsAppFlowsList).not.toHaveBeenCalled();
  });

  it("keeps a missing managed artifact reachable through its explicit resolution action", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        flows: [
          {
            id: "flow-missing",
            name: "Managed Flow",
            status: "MISSING",
            providerUnavailable: true,
            managedArtifact: {
              operationId: "operation-1",
              ledgerStatus: "SUPERSEDED",
              stage: "COMPLETED",
              cleanupEligibility: "ELIGIBLE",
              suggestedResolutionKind: "published_deprecated",
            },
          },
        ],
        readiness: {
          hasAccessToken: true,
          hasWabaId: true,
          hasPhoneNumberId: true,
        },
      },
    });
    jest.mocked(window.confirm).mockReturnValue(true);
    renderManager();

    await clickMenuAction("actions.resolveManaged");

    await waitFor(() =>
      expect(mockUpdateWhatsAppFlow).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-missing",
        operation: "deprecate",
        acknowledgePreviouslySentMessagesWillStopOpening: true,
      })
    );
  });
});

describe("WhatsAppFlowsManager editing and account ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.confirm = jest.fn(() => true);
  });

  it("opens a draft in the workspace account editor", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Lead form"));
    renderManager();
    fireEvent.click(
      await screen.findByRole("button", { name: "actions.edit" })
    );
    expect(screen.getByRole("dialog", { name: "Flow editor" })).toBeTruthy();
    expect(screen.getByText("source-1")).toBeTruthy();
  });

  it("does not restore old rows or clear the current loading state after a workspace transition", async () => {
    const oldRequest = deferred<ReturnType<typeof flowList>>();
    const currentRequest = deferred<ReturnType<typeof flowList>>();
    mockFetchWhatsAppFlowsList
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise);
    const view = renderManager();
    view.rerender(
      <WhatsAppFlowsManager
        workspaceId="workspace-2"
        sourceOptions={[{ id: "source-1", label: "Primary WhatsApp" }]}
      />
    );
    await act(async () => {
      oldRequest.resolve(flowList("Old account Flow"));
    });
    expect(screen.queryByText("Old account Flow")).toBeNull();
    expect(screen.getByText("loading")).toBeTruthy();
    await act(async () => {
      currentRequest.resolve(flowList("Current account Flow"));
    });
    expect(await screen.findByText("Current account Flow")).toBeTruthy();
  });

  it("rejects an old visit response after workspace A to B to A", async () => {
    const firstA = deferred<ReturnType<typeof flowList>>();
    const requestB = deferred<ReturnType<typeof flowList>>();
    const currentA = deferred<ReturnType<typeof flowList>>();
    mockFetchWhatsAppFlowsList
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(requestB.promise)
      .mockReturnValueOnce(currentA.promise);
    const view = renderManager();
    const sourceOptions = [{ id: "source-1", label: "Primary WhatsApp" }];
    view.rerender(
      <WhatsAppFlowsManager
        workspaceId="workspace-b"
        sourceOptions={sourceOptions}
      />
    );
    view.rerender(
      <WhatsAppFlowsManager
        workspaceId="workspace-1"
        sourceOptions={sourceOptions}
      />
    );
    await act(async () => {
      currentA.resolve(flowList("Latest A"));
    });
    await act(async () => {
      firstA.resolve(flowList("Stale A"));
      requestB.resolve(flowList("Stale B"));
    });
    expect(screen.getByText("Latest A")).toBeTruthy();
    expect(screen.queryByText("Stale A")).toBeNull();
    expect(screen.queryByText("Stale B")).toBeNull();
  });

  it("closes the editor when its workspace owner changes", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Lead form"));
    const view = renderManager();
    fireEvent.click(
      await screen.findByRole("button", { name: "actions.edit" })
    );
    view.rerender(
      <WhatsAppFlowsManager
        workspaceId="workspace-2"
        sourceOptions={[{ id: "source-1", label: "Primary WhatsApp" }]}
      />
    );
    expect(screen.queryByRole("dialog", { name: "Flow editor" })).toBeNull();
  });

  it("keeps a newer create dialog open when an old create request settles", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Lead form"));
    const creation = deferred<Awaited<ReturnType<typeof createWhatsAppFlow>>>();
    mockCreateWhatsAppFlow.mockReturnValueOnce(creation.promise);
    const view = renderManager();
    fireEvent.click(screen.getByRole("button", { name: "createFlow" }));
    fireEvent.change(screen.getByLabelText("dialogs.create.nameLabel"), {
      target: { value: "Old draft" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "dialogs.create.submit" })
    );
    view.rerender(
      <WhatsAppFlowsManager
        workspaceId="workspace-2"
        sourceOptions={[{ id: "source-1", label: "Primary WhatsApp" }]}
      />
    );
    await screen.findByText("Lead form");
    fireEvent.click(screen.getByRole("button", { name: "createFlow" }));
    fireEvent.change(screen.getByLabelText("dialogs.create.nameLabel"), {
      target: { value: "New draft" },
    });
    await act(async () => {
      creation.resolve({
        ok: true,
        status: 200,
        data: { flow: { id: "old-draft", status: "DRAFT" } },
      });
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      (screen.getByLabelText("dialogs.create.nameLabel") as HTMLInputElement)
        .value
    ).toBe("New draft");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("filters rows by name without losing the account selection", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        flows: [
          { id: "lead", name: "Lead capture", status: "DRAFT" },
          { id: "survey", name: "Feedback", status: "PUBLISHED" },
        ],
        readiness,
      },
    });
    renderManager();
    await screen.findByText("Lead capture");
    fireEvent.change(screen.getByRole("textbox", { name: "searchLabel" }), {
      target: { value: "Feedback" },
    });
    expect(screen.queryByText("Lead capture")).toBeNull();
    expect(screen.getByText("Feedback")).toBeTruthy();
  });

  it("does not claim an empty draft has no validation issues", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Empty draft"));
    renderManager();
    await screen.findByText("Empty draft");
    expect(screen.queryByText("table.noIssues")).toBeNull();
    expect(screen.getByText("table.validationUnknown")).toBeTruthy();
  });

  it("clears old account rows when the newly selected account fails to load", async () => {
    mockFetchWhatsAppFlowsList
      .mockResolvedValueOnce(flowList("Account A Flow"))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        data: { error: "Account B unavailable" },
      });
    renderManager([
      { id: "source-a", label: "Account A" },
      { id: "source-b", label: "Account B" },
    ]);
    await selectOption("sourceLabel", "Account A");
    await screen.findByText("Account A Flow");
    await selectOption("sourceLabel", "Account B");
    expect(await screen.findByText("Account B unavailable")).toBeTruthy();
    expect(screen.queryByText("Account A Flow")).toBeNull();
    expect(screen.queryByRole("button", { name: "actions.edit" })).toBeNull();
    expect(mockFetchWhatsAppFlowsList.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ sourceId: "source-b" })
    );
  });

  it("aborts a list request when its account session is replaced", async () => {
    const oldRequest = deferred<ReturnType<typeof flowList>>();
    mockFetchWhatsAppFlowsList
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce(flowList("New account"));
    const view = renderManager();
    const signal = mockFetchWhatsAppFlowsList.mock.calls[0]?.[0].signal;
    view.rerender(
      <WhatsAppFlowsManager
        workspaceId="workspace-2"
        sourceOptions={[{ id: "source-1", label: "Primary WhatsApp" }]}
      />
    );
    expect(signal?.aborted).toBe(true);
    await screen.findByText("New account");
  });

  it("creates a published Flow copy as a separate draft and opens its editor", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        flows: [
          {
            id: "original",
            name: "Bookings",
            status: "PUBLISHED",
            categories: ["APPOINTMENT_BOOKING"],
          },
        ],
        readiness,
      },
    });
    mockCreateWhatsAppFlow.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        flow: { id: "new-draft", name: "Bookings v2", status: "DRAFT" },
      },
    });
    renderManager();
    expect(
      await screen.findByRole("button", { name: "actions.view" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "actions.edit" })).toBeNull();
    await clickMenuAction("actions.copy");
    fireEvent.change(screen.getByLabelText("dialogs.create.nameLabel"), {
      target: { value: "Bookings v2" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "dialogs.create.submit" })
    );
    expect(
      await screen.findByRole("dialog", { name: "Flow editor" })
    ).toBeTruthy();
    expect(screen.getByText("Bookings v2")).toBeTruthy();
    expect(mockCreateWhatsAppFlow).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      name: "Bookings v2",
      categories: ["APPOINTMENT_BOOKING"],
      cloneFlowId: "original",
    });
    expect(mockUpdateWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("uses canonical category choices when creating a new draft", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Existing Flow"));
    mockCreateWhatsAppFlow.mockResolvedValue({
      ok: true,
      status: 200,
      data: { flow: { id: "new-flow", status: "DRAFT" } },
    });
    renderManager();
    await screen.findByText("Existing Flow");
    fireEvent.click(screen.getByRole("button", { name: "createFlow" }));
    fireEvent.change(screen.getByLabelText("dialogs.create.nameLabel"), {
      target: { value: "Survey" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "categories.SURVEY" })
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "categories.OTHER" }));
    fireEvent.click(
      screen.getByRole("button", { name: "dialogs.create.submit" })
    );
    await screen.findByRole("dialog", { name: "Flow editor" });
    expect(mockCreateWhatsAppFlow).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Survey", categories: ["SURVEY"] })
    );
  });

  it("filters by provider status while keeping the search active", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        flows: [
          { id: "lead-draft", name: "Lead draft", status: "DRAFT" },
          { id: "lead-published", name: "Lead published", status: "PUBLISHED" },
          { id: "survey", name: "Survey", status: "PUBLISHED" },
        ],
        readiness,
      },
    });
    renderManager();
    await screen.findByText("Lead draft");
    fireEvent.change(screen.getByRole("textbox", { name: "searchLabel" }), {
      target: { value: "Lead" },
    });
    await selectOption("statusFilterLabel", "statuses.published");
    expect(screen.getByText("Lead published")).toBeTruthy();
    expect(screen.queryByText("Lead draft")).toBeNull();
    expect(screen.queryByText("Survey")).toBeNull();
  });

  it("links a managed artifact to its owning scenario and hides standalone publication", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        flows: [
          {
            id: "managed",
            name: "Scenario form",
            status: "DRAFT",
            managedArtifact: {
              scenarioId: "scenario-1",
              operationId: "operation-1",
              ledgerStatus: "COMPLETED",
              stage: "COMPLETED",
              cleanupEligibility: "REPLACEMENT_PENDING",
            },
          },
        ],
        readiness,
      },
    });
    renderManager();
    const link = await screen.findByRole("link", {
      name: "actions.openScenario",
    });
    expect(link.getAttribute("href")).toBe(
      "/panel/w/workspace-1/scenarios?scenarioId=scenario-1"
    );
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "actions.more" }),
      { key: "Enter" }
    );
    await screen.findByRole("menuitem", { name: "actions.preview" });
    expect(
      screen.queryByRole("menuitem", { name: "actions.publish" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "actions.edit" })).toBeNull();
  });

  it("keeps the newer send dialog open when an earlier workspace send completes", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Form"));
    const sending =
      deferred<Awaited<ReturnType<typeof sendWhatsAppFlowTest>>>();
    mockSendWhatsAppFlowTest.mockReturnValueOnce(sending.promise);
    const view = renderManager();
    await clickMenuAction("actions.sendTest");
    fireEvent.change(screen.getByLabelText("dialogs.send.recipientLabel"), {
      target: { value: "+77000000001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "dialogs.send.submit" })
    );
    view.rerender(
      <WhatsAppFlowsManager
        workspaceId="workspace-2"
        sourceOptions={[{ id: "source-1", label: "Primary WhatsApp" }]}
      />
    );
    await clickMenuAction("actions.sendTest");
    fireEvent.change(screen.getByLabelText("dialogs.send.recipientLabel"), {
      target: { value: "+77000000002" },
    });
    await act(async () => {
      sending.resolve({ ok: true, status: 200, data: { success: true } });
    });
    expect(
      screen.getByRole("dialog", { name: "dialogs.send.title" })
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("dialogs.send.recipientLabel") as HTMLInputElement)
        .value
    ).toBe("+77000000002");
    expect(toast.success).not.toHaveBeenCalled();
    expect(mockSendWhatsAppFlowTest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        recipientPhone: "+77000000001",
        mode: "draft",
      })
    );
  });

  it("shows a literal JSON payload example without translating JSON as an ICU message", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Form"));
    renderManager();
    await clickMenuAction("actions.sendTest");
    const payload = screen.getByLabelText(
      "dialogs.send.payloadLabel"
    ) as HTMLTextAreaElement;
    expect(payload.placeholder).toBe('{"screen":"START"}');
  });

  it("keeps the current official guides reachable from the compact manager", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Form"));
    renderManager();
    await screen.findByText("Form");
    expect(
      screen.getByRole("link", { name: "readDocs" }).getAttribute("href")
    ).toBe(
      "https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides"
    );
  });

  it("explains the customer service window and device requirements before a test send", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue(flowList("Form"));
    renderManager();
    await clickMenuAction("actions.sendTest");
    expect(screen.getByText("dialogs.send.requirements")).toBeTruthy();
    expect(mockSendWhatsAppFlowTest).not.toHaveBeenCalled();
  });

  it("allows provider-limited tests for a throttled published Flow", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        flows: [
          { id: "throttled-flow", name: "Limited Flow", status: "THROTTLED" },
        ],
        readiness,
      },
    });
    mockSendWhatsAppFlowTest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true },
    });
    renderManager();
    await clickMenuAction("actions.sendTest");
    fireEvent.change(screen.getByLabelText("dialogs.send.recipientLabel"), {
      target: { value: "+77000000001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "dialogs.send.submit" })
    );
    await waitFor(() =>
      expect(mockSendWhatsAppFlowTest).toHaveBeenCalledWith(
        expect.objectContaining({
          flowId: "throttled-flow",
          recipientPhone: "+77000000001",
        })
      )
    );
    expect(mockSendWhatsAppFlowTest.mock.calls[0]?.[0].mode).not.toBe("draft");
  });
});

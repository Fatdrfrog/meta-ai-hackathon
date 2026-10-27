/** @jest-environment jsdom */

import type { KeyboardEventHandler, ReactNode } from "react";

const mockToastError = jest.fn();
const mockToastSuccess = jest.fn();
const mockFetch = jest.fn();

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}));

jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

jest.mock("@xyflow/react", () => ({
  Handle: ({
    children,
    id,
    "aria-label": ariaLabel,
    role,
    tabIndex,
    onKeyDown,
  }: {
    children?: ReactNode;
    id?: string;
    "aria-label"?: string;
    role?: string;
    tabIndex?: number;
    onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  }) => (
    <div
      data-testid="handle"
      data-handle-id={id}
      aria-label={ariaLabel}
      role={role}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  ),
  MarkerType: { ArrowClosed: "ArrowClosed" },
  Position: { Left: "left", Right: "right", Top: "top" },
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown
  ) => selector({ transform: [0, 0, 1] }),
  useUpdateNodeInternals: () => jest.fn(),
}));

// The Flow builder has its own tests; this file checks what the drawer passes it.
const mockFlowBuilderProps = jest.fn();
jest.mock("./action-node-whatsapp-flow-section", () => ({
  ActionNodeWhatsAppFlowBuilder: (props: Record<string, unknown>) => {
    mockFlowBuilderProps(props);
    return <div data-testid="mock-flow-builder" />;
  },
}));
jest.mock("../../builders/whatsapp/inline-editor", () => ({
  WhatsAppInlineEditor: ({
    value,
    onChange,
    ariaLabel,
    placeholder,
    error,
  }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel?: string;
    placeholder?: string;
    error?: string;
  }) => {
    const label = ariaLabel || placeholder || "editor";
    return (
      <>
        <textarea
          aria-label={label}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${label}-error` : undefined}
          value={value}
          onChange={event => onChange(event.target.value)}
        />
        {error ? <p id={`${label}-error`}>{error}</p> : null}
      </>
    );
  },
}));

jest.mock("@/components/whatsapp-templates/template-form-drawer", () => ({
  TemplateFormDrawer: ({ open }: { open: boolean }) =>
    open ? <div data-testid="template-create-drawer" /> : null,
}));

import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildWhatsAppTemplateButtonSourceHandleId,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import type { EditableWhatsAppTemplateButton } from "../../builders/whatsapp/template-editor-utils";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import type { ScenarioNodeData } from "../../types";
import {
  createActionEditorTestData,
  type ActionNodeTestData,
} from "./action-node-test-utils";
import {
  resolveActionNodeBranchState,
  resolveActionNodeModeState,
} from "./action-node-state";
import { ActionNodeWhatsAppTemplateSection } from "./action-node-whatsapp-template-section";
import { listTemplateButtonRoutesRemovedOnSave } from "./action-node-whatsapp-template-section-state";
import {
  ScenarioGraphResourcesProvider,
  type ScenarioGraphResourcesState,
} from "../../view/graph/resources-context";
import {
  installMatchMedia,
  installResizeObserver,
} from "@/test-support/dom-test-utils";

beforeAll(() => {
  installResizeObserver();
  Element.prototype.scrollIntoView = jest.fn();
  Object.defineProperty(global, "fetch", { writable: true, value: mockFetch });
  installMatchMedia();
});

// The message editor loads lazily in the app; load it up front so every
// test (run alone or in any order) renders it at once.
beforeAll(async () => {
  await scenarioEditorChunks.whatsAppInlineEditor.load();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, message: "Updated in Meta" }),
  });
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const t = (key: string) => key;

/** A step whose template opens no form. */
const NO_FORM_ROUTE = {
  formSubmittedRoute: { placement: "none" as const, connected: false },
  savedComponents: undefined,
  t,
};

type TemplateOverrides = Partial<ActionNodeTestData>;

function templateData(overrides: TemplateOverrides = {}) {
  return createActionEditorTestData({
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "order_update",
    actionWhatsAppTemplateLanguage: "en",
    actionWhatsAppTemplateComponents: [
      { type: "BODY", text: "Template body" },
    ] as WhatsAppComponent[],
    uiWorkspaceId: "workspace-1",
    ...overrides,
    uiWhatsAppTemplates: {
      options: [
        {
          id: "meta-1",
          name: "order_update",
          language: "en",
          category: "UTILITY",
        },
      ],
      selectedValue: "order_update::en",
      catalogMatch: true,
      ...overrides.uiWhatsAppTemplates,
    },
  } as ActionNodeTestData);
}

function renderSection(
  nodeData = templateData(),
  {
    showPorts = true,
    templatesLoading = false,
    patchNode = jest.fn<void, [Partial<ScenarioNodeData>]>(),
    resources,
    createNodeFromSourceHandle,
  }: {
    showPorts?: boolean;
    templatesLoading?: boolean;
    patchNode?: jest.Mock<void, [Partial<ScenarioNodeData>]>;
    resources?: ScenarioGraphResourcesState;
    createNodeFromSourceHandle?: jest.Mock<void, [string, number, number]>;
  } = {}
) {
  const mode = resolveActionNodeModeState(nodeData);
  const branchState = resolveActionNodeBranchState({
    id: "action-1",
    mode,
    nodeData,
    renderMode: "expanded",
    t,
  });
  const element = (data = nodeData, loading = templatesLoading) => (
    <ActionNodeWhatsAppTemplateSection
      id="action-1"
      branchState={branchState}
      createNodeFromSourceHandle={createNodeFromSourceHandle}
      loadingLabel="loadingItems"
      mode={mode}
      nodeData={data}
      patchNode={patchNode}
      showPorts={showPorts}
      whatsAppFlowsLoading={false}
      whatsAppFlowsRefreshing={false}
      whatsAppTemplatesLoading={loading}
      whatsAppTemplatesRefreshing={false}
    />
  );
  const wrap = (child: ReactNode) =>
    resources ? (
      <ScenarioGraphResourcesProvider value={resources}>
        {child}
      </ScenarioGraphResourcesProvider>
    ) : (
      child
    );
  const view = render(wrap(element()));
  return {
    ...view,
    patchNode,
    rerenderWith: (data: typeof nodeData, loading = templatesLoading) =>
      view.rerender(wrap(element(data, loading))),
  };
}

function editBody(value: string) {
  fireEvent.change(screen.getByDisplayValue("Template body"), {
    target: { value },
  });
}

it("explains a throttled catalog and disables Refresh until its retry time", async () => {
  await act(async () => {
    renderSection(templateData(), {
      resources: {
        whatsAppTemplatesLoading: false,
        whatsAppTemplatesRefreshing: false,
        hasLoadedWhatsAppTemplates: true,
        whatsAppFlowsLoading: false,
        whatsAppFlowsRefreshing: false,
        contextItemsLoading: false,
        whatsAppTemplatesError: { retryAt: "2099-10-06T13:00:00.000Z" },
      },
    });
  });
  expect(
    screen.getByTestId("whatsapp-template-catalog-unavailable")
  ).toHaveTextContent("alerts.savedTemplates");
  expect(screen.getByRole("button", { name: "refresh" })).toBeDisabled();
});

it.each([
  ["WHATSAPP_TEMPLATES_RATE_LIMITED", "alerts.refreshCooldown"],
  ["WHATSAPP_TEMPLATES_UNAVAILABLE", "readiness.cooldownUntil"],
  [null, "readiness.cooldownUntil"],
])(
  "calls only Meta's limit a limit when the catalog fails with %s",
  async (code, retryText) => {
    await act(async () => {
      renderSection(templateData(), {
        resources: {
          whatsAppTemplatesLoading: false,
          whatsAppTemplatesRefreshing: false,
          hasLoadedWhatsAppTemplates: true,
          whatsAppFlowsLoading: false,
          whatsAppFlowsRefreshing: false,
          contextItemsLoading: false,
          whatsAppTemplatesError: { retryAt: "2099-10-06T13:00:00.000Z", code },
        },
      });
    });
    const notice = screen.getByTestId("whatsapp-template-catalog-unavailable");
    expect(notice).toHaveTextContent(retryText);
    if (retryText !== "alerts.refreshCooldown") {
      expect(notice).not.toHaveTextContent("alerts.refreshCooldown");
    }
    expect(screen.getByRole("button", { name: "refresh" })).toBeDisabled();
  }
);

it("provides explicit Refresh for external approval changes", async () => {
  const data = templateData();
  await act(async () => {
    renderSection(data);
  });
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  expect(data.uiWhatsAppTemplates.refresh).toHaveBeenCalledTimes(1);
});

describe("ActionNodeWhatsAppTemplateSection", () => {
  it("shows the template picker without the old refresh button or status badge", () => {
    renderSection();
    expect(
      screen.getByRole("combobox", { name: "whatsappTemplateSelectLabel" })
    ).toHaveTextContent("order_update");
    expect(
      screen.queryByRole("button", { name: "whatsappTemplateRefresh" })
    ).toBeNull();
    expect(screen.queryByText("APPROVED")).toBeNull();
    expect(screen.queryByText("whatsappTemplateLoading")).toBeNull();
  });

  it("opens the create drawer from the picker's footer item", async () => {
    renderSection();
    fireEvent.click(
      screen.getByRole("combobox", { name: "whatsappTemplateSelectLabel" })
    );
    fireEvent.click(
      screen.getByRole("option", { name: "whatsappTemplateCreateNew" })
    );
    expect(await screen.findByTestId("template-create-drawer")).toBeTruthy();
  });

  it("marks a catalog template as shared and explains it on request", () => {
    renderSection();
    expect(screen.getByTestId("whatsapp-template-shared")).toHaveTextContent(
      "whatsappTemplateShared"
    );
    expect(
      screen.getByRole("button", {
        name: "infoHintLabel",
        description: "whatsappTemplateSharedInfo",
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the save bar hidden until the template has edits", async () => {
    renderSection();
    expect(screen.queryByTestId("whatsapp-template-save-bar")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "whatsappTemplateUpdateShared" })
    ).toBeNull();
    expect(screen.queryByText("whatsappTemplateDraftHint")).toBeNull();

    editBody("Updated body");
    const bar = await screen.findByTestId("whatsapp-template-save-bar");
    expect(bar).toHaveTextContent("whatsappTemplateDraftUnsaved");
    expect(
      within(bar).getByRole("button", { name: "whatsappTemplateDiscardDraft" })
    ).toBeEnabled();
    expect(
      within(bar).getByRole("button", { name: "whatsappTemplateUpdateShared" })
    ).toBeEnabled();

    fireEvent.click(
      within(bar).getByRole("button", { name: "whatsappTemplateDiscardDraft" })
    );
    await waitFor(() =>
      expect(screen.queryByTestId("whatsapp-template-save-bar")).toBeNull()
    );
    expect(screen.getByDisplayValue("Template body")).toBeInTheDocument();
  });

  it("asks before saving a shared template and saves only after confirming", async () => {
    const nodeData = templateData();
    const { patchNode } = renderSection(nodeData);
    editBody("Updated body");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("whatsappTemplateSaveConfirmTitle");
    expect(dialog).toHaveTextContent("whatsappTemplateSharedInfo");
    expect(mockFetch).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    );
    await waitFor(() =>
      expect(patchNode).toHaveBeenCalledWith(
        expect.objectContaining({ actionReplyText: "Updated body" })
      )
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/whatsapp/templates",
      expect.objectContaining({ method: "PATCH" })
    );
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "whatsappTemplateMetaUpdateSuccess"
    );
    // A toast naming removed routes follows, so it shows on top.
    expect(mockToastSuccess.mock.invocationCallOrder[0]).toBeLessThan(
      patchNode.mock.invocationCallOrder[0]
    );
    // The catalog is reloaded, so it no longer shows the template as it was.
    expect(nodeData.uiWhatsAppTemplates.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the edits when the merchant cancels the confirmation", async () => {
    renderSection();
    editBody("Updated body");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Updated body")).toBeInTheDocument();
  });

  it("does not ask to save an invalid template", async () => {
    renderSection();
    editBody("");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    );
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "whatsappTemplateSaveInvalid",
        { description: "whatsappTemplateErrorBodyRequired" }
      )
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("shows a blocked save's body error under the message field", async () => {
    renderSection();
    const body = screen.getByRole("textbox", {
      name: "scenarioMessageEditorLabel",
    });
    expect(body).toHaveAttribute("aria-invalid", "false");
    editBody("");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    );
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "whatsappTemplateSaveInvalid",
        { description: "whatsappTemplateErrorBodyRequired" }
      )
    );
    expect(body).toHaveAttribute("aria-invalid", "true");
    expect(body).toHaveAccessibleDescription(
      "whatsappTemplateErrorBodyRequired"
    );
  });

  it.each([
    ["whatsappTemplateHeaderPlaceholder", "whatsappTemplateErrorHeaderTooLong"],
    ["whatsappTemplateFooterPlaceholder", "whatsappTemplateErrorFooterTooLong"],
  ])("shows the %s length error under that field", async (field, error) => {
    renderSection();
    const input = screen.getByRole("textbox", { name: field });
    fireEvent.change(input, { target: { value: "x".repeat(61) } });
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(input).toHaveAccessibleDescription(error);
    expect(
      screen.getByRole("textbox", { name: "scenarioMessageEditorLabel" })
    ).toHaveAttribute("aria-invalid", "false");
  });

  it("leaves the step alone when the chosen template is picked again", () => {
    const select = jest.fn();
    const { patchNode } = renderSection(
      templateData({
        uiWhatsAppTemplates: { select },
      } as TemplateOverrides)
    );
    const trigger = screen.getByRole("combobox", {
      name: "whatsappTemplateSelectLabel",
    });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /order_update/ }));
    expect(select).not.toHaveBeenCalled();
    expect(patchNode).not.toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: /order_update/ })).toBeNull();
    expect(trigger.querySelector(".animate-spin")).toBeNull();
  });

  it("waits for templates to load before calling a template unapproved", () => {
    const data = templateData({
      actionWhatsAppTemplateId: "meta-gone",
      uiWhatsAppTemplates: { options: [], catalogMatch: false },
    } as TemplateOverrides);
    const { rerenderWith } = renderSection(data, { templatesLoading: true });
    expect(screen.queryByTestId("whatsapp-template-unverified")).toBeNull();
    rerenderWith(data, false);
    expect(
      screen.getByTestId("whatsapp-template-unverified")
    ).toHaveTextContent("whatsappTemplateUnverified");
    expect(screen.queryByTestId("whatsapp-template-shared")).toBeNull();
  });

  it.each([
    ["draft", "whatsappTemplateDraftStatusDraft", true],
    ["rejected", "whatsappTemplateDraftStatusRejected", true],
    ["pending", "whatsappTemplateDraftStatusInReview", false],
    ["approved", "whatsappTemplateDraftStatusApproved", false],
  ] as const)(
    "names an AI draft in the %s state",
    (status, label, canSendForReview) => {
      renderSection(
        templateData({
          generatedTemplateDraft: {
            id: "draft-1",
            name: "order_update",
            language: "en",
            status,
          },
        } as TemplateOverrides)
      );
      expect(
        screen.getByTestId("whatsapp-template-draft-status")
      ).toHaveTextContent(label);
      expect(
        Boolean(
          screen.queryByRole("button", {
            name: "whatsappTemplateSendForReview",
          })
        )
      ).toBe(canSendForReview);
      expect(screen.queryByText(new RegExp(`Draft: ${status}`))).toBeNull();
    }
  );

  it("sends an AI draft for review and hides Save template until it exists", async () => {
    const submitGenerated = jest.fn(async () => true);
    renderSection(
      templateData({
        generatedTemplateDraft: {
          id: "draft-1",
          name: "order_update",
          language: "en",
          status: "rejected",
          error: "Wrong category",
        },
        uiWhatsAppTemplates: { submitGenerated },
      } as TemplateOverrides)
    );
    expect(screen.getByTestId("whatsapp-template-rejected")).toHaveTextContent(
      "whatsappTemplateRejectedReason"
    );
    editBody("Draft edit");
    const bar = await screen.findByTestId("whatsapp-template-save-bar");
    expect(
      within(bar).queryByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateSendForReview" })
    );
    await waitFor(() => expect(submitGenerated).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "whatsappTemplateSentForReview"
    );
  });

  it("explains why a new reply button has no route dot yet", async () => {
    renderSection(
      templateData({
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Template body" },
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
        ] as WhatsAppComponent[],
      } as TemplateOverrides)
    );
    expect(
      screen
        .getAllByTestId("handle")
        .map(handle => handle.getAttribute("data-handle-id"))
    ).toContain(buildWhatsAppTemplateButtonSourceHandleId(0));
    expect(
      screen.queryByTestId("whatsapp-template-button-unsaved-route")
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateAddButton" })
    );
    const hint = await screen.findByTestId(
      "whatsapp-template-button-unsaved-route"
    );
    expect(
      within(hint).getByRole("button", { name: "infoHintLabel" })
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByTestId("handle")
        .map(handle => handle.getAttribute("data-handle-id"))
    ).not.toContain(buildWhatsAppTemplateButtonSourceHandleId(1));
  });

  it("keeps a removed reply button's route anchored until the template is saved", async () => {
    renderSection(
      templateData({
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Template body" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Basic" },
              { type: "QUICK_REPLY", text: "Premium" },
            ],
          },
        ] as WhatsAppComponent[],
      } as TemplateOverrides)
    );
    const removeButtons = () =>
      screen.getAllByRole("button", { name: "whatsappTemplateRemoveButton" });
    const handleIds = () =>
      screen
        .getAllByTestId("handle")
        .map(handle => handle.getAttribute("data-handle-id"));
    const basicHandle = buildWhatsAppTemplateButtonSourceHandleId(0);
    const premiumHandle = buildWhatsAppTemplateButtonSourceHandleId(1);
    expect(handleIds()).toEqual([basicHandle, premiumHandle]);

    fireEvent.click(removeButtons()[0]);
    await waitFor(() => expect(removeButtons()).toHaveLength(1));

    // Premium's row keeps its own handle; Basic's edge keeps a hidden anchor.
    expect(
      within(removeButtons()[0].parentElement as HTMLElement)
        .getAllByTestId("handle")
        .map(handle => handle.getAttribute("data-handle-id"))
    ).toEqual([premiumHandle]);
    expect(handleIds().sort()).toEqual([basicHandle, premiumHandle].sort());
  });

  describe("reply-button route warnings", () => {
    const planButtons = (...texts: string[]) =>
      [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: texts.map(text => ({ type: "QUICK_REPLY", text })),
        },
      ] as WhatsAppComponent[];
    const approvedTemplate = (components: WhatsAppComponent[]) => ({
      options: [
        {
          id: "meta-1",
          name: "order_update",
          language: "en",
          category: "UTILITY",
          components,
        },
      ],
    });
    const bothRouted = {
      sourceHandleIds: [0, 1].map(id =>
        buildWhatsAppTemplateButtonSourceHandleId(id)
      ),
    };
    const basicRoute = {
      destinationsBySourceHandle: new Map([
        [
          buildWhatsAppTemplateButtonSourceHandleId(0),
          { nodeId: "basic-follow-up", label: "Basic follow-up" },
        ],
      ]),
    };

    it("names the route Save will remove until the draft is discarded", async () => {
      renderSection(
        templateData({
          actionWhatsAppTemplateComponents: planButtons("Basic", "Premium"),
          uiConnections: basicRoute,
        } as TemplateOverrides)
      );
      const removeButtons = () =>
        screen.getAllByRole("button", {
          name: "whatsappTemplateRemoveButton",
        });
      const notices = () =>
        screen.queryAllByTestId("whatsapp-template-save-removes-route");

      // Premium has no route, so removing it removes none.
      fireEvent.click(removeButtons()[1]);
      await waitFor(() => expect(removeButtons()).toHaveLength(1));
      expect(notices()).toEqual([]);

      fireEvent.click(removeButtons()[0]);
      await waitFor(() => expect(notices()).toHaveLength(1));
      expect(notices()[0]).toHaveTextContent(
        "whatsappTemplateSaveRemovesRoute"
      );

      fireEvent.click(
        screen.getByRole("button", { name: "whatsappTemplateDiscardDraft" })
      );
      await waitFor(() => expect(notices()).toEqual([]));
    });

    it("names the routes Save removes in the confirmation", async () => {
      renderSection(
        templateData({
          actionWhatsAppTemplateComponents: planButtons("Basic", "Premium"),
          uiConnections: basicRoute,
        } as TemplateOverrides)
      );
      fireEvent.click(
        screen.getAllByRole("button", {
          name: "whatsappTemplateRemoveButton",
        })[0]
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: "whatsappTemplateUpdateShared",
        })
      );

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("whatsappTemplateSharedInfo");
      expect(
        within(dialog).getByTestId(
          "whatsapp-template-save-confirm-removes-routes"
        )
      ).toHaveTextContent("whatsappTemplateSaveConfirmRemovesRoutes");
    });

    it("says nothing about routes in the confirmation when Save removes none", async () => {
      renderSection();
      editBody("Updated body");
      fireEvent.click(
        await screen.findByRole("button", {
          name: "whatsappTemplateUpdateShared",
        })
      );
      await screen.findByRole("alertdialog");
      expect(
        screen.queryByTestId("whatsapp-template-save-confirm-removes-routes")
      ).toBeNull();
    });

    it("shortens a long next step in the notice", () => {
      const [removal] = listTemplateButtonRoutesRemovedOnSave({
        savedBranchesById: new Map([
          [
            0,
            {
              buttonId: 0,
              index: 0,
              label: "Basic",
              payload: "stb:action-1:0",
            },
          ],
        ]),
        buttons: [],

        ...NO_FORM_ROUTE,
        destinationsBySourceHandle: new Map([
          [
            buildWhatsAppTemplateButtonSourceHandleId(0),
            {
              nodeId: "basic-follow-up",
              label:
                "Here is the price list for the basic plan and what it includes",
            },
          ],
        ]),
      });

      expect(removal.nextStepLabel).toBe(
        "Here is the price list for the basic pl…"
      );
      expect(Array.from(removal.nextStepLabel)).toHaveLength(40);
    });

    it("drops a next step's closing period, which the notice sentence repeats", () => {
      const removalFor = (label: string) =>
        listTemplateButtonRoutesRemovedOnSave({
          savedBranchesById: new Map([
            [
              0,
              {
                buttonId: 0,
                index: 0,
                label: "Basic",
                payload: "stb:action-1:0",
              },
            ],
          ]),
          buttons: [],

          ...NO_FORM_ROUTE,
          destinationsBySourceHandle: new Map([
            [
              buildWhatsAppTemplateButtonSourceHandleId(0),
              { nodeId: "basic-follow-up", label },
            ],
          ]),
        })[0];

      expect(removalFor("An operator will reply shortly.").nextStepLabel).toBe(
        "An operator will reply shortly"
      );
      expect(removalFor("Ready?").nextStepLabel).toBe("Ready?");
      expect(removalFor("Wait...").nextStepLabel).toBe("Wait...");
    });

    it("warns, one line each, where the approved template moves routes", () => {
      const nodeData = templateData({
        actionWhatsAppTemplateComponents: planButtons("Basic", "Premium"),
        uiWhatsAppTemplates: approvedTemplate(planButtons("Premium", "Gold")),
        uiConnections: bothRouted,
      } as TemplateOverrides);
      renderSection(nodeData);

      const drift = screen.getByTestId("whatsapp-template-button-drift");
      // Premium only moved, so its route still runs and needs no line.
      expect(
        within(drift)
          .getAllByTestId("whatsapp-template-button-drift-item")
          .map(notice => notice.textContent)
      ).toEqual([
        "whatsappTemplateButtonDriftRemoved",
        "whatsappTemplateButtonDriftAddedwhatsappTemplateButtonDriftUseApproved",
      ]);

      fireEvent.click(
        within(drift).getByRole("button", {
          name: "whatsappTemplateButtonDriftUseApproved",
        })
      );
      expect(nodeData.uiWhatsAppTemplates.select).toHaveBeenCalledWith(
        "order_update::en"
      );
    });

    it("does not warn about buttons without routes", () => {
      renderSection(
        templateData({
          actionWhatsAppTemplateComponents: planButtons("Basic", "Premium"),
          uiWhatsAppTemplates: approvedTemplate(planButtons("Premium", "Gold")),
        } as TemplateOverrides)
      );
      expect(screen.queryByTestId("whatsapp-template-button-drift")).toBeNull();
    });

    it("does not warn while the approved template matches or isn't found", () => {
      const { rerenderWith } = renderSection(
        templateData({
          actionWhatsAppTemplateComponents: planButtons("Basic", "Premium"),
          uiWhatsAppTemplates: approvedTemplate(
            planButtons("Basic", "Premium")
          ),
          uiConnections: bothRouted,
        } as TemplateOverrides)
      );
      expect(screen.queryByTestId("whatsapp-template-button-drift")).toBeNull();

      rerenderWith(
        templateData({
          actionWhatsAppTemplateComponents: planButtons("Basic", "Premium"),
          uiWhatsAppTemplates: {
            ...approvedTemplate(planButtons("Gold")),
            catalogMatch: false,
          },
          uiConnections: bothRouted,
        } as TemplateOverrides)
      );
      expect(screen.queryByTestId("whatsapp-template-button-drift")).toBeNull();
    });
  });

  describe("the form button's Form submitted route", () => {
    const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
    // A reply button beside the form button, as on a mixed template.
    const formTemplate = [
      { type: "BODY", text: "Template body" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Yes" },
          {
            type: "FLOW",
            text: "Open form",
            flow_id: "1571793974235171",
            flow_action: "data_exchange",
          },
        ],
      },
    ] as WhatsAppComponent[];
    const toCarousel = {
      sourceHandleIds: [FORM_SUBMITTED],
      destinationsBySourceHandle: new Map([
        [FORM_SUBMITTED, { nodeId: "carousel", label: "Pick a medal" }],
      ]),
    };
    const formData = (overrides: TemplateOverrides = {}) =>
      templateData({
        actionWhatsAppTemplateComponents: formTemplate,
        ...overrides,
      } as TemplateOverrides);
    const formHandles = () =>
      screen
        .queryAllByTestId("handle")
        .filter(
          handle => handle.getAttribute("data-handle-id") === FORM_SUBMITTED
        );
    const removeButtons = () =>
      screen.getAllByRole("button", { name: "whatsappTemplateRemoveButton" });
    // A button row's actions end with its route dot.
    const rowHandleIds = (row: number) =>
      within(removeButtons()[row].parentElement as HTMLElement)
        .queryAllByTestId("handle")
        .map(handle => handle.getAttribute("data-handle-id"));

    // The form's health read answers after render; let it land first.
    const renderFormSection = async (
      ...args: Parameters<typeof renderSection>
    ) => {
      const view = renderSection(...args);
      await act(() => new Promise(resolve => setTimeout(resolve, 0)));
      return view;
    };

    it("draws the route's dot on the FLOW row only", async () => {
      await renderFormSection(
        formData({ uiConnections: toCarousel } as TemplateOverrides)
      );

      expect(rowHandleIds(0)).toEqual([
        buildWhatsAppTemplateButtonSourceHandleId(0),
      ]);
      expect(rowHandleIds(1)).toEqual([FORM_SUBMITTED]);
      expect(formHandles()).toHaveLength(1);
      expect(formHandles()[0].getAttribute("aria-label")).toMatch(
        /^serviceRouteFlowSubmitted/
      );
    });

    it.each<[string, TemplateOverrides, { showPorts?: boolean }]>([
      ["off the canvas", { uiConnections: toCarousel }, { showPorts: false }],
      [
        "on a bulk send's template, whose node anchors the route",
        { uiConnections: toCarousel, uiBulkPrimaryWhatsAppTemplate: true },
        {},
      ],
      [
        "on a template that no longer opens one form",
        {
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Template body" },
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
            },
          ] as WhatsAppComponent[],
          uiConnections: toCarousel,
        },
        {},
      ],
    ])(
      "draws no Form submitted dot or hint %s",
      async (_label, overrides, options) => {
        await renderFormSection(formData(overrides), options);

        expect(formHandles()).toEqual([]);
        expect(
          screen.queryByTestId("whatsapp-template-button-unsaved-route")
        ).toBeNull();
      }
    );

    it("opens the step picker from the dot with Enter", async () => {
      const createNodeFromSourceHandle = jest.fn<
        void,
        [string, number, number]
      >();
      await renderFormSection(formData(), { createNodeFromSourceHandle });
      const [dot] = formHandles();
      expect(dot).toHaveAttribute("tabindex", "0");

      dot.focus();
      fireEvent.keyDown(dot, { key: "Enter" });

      expect(createNodeFromSourceHandle).toHaveBeenCalledWith(
        FORM_SUBMITTED,
        expect.any(Number),
        expect.any(Number)
      );
    });

    it("keeps a linked route anchored while the draft has no FLOW row, and names it on Save", async () => {
      await renderFormSection(
        formData({ uiConnections: toCarousel } as TemplateOverrides)
      );
      const notices = () =>
        screen.queryAllByTestId("whatsapp-template-save-removes-route");
      expect(notices()).toEqual([]);

      fireEvent.click(removeButtons()[1]);
      await waitFor(() => expect(removeButtons()).toHaveLength(1));

      // The edge keeps one anchor, outside the remaining reply row.
      expect(formHandles()).toHaveLength(1);
      expect(rowHandleIds(0)).toEqual([
        buildWhatsAppTemplateButtonSourceHandleId(0),
      ]);
      expect(notices()).toHaveLength(1);
      fireEvent.click(
        screen.getByRole("button", { name: "whatsappTemplateUpdateShared" })
      );
      expect(
        within(await screen.findByRole("alertdialog")).getByTestId(
          "whatsapp-template-save-confirm-removes-routes"
        )
      ).toBeInTheDocument();
    });

    it("explains that saving connects a FLOW row switched to another form", async () => {
      await renderFormSection(
        formData({
          uiConnections: toCarousel,
          uiWhatsAppFlows: {
            options: [
              { id: "1571793974235171", name: "Medal form" },
              { id: "5550100", name: "Booking" },
            ],
          },
        } as TemplateOverrides)
      );
      fireEvent.keyDown(screen.getByRole("combobox", { name: "buttonFlow" }), {
        key: "ArrowDown",
      });
      fireEvent.click(await screen.findByRole("option", { name: "Booking" }));

      const hint = await screen.findByTestId(
        "whatsapp-template-button-unsaved-route"
      );
      expect(
        within(removeButtons()[1].parentElement as HTMLElement).getByTestId(
          "whatsapp-template-button-unsaved-route"
        )
      ).toBe(hint);
      // Saving keeps the route, so its edge stays anchored and nothing warns.
      expect(rowHandleIds(1)).toEqual([]);
      expect(formHandles()).toHaveLength(1);
      expect(
        screen.queryByTestId("whatsapp-template-save-removes-route")
      ).toBeNull();
    });

    it.each([
      [
        "has no form button",
        { type: "QUICK_REPLY", text: "Yes" },
        "whatsappTemplateButtonDriftFormRemoved",
      ],
      [
        "opens another form",
        { type: "FLOW", text: "Open form", flow_id: "5550100" },
        "whatsappTemplateButtonDriftFormChanged",
      ],
    ])(
      "warns when the approved template %s, and offers it to the step",
      async (_label, approvedButton, warning) => {
        const nodeData = formData({
          uiConnections: toCarousel,
          uiWhatsAppTemplates: {
            options: [
              {
                id: "meta-1",
                name: "order_update",
                language: "en",
                category: "UTILITY",
                components: [
                  { type: "BODY", text: "Template body" },
                  { type: "BUTTONS", buttons: [approvedButton] },
                ],
              },
            ],
          },
        } as TemplateOverrides);
        await renderFormSection(nodeData);

        const drift = screen.getByTestId("whatsapp-template-button-drift");
        expect(
          within(drift)
            .getAllByTestId("whatsapp-template-button-drift-item")
            .map(notice => notice.textContent)
        ).toEqual([`${warning}whatsappTemplateButtonDriftUseApproved`]);
        fireEvent.click(
          within(drift).getByRole("button", {
            name: "whatsappTemplateButtonDriftUseApproved",
          })
        );
        expect(nodeData.uiWhatsAppTemplates.select).toHaveBeenCalledWith(
          "order_update::en"
        );
      }
    );

    it("warns about saved form fields AI steps read when the approved template opens another form", async () => {
      // No Form submitted route: AI steps after Then read the saved fields.
      await renderFormSection(
        formData({
          actionWhatsAppTemplateForm: {
            version: 1,
            flowId: "1571793974235171",
            flowName: "medal_pick_1",
            answersKey: "medal_pick",
            digest: "digest-1",
            coverage: "complete",
            endpoint: false,
            readAt: "2026-10-05T06:49:00.000Z",
            fields: [],
          },
          uiWhatsAppTemplates: {
            options: [
              {
                id: "meta-1",
                name: "order_update",
                language: "en",
                category: "UTILITY",
                components: [
                  { type: "BODY", text: "Template body" },
                  {
                    type: "BUTTONS",
                    buttons: [
                      { type: "FLOW", text: "Open form", flow_id: "5550100" },
                    ],
                  },
                ],
              },
            ],
          },
        } as TemplateOverrides)
      );

      expect(
        within(screen.getByTestId("whatsapp-template-button-drift"))
          .getAllByTestId("whatsapp-template-button-drift-item")
          .map(notice => notice.textContent)
      ).toEqual([
        "whatsappTemplateButtonDriftFormChangedwhatsappTemplateButtonDriftUseApproved",
      ]);
    });

    it("lists the linked route among those Save removes only when the draft drops the form", () => {
      const removalsFor = (buttons: EditableWhatsAppTemplateButton[]) =>
        listTemplateButtonRoutesRemovedOnSave({
          savedBranchesById: new Map(),
          buttons,
          formSubmittedRoute: { placement: "row", connected: true },
          savedComponents: formTemplate,
          destinationsBySourceHandle: toCarousel.destinationsBySourceHandle,
          t,
        });
      const formButton: EditableWhatsAppTemplateButton = {
        index: 1,
        label: "Open form",
        type: "flow",
        flowId: "1571793974235171",
      };

      expect(removalsFor([])).toEqual([
        {
          key: "form-submitted",
          label: "serviceRouteFlowSubmitted",
          nextStepLabel: "Pick a medal",
        },
      ]);
      expect(removalsFor([formButton])).toEqual([]);
      expect(
        removalsFor([formButton, { ...formButton, index: 2 }])
      ).toHaveLength(1);
    });
  });

  describe("carousel templates", () => {
    const card = (text: string) => ({
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: ["https://cdn.test/item.jpg"] },
        },
        { type: "BODY", text },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Interested" },
            { type: "URL", text: "Buy", url: "https://shop.test/item" },
          ],
        },
      ],
    });
    const templateRouteHandleIds = () =>
      screen
        .queryAllByTestId("handle")
        .map(handle => handle.getAttribute("data-handle-id"))
        .filter(id =>
          id?.startsWith("right-source-whatsapp-template-button-branch::")
        );
    const carouselData = () =>
      templateData({
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Template body" },
          { type: "CAROUSEL", cards: [card("Blazer"), card("Coat")] },
        ] as WhatsAppComponent[],
      } as TemplateOverrides);

    it("shows the cards and edits only the message text", () => {
      renderSection(carouselData());

      expect(screen.getByTestId("template-carousel-preview")).toBeTruthy();
      expect(screen.getByDisplayValue("Template body")).toBeTruthy();
      for (const placeholder of [
        "whatsappTemplateHeaderPlaceholder",
        "whatsappTemplateFooterPlaceholder",
      ]) {
        expect(screen.queryByRole("textbox", { name: placeholder })).toBeNull();
      }
      expect(screen.queryByText("whatsappTemplateAddButton")).toBeNull();
    });

    it("routes the first card's quick reply before the cards are laid out", () => {
      renderSection(carouselData());

      expect(templateRouteHandleIds()).toEqual([
        buildWhatsAppTemplateButtonSourceHandleId(100),
      ]);
    });

    describe("with two cards in view", () => {
      // The step's carousel is 344px wide: two 160px cards and a sliver.
      const showCarouselAt = (scrollLeft: number) => {
        const viewport = screen.getByTestId("carousel-cards-viewport");
        const cards = viewport.querySelectorAll<HTMLElement>(
          "[data-carousel-card-id]"
        );
        Object.defineProperties(viewport, {
          clientWidth: { configurable: true, value: 344 },
          scrollLeft: { configurable: true, value: scrollLeft },
          scrollWidth: { configurable: true, value: cards.length * 168 - 8 },
        });
        for (const card of cards) {
          const index = Number(card.dataset.carouselCardId);
          Object.defineProperties(card, {
            offsetLeft: { configurable: true, value: index * 168 },
            offsetWidth: { configurable: true, value: 160 },
          });
        }
        fireEvent.scroll(viewport);
      };
      const fourCardData = (overrides: TemplateOverrides = {}) =>
        templateData({
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Template body" },
            {
              type: "CAROUSEL",
              cards: ["Premiata", "Lacoste", "Boss", "Boggi"].map(card),
            },
          ] as WhatsAppComponent[],
          ...overrides,
        } as TemplateOverrides);
      const handleIds = (...buttonIds: number[]) =>
        buttonIds.map(buildWhatsAppTemplateButtonSourceHandleId);

      it("routes the last card's quick reply once scrolled to the end", () => {
        renderSection(fourCardData());

        showCarouselAt(320);

        expect(templateRouteHandleIds()).toEqual(handleIds(120, 130));
      });

      it("routes both cards in view at the start", () => {
        renderSection(fourCardData());

        showCarouselAt(0);

        expect(templateRouteHandleIds()).toEqual(handleIds(100, 110));
      });

      it("routes both cards of a carousel that doesn't scroll", () => {
        renderSection(carouselData());

        showCarouselAt(0);

        expect(templateRouteHandleIds()).toEqual(handleIds(100, 110));
      });

      it("keeps the last card's linked route on its card at the end", () => {
        renderSection(
          fourCardData({
            uiConnections: {
              templateButtonPayloads: ["stb:action-1:100", "stb:action-1:130"],
            },
          } as TemplateOverrides)
        );

        showCarouselAt(320);

        const lastCard = screen
          .getByTestId("carousel-cards-viewport")
          .querySelector("[data-carousel-card-id='3']") as HTMLElement;
        expect(
          within(lastCard)
            .getAllByTestId("handle")
            .map(handle => handle.getAttribute("data-handle-id"))
        ).toEqual(handleIds(130));
        expect(
          within(screen.getByTestId("carousel-option-handle-rail"))
            .getAllByTestId(/^carousel-option-handle-slot-/)
            .map(slot => slot.dataset.testid)
        ).toEqual(["carousel-option-handle-slot-stb:action-1:100"]);
      });

      it("keeps the next-cards arrow above the route dots", () => {
        renderSection(fourCardData());

        showCarouselAt(168);

        expect(
          screen.getByRole("button", { name: "form.carouselScrollNext" })
            .className
        ).toContain("z-30");
      });
    });

    it("draws no routes off the canvas", () => {
      renderSection(carouselData(), { showPorts: false });

      expect(screen.getByTestId("template-carousel-preview")).toBeTruthy();
      expect(templateRouteHandleIds()).toEqual([]);
    });

    it("never lists a card route as removed on Save", () => {
      expect(
        listTemplateButtonRoutesRemovedOnSave({
          savedBranchesById: new Map([
            [
              100,
              {
                buttonId: 100,
                index: 0,
                cardIndex: 0,
                label: "Interested",
                payload: "stb:action-1:100",
              },
            ],
          ]),
          buttons: [],

          ...NO_FORM_ROUTE,
          destinationsBySourceHandle: new Map([
            [
              buildWhatsAppTemplateButtonSourceHandleId(100),
              { nodeId: "interested", label: "Interested follow-up" },
            ],
          ]),
        })
      ).toEqual([]);
    });
  });

  describe("form button first screen", () => {
    // Form ids are unique per test: the browser caches a form's screens.
    function answerFormScreens(screensByFlowId: Record<string, string[]>) {
      mockFetch.mockImplementation(async (input: unknown) => {
        const url = String(input);
        if (!url.startsWith("/api/whatsapp/flows/template-health")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, message: "Updated in Meta" }),
          };
        }
        const flowIds =
          new URLSearchParams(url.split("?")[1]).get("flowIds")?.split(",") ??
          [];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            facts: flowIds.map(flowId => ({
              flowId,
              state: "found",
              name: null,
              status: "PUBLISHED",
              screenIds: screensByFlowId[flowId] ?? null,
              checkedAt: new Date().toISOString(),
            })),
          }),
        };
      });
    }
    const formTemplate = (button: Record<string, unknown>) =>
      [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [{ type: "FLOW", text: "Book", ...button }],
        },
      ] as WhatsAppComponent[];
    const firstScreen = () =>
      screen.getByRole("combobox", { name: "whatsappTemplateFirstScreen" });
    const choose = async (combobox: HTMLElement, option: string) => {
      fireEvent.keyDown(combobox, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name: option }));
    };
    const templateHealthCalls = () =>
      mockFetch.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/whatsapp/flows/template-health")
      );

    it("sets a chosen form's first screen, and saves the screen picked", async () => {
      answerFormScreens({
        "5550001": ["OLD_START"],
        "5550002": ["WELCOME", "DETAILS"],
      });
      const { patchNode } = renderSection(
        templateData({
          actionWhatsAppTemplateComponents: formTemplate({
            flow_id: "5550001",
            flow_action: "navigate",
            navigate_screen: "OLD_START",
          }),
          uiWhatsAppFlows: {
            options: [
              { id: "5550001", name: "Old form" },
              { id: "5550002", name: "Booking" },
            ],
          },
        } as TemplateOverrides)
      );
      await waitFor(() => expect(firstScreen()).toBeEnabled());
      expect(firstScreen()).toHaveTextContent("OLD_START");

      await choose(
        screen.getByRole("combobox", { name: "buttonFlow" }),
        "Booking"
      );
      await waitFor(() => expect(firstScreen()).toHaveTextContent("WELCOME"));
      await choose(firstScreen(), "DETAILS");
      expect(firstScreen()).toHaveTextContent("DETAILS");

      fireEvent.click(
        screen.getByRole("button", { name: "whatsappTemplateUpdateShared" })
      );
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "whatsappTemplateUpdateShared",
        })
      );

      const savedButton = {
        type: "FLOW",
        text: "Book",
        flow_id: "5550002",
        flow_action: "navigate",
        navigate_screen: "DETAILS",
      };
      await waitFor(() =>
        expect(patchNode).toHaveBeenCalledWith(
          expect.objectContaining({
            actionWhatsAppTemplateComponents: expect.arrayContaining([
              { type: "BUTTONS", buttons: [savedButton] },
            ]),
          })
        )
      );
      const [, request] = mockFetch.mock.calls.find(
        ([url]) => url === "/api/whatsapp/templates"
      )!;
      expect(JSON.parse(String(request.body)).components).toContainEqual({
        type: "BUTTONS",
        buttons: [savedButton],
      });
    });

    it("keeps a saved screen the form lost, without changing the template", async () => {
      answerFormScreens({ "5550003": ["WELCOME"] });
      renderSection(
        templateData({
          actionWhatsAppTemplateComponents: formTemplate({
            flow_id: "5550003",
            flow_action: "navigate",
            navigate_screen: "GONE",
          }),
        } as TemplateOverrides)
      );

      await waitFor(() => expect(firstScreen()).toBeEnabled());
      expect(firstScreen()).toHaveTextContent(
        "whatsappTemplateFirstScreenMissing"
      );
      expect(screen.queryByTestId("whatsapp-template-save-bar")).toBeNull();
    });

    it("sets the first screen when the button switches to opening one", async () => {
      answerFormScreens({ "5550004": ["START", "DETAILS"] });
      renderSection(
        templateData({
          actionWhatsAppTemplateComponents: formTemplate({
            flow_id: "5550004",
            flow_action: "data_exchange",
          }),
        } as TemplateOverrides)
      );
      expect(screen.queryByTestId("template-flow-first-screen")).toBeNull();

      fireEvent.keyDown(
        screen.getByRole("button", { name: "whatsappTemplateButtonEditType" }),
        { key: "Enter" }
      );
      fireEvent.click(
        await screen.findByRole("menuitemradio", {
          name: "whatsappTemplateFlowActionNavigation",
        })
      );

      await waitFor(() => expect(firstScreen()).toHaveTextContent("START"));
      expect(
        await screen.findByTestId("whatsapp-template-save-bar")
      ).toBeInTheDocument();
    });

    it.each([
      ["the health notice's check", "flowHealth.checkAgain", "5550005"],
      ["the field's reload", "whatsappTemplateFirstScreenReload", "5550006"],
    ])(
      "updates the field and the health notice together after %s",
      async (_, reloadButton, flowId) => {
        answerFormScreens({ [flowId]: ["WELCOME"] });
        renderSection(
          templateData({
            actionWhatsAppTemplateComponents: formTemplate({
              flow_id: flowId,
              flow_action: "navigate",
              navigate_screen: "OLD",
            }),
          } as TemplateOverrides)
        );
        await waitFor(() => expect(firstScreen()).toBeEnabled());
        expect(firstScreen()).toHaveAttribute("data-missing-screen");
        expect(
          await screen.findByTestId("template-flow-health-notice")
        ).toBeInTheDocument();

        // The merchant puts the screen back in the form in WhatsApp.
        answerFormScreens({ [flowId]: ["WELCOME", "OLD"] });
        fireEvent.click(screen.getByRole("button", { name: reloadButton }));

        await waitFor(() =>
          expect(screen.queryByTestId("template-flow-health-notice")).toBeNull()
        );
        expect(firstScreen()).toHaveTextContent("OLD");
        expect(firstScreen()).not.toHaveAttribute("data-missing-screen");
        expect(
          templateHealthCalls().filter(([url]) =>
            String(url).includes("refresh=1")
          )
        ).toHaveLength(1);
      }
    );

    it.each([
      ["the step editor", true, "5550010"],
      ["the settings drawer", false, "5550011"],
    ])(
      "shows the form fields notice under the health notice in %s",
      async (_, showPorts, flowId) => {
        answerFormScreens({ [flowId]: ["WELCOME"] });
        renderSection(
          templateData({
            actionWhatsAppTemplateComponents: formTemplate({
              flow_id: flowId,
              flow_action: "navigate",
              navigate_screen: "GONE",
            }),
          } as TemplateOverrides),
          { showPorts }
        );

        const health = await screen.findByTestId("template-flow-health-notice");
        const fields = screen.getByTestId(
          "whatsapp-template-form-fields-notice"
        );
        expect(fields).toHaveTextContent("whatsappTemplateFormFieldsMissing");
        expect(
          health.compareDocumentPosition(fields) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        // Both notices read the form in one request.
        expect(templateHealthCalls()).toHaveLength(1);
      }
    );

    it("edits the template's form with every form's key, so its own stays unique", async () => {
      answerFormScreens({ "5550009": ["START"] });
      const formKeys = new Map([["other-form", "lead_generation"]]);
      renderSection(
        templateData({
          actionWhatsAppTemplateComponents: formTemplate({
            flow_id: "5550009",
            flow_action: "navigate",
          }),
          actionFlowConfig: {
            templateId: "lead_generation",
            ctaText: "Book",
            metaFlowId: "5550009",
            screens: [],
          },
          uiScenarioFormKeys: formKeys,
        } as TemplateOverrides)
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "whatsappTemplateOpenFlow" })
      );
      expect(await screen.findByTestId("mock-flow-builder")).toBeTruthy();
      expect(mockFlowBuilderProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          nodeId: "action-1",
          formKeysByNodeId: formKeys,
        })
      );
    });

    it("reads no form screens for templates without form buttons", async () => {
      renderSection(
        templateData({
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Template body" },
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
            },
          ] as WhatsAppComponent[],
        } as TemplateOverrides)
      );
      await act(async () => {});

      expect(screen.queryByTestId("template-flow-first-screen")).toBeNull();
      expect(templateHealthCalls()).toEqual([]);
    });
  });

  it("shows no route hint in the settings panel", async () => {
    renderSection(templateData(), { showPorts: false });
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateAddButton" })
    );
    await screen.findByTestId("whatsapp-template-save-bar");
    expect(
      screen.queryByTestId("whatsapp-template-button-unsaved-route")
    ).toBeNull();
  });

  it("offers to clear conversation values that conflict with a bulk send", () => {
    const { patchNode } = renderSection(
      templateData({
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Order {{1}}" },
        ] as WhatsAppComponent[],
        actionWhatsAppTemplateBindings: {
          version: 1,
          parameters: { "body:1": { source: "literal", value: "A1" } },
        },
        uiBulkPrimaryAction: true,
      } as TemplateOverrides)
    );
    const notice = screen.getByTestId("whatsapp-template-bulk-conflict");
    expect(notice).toHaveAttribute("data-tone", "error");
    expect(notice).toHaveTextContent("whatsappTemplateBindingsBulkConflict");
    fireEvent.click(
      within(notice).getByRole("button", {
        name: "whatsappTemplateBindingsUseCampaign",
      })
    );
    expect(patchNode).toHaveBeenCalledWith({
      actionWhatsAppTemplateBindings: undefined,
    });
  });

  it("folds the variables into a section on the canvas card only", () => {
    const data = templateData({
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Order {{1}}" },
      ] as WhatsAppComponent[],
      actionWhatsAppTemplateBindings: { version: 1, parameters: {} },
    } as TemplateOverrides);
    const canvas = renderSection(data);
    expect(screen.getByTestId("template-bindings-section")).toBeInTheDocument();
    canvas.unmount();
    renderSection(data, { showPorts: false });
    expect(screen.queryByTestId("template-bindings-section")).toBeNull();
    expect(
      screen.getByTestId("template-bindings-action-1")
    ).toBeInTheDocument();
  });
});

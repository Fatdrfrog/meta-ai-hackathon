/** @jest-environment jsdom */

/**
 * Regression (fix/template-button-routes): while the author edits a template
 * on the canvas, each reply-button row must keep its own route dot.
 *
 * Today a draft row draws the saved route handle at its current position
 * (use-whatsapp-template-preview-buttons.tsx savedPayloadsByIndex.get(button.index)),
 * so removing the first button moves that button's route dot, and the edge
 * wired to it, onto the next button before anything is saved.
 *
 * Mocks mirror action-node-whatsapp-template-section.test.tsx.
 */
import type { ReactNode } from "react";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}));

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

jest.mock("@xyflow/react", () => ({
  Handle: ({
    children,
    id,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    id?: string;
    "aria-label"?: string;
  }) => (
    <div data-testid="handle" data-handle-id={id} aria-label={ariaLabel}>
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

jest.mock("../../builders/whatsapp/inline-editor", () => ({
  WhatsAppInlineEditor: ({
    value,
    onChange,
    ariaLabel,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel?: string;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={ariaLabel || placeholder || "editor"}
      value={value}
      onChange={event => onChange(event.target.value)}
    />
  ),
}));

jest.mock("@/components/whatsapp-templates/template-form-drawer", () => ({
  TemplateFormDrawer: () => null,
}));

import type { WhatsAppComponent } from "@icecore/scenario-contracts";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom";
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
import {
  installMatchMedia,
  installResizeObserver,
} from "@/test-support/dom-test-utils";

beforeAll(() => {
  installResizeObserver();
  Element.prototype.scrollIntoView = jest.fn();
  Object.defineProperty(global, "fetch", { writable: true, value: jest.fn() });
  installMatchMedia();
});

const t = (key: string) => key;

function planMenuNodeData() {
  return createActionEditorTestData({
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "pick_plan",
    actionWhatsAppTemplateLanguage: "en",
    actionWhatsAppTemplateComponents: [
      { type: "BODY", text: "Which plan do you want?" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Basic" },
          { type: "QUICK_REPLY", text: "Premium" },
        ],
      },
    ] as WhatsAppComponent[],
    uiWorkspaceId: "workspace-1",
    uiWhatsAppTemplates: {
      options: [
        {
          id: "meta-1",
          name: "pick_plan",
          language: "en",
          category: "MARKETING",
        },
      ],
      selectedValue: "pick_plan::en",
      catalogMatch: true,
    },
  } as ActionNodeTestData);
}

function renderCanvasSection(nodeData: ReturnType<typeof planMenuNodeData>) {
  const mode = resolveActionNodeModeState(nodeData);
  render(
    <ActionNodeWhatsAppTemplateSection
      id="menu"
      branchState={resolveActionNodeBranchState({
        id: "menu",
        mode,
        nodeData,
        renderMode: "expanded",
        t,
      })}
      loadingLabel="loadingItems"
      mode={mode}
      nodeData={nodeData}
      patchNode={jest.fn<void, [Partial<ScenarioNodeData>]>()}
      showPorts
      whatsAppFlowsLoading={false}
      whatsAppFlowsRefreshing={false}
      whatsAppTemplatesLoading={false}
      whatsAppTemplatesRefreshing={false}
    />
  );
}

function removeButtons() {
  return screen.getAllByRole("button", {
    name: "whatsappTemplateRemoveButton",
  });
}

/** The route handle ids drawn in each button row, in row order. */
function routeHandlesByRow() {
  return removeButtons().map(removeButton =>
    within(removeButton.parentElement as HTMLElement)
      .queryAllByTestId("handle")
      .map(handle => handle.getAttribute("data-handle-id"))
  );
}

describe("template reply-button route dots stay on their button while editing (regression)", () => {
  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("removing the first reply button does not move its route dot onto the remaining button", async () => {
    renderCanvasSection(planMenuNodeData());
    const [basicRouteHandles, premiumRouteHandles] = routeHandlesByRow();
    expect(basicRouteHandles).toHaveLength(1);
    expect(premiumRouteHandles).toHaveLength(1);
    expect(premiumRouteHandles).not.toEqual(basicRouteHandles);

    fireEvent.click(removeButtons()[0]);
    await waitFor(() => expect(removeButtons()).toHaveLength(1));

    expect(routeHandlesByRow()).toEqual([premiumRouteHandles]);
  });
});

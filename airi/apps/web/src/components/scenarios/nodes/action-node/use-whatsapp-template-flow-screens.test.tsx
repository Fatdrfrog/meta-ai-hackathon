/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { useCallback } from "react";
import { useForm } from "react-hook-form";
import { fetchTemplateFlowFacts } from "@/lib/whatsapp/flows/client";
import type { TemplateFlowFacts } from "@/lib/whatsapp/flows/template-flow-health";
import type {
  EditableWhatsAppTemplateButton,
  EditableWhatsAppTemplateEditorFormValues,
} from "../../builders/whatsapp/template-editor-utils";
import {
  applyEditableTemplateButtonPatch,
  reindexEditableTemplateButtons,
  type EditableTemplateButtonPatch,
} from "./action-node-template-editor";
import { useWhatsAppTemplateFlowScreens } from "./use-whatsapp-template-flow-screens";

jest.mock("@/lib/whatsapp/flows/client", () => ({
  fetchTemplateFlowFacts: jest.fn(),
}));

const fetchFacts = jest.mocked(fetchTemplateFlowFacts);
const FORM_ID = "1234567890";
const OTHER_FORM_ID = "9876543210";

function found(flowId: string, screenIds: string[]): TemplateFlowFacts {
  return {
    flowId,
    state: "found",
    name: null,
    status: "PUBLISHED",
    screenIds,
    checkedAt: "2026-09-29T10:00:00.000Z",
  };
}

const SCREENS: Record<string, string[]> = {
  [FORM_ID]: ["WELCOME", "DETAILS"],
  [OTHER_FORM_ID]: ["START"],
};

function screensOf(flowIds: readonly string[]) {
  return Object.fromEntries(
    flowIds.map(flowId => [flowId, found(flowId, SCREENS[flowId] ?? [])])
  );
}

function answerWithScreens() {
  fetchFacts.mockImplementation(async ({ flowIds }) => screensOf(flowIds));
}

/**
 * Holds every screen lookup until the test answers it. The default and the
 * tray's lookup each ask, so an answer settles every call for that form.
 */
function holdAnswers() {
  const calls: Array<{
    flowIds: readonly string[];
    settle: (facts: Record<string, TemplateFlowFacts>) => void;
  }> = [];
  fetchFacts.mockImplementation(
    ({ flowIds }) =>
      new Promise(settle => {
        calls.push({ flowIds, settle });
      })
  );
  return (flowId: string) =>
    act(async () => {
      for (const call of calls.filter(item => item.flowIds.includes(flowId))) {
        call.settle(screensOf(call.flowIds));
      }
    });
}

function formButton(
  overrides: Partial<EditableWhatsAppTemplateButton> = {}
): EditableWhatsAppTemplateButton {
  return {
    index: 0,
    type: "flow",
    label: "Book",
    flowId: FORM_ID,
    flowAction: "navigate",
    ...overrides,
  };
}

function useHarness(
  workspaceId: string | undefined,
  buttons: EditableWhatsAppTemplateButton[],
  healthComponents?: unknown,
  fieldsFlowId?: string
) {
  const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
    defaultValues: { headerText: "", bodyText: "Hi", footerText: "", buttons },
  });
  // eslint-disable-next-line react-hooks/incompatible-library -- The editor watches its buttons the same way.
  const watchedButtons = form.watch("buttons");
  const updateButton = useCallback(
    (buttonIndex: number, patch: EditableTemplateButtonPatch) => {
      form.setValue(
        "buttons",
        form
          .getValues("buttons")
          .map(button =>
            button.index === buttonIndex
              ? applyEditableTemplateButtonPatch(button, patch)
              : button
          )
      );
    },
    [form]
  );
  return {
    form,
    ...useWhatsAppTemplateFlowScreens({
      workspaceId,
      form,
      buttons: watchedButtons,
      updateButton,
      healthComponents,
      fieldsFlowId,
    }),
  };
}

function renderHarness(
  buttons: EditableWhatsAppTemplateButton[],
  workspaceId: string | undefined = "workspace-1",
  healthComponents?: unknown,
  fieldsFlowId?: string
) {
  const view = renderHook(() =>
    useHarness(workspaceId, buttons, healthComponents, fieldsFlowId)
  );
  const screenOf = () =>
    view.result.current.form.getValues("buttons.0.navigateScreen");
  return { ...view, screenOf };
}

beforeEach(() => {
  jest.clearAllMocks();
  answerWithScreens();
});

it("sets a newly chosen form's first screen", async () => {
  const { result, screenOf } = renderHarness([
    formButton({ flowId: OTHER_FORM_ID, navigateScreen: "START" }),
  ]);

  act(() => result.current.updateButton(0, { flowId: FORM_ID }));

  await waitFor(() => expect(screenOf()).toBe("WELCOME"));
  await waitFor(() =>
    expect(result.current.lookup?.screensFor(FORM_ID)).toEqual({
      status: "ready",
      screenIds: ["WELCOME", "DETAILS"],
    })
  );
});

it("sets the first screen when a button switches to opening one", async () => {
  const { result, screenOf } = renderHarness([
    formButton({ flowAction: "data_exchange" }),
  ]);

  act(() => result.current.updateButton(0, { flowAction: "navigate" }));

  await waitFor(() => expect(screenOf()).toBe("WELCOME"));
});

it("keeps a screen the merchant chose while the screens loaded", async () => {
  const answer = holdAnswers();
  const { result, screenOf } = renderHarness([formButton({ flowId: "" })]);

  act(() => result.current.updateButton(0, { flowId: FORM_ID }));
  act(() => result.current.updateButton(0, { navigateScreen: "DETAILS" }));
  await answer(FORM_ID);

  expect(screenOf()).toBe("DETAILS");
});

it("ignores a form's late screens once the merchant chose another form", async () => {
  const answer = holdAnswers();
  const { result, screenOf } = renderHarness([formButton({ flowId: "" })]);

  act(() => result.current.updateButton(0, { flowId: FORM_ID }));
  act(() => result.current.updateButton(0, { flowId: OTHER_FORM_ID }));
  await answer(FORM_ID);
  expect(screenOf()).toBeUndefined();

  await answer(OTHER_FORM_ID);
  expect(screenOf()).toBe("START");
});

it("sets the first screen after the rows renumber", async () => {
  const answer = holdAnswers();
  const { result } = renderHarness([
    { index: 0, type: "quick_reply", label: "Yes" },
    formButton({ index: 1, flowId: "" }),
  ]);

  act(() => result.current.updateButton(1, { flowId: FORM_ID }));
  act(() =>
    result.current.form.setValue(
      "buttons",
      reindexEditableTemplateButtons(
        result.current.form.getValues("buttons").slice(1)
      )
    )
  );
  await answer(FORM_ID);

  expect(result.current.form.getValues("buttons")).toEqual([
    expect.objectContaining({ index: 0, navigateScreen: "WELCOME" }),
  ]);
});

it("sets no screen when the step opens, or for other edits", async () => {
  const { result, screenOf } = renderHarness([formButton()]);

  await waitFor(() =>
    expect(result.current.lookup?.screensFor(FORM_ID).status).toBe("ready")
  );
  act(() => result.current.updateButton(0, { label: "Book now" }));
  await act(async () => {});

  expect(screenOf()).toBeUndefined();
  expect(result.current.form.getValues("buttons.0.label")).toBe("Book now");
});

it("reads the health notice's forms in the same request", async () => {
  const { result } = renderHarness([formButton()], "workspace-1", [
    {
      type: "BUTTONS",
      buttons: [{ type: "FLOW", text: "Book", flow_id: OTHER_FORM_ID }],
    },
  ]);

  await waitFor(() =>
    expect(result.current.flowFacts.factsByFlowId).toEqual(
      screensOf([FORM_ID, OTHER_FORM_ID])
    )
  );
  expect(fetchFacts).toHaveBeenCalledTimes(1);
  expect(fetchFacts.mock.calls[0]?.[0].flowIds).toEqual([
    FORM_ID,
    OTHER_FORM_ID,
  ]);
});

it("reads the saved template's form for its fields though the approved one opens another", async () => {
  const { result } = renderHarness(
    [],
    "workspace-1",
    [
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Book", flow_id: OTHER_FORM_ID }],
      },
    ],
    FORM_ID
  );

  await waitFor(() =>
    expect(result.current.flowFacts.factsByFlowId).toEqual(
      screensOf([FORM_ID, OTHER_FORM_ID])
    )
  );
  expect(fetchFacts).toHaveBeenCalledTimes(1);
  expect(fetchFacts.mock.calls[0]?.[0].flowIds).toEqual([
    FORM_ID,
    OTHER_FORM_ID,
  ]);
});

it("reads no screens without a workspace", async () => {
  const { result, screenOf } = renderHarness([formButton({ flowId: "" })], "");

  act(() => result.current.updateButton(0, { flowId: FORM_ID }));
  await act(async () => {});

  expect(result.current.lookup).toBeUndefined();
  expect(fetchFacts).not.toHaveBeenCalled();
  expect(screenOf()).toBeUndefined();
});

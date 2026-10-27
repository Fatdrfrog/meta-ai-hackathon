/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import type { ScenarioWhatsAppTemplateForm } from "@icecore/scenario-contracts";
import type { TemplateFlowFacts } from "@/lib/whatsapp/flows/template-flow-health";
import type { ScenarioTemplateFormLoadResult } from "../../view/use-scenario-template-form-loader";
import {
  createActionEditorTestData,
  type ActionNodeTestData,
} from "./action-node-test-utils";
import { ActionNodeWhatsAppTemplateFormFields } from "./action-node-whatsapp-template-form-fields";

let mockMessages: Record<string, string> | null = null;

// Keys show as themselves, with their values, unless a test reads a catalog.
jest.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      const message = mockMessages?.[key];
      if (message === undefined) {
        return values ? `${key}:${JSON.stringify(values)}` : key;
      }
      return message.replace(/\{(\w+)\}/g, (_match, name) =>
        String(values?.[name] ?? "")
      );
    },
}));

const FLOW_ID = "1571793974235171";
const CHECKED_AT = "2026-10-05T10:00:00.000Z";

const SAVED_FORM: ScenarioWhatsAppTemplateForm = {
  version: 1,
  flowId: FLOW_ID,
  flowName: "demoshop_ai_case",
  answersKey: "demoshop_ai_case",
  digest: "old",
  coverage: "complete",
  endpoint: false,
  readAt: "2026-10-01T00:00:00.000Z",
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

const FACTS: TemplateFlowFacts = {
  flowId: FLOW_ID,
  state: "found",
  name: "demoshop_ai_case",
  status: "PUBLISHED",
  screenIds: ["QUESTION_ONE"],
  answerSchema: {
    flowName: "demoshop_ai_case",
    digest: "new",
    coverage: "complete",
    endpoint: false,
    fields: [],
  },
  checkedAt: CHECKED_AT,
};

type LoadArgs = [string, { confirmRemovals?: boolean }?];
type Load = jest.Mock<Promise<ScenarioTemplateFormLoadResult>, LoadArgs>;

function stepData(
  overrides: Partial<ActionNodeTestData> = {},
  { load, loading = false }: { load: Load; loading?: boolean }
) {
  return createActionEditorTestData({
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "demoshop_test",
    actionWhatsAppTemplateComponents: [
      { type: "BODY", text: "Choose your medal" },
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Open form", flow_id: FLOW_ID }],
      },
    ],
    uiScenarioFormKeys: new Map([["template", "demoshop_ai_case"]]),
    ...overrides,
    uiWhatsAppTemplates: { formFields: { flowId: FLOW_ID, loading, load } },
  } as ActionNodeTestData);
}

type FlowFactsState = { facts?: TemplateFlowFacts; refreshing?: boolean };

function renderFields(
  overrides: Partial<ActionNodeTestData> = {},
  {
    result = { status: "skipped" },
    facts = FACTS,
  }: { result?: ScenarioTemplateFormLoadResult; facts?: TemplateFlowFacts } = {}
) {
  const load: Load = jest.fn<Promise<ScenarioTemplateFormLoadResult>, LoadArgs>(
    async () => result
  );
  const refresh = jest.fn<Promise<void>, [readonly string[]]>(async () => {});
  // Stand-ins for the step around the notice, which selects and drags.
  const onStepClick = jest.fn();
  const onStepPointerDown = jest.fn();
  const onStepKeyDown = jest.fn();
  const element = (
    data = stepData(overrides, { load }),
    { facts: current = facts, refreshing = false }: FlowFactsState = {}
  ) => (
    <div
      onClick={onStepClick}
      onPointerDown={onStepPointerDown}
      onKeyDown={onStepKeyDown}
    >
      <ActionNodeWhatsAppTemplateFormFields
        id="template"
        nodeData={data}
        flowFacts={{
          factsByFlowId: { [FLOW_ID]: current },
          refresh,
          isRefreshing: () => refreshing,
        }}
      />
    </div>
  );
  const view = render(element());
  return {
    ...view,
    load,
    refresh,
    onStepClick,
    onStepPointerDown,
    onStepKeyDown,
    rerenderWith: (
      data: Partial<ActionNodeTestData>,
      { loading, ...flowFacts }: { loading?: boolean } & FlowFactsState = {}
    ) => view.rerender(element(stepData(data, { load, loading }), flowFacts)),
  };
}

const notice = () => screen.getByTestId("whatsapp-template-form-fields-notice");
const action = () => screen.getByTestId("whatsapp-template-form-fields-action");
const status = () => screen.getByRole("status");

beforeEach(() => {
  mockMessages = null;
});

const SAVED_ONE: ScenarioTemplateFormLoadResult = {
  status: "saved",
  fieldCount: 1,
  coverage: "complete",
  newlyUnavailable: [],
};
const LOADED_ONE = 'whatsappTemplateFormFieldsLoaded:{"count":1}';

it("loads a form's fields on a press, then reads out how many AI steps can use", async () => {
  const { load, rerenderWith } = renderFields({}, { result: SAVED_ONE });
  expect(notice()).toHaveTextContent("whatsappTemplateFormFieldsMissing");
  expect(notice()).toHaveAttribute("data-tone", "info");
  // It appeared on open, so nothing reads it out.
  expect(notice()).not.toHaveAttribute("role");
  expect(status()).toBeEmptyDOMElement();

  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateFormFieldsLoad" })
  );
  expect(load).toHaveBeenCalledWith("load", {});
  // The loader saved the fields on the step.
  await act(async () => {});
  rerenderWith({
    actionWhatsAppTemplateForm: { ...SAVED_FORM, readAt: CHECKED_AT },
  });

  expect(notice()).toHaveTextContent(LOADED_ONE);
  expect(status()).toHaveTextContent(LOADED_ONE);
  expect(screen.queryByRole("button")).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  ["after", false],
  ["before", true],
])(
  "keeps focus on the notice when its button goes, with the fields saved %s the answer",
  async (_, savedFirst) => {
    const { load, rerenderWith } = renderFields();
    const answer = deferred<ScenarioTemplateFormLoadResult>();
    load.mockImplementation(() => answer.promise);
    // Mounted before the press, so screen readers read out its answer.
    const before = status();
    const user = userEvent.setup();

    action().focus();
    await user.keyboard("{Enter}");
    rerenderWith({}, { loading: true });
    expect(action()).toHaveFocus();
    // The loader saves the fields on the step as it answers; the step can
    // show them first, which hides the notice for a moment.
    const saved = { ...SAVED_FORM, readAt: CHECKED_AT };
    if (savedFirst) rerenderWith({ actionWhatsAppTemplateForm: saved });
    await act(async () => answer.resolve(SAVED_ONE));
    if (!savedFirst) rerenderWith({ actionWhatsAppTemplateForm: saved });

    expect(screen.queryByRole("button")).toBeNull();
    expect(notice()).toHaveFocus();
    expect(status()).toBe(before);
    expect(before).toHaveTextContent(LOADED_ONE);
    expect(notice()).not.toHaveAttribute("role");
  }
);

it("leaves focus where the user moved it while the form was read", async () => {
  const step = { actionWhatsAppTemplateForm: SAVED_FORM };
  const { load, rerenderWith } = renderFields(step);
  const answer = deferred<ScenarioTemplateFormLoadResult>();
  load.mockImplementation(() => answer.promise);
  const elsewhere = document.body.appendChild(document.createElement("input"));

  action().focus();
  fireEvent.click(action());
  rerenderWith(step, { loading: true });
  elsewhere.focus();
  // WhatsApp's form has the saved fields, so the answer takes the button away.
  await act(async () => answer.resolve({ status: "unchanged" }));
  rerenderWith(step);

  expect(notice()).toHaveTextContent(LOADED_ONE);
  expect(elsewhere).toHaveFocus();
  elsewhere.remove();
});

const queryNotice = () =>
  screen.queryByTestId("whatsapp-template-form-fields-notice");

/** WhatsApp's form, read at `checkedAt`, sending the answers of `digest`. */
function readFacts(digest: string, checkedAt: string): TemplateFlowFacts {
  return {
    flowId: FLOW_ID,
    state: "found",
    name: "demoshop_ai_case",
    status: "PUBLISHED",
    screenIds: ["QUESTION_ONE"],
    answerSchema: {
      flowName: "demoshop_ai_case",
      digest,
      coverage: "complete",
      endpoint: false,
      fields: [],
    },
    checkedAt,
  };
}

// The form sends the answers SAVED_FORM lists.
const SAVED_FACTS = readFacts("old", CHECKED_AT);
// Read a day later: the form changed in WhatsApp.
const LATER_FACTS = readFacts("later", "2026-10-06T10:00:00.000Z");

it("leaves focus on the page when a Retry hides the notice, and a later notice never takes it", async () => {
  const step = { actionWhatsAppTemplateForm: SAVED_FORM };
  const { refresh, rerenderWith } = renderFields(step, {
    facts: { flowId: FLOW_ID, state: "unavailable", checkedAt: CHECKED_AT },
  });
  expect(action()).toHaveTextContent("retry");

  action().focus();
  await act(async () => fireEvent.click(action()));
  expect(refresh).toHaveBeenCalledWith([FLOW_ID]);
  rerenderWith(step, { refreshing: true });
  expect(action()).toHaveFocus();
  // WhatsApp's form has the saved fields, so the notice goes for good, and
  // focus falls to the page with its button.
  rerenderWith(step, { facts: SAVED_FACTS });
  expect(queryNotice()).toBeNull();
  expect(document.body).toHaveFocus();

  // Later the form changes in WhatsApp; nobody pressed the notice since.
  rerenderWith(step, { facts: LATER_FACTS });
  expect(notice()).toHaveTextContent("whatsappTemplateFormFieldsChanged");
  expect(document.body).toHaveFocus();
});

it("stops waiting for the notice once a Load's answer leaves it hidden", async () => {
  const { load, rerenderWith } = renderFields();
  const answer = deferred<ScenarioTemplateFormLoadResult>();
  load.mockImplementation(() => answer.promise);

  action().focus();
  fireEvent.click(action());
  rerenderWith({}, { loading: true });
  // Another read saved the form's fields on the step first, which hides
  // the notice; this press then finds them unchanged.
  const step = {
    actionWhatsAppTemplateForm: { ...SAVED_FORM, readAt: CHECKED_AT },
  };
  rerenderWith(step);
  expect(queryNotice()).toBeNull();
  await act(async () => answer.resolve({ status: "unchanged" }));
  expect(queryNotice()).toBeNull();
  expect(document.body).toHaveFocus();

  rerenderWith(step, { facts: LATER_FACTS });
  expect(notice()).toHaveTextContent("whatsappTemplateFormFieldsChanged");
  expect(document.body).toHaveFocus();
});

const NAME_TOKEN = "form.demoshop_ai_case.f_68d224";
const REMOVES_NAME: ScenarioTemplateFormLoadResult = {
  status: "needs_confirmation",
  newlyUnavailable: [{ token: NAME_TOKEN, label: "Athlete's name" }],
};

it("updates a changed form only after confirming it removes answers AI steps read", async () => {
  const { load } = renderFields(
    {
      actionWhatsAppTemplateForm: SAVED_FORM,
      uiScenarioFormAnswerTokensRead: [NAME_TOKEN],
    },
    { result: REMOVES_NAME }
  );
  expect(notice()).toHaveTextContent("whatsappTemplateFormFieldsChanged");
  expect(notice()).toHaveAttribute("data-tone", "warning");

  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateFormFieldsUpdate" })
  );
  await act(async () => {});

  expect(load).toHaveBeenLastCalledWith("update", {});
  expect(notice()).toHaveTextContent(
    `whatsappTemplateFormFieldsRemovesUsed:${JSON.stringify({
      labels: `whatsappTemplateButtonQuoted:${JSON.stringify({ label: "Athlete's name" })}`,
    })}`
  );
  // The button stays, now asking to confirm, and the warning is read out.
  expect(status()).toHaveTextContent("whatsappTemplateFormFieldsRemovesUsed");
  expect(action()).toHaveAccessibleDescription(
    screen.getByTestId("whatsapp-template-form-fields-text").textContent ?? ""
  );
  expect(
    screen.getByRole("button", {
      name: `infoHintLabel:${JSON.stringify({
        topic: "whatsappTemplateFormFieldsUpdateAnyway",
      })}`,
      description: "whatsappTemplateFormFieldsRemovesUsedDetails",
    })
  ).toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", {
      name: "whatsappTemplateFormFieldsUpdateAnyway",
    })
  );
  await act(async () => {});
  expect(load).toHaveBeenLastCalledWith("update", { confirmRemovals: true });
});

it("drops the confirmation once AI steps stop reading the answers it names", async () => {
  const { load, rerenderWith } = renderFields(
    {
      actionWhatsAppTemplateForm: SAVED_FORM,
      uiScenarioFormAnswerTokensRead: [NAME_TOKEN],
    },
    { result: REMOVES_NAME }
  );
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateFormFieldsUpdate" })
  );
  await act(async () => {});
  expect(action()).toHaveTextContent("whatsappTemplateFormFieldsUpdateAnyway");

  // As the details tell them, the user takes the answer out of the AI step.
  rerenderWith({
    actionWhatsAppTemplateForm: SAVED_FORM,
    uiScenarioFormAnswerTokensRead: [],
  });

  expect(notice()).toHaveTextContent("whatsappTemplateFormFieldsChanged");
  expect(notice()).not.toHaveTextContent(
    "whatsappTemplateFormFieldsRemovesUsed"
  );
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateFormFieldsUpdate" })
  );
  await act(async () => {});
  expect(load).toHaveBeenLastCalledWith("update", {});
});

it("keeps the button, busy, while the form is read", () => {
  const { load, rerenderWith } = renderFields();

  rerenderWith({}, { loading: true });

  expect(action()).toHaveAttribute("aria-busy", "true");
  expect(action()).toHaveAttribute("aria-disabled", "true");
  expect(action()).toHaveTextContent("whatsappTemplateFormFieldsLoading");
  fireEvent.click(action());
  expect(load).not.toHaveBeenCalled();
});

it.each([
  ["Enter", "{Enter}"],
  ["Space", " "],
])("presses the button with %s", async (_, key) => {
  const { load, onStepKeyDown } = renderFields();
  const user = userEvent.setup();

  action().focus();
  await user.keyboard(key);
  await act(async () => {});

  expect(load).toHaveBeenCalledWith("load", {});
  expect(onStepKeyDown).not.toHaveBeenCalled();
});

it("never selects or drags the step on a press", async () => {
  const { load, onStepClick, onStepPointerDown } = renderFields();

  expect(action()).toHaveClass("nodrag", "nopan", "nokey");
  fireEvent.pointerDown(action());
  fireEvent.click(action());
  await act(async () => {});

  expect(load).toHaveBeenCalledTimes(1);
  expect(onStepPointerDown).not.toHaveBeenCalled();
  expect(onStepClick).not.toHaveBeenCalled();
});

it("wraps the Kazakh text and button inside the step", async () => {
  mockMessages = jest.requireActual<{ Scenarios: Record<string, string> }>(
    "../../../../../messages/scenarios/kz/page.json"
  ).Scenarios;
  const labels = [
    "Спортшының толық аты-жөні және тегі",
    "Қала немесе облыс атауы толығымен",
  ];
  renderFields(
    { actionWhatsAppTemplateForm: SAVED_FORM },
    {
      result: {
        status: "needs_confirmation",
        newlyUnavailable: labels.map((label, index) => ({
          token: `form.demoshop_ai_case.f_${index}`,
          label,
        })),
      },
    }
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Форма өрістерін жаңарту" })
  );
  await act(async () => {});

  const text = screen.getByTestId("whatsapp-template-form-fields-text");
  expect(text).toHaveTextContent(
    "Жаңарту AI қадамдары қолданатын «Спортшының толық аты-жөні және тегі», «Қала немесе облыс атауы толығымен» жауаптарын жояды."
  );
  expect(notice().textContent).not.toMatch(/[{}]/);
  // The text takes the full width and breaks long words; the button goes
  // under it and wraps its label.
  expect(text).toHaveClass("block");
  expect(text.parentElement).toHaveClass("min-w-0", "break-words");
  expect(action()).toHaveTextContent("Бәрібір жаңарту");
  expect(action()).toHaveClass(
    "max-w-full",
    "whitespace-normal",
    "break-words"
  );
});

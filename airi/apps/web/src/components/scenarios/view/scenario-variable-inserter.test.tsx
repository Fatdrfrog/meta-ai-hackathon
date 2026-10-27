/** @jest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ScenarioFormAnswerChoice } from "./node-enrichment/scenario-node-graph-index";
import {
  buildScenarioFormAnswerVariableFields,
  buildScenarioPromptInputVariableFields,
} from "./scenario-variable-groups";
import { ScenarioVariableInserter } from "./scenario-variable-inserter";
import { installResizeObserver } from "@/test-support/dom-test-utils";

// ui/command pulls in next-intl through its dialog.

const t = (key: string) => key;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalResizeObserver = globalThis.ResizeObserver;

beforeAll(() => {
  // cmdk measures and scrolls its list; jsdom has neither API.
  HTMLElement.prototype.scrollIntoView = jest.fn();
  installResizeObserver();
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  globalThis.ResizeObserver = originalResizeObserver;
});

function renderInserter(
  props: Partial<Parameters<typeof ScenarioVariableInserter>[0]> = {}
) {
  const onInsertToken = jest.fn();
  render(
    <ScenarioVariableInserter t={t} onInsertToken={onInsertToken} {...props} />
  );
  fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
  return { onInsertToken };
}

const item = (token: string) =>
  screen.getByTestId(`service-message-variable-${token}`);

describe("ScenarioVariableInserter", () => {
  it("names its trigger by its visible text only", () => {
    render(<ScenarioVariableInserter t={t} onInsertToken={jest.fn()} />);
    const trigger = screen.getByRole("button", { name: "variables" });
    expect(trigger.hasAttribute("title")).toBe(false);
    expect(trigger.hasAttribute("aria-label")).toBe(false);
  });

  it("searches from a labelled field and lists chips with one description", () => {
    renderInserter();
    expect(screen.getByRole("dialog", { name: "variables" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "variablesSearchPlaceholder" })
    ).toBeTruthy();
    expect(screen.queryByText("variablesCount")).toBeNull();
    expect(screen.queryByText("variablesHint")).toBeNull();
    expect(item("customer_name").textContent).toBe(
      "variableFieldFullNamevariableFieldFullNameDesc"
    );
  });

  it("drops the coming soon group and explains only the groups that need it", () => {
    renderInserter();
    expect(screen.queryByText("variableGroupComingSoon")).toBeNull();
    expect(screen.queryByText("variableSoonPromo")).toBeNull();
    for (const shown of [
      "variableGroupAdsDesc",
      "variableGroupCalendarDesc",
      "variableGroupPickedDesc",
    ]) {
      expect(screen.getByText(shown)).toBeTruthy();
    }
    for (const hidden of [
      "variableGroupContactDesc",
      "variableGroupConversationDesc",
      "variableGroupMessageDesc",
      "variableGroupCountdownDesc",
    ]) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
  });

  it("inserts the chosen token and closes", () => {
    const { onInsertToken } = renderInserter();
    fireEvent.click(item("customer_name"));
    expect(onInsertToken).toHaveBeenCalledWith("customer_name");
    expect(
      screen.queryByTestId("service-message-variable-customer_name")
    ).toBeNull();
  });

  it("filters by name and says when nothing matches", () => {
    renderInserter();
    const search = screen.getByRole("combobox", {
      name: "variablesSearchPlaceholder",
    });
    fireEvent.change(search, { target: { value: "variableFieldPhone" } });
    expect(item("whatsappclient.wa_id")).toBeTruthy();
    expect(
      screen.queryByTestId("service-message-variable-first_name")
    ).toBeNull();
    fireEvent.change(search, { target: { value: "zzzzqqq" } });
    expect(screen.getByText("variablesSearchEmpty")).toBeTruthy();
  });

  it("leaves out excluded groups", () => {
    renderInserter({ excludeSources: ["picked", "countdown"] });
    expect(item("first_name")).toBeTruthy();
    for (const token of ["picked.label", "picked.text", "countdown"]) {
      expect(
        screen.queryByTestId(`service-message-variable-${token}`)
      ).toBeNull();
    }
  });

  it("lists collected answers first, without a description when they have no question", () => {
    renderInserter({
      extraFields: buildScenarioPromptInputVariableFields([
        { key: "name", label: "Name", prompt: "What is your name?" },
        { key: "sport", label: "Sport", prompt: "" },
      ]),
    });
    const groups = screen.getAllByRole("group");
    expect(within(groups[0]).getAllByRole("option")[0]).toBe(
      item("input.name")
    );
    expect(item("input.name").textContent).toBe("NameWhat is your name?");
    expect(item("input.sport").textContent).toBe("Sport");
  });
});

const tWithNames = (
  key: string,
  values?: Record<string, string | number | Date>
) => (values ? `${key}: ${String(values.name)}` : key);

function formSource(
  overrides: Partial<ScenarioFormAnswerChoice> &
    Pick<ScenarioFormAnswerChoice, "nodeId" | "formKey" | "label">
): ScenarioFormAnswerChoice {
  return {
    formLabel: overrides.label,
    availability: "always",
    schema: "known",
    fields: [],
    ...overrides,
  };
}

function formField(
  key: string,
  label: string,
  mayBeEmpty = false
): ScenarioFormAnswerChoice["fields"][number] {
  return {
    key,
    responseKey: key,
    label,
    description: "",
    fieldType: "TextInput",
    required: !mayBeEmpty,
    screenIndex: 0,
    options: [],
    mayBeEmpty,
  };
}

const contactForm = formSource({
  nodeId: "contact-step",
  formKey: "contact",
  label: "Contact details",
  fields: [formField("name", "Name"), formField("email", "Email", true)],
});
const orderForm = formSource({
  nodeId: "order-step",
  formKey: "order",
  label: "Order details",
  availability: "some_paths",
  fields: [formField("size", "Size", true)],
});
const medalForm = formSource({
  nodeId: "medal-step",
  formKey: "medal_pick",
  label: "Medal pick",
  schema: "unknown",
});

describe("ScenarioVariableInserter form answers", () => {
  it("groups every earlier form under its own heading after collected details", () => {
    renderInserter({
      t: tWithNames,
      extraFields: [
        ...buildScenarioPromptInputVariableFields([
          { key: "city", label: "City", prompt: "Your city?" },
        ]),
        ...buildScenarioFormAnswerVariableFields(
          [contactForm, orderForm],
          tWithNames
        ),
      ],
    });
    // cmdk names each group by its heading.
    expect(
      screen
        .getAllByRole("group")
        .slice(0, 3)
        .map(
          group =>
            document.getElementById(group.getAttribute("aria-labelledby") ?? "")
              ?.textContent
        )
    ).toEqual([
      "variableGroupPromptInputs",
      "variableGroupForm: Contact details",
      "variableGroupForm: Order details",
    ]);
    const contact = screen.getByRole("group", {
      name: "variableGroupForm: Contact details",
    });
    expect(
      within(contact)
        .getAllByRole("option")
        .map(option => option.getAttribute("data-testid"))
    ).toEqual([
      "service-message-variable-form.contact.name",
      "service-message-variable-form.contact.email",
    ]);
    const order = screen.getByRole("group", {
      name: "variableGroupForm: Order details",
    });
    expect(within(order).getAllByRole("option")).toEqual([
      item("form.order.size"),
    ]);
    // The catalog still follows the answers.
    expect(item("first_name")).toBeTruthy();
  });

  it("badges only the answers that may be empty", () => {
    renderInserter({
      extraFields: buildScenarioFormAnswerVariableFields([contactForm], t),
    });
    expect(
      within(item("form.contact.email")).getByText("variableFieldMayBeEmpty")
    ).toBeTruthy();
    expect(
      within(item("form.contact.name")).queryByText("variableFieldMayBeEmpty")
    ).toBeNull();
  });

  it("inserts a form answer's token", () => {
    const { onInsertToken } = renderInserter({
      extraFields: buildScenarioFormAnswerVariableFields([orderForm], t),
    });
    fireEvent.click(item("form.order.size"));
    expect(onInsertToken).toHaveBeenCalledWith("form.order.size");
  });

  it("shows a note for a form whose fields can't be listed, which inserts nothing", () => {
    const { onInsertToken } = renderInserter({
      t: tWithNames,
      extraFields: buildScenarioFormAnswerVariableFields(
        [medalForm],
        tWithNames
      ),
    });
    const row = item("form.medal_pick");
    // Not dimmed or skipped: arrow keys reach it, so screen readers read it.
    expect(row.getAttribute("aria-disabled")).toBe("false");
    expect(row.getAttribute("data-note")).toBe("true");
    expect(row.textContent).toBe("variableFormFieldsUnknown");
    expect(screen.getByText("variableGroupForm: Medal pick")).toBeTruthy();
    fireEvent.click(row);
    expect(onInsertToken).not.toHaveBeenCalled();
    expect(item("form.medal_pick")).toBeTruthy();
  });

  it("reads the note with the keyboard, where Enter inserts nothing", () => {
    const { onInsertToken } = renderInserter({
      answersOnly: true,
      extraFields: buildScenarioFormAnswerVariableFields(
        [medalForm, orderForm],
        t
      ),
    });
    const search = screen.getByRole("combobox", {
      name: "variablesSearchPlaceholder",
    });
    expect(item("form.medal_pick").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onInsertToken).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onInsertToken).toHaveBeenCalledWith("form.order.size");
  });

  it("ends a form that leaves answers out with a note the keyboard reaches and Enter skips", () => {
    const { onInsertToken } = renderInserter({
      answersOnly: true,
      extraFields: buildScenarioFormAnswerVariableFields(
        [{ ...orderForm, partial: true }],
        t
      ),
    });
    expect(
      screen
        .getAllByRole("option")
        .map(option => option.getAttribute("data-testid"))
    ).toEqual([
      "service-message-variable-form.order.size",
      "service-message-variable-form.order",
    ]);
    const note = item("form.order");
    expect(note.getAttribute("data-note")).toBe("true");
    expect(note.textContent).toBe("variableFormFieldsPartial");
    const search = screen.getByRole("combobox", {
      name: "variablesSearchPlaceholder",
    });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(note.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(note);
    expect(onInsertToken).not.toHaveBeenCalled();
  });

  it("inserts nothing when a search finds a Meta form by name", () => {
    const deliveryForm = formSource({
      nodeId: "delivery-step",
      formKey: "order_details",
      label: "Order details",
      fields: [
        formField(
          "delivery_address",
          "Please tell us your full delivery address including apartment and entrance"
        ),
      ],
    });
    const { onInsertToken } = renderInserter({
      t: tWithNames,
      answersOnly: true,
      extraFields: buildScenarioFormAnswerVariableFields(
        [medalForm, deliveryForm],
        tWithNames
      ),
    });
    const search = screen.getByRole("combobox", {
      name: "variablesSearchPlaceholder",
    });
    fireEvent.change(search, { target: { value: "medal" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onInsertToken).not.toHaveBeenCalled();
  });

  it("highlights one row when two forms share a key", () => {
    const again = formSource({ ...orderForm, nodeId: "order-step-2" });
    renderInserter({
      answersOnly: true,
      extraFields: buildScenarioFormAnswerVariableFields([orderForm, again], t),
    });
    const search = screen.getByRole("combobox", {
      name: "variablesSearchPlaceholder",
    });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(
      screen
        .getAllByRole("option")
        .filter(option => option.getAttribute("aria-selected") === "true")
    ).toHaveLength(1);
  });

  it("keeps focus where an insert moved it; Escape returns it to Variables", async () => {
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    const { onInsertToken } = renderInserter({
      extraFields: buildScenarioFormAnswerVariableFields([orderForm], t),
    });
    // The field takes focus back once the menu has closed, as a text field's
    // next frame does, before Radix would hand it to the trigger.
    onInsertToken.mockImplementation(() => queueMicrotask(() => field.focus()));
    fireEvent.click(item("form.order.size"));
    await waitFor(() =>
      expect(screen.queryByTestId("service-message-variables-menu")).toBeNull()
    );
    // Radix hands focus back on the next tick, unless the insert moved it.
    await act(() => new Promise(resolve => setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(field);

    const trigger = screen.getByTestId("whatsapp-service-message-variables");
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByTestId("service-message-variables-search"), {
      key: "Escape",
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    field.remove();
  });

  it("hides a form's text fields read as input answers", () => {
    renderInserter({
      extraFields: buildScenarioPromptInputVariableFields([
        { key: "city", label: "City", prompt: "Your city?" },
        { key: "sport", label: "Sport", prompt: "Sport", fromForm: true },
      ]),
    });
    expect(item("input.city")).toBeTruthy();
    expect(
      screen.queryByTestId("service-message-variable-input.sport")
    ).toBeNull();
  });

  it("offers only answers in answers-only mode", () => {
    renderInserter({
      answersOnly: true,
      extraFields: buildScenarioFormAnswerVariableFields([contactForm], t),
    });
    expect(item("form.contact.name")).toBeTruthy();
    for (const token of ["first_name", "customer_name", "picked.label"]) {
      expect(
        screen.queryByTestId(`service-message-variable-${token}`)
      ).toBeNull();
    }
  });

  it("says when no answers come before this step", () => {
    renderInserter({ answersOnly: true });
    expect(screen.getByText("variablesAnswersEmpty")).toBeTruthy();
    expect(screen.queryByText("variablesSearchEmpty")).toBeNull();
  });
});

describe("buildScenarioPromptInputVariableFields", () => {
  it("never describes an answer by its raw key", () => {
    expect(
      buildScenarioPromptInputVariableFields([
        { key: "sport", label: "Sport", prompt: "  " },
      ])
    ).toEqual([{ token: "input.sport", label: "Sport", description: "" }]);
  });
});

/**
 * @jest-environment jsdom
 */

jest.mock("./inline-editor", () => ({
  WhatsAppInlineEditor: ({
    value,
    onChange,
    placeholder,
    className,
    error,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    error?: string;
  }) => (
    <input
      aria-label={placeholder || "editor"}
      className={className}
      aria-invalid={Boolean(error)}
      data-validation-error={error}
      value={value}
      onChange={event => onChange(event.target.value)}
    />
  ),
}));

import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  buildFlowBranchOptionKey,
  buildFlowBranchSourceHandleId,
} from "@icecore/scenario-contracts";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import { FieldEditor, FlowFormEditorContent } from "./field-editor";
import {
  convertWhatsAppFlowToStaticGraph,
  generateFlowJson,
} from "./flow-json-generator";
import { validateWhatsAppFlowConfig } from "./flow-validation";
import { META_STARTER_FLOW_JSON } from "./flow-json-fixtures";
import {
  FlowFieldAnswerTokensContext,
  listFlowFieldAnswerTokens,
} from "./flow-field-answer-tokens";

// The message editor loads lazily in the app; load it up front so every
// test (run alone or in any order) renders it at once.
beforeAll(async () => {
  await scenarioEditorChunks.whatsAppInlineEditor.load();
});

it("uses ordinary editable field keys for standalone Flow authoring", () => {
  const onChange = jest.fn();
  render(
    <FlowFieldAnswerTokensContext.Provider
      value={new Map([["choice", "{{form.order.choice}}"]])}
    >
      <FlowFormEditorContent
        authoringContext="manager"
        fieldKeyLabel="Field key"
        flowConfig={{
          templateId: "custom",
          ctaText: "Open",
          screens: [
            {
              id: "START",
              title: "Contact",
              fields: [
                {
                  id: "choice",
                  label: "Pick one",
                  fieldType: "Dropdown",
                  required: true,
                  options: [{ id: "a", title: "A" }],
                },
              ],
            },
          ],
        }}
        onChange={onChange}
      />
    </FlowFieldAnswerTokensContext.Provider>
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Field key Pick one" }),
    { target: { value: "new_choice" } }
  );
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      screens: [
        expect.objectContaining({
          fields: [expect.objectContaining({ id: "new_choice" })],
        }),
      ],
    })
  );
  expect(screen.queryByText("flowPromptInputHint")).toBeNull();
  expect(screen.queryByTestId("flow-field-answer-token")).toBeNull();
  expect(
    screen.queryByRole("combobox", { name: "flowNavigationLabel" })
  ).toBeNull();
});

it("uses ordinary editable field keys for standalone Flow authoring", () => {
  const onChange = jest.fn();
  render(
    <FlowFormEditorContent
      authoringContext="manager"
      fieldKeyLabel="Field key"
      flowConfig={{
        templateId: "custom",
        ctaText: "Open",
        screens: [
          {
            id: "START",
            title: "Contact",
            fields: [
              {
                id: "choice",
                label: "Pick one",
                fieldType: "Dropdown",
                required: true,
                options: [{ id: "a", title: "A" }],
              },
            ],
          },
        ],
      }}
      onChange={onChange}
    />
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Field key Pick one" }),
    { target: { value: "new_choice" } }
  );
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      screens: [
        expect.objectContaining({
          fields: [expect.objectContaining({ id: "new_choice" })],
        }),
      ],
    })
  );
  expect(screen.queryByText("flowPromptInputHint")).toBeNull();
  expect(
    screen.queryByRole("combobox", { name: "flowNavigationLabel" })
  ).toBeNull();
});

const sampleFlowConfig = {
  templateId: "template-1",
  ctaText: "Open",
  screens: [
    {
      id: "screen-1",
      title: "Screen",
      fields: [
        {
          id: "radio-field",
          label: "Pick one",
          fieldType: "RadioButtonsGroup" as const,
          options: [
            { id: "one", title: "One" },
            { id: "two", title: "Two" },
          ],
        },
        {
          id: "checkbox-field",
          label: "Pick many",
          fieldType: "CheckboxGroup" as const,
          options: [{ id: "check-one", title: "Check one" }],
        },
      ],
    },
  ],
};

const multiScreenFlowConfig = {
  ...sampleFlowConfig,
  screens: [
    sampleFlowConfig.screens[0],
    {
      id: "screen-2",
      title: "Follow up",
      fields: [
        {
          id: "follow-up-field",
          label: "Pick another",
          fieldType: "RadioButtonsGroup" as const,
          options: [{ id: "three", title: "Three" }],
        },
      ],
    },
  ],
};

const endpointFlowConfig = {
  ...multiScreenFlowConfig,
  flowNavigationMode: "data_endpoint" as const,
  screens: [
    multiScreenFlowConfig.screens[0],
    multiScreenFlowConfig.screens[1],
    {
      id: "screen-3",
      title: "Finish",
      fields: [
        { id: "finish", label: "Finish", fieldType: "TextInput" as const },
      ],
    },
  ],
  screenRoutes: { "screen-1": ["screen-2"], "screen-2": ["screen-3"] },
};

const routeLimitFlowConfig = {
  templateId: "template-1",
  ctaText: "Open",
  flowNavigationMode: "data_endpoint" as const,
  screens: Array.from({ length: 11 }, (_, index) => {
    const suffix = String.fromCharCode(65 + index);
    return {
      id: `SCREEN_${suffix}`,
      title: `Screen ${suffix}`,
      fields: [],
    };
  }),
};

const graphFlowConfig = {
  templateId: "custom",
  ctaText: "Open",
  flowNavigationMode: "static_graph",
  flowJsonVersion: "6.3",
  screens: [
    {
      id: "QUESTION_ONE",
      title: "Sport",
      fields: [
        {
          id: "sport_list",
          label: "",
          fieldType: "NavigationList",
          navigationItems: [
            {
              id: "sport_0",
              title: "Football",
              action: {
                name: "navigate",
                nextScreenId: "DETAILS",
                payload: { sport: "0_Football" },
              },
            },
            {
              id: "sport_other",
              title: "Other sport",
              description: "Write your own",
              action: { name: "navigate", nextScreenId: "OTHER_DETAILS" },
            },
          ],
        },
      ],
    },
    {
      id: "DETAILS",
      title: "Design and name",
      terminal: true,
      data: { sport: { type: "string", __example__: "0_Football" } },
      fields: [
        {
          id: "____133f36",
          label: "Design",
          fieldType: "RadioButtonsGroup",
          required: true,
          options: [
            {
              id: "0_Name_(Personalised)",
              title: "Personalised",
              description: "Athlete's name",
            },
          ],
        },
        {
          id: "_68d224",
          label: "Athlete name",
          fieldType: "TextInput",
          helperText: "Write all names",
          required: true,
        },
      ],
      footer: {
        label: "Send",
        action: {
          name: "complete",
          payload: {
            __9ba1c9: "${data.sport}",
            ____133f36: "${form.____133f36}",
            _68d224: "${form._68d224}",
          },
        },
      },
    },
    {
      id: "OTHER_DETAILS",
      title: "Design and name",
      terminal: true,
      fields: [
        {
          id: "_68d224",
          label: "Athlete name",
          fieldType: "TextInput",
          required: true,
        },
      ],
      footer: {
        label: "Send",
        action: {
          name: "complete",
          payload: { __9ba1c9: "4_Other", _68d224: "${form._68d224}" },
        },
      },
    },
  ],
} as unknown as Parameters<typeof FlowFormEditorContent>[0]["flowConfig"];

function renderEditableFlow(
  initial: Parameters<typeof FlowFormEditorContent>[0]["flowConfig"],
  props: Partial<Parameters<typeof FlowFormEditorContent>[0]> = {}
) {
  let current = initial;
  const onChange = (next: typeof initial) => {
    current = next;
    view.rerender(content());
  };
  const content = () => (
    <FlowFormEditorContent
      flowConfig={current}
      onChange={onChange}
      {...props}
    />
  );
  const view = render(content());
  return () => current;
}

const starterTextFlowConfig = {
  templateId: "custom",
  ctaText: "Open",
  flowNavigationMode: "static_graph",
  flowJsonVersion: "7.3",
  screens: [
    {
      id: "WELCOME_SCREEN",
      title: "Welcome",
      terminal: true,
      success: true,
      data: {},
      fields: [],
      layoutContent: [
        {
          kind: "text",
          id: "heading",
          type: "TextHeading",
          text: "Hello World",
        },
        {
          kind: "text",
          id: "body",
          type: "TextBody",
          text: "Let's start building things!",
        },
      ],
      footer: { label: "Complete", action: { name: "complete", payload: {} } },
    },
  ],
} as unknown as Parameters<typeof FlowFormEditorContent>[0]["flowConfig"];

describe("ordered static Flow text authoring", () => {
  it("edits Meta starter text without changing its success, data, direct layout or completion action", () => {
    const current = renderEditableFlow(starterTextFlowConfig, {
      authoringContext: "manager",
    });
    fireEvent.click(screen.getByRole("button", { name: "Hello World" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "flowAuthoring.text" }),
      { target: { value: "Welcome to airi.chat" } }
    );
    expect(screen.queryByTestId("flow-prompt-input-key")).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "flowFieldRequired" })
    ).toBeNull();
    const saved = generateFlowJson(current());
    expect(saved).toEqual({
      ...META_STARTER_FLOW_JSON,
      screens: [
        {
          ...META_STARTER_FLOW_JSON.screens[0],
          layout: {
            type: "SingleColumnLayout",
            children: [
              { type: "TextHeading", text: "Welcome to airi.chat" },
              { type: "TextBody", text: "Let's start building things!" },
              {
                type: "Footer",
                label: "Complete",
                "on-click-action": { name: "complete", payload: {} },
              },
            ],
          },
        },
      ],
    });
  });

  it.each([undefined, false, true])(
    "keeps the optional success flag distinct until explicitly changed (%s)",
    success => {
      const current = renderEditableFlow({
        ...starterTextFlowConfig,
        screens: [{ ...starterTextFlowConfig.screens[0], success }],
      });
      fireEvent.click(
        screen.getByRole("button", { name: "flowAuthoring.screen" })
      );
      const outcome = screen.getByRole("combobox", {
        name: "flowAuthoring.success",
      }) as HTMLSelectElement;
      expect(outcome.value).toBe(
        success === undefined ? "default" : String(success)
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "flowAuthoring.screenTitle" }),
        { target: { value: "Edited title" } }
      );
      expect(current().screens[0].success).toBe(success);
      fireEvent.change(outcome, { target: { value: "false" } });
      expect(current().screens[0].success).toBe(false);
      fireEvent.change(outcome, { target: { value: "default" } });
      expect(current().screens[0].success).toBeUndefined();
    }
  );

  it("edits, reorders and deletes text around existing fields while maintaining field references", () => {
    const current = renderEditableFlow(
      {
        ...starterTextFlowConfig,
        screens: [
          {
            ...starterTextFlowConfig.screens[0],
            fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
            layoutContent: [
              {
                kind: "text",
                id: "heading",
                type: "TextHeading",
                text: "Introduction",
              },
              { kind: "field", fieldId: "name" },
              {
                kind: "text",
                id: "body",
                type: "TextBody",
                text: "Instructions",
              },
            ],
          },
        ],
      },
      { authoringContext: "manager" }
    );
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    fireEvent.change(screen.getByTestId("flow-prompt-input-key"), {
      target: { value: "customer_name" },
    });
    expect(current().screens[0].layoutContent?.[1]).toEqual({
      kind: "field",
      fieldId: "customer_name",
    });
    fireEvent.click(screen.getByRole("button", { name: "Instructions" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "flowAuthoring.textType" }),
      { target: { value: "TextCaption" } }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.moveUp" })
    );
    expect(current().screens[0].layoutContent).toEqual([
      {
        kind: "text",
        id: "heading",
        type: "TextHeading",
        text: "Introduction",
      },
      { kind: "text", id: "body", type: "TextCaption", text: "Instructions" },
      { kind: "field", fieldId: "customer_name" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(current().screens[0].fields[0].id).toBe("customer_name");
    expect(current().screens[0].layoutContent).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "flowAddField" }), {
      target: { value: "TextSubheading" },
    });
    fireEvent.click(screen.getByRole("button", { name: "flowAddField" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "flowAuthoring.text" }),
      { target: { value: "Next steps" } }
    );
    expect(
      generateFlowJson(current()).screens[0].layout.children.slice(0, 3)
    ).toEqual([
      { type: "TextHeading", text: "Introduction" },
      expect.objectContaining({ type: "TextInput", name: "customer_name" }),
      { type: "TextSubheading", text: "Next steps" },
    ]);
  });

  it("appends and removes field references without dropping ordered text blocks", () => {
    const current = renderEditableFlow(starterTextFlowConfig, {
      authoringContext: "manager",
    });
    fireEvent.click(screen.getByRole("button", { name: "flowAddField" }));
    const fieldId = current().screens[0].fields[0].id;
    expect(current().screens[0].layoutContent?.at(-1)).toEqual({
      kind: "field",
      fieldId,
    });
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(current().screens[0].fields).toEqual([]);
    expect(current().screens[0].layoutContent).toEqual(
      starterTextFlowConfig.screens[0].layoutContent
    );
  });
});

describe("shared Flow graph authoring", () => {
  it("discloses legacy endpoint routing settings under Advanced without changing their controls", () => {
    renderEditableFlow(endpointFlowConfig, {
      renderPreview: id => <p>Preview {id}</p>,
    });
    const navigationMode = screen.getByLabelText("flowNavigationLabel");
    expect(navigationMode.closest("details")?.open).toBe(false);
  });
  it("moves keyboard focus out of a hidden outline after selection while preserving pane-button focus", () => {
    const narrowStyles = document.createElement("style");
    narrowStyles.textContent = ".hidden { display: none; }";
    document.head.appendChild(narrowStyles);
    try {
      renderEditableFlow(graphFlowConfig, {
        renderPreview: id => <p>Preview {id}</p>,
      });
      const outlineButton = screen.getByRole("button", {
        name: "flowAuthoring.outline",
      });
      fireEvent.click(outlineButton);
      const selectedScreen = screen.getByRole("button", {
        name: "DETAILS Design and name",
      });
      selectedScreen.focus();
      fireEvent.click(selectedScreen);
      expect(document.activeElement).toBe(
        screen.getByTestId("flow-authoring-editor")
      );
      fireEvent.click(outlineButton);
      const editButton = screen.getByRole("button", {
        name: "flowAuthoring.edit",
      });
      editButton.focus();
      fireEvent.click(editButton);
      expect(document.activeElement).toBe(editButton);
    } finally {
      narrowStyles.remove();
    }
  });

  it("keeps desktop outline focus in place while updating the middle editor", () => {
    renderEditableFlow(graphFlowConfig, {
      renderPreview: id => <p>Preview {id}</p>,
    });
    const selectedScreen = screen.getByRole("button", {
      name: "DETAILS Design and name",
    });
    selectedScreen.focus();
    fireEvent.click(selectedScreen);
    expect(document.activeElement).toBe(selectedScreen);
  });

  it("opens narrow workspaces on editing and returns to editing after choosing a screen", () => {
    const narrowStyles = document.createElement("style");
    narrowStyles.textContent = ".hidden { display: none; }";
    document.head.appendChild(narrowStyles);
    try {
      renderEditableFlow(graphFlowConfig, {
        renderPreview: id => <p>Preview {id}</p>,
      });
      expect(
        screen.getByRole("combobox", { name: "flowAuthoring.fieldType" })
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "flowAuthoring.outline" })
      );
      fireEvent.click(
        screen.getByRole("button", { name: "DETAILS Design and name" })
      );
      expect(
        screen
          .getByRole("button", { name: "flowAuthoring.edit" })
          .getAttribute("aria-pressed")
      ).toBe("true");
      expect(
        screen.getByRole("textbox", { name: "flowFieldLabelPlaceholder" })
      ).toBeTruthy();
    } finally {
      narrowStyles.remove();
    }
  });

  it("collapses technical settings while keeping ordinary content, CTA and destinations available", () => {
    renderEditableFlow(graphFlowConfig, { authoringContext: "manager" });
    const fieldKey = screen.getByTestId("flow-prompt-input-key");
    expect(fieldKey.closest("details")?.open).toBe(false);
    const item = within(
      screen.getByRole("group", { name: "flowAuthoring.navigationItems 1" })
    );
    expect(
      item.getByLabelText("flowAuthoring.itemId").closest("details")?.open
    ).toBe(false);
    expect(
      item
        .getByRole("combobox", { name: "flowAuthoring.destination" })
        .closest("details")
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "DETAILS Design and name" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.screen" })
    );
    expect(
      screen.getByLabelText("flowAuthoring.screenId").closest("details")?.open
    ).toBe(false);
    expect(
      screen
        .getByRole("textbox", { name: "flowAuthoring.screenTitle" })
        .closest("details")
    ).toBeNull();
    expect(
      screen
        .getByRole("textbox", { name: "flowAuthoring.footerLabel" })
        .closest("details")
    ).toBeNull();
  });
  it("builds a direct-field graph with two terminal paths and structured payload bindings from an empty draft", () => {
    const current = renderEditableFlow({
      templateId: "custom",
      ctaText: "Open",
      flowNavigationMode: "static_graph",
      flowJsonVersion: "6.3",
      screens: [],
    });
    const createScreen = (id: string, title: string) => {
      fireEvent.click(screen.getByRole("button", { name: "flowAddScreen" }));
      const idInput = screen.getByRole("textbox", {
        name: "flowAuthoring.screenId",
      });
      fireEvent.change(idInput, { target: { value: id } });
      fireEvent.blur(idInput);
      fireEvent.change(
        screen.getByRole("textbox", { name: "flowAuthoring.screenTitle" }),
        { target: { value: title } }
      );
    };
    createScreen("QUESTION_ONE", "Sport");
    createScreen("DETAILS", "Design and name");
    createScreen("OTHER_DETAILS", "Design and name");
    const makeTerminal = () => {
      fireEvent.click(
        screen.getByRole("checkbox", { name: "flowAuthoring.terminal" })
      );
      fireEvent.change(
        screen.getByRole("combobox", { name: "flowAuthoring.footer" }),
        { target: { value: "on" } }
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "flowAuthoring.footerLabel" }),
        { target: { value: "Send" } }
      );
    };
    const addName = () => {
      fireEvent.click(screen.getByRole("button", { name: "flowAddField" }));
      fireEvent.change(screen.getByTestId("flow-prompt-input-key"), {
        target: { value: "_68d224" },
      });
      fireEvent.change(
        screen.getByRole("textbox", { name: "flowFieldLabelPlaceholder" }),
        { target: { value: "Athlete name" } }
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "flowAuthoring.helperText" }),
        { target: { value: "Write all names" } }
      );
    };
    makeTerminal();
    addName();
    fireEvent.click(
      screen.getByRole("button", { name: "DETAILS Design and name" })
    );
    makeTerminal();
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.addData" })
    );
    const dataKey = screen.getByRole("textbox", {
      name: "flowAuthoring.dataKey",
    });
    fireEvent.change(dataKey, { target: { value: "sport" } });
    fireEvent.blur(dataKey);
    fireEvent.change(
      screen.getByRole("textbox", { name: "flowAuthoring.example" }),
      { target: { value: "0_Football" } }
    );
    addName();
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.screen" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.addPayload" })
    );
    const mappingKey = screen.getByRole("textbox", {
      name: "flowAuthoring.payloadKey",
    });
    fireEvent.change(mappingKey, { target: { value: "__9ba1c9" } });
    fireEvent.blur(mappingKey);
    fireEvent.change(
      screen.getByRole("combobox", { name: "flowAuthoring.valueSource" }),
      { target: { value: "data" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "QUESTION_ONE Sport" }));
    fireEvent.change(screen.getByRole("combobox", { name: "flowAddField" }), {
      target: { value: "NavigationList" },
    });
    fireEvent.click(screen.getByRole("button", { name: "flowAddField" }));
    fireEvent.change(screen.getByTestId("flow-prompt-input-key"), {
      target: { value: "sport_list" },
    });
    const item = within(
      screen.getByRole("group", { name: "flowAuthoring.navigationItems 1" })
    );
    fireEvent.change(
      item.getByRole("textbox", { name: "flowAuthoring.itemId" }),
      { target: { value: "sport_0" } }
    );
    fireEvent.change(
      item.getByRole("textbox", { name: "flowAuthoring.optionTitle" }),
      { target: { value: "Football" } }
    );
    fireEvent.click(
      item.getByRole("button", { name: "flowAuthoring.addPayload" })
    );
    const sportKey = item.getByRole("textbox", {
      name: "flowAuthoring.payloadKey",
    });
    fireEvent.change(sportKey, { target: { value: "sport" } });
    fireEvent.blur(sportKey);
    fireEvent.change(
      item.getByRole("textbox", { name: "flowAuthoring.value" }),
      { target: { value: "0_Football" } }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.addItem" })
    );
    const other = within(
      screen.getByRole("group", { name: "flowAuthoring.navigationItems 2" })
    );
    fireEvent.change(
      other.getByRole("textbox", { name: "flowAuthoring.itemId" }),
      { target: { value: "sport_other" } }
    );
    fireEvent.change(
      other.getByRole("textbox", { name: "flowAuthoring.optionTitle" }),
      { target: { value: "Other sport" } }
    );
    fireEvent.change(
      other.getByRole("combobox", { name: "flowAuthoring.destination" }),
      { target: { value: "OTHER_DETAILS" } }
    );
    expect(current().screens[0].fields[0].navigationItems).toEqual([
      {
        id: "sport_0",
        title: "Football",
        action: {
          name: "navigate",
          nextScreenId: "DETAILS",
          payload: { sport: "0_Football" },
        },
      },
      {
        id: "sport_other",
        title: "Other sport",
        action: { name: "navigate", nextScreenId: "OTHER_DETAILS" },
      },
    ]);
    expect(validateWhatsAppFlowConfig(current()).issues).toEqual([]);
    expect(
      current().screens.map(value => ({
        id: value.id,
        terminal: value.terminal === true,
        layoutForm: value.layoutForm,
      }))
    ).toEqual([
      { id: "QUESTION_ONE", terminal: false, layoutForm: undefined },
      { id: "DETAILS", terminal: true, layoutForm: undefined },
      { id: "OTHER_DETAILS", terminal: true, layoutForm: undefined },
    ]);
    expect(current().screens[1].data).toEqual({
      sport: { type: "string", __example__: "0_Football" },
    });
    expect(current().screens[1].footer).toEqual({
      label: "Send",
      action: { name: "complete", payload: { __9ba1c9: "${data.sport}" } },
    });
    expect(current().screens[1].fields[0].id).toBe("_68d224");
    expect(current().screens[2].fields[0].id).toBe("_68d224");
  });

  it("edits navigation item identity, description, destination and payload without changing other items", () => {
    const current = renderEditableFlow(graphFlowConfig);
    const first = within(
      screen.getByRole("group", { name: "flowAuthoring.navigationItems 1" })
    );
    fireEvent.change(
      first.getByRole("textbox", { name: "flowAuthoring.itemId" }),
      { target: { value: "sport_ball" } }
    );
    fireEvent.change(
      first.getByRole("textbox", { name: "flowAuthoring.optionDescription" }),
      { target: { value: "Team sports" } }
    );
    fireEvent.change(
      first.getByRole("combobox", { name: "flowAuthoring.destination" }),
      { target: { value: "OTHER_DETAILS" } }
    );
    fireEvent.change(
      first.getByRole("textbox", { name: "flowAuthoring.value" }),
      { target: { value: "0_Team_sports" } }
    );
    const field = current().screens[0]
      .fields[0] as (typeof graphFlowConfig.screens)[0]["fields"][0] & {
      navigationItems: unknown[];
    };
    expect(field.navigationItems).toEqual([
      {
        id: "sport_ball",
        title: "Football",
        description: "Team sports",
        action: {
          name: "navigate",
          nextScreenId: "OTHER_DETAILS",
          payload: { sport: "0_Team_sports" },
        },
      },
      {
        id: "sport_other",
        title: "Other sport",
        description: "Write your own",
        action: { name: "navigate", nextScreenId: "OTHER_DETAILS" },
      },
    ]);
    fireEvent.click(
      first.getByRole("button", { name: "flowAuthoring.moveDown" })
    );
    expect(
      (current().screens[0].fields[0] as typeof field).navigationItems[0]
    ).toEqual({
      id: "sport_other",
      title: "Other sport",
      description: "Write your own",
      action: { name: "navigate", nextScreenId: "OTHER_DETAILS" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.addItem" })
    );
    expect(
      (current().screens[0].fields[0] as typeof field).navigationItems
    ).toHaveLength(3);
  });

  it("preserves screen-local underscore response keys and edits option IDs, descriptions and helper text in scenarios", () => {
    const current = renderEditableFlow(graphFlowConfig);
    fireEvent.click(
      screen.getByRole("button", { name: "DETAILS Design and name" })
    );
    expect(
      screen
        .getByRole("textbox", { name: "flowAuthoring.fieldKey Design" })
        .getAttribute("aria-invalid")
    ).not.toBe("true");
    fireEvent.change(
      screen.getByRole("textbox", { name: "flowAuthoring.optionId 1" }),
      { target: { value: "0_Есімі_жазылатын_(Именная)" } }
    );
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "flowAuthoring.optionDescription 1",
      }),
      { target: { value: "Спортшының есімімен" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Athlete name" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "flowAuthoring.helperText" }),
      { target: { value: "Бірнеше есім болса, бәрін жазыңыз" } }
    );
    expect(current().screens[1].fields).toEqual([
      expect.objectContaining({
        id: "____133f36",
        options: [
          {
            id: "0_Есімі_жазылатын_(Именная)",
            title: "Personalised",
            description: "Спортшының есімімен",
          },
        ],
      }),
      expect.objectContaining({
        id: "_68d224",
        helperText: "Бірнеше есім болса, бәрін жазыңыз",
      }),
    ]);
    expect(current().screens[2].fields[0].id).toBe("_68d224");
  });

  it("authors screen data, direct layout and completion mappings independently on each terminal screen", () => {
    const current = renderEditableFlow(graphFlowConfig, {
      authoringContext: "manager",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "OTHER_DETAILS Design and name" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.screen" })
    );
    expect(
      screen
        .getByRole("checkbox", { name: "flowAuthoring.terminal" })
        .getAttribute("aria-checked")
    ).toBe("true");
    expect(
      (
        screen.getByRole("combobox", {
          name: "flowAuthoring.formLayout",
        }) as HTMLSelectElement
      ).value
    ).toBe("direct");
    fireEvent.change(
      screen.getByRole("textbox", { name: "flowAuthoring.footerLabel" }),
      { target: { value: "Жіберу" } }
    );
    const payload = within(
      screen.getByRole("group", { name: "flowAuthoring.payload" })
    );
    const rows = payload.getAllByRole("group");
    fireEvent.change(
      within(rows[0]).getByRole("textbox", { name: "flowAuthoring.value" }),
      { target: { value: "4_Басқа" } }
    );
    expect(current().screens[2].layoutForm).toBeUndefined();
    expect(current().screens[2]).toEqual(
      expect.objectContaining({
        terminal: true,
        footer: {
          label: "Жіберу",
          action: {
            name: "complete",
            payload: { __9ba1c9: "4_Басқа", _68d224: "${form._68d224}" },
          },
        },
      })
    );
    expect(current().screens[1]).toEqual(graphFlowConfig.screens[1]);
  });

  it("switches the real preview by screen ID and keeps all radio branch handles visible while another field is selected", () => {
    const branchHandle = jest.fn(({ handleId }: { handleId: string }) => (
      <span data-testid="graph-branch-handle">{handleId}</span>
    ));
    renderEditableFlow(graphFlowConfig, {
      renderPreview: id => <p>Preview {id}</p>,
      renderFlowBranchHandle: branchHandle,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "DETAILS Design and name" })
    );
    expect(screen.getByText("Preview DETAILS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Athlete name" }));
    expect(screen.getAllByTestId("graph-branch-handle")).toHaveLength(1);
    expect(screen.getByTestId("graph-branch-handle").textContent).toBe(
      buildFlowBranchSourceHandleId("____133f36", "0_Name_(Personalised)")
    );
    fireEvent.click(
      screen.getByRole("button", { name: "OTHER_DETAILS Design and name" })
    );
    expect(screen.getByText("Preview OTHER_DETAILS")).toBeTruthy();
  });

  it("keeps branch handles visible when a narrow workspace switches away from its screen navigator", () => {
    const narrowStyles = document.createElement("style");
    narrowStyles.textContent = ".hidden { display: none; }";
    document.head.appendChild(narrowStyles);
    try {
      renderEditableFlow(graphFlowConfig, {
        renderPreview: id => <p>Preview {id}</p>,
        renderFlowBranchHandle: ({ handleId }) => (
          <span data-testid="narrow-branch">{handleId}</span>
        ),
      });
      fireEvent.click(
        screen.getByRole("button", { name: "flowAuthoring.outline" })
      );
      fireEvent.click(
        screen.getByRole("button", { name: "DETAILS Design and name" })
      );
      fireEvent.click(
        screen.getByRole("button", { name: "flowAuthoring.edit" })
      );
      let element: HTMLElement | null = screen.getByTestId("narrow-branch");
      while (element) {
        expect(window.getComputedStyle(element).display).not.toBe("none");
        element = element.parentElement;
      }
    } finally {
      narrowStyles.remove();
    }
  });

  it("keeps keyboard focus while editing an actual option ID", () => {
    renderEditableFlow(graphFlowConfig, { authoringContext: "manager" });
    fireEvent.click(
      screen.getByRole("button", { name: "DETAILS Design and name" })
    );
    const id = screen.getByRole("textbox", {
      name: "flowAuthoring.optionId 1",
    });
    id.focus();
    fireEvent.change(id, { target: { value: "0_Custom_design" } });
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "flowAuthoring.optionId 1" })
    );
  });

  it("locks scenario radio identities and completion aliases already connected to another canvas step", () => {
    const flow = JSON.parse(
      JSON.stringify(graphFlowConfig)
    ) as typeof graphFlowConfig;
    flow.screens[1].footer!.action.payload = {
      design_answer: "${form.____133f36}",
      athlete: "${form._68d224}",
    };
    renderEditableFlow(flow, {
      connectedBranchIds: [
        buildFlowBranchOptionKey("design_answer", "0_Name_(Personalised)"),
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "DETAILS Design and name" })
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "flowAuthoring.fieldKey Design",
        }) as HTMLInputElement
      ).readOnly
    ).toBe(true);
    expect(
      (
        screen.getByRole("textbox", {
          name: "flowAuthoring.optionId 1",
        }) as HTMLInputElement
      ).readOnly
    ).toBe(true);
    expect(
      (
        screen.getByRole("textbox", {
          name: "flowAuthoring.optionDescription 1",
        }) as HTMLInputElement
      ).readOnly
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.screen" })
    );
    const mapping = within(
      screen.getByRole("group", { name: "design_answer" })
    );
    expect(
      (
        mapping.getByRole("textbox", {
          name: "flowAuthoring.payloadKey",
        }) as HTMLInputElement
      ).readOnly
    ).toBe(true);
    expect(
      (
        mapping.getByRole("combobox", {
          name: "flowAuthoring.valueSource",
        }) as HTMLSelectElement
      ).disabled
    ).toBe(true);
    expect(
      (mapping.getByRole("button", { name: "delete" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    const athlete = within(screen.getByRole("group", { name: "athlete" }));
    expect(
      (
        athlete.getByRole("textbox", {
          name: "flowAuthoring.payloadKey",
        }) as HTMLInputElement
      ).readOnly
    ).toBe(false);
  });

  it("allows manager option identities to change even when connection metadata is provided", () => {
    renderEditableFlow(graphFlowConfig, {
      authoringContext: "manager",
      connectedBranchIds: [
        buildFlowBranchOptionKey("____133f36", "0_Name_(Personalised)"),
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "DETAILS Design and name" })
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "flowAuthoring.fieldKey Design",
        }) as HTMLInputElement
      ).readOnly
    ).toBe(false);
    expect(
      (
        screen.getByRole("textbox", {
          name: "flowAuthoring.optionId 1",
        }) as HTMLInputElement
      ).readOnly
    ).toBe(false);
  });

  it.each([null, {}])(
    "rejects a malformed advanced data schema and preserves the prior screen data (%j)",
    malformed => {
      const current = renderEditableFlow(graphFlowConfig);
      fireEvent.click(
        screen.getByRole("button", { name: "DETAILS Design and name" })
      );
      fireEvent.click(
        screen.getByRole("button", { name: "flowAuthoring.screen" })
      );
      fireEvent.click(screen.getAllByText("flowAuthoring.advanced")[0]);
      const schema = screen.getByRole("textbox", {
        name: "flowAuthoring.dataSchema",
      });
      fireEvent.change(schema, {
        target: { value: JSON.stringify({ sport: malformed }) },
      });
      fireEvent.click(
        within(schema.closest("details")!).getByRole("button", {
          name: "flowAuthoring.applyJson",
        })
      );
      expect(current().screens[1].data).toEqual({
        sport: { type: "string", __example__: "0_Football" },
      });
      expect(screen.getByRole("alert").textContent).toBe(
        "flowAuthoring.invalidDataSchema"
      );
    }
  );

  it("preserves an own __proto__ schema key when applying advanced data JSON", () => {
    const current = renderEditableFlow(graphFlowConfig);
    fireEvent.click(
      screen.getByRole("button", { name: "DETAILS Design and name" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.screen" })
    );
    fireEvent.click(screen.getAllByText("flowAuthoring.advanced")[0]);
    const schema = screen.getByRole("textbox", {
      name: "flowAuthoring.dataSchema",
    });
    fireEvent.change(schema, {
      target: {
        value:
          '{"__proto__":{"type":"string","__example__":"Actual"},"sport":{"type":"string","__example__":"0_Football"}}',
      },
    });
    fireEvent.click(
      within(schema.closest("details")!).getByRole("button", {
        name: "flowAuthoring.applyJson",
      })
    );
    expect(Object.hasOwn(current().screens[1].data!, "__proto__")).toBe(true);
    const saved = generateFlowJson(current()).screens[1].data!;
    expect(Object.hasOwn(saved, "__proto__")).toBe(true);
    expect(saved.__proto__).toEqual({ type: "string", __example__: "Actual" });
  });

  it.each([
    "Dropdown",
    "DatePicker",
    "RadioButtonsGroup",
    "CheckboxGroup",
  ] as const)("does not offer unsupported helper text on %s", fieldType => {
    renderEditableFlow({
      ...graphFlowConfig,
      screens: [
        {
          id: "START",
          title: "Question",
          fields: [
            {
              id: "question",
              label: "Question",
              fieldType,
              options: [{ id: "a", title: "A" }],
            },
          ],
          terminal: true,
          footer: {
            label: "Send",
            action: {
              name: "complete",
              payload: { question: "${form.question}" },
            },
          },
        },
      ],
    });
    expect(
      screen.queryByRole("textbox", { name: "flowAuthoring.helperText" })
    ).toBeNull();
  });

  it.each(["TextInput", "TextArea"] as const)(
    "persists supported helper text on %s in the generated asset",
    fieldType => {
      const current = renderEditableFlow({
        ...graphFlowConfig,
        screens: [
          {
            id: "START",
            title: "Question",
            fields: [{ id: "question", label: "Question", fieldType }],
            terminal: true,
            footer: {
              label: "Send",
              action: {
                name: "complete",
                payload: { question: "${form.question}" },
              },
            },
          },
        ],
      });
      fireEvent.change(
        screen.getByRole("textbox", { name: "flowAuthoring.helperText" }),
        { target: { value: "Actual saved help" } }
      );
      const json = generateFlowJson(current());
      expect(json.screens[0].layout.children[0]).toEqual(
        expect.objectContaining({ "helper-text": "Actual saved help" })
      );
    }
  );

  it("preserves connected transported radio branches across option rename, deletion, type and footer edits", () => {
    const flow = convertWhatsAppFlowToStaticGraph({
      templateId: "custom",
      ctaText: "Open",
      screens: [
        {
          id: "FIRST",
          title: "Choice",
          fields: [
            {
              id: "choice",
              label: "Choice",
              fieldType: "RadioButtonsGroup",
              options: [
                { id: "a", title: "A" },
                { id: "b", title: "B" },
              ],
            },
          ],
        },
        {
          id: "END",
          title: "Finish",
          fields: [{ id: "note", label: "Note", fieldType: "TextInput" }],
        },
      ],
    })!;
    const current = renderEditableFlow(flow, {
      connectedBranchIds: [buildFlowBranchOptionKey("choice", "a")],
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "flowAuthoring.optionId 1" }),
      { target: { value: "renamed" } }
    );
    expect(current().screens[0].fields[0].options?.[0].id).toBe("a");
    expect(screen.getByRole("alert").textContent).toBe(
      "flowAuthoring.connectedIdentifier"
    );
    fireEvent.click(screen.getAllByRole("button", { name: "delete" })[1]);
    expect(current().screens[0].fields[0].options).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("combobox", { name: "flowAuthoring.fieldType" })
    );
    fireEvent.click(screen.getByRole("option", { name: "Text" }));
    expect(current().screens[0].fields[0].fieldType).toBe("RadioButtonsGroup");
    fireEvent.click(screen.getByRole("button", { name: "END Finish" }));
    fireEvent.click(
      screen.getByRole("button", { name: "flowAuthoring.screen" })
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "flowAuthoring.footer" }),
      { target: { value: "off" } }
    );
    expect(current().screens[1].footer).toEqual(flow.screens[1].footer);
  });
});

describe("FlowFormEditorContent prompt variables", () => {
  const renderWithAnswerTokens = (
    flowConfig: Parameters<typeof FlowFormEditorContent>[0]["flowConfig"],
    onChange = jest.fn()
  ) =>
    render(
      <FlowFieldAnswerTokensContext.Provider
        value={listFlowFieldAnswerTokens(flowConfig)}
      >
        <FlowFormEditorContent flowConfig={flowConfig} onChange={onChange} />
      </FlowFieldAnswerTokensContext.Provider>
    );

  it("shows the form answer variable for every field type", () => {
    renderWithAnswerTokens({
      templateId: "template-1",
      ctaText: "Open",
      answersKey: "order",
      screens: [
        {
          id: "screen-1",
          title: "Screen",
          fields: [
            { id: "name", label: "Name", fieldType: "TextInput" as const },
            {
              id: "size",
              label: "Size",
              fieldType: "Dropdown" as const,
              options: [{ id: "s", title: "S" }],
            },
            {
              id: "Wrap Gift",
              label: "Wrap",
              fieldType: "RadioButtonsGroup" as const,
              options: [{ id: "yes", title: "Yes" }],
            },
            { id: "day", label: "Day", fieldType: "DatePicker" as const },
          ],
        },
      ],
    });

    expect(
      screen
        .getAllByTestId("flow-field-answer-token")
        .map(token => token.textContent)
    ).toEqual([
      "{{form.order.name}}",
      "{{form.order.size}}",
      "{{form.order.wrap_gift}}",
      "{{form.order.day}}",
    ]);
  });

  it("shows no variable for a form without an answers key", () => {
    renderWithAnswerTokens({
      templateId: "template-1",
      ctaText: "Open",
      screens: [
        {
          id: "screen-1",
          title: "Screen",
          fields: [
            { id: "name", label: "Name", fieldType: "TextInput" as const },
          ],
        },
      ],
    });

    expect(screen.queryByTestId("flow-field-answer-token")).toBeNull();
    expect(screen.getByTestId("flow-prompt-input-key")).toBeTruthy();
    // Nothing to insert, so nothing to explain.
    expect(screen.queryByText("flowPromptInputHint")).toBeNull();
  });

  it("explains where answers go on a screen of choices only", () => {
    renderWithAnswerTokens({
      templateId: "template-1",
      ctaText: "Open",
      answersKey: "order",
      screens: [
        {
          id: "screen-1",
          title: "Screen",
          fields: [
            {
              id: "size",
              label: "Size",
              fieldType: "Dropdown" as const,
              options: [{ id: "s", title: "S" }],
            },
          ],
        },
      ],
    });

    expect(screen.getByText("flowPromptInputHint")).toBeTruthy();
    expect(screen.getByTestId("flow-field-answer-token").textContent).toBe(
      "{{form.order.size}}"
    );
  });

  it("lets a text field choose the prompt variable name", () => {
    const onChange = jest.fn();
    renderWithAnswerTokens(
      {
        templateId: "template-1",
        ctaText: "Open",
        answersKey: "order",
        screens: [
          {
            id: "screen-1",
            title: "Screen",
            fields: [
              { id: "name", label: "Name", fieldType: "TextInput" as const },
            ],
          },
        ],
      },
      onChange
    );

    expect(screen.getByText("{{form.order.name}}")).toBeTruthy();
    fireEvent.change(screen.getByTestId("flow-prompt-input-key"), {
      target: { value: "sport" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        screens: [
          expect.objectContaining({
            fields: [expect.objectContaining({ id: "sport" })],
          }),
        ],
      })
    );
  });
});

describe("FlowFormEditorContent branch handles", () => {
  it("keeps unfinished Flow fields quiet in a draft and validates when publishing", () => {
    const unfinished = {
      ...sampleFlowConfig,
      screens: [
        {
          ...sampleFlowConfig.screens[0],
          fields: [{ ...sampleFlowConfig.screens[0].fields[0], label: "" }],
        },
      ],
    };
    const onChange = jest.fn();
    const view = render(
      <FlowFormEditorContent
        flowConfig={unfinished}
        onChange={onChange}
        validationMode="draft"
      />
    );
    expect(view.container.querySelector('[aria-invalid="true"]')).toBeNull();
    view.rerender(
      <FlowFormEditorContent
        flowConfig={unfinished}
        onChange={onChange}
        validationMode="runnable"
      />
    );
    expect(
      view.container.querySelector(
        '[data-validation-error="Label is required"]'
      )
    ).toBeTruthy();
  });
  it("renders active branch handles for radio options only", () => {
    const renderFlowBranchHandle = jest.fn(params => (
      <button
        type="button"
        data-testid="branch-handle"
        data-handle-id={params.handleId}
      />
    ));

    render(
      <FlowFormEditorContent
        flowConfig={sampleFlowConfig}
        onChange={jest.fn()}
        renderFlowBranchHandle={renderFlowBranchHandle}
      />
    );

    const handles = screen.getAllByTestId("branch-handle");

    expect(handles).toHaveLength(2);
    expect(handles[0]?.getAttribute("data-handle-id")).toBe(
      buildFlowBranchSourceHandleId("radio-field", "one")
    );
    expect(handles[1]?.getAttribute("data-handle-id")).toBe(
      buildFlowBranchSourceHandleId("radio-field", "two")
    );
    expect(renderFlowBranchHandle).toHaveBeenCalledTimes(2);
  });

  it("requests branch handle geometry refresh when the active screen changes", () => {
    const onViewportChange = jest.fn();

    render(
      <FlowFormEditorContent
        flowConfig={multiScreenFlowConfig}
        onChange={jest.fn()}
        onViewportChange={onViewportChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Follow up" }));

    expect(onViewportChange).toHaveBeenCalledTimes(1);
  });

  it("keeps wheel gestures inside the inline flow form editor", () => {
    const parentWheel = jest.fn();

    render(
      <div onWheel={parentWheel}>
        <FlowFormEditorContent
          flowConfig={sampleFlowConfig}
          onChange={jest.fn()}
        />
      </div>
    );

    fireEvent.wheel(screen.getByText("flowAddField"), {
      deltaX: 160,
      deltaY: 0,
      ctrlKey: true,
    });

    expect(parentWheel).not.toHaveBeenCalled();
  });

  it("keeps wheel gestures inside the full WhatsApp flow editor", () => {
    const parentWheel = jest.fn();

    render(
      <div onWheel={parentWheel}>
        <FieldEditor flowConfig={sampleFlowConfig} onChange={jest.fn()} />
      </div>
    );

    fireEvent.wheel(screen.getByTestId("whatsapp-action-renderer"), {
      deltaX: 160,
      deltaY: 0,
      ctrlKey: true,
    });

    expect(parentWheel).not.toHaveBeenCalled();
  });

  it("authors endpoint routes and refreshes React Flow geometry after edits", () => {
    const onChange = jest.fn();
    const onViewportChange = jest.fn();

    render(
      <FlowFormEditorContent
        flowConfig={endpointFlowConfig}
        onChange={onChange}
        onViewportChange={onViewportChange}
      />
    );

    const routeToggles = screen.getAllByLabelText("flowEndpointRouteToggle");
    expect(routeToggles.length).toBeGreaterThan(0);
    fireEvent.click(routeToggles[1]!);

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        flowNavigationMode: "data_endpoint",
        screenRoutes: expect.objectContaining({
          screen_ONE: ["screen_TWO", "screen_THREE"],
        }),
      })
    );
    expect(onViewportChange).toHaveBeenCalled();
  });

  it("replaces a sole route when the global route limit is reached", () => {
    const onChange = jest.fn();

    render(
      <FlowFormEditorContent
        flowConfig={routeLimitFlowConfig}
        onChange={onChange}
      />
    );

    const routeToggles = screen.getAllByLabelText("flowEndpointRouteToggle");
    const replacementToggle = routeToggles[1]!;

    expect(replacementToggle).toHaveProperty("disabled", false);
    fireEvent.click(replacementToggle);

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        screenRoutes: expect.objectContaining({
          SCREEN_A: ["SCREEN_C"],
        }),
      })
    );
  });

  it("exposes an accessible navigation mode selector", () => {
    render(
      <FlowFormEditorContent
        flowConfig={multiScreenFlowConfig}
        onChange={jest.fn()}
      />
    );

    expect(
      screen.getByRole("combobox", { name: "flowNavigationLabel" })
    ).toBeTruthy();
  });

  it("authors radio-option branch rules from the allowed route map", () => {
    const onChange = jest.fn();

    render(
      <FlowFormEditorContent
        flowConfig={endpointFlowConfig}
        onChange={onChange}
      />
    );

    const branchRouteSelect = screen.getByRole("combobox", {
      name: "flowEndpointBranchRules: Pick one: One",
    });
    fireEvent.change(branchRouteSelect, { target: { value: "screen-2" } });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        flowBranchRules: expect.objectContaining({
          screen_ONE: expect.objectContaining({
            "radio-field": expect.objectContaining({ one: "screen_TWO" }),
          }),
        }),
      })
    );
  });
});

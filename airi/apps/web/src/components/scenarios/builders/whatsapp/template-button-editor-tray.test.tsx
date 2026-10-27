/**
 * @jest-environment jsdom
 */

const mockTranslate = jest.fn(
  (key: string, _values?: Record<string, unknown>) => key
);

jest.mock("next-intl", () => ({
  useTranslations: () => mockTranslate,
}));

import { zodResolver } from "@hookform/resolvers/zod";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { applyEditableTemplateButtonPatch } from "../../nodes/action-node/action-node-template-editor";
import {
  WhatsAppTemplateButtonEditorTray,
  WhatsAppTemplateButtonRowActions,
} from "./template-button-editor-tray";
import {
  applyWhatsAppTemplateEditorFormValues,
  editableWhatsAppTemplateEditorFormSchema,
  getTemplateButtonDisplayLabel,
  type EditableWhatsAppTemplateButton,
  type EditableWhatsAppTemplateEditorFormValues,
} from "./template-editor-utils";
import type {
  TemplateFlowScreenLookup,
  TemplateFlowScreens,
} from "./template-flow-screens";

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  // Keyboard focus opens tooltips, which measure themselves.
  global.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const buttonTypeOptions = [
  { value: "quick_reply" as const, label: "Reply" },
  { value: "url" as const, label: "Link" },
  { value: "phone" as const, label: "Phone" },
  { value: "flow" as const, label: "Flow" },
];

type TrayHarnessProps = ComponentProps<
  typeof WhatsAppTemplateButtonEditorTray
> & {
  /** Seed only — tray reads `buttons` from the form via `useWatch` */
  buttons?: EditableWhatsAppTemplateButton[];
  stateful?: boolean;
};

function TrayHarness({
  buttons = [],
  stateful = false,
  ...trayProps
}: TrayHarnessProps) {
  const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
    resolver: zodResolver(editableWhatsAppTemplateEditorFormSchema, undefined, {
      mode: "sync",
    }),
    defaultValues: {
      headerText: "",
      bodyText: "",
      footerText: "",
      buttons,
    },
    mode: "onChange",
  });
  // eslint-disable-next-line react-hooks/incompatible-library -- Match the real editor subscription to catch mutations before type cleanup.
  const watchedButtons = form.watch("buttons");
  return (
    <FormProvider {...form}>
      <form>
        <WhatsAppTemplateButtonEditorTray
          {...trayProps}
          onButtonChange={
            stateful
              ? (index, patch) => {
                  trayProps.onButtonChange(index, patch);
                  form.setValue(
                    "buttons",
                    watchedButtons.map(button =>
                      button.index === index
                        ? applyEditableTemplateButtonPatch(button, patch)
                        : button
                    )
                  );
                }
              : trayProps.onButtonChange
          }
        />
        {stateful ? (
          <output data-testid="button-data">
            {JSON.stringify(watchedButtons)}
          </output>
        ) : null}
      </form>
    </FormProvider>
  );
}

function renderTray(overrides: Partial<TrayHarnessProps> = {}) {
  const props: TrayHarnessProps = {
    buttons: [],
    buttonTypeOptions,
    existingFlows: [],
    onButtonChange: jest.fn(),
    onButtonRemove: jest.fn(),
    onAddButton: jest.fn(),
    ...overrides,
  };

  render(<TrayHarness {...props} />);
  return props;
}

describe("WhatsAppTemplateButtonEditorTray", () => {
  it("selects a Flow without changing controlled state or retaining the old start screen", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderTray({
        stateful: true,
        buttons: [
          {
            index: 0,
            type: "flow",
            label: "Open",
            flowId: "",
            navigateScreen: "OLD_SCREEN",
          },
        ],
        existingFlows: [{ id: "new-flow", name: "New flow" }],
      });
      fireEvent.keyDown(screen.getByRole("combobox", { name: "buttonFlow" }), {
        key: "ArrowDown",
      });
      fireEvent.click(await screen.findByRole("option", { name: "New flow" }));
      await waitFor(() =>
        expect(
          JSON.parse(screen.getByTestId("button-data").textContent!)[0].flowId
        ).toBe("new-flow")
      );
      expect(
        JSON.parse(screen.getByTestId("button-data").textContent!)[0]
          .navigateScreen
      ).toBeUndefined();
      expect(
        warning.mock.calls.filter(args =>
          /uncontrolled|controlled/.test(String(args[0]))
        )
      ).toEqual([]);
    } finally {
      warning.mockRestore();
    }
  });

  it("ignores a native empty Flow sync event during template reset", async () => {
    const onButtonChange = jest.fn();
    renderTray({
      stateful: true,
      buttons: [
        {
          index: 0,
          type: "flow",
          label: "Open B",
          flowId: "flow-b",
          flowAction: "navigate",
          navigateScreen: "B_START",
        },
      ],
      existingFlows: [{ id: "flow-b", name: "Flow B" }],
      onButtonChange,
    });
    const nativeFlowSelect = Array.from(
      document.querySelectorAll("select")
    ).find(select => select.value === "flow-b");
    expect(nativeFlowSelect).toBeTruthy();

    fireEvent.change(nativeFlowSelect!, { target: { value: "" } });

    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("button-data").textContent!)[0]
      ).toEqual(
        expect.objectContaining({
          flowId: "flow-b",
          navigateScreen: "B_START",
        })
      )
    );
    expect(onButtonChange).not.toHaveBeenCalled();
  });

  it("clears the previous destination when switching from URL to phone", async () => {
    renderTray({
      stateful: true,
      buttons: [
        {
          index: 0,
          type: "url",
          label: "Contact",
          value: "https://example.com",
        },
      ],
    });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Phone" }));
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("button-data").textContent!)[0]
      ).toEqual({ index: 0, label: "Contact", type: "phone", value: "" })
    );
  });

  it.each([
    ["url", "whatsappTemplateUrlLabel", "url"],
    ["phone", "whatsappTemplatePhoneLabel", "tel"],
  ] as const)(
    "names the %s destination and supplies the appropriate input type",
    (type, name, inputType) => {
      renderTray({
        buttons: [{ index: 0, type, label: "Contact", value: "" }],
      });
      const input = screen.getByRole("textbox", { name });
      expect(input.getAttribute("type")).toBe(inputType);
      expect(screen.getByRole("combobox").className).toContain("w-full");
    }
  );

  it("shows a field error for an empty URL after validation", async () => {
    function ValidationHarness() {
      const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
        resolver: zodResolver(editableWhatsAppTemplateEditorFormSchema),
        defaultValues: {
          headerText: "",
          bodyText: "Hello",
          footerText: "",
          buttons: [{ index: 0, type: "url", label: "Website", value: "" }],
        },
      });
      return (
        <FormProvider {...form}>
          <WhatsAppTemplateButtonEditorTray
            buttonTypeOptions={buttonTypeOptions}
            onButtonChange={jest.fn()}
            onButtonRemove={jest.fn()}
            onAddButton={jest.fn()}
          />
          <button onClick={() => void form.trigger()}>Validate</button>
        </FormProvider>
      );
    }
    render(<ValidationHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "whatsappTemplateErrorLinkRequired"
    );
  });

  it("shows only the add button when there are no editable buttons", () => {
    renderTray();

    expect(
      screen.getByRole("button", { name: "whatsappTemplateAddButton" })
    ).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("disables adding a fourth template button", () => {
    const props = renderTray({
      buttons: [0, 1, 2].map(index => ({
        index,
        type: "quick_reply",
        label: `Option ${index}`,
      })),
    });
    const add = screen.getByRole("button", {
      name: "whatsappTemplateAddButton",
    });
    expect(add).toHaveProperty("disabled", true);
    fireEvent.click(add);
    expect(props.onAddButton).not.toHaveBeenCalled();
  });

  it("adds a default reply button through the parent callback", () => {
    const props = renderTray();

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateAddButton" })
    );

    expect(props.onAddButton).toHaveBeenCalledTimes(1);
  });

  it("shows flow picker in the tray for flow buttons", () => {
    renderTray({
      buttons: [
        {
          index: 0,
          type: "flow",
          label: "Open flow",
          flowId: "",
          flowAction: "navigate",
        },
      ],
      existingFlows: [{ id: "flow-1", name: "Registration" }],
      onExistingFlowPickerOpen: jest.fn(),
    });

    const flowSelect = screen.getByLabelText("buttonFlow");
    expect(flowSelect).toBeTruthy();
    expect(screen.queryByText("whatsappTemplateOpenFlow")).toBeNull();
  });

  it("does not show the generic WhatsApp Flow label for an existing template flow before the flow list resolves", () => {
    const onExistingFlowPickerOpen = jest.fn();

    renderTray({
      buttons: [
        {
          index: 0,
          type: "flow",
          label: "Open flow",
          flowId: "flow-1",
          flowAction: "navigate",
        },
      ],
      existingFlows: [],
      onExistingFlowPickerOpen,
    });

    expect(screen.getAllByText("untitledForm").length).toBeGreaterThan(0);
    expect(screen.queryByText(/flow-1/)).toBeNull();
    expect(screen.queryByText("interactiveSurfaceWhatsAppFlow")).toBeNull();
    expect(onExistingFlowPickerOpen).toHaveBeenCalledTimes(1);
  });

  it("uses the empty flow prompt only when no template flow is selected", () => {
    const props = renderTray({
      buttons: [
        {
          index: 0,
          type: "flow",
          label: "Open flow",
          flowId: "",
          flowAction: "navigate",
        },
      ],
      existingFlows: [{ id: "flow-1", name: "Registration" }],
      onExistingFlowPickerOpen: jest.fn(),
    });

    const flowSelect = screen.getByLabelText("buttonFlow");
    expect(flowSelect.textContent).toContain(
      "whatsappTemplateButtonValuePlaceholderFlow"
    );
    expect(props.onExistingFlowPickerOpen).not.toHaveBeenCalled();
  });

  it("renders flow action menu in the CTA row actions strip", () => {
    function RowActionsHarness() {
      const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
        resolver: zodResolver(
          editableWhatsAppTemplateEditorFormSchema,
          undefined,
          {
            mode: "sync",
          }
        ),
        defaultValues: {
          headerText: "",
          bodyText: "",
          footerText: "",
          buttons: [
            {
              index: 0,
              type: "flow",
              label: "Open flow",
              flowId: "flow-1",
              flowAction: "navigate",
            },
          ],
        },
        mode: "onChange",
      });
      return (
        <FormProvider {...form}>
          <WhatsAppTemplateButtonRowActions
            formIndex={0}
            canEditTemplateFlow={false}
            onButtonChange={jest.fn()}
            onButtonRemove={jest.fn()}
            onOpenInlineTemplateFlow={jest.fn()}
          />
        </FormProvider>
      );
    }
    render(<RowActionsHarness />);
    expect(
      screen.getByLabelText("whatsappTemplateButtonEditType")
    ).toBeTruthy();
    expect(screen.getByLabelText("whatsappTemplatePreviewForm")).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.queryByLabelText("whatsappTemplateOpenFlow")).toBeNull();
  });

  it("keeps the quick reply branch add control after delete", () => {
    function RowActionsHarness() {
      const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
        resolver: zodResolver(
          editableWhatsAppTemplateEditorFormSchema,
          undefined,
          {
            mode: "sync",
          }
        ),
        defaultValues: {
          headerText: "",
          bodyText: "",
          footerText: "",
          buttons: [
            {
              index: 0,
              type: "quick_reply",
              label: "Get started",
              value: "",
            },
          ],
        },
        mode: "onChange",
      });
      return (
        <FormProvider {...form}>
          <WhatsAppTemplateButtonRowActions
            formIndex={0}
            branchHandle={
              <button type="button" aria-label="branch add">
                +
              </button>
            }
            canEditTemplateFlow={false}
            onButtonChange={jest.fn()}
            onButtonRemove={jest.fn()}
            onOpenInlineTemplateFlow={jest.fn()}
          />
        </FormProvider>
      );
    }

    render(<RowActionsHarness />);

    const deleteButton = screen.getByRole("button", {
      name: "whatsappTemplateRemoveButton",
    });
    const branchButton = screen.getByRole("button", { name: "branch add" });

    expect(
      deleteButton.compareDocumentPosition(branchButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("does not render a dedicated quick reply label input", () => {
    renderTray({
      buttons: [
        {
          index: 0,
          type: "quick_reply",
          label: "Kazakh",
          value: "",
        },
      ],
    });

    expect(screen.queryByDisplayValue("Kazakh")).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "whatsappTemplateButtonTypeLabel" })
    ).toBeTruthy();
  });

  it("keeps focus while editing URL button labels", () => {
    renderTray({
      buttons: [
        {
          index: 0,
          type: "url",
          label: "Website",
          value: "https://example.com",
        },
      ],
    });

    const input = screen.getByDisplayValue("Website");
    input.focus();
    fireEvent.change(input, { target: { value: "Docs" } });

    expect(screen.getByDisplayValue("Docs")).toBe(document.activeElement);
  });

  it("describes each button type and disables types over their limit", async () => {
    renderTray({
      buttonTypeOptions: [
        { value: "quick_reply", label: "Reply", description: "Reply help" },
        { value: "url", label: "Link", description: "Link help" },
        { value: "phone", label: "Phone", description: "Phone help" },
      ],
      buttons: [
        { index: 0, type: "url", label: "One", value: "https://one.test" },
        { index: 1, type: "url", label: "Two", value: "https://two.test" },
        { index: 2, type: "phone", label: "Call", value: "+77001234567" },
      ],
    });
    const typeSelects = screen.getAllByRole("combobox", {
      name: "whatsappTemplateButtonTypeLabel",
    });
    fireEvent.keyDown(typeSelects[2]!, { key: "ArrowDown" });
    const link = await screen.findByRole("option", { name: /^Link/ });
    expect(link.textContent).toBe("LinkwhatsappTemplateTypeLimitTwo");
    expect(link.hasAttribute("data-disabled")).toBe(true);
    const reply = screen.getByRole("option", { name: /^Reply/ });
    expect(reply.textContent).toBe("ReplyReply help");
    expect(reply.hasAttribute("data-disabled")).toBe(false);
    const phone = screen.getByRole("option", { name: /^Phone/ });
    expect(phone.hasAttribute("data-disabled")).toBe(false);
  });

  it("marks a type that already used its single slot on another row", async () => {
    renderTray({
      buttonTypeOptions: [
        { value: "url", label: "Link" },
        { value: "phone", label: "Phone" },
      ],
      buttons: [
        { index: 0, type: "url", label: "Shop", value: "https://shop.test" },
        { index: 1, type: "phone", label: "Call", value: "+77001234567" },
      ],
    });
    fireEvent.keyDown(
      screen.getAllByRole("combobox", {
        name: "whatsappTemplateButtonTypeLabel",
      })[0]!,
      { key: "ArrowDown" }
    );
    const phone = await screen.findByRole("option", { name: /^Phone/ });
    expect(phone.textContent).toBe("PhonewhatsappTemplateTypeLimitOne");
    expect(phone.hasAttribute("data-disabled")).toBe(true);
  });

  it("counts buttons next to Add and points the disabled Add at the count", () => {
    renderTray({
      buttons: [0, 1, 2].map(index => ({
        index,
        type: "quick_reply" as const,
        label: `Option ${index}`,
      })),
    });
    const counter = screen.getByTestId("template-button-count");
    expect(counter.textContent).toBe("whatsappTemplateButtonCount");
    const add = screen.getByRole("button", {
      name: "whatsappTemplateAddButton",
    });
    expect(add).toHaveProperty("disabled", true);
    expect(add.getAttribute("aria-describedby")).toBe(counter.id);
  });

  it("does not describe the Add button while more buttons fit", () => {
    renderTray();
    expect(screen.getByTestId("template-button-count")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "whatsappTemplateAddButton" })
        .hasAttribute("aria-describedby")
    ).toBe(false);
  });

  it("numbers tray rows like the preview and names untitled buttons", () => {
    renderTray({
      buttons: [
        { index: 0, type: "quick_reply", label: "Yes" },
        { index: 1, type: "url", label: " ", value: "" },
      ],
    });
    expect(
      screen
        .getAllByTestId("template-button-tray-row")
        .map(row => row.querySelector("p")?.textContent)
    ).toEqual(["1 · Yes", "2 · untitledButton"]);
  });

  it("labels the button text field and drops the per-type hint paragraphs", () => {
    renderTray({
      buttons: [
        { index: 0, type: "url", label: "Shop", value: "" },
        { index: 1, type: "phone", label: "Call", value: "" },
        { index: 2, type: "quick_reply", label: "Yes" },
      ],
    });
    expect(screen.getAllByRole("textbox", { name: "buttonText" })).toHaveLength(
      2
    );
    for (const key of [
      "whatsappTemplateReplyClickHint",
      "whatsappTemplateUrlClickHint",
      "whatsappTemplatePhoneClickHint",
      "whatsappTemplateContactClickHint",
    ]) {
      expect(screen.queryByText(key)).toBeNull();
    }
    expect(
      screen.getByRole("textbox", { name: "whatsappTemplateUrlLabel" })
    ).toHaveProperty("placeholder", "whatsappTemplateAttachLinkPlaceholder");
  });

  it("shows the form error only after a save attempt", async () => {
    function SubmitHarness() {
      const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
        resolver: zodResolver(editableWhatsAppTemplateEditorFormSchema),
        defaultValues: {
          headerText: "",
          bodyText: "Hello",
          footerText: "",
          buttons: [
            {
              index: 0,
              type: "flow",
              label: "Open",
              flowId: "",
              flowAction: "navigate",
            },
          ],
        },
      });
      return (
        <FormProvider {...form}>
          <WhatsAppTemplateButtonEditorTray
            buttonTypeOptions={buttonTypeOptions}
            onButtonChange={jest.fn()}
            onButtonRemove={jest.fn()}
            onAddButton={jest.fn()}
          />
          <button type="button" onClick={() => void form.trigger()}>
            Validate
          </button>
          <button
            type="button"
            onClick={() => void form.handleSubmit(() => undefined)()}
          >
            Save
          </button>
        </FormProvider>
      );
    }
    render(<SubmitHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("combobox", { name: "buttonFlow" })
          .getAttribute("aria-invalid")
      ).toBe("false")
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "whatsappTemplateErrorFormRequired"
    );
  });

  it.each([
    [true, "whatsappTemplateFormsLoading"],
    [false, "whatsappTemplateFormsEmpty"],
  ])(
    "explains an empty form list while loading=%s",
    async (existingFlowsLoading, text) => {
      renderTray({
        buttons: [
          {
            index: 0,
            type: "flow",
            label: "Open",
            flowId: "",
            flowAction: "navigate",
          },
        ],
        existingFlows: [],
        existingFlowsLoading,
      });
      fireEvent.keyDown(screen.getByRole("combobox", { name: "buttonFlow" }), {
        key: "ArrowDown",
      });
      expect(await screen.findByText(text)).toBeTruthy();
    }
  );

  it("names unnamed forms without showing their IDs", async () => {
    renderTray({
      buttons: [
        {
          index: 0,
          type: "flow",
          label: "Open",
          flowId: "",
          flowAction: "navigate",
        },
      ],
      existingFlows: [
        { id: "flow-9", name: "" },
        { id: "flow-2", name: "Booking" },
      ],
    });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "buttonFlow" }), {
      key: "ArrowDown",
    });
    const untitled = await screen.findByRole("option", {
      name: "untitledForm",
    });
    expect(untitled.getAttribute("title")).toBe("flow-9");
    expect(screen.getByRole("option", { name: "Booking" })).toBeTruthy();
    expect(screen.queryByText(/flow-9/)).toBeNull();
  });

  it("opens an editable form with the pencil", () => {
    const onOpenInlineTemplateFlow = jest.fn();
    function EditableRowHarness() {
      const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
        defaultValues: {
          headerText: "",
          bodyText: "",
          footerText: "",
          buttons: [
            {
              index: 0,
              type: "flow",
              label: "Open",
              flowId: "flow-1",
              flowAction: "navigate",
            },
          ],
        },
      });
      return (
        <FormProvider {...form}>
          <WhatsAppTemplateButtonRowActions
            formIndex={0}
            canEditTemplateFlow
            inlineTemplateFlowId="flow-1"
            onButtonChange={jest.fn()}
            onButtonRemove={jest.fn()}
            onOpenInlineTemplateFlow={onOpenInlineTemplateFlow}
          />
        </FormProvider>
      );
    }
    render(<EditableRowHarness />);
    const edit = screen.getByRole("button", {
      name: "whatsappTemplateOpenFlow",
    });
    expect(edit.querySelector(".lucide-pencil")).not.toBeNull();
    fireEvent.click(edit);
    expect(onOpenInlineTemplateFlow).toHaveBeenCalledWith("flow-1");
    expect(
      screen.getByRole("button", { name: "whatsappTemplateButtonEditType" })
    ).toBeTruthy();
  });

  it("names each connected route that Save removes", () => {
    renderTray({
      buttons: [{ index: 0, type: "quick_reply", label: "Premium" }],
      pendingRouteRemovals: [
        { key: "button:0", label: "Basic", nextStepLabel: "Basic follow-up" },
      ],
    });

    const notice = screen.getByTestId("whatsapp-template-save-removes-route");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe("whatsappTemplateSaveRemovesRoute");
    expect(mockTranslate).toHaveBeenCalledWith(
      "whatsappTemplateSaveRemovesRoute",
      { button: "Basic", step: "Basic follow-up" }
    );
  });

  it("keeps the removal notice after the last button is deleted", () => {
    renderTray({
      pendingRouteRemovals: [
        { key: "button:0", label: "Basic", nextStepLabel: "Basic follow-up" },
        {
          key: "button:1",
          label: "Premium",
          nextStepLabel: "Premium follow-up",
        },
        {
          key: "form-submitted",
          label: "Form submitted",
          nextStepLabel: "Pick a medal",
        },
      ],
    });

    expect(
      screen.getAllByTestId("whatsapp-template-save-removes-route")
    ).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "whatsappTemplateAddButton" })
    ).toBeTruthy();
  });

  it("calls the removed Form submitted route a route in Kazakh, not a button", () => {
    const kz = jest.requireActual<{ Scenarios: Record<string, string> }>(
      "../../../../../messages/scenarios/kz/page.json"
    ).Scenarios;
    mockTranslate.mockImplementation((key, values) =>
      (kz[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) =>
        String(values?.[name] ?? "")
      )
    );
    try {
      renderTray({
        pendingRouteRemovals: [
          { key: "button:0", label: "Иә", nextStepLabel: "Карусель" },
          {
            key: "form-submitted",
            label: kz.serviceRouteFlowSubmitted,
            nextStepLabel: "Карусель",
          },
        ],
      });

      const [buttonRoute, formRoute] = screen.getAllByTestId(
        "whatsapp-template-save-removes-route"
      );
      expect(formRoute.textContent).toBe(
        "Сақтағанда «Карусель» қадамына апаратын «Форма жіберілді» бағыты жойылады."
      );
      expect(formRoute.textContent).not.toMatch(/батырма/);
      expect(buttonRoute.textContent).toBe(
        "Сақтағанда «Карусель» қадамына апаратын «Иә» бағыты жойылады."
      );
    } finally {
      mockTranslate.mockImplementation(key => key);
    }
  });

  it("warns once about reply buttons that share a text", () => {
    renderTray({
      buttons: [
        { index: 0, type: "quick_reply", label: "Yes" },
        { index: 1, type: "quick_reply", label: " yes" },
        { index: 2, type: "quick_reply", label: "No" },
      ],
    });

    expect(
      screen.getAllByTestId("whatsapp-template-duplicate-button-text")
    ).toHaveLength(1);
    expect(mockTranslate).toHaveBeenCalledWith(
      "whatsappTemplateDuplicateButtonText",
      { label: "Yes" }
    );
  });

  it("shows no notices while no route is removed and every text differs", () => {
    renderTray({
      buttons: [
        { index: 0, type: "quick_reply", label: "Yes" },
        { index: 1, type: "quick_reply", label: "No" },
      ],
    });

    expect(
      screen.queryByTestId("whatsapp-template-save-removes-route")
    ).toBeNull();
    expect(
      screen.queryByTestId("whatsapp-template-duplicate-button-text")
    ).toBeNull();
  });

  it("removes a button without reaching the canvas node", () => {
    const onButtonRemove = jest.fn();
    const onParentClick = jest.fn();
    function RemoveHarness() {
      const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
        defaultValues: {
          headerText: "",
          bodyText: "",
          footerText: "",
          buttons: [{ index: 0, type: "quick_reply", label: "Yes" }],
        },
      });
      return (
        <FormProvider {...form}>
          <div onClick={onParentClick}>
            <WhatsAppTemplateButtonRowActions
              formIndex={0}
              canEditTemplateFlow={false}
              onButtonChange={jest.fn()}
              onButtonRemove={onButtonRemove}
              onOpenInlineTemplateFlow={jest.fn()}
            />
          </div>
        </FormProvider>
      );
    }
    render(<RemoveHarness />);
    const remove = screen.getByRole("button", {
      name: "whatsappTemplateRemoveButton",
    });
    expect(remove.className).toContain("nokey");
    expect(remove.hasAttribute("title")).toBe(false);
    fireEvent.click(remove);
    expect(onButtonRemove).toHaveBeenCalledWith(0);
    expect(onParentClick).not.toHaveBeenCalled();
  });
});

describe("WhatsAppTemplateButtonEditorTray first screen", () => {
  const FORM_ID = "1234567890";

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

  function screenLookup(screens: TemplateFlowScreens) {
    return {
      screensFor: jest.fn((_flowId: string) => screens),
      isRefreshing: jest.fn((_flowId: string) => false),
      refresh: jest.fn((_flowId: string) => undefined),
    } satisfies TemplateFlowScreenLookup;
  }

  const ready = (...screenIds: string[]): TemplateFlowScreens => ({
    status: "ready",
    screenIds,
  });
  const firstScreenSelect = () =>
    screen.getByRole("combobox", { name: "whatsappTemplateFirstScreen" });
  const buttonData = () =>
    JSON.parse(
      screen.getByTestId("button-data").textContent!
    ) as EditableWhatsAppTemplateButton[];

  it("sets the first screen from the form's screens, and Save sends it", async () => {
    const onButtonChange = jest.fn();
    const lookup = screenLookup(ready("WELCOME", "DETAILS"));
    renderTray({
      stateful: true,
      buttons: [formButton({ navigateScreen: "WELCOME" })],
      existingFlows: [{ id: FORM_ID, name: "Booking" }],
      flowScreens: lookup,
      onButtonChange,
    });

    expect(lookup.screensFor).toHaveBeenCalledWith(FORM_ID);
    expect(firstScreenSelect().textContent).toBe("WELCOME");
    expect(firstScreenSelect().className).toContain("nokey");
    fireEvent.keyDown(firstScreenSelect(), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "DETAILS" }));

    expect(onButtonChange).toHaveBeenCalledWith(0, {
      navigateScreen: "DETAILS",
    });
    await waitFor(() =>
      expect(buttonData()[0]?.navigateScreen).toBe("DETAILS")
    );
    const saved = applyWhatsAppTemplateEditorFormValues(
      [{ type: "BODY", text: "Hi" }],
      { headerText: "", bodyText: "Hi", footerText: "", buttons: buttonData() }
    );
    expect(saved).toContainEqual({
      type: "BUTTONS",
      buttons: [
        {
          type: "FLOW",
          text: "Book",
          flow_id: FORM_ID,
          flow_action: "navigate",
          navigate_screen: "DETAILS",
        },
      ],
    });
  });

  it("keeps a saved screen the form no longer has, marked and disabled", async () => {
    const onButtonChange = jest.fn();
    renderTray({
      buttons: [formButton({ navigateScreen: "OLD_SCREEN" })],
      flowScreens: screenLookup(ready("WELCOME")),
      onButtonChange,
    });

    expect(firstScreenSelect().textContent).toBe(
      "whatsappTemplateFirstScreenMissing"
    );
    // A truncated label still reads as a warning, with its full text on hover.
    expect(firstScreenSelect().hasAttribute("data-missing-screen")).toBe(true);
    expect(firstScreenSelect().getAttribute("title")).toBe(
      "whatsappTemplateFirstScreenMissing"
    );
    expect(mockTranslate).toHaveBeenCalledWith(
      "whatsappTemplateFirstScreenMissing",
      { screen: "OLD_SCREEN" }
    );
    fireEvent.keyDown(firstScreenSelect(), { key: "ArrowDown" });
    const missing = await screen.findByRole("option", {
      name: "whatsappTemplateFirstScreenMissing",
    });
    expect(missing.hasAttribute("data-disabled")).toBe(true);
    expect(
      screen
        .getByRole("option", { name: "WELCOME" })
        .hasAttribute("data-disabled")
    ).toBe(false);
    expect(onButtonChange).not.toHaveBeenCalled();
  });

  it("disables the screen list and shows a spinner while the screens load", () => {
    const lookup = screenLookup({ status: "loading" });
    renderTray({
      buttons: [formButton({ navigateScreen: "WELCOME" })],
      flowScreens: lookup,
    });

    expect(firstScreenSelect()).toHaveProperty("disabled", true);
    expect(firstScreenSelect().textContent).toBe("WELCOME");
    expect(firstScreenSelect().getAttribute("title")).toBe("WELCOME");
    expect(firstScreenSelect().hasAttribute("data-missing-screen")).toBe(false);
    const busy = screen.getByRole("button", {
      name: "whatsappTemplateFirstScreenLoading",
    });
    expect(busy.querySelector(".animate-spin")).not.toBeNull();
    // Busy, but still focusable: a keyboard press keeps its place.
    expect(busy).toHaveProperty("disabled", false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    act(() => busy.focus());
    fireEvent.click(busy);
    expect(lookup.refresh).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(busy);
    expect(
      screen.queryByTestId("template-flow-first-screen-failed")
    ).toBeNull();
  });

  it("takes a typed screen id when the screens can't be read, and reloads them", () => {
    const onButtonChange = jest.fn();
    const lookup = screenLookup({ status: "failed" });
    renderTray({
      buttons: [formButton()],
      flowScreens: lookup,
      onButtonChange,
    });

    expect(
      screen.getByTestId("template-flow-first-screen-failed").textContent
    ).toBe("whatsappTemplateFirstScreenLoadFailed");
    const input = screen.getByRole("textbox", {
      name: "whatsappTemplateFirstScreen",
    });
    expect(input.getAttribute("placeholder")).toBe(
      "whatsappTemplateFirstScreenExample"
    );
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "whatsappTemplateFirstScreenLoadFailed"
    );
    fireEvent.change(input, { target: { value: "LEAD_FORM" } });
    expect(onButtonChange).toHaveBeenCalledWith(0, {
      navigateScreen: "LEAD_FORM",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateFirstScreenReload" })
    );
    expect(lookup.refresh).toHaveBeenCalledWith(FORM_ID);
  });

  it("takes a typed screen id, without a reload, when the form can't be looked up", () => {
    renderTray({ buttons: [formButton({ navigateScreen: "START" })] });

    expect(
      screen.getByRole("textbox", { name: "whatsappTemplateFirstScreen" })
    ).toHaveProperty("value", "START");
    expect(
      screen.queryByRole("button", {
        name: "whatsappTemplateFirstScreenReload",
      })
    ).toBeNull();
    expect(
      screen.queryByTestId("template-flow-first-screen-failed")
    ).toBeNull();
  });

  it.each([
    ["loads its first screen from the server", { flowAction: "data_exchange" }],
    ["has no form yet", { flowId: "" }],
  ] as const)("shows no first screen for a form button that %s", (_, patch) => {
    const lookup = screenLookup(ready("WELCOME"));
    renderTray({ buttons: [formButton(patch)], flowScreens: lookup });

    expect(screen.queryByTestId("template-flow-first-screen")).toBeNull();
    expect(lookup.screensFor).not.toHaveBeenCalled();
  });

  it("leaves templates without form buttons as they were", () => {
    const lookup = screenLookup(ready("WELCOME"));
    renderTray({
      buttons: [
        { index: 0, type: "quick_reply", label: "Yes" },
        { index: 1, type: "url", label: "Shop", value: "https://shop.test" },
      ],
      flowScreens: lookup,
    });

    expect(screen.getAllByTestId("template-button-tray-row")).toHaveLength(2);
    expect(screen.queryByTestId("template-flow-first-screen")).toBeNull();
    expect(lookup.screensFor).not.toHaveBeenCalled();
  });

  it.each([
    ["navigate", "whatsappTemplateErrorFormStartScreen"],
    ["data_exchange", null],
  ] as const)(
    "asks for a first screen on Save only when the button opens one (%s)",
    async (flowAction, expectedError) => {
      const onValid = jest.fn();
      function SaveHarness() {
        const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
          resolver: zodResolver(editableWhatsAppTemplateEditorFormSchema),
          defaultValues: {
            headerText: "",
            bodyText: "Hello",
            footerText: "",
            buttons: [formButton({ flowAction })],
          },
        });
        return (
          <FormProvider {...form}>
            <WhatsAppTemplateButtonEditorTray
              buttonTypeOptions={buttonTypeOptions}
              existingFlows={[{ id: FORM_ID, name: "Booking" }]}
              flowScreens={screenLookup(ready("WELCOME"))}
              onButtonChange={jest.fn()}
              onButtonRemove={jest.fn()}
              onAddButton={jest.fn()}
            />
            <button
              type="button"
              onClick={() => void form.handleSubmit(onValid)()}
            >
              Save
            </button>
          </FormProvider>
        );
      }
      render(<SaveHarness />);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      if (expectedError === null) {
        await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByTestId("template-flow-first-screen")).toBeNull();
        return;
      }
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(expectedError);
      expect(onValid).not.toHaveBeenCalled();
      expect(firstScreenSelect().getAttribute("aria-invalid")).toBe("true");
      expect(firstScreenSelect().getAttribute("aria-describedby")).toBe(
        alert.id
      );
      expect(
        screen
          .getByRole("combobox", { name: "buttonFlow" })
          .getAttribute("aria-invalid")
      ).toBe("false");
    }
  );
});

describe("getTemplateButtonDisplayLabel", () => {
  const t = (key: string) => key;
  it.each([
    [{ label: "Yes", type: "quick_reply" as const }, "Yes"],
    [{ label: " ", type: "quick_reply" as const }, "untitledButton"],
    [{ label: "", type: "request_contact_info" as const }, "buttonContactInfo"],
    [{ label: "", type: "copy_code" as const }, "whatsappTemplateCopyCode"],
  ])("names %j as %s", (button, expected) => {
    expect(getTemplateButtonDisplayLabel(button, t)).toBe(expected);
  });
});

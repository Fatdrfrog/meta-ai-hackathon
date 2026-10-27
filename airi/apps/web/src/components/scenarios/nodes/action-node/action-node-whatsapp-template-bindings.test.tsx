/** @jest-environment jsdom */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";
import type {
  ScenarioWhatsAppTemplateBindings,
  WhatsAppComponent,
} from "@icecore/scenario-contracts";
import { ActionNodeWhatsAppTemplateBindings } from "./action-node-whatsapp-template-bindings";
import { installResizeObserver } from "@/test-support/dom-test-utils";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
jest.mock("../../builders/whatsapp/action-renderer", () => ({
  WhatsAppActionRenderer: ({
    headerText,
    bodyText,
    buttons,
  }: {
    headerText?: string;
    bodyText: string;
    buttons?: Array<{ value?: string }>;
  }) => (
    <div data-testid="resolved-message">
      {headerText}|{bodyText}|{buttons?.map(button => button.value).join("|")}
    </div>
  ),
}));
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const SelectContext = React.createContext<{
    value?: string;
    onValueChange?: (value: string) => void;
  }>({});
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
    }) => (
      <SelectContext.Provider value={{ value, onValueChange }}>
        {children}
      </SelectContext.Provider>
    ),
    SelectTrigger: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLButtonElement>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectGroup: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="select-group">{children}</div>
    ),
    SelectLabel: ({ children }: { children: React.ReactNode }) => (
      <span data-testid="select-label">{children}</span>
    ),
    SelectItem: ({
      value,
      children,
      disabled,
    }: {
      value: string;
      children: React.ReactNode;
      disabled?: boolean;
    }) => {
      const context = React.useContext(SelectContext);
      return (
        <button
          type="button"
          disabled={disabled}
          onClick={() => context.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
  };
});

beforeAll(() => {
  installResizeObserver();
});

const components: WhatsAppComponent[] = [
  { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
  { type: "BODY", text: "Status {{1}}" },
  {
    type: "BUTTONS",
    buttons: [
      { type: "URL", text: "Track", url: "https://example.com/track/{{1}}" },
    ],
  },
];

function Harness({
  initial,
  onChange = jest.fn(),
  templateComponents = components,
  promptInputs = [
    { key: "reference", label: "Customer reference", prompt: "Reference" },
  ],
  collapsible,
}: {
  initial?: ScenarioWhatsAppTemplateBindings;
  onChange?: (value: ScenarioWhatsAppTemplateBindings) => void;
  templateComponents?: WhatsAppComponent[];
  promptInputs?: Array<{ key: string; label: string; prompt: string }>;
  collapsible?: boolean;
}) {
  const [bindings, setBindings] = useState(initial);
  return (
    <ActionNodeWhatsAppTemplateBindings
      nodeId="action-1"
      components={templateComponents}
      bindings={bindings}
      promptInputs={promptInputs}
      collapsible={collapsible}
      onChange={next => {
        setBindings(next);
        onChange(next);
      }}
    />
  );
}

test("preserves legacy automatic values until explicitly configured", () => {
  const onChange = jest.fn();
  render(<Harness onChange={onChange} />);
  expect(onChange).not.toHaveBeenCalled();
  expect(
    screen.getByText("whatsappTemplateBindingsLegacyHint")
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateBindingsConfigure" })
  );
  expect(onChange).toHaveBeenCalledWith({ version: 1, parameters: {} });
  // Unset rows stay quiet until the merchant works on them.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("says what each variable is filled with until values are set", () => {
  render(
    <Harness
      templateComponents={[
        {
          type: "BODY",
          text: "Dear {{1}}, your phone {{2}} or {{first_name}}",
        },
        {
          type: "CAROUSEL",
          cards: [
            {
              components: [
                { type: "HEADER", format: "IMAGE" },
                { type: "BODY", text: "Look {{1}}" },
              ],
            },
          ],
        },
      ]}
    />
  );

  const defaults = screen.getByTestId("template-bindings-defaults");
  expect(
    Array.from(defaults.querySelectorAll("li"), item =>
      Array.from(item.children, part => part.textContent)
    )
  ).toEqual([
    ["whatsappTemplateBindingBody · {{1}}", "variableFieldFullName"],
    ["whatsappTemplateBindingBody · {{2}}", "variableFieldPhone"],
    ["whatsappTemplateBindingBody · {{first_name}}", "variableFieldFirstName"],
    [
      'whatsappTemplateBindingCard:{"index":1} · whatsappTemplateBindingBody · {{1}}',
      "variableFieldFullName",
    ],
  ]);
  expect(
    screen.getByTestId("template-bindings-default-missing")
  ).toHaveTextContent(
    'whatsappTemplateBindingsDefaultMissing:{"fallback":"both"}'
  );
});

// Conversation sends fill a missing name with the customer's WhatsApp or
// saved name, else "Customer"; only a missing phone or link goes out as "-".
test.each([
  ["Dear {{1}}, see {{order_id}}", "name"],
  ["Call {{2}} or open {{link}}", "dash"],
  ["Dear {{customer_name}}, call {{phone}}", "both"],
])("says what %s sends when its data is missing", (text, fallback) => {
  render(<Harness templateComponents={[{ type: "BODY", text }]} />);
  expect(
    screen.getByTestId("template-bindings-default-missing")
  ).toHaveTextContent(
    `whatsappTemplateBindingsDefaultMissing:${JSON.stringify({ fallback })}`
  );
});

test("adds no fallback note when every variable is always known", () => {
  render(
    <Harness
      templateComponents={[{ type: "BODY", text: "Chat {{3}} {{chat_id}}" }]}
    />
  );
  expect(screen.getByTestId("template-bindings-defaults")).toBeInTheDocument();
  expect(
    screen.queryByTestId("template-bindings-default-missing")
  ).not.toBeInTheDocument();
});

test("never tells merchants a missing name is sent as a dash", () => {
  const catalogs = Object.fromEntries(
    ["en", "ru", "kz"].map(locale => [
      locale,
      JSON.parse(
        readFileSync(
          path.join(
            __dirname,
            `../../../../../messages/scenarios/${locale}/page.json`
          ),
          "utf8"
        )
      ).Scenarios,
    ])
  );
  // next-intl is ESM-only; run its real formatter outside Jest's CJS loader.
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { readFileSync } from "node:fs";
      import { createTranslator } from "next-intl";
      const catalogs = JSON.parse(readFileSync(0, "utf8"));
      const result = {};
      for (const [locale, messages] of Object.entries(catalogs)) {
        const t = createTranslator({ locale, messages: { Scenarios: messages }, namespace: "Scenarios" });
        result[locale] = Object.fromEntries(
          ["name", "dash", "both"].map(fallback => [
            fallback,
            t("whatsappTemplateBindingsDefaultMissing", { fallback }),
          ])
        );
      }
      process.stdout.write(JSON.stringify(result));
      `,
    ],
    {
      cwd: path.resolve(__dirname, "../../../../.."),
      input: JSON.stringify(catalogs),
      encoding: "utf8",
      windowsHide: true,
    }
  );
  const hints = JSON.parse(output) as Record<
    string,
    Record<"name" | "dash" | "both", string>
  >;
  for (const hint of Object.values(hints)) {
    expect(hint.name).toContain("Customer");
    expect(hint.name).not.toMatch(/[«“]-[»”]/);
    expect(hint.dash).toMatch(/[«“]-[»”]/);
    expect(hint.dash).not.toContain("Customer");
    expect(hint.both).toBe(`${hint.name} ${hint.dash}`);
  }
});

test("shows a row error once the row is touched", () => {
  render(<Harness initial={{ version: 1, parameters: {} }} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "whatsappTemplateBindingLiteral",
    })[1]!
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "whatsappTemplateBindingValueMissing"
  );
  expect(screen.getByTestId("template-binding-value-body:1")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
});

test("edits component-scoped literals independently and previews body, header and URL", () => {
  const onChange = jest.fn();
  render(
    <Harness
      onChange={onChange}
      initial={{
        version: 1,
        parameters: {
          "header:1": { source: "literal", value: "A123" },
          "body:1": { source: "literal", value: "Shipped" },
          "button:0:1": { source: "literal", value: "parcel-9" },
        },
      }}
    />
  );
  fireEvent.change(screen.getByTestId("template-binding-value-body:1"), {
    target: { value: "Delivered" },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    version: 1,
    parameters: {
      "header:1": { source: "literal", value: "A123" },
      "body:1": { source: "literal", value: "Delivered" },
      "button:0:1": { source: "literal", value: "parcel-9" },
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateBindingsPreview" })
  );
  expect(screen.getByTestId("resolved-message")).toHaveTextContent(
    "Order A123|Status Delivered|https://example.com/track/parcel-9"
  );
  expect(
    screen.queryByText("whatsappTemplateBindingsPreviewHint")
  ).not.toBeInTheDocument();
});

test("keeps collected-answer samples local and shows missing preview values", () => {
  const onChange = jest.fn();
  render(
    <Harness
      onChange={onChange}
      templateComponents={[{ type: "BODY", text: "Reference {{1}}" }]}
      initial={{
        version: 1,
        parameters: { "body:1": { source: "prompt_input", key: "reference" } },
      }}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateBindingsPreview" })
  );
  expect(
    screen.getByText("whatsappTemplateBindingsPreviewMissing")
  ).toBeInTheDocument();
  const sample = screen.getByTestId(
    "template-binding-sample-prompt_input:reference"
  );
  expect(sample).toHaveAttribute(
    "placeholder",
    "whatsappTemplateBindingSamplePlaceholder"
  );
  fireEvent.change(sample, { target: { value: "REF42" } });
  expect(screen.getByTestId("resolved-message")).toHaveTextContent(
    "Reference REF42"
  );
  expect(onChange).not.toHaveBeenCalled();
});

test("flags an unavailable collected answer and empty fixed value", () => {
  render(
    <Harness
      initial={{
        version: 1,
        parameters: {
          "header:1": { source: "prompt_input", key: "removed" },
          "body:1": { source: "literal", value: " " },
        },
      }}
    />
  );
  expect(
    screen.getByText("whatsappTemplateBindingInputUnavailable")
  ).toBeInTheDocument();
  expect(
    screen.getByText("whatsappTemplateBindingValueMissing")
  ).toBeInTheDocument();
  expect(screen.getByTestId("template-binding-value-body:1")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
});

test("renders nothing for a template without variables or stale values", () => {
  const { container } = render(
    <Harness
      templateComponents={[{ type: "BODY", text: "Your parcel has arrived." }]}
    />
  );
  expect(container).toBeEmptyDOMElement();
});

test("selects exact context and prior answer sources without duplicate aliases", () => {
  const onChange = jest.fn();
  render(
    <Harness
      onChange={onChange}
      templateComponents={[{ type: "BODY", text: "Hello {{1}}" }]}
      initial={{ version: 1, parameters: {} }}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateBindingContext" })
  );
  expect(
    screen.getAllByRole("button", { name: "variableFieldFullName" })
  ).toHaveLength(1);
  expect(
    screen.getAllByRole("button", { name: "variableFieldPhone" })
  ).toHaveLength(1);
  fireEvent.click(
    screen.getByRole("button", { name: "variableFieldFirstName" })
  );
  expect(onChange).toHaveBeenLastCalledWith({
    version: 1,
    parameters: { "body:1": { source: "context", key: "first_name" } },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateBindingPromptInput" })
  );
  expect(onChange).toHaveBeenLastCalledWith({
    version: 1,
    parameters: { "body:1": { source: "prompt_input", key: "reference" } },
  });
});

test("lists customer data first and IDs and tokens under Technical", () => {
  render(
    <Harness
      templateComponents={[{ type: "BODY", text: "Hello {{1}}" }]}
      initial={{
        version: 1,
        parameters: { "body:1": { source: "context", key: "first_name" } },
      }}
    />
  );
  const groups = screen.getAllByTestId("select-group");
  expect(
    groups.map(
      group => within(group).getByTestId("select-label").firstChild?.textContent
    )
  ).toEqual([
    "whatsappTemplateBindingContext",
    "whatsappTemplateBindingTechnical",
    "whatsappTemplateBindingsCartGroup",
  ]);
  expect(
    within(groups[0]!)
      .getAllByRole("button")
      .map(item => item.textContent)
  ).toEqual([
    "variableFieldFirstName",
    "variableFieldLastName",
    "variableFieldFullName",
    "variableFieldPhone",
    "variableFieldLanguage",
  ]);
  expect(
    within(groups[1]!).getByRole("button", {
      name: "whatsappTemplateContextChatId",
    })
  ).toBeInTheDocument();
  expect(within(groups[2]!).getByTestId("select-label")).toHaveTextContent(
    "whatsappTemplateBindingsCartHint"
  );
});

test("explains why Customer answer is unavailable inside the menu", () => {
  render(
    <Harness
      templateComponents={[{ type: "BODY", text: "Hello {{1}}" }]}
      promptInputs={[]}
      initial={{ version: 1, parameters: {} }}
    />
  );
  const item = screen.getByRole("button", {
    name: /^whatsappTemplateBindingPromptInput/,
  });
  expect(item).toBeDisabled();
  expect(item).toHaveTextContent("whatsappTemplateBindingsNoInputs");
  expect(screen.getAllByText("whatsappTemplateBindingsNoInputs")).toHaveLength(
    1
  );
});

test("names the link a URL variable completes", () => {
  render(
    <Harness
      initial={{
        version: 1,
        parameters: { "button:0:1": { source: "literal", value: "x" } },
      }}
    />
  );
  expect(
    screen.getByText(
      'whatsappTemplateBindingUrlHint:{"url":"https://example.com/track/{{1}}"}'
    )
  ).toBeInTheDocument();
});

test("labels the context key picker for its source", () => {
  render(
    <Harness
      templateComponents={[{ type: "BODY", text: "Hello {{1}}" }]}
      initial={{
        version: 1,
        parameters: { "body:1": { source: "context", key: "first_name" } },
      }}
    />
  );
  expect(screen.getByTestId("template-binding-context-body:1")).toHaveAttribute(
    "aria-label",
    expect.stringMatching(/: whatsappTemplateBindingContext$/)
  );
  expect(
    screen.queryByTestId("template-binding-input-body:1")
  ).not.toBeInTheDocument();
});

test("switches between prior answers from the collected-answer picker", () => {
  const onChange = jest.fn();
  render(
    <Harness
      onChange={onChange}
      templateComponents={[{ type: "BODY", text: "Hello {{1}}" }]}
      promptInputs={[
        { key: "reference", label: "Customer reference", prompt: "Reference" },
        { key: "status", label: "Status", prompt: "Status" },
      ]}
      initial={{
        version: 1,
        parameters: { "body:1": { source: "prompt_input", key: "reference" } },
      }}
    />
  );
  expect(screen.getByTestId("template-binding-input-body:1")).toHaveAttribute(
    "aria-label",
    expect.stringMatching(/: whatsappTemplateBindingPromptInput$/)
  );
  expect(
    screen.queryByTestId("template-binding-context-body:1")
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Status" }));
  expect(onChange).toHaveBeenLastCalledWith({
    version: 1,
    parameters: { "body:1": { source: "prompt_input", key: "status" } },
  });
});

test("keeps a removed collected answer visible but not selectable", () => {
  render(
    <Harness
      templateComponents={[{ type: "BODY", text: "Hello {{1}}" }]}
      initial={{
        version: 1,
        parameters: { "body:1": { source: "prompt_input", key: "removed" } },
      }}
    />
  );
  expect(screen.getByRole("button", { name: "removed" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Customer reference" })
  ).toBeEnabled();
});

test("previews independently bound carousel card values", () => {
  render(
    <Harness
      templateComponents={[
        { type: "BODY", text: "Updates" },
        {
          type: "CAROUSEL",
          cards: [
            { components: [{ type: "BODY", text: "First {{1}}" }] },
            { components: [{ type: "BODY", text: "Second {{1}}" }] },
          ],
        },
      ]}
      initial={{
        version: 1,
        parameters: {
          "card:0:body:1": { source: "literal", value: "A123" },
          "card:1:body:1": { source: "literal", value: "B456" },
        },
      }}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappTemplateBindingsPreview" })
  );
  expect(
    screen
      .getAllByTestId("resolved-message")
      .map(message => message.textContent)
  ).toEqual(["|Updates|", "|First A123|", "|Second B456|"]);
});

test("shows stale values of a template without variables until Reset clears them", () => {
  const onChange = jest.fn();
  render(
    <Harness
      onChange={onChange}
      templateComponents={[{ type: "BODY", text: "Delivered" }]}
      initial={{
        version: 1,
        parameters: { "body:1": { source: "literal", value: "obsolete" } },
      }}
    />
  );
  const notice = screen.getByTestId("template-bindings-stale");
  expect(notice).toHaveTextContent("whatsappTemplateBindingsStale");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(
    within(notice).getByRole("button", {
      name: "whatsappTemplateBindingsReset",
    })
  );
  expect(onChange).toHaveBeenLastCalledWith({ version: 1, parameters: {} });
  expect(
    screen.queryByRole("button", { name: "whatsappTemplateBindingsReset" })
  ).not.toBeInTheDocument();
});

test("shows stale values next to the current variables", () => {
  const onChange = jest.fn();
  render(
    <Harness
      onChange={onChange}
      templateComponents={[{ type: "BODY", text: "Hello {{1}}" }]}
      initial={{
        version: 1,
        parameters: {
          "body:1": { source: "literal", value: "Ann" },
          "body:2": { source: "literal", value: "old" },
        },
      }}
    />
  );
  expect(screen.getByTestId("template-bindings-stale")).toBeInTheDocument();
  expect(screen.getByTestId("template-binding-value-body:1")).toHaveValue(
    "Ann"
  );
  expect(onChange).not.toHaveBeenCalled();
});

describe("on the legacy canvas card", () => {
  test("opens while a variable is unset and summarizes what is set", () => {
    render(
      <Harness
        collapsible
        templateComponents={[{ type: "BODY", text: "Hi {{1}} {{2}}" }]}
        initial={{
          version: 1,
          parameters: { "body:1": { source: "literal", value: "Ann" } },
        }}
      />
    );
    expect(
      screen.getByRole("button", { name: "whatsappTemplateBindingsTitle" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("template-binding-value-body:1")).toBeVisible();
  });

  test("stays closed with a summary when every variable is set", () => {
    render(
      <Harness
        collapsible
        templateComponents={[{ type: "BODY", text: "Hi {{1}}" }]}
        initial={{
          version: 1,
          parameters: { "body:1": { source: "literal", value: "Ann" } },
        }}
      />
    );
    expect(
      screen.getByRole("button", {
        name: "whatsappTemplateBindingsTitle",
        hidden: true,
      })
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByText('whatsappTemplateBindingsSummary:{"set":1,"total":1}')
    ).toBeInTheDocument();
    // Fields stay mounted so validation can find them.
    expect(
      screen.getByTestId("template-binding-value-body:1")
    ).not.toBeVisible();
  });

  test("counts visible row errors on the section header", () => {
    render(
      <Harness
        collapsible
        templateComponents={[{ type: "BODY", text: "Hi {{1}}" }]}
        initial={{
          version: 1,
          parameters: { "body:1": { source: "literal", value: " " } },
        }}
      />
    );
    expect(
      screen.getByTestId("scenario-collapsible-error-count")
    ).toHaveTextContent("1");
  });
});

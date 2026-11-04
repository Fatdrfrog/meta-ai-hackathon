/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { buildOrderFormFlowConfig } from "@/lib/products/order-form-config";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TextEncoder } from "node:util";
import { ProductOrderFormEditor } from "./product-order-form-editor";

// jsdom has no TextEncoder; the form's size check reads bytes with it, as browsers do.
globalThis.TextEncoder ??= TextEncoder as typeof globalThis.TextEncoder;

// "Edit questions" hands airi's own Flow editor a kit's order form. The
// editor stands in as its props here; its own suite covers what they do.

const mockFlowEditor: {
  props: Record<string, unknown> | null;
  change: ((config: WhatsAppFlowConfig) => void) | null;
} = { props: null, change: null };

jest.mock("@/components/scenarios/builders/whatsapp/field-editor", () => ({
  ...jest.requireActual(
    "@/components/scenarios/builders/whatsapp/field-editor"
  ),
  FlowFormEditorContent: (props: {
    onChange: (config: WhatsAppFlowConfig) => void;
    renderPreview: (screenId: string) => React.ReactNode;
    flowConfig: WhatsAppFlowConfig;
  }) => {
    mockFlowEditor.props = props;
    mockFlowEditor.change = props.onChange;
    return (
      <div data-testid="flow-editor">
        {props.renderPreview(props.flowConfig.screens[0]!.id)}
      </div>
    );
  },
}));

jest.mock("@/components/ai/airi-builder-intl-provider", () => ({
  AiriBuilderIntlProvider: ({
    locale,
    children,
  }: {
    locale?: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="intl" data-locale={locale}>
      {children}
    </div>
  ),
}));

const products = [
  {
    id: "651f1f77bcf86cd799439011",
    name: "Кукла Лол",
    price: 5000,
    currency: "KZT",
    priceIsFrom: false,
  },
  {
    id: "651f1f77bcf86cd799439012",
    name: "Кружка",
    price: 3500,
    currency: "KZT",
    priceIsFrom: false,
  },
];
const productIds = products.map(product => product.id);
const shelfForm = buildOrderFormFlowConfig(products, "kk");

function renderEditor(onSave = jest.fn()) {
  render(
    <ProductOrderFormEditor
      initialConfig={shelfForm}
      language="kk"
      productIds={productIds}
      note="Nothing goes to WhatsApp until you press Make."
      submitLabel="Save changes"
      onSave={onSave}
      onCancel={jest.fn()}
    />
  );
  return onSave;
}

test("opens airi's Flow editor in English, its products question locked, Paper's form as preview", () => {
  renderEditor();

  expect(screen.getByTestId("intl")).toHaveAttribute("data-locale", "en");
  expect(mockFlowEditor.props).toMatchObject({
    authoringContext: "manager",
    fillAvailableHeight: true,
    protectedFieldIds: ["products"],
    flowConfig: shelfForm,
  });
  // The preview is the Products form screen, in the buyers' language.
  expect(screen.getByText("Не алғыңыз келеді? *")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Each option of the products question is a product on your shelf, so it stays linked: rename it freely. Add or remove products with Change on the Make page."
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText("Nothing goes to WhatsApp until you press Make.")
  ).toBeInTheDocument();
});

test("saves questions that pass the checks", () => {
  const onSave = renderEditor();
  const renamed: WhatsAppFlowConfig = {
    ...shelfForm,
    screens: shelfForm.screens.map((screen, index) =>
      index === 0 ? { ...screen, title: "Тапсырыс беріңіз" } : screen
    ),
  };
  fireEvent.click(screen.getByText("Save changes"));
  expect(onSave).toHaveBeenLastCalledWith(shelfForm);

  // An edit the editor reports is what gets saved.
  act(() => mockFlowEditor.change!(renamed));
  fireEvent.click(screen.getByText("Save changes"));
  expect(onSave).toHaveBeenLastCalledWith(renamed);
});

test("refuses questions that fail the checks, saying the first problem", () => {
  const onSave = renderEditor();
  const foreign: WhatsAppFlowConfig = {
    ...shelfForm,
    screens: shelfForm.screens.map((screen, index) =>
      index === 0
        ? {
            ...screen,
            fields: screen.fields.map(field =>
              field.id === "products"
                ? {
                    ...field,
                    options: [
                      ...(field.options ?? []),
                      { id: "651f1f77bcf86cd799439099", title: "Not mine" },
                    ],
                  }
                : field
            ),
          }
        : screen
    ),
  };
  act(() => mockFlowEditor.change!(foreign));

  fireEvent.click(screen.getByText("Save changes"));

  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).not.toBeEmptyDOMElement();
});

test("shows why the caller couldn't publish, and waits while it does", () => {
  render(
    <ProductOrderFormEditor
      initialConfig={shelfForm}
      language="kk"
      productIds={productIds}
      note="It's published on WhatsApp when you press Publish."
      submitLabel="Publish"
      busy
      error="Meta refused it."
      onSave={jest.fn()}
      onCancel={jest.fn()}
    />
  );

  expect(screen.getByRole("alert")).toHaveTextContent("Meta refused it.");
  expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
});

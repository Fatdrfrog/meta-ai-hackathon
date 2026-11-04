/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ProductCarouselEditor } from "./product-carousel-editor";

// "Edit cards" hands airi's own template editor a kit's carousel. The editor
// stands in as its props here; its own suite covers what they do.

const mockEditorProps: Array<Record<string, unknown>> = [];

jest.mock("@/components/whatsapp-templates/template-editor-form", () => ({
  TemplateEditorForm: (props: Record<string, unknown>) => {
    mockEditorProps.push(props);
    return <div data-testid="template-editor" />;
  },
}));

// The builders' catalogs (templates and Scenarios), downloaded in a locale.
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

const prefill = {
  name: "products_20261103_101500",
  language: "kk" as const,
  components: [{ type: "BODY" as const, text: "Жаңа тауарлар келді!" }],
};

function renderEditor(next = prefill) {
  return (
    <ProductCarouselEditor
      workspaceId="workspace-1"
      prefill={next}
      draftScope="products:session-1"
      submitLabel="Save changes"
      onCreate={jest.fn()}
      onSaved={jest.fn()}
      onCancel={jest.fn()}
    />
  );
}

beforeEach(() => {
  mockEditorProps.length = 0;
});

test("opens airi's template editor in English, as a carousel the kit decides", () => {
  render(renderEditor());

  // The English catalogs, whatever the page's language.
  expect(screen.getByTestId("intl")).toHaveAttribute("data-locale", "en");
  expect(mockEditorProps.at(-1)).toMatchObject({
    workspaceId: "workspace-1",
    layout: "modal",
    platformScope: "whatsapp",
    draftScope: "products:session-1",
    submitLabel: "Save changes",
    fixedShape: { category: "MARKETING", layout: "carousel", language: "kk" },
    template: {
      name: "products_20261103_101500",
      language: "kk",
      category: "MARKETING",
      status: "PENDING",
      components: prefill.components,
    },
  });
  // A new template: no id, so the editor creates rather than updates.
  expect(mockEditorProps.at(-1)!.template).not.toHaveProperty("id");
});

test("keeps one template object across re-renders, so the editor never starts over", () => {
  const view = render(renderEditor());
  const first = mockEditorProps.at(-1)!.template;

  // The kit's polling re-renders the sheet with the same prefill.
  view.rerender(renderEditor());
  view.rerender(renderEditor());
  expect(mockEditorProps.at(-1)!.template).toBe(first);
  expect(mockEditorProps.at(-1)!.fixedShape).toBe(
    mockEditorProps[0]!.fixedShape
  );

  // A new source (saved edits) is a new template.
  view.rerender(renderEditor({ ...prefill, name: "my_cards" }));
  expect(mockEditorProps.at(-1)!.template).not.toBe(first);
});

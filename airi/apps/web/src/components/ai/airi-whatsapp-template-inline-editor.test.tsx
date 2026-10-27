/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";

let mockActionRendererProps: Record<string, unknown> | undefined;
const mockToastError = jest.fn();
let mockLocale = "en";
let mockSubmitOnClick: (() => void) | undefined;

jest.mock("@/components/ui/button", () => {
  const actual = jest.requireActual("@/components/ui/button");
  return {
    ...actual,
    Button: (props: Record<string, unknown>) => {
      if (Array.isArray(props.children) && props.children.includes("Submit")) {
        mockSubmitOnClick = props.onClick as () => void;
      }
      return <actual.Button {...props} />;
    },
  };
});

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    const messages = jest.requireActual(
      `../../../messages/templates/${mockLocale}/page.json`
    );
    return `${namespace}.${key}`
      .split(".")
      .reduce<unknown>(
        (current, part) => (current as Record<string, unknown>)[part],
        messages
      );
  },
}));

jest.mock("@/components/scenarios/builders/whatsapp/action-renderer", () => ({
  WhatsAppActionRenderer: (props: Record<string, unknown>) => {
    mockActionRendererProps = props;
    return <div data-testid="whatsapp-action-renderer" />;
  },
}));

jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), {
    error: (...args: unknown[]) => mockToastError(...args),
    success: jest.fn(),
  }),
}));

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT } from "./airi-builder-defaults";
import { AiriWhatsAppTemplateInlineEditor } from "./airi-whatsapp-template-inline-editor";

describe("AiriWhatsAppTemplateInlineEditor", () => {
  beforeEach(() => {
    mockToastError.mockReset();
    mockLocale = "en";
    mockSubmitOnClick = undefined;
  });

  it("rejects programmatic authentication submission before the API call", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    const onSaved = jest.fn();
    try {
      render(
        <AiriWhatsAppTemplateInlineEditor
          workspaceId="workspace-1"
          artifactId="artifact-1"
          templateDraft={{
            ...DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT,
            category: "AUTHENTICATION",
          }}
          onTemplateDraftChange={jest.fn()}
          onSaved={onSaved}
        />
      );
      expect(mockSubmitOnClick).toBeDefined();
      await act(async () => {
        mockSubmitOnClick?.();
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      expect(mockToastError).toHaveBeenCalledWith(
        "Authentication templates use Meta's verification-code preset. Create one in WhatsApp Manager; custom message text cannot be submitted from this editor."
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    ["en", "Open WhatsApp Manager"],
    ["ru", "Открыть WhatsApp Manager"],
    ["kz", "WhatsApp Manager ашу"],
  ])(
    "routes an authentication draft to the preset editor in %s",
    (locale, label) => {
      mockLocale = locale;
      const onChange = jest.fn();
      const onSaved = jest.fn();
      render(
        <AiriWhatsAppTemplateInlineEditor
          workspaceId="workspace-1"
          artifactId="artifact-1"
          templateDraft={{
            ...DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT,
            category: "AUTHENTICATION",
          }}
          onTemplateDraftChange={onChange}
          onSaved={onSaved}
        />
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        locale === "en"
          ? "verification-code preset"
          : locale === "ru"
            ? "кода подтверждения"
            : "растау коды"
      );
      expect(screen.getByRole("link", { name: label })).toHaveAttribute(
        "href",
        "/panel/w/workspace-1/messengers/whatsapp-templates"
      );
      expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
      expect(onSaved).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(
        screen.getByRole("combobox", { name: "Template category" })
      ).toHaveValue("AUTHENTICATION");
    }
  );

  it.each(["MARKETING", "UTILITY"] as const)(
    "keeps %s submissions available after leaving authentication",
    async category => {
      const originalFetch = globalThis.fetch;
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({}) });
      globalThis.fetch = fetchMock;
      const onSaved = jest.fn();
      const props = {
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
        onTemplateDraftChange: jest.fn(),
        onSaved,
      };
      try {
        const { rerender } = render(
          <AiriWhatsAppTemplateInlineEditor
            {...props}
            templateDraft={{
              ...DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT,
              category: "AUTHENTICATION",
            }}
          />
        );
        rerender(
          <AiriWhatsAppTemplateInlineEditor
            {...props}
            templateDraft={{ ...DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT, category }}
          />
        );
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
        fireEvent.click(screen.getByRole("button", { name: "Submit" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/workspaces/workspace-1/airi-artifacts/artifact-1/submit",
          { method: "POST", headers: { "Content-Type": "application/json" } }
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );

  it("owns preview fallback labels outside the scenarios translation scope", () => {
    render(
      <AiriWhatsAppTemplateInlineEditor
        workspaceId="workspace-1"
        templateDraft={DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT}
        onTemplateDraftChange={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    expect(screen.getByTestId("whatsapp-action-renderer")).toBeInTheDocument();
    expect(mockActionRendererProps?.buttonLabelPlaceholder).toBe(
      "Button label"
    );
    expect(mockActionRendererProps?.ctaFallbackLabel).toBe(
      "Select a WhatsApp Flow"
    );
  });

  it("shows an existing location header without a file picker and preserves it on edits", () => {
    const onChange = jest.fn();
    const { container } = render(
      <AiriWhatsAppTemplateInlineEditor
        workspaceId="workspace-1"
        templateDraft={{
          ...DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT,
          components: [
            { type: "HEADER", format: "LOCATION" },
            { type: "BODY", text: "Explore the sample pin" },
          ],
        }}
        onTemplateDraftChange={onChange}
        onSaved={jest.fn()}
      />
    );
    expect(screen.getByRole("combobox", { name: "Header type" })).toHaveValue(
      "LOCATION"
    );
    expect(container.querySelector('input[type="file"]')).toBeNull();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Template language" }),
      { target: { value: "ru" } }
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [
          { type: "HEADER", format: "LOCATION" },
          { type: "BODY", text: "Explore the sample pin" },
        ],
      })
    );
  });

  it("shows English text, not a catalog key, for an invalid template", () => {
    render(
      <AiriWhatsAppTemplateInlineEditor
        workspaceId="workspace-1"
        templateDraft={{
          ...DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT,
          components: [{ type: "BODY", text: "" }],
        }}
        onTemplateDraftChange={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(mockToastError).toHaveBeenCalledWith("Add message text");
  });

  describe("variable samples", () => {
    const namedDraft = {
      ...DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT,
      components: [
        { type: "HEADER" as const, format: "TEXT" as const, text: "Sale" },
        {
          type: "BODY" as const,
          text: "Hi {{name}}, thanks for your interest.",
          example: {
            body_text_named_params: [{ param_name: "name", example: "Pablo" }],
          },
        },
      ],
    };

    function editText(
      field: "onBodyTextChange" | "onHeaderTextChange",
      value: string
    ) {
      const onTemplateDraftChange = jest.fn();
      render(
        <AiriWhatsAppTemplateInlineEditor
          workspaceId="workspace-1"
          templateDraft={namedDraft}
          onTemplateDraftChange={onTemplateDraftChange}
          onSaved={jest.fn()}
        />
      );
      act(() => {
        (mockActionRendererProps?.[field] as (text: string) => void)(value);
      });
      const [draft] = onTemplateDraftChange.mock.calls[0] as [
        { components: Array<{ type: string }> },
      ];
      return draft.components;
    }

    it("writes named body samples and keeps the ones the draft has", () => {
      const components = editText(
        "onBodyTextChange",
        "Hi {{name}}, order {{order_id}} is ready."
      );

      expect(components.find(item => item.type === "BODY")).toEqual({
        type: "BODY",
        text: "Hi {{name}}, order {{order_id}} is ready.",
        example: {
          body_text_named_params: [
            { param_name: "name", example: "Pablo" },
            { param_name: "order_id", example: "order_id_example" },
          ],
        },
      });
    });

    it("drops the body sample once the variables are gone", () => {
      const components = editText(
        "onBodyTextChange",
        "Thanks for your interest."
      );

      expect(components.find(item => item.type === "BODY")).toEqual({
        type: "BODY",
        text: "Thanks for your interest.",
      });
    });

    it("writes named header samples", () => {
      const components = editText("onHeaderTextChange", "Sale for {{name}}");

      expect(components.find(item => item.type === "HEADER")).toEqual({
        type: "HEADER",
        format: "TEXT",
        text: "Sale for {{name}}",
        example: {
          header_text_named_params: [{ param_name: "name", example: "Pablo" }],
        },
      });
    });
  });
});

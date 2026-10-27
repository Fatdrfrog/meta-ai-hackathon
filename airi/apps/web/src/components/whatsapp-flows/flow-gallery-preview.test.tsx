/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { FlowGalleryPreview } from "./flow-gallery-preview";
import { projectFlowJsonPreview } from "@/components/scenarios/builders/whatsapp/flow-json-preview";
import {
  META_STARTER_FLOW_JSON,
  DEMOSHOP_FLOW_JSON,
} from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}));

it.each(["visual", "document"] as const)(
  "renders the Meta starter once in a %s thumbnail",
  kind => {
    const preview = projectFlowJsonPreview(META_STARTER_FLOW_JSON)!;
    const { container } = render(
      <FlowGalleryPreview
        model={
          kind === "visual"
            ? { kind, config: preview.config }
            : { kind, preview }
        }
      />
    );
    expect(screen.getAllByText("Hello World")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Hello World", level: 4 })
    ).toBeTruthy();
    expect(screen.getAllByText("Let's start building things!")).toHaveLength(1);
    expect(screen.getByText("Complete")).toBeTruthy();
    expect(screen.queryByText("advancedTitle")).toBeNull();
    expect(container.querySelector("input, select, textarea")).toBeNull();
  }
);

it("keeps all four text types distinct in canonical thumbnail order", () => {
  const { container } = render(
    <FlowGalleryPreview
      model={{
        kind: "visual",
        config: {
          templateId: "custom",
          ctaText: "Open",
          flowNavigationMode: "static_graph",
          screens: [
            {
              id: "START",
              title: "Text",
              fields: [],
              layoutContent: [
                {
                  kind: "text",
                  id: "heading",
                  type: "TextHeading",
                  text: "Heading",
                },
                {
                  kind: "text",
                  id: "subheading",
                  type: "TextSubheading",
                  text: "Subheading",
                },
                { kind: "text", id: "body", type: "TextBody", text: "Body" },
                {
                  kind: "text",
                  id: "caption",
                  type: "TextCaption",
                  text: "Caption",
                },
              ],
            },
          ],
        },
      }}
    />
  );
  expect(
    screen.getByRole("heading", { name: "Heading", level: 4 })
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Subheading", level: 5 })
  ).toBeTruthy();
  expect(screen.getByText("Body").tagName).toBe("P");
  expect(screen.getByText("Caption").className).toContain("text-xs");
  const content = screen.getByText("Heading").parentElement!;
  expect(Array.from(content.children).map(child => child.textContent)).toEqual([
    "Heading",
    "Subheading",
    "Body",
    "Caption",
  ]);
  expect(container.querySelector("input, select, textarea")).toBeNull();
});

it("preserves text/input ordering and counts fields omitted by the thumbnail budget", () => {
  render(
    <FlowGalleryPreview
      model={{
        kind: "visual",
        config: {
          templateId: "custom",
          ctaText: "Open",
          screens: [
            {
              id: "START",
              title: "Contact",
              fields: ["first", "last", "email", "city"].map(id => ({
                id,
                label: id,
                fieldType: "TextInput" as const,
              })),
              layoutContent: [
                {
                  kind: "text",
                  id: "intro",
                  type: "TextHeading",
                  text: "Details",
                },
                { kind: "field", fieldId: "first" },
                {
                  kind: "text",
                  id: "body",
                  type: "TextBody",
                  text: "About you",
                },
                { kind: "field", fieldId: "last" },
                { kind: "field", fieldId: "email" },
                { kind: "field", fieldId: "city" },
              ],
            },
          ],
        },
      }}
    />
  );
  const content = screen.getByText("Details").parentElement!;
  expect(
    Array.from(content.children)
      .slice(0, 4)
      .map(child => child.textContent)
  ).toEqual([
    "Details",
    "firstflowFieldSampleAnswer",
    "About you",
    "lastflowFieldSampleAnswer",
  ]);
  expect(screen.getByText("moreFields:2")).toBeTruthy();
  expect(screen.queryByText("email")).toBeNull();
});

it("keeps unsupported text settings notices visible beyond the thumbnail content budget", () => {
  const preview = projectFlowJsonPreview({
    screens: [
      {
        id: "START",
        title: "Text",
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextHeading", text: "Heading" },
            { type: "TextSubheading", text: "Subheading" },
            { type: "TextBody", text: "Body" },
            { type: "TextCaption", text: "Caption", "font-weight": "bold" },
          ],
        },
      },
    ],
  })!;
  render(<FlowGalleryPreview model={{ kind: "document", preview }} />);
  expect(screen.getByText("Caption")).toBeTruthy();
  expect(
    screen.getByText("simulationUnsupportedComponent:TextCaption settings")
  ).toBeTruthy();
});

const config: WhatsAppFlowConfig = {
  templateId: "custom",
  ctaText: "Open form",
  headerText: "Request a quote",
  bodyText: "Tell us what you need",
  footerText: "We will contact you",
  flowSubmitLabel: "Send request",
  screens: [
    {
      id: "CONTACT",
      title: "Your details",
      fields: [
        {
          id: "name",
          label: "Your name {{customer.first}}",
          fieldType: "TextInput",
          required: true,
          helperText: "Use your full name",
        },
        {
          id: "product",
          label: "Product",
          fieldType: "Dropdown",
          options: [
            { id: "bike", title: "Bicycle" },
            { id: "car", title: "Car" },
            { id: "boat", title: "Boat" },
          ],
        },
        {
          id: "plan",
          label: "Plan",
          fieldType: "RadioButtonsGroup",
          options: [
            { id: "basic", title: "Basic" },
            { id: "plus", title: "Plus" },
            { id: "premium", title: "Premium" },
          ],
        },
        {
          id: "extras",
          label: "Extras",
          fieldType: "CheckboxGroup",
          options: [
            { id: "delivery", title: "Delivery" },
            { id: "assembly", title: "Assembly" },
            { id: "cover", title: "Protective cover" },
          ],
        },
        { id: "date", label: "Delivery date", fieldType: "DatePicker" },
        { id: "notes", label: "Notes", fieldType: "TextArea" },
      ],
    },
    {
      id: "ADDRESS",
      title: "Delivery address",
      fields: [
        {
          id: "address",
          label: "Street address",
          fieldType: "TextArea",
          helperText: "Include your apartment number",
        },
      ],
    },
  ],
};

it("shows actual NavigationList rows, descriptions and screen-specific footers as static thumbnails", () => {
  const preview = projectFlowJsonPreview(DEMOSHOP_FLOW_JSON)!;
  const { container } = render(
    <FlowGalleryPreview model={{ kind: "document", preview }} />
  );
  expect(screen.getByText("Football, basketball")).toBeTruthy();
  expect(screen.getByText("Other sport")).toBeTruthy();
  expect(screen.getByText("Write your sport")).toBeTruthy();
  expect(screen.queryByText("Send")).toBeNull();
  expect(container.querySelector("input, select, textarea")).toBeNull();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Design and name" })[0]
  );
  expect(screen.getByText("With the athlete's name")).toBeTruthy();
  expect(screen.getByText("Write every name")).toBeTruthy();
  expect(screen.getByText("Send")).toBeTruthy();
});

it("keeps an internal NavigationList field name out of a customer thumbnail", () => {
  const preview = projectFlowJsonPreview(DEMOSHOP_FLOW_JSON)!;
  preview.config.screens[0].fields[0].label = "sport_list";
  render(
    <FlowGalleryPreview model={{ kind: "visual", config: preview.config }} />
  );
  expect(screen.getByRole("heading", { name: "Choose a sport" })).toBeTruthy();
  expect(screen.queryByText("sport_list")).toBeNull();
});

it("keeps supported content visible beside a local unsupported-component notice", () => {
  const preview = projectFlowJsonPreview({
    version: "7.3",
    screens: [
      {
        id: "START",
        title: "Partial flow",
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextBody", text: "Useful content" },
            { type: "Image", src: "https://example.test/private" },
            { type: "TextInput", name: "name", label: "Your name" },
          ],
        },
      },
    ],
  })!;
  const { container } = render(
    <FlowGalleryPreview model={{ kind: "document", preview }} />
  );
  expect(screen.getByText("Useful content")).toBeTruthy();
  expect(screen.getByText("simulationUnsupportedComponent:Image")).toBeTruthy();
  expect(screen.getByText("Your name")).toBeTruthy();
  expect(screen.queryByText("advancedTitle")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
});

it("renders actual text, helpers, options and submit label with bounded content", () => {
  const { container } = render(
    <FlowGalleryPreview model={{ kind: "visual", config }} />
  );

  expect(screen.getByRole("heading", { name: "Your details" })).toBeTruthy();
  for (const text of [
    "Request a quote",
    "Tell us what you need",
    "We will contact you",
    "Your name {{customer.first}}",
    "Use your full name",
    "Basic",
    "Plus",
    "Delivery",
    "Assembly",
    "Send request",
    "required",
    "moreFields:2",
  ]) {
    expect(screen.getByText(text)).toBeTruthy();
  }
  for (const text of [
    "Bicycle",
    "Car",
    "Boat",
    "Premium",
    "Protective cover",
    "Delivery date",
    "Notes",
  ]) {
    expect(screen.queryByText(text)).toBeNull();
  }
  expect(screen.getAllByText("moreOptions:1")).toHaveLength(2);
  expect(
    container.querySelector(
      "input, select, textarea, [contenteditable='true'], [role='combobox']"
    )
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Send request" })).toBeNull();
  const mobileSurface = screen.getByRole("region", { name: "Your details" });
  expect(
    mobileSurface.contains(screen.getByText("Your name {{customer.first}}"))
  ).toBe(true);
  expect(mobileSurface.contains(screen.getByText("Request a quote"))).toBe(
    false
  );
  expect(screen.getByText("Send request").style.backgroundColor).toBe(
    "rgb(27, 135, 85)"
  );
});

it("switches screens through actual title buttons without collecting answers", () => {
  render(<FlowGalleryPreview model={{ kind: "visual", config }} />);
  expect(
    screen
      .getByRole("button", { name: "Your details" })
      .getAttribute("aria-pressed")
  ).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Delivery address" }));

  expect(
    screen
      .getByRole("button", { name: "Delivery address" })
      .getAttribute("aria-pressed")
  ).toBe("true");
  expect(
    screen.getByRole("heading", { name: "Delivery address" })
  ).toBeTruthy();
  expect(screen.getByText("Street address")).toBeTruthy();
  expect(screen.getByText("Include your apartment number")).toBeTruthy();
  expect(screen.queryByText("Use your full name")).toBeNull();
});

it("falls back safely when the selected screen disappears", () => {
  const { rerender } = render(
    <FlowGalleryPreview model={{ kind: "visual", config }} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Delivery address" }));

  rerender(
    <FlowGalleryPreview
      model={{
        kind: "visual",
        config: { ...config, screens: [config.screens[0]] },
      }}
    />
  );

  expect(screen.getByRole("heading", { name: "Your details" })).toBeTruthy();
});

it("shows honest advanced JSON screen summaries without invented fields", () => {
  const { container } = render(
    <FlowGalleryPreview
      model={{
        kind: "advanced",
        screens: [
          { id: "VERIFY", title: "Identity verification" },
          { id: "QUOTE", title: "Personal quote" },
        ],
      }}
    />
  );

  expect(screen.getByText("advancedTitle")).toBeTruthy();
  expect(screen.getByText("advancedDescription")).toBeTruthy();
  expect(screen.getByText("screenCount:2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Personal quote" }));
  expect(screen.getByRole("heading", { name: "Personal quote" })).toBeTruthy();
  expect(screen.getByText("QUOTE")).toBeTruthy();
  expect(container.querySelector("input, select, textarea")).toBeNull();
  expect(screen.queryByText("flowFieldSampleAnswer")).toBeNull();
});

it.each([
  ["missing", ""],
  ["duplicate", "SHARED"],
  ["clipped", `${"SCREEN_".repeat(24).slice(0, 160)}…`],
])("switches advanced screens with %s display IDs independently", (_, id) => {
  const consoleError = jest
    .spyOn(console, "error")
    .mockImplementation(() => {});
  try {
    render(
      <FlowGalleryPreview
        model={{
          kind: "advanced",
          screens: [
            { id, title: "First screen" },
            { id, title: "Second screen" },
          ],
        }}
      />
    );
    const first = screen.getByRole("button", { name: "First screen" });
    const second = screen.getByRole("button", { name: "Second screen" });
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(second);

    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { name: "Second screen" })).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

it("renders an empty draft and an empty visual document safely", () => {
  const { rerender } = render(<FlowGalleryPreview model={{ kind: "empty" }} />);
  expect(screen.getByText("emptyTitle")).toBeTruthy();
  expect(screen.getByText("emptyDescription")).toBeTruthy();

  rerender(
    <FlowGalleryPreview
      model={{ kind: "visual", config: { ...config, screens: [] } }}
    />
  );
  expect(screen.getByText("emptyTitle")).toBeTruthy();
});

it("renders loading and retry states without stale content", () => {
  const retry = jest.fn();
  const { rerender } = render(<FlowGalleryPreview model={null} loading />);
  expect(screen.getByRole("status").textContent).toContain("loading");

  rerender(
    <FlowGalleryPreview
      model={{ kind: "visual", config }}
      error="Network unavailable"
      onRetry={retry}
    />
  );
  expect(screen.getByText("Network unavailable")).toBeTruthy();
  expect(screen.queryByText("Use your full name")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

it("keeps long screen titles discoverable without stretching the card", () => {
  const title = "Very long delivery information ".repeat(12);
  render(
    <FlowGalleryPreview
      model={{ kind: "advanced", screens: [{ id: "LONG", title }] }}
    />
  );
  expect(
    screen.getByRole("button", { name: title.trim() }).getAttribute("title")
  ).toBe(title);
});

it("reports the actual total when advanced screen summaries are capped", () => {
  render(
    <FlowGalleryPreview
      model={{
        kind: "advanced",
        screens: [{ id: "START", title: "Welcome" }],
        totalScreens: 84,
      }}
    />
  );
  expect(screen.getByText("screenCount:84")).toBeTruthy();
});

it("keeps an advanced document distinct from an empty draft when no screen can be summarized", () => {
  render(
    <FlowGalleryPreview
      model={{ kind: "advanced", screens: [], totalScreens: 3 }}
    />
  );
  expect(screen.getByText("advancedTitle")).toBeTruthy();
  expect(screen.getByText("advancedDescription")).toBeTruthy();
  expect(screen.getByText("screenCount:3")).toBeTruthy();
  expect(screen.queryByText("emptyTitle")).toBeNull();
});

it("reuses static date and long-answer shapes without form controls", () => {
  const { container } = render(
    <FlowGalleryPreview
      model={{
        kind: "visual",
        config: {
          ...config,
          screens: [
            { ...config.screens[0], fields: config.screens[0].fields.slice(4) },
          ],
        },
      }}
    />
  );
  expect(screen.getByText("Delivery date")).toBeTruthy();
  expect(screen.getByText("Notes")).toBeTruthy();
  expect(screen.getByText("flowFieldSampleDate")).toBeTruthy();
  expect(container.querySelector("input, select, textarea")).toBeNull();
});

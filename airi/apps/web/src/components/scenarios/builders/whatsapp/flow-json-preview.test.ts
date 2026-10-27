import {
  META_STARTER_FLOW_JSON,
  DEMOSHOP_FLOW_JSON,
} from "./flow-json-fixtures";
import { projectFlowJsonPreview } from "./flow-json-preview";

it("projects the Meta starter into ordered canonical text without answer fields", () => {
  const before = JSON.stringify(META_STARTER_FLOW_JSON);
  const preview = projectFlowJsonPreview(META_STARTER_FLOW_JSON)!;
  const welcome = preview.config.screens[0];
  expect(welcome.success).toBe(true);
  expect(welcome.fields).toEqual([]);
  expect(welcome.layoutContent).toEqual([
    { kind: "text", id: "text_0", type: "TextHeading", text: "Hello World" },
    {
      kind: "text",
      id: "text_1",
      type: "TextBody",
      text: "Let's start building things!",
    },
  ]);
  expect(preview.componentsByScreen.WELCOME_SCREEN).toEqual(
    welcome.layoutContent
  );
  expect(welcome.footer?.action).toEqual({ name: "complete", payload: {} });
  expect(JSON.stringify(META_STARTER_FLOW_JSON)).toBe(before);
});

it("retains four distinct text types and field order, with notices for unsupported text settings", () => {
  const preview = projectFlowJsonPreview({
    version: "7.3",
    screens: [
      {
        id: "START",
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextHeading", text: "Heading" },
            { type: "TextInput", name: "name", label: "Name" },
            { type: "TextSubheading", text: "Subheading" },
            { type: "TextBody", text: "Body", "font-weight": "bold" },
            { type: "TextCaption", text: "Caption", markdown: true },
            { type: "TextBody", text: "${data.unavailable}" },
            { type: "TextBody", text: "Hidden", visible: false },
          ],
        },
      },
    ],
  })!;
  expect(preview.componentsByScreen.START).toEqual([
    { kind: "text", id: "text_0", type: "TextHeading", text: "Heading" },
    { kind: "field", fieldId: "name" },
    { kind: "text", id: "text_2", type: "TextSubheading", text: "Subheading" },
    { kind: "text", id: "text_3", type: "TextBody", text: "Body" },
    { kind: "unsupported", component: "TextBody settings" },
    { kind: "text", id: "text_4", type: "TextCaption", text: "Caption" },
    { kind: "unsupported", component: "TextCaption settings" },
    { kind: "unsupported", component: "TextBody" },
    { kind: "unsupported", component: "TextBody" },
  ]);
  expect(preview.config.screens[0].layoutContent).toEqual(
    preview.componentsByScreen.START.filter(item => item.kind !== "unsupported")
  );
});

it("projects direct inputs, NavigationList branches and terminal payloads without changing the source", () => {
  const before = JSON.stringify(DEMOSHOP_FLOW_JSON);
  const preview = projectFlowJsonPreview(DEMOSHOP_FLOW_JSON);
  expect(preview?.config.flowNavigationMode).toBe("static_graph");
  expect(preview?.config.screens[0].fields[0]).toMatchObject({
    fieldType: "NavigationList",
    navigationItems: [
      { action: { name: "navigate", nextScreenId: "DETAILS" } },
      { action: { name: "navigate", nextScreenId: "DETAILS" } },
      { action: { name: "navigate", nextScreenId: "DETAILS" } },
      {
        description: "Write your sport",
        action: { name: "navigate", nextScreenId: "OTHER_DETAILS" },
      },
    ],
  });
  expect(preview?.config.screens[1].terminal).toBe(true);
  expect(preview?.config.screens[2].terminal).toBe(true);
  expect(preview?.config.screens[1].fields[0].options?.[0].description).toBe(
    "With the athlete's name"
  );
  expect(preview?.config.screens[1].footer?.action).toMatchObject({
    name: "complete",
    payload: { __9ba1c9: "${data.sport}" },
  });
  expect(JSON.stringify(DEMOSHOP_FLOW_JSON)).toBe(before);
});

it("keeps supported content around unsupported components rather than replacing the screen", () => {
  const preview = projectFlowJsonPreview({
    version: "7.3",
    screens: [
      {
        id: "START",
        title: "Contact",
        terminal: true,
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextHeading", text: "Tell us about yourself" },
            { type: "Image", src: "https://example.test/private-image" },
            {
              type: "TextInput",
              name: "name",
              label: "Your name",
              required: true,
            },
            {
              type: "Footer",
              label: "Send",
              "on-click-action": {
                name: "complete",
                payload: { name: "${form.name}" },
              },
            },
          ],
        },
      },
    ],
  });
  expect(preview?.config.screens[0].fields[0].label).toBe("Your name");
  expect(preview?.componentsByScreen.START).toEqual([
    {
      kind: "text",
      id: "text_0",
      type: "TextHeading",
      text: "Tell us about yourself",
    },
    { kind: "unsupported", component: "Image" },
    { kind: "field", fieldId: "name" },
  ]);
  expect(JSON.stringify(preview)).not.toContain("private-image");
});

it("labels bounded dynamic examples and does not interpret an unsupported expression", () => {
  const preview = projectFlowJsonPreview({
    version: "7.3",
    screens: [
      {
        id: "START",
        title: "Examples",
        data: {
          greeting: { type: "string", __example__: "Hello from sample data" },
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextBody", text: "${data.greeting}" },
            { type: "TextBody", text: "${data.greeting + 'live'}" },
          ],
        },
      },
    ],
  });
  expect(preview?.usesExampleData).toBe(true);
  expect(preview?.componentsByScreen.START).toEqual([
    {
      kind: "text",
      id: "text_0",
      type: "TextBody",
      text: "Hello from sample data",
    },
    { kind: "unsupported", component: "TextBody" },
  ]);
});

it("bounds retained content and never retains source media or oversized screen data", () => {
  const huge = "private-image-".repeat(100_000);
  const preview = projectFlowJsonPreview({
    version: "7.3",
    screens: Array.from({ length: 25 }, (_, index) => ({
      id: `SCREEN_${index}`,
      title: "T".repeat(500_000),
      data: { private: { type: "string", __example__: huge } },
      layout: {
        type: "SingleColumnLayout",
        children: [
          { type: "Image", src: huge },
          {
            type: "TextInput",
            name: "name",
            label: "Name",
            "helper-text": huge,
          },
        ],
      },
    })),
  });
  expect(preview?.config.screens).toHaveLength(20);
  expect(preview?.totalScreens).toBe(25);
  expect(JSON.stringify(preview).length).toBeLessThan(256 * 1024);
  expect(JSON.stringify(preview)).not.toContain(huge);
});

it("marks content omitted by the read-only projection budget", () => {
  const preview = projectFlowJsonPreview({
    version: "7.3",
    screens: [
      {
        id: "START",
        title: "Long form",
        layout: {
          type: "SingleColumnLayout",
          children: Array.from({ length: 41 }, (_, index) => ({
            type: "TextBody",
            text: `Paragraph ${index}`,
          })),
        },
      },
    ],
  });
  expect(preview?.componentsByScreen.START).toContainEqual({
    kind: "unsupported",
    component: "Additional content",
  });
});

describe("catalog limits", () => {
  const flowJson = {
    version: "7.3",
    screens: [
      {
        id: "START",
        terminal: true,
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "Dropdown",
              name: "city",
              label: "City",
              "data-source": Array.from({ length: 120 }, (_, index) => ({
                id: `city_${index}`,
                title: `City ${index}`,
              })),
            },
            { type: "TextInput", name: "name", label: "Name" },
            {
              type: "TextInput",
              name: "nickname",
              label: "Nickname",
              required: true,
              visible: "${form.name}",
            },
            {
              type: "TextInput",
              name: "hidden",
              label: "Hidden",
              visible: false,
            },
          ],
        },
      },
    ],
  };

  it("keeps the preview's 20 options and shows a conditional field as unsupported by default", () => {
    const preview = projectFlowJsonPreview(flowJson)!;

    expect(preview.config.screens[0].fields[0].options).toHaveLength(20);
    expect(preview.config.screens[0].fields.map(field => field.id)).toEqual([
      "city",
      "name",
    ]);
    expect(preview.componentsByScreen.START).toContainEqual({
      kind: "unsupported",
      component: "TextInput",
    });
  });

  it("keeps 100 options and a conditionally shown field, as optional", () => {
    const preview = projectFlowJsonPreview(flowJson, {
      maxOptions: 100,
      keepDynamicallyVisibleFields: true,
    })!;
    const fields = preview.config.screens[0].fields;

    expect(fields[0].options).toHaveLength(100);
    expect(fields.map(field => field.id)).toEqual(["city", "name", "nickname"]);
    expect(fields[2]).toEqual({
      id: "nickname",
      label: "Nickname",
      fieldType: "TextInput",
    });
    expect(preview.componentsByScreen.START).toContainEqual({
      kind: "unsupported",
      component: "TextInput",
    });
  });
});

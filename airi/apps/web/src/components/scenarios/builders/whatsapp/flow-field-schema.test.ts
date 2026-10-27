import { computeFieldErrors } from "./flow-field-schema";
import { parseFlowJsonToWhatsAppFlowConfig } from "./flow-json-parser";
import { DEMOSHOP_FLOW_JSON } from "./flow-json-fixtures";

describe("canonical authoring field diagnostics", () => {
  it("retains required labels for ordinary input fields", () => {
    const errors = computeFieldErrors({
      templateId: "simple",
      ctaText: "Open",
      screens: [
        {
          id: "FORM",
          title: "Form",
          fields: [{ id: "name", label: "", fieldType: "TextInput" }],
        },
      ],
    });
    expect(errors["screens.0.fields.0.label"]).toBeTruthy();
  });
  it("retains missing choice and overlong option diagnostics", () => {
    const errors = computeFieldErrors({
      templateId: "simple",
      ctaText: "Open",
      screens: [
        {
          id: "FORM",
          title: "Form",
          fields: [
            {
              id: "design",
              label: "Design",
              fieldType: "RadioButtonsGroup",
              options: [],
            },
            {
              id: "sport",
              label: "Sport",
              fieldType: "Dropdown",
              options: [{ id: "sport_a", title: "x".repeat(31) }],
            },
          ],
        },
      ],
    });
    expect(errors["screens.0.fields.0.options"]).toBeTruthy();
    expect(errors["screens.0.fields.1.options.0.title"]).toBeTruthy();
  });
  it("accepts a valid NavigationList without inventing a Meta label", () => {
    const config = parseFlowJsonToWhatsAppFlowConfig({
      flowJson: structuredClone(DEMOSHOP_FLOW_JSON),
      flowId: "synthetic",
    })!;
    expect(computeFieldErrors(config)).toEqual({});
  });
  it("reports canonical navigation item errors at their editor paths", () => {
    const config = parseFlowJsonToWhatsAppFlowConfig({
      flowJson: structuredClone(DEMOSHOP_FLOW_JSON),
      flowId: "synthetic",
    })!;
    const items = config.screens[0]!.fields[0]!.navigationItems!;
    items[1]!.id = items[0]!.id;
    items[0]!.title = "";
    items[0]!.action = { name: "navigate", nextScreenId: "MISSING" };
    const errors = computeFieldErrors(config);
    expect(errors["screens.0.fields.0.navigationItems.1.id"]).toBeTruthy();
    expect(errors["screens.0.fields.0.navigationItems.0.title"]).toBeTruthy();
    expect(
      errors["screens.0.fields.0.navigationItems.0.action.nextScreenId"]
    ).toBeTruthy();
    expect(errors["screens.0.fields.0.label"]).toBeUndefined();
  });
  it("reports invalid NavigationList composition at the screen fields path", () => {
    const config = parseFlowJsonToWhatsAppFlowConfig({
      flowJson: structuredClone(DEMOSHOP_FLOW_JSON),
      flowId: "synthetic",
    })!;
    config.screens[0]!.fields.push({
      id: "name",
      label: "Name",
      fieldType: "TextInput",
    });
    expect(computeFieldErrors(config)["screens.0.fields"]).toContain(
      "NavigationLists"
    );
  });
});

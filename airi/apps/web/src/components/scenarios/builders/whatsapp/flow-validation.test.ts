import { validateWhatsAppFlowConfig } from "./flow-validation";

describe("validateWhatsAppFlowConfig endpoint mode", () => {
  it("returns a validation issue instead of throwing for a one-screen endpoint Flow", () => {
    const result = validateWhatsAppFlowConfig({
      templateId: "endpoint",
      ctaText: "Open",
      flowNavigationMode: "data_endpoint",
      screens: [
        {
          id: "START",
          title: "Start",
          fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
        },
      ],
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toContainEqual({
      code: "flow_endpoint_screens_required",
      path: "screens",
    });
  });

  it("reports the routing edge limit instead of a generic topology error", () => {
    const result = validateWhatsAppFlowConfig({
      templateId: "endpoint",
      ctaText: "Open",
      flowNavigationMode: "data_endpoint",
      screens: Array.from({ length: 12 }, (_, index) => ({
        id: `SCREEN_${String.fromCharCode(65 + index)}`,
        title: `Screen ${index + 1}`,
        fields: [],
      })),
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toContainEqual({
      code: "flow_routing_edges_exceeded",
      path: "screenRoutes",
    });
    expect(result.issues).not.toContainEqual({
      code: "flow_endpoint_invalid",
      path: "flowNavigationMode",
    });
  });
});

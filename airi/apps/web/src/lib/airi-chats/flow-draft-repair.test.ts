import { validateWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-validation";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { airiBuilderFlowConfigSchema } from "./builder-state";
import { repairAiriGeneratedFlowConfig } from "./flow-draft-repair";

/** The checks createAiriArtifact runs on a Flow snapshot. */
function artifactIssues(config: WhatsAppFlowConfig): string[] {
  const sanitized = sanitizeWhatsAppFlowConfig(config);
  const parsed = airiBuilderFlowConfigSchema.safeParse(sanitized);
  if (!parsed.success) {
    return parsed.error.issues.map(issue => `schema:${issue.path.join(".")}`);
  }
  return validateWhatsAppFlowConfig(parsed.data).issues.map(
    issue => `${issue.code}:${issue.path}`
  );
}

// Plausible model output the validator rejects: an id reused on the next
// screen, labels over Meta's per-type limits, and a Dropdown with no options.
const modelOutput = {
  templateId: "lead_generation",
  ctaText: "Book a free consultation with our team today",
  bodyText: "Tell us about your project.",
  screens: [
    {
      id: "CONTACT",
      title: "Contact details",
      fields: [
        {
          id: "name",
          label: "Your full name as it appears on your ID",
          fieldType: "TextInput",
          required: true,
        },
        { id: "budget", label: "Budget", fieldType: "Dropdown", options: [] },
        {
          id: "service",
          label: "Which service are you interested in most?",
          fieldType: "RadioButtonsGroup",
          options: [
            { id: "web", title: "Website design and development services" },
            { id: "web", title: "Mobile app" },
            { id: "blank", title: "   " },
          ],
        },
      ],
    },
    {
      id: "DETAILS",
      title: "",
      fields: [
        { id: "name", label: "Company name", fieldType: "TextInput" },
        { id: "notes", label: "", fieldType: "TextArea" },
      ],
    },
  ],
  flowBranchRules: {
    DETAILS: { name: { any: "CONTACT" } },
  },
};

function sanitizedModelOutput(): WhatsAppFlowConfig {
  const sanitized = sanitizeWhatsAppFlowConfig(modelOutput);
  if (!sanitized) throw new Error("model output did not sanitize");
  return sanitized;
}

describe("repairAiriGeneratedFlowConfig", () => {
  it("turns a Flow the artifact validator rejects into one it accepts", () => {
    const sanitized = sanitizedModelOutput();
    expect(artifactIssues(sanitized)).not.toEqual([]);

    const repaired = repairAiriGeneratedFlowConfig(sanitized);

    expect(artifactIssues(repaired)).toEqual([]);
  });

  it("keeps the draft's content while repairing it", () => {
    const repaired = repairAiriGeneratedFlowConfig(sanitizedModelOutput());
    const [contact, details] = repaired.screens;

    expect(repaired.ctaText).toBe("Book a free consultation with our");
    expect(contact?.fields.map(field => field.id)).toEqual(["name", "service"]);
    expect(contact?.fields[0]?.label).toBe("Your full name as it");
    expect(contact?.fields[1]?.options).toEqual([
      { id: "web", title: "Website design and development" },
      { id: "web_2", title: "Mobile app" },
    ]);
    expect(details?.title).toBe("Step 2");
    expect(details?.fields.map(field => [field.id, field.label])).toEqual([
      ["name_2", "Company name"],
      ["notes", "Notes"],
    ]);
    // A branch rule follows its renamed field.
    expect(repaired.flowBranchRules).toEqual({
      DETAILS: { name_2: { any: "CONTACT" } },
    });
  });

  it("keeps a field id shared across screens in static_graph mode", () => {
    const repaired = repairAiriGeneratedFlowConfig({
      ...sanitizedModelOutput(),
      flowNavigationMode: "static_graph",
    });

    expect(repaired.screens[1]?.fields[0]?.id).toBe("name");
  });

  it("drops field types the Airi builder cannot show", () => {
    const repaired = repairAiriGeneratedFlowConfig({
      templateId: "lead_generation",
      ctaText: "Open",
      screens: [
        {
          id: "MENU",
          title: "Menu",
          fields: [
            { id: "pick", label: "Pick", fieldType: "NavigationList" },
            { id: "name", label: "Name", fieldType: "TextInput" },
          ],
        },
      ],
    });

    expect(repaired.screens[0]?.fields.map(field => field.id)).toEqual([
      "name",
    ]);
  });
});

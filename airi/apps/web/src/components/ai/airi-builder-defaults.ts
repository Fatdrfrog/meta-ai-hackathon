import type { AiriWhatsAppTemplateDraft } from "@/lib/airi-chats/whatsapp-template-drafts";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";

export const DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT: AiriWhatsAppTemplateDraft = {
  kind: "whatsapp_template",
  name: "airi_whatsapp_template",
  language: "en",
  category: "MARKETING",
  components: [
    {
      type: "BODY",
      text: "Hi {{1}}, thanks for your interest. Reply here and we will help you choose the best next step.",
      example: {
        body_text: [["customer_name"]],
      },
    },
    {
      type: "BUTTONS",
      buttons: [{ type: "QUICK_REPLY", text: "Tell me more" }],
    },
  ],
};

export const DEFAULT_AIRI_BUILDER_FLOW_CONFIG: WhatsAppFlowConfig = {
  templateId: "lead_generation",
  ctaText: "Get Started",
  bodyText: "Please fill in your details so we can assist you.",
  flowUiLocale: "en",
  screens: [
    {
      id: "LEAD_FORM",
      title: "Contact Information",
      fields: [
        {
          id: "name",
          label: "Full Name",
          fieldType: "TextInput",
          required: true,
        },
        {
          id: "phone",
          label: "Phone Number",
          fieldType: "TextInput",
        },
        {
          id: "message",
          label: "How can we help?",
          fieldType: "TextArea",
        },
      ],
    },
  ],
};

export function createDefaultAiriBuilderFlowConfig(
  ctaText?: string | null
): WhatsAppFlowConfig {
  const nextCtaText = ctaText?.trim();
  return {
    ...DEFAULT_AIRI_BUILDER_FLOW_CONFIG,
    ctaText: nextCtaText || DEFAULT_AIRI_BUILDER_FLOW_CONFIG.ctaText,
    screens: DEFAULT_AIRI_BUILDER_FLOW_CONFIG.screens.map(screen => ({
      ...screen,
      fields: screen.fields.map(field => ({ ...field })),
    })),
  };
}

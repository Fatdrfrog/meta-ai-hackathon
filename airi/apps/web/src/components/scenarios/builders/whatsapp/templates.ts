import type {
  WhatsAppFlowFieldConfig,
  WhatsAppFlowScreenConfig,
} from "@/components/scenarios/types";

export type FlowTemplateId =
  | "lead_generation"
  | "customer_survey"
  | "appointment_booking";

export type FlowTemplateDefinition = {
  id: FlowTemplateId;
  titleKey: string;
  descriptionKey: string;
  icon: "UserPlus" | "ClipboardList" | "CalendarCheck";
  defaultCtaText: string;
  defaultBodyText: string;
  screens: WhatsAppFlowScreenConfig[];
};

function field(
  id: string,
  label: string,
  fieldType: WhatsAppFlowFieldConfig["fieldType"],
  options?: {
    required?: boolean;
    helperText?: string;
    choices?: Array<{ id: string; title: string }>;
  }
): WhatsAppFlowFieldConfig {
  return {
    id,
    label,
    fieldType,
    required: options?.required ?? false,
    helperText: options?.helperText,
    options: options?.choices,
  };
}

export const FLOW_TEMPLATES: FlowTemplateDefinition[] = [
  {
    id: "lead_generation",
    titleKey: "flowTemplateLeadGenTitle",
    descriptionKey: "flowTemplateLeadGenDesc",
    icon: "UserPlus",
    defaultCtaText: "Get Started",
    defaultBodyText: "Please fill in your details so we can assist you.",
    screens: [
      {
        id: "LEAD_FORM",
        title: "Contact Information",
        fields: [
          field("name", "Full Name", "TextInput", { required: true }),
          field("email", "Email Address", "TextInput", { required: true }),
          field("phone", "Phone Number", "TextInput"),
          field("company", "Company Name", "TextInput"),
          field("message", "How can we help?", "TextArea"),
        ],
      },
    ],
  },
  {
    id: "customer_survey",
    titleKey: "flowTemplateSurveyTitle",
    descriptionKey: "flowTemplateSurveyDesc",
    icon: "ClipboardList",
    defaultCtaText: "Take Survey",
    defaultBodyText: "We'd love to hear your feedback!",
    screens: [
      {
        id: "SURVEY_FORM",
        title: "Customer Feedback",
        fields: [
          field("rating", "How would you rate our service?", "Dropdown", {
            required: true,
            choices: [
              { id: "5", title: "Excellent" },
              { id: "4", title: "Good" },
              { id: "3", title: "Average" },
              { id: "2", title: "Below Average" },
              { id: "1", title: "Poor" },
            ],
          }),
          field("recommend", "Would you recommend us?", "RadioButtonsGroup", {
            required: true,
            choices: [
              { id: "yes", title: "Yes, definitely" },
              { id: "maybe", title: "Maybe" },
              { id: "no", title: "No" },
            ],
          }),
          field("feedback", "Any additional feedback?", "TextArea"),
        ],
      },
    ],
  },
  {
    id: "appointment_booking",
    titleKey: "flowTemplateAppointmentTitle",
    descriptionKey: "flowTemplateAppointmentDesc",
    icon: "CalendarCheck",
    defaultCtaText: "Book Appointment",
    defaultBodyText: "Select a time that works for you.",
    screens: [
      {
        id: "BOOKING_FORM",
        title: "Book an Appointment",
        fields: [
          field("service", "Service", "Dropdown", {
            required: true,
            choices: [
              { id: "consultation", title: "Consultation" },
              { id: "demo", title: "Product Demo" },
              { id: "support", title: "Technical Support" },
              { id: "onboarding", title: "Onboarding Session" },
            ],
          }),
          field("date", "Preferred Date", "DatePicker", { required: true }),
          field("time_slot", "Preferred Time", "Dropdown", {
            required: true,
            choices: [
              { id: "09:00", title: "09:00 AM" },
              { id: "10:00", title: "10:00 AM" },
              { id: "11:00", title: "11:00 AM" },
              { id: "14:00", title: "02:00 PM" },
              { id: "15:00", title: "03:00 PM" },
              { id: "16:00", title: "04:00 PM" },
            ],
          }),
          field("name", "Your Name", "TextInput", { required: true }),
          field("notes", "Additional Notes", "TextArea"),
        ],
      },
    ],
  },
];

export function getFlowTemplate(
  templateId: FlowTemplateId
): FlowTemplateDefinition | undefined {
  return FLOW_TEMPLATES.find(t => t.id === templateId);
}

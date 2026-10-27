import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { FlowBuilder } from "../src/components/scenarios/builders/whatsapp/flow-builder";
import { parseFlowJsonToWhatsAppFlowConfig } from "../src/components/scenarios/builders/whatsapp/flow-json-parser";
import { DEMOSHOP_FLOW_JSON } from "../src/components/scenarios/builders/whatsapp/flow-json-fixtures";
import { NextIntlClientProvider } from "next-intl";
import { Toaster } from "sonner";
import { WhatsAppFlowsManager } from "../src/components/whatsapp-flows/flows-manager";
import { ScopedIntlProvider } from "../src/components/i18n/scoped-intl-provider";
import { PageHeader } from "../src/components/ui/page-header";
import { generateFlowJson } from "../src/components/scenarios/builders/whatsapp/flow-json-generator";
import commonMessages from "../messages/en.json";
import integrationMessages from "../messages/settings/integrations/en/page.json";
import scenarioMessages from "../messages/scenarios/en/page.json";
import ruIntegrationMessages from "../messages/settings/integrations/ru/page.json";
import ruScenarioMessages from "../messages/scenarios/ru/page.json";
import kzIntegrationMessages from "../messages/settings/integrations/kz/page.json";
import kzScenarioMessages from "../messages/scenarios/kz/page.json";
import "../src/app/globals.css";

const requestedLocale = new URLSearchParams(window.location.search).get(
  "locale"
);
const locale =
  requestedLocale === "ru" || requestedLocale === "kz" ? requestedLocale : "en";
const localizedMessages = {
  en: integrationMessages,
  ru: ruIntegrationMessages,
  kz: kzIntegrationMessages,
}[locale];
const localizedScenarioMessages = {
  en: scenarioMessages,
  ru: ruScenarioMessages,
  kz: kzScenarioMessages,
}[locale];
document.documentElement.lang = locale;

const layoutFlowConfig: WhatsAppFlowConfig = {
  templateId: "custom",
  ctaText: "Open survey",
  flowNavigationMode: "static_graph",
  flowJsonVersion: "7.3",
  screens: [
    {
      id: "SURVEY",
      title: "Complete the survey",
      terminal: true,
      success: true,
      data: {},
      fields: Array.from({ length: 8 }, (_, index) => ({
        id: `answer_${index + 1}`,
        label: index === 7 ? "Final answer" : `Question ${index + 1}`,
        fieldType: "TextInput" as const,
        helperText:
          "Tell us a little more so we can prepare the right response.",
      })),
      footer: {
        label: "Finish survey",
        action: {
          name: "complete",
          payload: Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [
              `answer_${index + 1}`,
              `\${form.answer_${index + 1}}`,
            ])
          ),
        },
      },
    },
  ],
};
const layoutFlowJson = generateFlowJson(layoutFlowConfig);

function ScenarioFlowSurface() {
  const [config, setConfig] = useState<WhatsAppFlowConfig>(() => {
    const imported = parseFlowJsonToWhatsAppFlowConfig({
      flowJson:
        new URLSearchParams(window.location.search).get("fixture") ===
        "longForm"
          ? layoutFlowJson
          : DEMOSHOP_FLOW_JSON,
      flowId: "scenario-fixture",
    });
    if (!imported) throw new Error("Expected editable graph fixture");
    return { ...imported, templateId: "custom", metaFlowId: undefined };
  });
  const params = new URLSearchParams(window.location.search);
  const width = Number(params.get("width")) || 360;
  const height = Number(params.get("height")) || 460;
  return (
    <div
      className="mx-auto min-h-0 w-full"
      style={{ maxWidth: width, height }}
      data-testid="scenario-flow-surface"
    >
      <FlowBuilder
        flowConfig={config}
        onFlowConfigChange={setConfig}
        renderMode="inline"
        validationMode="draft"
      />
    </div>
  );
}

// Real components, translation provider, styles and HTTP client. Playwright
// intercepts the Flow HTTP boundary; this page never contacts a provider.
Object.assign(window, {
  __flowFixtures: {
    longForm: layoutFlowJson,
    basic: generateFlowJson({
      templateId: "custom",
      ctaText: "Open form",
      flowUiLocale: "en",
      screens: [
        {
          id: "START",
          title: "Contact details",
          fields: [
            {
              id: "name",
              label: "Name",
              fieldType: "TextInput",
              required: true,
              helperText: "Use the name we should contact you by",
            },
          ],
        },
        {
          id: "PREFERENCES",
          title: "Your preferences",
          fields: [
            {
              id: "interest",
              label: "What interests you?",
              fieldType: "Dropdown",
              required: true,
              options: [
                { id: "consultation", title: "Consultation" },
                { id: "demo", title: "Product demo" },
                { id: "other", title: "Something else" },
              ],
            },
            {
              id: "plan",
              label: "Preferred plan",
              fieldType: "RadioButtonsGroup",
              options: [
                { id: "starter", title: "Starter" },
                { id: "growth", title: "Growth" },
              ],
            },
            {
              id: "notes",
              label: "Anything else?",
              fieldType: "TextArea",
              helperText: "Tell us what would help you decide",
            },
          ],
        },
      ],
    }),
    booking: generateFlowJson({
      templateId: "custom",
      ctaText: "Book a visit",
      flowUiLocale: "en",
      screens: [
        {
          id: "BOOKING",
          title: "Arrange your visit",
          fields: [
            {
              id: "visit_date",
              label: "Visit date",
              fieldType: "DatePicker",
              required: true,
            },
            {
              id: "visit_time",
              label: "Preferred time",
              fieldType: "Dropdown",
              options: [
                { id: "morning", title: "Morning" },
                { id: "afternoon", title: "Afternoon" },
              ],
            },
            {
              id: "visitor",
              label: "Who is visiting?",
              fieldType: "TextInput",
              helperText: "Include everyone joining your appointment",
            },
          ],
        },
      ],
    }),
    registration: generateFlowJson({
      templateId: "custom",
      ctaText: "Join updates",
      flowUiLocale: "en",
      screens: [
        {
          id: "REGISTRATION",
          title: "Join our updates",
          fields: [
            { id: "email", label: "Email address", fieldType: "TextInput" },
            {
              id: "interests",
              label: "Updates you want",
              fieldType: "CheckboxGroup",
              options: [
                { id: "news", title: "Product news" },
                { id: "events", title: "Upcoming events" },
              ],
            },
          ],
        },
      ],
    }),
    advanced: {
      version: "7.3",
      screens: [
        {
          id: "START",
          title: "Conditional welcome",
          terminal: true,
          data: { show_heading: { type: "boolean", __example__: true } },
          layout: {
            type: "SingleColumnLayout",
            children: [
              {
                type: "TextHeading",
                text: "Welcome",
                visible: "${data.show_heading}",
              },
              {
                type: "Footer",
                label: "Submit",
                "on-click-action": { name: "complete", payload: {} },
              },
            ],
          },
        },
      ],
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <NextIntlClientProvider
    locale={locale}
    timeZone="UTC"
    messages={{
      ...commonMessages,
      ...localizedMessages,
    }}
  >
    <main className="mx-auto max-w-7xl p-4 sm:p-8">
      <div className="space-y-4">
        <PageHeader
          title={localizedMessages.WhatsAppFlows.title}
          description={localizedMessages.WhatsAppFlows.description}
        />
        <ScopedIntlProvider
          messages={{ Scenarios: localizedScenarioMessages.Scenarios }}
        >
          {new URLSearchParams(window.location.search).get("surface") ===
          "scenario" ? (
            <ScenarioFlowSurface />
          ) : (
            <WhatsAppFlowsManager
              workspaceId="browser-workspace"
              sourceOptions={[
                { id: "browser-source", label: "Demo WhatsApp account" },
              ]}
            />
          )}
        </ScopedIntlProvider>
      </div>
    </main>
    <Toaster />
  </NextIntlClientProvider>
);

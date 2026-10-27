/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useTemplateFlowFacts } from "@/hooks/use-template-flow-facts";
import { collectTemplateFlowIds } from "@/lib/whatsapp/flows/template-flow-health";
import { ActionNodeWhatsAppTemplateFlowHealth } from "./action-node-whatsapp-template-flow-health";

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages: Record<string, string> = {
      "flowHealth.screenMissing":
        'The "{button}" button opens screen {screen}, but Flow "{flow}" no longer has it.',
      "flowHealth.screensAvailable": "Screens in this Flow: {screens}",
      "flowHealth.checkAgain": "Check again",
      "flowHealth.checking": "Checking...",
    };
    return (key: string, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, value),
        messages[key] ?? key
      );
  },
}));

const originalFetch = global.fetch;
const FLOW_ID = "2244981489363579";
const COMPONENTS = [
  {
    type: "BUTTONS",
    buttons: [
      {
        type: "FLOW",
        text: "Таңдау",
        flow_id: Number(FLOW_ID),
        flow_action: "NAVIGATE",
        navigate_screen: "QUESTION_ONE",
      },
    ],
  },
];

function answer(screenIds: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      facts: [
        {
          flowId: FLOW_ID,
          state: "found",
          name: "Message templates_medal_pick_1_MARKETING_9b1bc",
          status: "PUBLISHED",
          screenIds,
          checkedAt: new Date().toISOString(),
        },
      ],
    }),
  };
}

afterEach(() => {
  global.fetch = originalFetch;
});

/** The template section reads the facts once and hands them down. */
function FlowHealth({
  workspaceId,
  components,
}: {
  workspaceId: string;
  components: unknown;
}) {
  const flowIds = collectTemplateFlowIds(components);
  const flowFacts = useTemplateFlowFacts({
    workspaceId,
    flowIds,
    enabled: flowIds.length > 0,
  });
  return (
    <ActionNodeWhatsAppTemplateFlowHealth
      components={components}
      flowFacts={flowFacts}
    />
  );
}

it("warns in the builder when the template's Flow lost the button's screen", async () => {
  const fetchMock = jest
    .fn()
    .mockResolvedValueOnce(answer(["SURVEY_FORM"]))
    .mockResolvedValueOnce(answer(["QUESTION_ONE"]));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<FlowHealth workspaceId="ws-builder-flow" components={COMPONENTS} />);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    'The "Таңдау" button opens screen QUESTION_ONE, but Flow "Message templates_medal_pick_1_MARKETING_9b1bc" no longer has it.'
  );
  expect(alert).toHaveTextContent("Screens in this Flow: SURVEY_FORM");

  fireEvent.click(screen.getByRole("button", { name: /check again/i }));

  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(String(fetchMock.mock.calls[1][0])).toContain("refresh=1");
});

it("doesn't ask for templates without a Flow button", () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;

  const { container } = render(
    <FlowHealth
      workspaceId="ws-builder-flow-none"
      components={[{ type: "BODY", text: "Hi" }]}
    />
  );

  expect(container).toBeEmptyDOMElement();
  expect(fetchMock).not.toHaveBeenCalled();
});

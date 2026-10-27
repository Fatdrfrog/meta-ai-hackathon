/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { TextEncoder } from "node:util";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScenarioConversationPreview } from "./conversation";
import type { ScenarioSimulationMessage } from "@/lib/scenarios/scenario-simulation-types";
import type { ScenarioDraftPreviewInput } from "./evaluation";
import { useScenarioSimulation } from "./use-scenario-simulation";
import { installResizeObserver } from "@/test-support/dom-test-utils";

jest.mock("./use-scenario-simulation", () => ({
  useScenarioSimulation: jest.fn(),
}));
const run = jest.fn();
const reset = jest.fn();
const originalResizeObserver = global.ResizeObserver;
const originalTextEncoder = global.TextEncoder;
beforeAll(() => {
  global.TextEncoder = TextEncoder as typeof global.TextEncoder;
  installResizeObserver();
});
afterAll(() => {
  global.ResizeObserver = originalResizeObserver;
  global.TextEncoder = originalTextEncoder;
});
const draft = {
  scenarioId: "example",
  name: "Example",
  status: "draft",
  priority: 1,
  nodes: [],
  edges: [],
} as ScenarioDraftPreviewInput;
function show(
  message: ScenarioSimulationMessage,
  state = {
    status: "waiting",
    actionNodeId: "menu",
    dueAt: 600000,
    now: 120000,
  }
) {
  jest.mocked(useScenarioSimulation).mockReturnValue({
    entries: [{ id: "message-one", kind: "message", message }],
    result: { state },
    loading: false,
    error: null,
    run,
    reset,
  } as unknown as ReturnType<typeof useScenarioSimulation>);
  return render(
    <ScenarioConversationPreview
      workspaceId="workspace"
      draftScenario={draft}
    />
  );
}
const message = (
  data: NonNullable<ScenarioSimulationMessage["serviceMessage"]>["message"]
): ScenarioSimulationMessage => ({
  actionNodeId: "menu",
  bodyText: "Choose a route",
  dynamic: false,
  serviceMessage: { version: 1, message: data },
});

it("keeps form answers attached to their message when the transcript trims older entries", () => {
  const view = show(
    message({
      kind: "flow",
      body: { mode: "fixed", text: "Details" },
      flowConfig: {
        templateId: "details",
        ctaText: "Open details",
        screens: [
          {
            id: "ONE",
            title: "Details",
            fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
          },
        ],
      },
    })
  );
  const controller = jest.mocked(useScenarioSimulation).mock.results.at(-1)!
    .value as ReturnType<typeof useScenarioSimulation>;
  const props = { workspaceId: "workspace", draftScenario: draft };
  jest.mocked(useScenarioSimulation).mockReturnValue({
    ...controller,
    entries: [
      {
        id: "older",
        kind: "message",
        message: message({
          kind: "text",
          body: { mode: "fixed", text: "Hello" },
        }),
      },
      ...controller.entries,
    ],
  });
  view.rerender(<ScenarioConversationPreview {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Open details" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Alex" },
  });
  jest.mocked(useScenarioSimulation).mockReturnValue(controller);
  view.rerender(<ScenarioConversationPreview {...props} />);
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Alex");
});
beforeEach(() => {
  run.mockReset();
  reset.mockReset();
});

it("keeps a typed answer available to retry when evaluation fails", async () => {
  run.mockResolvedValue(false);
  show(message({ kind: "text", body: { mode: "fixed", text: "Hello" } }));
  const input = screen.getByRole("textbox", { name: "simulationYourMessage" });
  fireEvent.change(input, { target: { value: "Please help" } });
  fireEvent.click(screen.getByRole("button", { name: "simulationSend" }));
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith({ kind: "message", text: "Please help" })
  );
  expect(input).toHaveValue("Please help");
});

it("sends a multiline draft on Enter while preserving Shift+Enter and composition", () => {
  show(message({ kind: "text", body: { mode: "fixed", text: "Hello" } }));
  const input = screen.getByRole("textbox", { name: "simulationYourMessage" });
  fireEvent.change(input, { target: { value: "First line\nSecond line" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(run).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(run).toHaveBeenCalledWith({
    kind: "message",
    text: "First line\nSecond line",
  });
});

it("lets the customer keep talking after handoff while the quiet-period follow-up is pending", () => {
  show(
    message({
      kind: "text",
      body: { mode: "fixed", text: "A teammate will help" },
    }),
    { status: "handoff", actionNodeId: "handoff", dueAt: 600000, now: 120000 }
  );
  const input = screen.getByRole("textbox", { name: "simulationYourMessage" });
  expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: "More details" } });
  fireEvent.click(screen.getByRole("button", { name: "simulationSend" }));
  expect(run).toHaveBeenCalledWith({ kind: "message", text: "More details" });
  expect(
    screen.getByRole("button", { name: "simulationSkipWait" })
  ).toBeEnabled();
});

it("sends canonical button payload unchanged and disables historical choices after completion", () => {
  const view = show(
    message({
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Choose" },
      options: [{ id: "wsc:menu:help", label: "Help" }],
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  expect(run).toHaveBeenCalledWith(
    { kind: "choice", payload: "wsc:menu:help" },
    "Help"
  );
  view.unmount();
  show(
    message({
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Choose" },
      options: [{ id: "wsc:menu:help", label: "Help" }],
    }),
    { status: "completed", actionNodeId: "end", dueAt: 600000, now: 120000 }
  );
  expect(screen.getByRole("button", { name: "Help" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveFocus();
  expect(
    screen.queryByRole("textbox", { name: "simulationYourMessage" })
  ).not.toBeInTheDocument();
});

it("clears an unsent draft when the conversation is restarted", () => {
  show(message({ kind: "text", body: { mode: "fixed", text: "Hello" } }));
  const input = screen.getByRole("textbox", { name: "simulationYourMessage" });
  fireEvent.change(input, { target: { value: "Unsent draft" } });
  fireEvent.click(screen.getByRole("button", { name: "simulationRestart" }));
  expect(reset).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue("");
});

it("follows the latest message when the capped transcript keeps the same length", () => {
  const scrollTo = jest.fn();
  const original = HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollTo = scrollTo;
  try {
    const view = show(
      message({ kind: "text", body: { mode: "fixed", text: "First" } })
    );
    const controller = jest.mocked(useScenarioSimulation).mock.results.at(-1)!
      .value as ReturnType<typeof useScenarioSimulation>;
    scrollTo.mockClear();
    jest.mocked(useScenarioSimulation).mockReturnValue({
      ...controller,
      entries: [
        {
          id: "message-two",
          kind: "message",
          message: message({
            kind: "text",
            body: { mode: "fixed", text: "Latest" },
          }),
        },
      ],
    });
    view.rerender(
      <ScenarioConversationPreview
        workspaceId="workspace"
        draftScenario={draft}
      />
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
  } finally {
    HTMLElement.prototype.scrollTo = original;
  }
});

it("opens a list before sending the selected row's canonical payload", () => {
  show(
    message({
      kind: "list",
      body: { mode: "fixed", text: "Choose" },
      buttonLabel: "Browse",
      sections: [
        {
          id: "one",
          title: "Help topics",
          rows: [
            {
              id: "wsc:menu:billing",
              title: "Billing",
              description: "Invoices",
            },
          ],
        },
      ],
    })
  );
  expect(
    screen.queryByRole("button", { name: "Billing Invoices" })
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  fireEvent.click(screen.getByRole("button", { name: "Billing Invoices" }));
  expect(run).toHaveBeenCalledWith(
    { kind: "choice", payload: "wsc:menu:billing" },
    "Billing"
  );
});

it("shows each carousel card's own quick replies and sends the tapped option", () => {
  const card = (id: string, options: Array<{ id: string; label: string }>) => ({
    id,
    media: {
      url: `https://cdn.example.com/${id}.jpg`,
      mediaType: "image" as const,
    },
    bodyText: `Card ${id}`,
    interaction: { kind: "quick_replies" as const, options },
  });
  show(
    message({
      kind: "media_carousel",
      body: { mode: "fixed", text: "Pick one" },
      cards: [
        card("gold", [{ id: "wsc:menu:gold", label: "Gold" }]),
        card("silver", [{ id: "wsc:menu:silver", label: "Silver" }]),
      ],
    })
  );
  const buttons = screen.getAllByRole("button", { name: /Gold|Silver/ });
  expect(buttons.map(button => button.textContent)).toEqual(["Gold", "Silver"]);
  fireEvent.click(screen.getByRole("button", { name: "Silver" }));
  expect(run).toHaveBeenCalledWith(
    { kind: "choice", payload: "wsc:menu:silver" },
    "Silver"
  );
});

it("skips only the remaining quiet period and supports restart", () => {
  show(message({ kind: "text", body: { mode: "fixed", text: "Hello" } }));
  fireEvent.click(screen.getByRole("button", { name: "simulationSkipWait" }));
  expect(run).toHaveBeenCalledWith({ kind: "advance", minutes: 8 }, undefined);
  fireEvent.click(screen.getByRole("button", { name: "simulationRestart" }));
  expect(reset).toHaveBeenCalledTimes(1);
});

it("keeps required fields and checkbox selections in a submitted Flow", () => {
  show(
    message({
      kind: "flow",
      body: { mode: "fixed", text: "Please complete this form" },
      flowConfig: {
        templateId: "survey",
        ctaText: "Open survey",
        screens: [
          {
            id: "ONE",
            title: "Survey",
            fields: [
              {
                id: "name",
                label: "Your name",
                fieldType: "TextInput",
                required: true,
              },
              {
                id: "topics",
                label: "Topics",
                fieldType: "CheckboxGroup",
                options: [
                  { id: "news", title: "News" },
                  { id: "offers", title: "Offers" },
                ],
              },
            ],
          },
        ],
      },
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Open survey" }));
  expect(
    screen.getByRole("button", { name: "simulationSubmitForm" })
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Your name *"), {
    target: { value: "Alex" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "News" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Offers" }));
  fireEvent.click(screen.getByRole("button", { name: "simulationSubmitForm" }));
  expect(run).toHaveBeenCalledWith(
    { kind: "flow", values: { name: "Alex", topics: ["news", "offers"] } },
    "simulationFormSubmitted"
  );
});

it("follows configured Flow screen routing without submitting a skipped screen", () => {
  show(
    message({
      kind: "flow",
      body: { mode: "fixed", text: "Please complete this form" },
      flowConfig: {
        templateId: "survey",
        ctaText: "Open survey",
        flowNavigationMode: "data_endpoint",
        screenRoutes: { ONE: ["TWO", "THREE"] },
        flowBranchRules: {
          ONE: { route: { finish: "THREE", details: "TWO" } },
        },
        screens: [
          {
            id: "ONE",
            title: "Choose",
            fields: [
              {
                id: "route",
                label: "Route",
                fieldType: "RadioButtonsGroup",
                options: [
                  { id: "finish", title: "Finish" },
                  { id: "details", title: "Details" },
                ],
              },
            ],
          },
          { id: "TWO", title: "More details", fields: [] },
          { id: "THREE", title: "Done", fields: [] },
        ],
      },
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Open survey" }));
  expect(screen.getByRole("heading", { name: "Choose" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Finish" }));
  fireEvent.click(screen.getByRole("button", { name: "simulationNextScreen" }));
  expect(screen.getByText("Done")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Done" })).toHaveFocus();
  expect(screen.queryByText("More details")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "simulationSubmitForm" }));
  expect(run).toHaveBeenCalledWith(
    { kind: "flow", values: { route: "finish" } },
    "simulationFormSubmitted"
  );
});

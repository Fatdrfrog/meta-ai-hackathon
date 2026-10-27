/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AiriChatRunEvent } from "@/lib/airi-chats/run-events";
import { AiriChatRunProgress } from "./airi-chat-run-progress";

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages = jest.requireActual("../../../messages/en.json")
      .AiriChatProgress as Record<string, string>;
    return (key: string) => messages[key];
  },
}));

const at = "2026-09-20T14:00:00.000Z";
const generation: AiriChatRunEvent = {
  type: "stage",
  id: "generation",
  label: "Generating answer",
  status: "running",
  at,
};
function answer(metadata?: Record<string, unknown>): AiriChatRunEvent {
  return {
    type: "assistant_message",
    at,
    message: {
      id: "answer",
      threadId: "thread",
      role: "assistant",
      content: "Answer",
      metadata,
      createdAt: at,
    },
  };
}

it("shows a friendly live phase and keeps complete technical activity behind a disclosure", () => {
  render(
    <AiriChatRunProgress
      events={[
        {
          type: "stage",
          id: "intent",
          label: "Classifying request",
          status: "complete",
          detail: "general_answer",
          at,
        },
        generation,
        {
          type: "model_attempt",
          id: "model-1",
          label: "Model answered",
          status: "complete",
          detail: "model-a · 1250ms",
          at,
        },
        {
          type: "resources",
          id: "sources",
          label: "Resources used",
          status: "complete",
          resources: [
            {
              id: "kb",
              label: "Knowledge base",
              kind: "knowledge_base",
              count: 3,
            },
          ],
          at,
        },
      ]}
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent("Writing your answer");
  expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByText("general_answer")).not.toBeInTheDocument();
  expect(screen.queryByText("model-a · 1250ms")).not.toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "Activity details" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("general_answer")).toBeInTheDocument();
  expect(screen.getByText("model-a · 1250ms")).toBeInTheDocument();
  expect(screen.getByText("Knowledge base")).toBeInTheDocument();
  // Rendered inside the chat's role="log"; new trace rows must not each be
  // announced on top of the status line.
  expect(screen.getByTestId("airi-run-activity-trace")).toHaveAttribute(
    "aria-live",
    "off"
  );
  expect(screen.getByTestId("airi-run-activity-trace")).toContainElement(
    screen.getByText("general_answer")
  );
});

it("labels the stage still running when a parallel stage completes last", () => {
  const stage = (
    id: string,
    status: "running" | "complete"
  ): AiriChatRunEvent => ({ type: "stage", id, label: id, status, at });
  const { rerender } = render(
    <AiriChatRunProgress
      events={[
        stage("workspace_retrieval", "running"),
        stage("intent", "running"),
      ]}
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Understanding your request"
  );

  rerender(
    <AiriChatRunProgress
      events={[
        stage("workspace_retrieval", "running"),
        stage("intent", "running"),
        stage("intent", "complete"),
      ]}
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Reviewing relevant information"
  );

  rerender(
    <AiriChatRunProgress
      events={[
        stage("workspace_retrieval", "running"),
        stage("intent", "running"),
        stage("intent", "complete"),
        stage("workspace_retrieval", "complete"),
      ]}
    />
  );
  // Nothing runs any more: the last stage event names the phase.
  expect(screen.getByRole("status")).toHaveTextContent(
    "Reviewing relevant information"
  );
});

it("labels a draft the artifact store rejected as saving, not as generic work", () => {
  render(
    <AiriChatRunProgress
      events={[
        {
          type: "stage",
          id: "template_draft",
          label: "Drafting",
          status: "complete",
          at,
        },
        {
          type: "stage",
          id: "builder_artifact",
          label: "Saving draft",
          status: "error",
          detail: "2 validation issues",
          at,
        },
      ]}
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent("Saving your answer");
});

it("stops indicating work as soon as the saved answer arrives, before title and stream completion", () => {
  const { rerender } = render(<AiriChatRunProgress events={[generation]} />);
  expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  rerender(
    <AiriChatRunProgress
      events={[
        generation,
        answer(),
        {
          type: "stage",
          id: "title",
          label: "Naming chat",
          status: "running",
          at,
        },
      ]}
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent("Answer ready");
  expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false");
});

it("keeps an explicit stream failure visible outside the disclosure", () => {
  render(
    <AiriChatRunProgress
      events={[
        generation,
        {
          type: "error",
          message: "Could not save the answer. Please try again.",
          at,
        },
      ]}
    />
  );
  expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false");
  // Shown in the log without a second alert; the workspace banner announces it.
  expect(
    screen.getByText("Could not save the answer. Please try again.")
  ).toHaveAttribute("aria-live", "off");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([
  [
    { airiMetaAdsMcpCoverage: { complete: false, reasons: ["cancelled"] } },
    "Request stopped",
  ],
  [
    {
      airiMetaAdsMcpCoverage: {
        complete: false,
        reasons: ["budget_exhausted"],
      },
    },
    "Partial results ready",
  ],
  [{ failed: true }, "Could not complete the request"],
])(
  "does not mark an incomplete assistant response as successful",
  (metadata, label) => {
    render(<AiriChatRunProgress events={[generation, answer(metadata)]} />);
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false");
  }
);

it("retains earlier failures and retries in activity instead of slicing away evidence", () => {
  const events: AiriChatRunEvent[] = Array.from(
    { length: 9 },
    (_, attempt) => ({
      type: "model_attempt",
      id: `model-${attempt}`,
      label: `Attempt ${attempt + 1}`,
      status: attempt === 0 ? "error" : "complete",
      detail:
        attempt === 0 ? "Provider temporarily unavailable" : "Model answered",
      at,
    })
  );
  render(<AiriChatRunProgress events={events} />);
  fireEvent.click(screen.getByRole("button", { name: "Activity details" }));
  expect(
    screen.getByText("Provider temporarily unavailable")
  ).toBeInTheDocument();
  expect(screen.getByText("Attempt 9")).toBeInTheDocument();
});

it.each([
  [
    "a stopped answer",
    [generation, answer({ cancelled: true, partial: true })],
  ],
  [
    "a run that ended as cancelled before any answer",
    [
      generation,
      {
        type: "done",
        thread: {
          id: "thread",
          title: "Chat",
          source: "manual",
          updatedAt: at,
        },
        status: "cancelled",
        at,
      },
    ],
  ],
  [
    "a new chat's run stopped before its question was saved",
    [
      generation,
      {
        type: "error",
        message: "Request cancelled",
        code: "cancelled",
        status: 499,
        persisted: false,
        at,
      },
    ],
  ],
] as Array<[string, AiriChatRunEvent[]]>)(
  "shows %s as stopped, not ready or failed",
  (_, events) => {
    render(<AiriChatRunProgress events={events} />);
    expect(screen.getByRole("status")).toHaveTextContent("Request stopped");
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("Request cancelled")).not.toBeInTheDocument();
  }
);

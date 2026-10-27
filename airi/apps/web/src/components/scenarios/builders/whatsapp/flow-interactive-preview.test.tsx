/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { META_STARTER_FLOW_JSON } from "./flow-json-fixtures";
import { projectFlowJsonPreview } from "./flow-json-preview";
import { FlowInteractivePreview } from "./flow-interactive-preview";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const messages: Record<string, string> = {
      "flowAuthoring.previewCompleted": "Preview completed",
      "flowAuthoring.testResult": "Test submission",
      "flowAuthoring.restartPreview": "Restart preview",
    };
    return (
      messages[key] ??
      (values ? `${key}:${Object.values(values).join(",")}` : key)
    );
  },
}));

const config: WhatsAppFlowConfig = {
  templateId: "custom",
  ctaText: "Open",
  flowNavigationMode: "static_graph",
  screens: [
    {
      id: "FIRST",
      title: "First screen",
      terminal: true,
      fields: [
        {
          id: "answer",
          fieldType: "TextInput",
          label: "Your answer",
          required: true,
        },
      ],
      footer: {
        label: "Submit",
        action: {
          name: "complete",
          payload: { answer: "${form.answer}", count: 0, accepted: false },
        },
      },
    },
    {
      id: "SECOND",
      title: "Second screen",
      terminal: true,
      fields: [
        {
          id: "other",
          fieldType: "TextInput",
          label: "Other answer",
          required: true,
        },
      ],
      footer: {
        label: "Submit",
        action: { name: "complete", payload: { answer: "${form.other}" } },
      },
    },
  ],
};

function complete() {
  fireEvent.change(screen.getByLabelText("Your answer *"), {
    target: { value: "Ayan" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
}

it("announces completion while keeping the exact evaluated payload collapsed until requested", () => {
  render(<FlowInteractivePreview config={config} />);
  complete();

  expect(screen.getByRole("status")).toHaveTextContent("Preview completed");
  const disclosure = screen.getByText("Test submission").closest("details")!;
  expect(disclosure.open).toBe(false);
  const payload = disclosure.querySelector("pre")!;
  expect(payload).not.toBeVisible();
  expect(JSON.parse(payload.textContent!)).toEqual({
    answer: "Ayan",
    count: 0,
    accepted: false,
  });

  fireEvent.click(screen.getByText("Test submission"));
  expect(disclosure.open).toBe(true);
  expect(payload).toBeVisible();
});

it("shows completion for a starter with an empty payload", () => {
  const preview = projectFlowJsonPreview(META_STARTER_FLOW_JSON)!;
  render(<FlowInteractivePreview config={preview.config} />);
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));

  expect(screen.getByRole("status")).toHaveTextContent("Preview completed");
  const disclosure = screen.getByText("Test submission").closest("details")!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector("pre")!.textContent).toBe("{}");
});

it("retains answers and completion through presentation updates with unchanged session content", () => {
  const { rerender } = render(<FlowInteractivePreview config={config} />);
  complete();
  rerender(
    <FlowInteractivePreview
      config={JSON.parse(JSON.stringify(config))}
      disabled
    />
  );
  expect(screen.getByLabelText("Your answer *")).toHaveValue("Ayan");
  expect(screen.getByRole("status")).toHaveTextContent("Preview completed");
  expect(
    screen.getByRole("button", { name: "Restart preview" })
  ).toBeDisabled();

  rerender(<FlowInteractivePreview config={config} />);
  expect(screen.getByLabelText("Your answer *")).toHaveValue("Ayan");
  expect(screen.getByRole("status")).toHaveTextContent("Preview completed");
});

it("retains answers and completion when only provider metadata changes", () => {
  const initial = {
    ...config,
    metaFlowId: "draft-1",
    metaFlowName: null,
    metaFlowStatus: null,
  };
  const { rerender } = render(<FlowInteractivePreview config={initial} />);
  complete();
  const disclosure = screen.getByText("Test submission").closest("details")!;
  fireEvent.click(screen.getByText("Test submission"));

  rerender(
    <FlowInteractivePreview
      config={{
        ...config,
        metaFlowId: "draft-2",
        metaFlowName: "Saved Flow name",
        metaFlowStatus: "DRAFT",
      }}
    />
  );
  expect(screen.getByLabelText("Your answer *")).toHaveValue("Ayan");
  expect(screen.getByRole("status")).toHaveTextContent("Preview completed");
  expect(screen.getByText("Test submission").closest("details")).toBe(
    disclosure
  );
  expect(disclosure.open).toBe(true);
  expect(JSON.parse(disclosure.querySelector("pre")!.textContent!)).toEqual({
    answer: "Ayan",
    count: 0,
    accepted: false,
  });
});

it.each([
  "Restart",
  "config change",
  "action change",
  "screen change",
] as const)("clears answers and completion on %s", reset => {
  const { rerender } = render(<FlowInteractivePreview config={config} />);
  complete();
  if (reset === "Restart") {
    fireEvent.click(screen.getByRole("button", { name: "Restart preview" }));
  } else if (reset === "config change" || reset === "action change") {
    rerender(
      <FlowInteractivePreview
        config={{
          ...config,
          screens: [
            reset === "config change"
              ? { ...config.screens[0], title: "Changed first screen" }
              : {
                  ...config.screens[0],
                  footer: {
                    label: "Submit",
                    action: {
                      name: "complete",
                      payload: { answer: "${form.answer}", changed: true },
                    },
                  },
                },
            config.screens[1],
          ],
        }}
      />
    );
  } else {
    rerender(
      <FlowInteractivePreview config={config} initialScreenId="SECOND" />
    );
  }
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("Test submission")).toBeNull();
  expect(
    screen.getByLabelText(
      reset === "screen change" ? "Other answer *" : "Your answer *"
    )
  ).toHaveValue("");
});

it("keeps example-data and unsupported-component notices visible after completion", () => {
  render(
    <FlowInteractivePreview
      config={config}
      preview={{
        config,
        componentsByScreen: {
          FIRST: [
            { kind: "unsupported", component: "Image" },
            { kind: "field", fieldId: "answer" },
          ],
        },
        usesExampleData: true,
        totalScreens: 2,
      }}
    />
  );
  complete();
  expect(screen.getByText("simulationExampleData")).toBeVisible();
  expect(
    screen.getByText("simulationUnsupportedComponent:Image")
  ).toBeVisible();
});

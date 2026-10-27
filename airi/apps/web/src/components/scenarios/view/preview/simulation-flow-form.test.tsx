/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  META_STARTER_FLOW_JSON,
  DEMOSHOP_FLOW_JSON,
} from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";
import { projectFlowJsonPreview } from "@/components/scenarios/builders/whatsapp/flow-json-preview";
import { FlowInteractivePreview } from "@/components/scenarios/builders/whatsapp/flow-interactive-preview";
import type {
  WhatsAppFlowConfig,
  WhatsAppFlowPayloadValue,
} from "@icecore/scenario-contracts";
import { SimulationFlowForm } from "./simulation-flow-form";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}));

it("renders a text-only Meta starter and completes its empty payload", () => {
  const preview = projectFlowJsonPreview(META_STARTER_FLOW_JSON)!;
  const onComplete = jest.fn();
  const onSubmit = jest.fn();
  const { container } = render(
    <SimulationFlowForm
      config={preview.config}
      enabled
      onSubmit={onSubmit}
      onComplete={onComplete}
    />
  );
  expect(
    screen.getByRole("heading", { name: "Hello World", level: 4 })
  ).toBeInTheDocument();
  expect(screen.getByText("Let's start building things!")).toBeInTheDocument();
  expect(container.querySelector("input, select, textarea")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(onComplete).toHaveBeenCalledWith({});
  expect(onSubmit).not.toHaveBeenCalled();
});

it("preserves interleaved canonical text and field order without adding text to submitted answers", () => {
  const config: WhatsAppFlowConfig = {
    templateId: "custom",
    ctaText: "Open",
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "START",
        title: "Contact",
        terminal: true,
        fields: [
          {
            id: "last",
            fieldType: "TextInput",
            label: "Last name",
            required: true,
          },
          {
            id: "first",
            fieldType: "TextInput",
            label: "First name",
            required: true,
          },
        ],
        layoutContent: [
          { kind: "text", id: "title", type: "TextHeading", text: "Details" },
          { kind: "field", fieldId: "first" },
          {
            kind: "text",
            id: "section",
            type: "TextSubheading",
            text: "More details",
          },
          {
            kind: "text",
            id: "body",
            type: "TextBody",
            text: "Fill both names",
          },
          { kind: "field", fieldId: "last" },
          {
            kind: "text",
            id: "caption",
            type: "TextCaption",
            text: "Keep this accurate",
          },
        ],
        footer: {
          label: "Send",
          action: {
            name: "complete",
            payload: { first: "${form.first}", last: "${form.last}" },
          },
        },
      },
    ],
  };
  const onSubmit = jest.fn();
  const { container } = render(
    <SimulationFlowForm config={config} enabled onSubmit={onSubmit} />
  );
  const ordered = Array.from(container.querySelector("fieldset")!.children).map(
    child => child.textContent
  );
  expect(ordered).toEqual([
    "Details",
    "First name *",
    "More details",
    "Fill both names",
    "Last name *",
    "Keep this accurate",
  ]);
  expect(
    screen.getByRole("heading", { name: "More details", level: 5 })
  ).toBeInTheDocument();
  expect(screen.getByText("Keep this accurate")).toHaveClass("text-xs");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("First name *"), {
    target: { value: "Ayan" },
  });
  fireEvent.change(screen.getByLabelText("Last name *"), {
    target: { value: "Ali" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onSubmit).toHaveBeenCalledWith({ first: "Ayan", last: "Ali" });
});

function showDemoshop() {
  const preview = projectFlowJsonPreview(DEMOSHOP_FLOW_JSON)!;
  const onSubmit = jest.fn();
  const onComplete = jest.fn();
  render(
    <SimulationFlowForm
      config={preview.config}
      preview={preview}
      enabled
      onSubmit={onSubmit}
      onComplete={onComplete}
    />
  );
  return { onSubmit, onComplete };
}

function fillDetails(name = "Ayan", city = "Shymkent") {
  fireEvent.click(screen.getByRole("radio", { name: /Personalised/ }));
  fireEvent.change(screen.getByLabelText("Athlete's name *"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText("City / region *"), {
    target: { value: city },
  });
}

it.each(["initial mount", "config refresh", "selected screen change"] as const)(
  "keeps property input focus through preview %s",
  change => {
    const preview = projectFlowJsonPreview(DEMOSHOP_FLOW_JSON)!;
    const initial = {
      config: preview.config,
      initialScreenId: "QUESTION_ONE",
      show: change !== "initial mount",
    };
    function Editor({ config, initialScreenId, show }: typeof initial) {
      return (
        <>
          <input aria-label="Screen title property" autoFocus />
          {show ? (
            <FlowInteractivePreview
              config={config}
              initialScreenId={initialScreenId}
            />
          ) : null}
        </>
      );
    }
    const { rerender } = render(<Editor {...initial} />);
    const propertyInput = screen.getByRole("textbox", {
      name: "Screen title property",
    });
    propertyInput.focus();
    const config =
      change === "config refresh"
        ? {
            ...preview.config,
            screens: [
              { ...preview.config.screens[0], title: "Edited sport title" },
              ...preview.config.screens.slice(1),
            ],
          }
        : preview.config;
    rerender(
      <Editor
        config={config}
        initialScreenId={
          change === "selected screen change" ? "DETAILS" : "QUESTION_ONE"
        }
        show
      />
    );
    expect(propertyInput).toHaveFocus();
    expect(screen.getByRole("heading")).not.toHaveFocus();
  }
);

it("keeps an internal NavigationList field name out of the customer screen", () => {
  const preview = projectFlowJsonPreview(DEMOSHOP_FLOW_JSON)!;
  preview.config.screens[0].fields[0].label = "sport_list";
  render(
    <SimulationFlowForm config={preview.config} enabled onSubmit={jest.fn()} />
  );
  expect(
    screen.getByRole("heading", { name: "Choose a sport" })
  ).toBeInTheDocument();
  expect(screen.queryByText("sport_list")).toBeNull();
});

it("submits scalar completion constants through the scenario-compatible callback", () => {
  const onSubmit = jest.fn();
  render(
    <SimulationFlowForm
      config={{
        templateId: "custom",
        ctaText: "Open",
        flowNavigationMode: "static_graph",
        screens: [
          {
            id: "END",
            title: "Result",
            terminal: true,
            fields: [],
            footer: {
              label: "Send",
              action: {
                name: "complete",
                payload: {
                  score: 0,
                  consent: false,
                  text: "  Preserved text  ",
                  choices: ["first", "second"],
                },
              },
            },
          },
        ],
      }}
      enabled
      onSubmit={onSubmit}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onSubmit).toHaveBeenCalledWith({
    score: "0",
    consent: "false",
    text: "  Preserved text  ",
    choices: ["first", "second"],
  });
  expect(screen.queryByText("simulationPayloadUnavailable")).toBeNull();
});

it.each<Record<string, WhatsAppFlowPayloadValue>>([
  { details: { selected: "first" } },
  { nested: [["first"]] },
])(
  "keeps structured completion values unavailable to scenario events: %j",
  payload => {
    const onSubmit = jest.fn();
    render(
      <SimulationFlowForm
        config={{
          templateId: "custom",
          ctaText: "Open",
          flowNavigationMode: "static_graph",
          screens: [
            {
              id: "END",
              title: "Result",
              terminal: true,
              fields: [],
              footer: { label: "Send", action: { name: "complete", payload } },
            },
          ],
        }}
        enabled
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText("simulationPayloadUnavailable")
    ).toBeInTheDocument();
  }
);

it.each([
  ["Football, basketball", "0_Футбол_/_Баскетбол_/_Волейбол"],
  ["Taekwondo, karate, wrestling", "1_Таэквондо_/_Каратэ_/_Күрес"],
  ["Gymnastics, dance", "2_Гимнастика_/_Би"],
])(
  "navigates %s and evaluates the configured completion payload",
  (label, sport) => {
    const { onComplete, onSubmit } = showDemoshop();
    expect(
      screen.getByRole("heading", { name: "Choose a sport" })
    ).not.toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(
      screen.getByRole("heading", { name: "Design and name" })
    ).toHaveFocus();
    expect(screen.getByText("With the athlete's name")).toBeInTheDocument();
    expect(screen.getByText("Write every name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onComplete).toHaveBeenCalledWith({
      __9ba1c9: sport,
      ____133f36: "0_Есімі_жазылатын_(Именная)",
      _68d224: "Ayan",
      _ebfcfb: "Shymkent",
    });
    expect(onSubmit).not.toHaveBeenCalled();
  }
);

it("takes the other terminal path and preserves independent screen answers through Back", () => {
  const { onComplete } = showDemoshop();
  expect(screen.getByText("Write your sport")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Gymnastics, dance" }));
  fillDetails("First athlete", "First city");
  fireEvent.click(screen.getByRole("button", { name: "simulationBack" }));
  expect(screen.getByRole("heading", { name: "Choose a sport" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: /Other sport/ }));
  expect(screen.getByLabelText("Athlete's name *")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fillDetails("Second athlete", "Second city");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Which sport? *"), {
    target: { value: "Chess" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onComplete).toHaveBeenLastCalledWith({
    __9ba1c9: "4_Басқа",
    other_sport: "Chess",
    ____133f36: "0_Есімі_жазылатын_(Именная)",
    _68d224: "Second athlete",
    _ebfcfb: "Second city",
  });
  fireEvent.click(screen.getByRole("button", { name: "simulationBack" }));
  fireEvent.click(screen.getByRole("button", { name: "Gymnastics, dance" }));
  expect(screen.getByLabelText("Athlete's name *")).toHaveValue(
    "First athlete"
  );
  expect(screen.getByLabelText("City / region *")).toHaveValue("First city");
});

it("resets coherently when the selected screen or config changes and labels sample data", () => {
  const preview = projectFlowJsonPreview(DEMOSHOP_FLOW_JSON)!;
  const onComplete = jest.fn();
  const props = {
    config: preview.config,
    preview,
    enabled: true,
    onSubmit: jest.fn(),
    onComplete,
  };
  const { rerender } = render(
    <SimulationFlowForm {...props} initialScreenId="DETAILS" />
  );
  expect(
    screen.getByRole("heading", { name: "Design and name" })
  ).not.toHaveFocus();
  expect(screen.getByText("simulationExampleData")).toBeInTheDocument();
  fillDetails();
  rerender(<SimulationFlowForm {...props} initialScreenId="OTHER_DETAILS" />);
  expect(screen.getByLabelText("Athlete's name *")).toHaveValue("");
  rerender(
    <SimulationFlowForm
      {...props}
      config={{
        ...preview.config,
        screens: [
          { ...preview.config.screens[0], title: "Updated sport selection" },
          ...preview.config.screens.slice(1),
        ],
      }}
    />
  );
  expect(
    screen.getByRole("heading", { name: "Updated sport selection" })
  ).not.toHaveFocus();
});

it("renders supported content with per-component notices and fails closed on unresolved action data", () => {
  const preview = projectFlowJsonPreview({
    version: "7.3",
    screens: [
      {
        id: "START",
        title: "Partial",
        terminal: true,
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextBody", text: "Your details remain visible" },
            { type: "Image", src: "https://example.test/private" },
            { type: "TextInput", name: "name", label: "Name" },
            {
              type: "Footer",
              label: "Send",
              "on-click-action": {
                name: "complete",
                payload: { result: "${data.unavailable}" },
              },
            },
          ],
        },
      },
    ],
  })!;
  const onComplete = jest.fn();
  render(
    <SimulationFlowForm
      config={preview.config}
      preview={preview}
      enabled
      onSubmit={jest.fn()}
      onComplete={onComplete}
    />
  );
  expect(screen.getByText("Your details remain visible")).toBeInTheDocument();
  expect(
    screen.getByText("simulationUnsupportedComponent:Image")
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "simulationPayloadUnavailable"
  );
  expect(onComplete).not.toHaveBeenCalled();
});

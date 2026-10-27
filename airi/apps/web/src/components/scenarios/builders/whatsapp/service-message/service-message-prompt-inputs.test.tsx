/** @jest-environment jsdom */

import type { ScenarioPromptInputField } from "@icecore/scenario-contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ServiceMessagePromptInputs } from "./service-message-prompt-inputs";

const initialFields: ScenarioPromptInputField[] = [
  { key: "name", label: "Name", prompt: "Customer name" },
  { key: "city", label: "City", prompt: "Customer city" },
];
const t = (key: string) => key;
/** Shows ICU values after the key, so summaries can be checked. */
const tWithValues = (key: string, values?: Record<string, unknown>) =>
  values
    ? `${key}:${Object.entries(values)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",")}`
    : key;

function Editor({ initial = initialFields }: { initial?: ScenarioPromptInputField[] }) {
  const [fields, setFields] = useState(initial);
  return (
    <>
      <ServiceMessagePromptInputs
        fields={fields}
        t={t}
        onChange={next => setFields(next.map(field => ({ ...field })))}
        onBehaviorChange={jest.fn()}
      />
      <button onClick={() => setFields(current => [...current].reverse())}>
        Reverse fields
      </button>
      <output data-testid="payload">{JSON.stringify(fields)}</output>
    </>
  );
}

/** Opens the rename popover of the detail at `index` (0-based). */
function openRename(index: number) {
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "whatsappServicePromptInputsRename",
    })[index]!
  );
}

it("keeps the surviving row DOM when a preceding row is deleted", () => {
  render(<Editor />);
  const city = screen.getByLabelText("whatsappServicePromptInputsQuestion 2");
  fireEvent.click(screen.getByLabelText("whatsappServicePromptInputsRemove 1"));
  expect(screen.getByLabelText("whatsappServicePromptInputsQuestion 1")).toBe(
    city
  );
  expect(city).toHaveValue("Customer city");
});

it("keeps focus and row identity while editing the variable name", () => {
  render(<Editor />);
  openRename(0);
  const input = screen.getByLabelText("whatsappServicePromptInputsKey 1");
  input.focus();
  fireEvent.change(input, { target: { value: "customer_name" } });
  expect(screen.getByLabelText("whatsappServicePromptInputsKey 1")).toBe(input);
  expect(input).toHaveFocus();
  expect(JSON.parse(screen.getByTestId("payload").textContent || "[]")[0]).toEqual({
    key: "customer_name", label: "Name", prompt: "Customer name",
  });
});

it("keeps duplicate blank rows distinct without persisting editor IDs", () => {
  render(<Editor initial={[
    { key: "", label: "", prompt: "" },
    { key: "", label: "", prompt: "" },
  ]} />);
  const second = screen.getByLabelText("whatsappServicePromptInputsQuestion 2");
  fireEvent.click(screen.getByLabelText("whatsappServicePromptInputsRemove 1"));
  expect(screen.getByLabelText("whatsappServicePromptInputsQuestion 1")).toBe(
    second
  );
  expect(JSON.parse(screen.getByTestId("payload").textContent || "[]")).toEqual([
    { key: "", label: "", prompt: "" },
  ]);
});

it("keeps row identity when controlled fields are reordered", () => {
  render(<Editor />);
  const name = screen.getByLabelText("whatsappServicePromptInputsQuestion 1");
  const city = screen.getByLabelText("whatsappServicePromptInputsQuestion 2");
  fireEvent.click(screen.getByText("Reverse fields"));
  expect(screen.getByLabelText("whatsappServicePromptInputsQuestion 1")).toBe(
    city
  );
  expect(screen.getByLabelText("whatsappServicePromptInputsQuestion 2")).toBe(
    name
  );
});

it("starts with a single Collect details button", () => {
  const onChange = jest.fn();
  render(
    <ServiceMessagePromptInputs
      fields={undefined}
      t={t}
      onChange={onChange}
      onBehaviorChange={jest.fn()}
    />
  );
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(
    screen.queryByText("whatsappServicePromptInputsTitle")
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappServicePromptInputsAddFirst" })
  );
  expect(onChange).toHaveBeenCalledWith([{ key: "", label: "", prompt: "" }]);
});

it("titles a detail by what it collects and asks the message to request it", () => {
  render(<Editor initial={[{ key: "", label: "", prompt: "" }]} />);
  expect(screen.getByText("whatsappServicePromptInputsAsk")).toBeVisible();
  expect(
    screen.getByText("whatsappServicePromptInputsRowTitle")
  ).toBeVisible();
  fireEvent.change(
    screen.getByLabelText("whatsappServicePromptInputsQuestion 1"),
    { target: { value: "Delivery address" } }
  );
  expect(screen.getByText("Delivery address", { selector: "p" })).toBeVisible();
});

it.each([
  [true, "on"],
  [false, "off"],
])(
  "keeps the paid reminder in the closed reply settings summary (nudge %s)",
  (nudgeOnce, nudge) => {
    render(
      <ServiceMessagePromptInputs
        fields={[{ key: "name", label: "", prompt: "Name" }]}
        ask="choice"
        behavior={{ nudgeOnce }}
        t={tWithValues}
        onChange={jest.fn()}
        onBehaviorChange={jest.fn()}
      />
    );
    expect(
      screen.getByText(
        `whatsappServicePromptInputsReplyRulesSummary:wait=whatsappServicePromptInputsWaitDay,nudge=${nudge}`
      )
    ).toBeVisible();
    expect(screen.queryByText("whatsappServiceExtraCost")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "whatsappServicePromptInputsReplyRules",
      })
    );
    expect(screen.getByText("whatsappServiceExtraCost")).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "whatsappServicePromptInputsNudge" })
    ).toHaveAccessibleDescription("whatsappServicePromptInputsNudgeHint");
  }
);

/**
 * React Flow keeps node data in its own store and copies graph state into it
 * after commit, so an edited node first re-renders with its own row state and
 * the previous `fields`, then with the edited ones.
 */
function createNodeStore(initial: ScenarioPromptInputField[]) {
  let fields = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => fields,
    write: (next: ScenarioPromptInputField[]) => {
      fields = next;
      listeners.forEach(listener => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function StoreHostedNode({
  store,
  onChange,
}: {
  store: ReturnType<typeof createNodeStore>;
  onChange: (fields: ScenarioPromptInputField[]) => void;
}) {
  const fields = useSyncExternalStore(store.subscribe, store.read, store.read);
  return (
    <ServiceMessagePromptInputs
      fields={fields}
      t={t}
      onChange={onChange}
      onBehaviorChange={jest.fn()}
    />
  );
}

function DeferredHostEditor() {
  const [graphFields, setGraphFields] = useState(initialFields);
  const [store] = useState(() => createNodeStore(initialFields));
  useEffect(() => {
    store.write(graphFields.map(field => ({ ...field })));
  }, [graphFields, store]);
  return (
    <>
      <StoreHostedNode store={store} onChange={setGraphFields} />
      <output data-testid="payload">{JSON.stringify(graphFields)}</output>
    </>
  );
}

it.each([
  ["variable name", "whatsappServicePromptInputsKey 1", "key"],
  ["question", "whatsappServicePromptInputsQuestion 1", "prompt"],
] as const)(
  "keeps the %s field mounted and focused when the host delivers edits a commit later",
  async (_label, fieldLabel, property) => {
    const user = userEvent.setup();
    render(<DeferredHostEditor />);
    if (property === "key") openRename(0);
    const input = screen.getByLabelText(fieldLabel);
    await user.click(input);
    for (const character of "abcdefghijklmnopqrst") {
      await user.keyboard(character);
      expect(input.isConnected).toBe(true);
      expect(input).toHaveFocus();
    }
    const [first] = JSON.parse(
      screen.getByTestId("payload").textContent || "[]"
    ) as ScenarioPromptInputField[];
    expect(first[property]).toBe(
      `${initialFields[0][property]}abcdefghijklmnopqrst`
    );
  },
  // Typing 20 characters one by one outlasts the default under a full run.
  15_000
);

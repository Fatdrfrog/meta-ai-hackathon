/**
 * @jest-environment jsdom
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import {
  SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS,
  ScenarioSelectItemContent,
} from "./scenario-select-item-description";
import { installResizeObserver } from "@/test-support/dom-test-utils";

// ui/select reads its scroll-button labels from next-intl (ESM-only in Jest).

const OPTIONS = [
  {
    value: "message",
    label: "Chat message",
    description: "Free. Only within 24 h of the customer's last message.",
  },
  {
    value: "template",
    label: "Template",
    description: "Send anytime. WhatsApp approves it first; may be paid.",
  },
];

const elementPrototype = Element.prototype as unknown as {
  hasPointerCapture?: unknown;
  releasePointerCapture?: unknown;
  scrollIntoView?: unknown;
};

beforeAll(() => {
  elementPrototype.hasPointerCapture = () => false;
  elementPrototype.releasePointerCapture = () => {};
  elementPrototype.scrollIntoView = () => {};
  installResizeObserver();
});

function MessageTypeSelect({
  onValueChange = jest.fn(),
}: {
  onValueChange?: (value: string) => void;
}) {
  return (
    <Select defaultValue="message" onValueChange={onValueChange}>
      <SelectTrigger
        aria-label="Message type"
        className={SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map(option => (
          <SelectItem
            key={option.value}
            value={option.value}
            textValue={option.label}
          >
            <ScenarioSelectItemContent
              label={option.label}
              description={option.description}
            />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

describe("ScenarioSelectItemContent", () => {
  it("stacks the label above a muted description", () => {
    render(
      <ScenarioSelectItemContent
        label="Has these words"
        description="e.g. “yes, please” matches “yes”"
      />
    );

    const label = screen.getByText("Has these words");
    const description = screen.getByText("e.g. “yes, please” matches “yes”");
    const stack = label.parentElement;
    expect(stack).toBe(description.parentElement);
    expect(stack).toHaveClass("flex", "flex-col", "items-start");
    expect(description).toHaveAttribute("data-select-description");
    expect(description).toHaveClass("text-muted-foreground");
  });

  it("hides the description in the closed trigger", () => {
    render(<MessageTypeSelect />);

    const trigger = screen.getByRole("combobox", { name: "Message type" });
    expect(trigger).toHaveClass("[&_[data-select-description]]:hidden");
    expect(trigger).toHaveTextContent("Chat message");
    expect(
      trigger.querySelector("[data-select-description]")
    ).toBeInTheDocument();
  });

  it("shows each description in the open list", async () => {
    const user = userEvent.setup();
    render(<MessageTypeSelect />);

    await user.click(screen.getByRole("combobox", { name: "Message type" }));
    const template = screen.getByRole("option", { name: /Template/ });
    expect(template).toHaveTextContent(
      "Send anytime. WhatsApp approves it first; may be paid."
    );
  });

  it.each([
    // "T" starts the template's label.
    ["t", "template"],
    // "S" starts the template's description, not any label.
    ["s", undefined],
  ])("matches typeahead %s against the labels only", async (key, expected) => {
    const user = userEvent.setup();
    const onValueChange = jest.fn();
    render(<MessageTypeSelect onValueChange={onValueChange} />);

    screen.getByRole("combobox", { name: "Message type" }).focus();
    await user.keyboard(key);

    if (expected) {
      expect(onValueChange).toHaveBeenCalledWith(expected);
    } else {
      expect(onValueChange).not.toHaveBeenCalled();
    }
  });
});

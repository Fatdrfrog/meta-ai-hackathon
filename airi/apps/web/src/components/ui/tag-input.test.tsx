/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TagInput } from "./tag-input";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values?.tag ? `${key} ${values.tag}` : key,
}));

describe("TagInput", () => {
  it("renders selected tag remove controls as named non-submit buttons", () => {
    render(<TagInput value={["Enterprise"]} onChange={jest.fn()} />);

    const removeButton = screen.getByRole("button", {
      name: "removeTag Enterprise",
    });

    expect(removeButton.getAttribute("type")).toBe("button");
  });

  it("allows long suggestions to wrap inside narrow mobile forms", () => {
    render(
      <TagInput
        value={[]}
        onChange={jest.fn()}
        suggestions={["AiContextManager.customerRetention"]}
      />
    );

    const suggestion = screen.getByRole("button", {
      name: "AiContextManager.customerRetention",
    });

    expect(suggestion.className).toContain("max-w-full");
    expect(suggestion.className).toContain("whitespace-normal");
    expect(suggestion.className).toContain("break-words");
  });

  it("names its input for an outside label", () => {
    render(
      <>
        <label htmlFor="answers">Accepted answers</label>
        <TagInput
          id="answers"
          aria-label="Accepted answers 1"
          value={[]}
          onChange={jest.fn()}
        />
      </>
    );

    const input = screen.getByRole("textbox", { name: "Accepted answers 1" });
    expect(input).toHaveAttribute("id", "answers");
  });

  it("keeps typed text as a tag on blur only when asked", () => {
    const onChange = jest.fn();
    const { rerender } = render(<TagInput value={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "Gold" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();

    rerender(<TagInput value={[]} onChange={onChange} commitOnBlur />);
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onChange).toHaveBeenCalledWith(["Gold"]);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("adds a tag on Enter and on a comma", () => {
    const onChange = jest.fn();
    render(<TagInput value={["Gold"]} onChange={onChange} />);
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "Silver" } });
    fireEvent.keyDown(input, { key: "," });
    expect(onChange).toHaveBeenLastCalledWith(["Gold", "Silver"]);
  });
});

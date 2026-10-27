/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render } from "@testing-library/react";
import { MentionTextarea } from "./mention-textarea";

describe("MentionTextarea", () => {
  it("caps height and keeps the decorated overlay scrolled with the textarea", () => {
    const renderTextarea = (value: string) => (
      <MentionTextarea
        value={value}
        onValueChange={() => undefined}
        renderValue={value => value}
        placeholder="Prompt"
        minHeight={40}
        maxHeight={80}
      />
    );
    const { getByRole, getByTestId, rerender } = render(renderTextarea("one"));
    const textarea = getByRole("textbox");
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 160,
    });
    rerender(renderTextarea("one\ntwo\nthree\nfour"));
    expect(textarea).toHaveStyle({ height: "80px", overflowY: "auto" });

    fireEvent.scroll(textarea, { target: { scrollTop: 36 } });
    expect(getByTestId("mention-textarea-overlay")).toHaveStyle({
      transform: "translate(0px, -36px)",
    });
  });

  it("resets the overlay translation when a controlled value update clamps native scroll", () => {
    const renderTextarea = (value: string) => (
      <MentionTextarea
        value={value}
        onValueChange={() => undefined}
        renderValue={value => value}
        placeholder="Prompt"
        minHeight={40}
        maxHeight={80}
      />
    );
    const { getByRole, getByTestId, rerender } = render(
      renderTextarea("one\ntwo\nthree\nfour")
    );
    const textarea = getByRole("textbox");

    fireEvent.scroll(textarea, { target: { scrollTop: 36 } });
    expect(getByTestId("mention-textarea-overlay")).toHaveStyle({
      transform: "translate(0px, -36px)",
    });

    Object.defineProperties(textarea, {
      scrollLeft: { configurable: true, value: 0 },
      scrollTop: { configurable: true, value: 0 },
    });
    rerender(renderTextarea(""));

    expect(getByTestId("mention-textarea-overlay")).toHaveStyle({
      transform: "translate(0px, 0px)",
    });
  });

  it("renders an accessible-name fallback and muted empty placeholder", () => {
    const { getByRole, getByText, queryByRole, rerender } = render(
      <MentionTextarea
        value=""
        onValueChange={() => undefined}
        renderValue={value => value}
        placeholder="Prompt"
        minHeight={40}
        maxHeight={80}
      />
    );

    expect(getByRole("textbox", { name: "Prompt" })).toBeInTheDocument();
    expect(getByText("Prompt")).toHaveClass("text-muted-foreground");

    rerender(
      <MentionTextarea
        value=""
        onValueChange={() => undefined}
        renderValue={value => value}
        placeholder="Prompt"
        minHeight={40}
        maxHeight={80}
        aria-label="Ask Airi"
      />
    );

    expect(getByRole("textbox", { name: "Ask Airi" })).toBeInTheDocument();
    expect(queryByRole("textbox", { name: "Prompt" })).not.toBeInTheDocument();
  });

  it("preserves native and dedicated textarea classes", () => {
    const { getByRole } = render(
      <MentionTextarea
        value=""
        onValueChange={() => undefined}
        renderValue={value => value}
        placeholder="Prompt"
        minHeight={40}
        maxHeight={80}
        className="native-textarea-class"
        textareaClassName="mention-textarea-class"
      />
    );

    expect(getByRole("textbox")).toHaveClass(
      "native-textarea-class",
      "mention-textarea-class"
    );
  });
});

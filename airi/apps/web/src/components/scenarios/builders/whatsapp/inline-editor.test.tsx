/** @jest-environment jsdom */

import { act, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { renderToString } from "react-dom/server";
import { WhatsAppInlineEditor } from "./inline-editor";

// Variable chips inside the editor read their labels from the catalog.

describe("WhatsAppInlineEditor external value synchronization", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(["typing", "undo"])(
    "publishes %s immediately after a parent value update without echoing that update",
    async input => {
      const onChange = jest.fn();
      const { container, rerender } = render(
        <WhatsAppInlineEditor value="Original" onChange={onChange} />
      );
      await waitFor(() =>
        expect(container.querySelector("[contenteditable=true]")).not.toBeNull()
      );
      const element = container.querySelector(
        "[contenteditable=true]"
      ) as HTMLElement & { editor: Editor };
      const editor = element.editor;
      jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

      rerender(<WhatsAppInlineEditor value="External" onChange={onChange} />);
      expect(editor.getText()).toBe("External");
      expect(onChange).not.toHaveBeenCalled();

      act(() => {
        if (input === "typing")
          editor.commands.insertContentAt(
            editor.state.doc.content.size - 1,
            " edit"
          );
        else editor.commands.undo();
      });
      const expected = input === "typing" ? "External edit" : "Original";
      expect(editor.getText()).toBe(expected);
      expect(onChange).toHaveBeenLastCalledWith(expected);
    }
  );
});

describe("WhatsAppInlineEditor accessible name", () => {
  async function editorFor(props: {
    ariaLabel?: string;
    placeholder?: string;
  }) {
    const { container } = render(
      <WhatsAppInlineEditor value="" onChange={jest.fn()} {...props} />
    );
    await waitFor(() =>
      expect(container.querySelector("[contenteditable=true]")).not.toBeNull()
    );
    return container.querySelector("[contenteditable=true]") as HTMLElement;
  }

  it("uses the label it is given rather than the placeholder", async () => {
    const editor = await editorFor({
      ariaLabel: "Message text",
      placeholder: "e.g. Hello",
    });
    expect(editor.getAttribute("aria-label")).toBe("Message text");
  });

  it("never falls back to hard-coded English", async () => {
    const editor = await editorFor({});
    expect(editor.hasAttribute("aria-label")).toBe(false);
  });
});

describe("WhatsAppInlineEditor error", () => {
  it("marks the field invalid and points it at the error line", async () => {
    const { container, rerender } = render(
      <WhatsAppInlineEditor value="" onChange={jest.fn()} />
    );
    await waitFor(() =>
      expect(container.querySelector("[contenteditable=true]")).not.toBeNull()
    );
    const editor = container.querySelector(
      "[contenteditable=true]"
    ) as HTMLElement;
    expect(editor.getAttribute("aria-invalid")).toBe("false");
    expect(editor.hasAttribute("aria-describedby")).toBe(false);

    rerender(
      <WhatsAppInlineEditor
        value=""
        onChange={jest.fn()}
        error="Add message text"
      />
    );
    await waitFor(() =>
      expect(editor.getAttribute("aria-invalid")).toBe("true")
    );
    const describedBy = editor.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      "Add message text"
    );

    rerender(<WhatsAppInlineEditor value="" onChange={jest.fn()} />);
    await waitFor(() =>
      expect(editor.getAttribute("aria-invalid")).toBe("false")
    );
    expect(editor.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("WhatsAppInlineEditor before its editor exists", () => {
  it("lays out the message instead of rendering nothing", async () => {
    // Server rendering runs no effect, so the editor is not created yet.
    const html = renderToString(
      <WhatsAppInlineEditor
        value="Hello there"
        onChange={jest.fn()}
        className="min-h-[88px]"
        error="Label is required"
      />
    );
    expect(html).toContain("Hello there");
    expect(html).toContain("min-h-[88px]");
    expect(html).toContain("Label is required");

    const { container } = render(
      <WhatsAppInlineEditor value="Hello there" onChange={jest.fn()} />
    );
    await waitFor(() =>
      expect(container.querySelector("[contenteditable=true]")).not.toBeNull()
    );
    // The editor replaces the laid-out text: the message shows once.
    expect(container.querySelector("[contenteditable=true]")?.textContent).toBe(
      "Hello there"
    );
    expect(container.querySelector("[data-inline-editor-fallback]")).toBeNull();
  });

  it("lays out line breaks, formatting and variables as the editor does", async () => {
    const value = "Hi *{{customer.name}}*,\n\nyour _order_ ~is~ ```ready```";
    const resolveVariableLabel = (token: string) => `Label of ${token}`;
    const fallback = document.createElement("div");
    fallback.innerHTML = renderToString(
      <WhatsAppInlineEditor
        value={value}
        onChange={jest.fn()}
        resolveVariableLabel={resolveVariableLabel}
      />
    );
    const { container } = render(
      <WhatsAppInlineEditor
        value={value}
        onChange={jest.fn()}
        resolveVariableLabel={resolveVariableLabel}
      />
    );
    await waitFor(() =>
      expect(container.querySelector("[contenteditable=true]")).not.toBeNull()
    );
    const editor = container.querySelector("[contenteditable=true]")!;
    // Chips are React node views that render after the editor.
    await waitFor(() =>
      expect(editor.querySelector(".scenario-variable-chip")).not.toBeNull()
    );
    const content = fallback.querySelector(
      ".whatsapp-inline-editor p"
    )!.parentElement!;

    // The same content classes, paragraphs, lines, marks and chips.
    for (const className of editor.classList) {
      if (!["tiptap", "ProseMirror"].includes(className))
        expect(content.classList).toContain(className);
    }
    expect(content.querySelectorAll("p")).toHaveLength(
      editor.querySelectorAll("p").length
    );
    // The editor breaks lines with <br>; the fallback keeps the newlines.
    const lines = (root: Element) =>
      root
        .querySelector("p")!
        .innerHTML.replace(/<br[^>]*>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .split("\n");
    expect(lines(content)).toEqual(lines(editor));
    for (const tag of ["strong", "em", "s", "code"]) {
      expect(content.querySelector(tag)?.textContent).toBe(
        editor.querySelector(tag)?.textContent
      );
    }
    expect(content.textContent).not.toMatch(/[*_~`{}]/);
    expect(content.querySelector(".scenario-variable-chip")?.textContent).toBe(
      editor.querySelector(".scenario-variable-chip")?.textContent
    );
  });
});

/**
 * @jest-environment jsdom
 */

import {
  buildServiceMessageFieldErrors,
  diagnosticFieldKey,
  fieldErrorMessage,
  findServiceMessageFieldTarget,
  firstServiceMessageFieldKey,
  hasServiceMessageField,
  scrollToServiceMessageField,
} from "./service-message-field-errors";

describe("service-message-field-errors", () => {
  it("strips message. prefix from diagnostic paths", () => {
    expect(diagnosticFieldKey("message.cards.0.interaction.options.2.label")).toBe(
      "cards.0.interaction.options.2.label"
    );
    expect(diagnosticFieldKey("message.body")).toBe("body");
    expect(diagnosticFieldKey("message")).toBeNull();
  });

  it("builds a map keyed by field path with the first error per field", () => {
    const map = buildServiceMessageFieldErrors({
      diagnostics: [
        {
          code: "button_label_required",
          path: "message.cards.0.interaction.options.2.label",
        },
        {
          code: "button_label_too_long",
          path: "message.cards.0.interaction.options.2.label",
        },
        { code: "media_required", path: "message.cards.1.media" },
      ],
      messageForCode: code => `msg:${code}`,
    });

    expect(fieldErrorMessage(map, "cards.0.interaction.options.2.label")).toBe(
      "msg:button_label_required"
    );
    expect(fieldErrorMessage(map, "cards.1.media")).toBe("msg:media_required");
    expect(firstServiceMessageFieldKey(map)).toBe(
      "cards.0.interaction.options.2.label"
    );
  });

  it("tells the message which field the error is in", () => {
    const messageForCode = jest.fn(() => "msg");
    buildServiceMessageFieldErrors({
      diagnostics: [{ code: "body_too_long", path: "message.cards.1.bodyText" }],
      messageForCode,
    });
    expect(messageForCode).toHaveBeenCalledWith(
      "body_too_long",
      "cards.1.bodyText"
    );
  });
});

describe("scrollToServiceMessageField", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
    document.body.innerHTML = "";
  });

  it("focuses the text field of a group before a button that removes an item", () => {
    document.body.innerHTML = `
      <div data-sm-field="promptInputs.0.choices">
        <button type="button">Remove Small</button>
        <input type="text" aria-label="Accepted answers" />
      </div>`;
    expect(scrollToServiceMessageField("promptInputs.0.choices")).toBe(true);
    expect(document.activeElement).toBe(document.querySelector("input"));
  });

  it("falls back to a button when the group has no text field", () => {
    document.body.innerHTML = `
      <div data-sm-field="sections">
        <button type="button" disabled>Add section</button>
        <button type="button">Add option</button>
      </div>`;
    scrollToServiceMessageField("sections");
    expect(document.activeElement?.textContent).toBe("Add option");
  });

  it("focuses an error marked as the field itself", () => {
    document.body.innerHTML = `
      <section data-sm-field="promptInputs.0">
        <button type="button">Delete detail 1</button>
        <p data-sm-field="promptInputs">Write the text yourself.</p>
      </section>`;
    scrollToServiceMessageField("promptInputs");
    const error = document.querySelector("p");
    expect(document.activeElement).toBe(error);
    expect(error).toHaveProperty("tabIndex", -1);
  });

  it("tells an exact field from a group that only contains it", () => {
    document.body.innerHTML = `<div data-sm-field="options"><div data-sm-field="options.0.label"></div></div>`;
    expect(hasServiceMessageField("options.0.label", document)).toBe(true);
    expect(hasServiceMessageField("options.0.id", document)).toBe(false);
    expect(findServiceMessageFieldTarget("options.0.id")).toBe(
      document.querySelector("[data-sm-field=options]")
    );
    expect(findServiceMessageFieldTarget("cards")).toBeNull();
    expect(scrollToServiceMessageField("cards")).toBe(false);
  });
});

/**
 * @jest-environment jsdom
 */

import {
  isScenarioKeyboardControlTarget,
  stopScenarioKeyboardPropagationFromEditableTarget,
} from "./scenario-keyboard-events";

describe("scenario keyboard events", () => {
  it.each([
    '<button><svg><path id="target" /></svg></button>',
    '<div role="dialog"><div id="target" /></div>',
    '<div role="listbox"><div role="option" id="target" /></div>',
    '<div contenteditable="plaintext-only"><span id="target" /></div>',
    '<div data-scenario-stop-keyboard-propagation="true"><span id="target" /></div>',
  ])("protects keyboard controls and their nested targets: %s", html => {
    const container = document.createElement("div");
    container.innerHTML = html;
    const target = container.querySelector("#target");
    const event = { target, stopPropagation: jest.fn() };
    stopScenarioKeyboardPropagationFromEditableTarget(event as never);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(isScenarioKeyboardControlTarget(target)).toBe(true);
  });

  it("leaves canvas shortcuts available outside controls", () => {
    const target = document.createElement("div");
    const event = { target, stopPropagation: jest.fn() };
    stopScenarioKeyboardPropagationFromEditableTarget(event as never);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(isScenarioKeyboardControlTarget(target)).toBe(false);
  });

  it("stops propagation when the target is inside an editable element", () => {
    document.body.innerHTML = '<div><input id="input" /></div>';
    const input = document.getElementById("input");
    const event = {
      target: input,
      stopPropagation: jest.fn(),
    };

    stopScenarioKeyboardPropagationFromEditableTarget(event as never);

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

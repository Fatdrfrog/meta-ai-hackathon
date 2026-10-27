import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const KEYBOARD_CONTROL_TARGET_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='option']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[data-scenario-stop-keyboard-propagation='true']",
].join(",");

// Canvas shortcuts run in capture phase, before a field can stop bubbling.
// Share this guard with those shortcuts, including controls rendered in portals.
export function isScenarioKeyboardControlTarget(
  target: EventTarget | null
): boolean {
  return (
    typeof Element !== "undefined" &&
    target instanceof Element &&
    Boolean(target.closest(KEYBOARD_CONTROL_TARGET_SELECTOR))
  );
}

export function stopScenarioKeyboardPropagationFromEditableTarget(
  event: ReactKeyboardEvent<HTMLElement>
) {
  if (!isScenarioKeyboardControlTarget(event.target)) return;
  event.stopPropagation();
}

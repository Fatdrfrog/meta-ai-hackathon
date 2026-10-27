const SCENARIO_COLLAPSIBLE_SELECTOR = "[data-scenario-collapsible]";

/** Dispatched on a section root to ask a closed section to open. */
export const SCENARIO_COLLAPSIBLE_OPEN_EVENT = "scenario-collapsible-open";

/** Opens every closed section around `element`, innermost first. */
export function openScenarioCollapsibleAncestors(element: Element): void {
  let section = element.closest(SCENARIO_COLLAPSIBLE_SELECTOR);
  while (section) {
    if (section.getAttribute("data-state") === "closed") {
      section.dispatchEvent(new Event(SCENARIO_COLLAPSIBLE_OPEN_EVENT));
    }
    section =
      section.parentElement?.closest(SCENARIO_COLLAPSIBLE_SELECTOR) ?? null;
  }
}

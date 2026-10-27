/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MetricHelpTooltip } from "./metric-help-tooltip";
import { installResizeObserver } from "@/test-support/dom-test-utils";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    key === "metricDefinition" ? "Definition" : key,
}));

describe("MetricHelpTooltip", () => {
  beforeAll(() => {
    installResizeObserver();
  });

  it("keeps the shared tooltip arrow by default", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Shared help</TooltipTrigger>
          <TooltipContent>Shared definition</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    await user.tab();
    expect(await screen.findByRole("tooltip")).not.toBeNull();
    expect(
      document.querySelector('[data-slot="tooltip-content"] svg')
    ).not.toBeNull();
  });

  it("exposes a text definition action, opens on keyboard focus, and closes on Escape without SVG", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <MetricHelpTooltip
          label="First response time"
          text="Time until the first reply in the selected period."
        />
      </TooltipProvider>
    );
    const trigger = screen.getByRole("button", { name: /First response time/ });
    expect(trigger.textContent).toBe("Definition");
    expect(trigger.getAttribute("aria-label")).toContain("Definition");
    await user.tab();
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Time until the first reply in the selected period."
    );
    expect(document.querySelector("svg")).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

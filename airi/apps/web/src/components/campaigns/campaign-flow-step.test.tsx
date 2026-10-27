/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import { CampaignFlowStep } from "./campaign-flow-step";

describe("CampaignFlowStep", () => {
  it("renders a numbered step heading and keeps actions in the body", () => {
    render(
      <CampaignFlowStep step={2} title="Message">
        <button type="button">Choose template</button>
      </CampaignFlowStep>
    );

    const step = screen.getByTestId("campaign-flow-step");
    expect(step.getAttribute("data-step")).toBe("2");
    expect(screen.getByRole("heading", { name: "Message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose template" })).toBeTruthy();
    expect(step.className).not.toContain("border");
  });

  it("lets the send step sit flush so the primary CTA stays full width", () => {
    render(
      <CampaignFlowStep step={4} title="Send" flush>
        <button type="button">Send</button>
      </CampaignFlowStep>
    );

    const body = screen.getByRole("button", { name: "Send" }).parentElement;
    expect(body?.className).not.toContain("sm:pl-10");
  });
});

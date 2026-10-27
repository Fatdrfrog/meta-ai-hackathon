/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import TermsOfServicePage from "./page";

jest.mock("@/components/landing/page-header", () => ({
  LandingPageHeader: () => null,
}));

// The real viewer reads request cookies, which do not exist outside a request.
jest.mock("@/lib/landing/landing-header-viewer.server", () => ({
  getLandingHeaderViewerForRequest: async () => null,
}));

describe("Terms of Service", () => {
  // Regression: section 8 still described a helpdesk integration (its Client
  // Secret, "analytics and coaching features") after that integration was
  // removed.
  it("describes the platforms customers actually connect", async () => {
    const { container } = render(await TermsOfServicePage());
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/Client Secret|coaching/i);
    expect(text).toContain("WhatsApp Business Platform");
    expect(text).toMatch(/consent or opt-in/);
    expect(text).toMatch(/Changes to\s+Meta Ads campaigns require/);
  });
});

/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import PrivacyPolicyPage from "./page";

jest.mock("@/components/landing/page-header", () => ({
  LandingPageHeader: () => null,
}));

// The real viewer reads request cookies, which do not exist outside a request.
jest.mock("@/lib/landing/landing-header-viewer.server", () => ({
  getLandingHeaderViewerForRequest: async () => null,
}));

describe("Privacy Policy", () => {
  // Regression: the policy named helpdesk platforms as integrations and
  // listed a vendor called "Realtime for realtime" after a bad replacement.
  it("names the platforms and providers the product actually uses", async () => {
    const { container } = render(await PrivacyPolicyPage());
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/helpdesk|Realtime for realtime/i);
    expect(text).toContain("WhatsApp Business Platform");
    for (const provider of [
      "Vercel",
      "Google Cloud",
      "Supabase",
      "MongoDB Atlas",
      "Temporal",
      "Postmark",
      "PostHog",
      "Anthropic (Claude)",
      "Google (Gemini)",
    ]) {
      expect(text).toContain(provider);
    }
    expect(text).toContain("AI replies");
  });
});

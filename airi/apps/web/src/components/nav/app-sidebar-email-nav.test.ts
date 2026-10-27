import { shouldShowEmailAutomationNav } from "./app-sidebar-email-nav";

describe("shouldShowEmailAutomationNav", () => {
  it("shows email automation when the email provider is connected without requiring active address rows", () => {
    expect(
      shouldShowEmailAutomationNav({
        emailProviderConnected: true,
        emailSources: [],
      })
    ).toBe(true);
  });

  it("hides email automation when the email provider is not connected", () => {
    expect(
      shouldShowEmailAutomationNav({
        emailProviderConnected: false,
        emailSources: [{ id: "address-1" }],
      })
    ).toBe(false);
  });
});

import { panelConnectWhatsAppOnboardingHref } from "./hrefs";

describe("panelConnectWhatsAppOnboardingHref", () => {
  it("opens Integrations with WhatsApp preselected and the onboarding toast", () => {
    expect(panelConnectWhatsAppOnboardingHref("workspace-1")).toBe(
      "/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp"
    );
  });

  it("encodes the workspace id", () => {
    expect(panelConnectWhatsAppOnboardingHref("a/b")).toBe(
      "/panel/w/a%2Fb/settings/integrations?new=true&integration=whatsapp"
    );
  });
});

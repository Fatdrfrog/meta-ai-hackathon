import {
  buildIntegrationSelectionUrl,
  getSelectedIntegrationId,
} from "./integration-selection-url";

describe("integration selection URL helpers", () => {
  it("selects an integration on the current page without preserving stale source state", () => {
    const result = buildIntegrationSelectionUrl({
      pathname: "/panel/w/workspace-1/settings/integrations",
      currentSearch:
        "type=whatsapp&error=oauth_failed&warning=webhook_failed&new=true&utm=keep&whatsapp_mode=coexistence",
      integrationId: "instagram",
    });

    expect(result).toEqual({
      href: "/panel/w/workspace-1/settings/integrations?utm=keep&integration=instagram",
      search: "utm=keep&integration=instagram",
    });
  });

  it("preserves WhatsApp setup mode only while WhatsApp remains selected", () => {
    expect(
      buildIntegrationSelectionUrl({
        pathname: "/panel/w/workspace-1/settings/integrations",
        currentSearch: "integration=whatsapp&whatsapp_mode=coexistence",
        integrationId: "whatsapp",
      }).href
    ).toBe(
      "/panel/w/workspace-1/settings/integrations?integration=whatsapp&whatsapp_mode=coexistence"
    );

    expect(
      buildIntegrationSelectionUrl({
        pathname: "/panel/w/workspace-1/settings/integrations",
        currentSearch: "integration=whatsapp&whatsapp_mode=coexistence",
        integrationId: null,
      }).href
    ).toBe("/panel/w/workspace-1/settings/integrations");
  });

  it("derives the selected integration from integration first, then type", () => {
    expect(
      getSelectedIntegrationId(
        new URLSearchParams("type=whatsapp&integration=instagram")
      )
    ).toBe("instagram");
    expect(
      getSelectedIntegrationId(new URLSearchParams("type=all"))
    ).toBeNull();
    expect(getSelectedIntegrationId(new URLSearchParams("type=whatsapp"))).toBe(
      "whatsapp"
    );
  });
});

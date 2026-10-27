import { getWhatsAppAppPermissionSummary } from "./route";

describe("getWhatsAppAppPermissionSummary", () => {
  it("treats live app permissions as available for Tech Provider apps", () => {
    expect(
      getWhatsAppAppPermissionSummary([
        { permission: "whatsapp_business_management", status: "live" },
        { permission: "whatsapp_business_messaging", status: "live" },
      ])
    ).toEqual({
      hasManagement: true,
      hasMessaging: true,
      hasRequiredWhatsAppPermissions: true,
      missingPermissions: [],
    });
  });

  it("still accepts granted token-style permission status", () => {
    expect(
      getWhatsAppAppPermissionSummary([
        { permission: "whatsapp_business_management", status: "granted" },
        { permission: "whatsapp_business_messaging", status: "granted" },
      ]).hasRequiredWhatsAppPermissions
    ).toBe(true);
  });
});

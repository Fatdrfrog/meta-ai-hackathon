import { readQrE2eEnv } from "../../../../e2e/fixtures/auth";

describe("readQrE2eEnv", () => {
  it("fails with each missing required QR E2E variable", () => {
    expect(() => readQrE2eEnv({} as never)).toThrow(
      "WhatsApp QR E2E requires TEST_WORKSPACE_ID, TEST_MANAGER_EMAIL, TEST_MANAGER_PASSWORD, and TEST_WHATSAPP_QR_SCENARIO_ID. Missing: TEST_WORKSPACE_ID, TEST_MANAGER_EMAIL, TEST_MANAGER_PASSWORD, TEST_WHATSAPP_QR_SCENARIO_ID"
    );
  });

  it("reads trimmed QR E2E configuration", () => {
    expect(
      readQrE2eEnv({
        NEXT_PUBLIC_APP_URL: " https://staging.airi.chat ",
        TEST_WORKSPACE_ID: " workspace-id ",
        TEST_MANAGER_EMAIL: " manager@airi.chat ",
        TEST_MANAGER_PASSWORD: " password ",
        TEST_WHATSAPP_QR_SCENARIO_ID: " scenario-id ",
      } as never)
    ).toEqual({
      appUrl: "https://staging.airi.chat",
      workspaceId: "workspace-id",
      managerEmail: "manager@airi.chat",
      managerPassword: "password",
      scenarioId: "scenario-id",
    });
  });
});

import {
  DEFAULT_EMAIL_AUTOMATION_SETTINGS,
  normalizeEmailAutomationSettings,
} from "./email-automation-settings";

describe("normalizeEmailAutomationSettings", () => {
  it("defaults registration follow-up automation to enabled", () => {
    expect(normalizeEmailAutomationSettings(null)).toEqual(
      DEFAULT_EMAIL_AUTOMATION_SETTINGS
    );
  });

  it("preserves an explicit disabled registration follow-up setting", () => {
    expect(
      normalizeEmailAutomationSettings({
        registrationFollowUpEnabled: false,
      })
    ).toEqual({
      registrationFollowUpEnabled: false,
      registrationFollowUpTemplate:
        DEFAULT_EMAIL_AUTOMATION_SETTINGS.registrationFollowUpTemplate,
    });
  });

  it("normalizes custom registration follow-up template content", () => {
    expect(
      normalizeEmailAutomationSettings({
        registrationFollowUpEnabled: true,
        registrationFollowUpTemplate: {
          subject: "  Welcome, {{userName}}  ",
          markdown: "\n# Hi {{userName}}\n\nOpen {{setupUrl}}\n",
        },
      })
    ).toEqual({
      registrationFollowUpEnabled: true,
      registrationFollowUpTemplate: {
        subject: "Welcome, {{userName}}",
        markdown: "# Hi {{userName}}\n\nOpen {{setupUrl}}",
      },
    });
  });
});

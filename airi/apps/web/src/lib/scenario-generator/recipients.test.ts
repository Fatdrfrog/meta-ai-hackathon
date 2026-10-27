import {
  buildRecipientCohorts,
  resolveScenarioGeneratorRecipients,
} from "./recipients";

describe("resolveScenarioGeneratorRecipients", () => {
  it("emits a recipient for every selected channel with a matching identifier", () => {
    const recipients = [
      {
        phone: "+1 (555) 123-4567",
        email: "VIP@example.com",
        chatId: "telegram-42",
        name: "VIP User",
        fields: { segment: "VIP" },
      },
    ];
    const cohorts = buildRecipientCohorts(recipients);

    expect(
      resolveScenarioGeneratorRecipients({
        channels: ["whatsapp", "email", "telegram"],
        recipients,
        cohorts,
      })
    ).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        recipient: "15551234567",
        cohortId: "vip",
      }),
      expect.objectContaining({
        channel: "telegram",
        recipient: "telegram-42",
        cohortId: "vip",
      }),
      expect.objectContaining({
        channel: "email",
        recipient: "vip@example.com",
        cohortId: "vip",
      }),
    ]);
  });
});

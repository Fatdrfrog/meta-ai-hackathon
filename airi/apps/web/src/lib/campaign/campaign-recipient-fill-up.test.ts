import {
  mergeCampaignRecipientsWithFillUp,
  resolveCampaignFillUpCapacity,
} from "./campaign-recipient-fill-up";

describe("campaign recipient fill-up", () => {
  it("keeps base recipients first, appends unique fill-up recipients, and respects the max", () => {
    const result = mergeCampaignRecipientsWithFillUp({
      channel: "whatsapp",
      baseRecipients: [{ phone: "+7 700 000 0001" }, { phone: "77000000002" }],
      fillUpRecipients: [
        { phone: "wa_77000000001" },
        { phone: "+7 700 000 0003" },
        { phone: "+7 700 000 0004" },
        { phone: "+7 700 000 0005" },
      ],
      maxRecipients: 4,
    });

    expect(result.recipients.map(recipient => recipient.phone)).toEqual([
      "+7 700 000 0001",
      "77000000002",
      "+7 700 000 0003",
      "+7 700 000 0004",
    ]);
    expect(result.acceptedFillUpCount).toBe(2);
    expect(result.duplicateFillUpCount).toBe(1);
    expect(result.truncatedFillUpCount).toBe(1);
  });

  it("reports remaining fill-up capacity from the official recipient limit", () => {
    expect(
      resolveCampaignFillUpCapacity({
        baseRecipientCount: 750,
        fillUpRecipientCount: 400,
        maxRecipients: 1000,
      })
    ).toEqual({
      remainingCapacity: 250,
      acceptedFillUpCount: 250,
      truncatedFillUpCount: 150,
    });
  });

  it("treats an unavailable zero recipient limit as no fill-up capacity", () => {
    expect(
      resolveCampaignFillUpCapacity({
        baseRecipientCount: 0,
        fillUpRecipientCount: 10,
        maxRecipients: 0,
      })
    ).toEqual({
      remainingCapacity: 0,
      acceptedFillUpCount: 0,
      truncatedFillUpCount: 10,
    });
  });
});

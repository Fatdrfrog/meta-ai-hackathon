import { buildBirthdayRecipientPlan } from "./campaign-birthday-recipient-plan";

describe("buildBirthdayRecipientPlan", () => {
  it("counts selected uploaded birthday recipients by calendar day", () => {
    const plan = buildBirthdayRecipientPlan({
      recipients: [
        { phone: "+77000000001", birthday: "12.05" },
        { phone: "+77000000002", birthday: "05-12" },
        { phone: "+77000000003", birthday: "1992-06-01" },
      ],
      dailyLimit: 10,
      timezone: "Asia/Qyzylorda",
      now: new Date("2026-05-12T03:00:00.000Z"),
    });

    expect(plan.selectedRecipientCount).toBe(3);
    expect(plan.uniquePhoneCount).toBe(3);
    expect(plan.validBirthdayCount).toBe(3);
    expect(plan.todayBirthdayCount).toBe(2);
    expect(plan.dayCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "05-12", count: 2, overflow: 0 }),
        expect.objectContaining({ key: "06-01", count: 1, overflow: 0 }),
      ])
    );
  });

  it("reports every birthday day that exceeds the daily cap", () => {
    const plan = buildBirthdayRecipientPlan({
      recipients: [
        { phone: "+77000000001", birthday: "12.05" },
        { phone: "+77000000002", birthday: "12.05" },
        { phone: "+77000000003", birthday: "13.05" },
        { phone: "+77000000004", birthday: "13.05" },
        { phone: "+77000000005", birthday: "14.05" },
      ],
      dailyLimit: 1,
    });

    expect(plan.overLimitDays).toEqual([
      expect.objectContaining({ key: "05-12", count: 2, overflow: 1 }),
      expect.objectContaining({ key: "05-13", count: 2, overflow: 1 }),
    ]);
  });

  it("counts Feb 29 birthdays on Feb 28 in non-leap years", () => {
    const plan = buildBirthdayRecipientPlan({
      recipients: [
        { phone: "+77000000001", birthday: "28.02" },
        { phone: "+77000000002", birthday: "29.02.2000" },
      ],
      dailyLimit: 1,
      timezone: "UTC",
      now: new Date("2027-02-28T09:00:00.000Z"),
    });

    expect(plan.todayBirthdayCount).toBe(2);
    expect(plan.overLimitDays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "02-28-non-leap",
          count: 2,
          overflow: 1,
          nonLeapFeb28: true,
        }),
      ])
    );
  });

  it("dedupes phones while preserving the last valid birthday import", () => {
    const plan = buildBirthdayRecipientPlan({
      recipients: [
        { phone: "+77000000001", birthday: "12.05" },
        { phone: "+7 700 000 0001", birthday: "not-a-date" },
        { phone: "+77000000002", fields: { birthday: "13.05" } },
      ],
      dailyLimit: 10,
    });

    expect(plan.selectedRecipientCount).toBe(3);
    expect(plan.uniquePhoneCount).toBe(2);
    expect(plan.duplicatePhoneCount).toBe(1);
    expect(plan.invalidBirthdayCount).toBe(1);
    expect(plan.validBirthdayCount).toBe(2);
    expect(plan.dayCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "05-12", count: 1 }),
        expect.objectContaining({ key: "05-13", count: 1 }),
      ])
    );
  });

  it("counts and dedupes Telegram recipients by chat ID", () => {
    const plan = buildBirthdayRecipientPlan({
      recipients: [
        { chatId: "123456", birthday: "12.05" },
        { chatId: "123456", birthday: "13.05" },
        { chatId: "654321", fields: { birthday: "13.05" } },
      ],
      dailyLimit: 10,
    });

    expect(plan.selectedRecipientCount).toBe(3);
    expect(plan.uniquePhoneCount).toBe(2);
    expect(plan.duplicatePhoneCount).toBe(1);
    expect(plan.validBirthdayCount).toBe(2);
    expect(plan.dayCounts).toEqual([
      expect.objectContaining({ key: "05-13", count: 2 }),
    ]);
  });
});

import {
  previewCampaignAutoVariableValues,
  resolveCampaignVariableValue,
  resolveCampaignVariableValueWithSource,
} from "./campaign-variable-values";

const auto = { mode: "auto" } as const;

describe("resolveCampaignVariableValueWithSource", () => {
  it.each([
    [
      "an uploaded variable column",
      "1",
      { phone: "+77001", name: "Aibek", fields: { var1: "VIP" } },
      { value: "VIP", source: "csv_variable" },
    ],
    [
      "the name for {{1}}",
      "1",
      { phone: "+77001", name: "Aibek" },
      { value: "Aibek", source: "contact_name" },
    ],
    [
      "the phone for {{2}}",
      "2",
      { phone: "+77001", name: "Aibek" },
      { value: "+77001", source: "recipient_phone" },
    ],
    [
      "the phone for a phone variable",
      "phone",
      { phone: "+77001" },
      { value: "+77001", source: "recipient_phone" },
    ],
    [
      "the phone when a row has no name",
      "1",
      { phone: "+77001" },
      { value: "+77001", source: "phone_fallback" },
    ],
    [
      "the phone when a row's name is blank",
      "1",
      { phone: "+77001", name: "  ", fields: { name: "" } },
      { value: "+77001", source: "phone_fallback" },
    ],
    ["nothing", "1", {}, { value: "", source: "none" }],
  ])("finds %s in auto mode", (_label, variable, recipient, expected) => {
    expect(
      resolveCampaignVariableValueWithSource(variable, recipient, auto)
    ).toEqual(expected);
    // The value is what is sent, unchanged.
    expect(resolveCampaignVariableValue(variable, recipient, auto)).toBe(
      expected.value
    );
  });

  it("never calls an explicit phone choice a fallback", () => {
    expect(
      resolveCampaignVariableValueWithSource(
        "1",
        { phone: "+77001" },
        { mode: "recipient_phone" }
      )
    ).toEqual({ value: "+77001", source: "recipient_phone" });
    expect(
      resolveCampaignVariableValueWithSource(
        "1",
        { phone: "+77001" },
        { mode: "contact_name" }
      )
    ).toEqual({ value: "", source: "none" });
  });
});

describe("previewCampaignAutoVariableValues", () => {
  it("shows the first recipient's value and counts rows that get their phone", () => {
    expect(
      previewCampaignAutoVariableValues({
        variables: ["1"],
        recipients: [
          { phone: "+77001", name: "Aibek" },
          { phone: "+77002" },
          { phone: "+77003", fields: { name: "" } },
          { phone: "+77004", fields: { full_name: "Dana" } },
        ],
      }).get("1")
    ).toEqual({ firstValue: "Aibek", phoneFallbackCount: 2 });
  });

  it("shows the phone a nameless first recipient gets", () => {
    expect(
      previewCampaignAutoVariableValues({
        variables: ["1"],
        recipients: [{ phone: "+77002" }],
      }).get("1")
    ).toEqual({ firstValue: "+77002", phoneFallbackCount: 1 });
  });

  it("previews several variables in one pass, each as its own send resolves it", () => {
    const recipients = [
      { phone: "+77001", fields: { "Promo Code": "A1", Name: "Aibek" } },
      { phone: "+77002", fields: { promo_code: "B2" } },
    ];
    const previews = previewCampaignAutoVariableValues({
      variables: ["1", "promo_code", "2"],
      recipients,
    });

    for (const variable of ["1", "promo_code", "2"]) {
      const sent = recipients.map(recipient =>
        resolveCampaignVariableValueWithSource(variable, recipient, auto)
      );
      expect(previews.get(variable)).toEqual({
        firstValue: sent[0].value,
        phoneFallbackCount: sent.filter(
          item => item.source === "phone_fallback"
        ).length,
      });
    }
    expect(previews.get("promo_code")?.firstValue).toBe("A1");
  });

  it("has nothing to show without recipients or variables", () => {
    expect(
      previewCampaignAutoVariableValues({ variables: ["1"], recipients: [] })
        .size
    ).toBe(0);
    expect(
      previewCampaignAutoVariableValues({
        variables: [],
        recipients: [{ phone: "+77002" }],
      }).size
    ).toBe(0);
  });
});

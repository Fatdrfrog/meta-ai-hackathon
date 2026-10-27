import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  buildCampaignWhatsappRecipientPayload,
  normalizeCampaignPhone,
  resolveCampaignRecipientContactName,
  resolveCampaignRecipientTemplateValue,
  type CampaignScenarioStepTemplate,
} from "./campaign-recipient-utils";

describe("resolveCampaignRecipientContactName", () => {
  it.each([
    [{ phone: "+77001234567", name: " Aigerim " }, "Aigerim"],
    [
      { phone: "+77001234567", fields: { "Full Name": "Dana Sadykova" } },
      "Dana Sadykova",
    ],
    [{ phone: "+77001234567", fields: { customer_name: "Arman" } }, "Arman"],
    [{ phone: "+77001234567", name: " ", fields: { city: "Almaty" } }, ""],
    [{ phone: "+77001234567" }, ""],
  ])("reads the row's own name from %j", (recipient, expected) => {
    expect(resolveCampaignRecipientContactName(recipient)).toBe(expected);
  });

  it("is the name {{1}} sends, without its phone fallback", () => {
    const named = { phone: "+77001234567", fields: { first_name: "Arman" } };
    expect(resolveCampaignRecipientTemplateValue(named, "1")).toBe(
      resolveCampaignRecipientContactName(named)
    );
    const nameless = { phone: "+77001234567" };
    expect(resolveCampaignRecipientTemplateValue(nameless, "1")).toBe(
      "+77001234567"
    );
    expect(resolveCampaignRecipientContactName(nameless)).toBe("");
  });
});

describe("normalizeCampaignPhone", () => {
  it.each([
    ["'+77001234567", "77001234567"],
    ["+7 (700) 123-45-67", "77001234567"],
    ["87001234567", "77001234567"],
    ["00123456789", "00123456789"],
  ])(
    "normalizes supported phone %s without changing its identity",
    (input, expected) => {
      expect(normalizeCampaignPhone(input)).toBe(expected);
    }
  );

  it.each([
    "KZ.123456789012",
    "wa_bsuid_US.123456789012",
    "++77001234567",
    "77+001234567",
    "'=SUM(77001234567)",
    "call +77001234567",
    "12345",
    "1234567890123456",
  ])(
    "does not rescue invalid phone %s by stripping other characters",
    input => {
      expect(normalizeCampaignPhone(input)).toBe("");
    }
  );
});

describe("buildCampaignWhatsappRecipientPayload tap payloads", () => {
  const quickReplies = (...labels: string[]): WhatsAppComponent[] => [
    {
      type: "BUTTONS",
      buttons: labels.map(text => ({ type: "QUICK_REPLY" as const, text })),
    },
  ];
  const payloadsByIndex = (
    templateComponents: WhatsAppComponent[],
    scenarioStepTemplate?: CampaignScenarioStepTemplate
  ) =>
    Object.fromEntries(
      (
        buildCampaignWhatsappRecipientPayload({
          workspaceId: "workspace-1",
          scenarioId: "scenario-1",
          scenarioNodeId: "menu",
          scenarioStepTemplate,
          recipient: { phone: "77001234567" },
          templateComponents,
          requiredTemplateVariables: [],
        }).components ?? []
      ).flatMap(component =>
        component.type === "button" && component.sub_type === "quick_reply"
          ? [[String(component.index), component.parameters[0]?.payload]]
          : []
      )
    );

  it("keeps positional payloads without the scenario step's template", () => {
    expect(payloadsByIndex(quickReplies("Premium", "Basic"))).toEqual({
      "0": "stb:menu:0",
      "1": "stb:menu:1",
    });
  });

  it("keeps today's payloads when the approved template matches the step", () => {
    const template = quickReplies("Basic", "Premium");
    expect(
      payloadsByIndex(template, { components: template, buttonIds: undefined })
    ).toEqual(payloadsByIndex(template));
  });

  it("names the step's buttons when the approved template orders them differently", () => {
    expect(
      payloadsByIndex(quickReplies("Premium", "Basic"), {
        components: quickReplies("Basic", "Premium"),
        buttonIds: undefined,
      })
    ).toEqual({ "0": "stb:menu:1", "1": "stb:menu:0" });
  });

  it("sends the step's button ids", () => {
    const template = quickReplies("Premium", "Gold");
    expect(
      payloadsByIndex(template, {
        components: template,
        buttonIds: {
          version: 1,
          nextId: 11,
          buttons: [
            { id: 1, index: 0, text: "Premium" },
            { id: 10, index: 1, text: "Gold" },
          ],
        },
      })
    ).toEqual({ "0": "stb:menu:1", "1": "stb:menu:10" });
  });
});

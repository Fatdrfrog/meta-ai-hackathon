import { applyScenarioReplyTemplate } from "@/lib/airi/scenario/scenario-template";

describe("applyScenarioReplyTemplate WhatsApp referral fields", () => {
  it("renders merchant image instructions from customer and inbound tokens without rewriting their text", () => {
    const result = applyScenarioReplyTemplate({
      reply:
        "Keep every medal slot and the 100 cm frame. Print {{customer.name}}. Personalization: {{trigger.message.text}}",
      channel: "whatsapp",
      conversation: { _id: "conv_1" } as unknown as Parameters<
        typeof applyScenarioReplyTemplate
      >[0]["conversation"],
      chatDocument: { first_name: "Аяла" } as Parameters<
        typeof applyScenarioReplyTemplate
      >[0]["chatDocument"],
      triggerMessage: { text: "Name: АЯЛА; sport: gymnastics" } as Parameters<
        typeof applyScenarioReplyTemplate
      >[0]["triggerMessage"],
    });
    expect(result).toBe(
      "Keep every medal slot and the 100 cm frame. Print Аяла. Personalization: Name: АЯЛА; sport: gymnastics"
    );
  });
  it("renders trigger WhatsApp referral tokens from the inbound message", () => {
    const result = applyScenarioReplyTemplate({
      reply:
        "Source: {{trigger.whatsappReferral.sourcePlatform}} {{trigger.whatsappReferral.sourceType}} {{trigger.whatsappReferral.sourceId}}",
      channel: "whatsapp",
      conversation: {
        _id: "conv_1",
        channel: "whatsapp",
      } as unknown as Parameters<
        typeof applyScenarioReplyTemplate
      >[0]["conversation"],
      chatDocument: {
        first_name: "Ada",
      } as Parameters<typeof applyScenarioReplyTemplate>[0]["chatDocument"],
      triggerMessage: {
        whatsappReferral: {
          sourceType: "ad",
          sourceId: "238000111222333",
          sourceUrl: "https://www.instagram.com/p/CampaignPost/",
        },
      } as Parameters<typeof applyScenarioReplyTemplate>[0]["triggerMessage"],
    });

    expect(result).toBe("Source: instagram ad 238000111222333");
  });

  it("inserts answers collected before image generation", () => {
    const result = applyScenarioReplyTemplate({
      reply:
        "Medal for {{input.name}}, sport {{input.sport}}. Ignore {{input.Name}}.",
      channel: "whatsapp",
      conversation: { _id: "conv_1" } as unknown as Parameters<
        typeof applyScenarioReplyTemplate
      >[0]["conversation"],
      chatDocument: {} as Parameters<
        typeof applyScenarioReplyTemplate
      >[0]["chatDocument"],
      promptInputs: {
        name: "Amina",
        sport: "gymnastics",
        Name: "ignored",
        "not_a_key!": "ignored",
      },
    });

    expect(result).toBe("Medal for Amina, sport gymnastics. Ignore .");
  });
});

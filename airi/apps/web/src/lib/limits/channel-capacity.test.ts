import { evaluateChannelCapacity } from "./channel-capacity";

const open = {
  trialExpired: false,
  whatsappNumberLimit: 1,
  whatsappNumberCount: 0,
  integrationConnectionLimit: 1,
  integrationConnectionCounts: {},
  channelTypes: [] as string[],
  channelExhausted: false,
};

describe("evaluateChannelCapacity", () => {
  it("allows a first WhatsApp number", () => {
    expect(evaluateChannelCapacity(open, "whatsapp")).toEqual({
      allowed: true,
    });
  });

  it("blocks everything once the trial has ended", () => {
    expect(
      evaluateChannelCapacity({ ...open, trialExpired: true }, "whatsapp")
    ).toEqual({ allowed: false, reason: "trial_expired" });
    expect(
      evaluateChannelCapacity({ ...open, trialExpired: true }, null)
    ).toEqual({ allowed: false, reason: "trial_expired" });
  });

  it("allows channel types that are not limited", () => {
    expect(evaluateChannelCapacity(open, null)).toEqual({ allowed: true });
  });

  it("blocks a WhatsApp number beyond the plan limit", () => {
    expect(
      evaluateChannelCapacity({ ...open, whatsappNumberCount: 1 }, "whatsapp")
    ).toEqual({ allowed: false, reason: "whatsapp_number_limit" });
  });

  it("counts connections per channel type, not across all types", () => {
    const telegramUsed = {
      ...open,
      integrationConnectionCounts: { telegram: 1 },
    };
    expect(evaluateChannelCapacity(telegramUsed, "whatsapp")).toEqual({
      allowed: true,
    });
    expect(evaluateChannelCapacity(telegramUsed, "telegram")).toEqual({
      allowed: false,
      reason: "integration_connection_limit",
    });
  });

  it("leaves WhatsApp numbers to the WhatsApp number limit alone", () => {
    expect(
      evaluateChannelCapacity(
        {
          ...open,
          whatsappNumberLimit: 3,
          whatsappNumberCount: 2,
          integrationConnectionCounts: { whatsapp: 2 },
        },
        "whatsapp"
      )
    ).toEqual({ allowed: true });
  });

  it("blocks a new channel type when the channel limit is reached", () => {
    const exhausted = {
      ...open,
      channelTypes: ["telegram", "instagram"],
      channelExhausted: true,
    };
    expect(evaluateChannelCapacity(exhausted, "whatsapp")).toEqual({
      allowed: false,
      reason: "channel_limit",
    });
    expect(
      evaluateChannelCapacity(
        { ...exhausted, channelTypes: ["whatsapp"] },
        "whatsapp"
      )
    ).toEqual({ allowed: true });
  });

  it("treats a missing limit as unlimited", () => {
    expect(
      evaluateChannelCapacity(
        {
          ...open,
          whatsappNumberLimit: null,
          whatsappNumberCount: 5,
          integrationConnectionLimit: null,
        },
        "whatsapp"
      )
    ).toEqual({ allowed: true });
  });

  it("reads a partial payload as no limit instead of throwing", () => {
    expect(evaluateChannelCapacity({}, "whatsapp")).toEqual({ allowed: true });
  });
});

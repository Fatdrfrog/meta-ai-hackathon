import {
  isAiriPlatformHowToRequest,
  isAiriPlatformQuestionSafetyNet,
  shouldRerouteEmptyTenantToProductKb,
} from "./platform-how-to";

describe("isAiriPlatformHowToRequest", () => {
  it.each([
    "how to connect WhatsApp",
    "как подключить WhatsApp",
    "хочу регистрацию через вотсап сделать",
    "Telegram qanday ulash",
    "What can Airi do with WhatsApp templates and flows?",
  ])("treats %s as platform how-to", message => {
    expect(isAiriPlatformHowToRequest(message)).toBe(true);
  });

  it.each([
    "Create a WhatsApp Flow for lead capture",
    "создать флоу регистрации для клиентов",
    "what is airi.chat",
    "как добавить мессенджер",
    "Какая у нас политика возврата?",
    "Airi, what's our refund policy?",
    "how to edit a WhatsApp template",
    "continue this WhatsApp Flow",
    "как сделать шаблон WhatsApp",
    "Create a lead-form Flow",
  ])("does not treat %s as platform how-to", message => {
    expect(isAiriPlatformHowToRequest(message)).toBe(false);
  });
});

describe("isAiriPlatformQuestionSafetyNet", () => {
  it.each([
    "what is airi.chat",
    "airi.chat pricing",
    "как добавить мессенджер",
    "how does WhatsApp onboarding work",
    "how to connect WhatsApp",
  ])("treats %s as a platform safety-net miss", message => {
    expect(isAiriPlatformQuestionSafetyNet(message)).toBe(true);
  });

  it.each([
    "Какая у нас политика возврата?",
    "Airi, what's our refund policy?",
    "What content is in the refund policy?",
    "Create a WhatsApp Flow for lead capture",
    "Use my connected customer channels to identify opportunities",
  ])("does not treat %s as a platform safety-net miss", message => {
    expect(isAiriPlatformQuestionSafetyNet(message)).toBe(false);
  });
});

describe("shouldRerouteEmptyTenantToProductKb", () => {
  it("reroutes an empty-tenant general_answer that looks like a platform question", () => {
    expect(
      shouldRerouteEmptyTenantToProductKb({
        intent: "general_answer",
        userMessage: "what is airi.chat",
        tenantHasKbOrChats: false,
        hasSelectedSources: false,
      })
    ).toBe(true);
  });

  it("does not steal airi.chat KB for an empty-tenant company question", () => {
    expect(
      shouldRerouteEmptyTenantToProductKb({
        intent: "general_answer",
        userMessage: "Какая у нас политика возврата?",
        tenantHasKbOrChats: false,
        hasSelectedSources: false,
      })
    ).toBe(false);
  });

  it("does not reroute when the tenant already has KB or chats", () => {
    expect(
      shouldRerouteEmptyTenantToProductKb({
        intent: "general_answer",
        userMessage: "what is airi.chat",
        tenantHasKbOrChats: true,
        hasSelectedSources: false,
      })
    ).toBe(false);
  });

  it("does not reroute when the user attached sources", () => {
    expect(
      shouldRerouteEmptyTenantToProductKb({
        intent: "general_answer",
        userMessage: "what is airi.chat",
        tenantHasKbOrChats: false,
        hasSelectedSources: true,
      })
    ).toBe(false);
  });

  it("does not reroute non-general intents", () => {
    expect(
      shouldRerouteEmptyTenantToProductKb({
        intent: "opportunity_scan",
        userMessage: "what is airi.chat",
        tenantHasKbOrChats: false,
        hasSelectedSources: false,
      })
    ).toBe(false);
  });
});
